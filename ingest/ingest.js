#!/usr/bin/env node
/**
 * GreenBook ingest — replaces demo layers with real geometry + elevation.
 *
 * Pipeline per course:
 *   1. Overpass API  → find leisure=golf_course by name, pull golf=hole centerlines
 *                      (+ optional bunker/water/green polygons)
 *   2. Resample each centerline every SAMPLE_M meters
 *   3. USGS 3DEP EPQS → elevation (feet) at every sample point
 *   4. Emit data/courses/<slug>.json  — flat file, committed to repo, consumed
 *      by index.html / play.html at build time. No runtime backend.
 *
 * Usage:
 *   node ingest/ingest.js --name "Allentown Municipal" --slug allentown \
 *        --bbox "40.57,-75.55,40.62,-75.48"
 *
 * Notes:
 *   - Node 18+ (native fetch). Zero dependencies.
 *   - EPQS is queried sequentially with a delay; be a good citizen.
 *   - PROVENANCE: every hole in output carries geometry_source + elevation_source.
 *     If Overpass returns no golf=hole ways, the course is emitted with
 *     coverage:"none" and the Terrain axis stays gated. Never synthesize.
 */

const fs = require("fs");
const path = require("path");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const EPQS = "https://epqs.nationalmap.gov/v1/json";
const SAMPLE_M = 20;          // sample spacing along centerline
const EPQS_DELAY_MS = 120;    // throttle elevation queries

// ---------- args ----------
const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith("--")) args[a.slice(2)] = arr[i + 1];
});
const NAME = args.name;
const SLUG = args.slug || (NAME || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
const BBOX = args.bbox; // "s,w,n,e"
if (!NAME || !BBOX) {
  console.error('Usage: node ingest.js --name "Course Name" --slug slug --bbox "s,w,n,e"');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// haversine, meters
function distM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// resample polyline every step meters (includes endpoints)
function resample(coords, step) {
  const out = [{ ...coords[0], d: 0 }];
  let carried = 0, total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const seg = distM(a, b);
    let along = step - carried;
    while (along < seg) {
      const t = along / seg;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        d: total + along,
      });
      along += step;
    }
    carried = seg - (along - step);
    total += seg;
  }
  const last = coords[coords.length - 1];
  out.push({ ...last, d: total });
  return { points: out, length_m: total };
}

async function overpass(query) {
  // overpass-api.de round-robins across backends; one can intermittently 406.
  // Retry with backoff, rotating through mirrors. Transport only — no data changes.
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "GreenBook-ingest/1.0 (github.com/CaptainMig/greenbook)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status} (${url})`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = 1500 * (attempt + 1);
      console.log(`  retry ${attempt + 1}/6 after ${e.message} — waiting ${wait} ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function elevationFt(lat, lon) {
  const url = `${EPQS}?x=${lon}&y=${lat}&units=Feet&wkid=4326&includeDate=false`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const v = j?.value;
  return typeof v === "number" && v > -1000 ? +v.toFixed(1) : null;
}

(async () => {
  console.log(`\nGreenBook ingest · ${NAME} (${SLUG})`);
  console.log(`bbox ${BBOX}\n`);

  // ---- 1. Hole centerlines (+ hazards) inside bbox, scoped to the named course ----
  const q = `
    [out:json][timeout:60][bbox:${BBOX}];
    (
      way["leisure"="golf_course"]["name"~"${NAME}",i];
      relation["leisure"="golf_course"]["name"~"${NAME}",i];
    )->.course;
    (
      way(area.course)["golf"="hole"];
      way["golf"="hole"](${BBOX});
    )->.holes;
    (
      way["golf"="bunker"](${BBOX});
      way["golf"="water_hazard"](${BBOX});
      way["natural"="water"](${BBOX});
      way["golf"="green"](${BBOX});
    )->.features;
    .holes out geom;
    .features out geom;
  `;
  console.log("→ Overpass: hole centerlines + hazards…");
  const osm = await overpass(q);

  const holeWays = osm.elements.filter((e) => e.tags?.golf === "hole" && e.geometry);
  const hazards = osm.elements.filter((e) => e.tags?.golf !== "hole" && e.geometry);
  console.log(`  ${holeWays.length} hole centerlines · ${hazards.length} hazard/green polygons`);

  if (holeWays.length === 0) {
    // Honest failure mode: emit gated stub. Terrain axis stays off.
    const stub = {
      slug: SLUG, name: NAME, ingested: new Date().toISOString(),
      coverage: "none",
      note: "No golf=hole ways in OSM for this bbox. Map the course in OSM (or via OpenCourseMaps) and re-run. Do NOT synthesize.",
      holes: [],
    };
    write(stub);
    console.log("\n⚠ coverage:none — Terrain axis stays gated. Stub written.");
    return;
  }

  // ---- 2 + 3. Resample and elevate ----
  const holes = [];
  for (const w of holeWays) {
    const ref = w.tags.ref || w.tags.name || String(holeWays.indexOf(w) + 1);
    const { points, length_m } = resample(w.geometry, SAMPLE_M);
    process.stdout.write(`→ hole ${ref}: ${points.length} samples, ${(length_m * 1.09361).toFixed(0)} yds … `);

    const profile = [];
    let misses = 0;
    for (const p of points) {
      const e = await elevationFt(p.lat, p.lon);
      if (e === null) misses++;
      profile.push({ d_m: +p.d.toFixed(1), lat: p.lat, lon: p.lon, elev_ft: e });
      await sleep(EPQS_DELAY_MS);
    }
    const valid = profile.filter((p) => p.elev_ft !== null);
    const delta =
      valid.length >= 2 ? +(valid[valid.length - 1].elev_ft - valid[0].elev_ft).toFixed(1) : null;

    holes.push({
      ref,
      par: w.tags.par ? +w.tags.par : null,
      handicap: w.tags.handicap ? +w.tags.handicap : null,
      dist: w.tags.dist || null,                     // OSM-tagged distance if present
      length_m: +length_m.toFixed(1),
      length_yds: +(length_m * 1.09361).toFixed(0),  // centerline length ≠ card yardage; keep both
      elev_delta_ft: delta,
      geometry_source: "osm_overpass",
      elevation_source: misses === 0 ? "usgs_3dep_epqs" : `usgs_3dep_epqs (${misses} gaps)`,
      profile,
    });
    console.log(`Δ ${delta === null ? "n/a" : (delta > 0 ? "+" : "") + delta + " ft"}`);
  }
  holes.sort((a, b) => (parseInt(a.ref) || 99) - (parseInt(b.ref) || 99));

  // hazards: keep simplified rings for the play-view verdict engine
  const hazardOut = hazards.map((h) => ({
    kind: h.tags.golf || h.tags.natural,
    ring: h.geometry.map((g) => [+g.lat.toFixed(6), +g.lon.toFixed(6)]),
  }));

  const out = {
    slug: SLUG, name: NAME, ingested: new Date().toISOString(),
    coverage: holes.length >= 18 ? "full" : "partial",
    sample_spacing_m: SAMPLE_M,
    sources: {
      geometry: "OpenStreetMap via Overpass (ODbL — attribution required)",
      elevation: "USGS 3DEP via EPQS (public domain)",
    },
    holes,
    hazards: hazardOut,
  };
  write(out);
  console.log(`\n✓ ${holes.length} holes, coverage:${out.coverage} → data/courses/${SLUG}.json`);
  console.log("  Next: flip holesDemo:false in index.html and point it at this file.");

  function write(obj) {
    const dir = path.join(__dirname, "..", "data", "courses");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SLUG}.json`), JSON.stringify(obj, null, 1));
  }
})().catch((e) => {
  console.error("\n✗ ingest failed:", e.message);
  process.exit(1);
});

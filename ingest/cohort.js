#!/usr/bin/env node
/**
 * GreenBook cohort ingest — top of the terrain queue → data/open/courses/.
 *
 *   node ingest/cohort.js [--count 25]
 *
 * Selection from ingest/queue.json (nationwide census):
 *   - single-course layouts only: 18–27 holes, >=15 tagged (multi-course
 *     megaparcels like Bethpage's 90-hole facility need supervised splits)
 *   - must match an OpenGolfAPI registry record within 3 km (name-agnostic,
 *     nearest-neighbor) so the page join works by slug
 *   - Allentown is skipped (already ingested via EPQS in phase 1)
 *
 * Elevation: USGS 3DEP GeoTIFF range-reads (ingest/dem.js), validated against
 * EPQS to <1 ft on the Allentown reference points. EPQS remains the fallback.
 * Geometry source per hole: osm_overpass. Never synthesized.
 */

const fs = require("fs");
const path = require("path");
const { sampleElevationFt, cacheStats } = require("./dem");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "open", "courses");
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const SAMPLE_M = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COUNT = +(process.argv[process.argv.indexOf("--count") + 1] || 25);

function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function distM(a, b) { return distKm(a.lat, a.lon, b.lat, b.lon) * 1000; }

function resample(coords, step) {
  const out = [{ ...coords[0], d: 0 }];
  let carried = 0, total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const seg = distM(a, b);
    let along = step - carried;
    while (along < seg) {
      const t = along / seg;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, d: total + along });
      along += step;
    }
    carried = seg - (along - step);
    total += seg;
  }
  out.push({ ...coords[coords.length - 1], d: total });
  return { points: out, length_m: total };
}

async function overpass(query, label) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GreenBook-ingest/1.0 (github.com/CaptainMig/greenbook)" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(2500 * (attempt + 1));
      console.log(`  [${label}] retry ${attempt + 1}/8 (${e.message})`);
    }
  }
  throw lastErr;
}

(async () => {
  const queue = JSON.parse(fs.readFileSync(path.join(__dirname, "queue.json"), "utf8")).queue;

  // registry index with coordinates: load all state shards
  const regDir = path.join(ROOT, "data", "open", "registry", "state");
  const regAll = [];
  for (const f of fs.readdirSync(regDir)) {
    for (const c of JSON.parse(fs.readFileSync(path.join(regDir, f), "utf8")).courses) regAll.push(c);
  }
  console.log(`${regAll.length} registry records loaded for matching`);

  // selection
  const done = new Set(fs.existsSync(OUT) ? fs.readdirSync(OUT).map((f) => f.replace(".json", "")) : []);
  const picked = [];
  const usedSlugs = new Set(done);
  for (const q of queue) {
    if (picked.length >= COUNT) break;
    if (q.holes < 18 || q.holes > 27 || q.tagged < 15) continue;
    // nearest registry record within 3 km
    let best = null, bestD = 3;
    for (const r of regAll) {
      if (Math.abs(r.lat - q.lat) > 0.05 || Math.abs(r.lon - q.lon) > 0.06) continue;
      const d = distKm(q.lat, q.lon, r.lat, r.lon);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (!best || usedSlugs.has(best.slug) || best.slug === "allentown") continue;
    usedSlugs.add(best.slug);
    picked.push({ q, reg: best });
  }
  console.log(`cohort: ${picked.length} courses selected\n`);

  fs.mkdirSync(OUT, { recursive: true });
  const okSlugs = [];
  for (const { q, reg } of picked) {
    const label = `${reg.slug}`;
    try {
      console.log(`→ ${reg.name} (${reg.state}) [queue: ${q.holes} holes, ${q.tagged} tagged]`);
      const bq = `
        [out:json][timeout:90][bbox:${q.bbox}];
        (way["golf"="hole"];)->.holes;
        (way["golf"="bunker"];way["golf"="water_hazard"];way["natural"="water"];way["golf"="green"];)->.features;
        .holes out geom; .features out geom;`;
      const osm = await overpass(bq, label);
      const holeWays = osm.elements.filter((e) => e.tags?.golf === "hole" && e.geometry);
      const hazards = osm.elements.filter((e) => e.tags?.golf !== "hole" && e.geometry);
      if (holeWays.length === 0) { console.log("  ✗ no centerlines in bbox — skipped (never synthesized)"); continue; }

      const holes = [];
      let gapsTotal = 0;
      for (const w of holeWays) {
        const ref = w.tags.ref || w.tags.name || String(holeWays.indexOf(w) + 1);
        const { points, length_m } = resample(w.geometry, SAMPLE_M);
        const profile = [];
        let misses = 0;
        // batch elevation lookups — local after first tile fetch
        for (let i = 0; i < points.length; i += 16) {
          const chunk = points.slice(i, i + 16);
          const els = await Promise.all(chunk.map((p) => sampleElevationFt(p.lat, p.lon)));
          els.forEach((e, j) => {
            if (e === null) misses++;
            profile.push({ d_m: +chunk[j].d.toFixed(1), lat: chunk[j].lat, lon: chunk[j].lon, elev_ft: e });
          });
        }
        gapsTotal += misses;
        const valid = profile.filter((p) => p.elev_ft !== null);
        const delta = valid.length >= 2 ? +(valid[valid.length - 1].elev_ft - valid[0].elev_ft).toFixed(1) : null;
        holes.push({
          ref, par: w.tags.par ? +w.tags.par : null,
          handicap: w.tags.handicap ? +w.tags.handicap : null,
          length_m: +length_m.toFixed(1), length_yds: +(length_m * 1.09361).toFixed(0),
          elev_delta_ft: delta,
          geometry_source: "osm_overpass",
          elevation_source: misses === 0 ? "usgs_3dep_geotiff_aws" : `usgs_3dep_geotiff_aws (${misses} gaps)`,
          profile,
        });
      }
      holes.sort((a, b) => (parseInt(a.ref) || 99) - (parseInt(b.ref) || 99));

      const out = {
        slug: reg.slug, name: reg.name, registry_id: reg.id,
        osm_course: q.osm, ingested: new Date().toISOString(),
        coverage: holes.length >= 18 ? "full" : "partial",
        sample_spacing_m: SAMPLE_M,
        sources: {
          geometry: "OpenStreetMap via Overpass (ODbL — attribution required)",
          elevation: "USGS 3DEP 1/3 arc-second GeoTIFF via AWS Open Data (public domain); EPQS-validated sampler",
        },
        holes,
        hazards: hazards.map((h) => ({ kind: h.tags.golf || h.tags.natural, ring: h.geometry.map((g) => [+g.lat.toFixed(6), +g.lon.toFixed(6)]) })),
      };
      fs.writeFileSync(path.join(OUT, `${reg.slug}.json`), JSON.stringify(out, null, 1));
      const deltas = holes.map((h) => h.elev_delta_ft).filter((d) => d !== null);
      const meanAbs = deltas.length ? (deltas.reduce((s, d) => s + Math.abs(d), 0) / deltas.length).toFixed(1) : "n/a";
      console.log(`  ✓ ${holes.length} holes, ${gapsTotal} elevation gaps, mean|Δ| ${meanAbs} ft → ${reg.slug}.json`);
      okSlugs.push(reg.slug);
      await sleep(3000);
    } catch (e) {
      console.log(`  ✗ ${label}: ${e.message} — skipped`);
      await sleep(3000);
    }
  }
  console.log(`\n✓ cohort complete: ${okSlugs.length} courses · DEM cache ${JSON.stringify(cacheStats())}`);
  console.log("enrich next: node ingest/registry.js --enrich " + okSlugs.join(","));
})().catch((e) => { console.error("cohort failed:", e); process.exit(1); });

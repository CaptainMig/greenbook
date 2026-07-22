#!/usr/bin/env node
/**
 * GreenBook boundary census — Phase 3, step 1.
 *
 * ONE nationwide Overpass pass collecting leisure=golf_course polygons
 * (ways + relations, full geometry), matched to registry dedup clusters by
 * name + proximity. A wrong match is worse than no match: unmatched polygons
 * and unmatched courses are LISTED, never force-paired.
 *
 *   node ingest/boundary-census.js
 *
 * Outputs (ingest/, not shipped):
 *   boundary-queue.json        matched courses ranked by confidence, plus
 *                              unmatched polygon + course lists and match rate
 *   boundary-geometry.json.gz  osm id -> {outer:[[lat,lon]…][], inners:[…]}
 *                              (ODbL, consumed by ingest/boundary-dem.js so the
 *                              full run never re-queries Overpass)
 *
 * Match confidence (judgment layer — stays out of data/open):
 *   high    normalized names identical, centers <= 3 km apart
 *   medium  name-token Jaccard >= 0.5, centers <= 2 km apart
 *   below that: unmatched. Registry dedup clusters (data/starpoint/quality/
 *   duplicates.json) count as ONE course keyed by their primary slug.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "GreenBook-boundary-census/1.0 (github.com/CaptainMig/greenbook)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status} (${url})`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = 4000 * (attempt + 1);
      console.log(`  [${label}] retry ${attempt + 1}/8 after ${e.message} — ${wait} ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ---- name normalization: SAME rules as the build.js dedup pass ---- */
const normName = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, " ")
  .replace(/\b(the|golf|club|course|country|cc|gc|links|at)\b/g, " ")
  .replace(/\s+/g, " ").trim();
const tokens = (s) => new Set(normName(s).split(" ").filter(Boolean));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function distKm(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ---- polygon helpers ---- */
const rnd = (v) => +v.toFixed(6);
function ringArea_m2(ring) {
  // planar shoelace with local metric scaling — fine at course scale
  if (ring.length < 3) return 0;
  const lat0 = ring[0][0] * Math.PI / 180;
  const mx = 111320 * Math.cos(lat0), my = 110540;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [aLat, aLon] = ring[i], [bLat, bLon] = ring[(i + 1) % ring.length];
    s += (aLon * mx) * (bLat * my) - (bLon * mx) * (aLat * my);
  }
  return Math.abs(s / 2);
}
function ringCentroid(ring) {
  let lat = 0, lon = 0;
  for (const [a, b] of ring) { lat += a; lon += b; }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

/* stitch relation member ways into closed rings (endpoint matching) */
function assembleRings(members) {
  const segs = members.map((m) => m.geometry.map((g) => [rnd(g.lat), rnd(g.lon)]));
  const rings = [];
  const key = (p) => p[0] + "," + p[1];
  while (segs.length) {
    let ring = segs.shift();
    let closed = key(ring[0]) === key(ring[ring.length - 1]);
    let progress = true;
    while (!closed && progress) {
      progress = false;
      const tail = key(ring[ring.length - 1]);
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (key(s[0]) === tail) { ring = ring.concat(s.slice(1)); segs.splice(i, 1); progress = true; break; }
        if (key(s[s.length - 1]) === tail) { ring = ring.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); progress = true; break; }
      }
      closed = key(ring[0]) === key(ring[ring.length - 1]);
    }
    if (closed && ring.length >= 4) rings.push(ring);
    else return null; // could not assemble — caller lists the polygon as unusable
  }
  return rings;
}

(async () => {
  console.log("GreenBook boundary census · CONUS leisure=golf_course polygons\n");

  /* ---- 1. nationwide polygon sweep, 8 longitude bands (geometry is heavy) ---- */
  const CONUS = [24.5, -125.0, 49.5, -66.9];
  const bands = [];
  const nBands = 8, step = (CONUS[3] - CONUS[1]) / nBands;
  for (let i = 0; i < nBands; i++)
    bands.push([CONUS[0], CONUS[1] + i * step, CONUS[2], CONUS[1] + (i + 1) * step]);

  const seen = new Set();
  const raw = [];
  for (const [s, w, n, e] of bands) {
    console.log(`→ band ${w.toFixed(1)}..${e.toFixed(1)}…`);
    const q = `
      [out:json][timeout:600];
      (
        way["leisure"="golf_course"](${s},${w},${n},${e});
        relation["leisure"="golf_course"](${s},${w},${n},${e});
      );
      out tags geom;`;
    const j = await overpass(q, `band ${w.toFixed(0)}`);
    let fresh = 0;
    for (const el of j.elements) {
      const id = `${el.type}/${el.id}`;
      if (seen.has(id)) continue; // band-boundary crossers appear twice
      seen.add(id);
      raw.push(el);
      fresh++;
    }
    console.log(`  ${fresh} new polygons (running total ${raw.length})`);
    await sleep(3000);
  }

  /* ---- 2. build usable polygons ---- */
  const polys = [];
  const unusable = [];
  for (const el of raw) {
    const name = el.tags && el.tags.name ? el.tags.name : null;
    let outer = [], inners = [];
    if (el.type === "way") {
      if (!el.geometry || el.geometry.length < 4) { unusable.push({ osm: `${el.type}/${el.id}`, name, reason: "degenerate way" }); continue; }
      outer = [el.geometry.map((g) => [rnd(g.lat), rnd(g.lon)])];
    } else {
      const mem = (el.members || []).filter((m) => m.type === "way" && m.geometry);
      const out = assembleRings(mem.filter((m) => m.role === "outer" || m.role === ""));
      if (!out || !out.length) { unusable.push({ osm: `${el.type}/${el.id}`, name, reason: "multipolygon outer rings did not assemble" }); continue; }
      outer = out;
      inners = assembleRings(mem.filter((m) => m.role === "inner")) || [];
    }
    const area = outer.reduce((s, r) => s + ringArea_m2(r), 0) - inners.reduce((s, r) => s + ringArea_m2(r), 0);
    if (area < 20000) { unusable.push({ osm: `${el.type}/${el.id}`, name, reason: `area ${Math.round(area)} m² implausibly small` }); continue; }
    const c = ringCentroid(outer.reduce((a, b) => (ringArea_m2(a) >= ringArea_m2(b) ? a : b)));
    polys.push({ osm: `${el.type}/${el.id}`, name, lat: rnd(c.lat), lon: rnd(c.lon), area_ha: +(area / 1e4).toFixed(1), outer, inners });
  }
  console.log(`\n${polys.length} usable polygons · ${unusable.length} unusable (${raw.length} raw)`);

  /* ---- 3. registry (dedup-cluster aware) ---- */
  const regDir = path.join(ROOT, "data", "open", "registry", "state");
  const regAll = [];
  for (const f of fs.readdirSync(regDir))
    for (const c of JSON.parse(fs.readFileSync(path.join(regDir, f), "utf8")).courses)
      if (c.lat != null && c.lon != null) regAll.push(c);

  const dup = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "starpoint", "quality", "duplicates.json"), "utf8"));
  const primaryOf = new Map(); // shadowed slug -> primary slug
  for (const cl of dup.clusters) for (const m of cl.members) if (m.slug !== cl.primary) primaryOf.set(m.slug, cl.primary);
  const canonical = (slug) => primaryOf.get(slug) || slug;
  const primaries = new Set(regAll.map((r) => canonical(r.slug)));
  console.log(`${regAll.length} registry records → ${primaries.size} dedup-canonical courses`);

  /* coarse grid index over registry records */
  const grid = new Map();
  const gkey = (lat, lon) => `${Math.round(lat * 10)},${Math.round(lon * 10)}`;
  regAll.forEach((r, i) => {
    const k = gkey(r.lat, r.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  /* ---- 4. candidate pairs, then greedy one-to-one by confidence ---- */
  const pairs = [];
  const holeLevelDir = path.join(ROOT, "data", "open", "courses");
  const holeLevel = new Set(fs.existsSync(holeLevelDir) ? fs.readdirSync(holeLevelDir).map((f) => f.replace(".json", "")) : []);
  for (let pi = 0; pi < polys.length; pi++) {
    const p = polys[pi];
    if (!p.name) continue; // unnamed polygons are never paired — listed below
    const pn = normName(p.name), pt = tokens(p.name);
    const la = Math.round(p.lat * 10), lo = Math.round(p.lon * 10);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const ri of grid.get(`${la + dy},${lo + dx}`) || []) {
          const r = regAll[ri];
          const d = distKm(p.lat, p.lon, r.lat, r.lon);
          if (d > 3) continue;
          const exact = pn && pn === normName(r.name);
          const sim = exact ? 1 : jaccard(pt, tokens(r.name));
          let conf = null;
          if (exact && d <= 3) conf = "high";
          else if (sim >= 0.5 && d <= 2) conf = "medium";
          if (conf) pairs.push({ pi, slug: canonical(r.slug), rec: r, conf, sim: +sim.toFixed(3), d: +d.toFixed(3) });
        }
  }
  pairs.sort((a, b) => (a.conf === b.conf ? b.sim - a.sim || a.d - b.d : a.conf === "high" ? -1 : 1));
  const polyTaken = new Set(), slugTaken = new Set();
  const matched = [];
  for (const pr of pairs) {
    if (polyTaken.has(pr.pi) || slugTaken.has(pr.slug)) continue;
    polyTaken.add(pr.pi); slugTaken.add(pr.slug);
    const p = polys[pr.pi];
    matched.push({
      slug: pr.slug, name: pr.rec.name, state: pr.rec.state, city: pr.rec.city || null,
      registry_id: pr.rec.id || null,
      osm: p.osm, osm_name: p.name,
      lat: p.lat, lon: p.lon, area_ha: p.area_ha,
      confidence: pr.conf, name_sim: pr.sim, dist_km: pr.d,
      hole_level: holeLevel.has(pr.slug), // strictly-superior hole ingest exists — sampler skips
    });
  }
  matched.sort((a, b) => (a.confidence === b.confidence ? b.name_sim - a.name_sim || a.dist_km - b.dist_km : a.confidence === "high" ? -1 : 1));

  const unmatchedPolys = polys.filter((_, i) => !polyTaken.has(i))
    .map((p) => ({ osm: p.osm, name: p.name, lat: p.lat, lon: p.lon, area_ha: p.area_ha, reason: p.name ? "no registry course met the confidence bar" : "unnamed polygon" }));
  const unmatchedCourses = [...primaries].filter((s) => !slugTaken.has(s)).sort();

  const rate = (matched.length / primaries.size * 100).toFixed(1);
  const namedPolys = polys.filter((p) => p.name).length;

  /* ---- 5. write ---- */
  const geom = {};
  for (const m of matched) {
    const p = polys.find((x) => x.osm === m.osm);
    geom[m.osm] = { outer: p.outer, inners: p.inners };
  }
  fs.writeFileSync(path.join(__dirname, "boundary-geometry.json.gz"), zlib.gzipSync(JSON.stringify(geom), { level: 9 }));

  const out = {
    generated: new Date().toISOString(),
    source: "OpenStreetMap via Overpass (ODbL) — leisure=golf_course polygons",
    note: "Match confidence is a Starpoint judgment; it stays here and in data/starpoint — never in data/open artifacts. Unmatched entries are listed, not force-paired.",
    conus_bbox: CONUS.join(","),
    polygons_usable: polys.length,
    polygons_named: namedPolys,
    polygons_unusable: unusable.length,
    registry_canonical_courses: primaries.size,
    matched_count: matched.length,
    match_rate_pct: +rate,
    confidence_counts: matched.reduce((a, m) => ((a[m.confidence] = (a[m.confidence] || 0) + 1), a), {}),
    queue: matched,
    unmatched_polygons: unmatchedPolys,
    unusable_polygons: unusable,
    unmatched_courses: unmatchedCourses,
  };
  fs.writeFileSync(path.join(__dirname, "boundary-queue.json"), JSON.stringify(out, null, 1));

  console.log(`\n✓ ${matched.length} matched (${out.confidence_counts.high || 0} high, ${out.confidence_counts.medium || 0} medium)`);
  console.log(`  match rate: ${rate}% of ${primaries.size} canonical courses · ${unmatchedPolys.length} unmatched polygons · ${unmatchedCourses.length} unmatched courses`);
  console.log(`  → ingest/boundary-queue.json + ingest/boundary-geometry.json.gz`);
})().catch((e) => {
  console.error("boundary census failed:", e);
  process.exit(1);
});

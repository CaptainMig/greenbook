#!/usr/bin/env node
/**
 * GreenBook terrain census — nationwide Overpass sweep for golf=hole coverage.
 *
 *   1. Pull all named leisure=golf_course ways/relations in CONUS (out bb tags)
 *   2. Pull all golf=hole ways in CONUS (out bb tags), in regional bands
 *   3. Assign holes to the nearest course center within 3 km
 *   4. Rank courses by completeness:  min(holes,18)*2 + holes tagged ref+par
 *   5. Write ingest/queue.json (top candidates first)
 *
 * Read-only census: no elevation, no synthesis. ODbL data stays in data/open.
 */

const fs = require("fs");
const path = require("path");

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
          "User-Agent": "GreenBook-census/1.0 (github.com/CaptainMig/greenbook)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status} (${url})`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = 3000 * (attempt + 1);
      console.log(`  [${label}] retry ${attempt + 1}/8 after ${e.message} — ${wait} ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const center = (e) =>
  e.center
    ? { lat: e.center.lat, lon: e.center.lon }
    : e.bounds
      ? { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 }
      : null;

function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

(async () => {
  console.log("GreenBook census · CONUS golf=hole coverage\n");

  // ---- 1. named courses ----
  console.log("→ courses (named leisure=golf_course)…");
  const cq = `
    [out:json][timeout:300][bbox:24.5,-125.0,49.5,-66.9];
    (
      way["leisure"="golf_course"]["name"];
      relation["leisure"="golf_course"]["name"];
    );
    out tags bb;
  `;
  const cj = await overpass(cq, "courses");
  const courses = cj.elements
    .map((e) => ({
      osm: `${e.type}/${e.id}`,
      name: e.tags.name,
      bounds: e.bounds,
      c: center(e),
      holes: 0,
      tagged: 0,
    }))
    .filter((c) => c.c);
  console.log(`  ${courses.length} named courses`);

  // ---- 2. holes, in 4 longitude bands ----
  const bands = [
    [24.5, -125.0, 49.5, -110.0],
    [24.5, -110.0, 49.5, -95.0],
    [24.5, -95.0, 49.5, -80.0],
    [24.5, -80.0, 49.5, -66.9],
  ];
  const holes = [];
  for (const [s, w, n, e] of bands) {
    console.log(`→ holes band ${w}..${e}…`);
    const hq = `[out:json][timeout:300];way["golf"="hole"](${s},${w},${n},${e});out tags bb;`;
    const hj = await overpass(hq, `holes ${w}`);
    for (const el of hj.elements) {
      const c = center(el);
      if (c) holes.push({ c, tagged: !!(el.tags.ref && el.tags.par) });
    }
    console.log(`  running total ${holes.length} holes`);
    await sleep(2000);
  }

  // ---- 3. assign holes to nearest course within 3 km (coarse grid index) ----
  console.log("→ matching holes to courses…");
  const grid = new Map();
  const key = (lat, lon) => `${Math.round(lat * 10)},${Math.round(lon * 10)}`;
  courses.forEach((c, i) => {
    const k = key(c.c.lat, c.c.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  let unmatched = 0;
  for (const h of holes) {
    let best = null, bestD = 3;
    const la = Math.round(h.c.lat * 10), lo = Math.round(h.c.lon * 10);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const i of grid.get(`${la + dy},${lo + dx}`) || []) {
          const d = distKm(h.c, courses[i].c);
          if (d < bestD) { bestD = d; best = i; }
        }
    if (best === null) { unmatched++; continue; }
    courses[best].holes++;
    if (h.tagged) courses[best].tagged++;
  }
  console.log(`  ${holes.length - unmatched} matched · ${unmatched} orphan holes`);

  // ---- 4. rank ----
  const ranked = courses
    .filter((c) => c.holes > 0)
    .map((c) => ({
      name: c.name,
      osm: c.osm,
      lat: +c.c.lat.toFixed(6),
      lon: +c.c.lon.toFixed(6),
      // ingest bbox: course bounds padded ~300 m
      bbox: [
        +(c.bounds.minlat - 0.003).toFixed(4),
        +(c.bounds.minlon - 0.004).toFixed(4),
        +(c.bounds.maxlat + 0.003).toFixed(4),
        +(c.bounds.maxlon + 0.004).toFixed(4),
      ].join(","),
      holes: c.holes,
      tagged: c.tagged,
      completeness: Math.min(c.holes, 18) * 2 + c.tagged,
    }))
    .sort((a, b) => b.completeness - a.completeness || a.name.localeCompare(b.name));

  const out = {
    generated: new Date().toISOString(),
    source: "OpenStreetMap via Overpass (ODbL)",
    conus_bbox: "24.5,-125.0,49.5,-66.9",
    courses_with_holes: ranked.length,
    total_hole_ways: holes.length,
    queue: ranked,
  };
  fs.writeFileSync(path.join(__dirname, "queue.json"), JSON.stringify(out, null, 1));
  console.log(`\n✓ ${ranked.length} courses with golf=hole coverage → ingest/queue.json`);
  console.log("  top 10:");
  ranked.slice(0, 10).forEach((c, i) => console.log(`   ${i + 1}. ${c.name} — ${c.holes} holes, ${c.tagged} tagged`));
})().catch((e) => {
  console.error("census failed:", e);
  process.exit(1);
});

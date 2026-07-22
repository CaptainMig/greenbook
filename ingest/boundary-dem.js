#!/usr/bin/env node
/**
 * GreenBook boundary sampler — Phase 3, step 2.
 *
 * For each matched course in ingest/boundary-queue.json, sample USGS 3DEP
 * elevation on a regular grid across the OSM boundary polygon interior
 * (~30 m spacing, capped at 2,500 in-polygon samples per course — spacing
 * widens uniformly when a big property would exceed the cap).
 *
 *   node ingest/boundary-dem.js [--count 500] [--dry-run]
 *
 * Rules carried from the README:
 *   - Elevation via the EXISTING GeoTIFF range-read machinery (ingest/dem.js);
 *     decoded tile blocks are cached (LRU) across courses — never re-fetched
 *     within a run. Courses are visited in DEM-tile order for cache locality.
 *   - Points-in-polygon only. Border / no-coverage points are GAPS, counted
 *     and reported — NEVER interpolated or synthesized.
 *   - Hole-level data is strictly superior: queue entries with hole_level=true
 *     are skipped (their Terrain axis already runs on routed profiles).
 *   - Resumable: a course whose artifact already exists is skipped. Safe to
 *     stop and rerun.
 *
 * Output per course → data/open/terrain-course/<slug>.json (ODbL + public
 * domain facts only: grid, elevations, gap count, slope histogram. No scores,
 * no caps, no match judgments — those live in data/starpoint).
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { sampleElevationFt, tileName, cacheStats } = require("./dem");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "open", "terrain-course");
const SPACING_M = 30;
const CAP = 2500;
const MIN_VALID = 100; // below this the artifact still ships, honestly flagged low-coverage

const argv = process.argv;
const COUNT = argv.includes("--count") ? +argv[argv.indexOf("--count") + 1] : Infinity;
const DRY = argv.includes("--dry-run");

/* ---- point-in-polygon (even-odd ray cast over outer + inner rings) ---- */
function inPolygon(lat, lon, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/* grid of in-polygon points at `spacing` metres; widens spacing to honor CAP */
function gridPoints(geom) {
  const rings = geom.outer.concat(geom.inners || []);
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const r of geom.outer) for (const [la, lo] of r) {
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
  }
  const midLat = (minLat + maxLat) / 2;
  let spacing = SPACING_M;
  for (let iter = 0; iter < 4; iter++) {
    const dlat = spacing / 110540;
    const dlon = spacing / (111320 * Math.cos((midLat * Math.PI) / 180));
    const rows = Math.max(1, Math.floor((maxLat - minLat) / dlat));
    const cols = Math.max(1, Math.floor((maxLon - minLon) / dlon));
    const pts = [];
    for (let r = 0; r < rows; r++) {
      const lat = minLat + (r + 0.5) * dlat;
      for (let c = 0; c < cols; c++) {
        const lon = minLon + (c + 0.5) * dlon;
        if (inPolygon(lat, lon, rings)) pts.push({ r, c, lat, lon });
      }
    }
    if (pts.length <= CAP || iter === 3)
      return { pts: pts.slice(0, CAP), spacing_m: +spacing.toFixed(1), origin_lat: +(minLat).toFixed(6), origin_lon: +(minLon).toFixed(6), dlat, dlon, rows, cols };
    spacing = spacing * Math.sqrt(pts.length / CAP) * 1.02; // widen uniformly, keep the grid regular
  }
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/* sample one course polygon → artifact object (no fs). m needs slug/name/
   registry_id/osm/osm_name; geom is {outer, inners}. */
async function sampleCourse(m, geom) {
  const g = gridPoints(geom);
  const pts = g.pts;
  if (!pts.length) return null;

  const elev = new Array(pts.length).fill(null);
  for (let i = 0; i < pts.length; i += 32) {
    const chunk = pts.slice(i, i + 32);
    const els = await Promise.all(chunk.map((p) => sampleElevationFt(p.lat, p.lon)));
    els.forEach((e, j) => { elev[i + j] = e; });
  }

  const valid = [];
  const byCell = new Map();
  pts.forEach((p, i) => {
    if (elev[i] !== null) { valid.push(elev[i]); byCell.set(p.r + "," + p.c, elev[i]); }
  });
  const gaps = pts.length - valid.length;

  /* slope between adjacent grid cells (right + down neighbors), % grade */
  const slopes = [];
  for (const p of pts) {
    const e0 = byCell.get(p.r + "," + p.c);
    if (e0 === undefined) continue;
    for (const nk of [p.r + "," + (p.c + 1), (p.r + 1) + "," + p.c]) {
      const e1 = byCell.get(nk);
      if (e1 !== undefined) slopes.push((Math.abs(e1 - e0) * 0.3048) / g.spacing_m * 100);
    }
  }
  const bins = { "0-2": 0, "2-4": 0, "4-6": 0, "6-10": 0, "10+": 0 };
  for (const s of slopes)
    bins[s < 2 ? "0-2" : s < 4 ? "2-4" : s < 6 ? "4-6" : s < 10 ? "6-10" : "10+"]++;

  const min = valid.length ? Math.min(...valid) : null;
  const max = valid.length ? Math.max(...valid) : null;
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  const p10 = pct(valid, 10), p90 = pct(valid, 90);
  const meanSlope = slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : null;

  return {
    slug: m.slug, name: m.name, registry_id: m.registry_id || null,
    osm_boundary: m.osm, osm_name: m.osm_name || null,
    ingested: new Date().toISOString(),
    spacing_m: g.spacing_m, sample_cap: CAP,
    sources: {
      boundary: "OpenStreetMap leisure=golf_course polygon via Overpass (ODbL — attribution required)",
      elevation: "USGS 3DEP 1/3 arc-second GeoTIFF via AWS Open Data (public domain); EPQS-validated sampler",
    },
    grid: { origin_lat: g.origin_lat, origin_lon: g.origin_lon, dlat: +g.dlat.toFixed(8), dlon: +g.dlon.toFixed(8), rows: g.rows, cols: g.cols },
    /* [row, col, elev_ft|null] — in-polygon cells only; null = no DEM coverage (a gap, never interpolated) */
    samples: pts.map((p, i) => [p.r, p.c, elev[i]]),
    stats: {
      samples: pts.length, valid: valid.length, gaps,
      low_coverage: valid.length < MIN_VALID || gaps > pts.length / 2,
      area_sampled_ha: +((pts.length * g.spacing_m * g.spacing_m) / 1e4).toFixed(1),
      elev_min_ft: min, elev_max_ft: max,
      elev_mean_ft: mean === null ? null : +mean.toFixed(1),
      relief_ft: min === null ? null : +(max - min).toFixed(1),
      relief_p90_p10_ft: p10 === null ? null : +(p90 - p10).toFixed(1),
      mean_slope_pct: meanSlope === null ? null : +meanSlope.toFixed(2),
      slope_pairs: slopes.length,
      slope_ge5_pairs: slopes.filter((s) => s >= 5).length,
      slope_hist: bins,
    },
  };
}

module.exports = { inPolygon, gridPoints, sampleCourse, SPACING_M, CAP, MIN_VALID };

if (require.main === module) (async () => {
  const queue = JSON.parse(fs.readFileSync(path.join(__dirname, "boundary-queue.json"), "utf8"));
  const geomAll = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "boundary-geometry.json.gz"))).toString());

  const done = new Set(fs.existsSync(OUT) ? fs.readdirSync(OUT).map((f) => f.replace(".json", "")) : []);
  const eligible = [];
  for (const m of queue.queue) {
    if (eligible.length >= COUNT) break;
    if (m.hole_level) continue;            // routed hole profiles exist — strictly superior, never substituted
    if (done.has(m.slug)) continue;        // resumable
    if (!geomAll[m.osm]) continue;
    eligible.push(m);
  }
  /* queue is confidence-ranked; visit in DEM-tile order for block-cache locality */
  const byTile = [...eligible].sort((a, b) => tileName(a.lat, a.lon).localeCompare(tileName(b.lat, b.lon)));
  console.log(`boundary sampler: ${eligible.length} courses to sample (${done.size} already done, cap ${CAP}/course)${DRY ? " [DRY RUN]" : ""}\n`);
  if (DRY) { byTile.forEach((m) => console.log(`  ${m.confidence.padEnd(6)} ${m.slug} (${m.area_ha} ha, tile ${tileName(m.lat, m.lon)})`)); return; }

  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0, failed = 0;
  for (const m of byTile) {
    const t0 = Date.now();
    try {
      const artifact = await sampleCourse(m, geomAll[m.osm]);
      if (!artifact) { console.log(`  ✗ ${m.slug}: no in-polygon grid points — skipped`); failed++; continue; }
      fs.writeFileSync(path.join(OUT, `${m.slug}.json`), JSON.stringify(artifact));
      ok++;
      const st = artifact.stats;
      console.log(`  ✓ ${m.slug}: ${st.samples} samples (${st.gaps} gaps) · relief ${st.relief_ft} ft · p90−p10 ${st.relief_p90_p10_ft} ft · mean slope ${st.mean_slope_pct}% · ${Date.now() - t0} ms`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${m.slug}: ${e.message} — skipped (rerun resumes here)`);
    }
  }
  console.log(`\n✓ sampler done: ${ok} ok · ${failed} failed · DEM cache ${JSON.stringify(cacheStats())}`);
})().catch((e) => {
  console.error("boundary sampler failed:", e);
  process.exit(1);
});

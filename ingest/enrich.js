#!/usr/bin/env node
/**
 * GreenBook Challenge enrichment — Phase 4, national scale.
 *
 *   node ingest/enrich.js [--count N] [--dry-run]
 *
 * Per-tee ratings/slope from the OpenGolfAPI detail endpoint for all matched
 * registry clusters, prioritized:
 *   (a) course-level-terrain courses (qualified boundary-grid artifacts) —
 *       ratings take them from 1 counted axis to 2;
 *   (b) remaining matched clusters from the boundary census.
 *
 * Rules (README + Phase 4 brief):
 *   - Throttled (~1.2 s + jitter; 429/5xx back off harder). Resumable:
 *     records that already carry tees are skipped, and 404/empty responses
 *     are logged to data/starpoint/enrichment.json as not_available —
 *     ATTEMPTED · NOT AVAILABLE, never retried in a loop, never guessed.
 *   - Enriched tees land in the open registry shards (ODbL), every tee
 *     cited OPENGOLFAPI — the same shape the Phase 2 cohort enrichment
 *     used, so Challenge activates with zero scoring changes.
 *   - No bulk ratings release was reachable from this session (the public
 *     distribution at github.com/opengolfapi/data is outside the session's
 *     GitHub scope); the detail endpoint is the fallback the brief allows.
 *   - Checkpoint: run --count 500 first and report the hit rate before
 *     burning the full ~9k requests.
 */

const fs = require("fs");
const path = require("path");
const { request } = require("./net");

const ROOT = path.join(__dirname, "..");
const REG = path.join(ROOT, "data", "open", "registry");
const TERRAIN = path.join(ROOT, "data", "open", "terrain-course");
const LOG = path.join(ROOT, "data", "starpoint", "enrichment.json");
const API = "https://api.opengolfapi.org";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv;
const COUNT = argv.includes("--count") ? +argv[argv.indexOf("--count") + 1] : Infinity;
const DRY = argv.includes("--dry-run");

(async () => {
  /* ---- registry shards (in-memory; flushed periodically) ---- */
  const shards = new Map(); // state -> {path, data, dirty}
  const bySlug = new Map();
  for (const f of fs.readdirSync(path.join(REG, "state"))) {
    const p = path.join(REG, "state", f);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const st = { path: p, data, dirty: false };
    shards.set(f.replace(".json", ""), st);
    for (const c of data.courses) bySlug.set(c.slug, { rec: c, shard: st });
  }

  const log = fs.existsSync(LOG)
    ? JSON.parse(fs.readFileSync(LOG, "utf8"))
    : { _license: "All rights reserved, Starpoint LLC", note: "Enrichment attempt ledger. not_available = OpenGolfAPI detail endpoint queried, no ratings published — ATTEMPTED · NOT AVAILABLE, never retried in a loop, never guessed.", attempted: {} };

  /* ---- priority queue ---- */
  const queue = JSON.parse(fs.readFileSync(path.join(__dirname, "boundary-queue.json"), "utf8")).queue;
  const terrainQualified = new Set();
  if (fs.existsSync(TERRAIN))
    for (const f of fs.readdirSync(TERRAIN)) {
      const a = JSON.parse(fs.readFileSync(path.join(TERRAIN, f), "utf8"));
      if (a.stats && !a.stats.low_coverage) terrainQualified.add(a.slug);
    }
  const tierA = queue.filter((m) => terrainQualified.has(m.slug)).map((m) => m.slug);
  const tierB = queue.filter((m) => !terrainQualified.has(m.slug)).map((m) => m.slug);
  const ordered = tierA.concat(tierB);

  const todo = [];
  let skippedEnriched = 0, skippedNA = 0;
  for (const slug of ordered) {
    if (todo.length >= COUNT) break;
    const hit = bySlug.get(slug);
    if (!hit) continue;
    if (hit.rec.tees !== undefined) { skippedEnriched++; continue; }         // already enriched
    const att = log.attempted[slug];
    if (att && att.status === "not_available") { skippedNA++; continue; }    // never retried in a loop
    todo.push({ slug, ...hit });
  }
  console.log(`enrich: ${todo.length} to attempt (tier A ${tierA.length} terrain-course · tier B ${tierB.length} other matched)`);
  console.log(`        skipped: ${skippedEnriched} already enriched · ${skippedNA} previously ATTEMPTED · NOT AVAILABLE${DRY ? " [DRY RUN]" : ""}\n`);
  if (DRY) { todo.slice(0, 20).forEach((t) => console.log("  " + t.slug)); return; }

  const flush = () => {
    for (const st of shards.values()) if (st.dirty) { fs.writeFileSync(st.path, JSON.stringify(st.data)); st.dirty = false; }
    fs.writeFileSync(LOG, JSON.stringify(log, null, 1)); // shards first: a crash re-attempts, never skips unsaved data
  };

  let hits = 0, hitsSlopeOnly = 0, empty = 0, notFound = 0, errors = 0, done = 0;
  for (const { slug, rec, shard } of todo) {
    let res = null, backoff = 4000;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        res = await request(`${API}/api/v1/courses/${rec.id}`, { headers: { "User-Agent": "GreenBook/1.0 (github.com/CaptainMig/greenbook)" }, timeout: 30000 });
      } catch (e) { res = { status: -1, err: e.message }; }
      if (res.status === 429 || res.status >= 500 || res.status === -1) { await sleep(backoff); backoff *= 2; continue; }
      break;
    }
    done++;
    if (res.status === 404) {
      notFound++;
      log.attempted[slug] = { status: "not_available", code: 404, at: new Date().toISOString() };
    } else if (res.status === 200) {
      let tees = [];
      try { tees = (JSON.parse(res.buffer.toString()).tees || []).filter((t) => t.gender !== "Female"); } catch (e) { tees = []; }
      const rated = tees.filter((t) => t.slope); // slope-only accepted (Phase 2 rule); slope is the Challenge input
      if (!rated.length) {
        empty++;
        log.attempted[slug] = { status: "not_available", code: 200, note: "no rated tee sets in response", at: new Date().toISOString() };
      } else {
        if (rated.every((t) => t.course_rating == null)) hitsSlopeOnly++;
        hits++;
        rec.tees = tees.map((t) => ({
          tee_key: t.tee_key, tee_name: t.tee_name, tee_color: t.tee_color,
          course_rating: t.course_rating, slope: t.slope, par: t.par, yardage: t.yardage,
          source: "OPENGOLFAPI",
        }));
        rec.enriched_at = new Date().toISOString();
        shard.dirty = true;
        log.attempted[slug] = { status: "ok", tees: rated.length, at: rec.enriched_at };
      }
    } else {
      errors++; // transient exhausted or unexpected status: NOT logged as not_available — a rerun retries it
      console.log(`  ✗ ${slug}: ${res.status === -1 ? res.err : "HTTP " + res.status} (will retry on rerun)`);
    }
    if (done % 25 === 0) {
      flush();
      console.log(`  [${done}/${todo.length}] hits ${hits} (${(hits / done * 100).toFixed(1)}%) · empty ${empty} · 404 ${notFound} · errors ${errors}`);
    }
    await sleep(1000 + Math.random() * 400);
  }
  flush();
  console.log(`\n✓ enrich done: ${done} attempted · ${hits} with ratings (${(done ? hits / done * 100 : 0).toFixed(1)}% hit rate, ${hitsSlopeOnly} slope-only) · ${empty} empty · ${notFound} 404 · ${errors} transient errors`);
})().catch((e) => { console.error("enrich failed:", e); process.exit(1); });

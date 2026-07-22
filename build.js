#!/usr/bin/env node
/**
 * GreenBook static build — Phase 2.
 *
 * ONE course template + ONE play template serve every slug via Vercel rewrites
 * (/c/:slug → /c/course.html). No per-course HTML generation — 15,600+ courses,
 * five HTML files.
 *
 *   dist/index.html         home
 *   dist/courses.html       national registry index (search + state filter)
 *   dist/attribution.html   licenses + credits
 *   dist/c/course.html      course intelligence view (runtime fetch by slug)
 *   dist/c/play.html        on-course play view (runtime fetch by slug)
 *   dist/assets/greenbook.js
 *   dist/data/open/**       ODbL collective database (registry, geometry, elevation)
 *   dist/data/starpoint/**  proprietary scoring layer (config, overlays, scores)
 *
 * Build-time scoring: axis outputs are materialized to data/starpoint/scores/
 * for every course with a Starpoint overlay or an ingest artifact. Scores are
 * NEVER written into data/open — a purity gate fails the build if score-like
 * keys appear anywhere in the open tree.
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const read = (p) => fs.readFileSync(p, "utf8");

/* ---------- load the shared scoring runtime (same code the pages run) ---------- */
const gbSrc = read(path.join(ROOT, "templates", "assets", "greenbook.js"));
const windowShim = {};
new Function("window", "location", gbSrc)(windowShim, { pathname: "/" });
const GB = windowShim.GB;

/* ---------- purity gate: no computed scores in the open tree ---------- */
const FORBIDDEN = /^(score|scores|verdict|verdicts|composite|axis|axes)$/i;
function purityCheck(dir, bad = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) purityCheck(p, bad);
    else if (f.name.endsWith(".json")) {
      const walk = (o) => {
        if (Array.isArray(o)) o.forEach(walk);
        else if (o && typeof o === "object")
          for (const k of Object.keys(o)) {
            if (FORBIDDEN.test(k)) bad.push(`${p} → key "${k}"`);
            walk(o[k]);
          }
      };
      walk(JSON.parse(read(p)));
    }
  }
  return bad;
}

/* recursive over ALL of data/open — including data/open/terrain-course/ (Phase 3
 * boundary-grid artifacts): samples and summaries are open facts; scores, caps
 * and match judgments live only in data/starpoint. */
const violations = purityCheck(path.join(ROOT, "data", "open"));
if (violations.length) {
  console.error("✗ PURITY GATE FAILED — computed scores in data/open:");
  violations.forEach((v) => console.error("  " + v));
  process.exit(1);
}
console.log("✓ purity gate: data/open contains no score-like keys (incl. terrain-course tree)");

/* ---------- registry validator → data/starpoint/quality/ ----------
 * Grades every registry record. A nine is a legitimate course type, never an
 * incomplete eighteen: intended size is inferred FIRST (from stated par via
 * par-per-hole plausibility, else hole numbering), THEN completeness is graded
 * against it. Grades are Starpoint outputs — they never touch data/open. */
const SIZES = [9, 18, 27, 36];
function inferSize(rec) {
  if (rec.par) {
    for (const s of SIZES) {
      const pph = rec.par / s;
      if (pph >= 2.7 && pph <= 5.5) return s; // par 27–37 → 9; par 58–74 → 18
    }
  }
  const n = Math.max(rec.holes || 0, ...(rec.scorecard || []).map((h) => h.hole || 0));
  if (n === 0) return null;
  return SIZES.find((s) => s >= n) || 36;
}
function gradeRecord(rec) {
  const sc = rec.scorecard || [];
  const present = sc.length;
  const inferred = inferSize(rec);
  const parSummed = sc.reduce((s, h) => s + (h.par || 0), 0) || null;
  const flags = [];
  let grade;
  if (present === 0) {
    grade = "STUB";
    flags.push("registry identity only — no per-hole data");
  } else if (inferred && present < inferred) {
    grade = "PARTIAL";
    flags.push(`CARD PARTIAL · ${present}/${inferred} HOLES`);
    if (rec.par && parSummed && parSummed < rec.par - 2)
      flags.push(`hole count and par sum mutually implausible: ${present} holes summing ${parSummed} against stated par ${rec.par}`);
  } else {
    grade = "FULL";
    if (rec.par && parSummed && Math.abs(parSummed - rec.par) > 2)
      flags.push(`PAR MISMATCH · card sums ${parSummed} vs stated ${rec.par}`);
  }
  return { grade, inferred, present, par_stated: rec.par ?? null, par_summed: parSummed, flags };
}

const qualityDir = path.join(ROOT, "data", "starpoint", "quality");
fs.rmSync(qualityDir, { recursive: true, force: true });
fs.mkdirSync(path.join(qualityDir, "state"), { recursive: true });
const stateDir = path.join(ROOT, "data", "open", "registry", "state");
const gradeIndex = {};
const gradeCounts = { FULL: 0, PARTIAL: 0, STUB: 0 };
const artifactSlugs = fs.existsSync(path.join(ROOT, "data", "open", "courses"))
  ? fs.readdirSync(path.join(ROOT, "data", "open", "courses")).map((f) => f.replace(".json", "")) : [];
const qualityBySlug = new Map();
const shardQuality = new Map(); // state file -> {state, courses:{}}
const shardRecords = new Map(); // state file -> records
for (const f of fs.readdirSync(stateDir)) {
  const shard = JSON.parse(read(path.join(stateDir, f)));
  const out = {};
  for (const rec of shard.courses) {
    const q = gradeRecord(rec);
    out[rec.slug] = q;
    qualityBySlug.set(rec.slug, q);
    gradeIndex[rec.slug] = q.grade;
    gradeCounts[q.grade]++;
  }
  shardQuality.set(f, { state: shard.state, courses: out });
  shardRecords.set(f, shard.courses);
}

/* ---------- dedup pass: cluster same-course registry records ----------
 * Judgment layer only — data/open stays exactly as received. Clusters by
 * normalized name + state + ~1 km proximity; primary = most complete card. */
const normName = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, " ")
  .replace(/\b(the|golf|club|course|country|cc|gc|links|at)\b/g, " ")
  .replace(/\s+/g, " ").trim();
const dKm = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const s = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const clusters = [];
for (const [f, records] of shardRecords) {
  const byName = new Map();
  for (const rec of records) {
    const k = normName(rec.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(rec);
  }
  for (const [k, recs] of byName) {
    if (recs.length < 2) continue;
    // proximity-link within the name group (~1.2 km)
    const used = new Set();
    for (let i = 0; i < recs.length; i++) {
      if (used.has(i)) continue;
      const group = [recs[i]]; used.add(i);
      for (let j = i + 1; j < recs.length; j++) {
        if (used.has(j)) continue;
        if (group.some((g) => dKm(g, recs[j]) <= 1.2)) { group.push(recs[j]); used.add(j); }
      }
      if (group.length < 2) continue;
      group.sort((a, b) => (qualityBySlug.get(b.slug).present - qualityBySlug.get(a.slug).present) || a.slug.localeCompare(b.slug));
      clusters.push({
        state: group[0].state, name: group[0].name, city: group[0].city,
        primary: group[0].slug,
        members: group.map((g) => {
          const q = qualityBySlug.get(g.slug);
          return { slug: g.slug, id: g.id, present: q.present, inferred: q.inferred, grade: q.grade, lat: g.lat, lon: g.lon };
        }),
      });
    }
  }
}
const shadowed = [];
const dupPrimaries = {};
for (const cl of clusters) {
  dupPrimaries[cl.primary] = cl.members.length;
  for (const m of cl.members) {
    const st = cl.state + ".json";
    const entry = shardQuality.get(st).courses[m.slug];
    if (m.slug === cl.primary) entry.dup_members = cl.members.filter((x) => x.slug !== cl.primary).map((x) => x.slug);
    else { entry.dup_primary = cl.primary; shadowed.push(m.slug); }
  }
}
fs.writeFileSync(path.join(qualityDir, "duplicates.json"), JSON.stringify({
  _license: "All rights reserved, Starpoint LLC",
  note: "Starpoint judgment layer. data/open registry records are untouched — clusters name likely-identical courses; primary = most complete card.",
  cluster_count: clusters.length,
  shadowed_count: shadowed.length,
  clusters,
}, null, 1));
console.log(`✓ dedup: ${clusters.length} duplicate clusters (${shadowed.length} shadowed records) → data/starpoint/quality/duplicates.json`);

for (const [f, sq] of shardQuality) {
  fs.writeFileSync(path.join(qualityDir, "state", f), JSON.stringify({
    _license: "All rights reserved, Starpoint LLC", ...sq,
  }));
}
/* partial ratios for /courses chips ("CARD PARTIAL 4/9") */
const partialRatio = {};
for (const [slug, q] of qualityBySlug) if (q.grade === "PARTIAL" && q.inferred) partialRatio[slug] = `${q.present}/${q.inferred}`;
console.log(`✓ registry graded: ${gradeCounts.FULL} card-complete · ${gradeCounts.PARTIAL} card-partial · ${gradeCounts.STUB} stub → data/starpoint/quality/`);

/* ---------- materialize axis outputs → data/starpoint/scores/<slug>.json ---------- */
const scoring = JSON.parse(read(path.join(ROOT, "data", "starpoint", "scoring.json")));
const scoresDir = path.join(ROOT, "data", "starpoint", "scores");
fs.rmSync(scoresDir, { recursive: true, force: true });
fs.mkdirSync(scoresDir, { recursive: true });

const overlayDir = path.join(ROOT, "data", "starpoint", "courses");
const artifactDir = path.join(ROOT, "data", "open", "courses");
const courseTerrainDir = path.join(ROOT, "data", "open", "terrain-course");
const slugs = new Set();
if (fs.existsSync(overlayDir)) fs.readdirSync(overlayDir).forEach((f) => slugs.add(f.replace(".json", "")));
if (fs.existsSync(artifactDir)) fs.readdirSync(artifactDir).forEach((f) => slugs.add(f.replace(".json", "")));
if (fs.existsSync(courseTerrainDir)) fs.readdirSync(courseTerrainDir).forEach((f) => slugs.add(f.replace(".json", "")));

const aliases = JSON.parse(read(path.join(ROOT, "data", "open", "registry", "aliases.json")));
const shardCache = new Map();
function regFor(slug) {
  const alias = aliases[slug];
  let state = alias && alias.state ? alias.state : (slug.match(/-([a-z]{2})$/) || [])[1];
  if (!state) return null;
  state = state.toUpperCase();
  if (!shardCache.has(state)) {
    const p = path.join(ROOT, "data", "open", "registry", "state", `${state}.json`);
    shardCache.set(state, fs.existsSync(p) ? JSON.parse(read(p)) : null);
  }
  const shard = shardCache.get(state);
  return shard ? shard.courses.find((c) => c.slug === slug) || null : null;
}

const axesBySlug = {};
const courseTerrainLive = []; // slugs whose Terrain axis runs COURSE-LEVEL (no hole artifact)
for (const slug of [...slugs].sort()) {
  const overlayP = path.join(overlayDir, `${slug}.json`);
  const artifactP = path.join(artifactDir, `${slug}.json`);
  const ctP = path.join(courseTerrainDir, `${slug}.json`);
  const overlay = fs.existsSync(overlayP) ? JSON.parse(read(overlayP)) : null;
  const artifact = fs.existsSync(artifactP) ? JSON.parse(read(artifactP)) : null;
  const courseTerrain = fs.existsSync(ctP) ? JSON.parse(read(ctP)) : null;
  const C = GB.normalize(slug, regFor(slug), artifact, overlay, null, scoring, qualityBySlug.get(slug) || null, null, courseTerrain);
  const R = GB.computeAxes(C);
  if (R.counted > 0) axesBySlug[slug] = R.counted;
  if (!artifact && courseTerrain && GB.courseTerrainQualifies(courseTerrain)) courseTerrainLive.push(slug);
  fs.writeFileSync(path.join(scoresDir, `${slug}.json`), JSON.stringify({
    _license: "All rights reserved, Starpoint LLC",
    slug, computed: new Date().toISOString(),
    ...R,
  }, null, 1));
}
console.log(`✓ axis outputs materialized for ${slugs.size} courses → data/starpoint/scores/`);

/* quality index ships grade + partial ratio + qualified-axes count per slug */
fs.writeFileSync(path.join(qualityDir, "index.json"), JSON.stringify({
  _license: "All rights reserved, Starpoint LLC",
  counts: gradeCounts, terrain_live: artifactSlugs, terrain_course: courseTerrainLive, grades: gradeIndex,
  partials: partialRatio, axes: axesBySlug,
  dup_primaries: dupPrimaries, shadowed,
}));

/* ---------- assemble dist ---------- */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "c"), { recursive: true });
fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });

const tpl = (n) => read(path.join(ROOT, "templates", n));
fs.writeFileSync(path.join(DIST, "courses.html"), tpl("courses.html"));
fs.writeFileSync(path.join(DIST, "attribution.html"), tpl("attribution.html"));
fs.writeFileSync(path.join(DIST, "c", "course.html"), tpl("course.html"));
fs.writeFileSync(path.join(DIST, "c", "play.html"), tpl("play.html"));
fs.writeFileSync(path.join(DIST, "assets", "greenbook.js"), gbSrc);

/* home: flagship + demo cards, chips from live coverage */
const allentownArtifact = fs.existsSync(path.join(artifactDir, "allentown.json"))
  ? JSON.parse(read(path.join(artifactDir, "allentown.json"))) : null;
const cards = [
  { slug: "allentown", name: "Allentown Municipal", loc: "3400 Tilghman St, Allentown PA 18104",
    chip: allentownArtifact ? `COVERAGE ${allentownArtifact.coverage.toUpperCase()} · OSM + 3DEP` : "COVERAGE NONE", cls: "ver" },
  { slug: "bethpage-black", name: "Bethpage Black", loc: "Farmingdale, NY — DEMO LAYER", chip: "DEMO LAYER", cls: "dem" },
  { slug: "swope-memorial", name: "Swope Memorial", loc: "Kansas City, MO — DEMO LAYER", chip: "DEMO LAYER", cls: "dem" },
];
const cohortCount = fs.existsSync(artifactDir) ? fs.readdirSync(artifactDir).length - 1 : 0;
if (cohortCount > 0) cards.push({
  slug: null, href: "/courses", name: `Live-terrain cohort · ${cohortCount} courses`,
  loc: "OSM centerlines + USGS 3DEP GeoTIFF ingest — first tranche of the terrain queue",
  chip: "TERRAIN LIVE", cls: "ver",
});
const cardHtml = cards.map((c) => `    <a class="course" href="${c.href || "/c/" + c.slug}">
      <span><span class="nm">${c.name}</span><br><span class="loc">${c.loc}</span></span>
      <span class="chip ${c.cls}">${c.chip}</span>
    </a>`).join("\n");
fs.writeFileSync(path.join(DIST, "index.html"), tpl("home.html").replace("<!--COURSE_LIST-->", cardHtml));

/* data trees — both, verbatim (LICENSE + ATTRIBUTION ship with the site) */
fs.cpSync(path.join(ROOT, "data"), path.join(DIST, "data"), { recursive: true });

const count = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => String(f).endsWith(".json")).length;
console.log(`✓ dist assembled — open tree ${count(path.join(DIST, "data", "open"))} JSON files, starpoint ${count(path.join(DIST, "data", "starpoint"))}`);

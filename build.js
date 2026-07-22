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

const violations = purityCheck(path.join(ROOT, "data", "open"));
if (violations.length) {
  console.error("✗ PURITY GATE FAILED — computed scores in data/open:");
  violations.forEach((v) => console.error("  " + v));
  process.exit(1);
}
console.log("✓ purity gate: data/open contains no score-like keys");

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
    flags.push(`PARTIAL · ${present}/${inferred} HOLES`);
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
  fs.writeFileSync(path.join(qualityDir, "state", f), JSON.stringify({
    _license: "All rights reserved, Starpoint LLC", state: shard.state, courses: out,
  }));
}
fs.writeFileSync(path.join(qualityDir, "index.json"), JSON.stringify({
  _license: "All rights reserved, Starpoint LLC",
  counts: gradeCounts, terrain_live: artifactSlugs, grades: gradeIndex,
}));
console.log(`✓ registry graded: ${gradeCounts.FULL} FULL · ${gradeCounts.PARTIAL} PARTIAL · ${gradeCounts.STUB} STUB → data/starpoint/quality/`);

/* ---------- materialize axis outputs → data/starpoint/scores/<slug>.json ---------- */
const scoring = JSON.parse(read(path.join(ROOT, "data", "starpoint", "scoring.json")));
const scoresDir = path.join(ROOT, "data", "starpoint", "scores");
fs.rmSync(scoresDir, { recursive: true, force: true });
fs.mkdirSync(scoresDir, { recursive: true });

const overlayDir = path.join(ROOT, "data", "starpoint", "courses");
const artifactDir = path.join(ROOT, "data", "open", "courses");
const slugs = new Set();
if (fs.existsSync(overlayDir)) fs.readdirSync(overlayDir).forEach((f) => slugs.add(f.replace(".json", "")));
if (fs.existsSync(artifactDir)) fs.readdirSync(artifactDir).forEach((f) => slugs.add(f.replace(".json", "")));

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

for (const slug of [...slugs].sort()) {
  const overlayP = path.join(overlayDir, `${slug}.json`);
  const artifactP = path.join(artifactDir, `${slug}.json`);
  const overlay = fs.existsSync(overlayP) ? JSON.parse(read(overlayP)) : null;
  const artifact = fs.existsSync(artifactP) ? JSON.parse(read(artifactP)) : null;
  const C = GB.normalize(slug, regFor(slug), artifact, overlay, null, scoring, qualityBySlug.get(slug) || null);
  const R = GB.computeAxes(C);
  fs.writeFileSync(path.join(scoresDir, `${slug}.json`), JSON.stringify({
    _license: "All rights reserved, Starpoint LLC",
    slug, computed: new Date().toISOString(),
    ...R,
  }, null, 1));
}
console.log(`✓ axis outputs materialized for ${slugs.size} courses → data/starpoint/scores/`);

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

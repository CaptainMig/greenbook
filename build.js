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
  const C = GB.normalize(slug, regFor(slug), artifact, overlay, null, scoring);
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

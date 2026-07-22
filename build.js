#!/usr/bin/env node
/**
 * GreenBook static build — flat-file pattern (AnthonyCharts v17).
 *
 *   data/registry.json  +  data/courses/<slug>.json (ingest artifacts)
 *      → dist/index.html                 (course directory)
 *      → dist/c/<slug>/index.html        (course intelligence view)
 *      → dist/c/<slug>/play/index.html   (on-course play view)
 *      → dist/data/courses/<slug>.json   (raw artifact, linked from ledger)
 *
 * No runtime backend. Course JSON is inlined at build time as window.COURSE.
 * Registry metadata never overwrites ingest-artifact fields — the artifact wins.
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const read = (p) => fs.readFileSync(p, "utf8");
const tpl = {
  home: read(path.join(ROOT, "templates", "home.html")),
  course: read(path.join(ROOT, "templates", "course.html")),
  play: read(path.join(ROOT, "templates", "play.html")),
};

const registry = JSON.parse(read(path.join(ROOT, "data", "registry.json"))).courses;

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "data", "courses"), { recursive: true });

// </script> inside a JSON string would close the tag — escape for safe inlining
const inline = (obj) =>
  `<script>window.COURSE = ${JSON.stringify(obj).replace(/</g, "\\u003c")};</script>`;

const cards = [];

for (const reg of registry) {
  const artifactPath = path.join(ROOT, "data", "courses", `${reg.slug}.json`);
  let artifact = null;
  if (fs.existsSync(artifactPath)) {
    artifact = JSON.parse(read(artifactPath));
    fs.copyFileSync(artifactPath, path.join(DIST, "data", "courses", `${reg.slug}.json`));
  }

  // Registry supplies metadata; the ingest artifact wins on every shared field.
  const course = { coverage: reg.demo ? "demo" : "none", ...reg, ...(artifact || {}) };

  if (!reg.demo && (!artifact || course.coverage === "none")) {
    // Honest state: a real course with no ingest coverage renders gated, never demo-filled.
    course.holes = (artifact && artifact.holes) || [];
    console.log(`  ⚠ ${reg.slug}: no ingest coverage — page renders gated (coverage:none).`);
  }

  const dir = path.join(DIST, "c", course.slug);
  fs.mkdirSync(path.join(dir, "play"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), tpl.course.replace("<!--COURSE_DATA-->", inline(course)));
  fs.writeFileSync(path.join(dir, "play", "index.html"), tpl.play.replace("<!--COURSE_DATA-->", inline(course)));

  const chip = reg.demo
    ? `<span class="chip dem">DEMO LAYER</span>`
    : course.coverage === "none"
      ? `<span class="chip dem">COVERAGE NONE · AWAITING OSM</span>`
      : `<span class="chip ver">COVERAGE ${String(course.coverage).toUpperCase()} · OSM + 3DEP</span>`;
  cards.push(`    <a class="course" href="/c/${course.slug}">
      <span><span class="nm">${course.name}</span><br><span class="loc">${course.location || ""}</span></span>
      ${chip}
    </a>`);
  console.log(`  ✓ /c/${course.slug} + /c/${course.slug}/play (${reg.demo ? "demo" : "coverage:" + course.coverage})`);
}

fs.writeFileSync(path.join(DIST, "index.html"), tpl.home.replace("<!--COURSE_LIST-->", cards.join("\n")));
console.log(`\n✓ built ${registry.length} courses → dist/`);

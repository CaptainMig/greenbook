#!/usr/bin/env node
/**
 * GreenBook registry seeder — OpenGolfAPI bulk release → data/open/registry/.
 *
 *   node ingest/registry.js --src <opengolfapi-us.ndjson> [--release v2.1.0]
 *   node ingest/registry.js --enrich slug1,slug2   (per-course tee/rating detail via API)
 *
 * Provenance: every field cites OPENGOLFAPI (ODbL) — NOT USGA — until independently
 * verified. Enrichment adds per-tee ratings from the OpenGolfAPI detail endpoint.
 * This tree is ODbL: no computed scores are ever written here.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REG = path.join(ROOT, "data", "open", "registry");
const API = "https://api.opengolfapi.org";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = {};
process.argv.slice(2).forEach((a, i, arr) => { if (a.startsWith("--")) args[a.slice(2)] = arr[i + 1]; });

const kebab = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const META = (release) => ({
  license: "ODbL-1.0 — see /data/open/LICENSE",
  attribution: "OpenGolfAPI (opengolfapi.org), ODbL. Contains information from OpenStreetMap (© OpenStreetMap contributors).",
  source_release: release || "unknown",
  provenance_note: "All fields cite OPENGOLFAPI as source — not USGA — until independently verified per course.",
});

/* Manual slug aliases: flagship + demo pages keep their short slugs. */
const ALIASES = {
  allentown: { state: "PA", opengolfapi_id: "5830101c-3d28-400b-958d-22858dd81e98" },
  "bethpage-black": { demo: true },
  "swope-memorial": { demo: true },
};

if (args.src) seed();
else if (args.enrich) enrich(args.enrich.split(","));
else { console.error("usage: --src <ndjson> | --enrich slug1,slug2"); process.exit(1); }

function seed() {
  const release = args.release || "v2.1.0";
  const lines = fs.readFileSync(args.src, "utf8").split("\n").filter(Boolean);
  console.log(`${lines.length} records from ${args.src}`);

  const byState = new Map();
  const index = [];
  const slugSeen = new Set(Object.keys(ALIASES));
  const idAlias = {};
  for (const [slug, a] of Object.entries(ALIASES)) if (a.opengolfapi_id) idAlias[a.opengolfapi_id] = slug;

  for (const line of lines) {
    const f = JSON.parse(line);
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const st = (p.state || "XX").toUpperCase();
    let slug = idAlias[p.id];
    if (!slug) {
      slug = `${kebab(p.name)}-${st.toLowerCase()}`;
      if (slugSeen.has(slug)) {
        const withCity = `${kebab(p.name)}-${kebab(p.city || "x")}-${st.toLowerCase()}`;
        slug = slugSeen.has(withCity) ? null : withCity;
        let n = 2;
        while (!slug) { const s2 = `${withCity}-${n++}`; if (!slugSeen.has(s2)) slug = s2; }
      }
    }
    slugSeen.add(slug);

    const rec = {
      slug, id: p.id, name: p.name, city: p.city, state: st, type: p.type,
      lat: +lat.toFixed(6), lon: +lon.toFixed(6),
      holes: p.holes, par: p.par, yardage: p.total_yardage,
      architect: p.architect, year_built: p.year_built, website: p.website,
      osm_id: p.osm_id,
      scorecard: p.scorecard || [],
      source: "OPENGOLFAPI",
    };
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(rec);
    index.push({ slug, name: p.name, city: p.city, state: st, holes: p.holes, par: p.par, yardage: p.total_yardage });
  }

  fs.mkdirSync(path.join(REG, "state"), { recursive: true });
  for (const [st, courses] of byState) {
    courses.sort((a, b) => a.slug.localeCompare(b.slug));
    fs.writeFileSync(path.join(REG, "state", `${st}.json`), JSON.stringify({ ...META(release), state: st, courses }));
  }
  index.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(path.join(REG, "index.json"), JSON.stringify({ ...META(release), count: index.length, courses: index }));
  fs.writeFileSync(path.join(REG, "aliases.json"), JSON.stringify(ALIASES, null, 1));
  console.log(`✓ ${index.length} courses → ${byState.size} state shards + index.json + aliases.json`);
}

async function enrich(slugs) {
  for (const slug of slugs) {
    const alias = ALIASES[slug];
    let state = alias && alias.state ? alias.state : (slug.match(/-([a-z]{2})$/) || [])[1];
    if (!state) { console.log(`✗ ${slug}: cannot infer state`); continue; }
    state = state.toUpperCase();
    const shardPath = path.join(REG, "state", `${state}.json`);
    const shard = JSON.parse(fs.readFileSync(shardPath, "utf8"));
    const rec = shard.courses.find((c) => c.slug === slug);
    if (!rec) { console.log(`✗ ${slug}: not in ${state} shard`); continue; }
    const res = await fetch(`${API}/api/v1/courses/${rec.id}`, { headers: { "User-Agent": "GreenBook/1.0 (github.com/CaptainMig/greenbook)" } });
    if (!res.ok) { console.log(`✗ ${slug}: API ${res.status}`); await sleep(1500); continue; }
    const d = await res.json();
    rec.tees = (d.tees || []).filter((t) => t.gender !== "Female").map((t) => ({
      tee_key: t.tee_key, tee_name: t.tee_name, tee_color: t.tee_color,
      course_rating: t.course_rating, slope: t.slope, par: t.par, yardage: t.yardage,
      source: "OPENGOLFAPI",
    }));
    rec.enriched_at = new Date().toISOString();
    fs.writeFileSync(shardPath, JSON.stringify(shard));
    console.log(`✓ ${slug}: ${rec.tees.length} tee sets from OpenGolfAPI`);
    await sleep(1500);
  }
}

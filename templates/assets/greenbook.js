/* GreenBook runtime — render-time join of the open (ODbL) and Starpoint trees.
 *
 * Open tree   (/data/open):      registry shards, hole geometry, elevation. ODbL.
 * Starpoint   (/data/starpoint): scoring config, editorial overlays, computed scores.
 * The two join here, in the page, by slug. Open files never contain scores.
 *
 * Gating (unchanged): an axis counts only when VERIFIED or DERIVED; composite
 * needs >=3 counted axes; verdict bands 8.0 / 6.5 on a /10 scale.
 */
window.GB = (function () {
  const J = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  function slugFromPath() {
    const m = location.pathname.match(/^\/c\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : "allentown";
  }

  /* demo tee palette + factors — demo layer only, never applied to real data */
  const DEMO_TEES = [
    { id: "black", label: "Black", color: "#1b1b1b", dark: true, f: 1 },
    { id: "blue", label: "Blue", color: "#3a6ea5", f: 0.94 },
    { id: "white", label: "White", color: "#e9e4d3", f: 0.88 },
    { id: "gold", label: "Gold", color: "#c9a227", f: 0.8 },
    { id: "red", label: "Red", color: "#e23d2e", f: 0.72 },
  ];
  const TEE_COLORS = { black: "#1b1b1b", blue: "#3a6ea5", white: "#e9e4d3", gold: "#c9a227", yellow: "#c9a227", red: "#e23d2e", green: "#8fd6a0", silver: "#aaa", combo: "#9aa593" };

  function demoProfile(seed, h) {
    const s = seed * 31 + h * 7, n = 60, p = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      p.push(18 * Math.sin(t * Math.PI * 1.2 + s) + 9 * Math.sin(t * Math.PI * 2.6 + s * 1.7) + 5 * Math.sin(t * Math.PI * 5.1 + s * 0.6));
    }
    const b = p[0];
    return p.map((e) => e - b);
  }

  async function loadCourse(slug) {
    const [aliases, scoring] = await Promise.all([
      J("/data/open/registry/aliases.json"),
      J("/data/starpoint/scoring.json"),
    ]);
    const alias = (aliases && aliases[slug]) || null;
    let state = alias && alias.state ? alias.state : null;
    if (!state) {
      const m = slug.match(/-([a-z]{2})$/);
      if (m) state = m[1].toUpperCase();
    }

    const [shard, artifact, overlay, scores, qualityShard] = await Promise.all([
      state ? J(`/data/open/registry/state/${state}.json`) : Promise.resolve(null),
      J(`/data/open/courses/${slug}.json`),
      J(`/data/starpoint/courses/${slug}.json`),
      J(`/data/starpoint/scores/${slug}.json`),
      state ? J(`/data/starpoint/quality/state/${state}.json`) : Promise.resolve(null),
    ]);
    const reg = shard ? shard.courses.find((c) => c.slug === slug) || null : null;
    if (!reg && !overlay && !artifact) throw new Error("no data for slug " + slug);
    const quality = qualityShard && qualityShard.courses ? qualityShard.courses[slug] || null : null;
    return normalize(slug, reg, artifact, overlay, scores, scoring, quality);
  }

  function normalize(slug, reg, artifact, overlay, scores, scoring, quality) {
    const o = overlay || {};
    const demo = !!o.demo;
    const C = {
      slug, demo,
      scoring: scoring || { gates: { qualified_statuses: ["VERIFIED", "DERIVED"], min_axes: 3 }, verdict_bands: { strong_play: 8, play: 6.5 } },
      precomputed: scores || null,
      reg, artifact, overlay: o,
      name: (o.meta && o.meta.name) || (reg && reg.name) || slug,
      locLine: (o.meta && o.meta.locLine) || (reg ? `${reg.city}, ${reg.state} · ${reg.type || "Course"}` : ""),
      par: (reg && reg.par) || (o.meta && o.meta.par) || null,
      yards: (reg && reg.yardage) || (o.meta && o.meta.yards) || null,
      architect: (reg && reg.architect) || (o.meta && o.meta.architect) || null,
      founded: (reg && reg.year_built) || (o.meta && o.meta.founded) || null,
      seed: o.demoSeed || 7,
      quality: quality || null,
    };

    /* ---- holes ---- */
    if (artifact && artifact.holes && artifact.holes.length) {
      C.holes = artifact.holes;
      C.holeSource = "osm";
    } else if (demo && o.pars) {
      C.holes = o.pars.map((p, i) => ({ ref: String(i + 1), par: p, handicap: o.hcp[i], demo_yds: o.black[i], profile: null }));
      C.holeSource = "demo";
    } else if (reg && reg.scorecard && reg.scorecard.length) {
      C.holes = reg.scorecard.map((h) => ({ ref: String(h.hole), par: h.par, handicap: h.handicap_index, profile: null }));
      C.holeSource = "registry";
    } else C.holes = [];

    /* ---- ratings: overlay override (association tables) beats registry (OpenGolfAPI) ---- */
    const ro = o.ratings_override;
    if (ro) {
      C.ratingCards = ro.tees.map((t) => ({ tee: t.tee, color: t.color || TEE_COLORS[t.tee.toLowerCase()] || "#9aa593", dark: /black/i.test(t.tee), r: t.r, s: t.s, yds: t.yds || null, status: ro.status, srcLabel: ro.srcLabel }));
      C.rating = ro.tees[0].r; C.slope = ro.tees[0].s;
      C.ratingStatus = ro.status; C.ratingSrcLabel = ro.srcLabel;
    } else if (demo && o.ratings) {
      C.ratingCards = o.ratings.map((t) => ({ tee: t.tee, color: t.color, dark: /black/i.test(t.tee), r: t.r, s: t.s, status: t.st.toUpperCase(), srcLabel: "" }));
      C.rating = o.ratings[0].r; C.slope = o.ratings[0].s;
      C.ratingStatus = o.ratings[0].st.toUpperCase(); C.ratingSrcLabel = "";
    } else if (reg && reg.tees && reg.tees.length) {
      /* slope is the Challenge input; course_rating may be absent (e.g. executive layouts) */
      C.ratingCards = reg.tees.filter((t) => t.slope).map((t) => ({ tee: t.tee_name, color: TEE_COLORS[(t.tee_color || "").toLowerCase()] || "#9aa593", dark: /black/i.test(t.tee_name), r: t.course_rating ?? null, s: t.slope, yds: t.yardage || null, status: "DERIVED", srcLabel: "OPENGOLFAPI" }));
      if (C.ratingCards.length) {
        C.rating = C.ratingCards[0].r; C.slope = C.ratingCards[0].s;
        C.ratingStatus = "DERIVED"; C.ratingSrcLabel = "OPENGOLFAPI";
      } else C.ratingCards = [];
    } else C.ratingCards = [];
    if (C.rating === undefined) { C.rating = null; C.slope = null; C.ratingStatus = null; }

    /* ---- tee list for terrain/scorecard ---- */
    if (demo) {
      const avail = (o.ratings || []).map((r) => r.tee.toLowerCase());
      C.teeList = DEMO_TEES.filter((t) => !avail.length || avail.includes(t.id)).map((t) => ({ ...t, perHole: true }));
    } else if (C.holeSource === "osm") {
      C.teeList = [{ label: "Centerline", ydLabel: "Centerline yds · OSM", color: "#8fd6a0", perHole: true, centerline: true }];
    } else {
      C.teeList = [{ label: "Card", ydLabel: "Yds", color: "#9aa593", perHole: false }];
    }

    /* ---- copy strings ---- */
    C.cardSub = o.cardSub || (demo
      ? `All ${(o.ratings || []).length} rated tee sets, front and back. Hole values are a representative demo layout summing to the verified course total.`
      : C.holeSource === "osm"
        ? "Par and stroke index from OSM way tags; yardage is resampled centerline geometry — NOT card yardage. Card yardage stays withheld until a verified card is ledgered."
        : reg && reg.scorecard && reg.scorecard.length
          ? "Par and stroke index seeded from OpenGolfAPI (ODbL), cited as OPENGOLFAPI until independently verified. Per-hole yardage not in the registry."
          : "No per-hole card in any ledgered source.");
    C.terrainFlag = o.terrainFlag || (demo
      ? "▲ Demo layer — hole yardages are representative and elevation is synthetic until OSM centerlines + USGS 3DEP are ingested for this course."
      : C.holeSource === "osm" ? "" : "▲ Terrain gated — no OSM centerline coverage ingested for this course. Elevation is never synthesized.");

    /* ---- provenance rows ---- */
    if (o.prov) C.prov = o.prov;
    else {
      C.prov = [];
      if (reg) {
        C.prov.push(["Identity, city, type", "OpenGolfAPI registry (ODbL) — community-maintained", "DERIVED"]);
        const q = C.quality;
        if (q && q.grade === "PARTIAL")
          C.prov.push(["Hole-by-hole card", `OpenGolfAPI scorecard — cited as OPENGOLFAPI, not USGA. ${q.flags.join(" · ")}`, `PARTIAL · ${q.present}/${q.inferred} HOLES`]);
        else
          C.prov.push(["Par / stroke index", reg.scorecard && reg.scorecard.length ? "OpenGolfAPI scorecard — cited as OPENGOLFAPI, not USGA" : "Not present in registry record", reg.scorecard && reg.scorecard.length ? "DERIVED" : "WITHHELD"]);
        C.prov.push(["Ratings & slope", C.ratingCards.length ? "OpenGolfAPI per-tee crawl — cited as OPENGOLFAPI until independently verified" : "Not present in registry record", C.ratingCards.length ? "DERIVED" : "WITHHELD"]);
      }
      if (artifact) {
        C.prov.push(["Hole geometry", "OpenStreetMap via Overpass (ODbL)", "VERIFIED"]);
        C.prov.push(["Elevation profiles", artifact.sources && artifact.sources.elevation ? artifact.sources.elevation : "USGS 3DEP", "VERIFIED"]);
        C.prov.push(["Elevation Δ / centerline yds", "Computed from the two layers above", "DERIVED"]);
      } else {
        C.prov.push(["Hole geometry & elevation", "No OSM centerline ingest for this course yet", "WITHHELD"]);
      }
      C.prov.push(["Conditions & pace", "No ground truth ingested", "WITHHELD"]);
    }
    C.provNote = o.provNote || null;
    C.conflicts = o.conflicts || [];
    return C;
  }

  /* ---------- scoring: joins starpoint config + open inputs at render ---------- */
  function scoreCourse(C) {
    if (C.precomputed && C.precomputed.axes) {
      return C.precomputed; /* build-time output from data/starpoint/scores/<slug>.json */
    }
    return computeAxes(C);
  }

  function computeAxes(C) {
    const axes = [];
    const o = C.overlay || {};
    const oa = o.axes || {};

    /* Challenge — slope-driven, source-status inherited */
    if (C.slope) {
      const sc = Math.max(0, Math.min(10, ((C.slope - 55) / (155 - 55)) * 10));
      axes.push({ name: "Challenge", status: C.ratingStatus, srcLabel: C.ratingSrcLabel || "", score: +sc.toFixed(1), note: (oa.challenge && oa.challenge.note) || `Derived from slope ${C.slope}${C.rating ? " / rating " + C.rating : ""} — reproducible from the ledgered rating source. score = (slope−55)/100·10.` });
    } else {
      axes.push({ name: "Challenge", status: "WITHHELD", srcLabel: "", score: null, note: "No rating source ledgered for this course." });
    }

    /* Pedigree — editorial (Starpoint) */
    axes.push(oa.pedigree
      ? { name: "Pedigree", status: oa.pedigree.status, srcLabel: "STARPOINT", score: oa.pedigree.score, note: oa.pedigree.note }
      : { name: "Pedigree", status: "WITHHELD", srcLabel: "", score: null, note: "No editorial layer curated for this course yet." });

    /* Terrain — real ingest only */
    const deltas = (C.artifact && C.artifact.holes ? C.artifact.holes : []).map((h) => h.elev_delta_ft).filter((d) => d !== null && d !== undefined);
    if (deltas.length >= 14) {
      const meanAbs = deltas.reduce((s, d) => s + Math.abs(d), 0) / deltas.length;
      axes.push({ name: "Terrain", status: "DERIVED", srcLabel: "OSM + 3DEP", score: +Math.min(9.5, 2.0 + 0.22 * meanAbs).toFixed(1), note: `mean |Δelev| ${meanAbs.toFixed(1)} ft over ${deltas.length} ingested holes. score = 2.0 + 0.22·mean, cap 9.5.` });
    } else if (C.demo) {
      axes.push({ name: "Terrain", status: "DEMO", srcLabel: "", score: null, note: "Profiles below are placeholders. Axis activates when 3DEP + OSM centerlines land." });
    } else {
      axes.push({ name: "Terrain", status: "WITHHELD", srcLabel: "", score: null, note: "No OSM centerline coverage ingested. In the terrain queue if mapped; never synthesized." });
    }

    /* Access — editorial (Starpoint) */
    axes.push(oa.access
      ? { name: "Access", status: oa.access.status, srcLabel: "STARPOINT", score: oa.access.score, note: oa.access.note }
      : { name: "Access", status: "WITHHELD", srcLabel: "", score: null, note: "No editorial layer curated for this course yet." });

    /* Conditions — withheld until a verified feed exists */
    axes.push(oa.conditions
      ? { name: "Conditions", status: oa.conditions.status, srcLabel: "", score: oa.conditions.score ?? null, note: oa.conditions.note }
      : { name: "Conditions", status: "WITHHELD", srcLabel: "", score: null, note: "No verified review or agronomy feed ingested. A gap is not a zero." });

    const g = C.scoring.gates;
    axes.forEach((a) => { a.counted = g.qualified_statuses.includes(a.status) && a.score !== null; });
    const counted = axes.filter((a) => a.counted);
    let verdict = "INSUFFICIENT", composite = null;
    if (counted.length >= g.min_axes) {
      composite = counted.reduce((s, a) => s + a.score, 0) / counted.length;
      const b = C.scoring.verdict_bands;
      verdict = composite >= b.strong_play ? "STRONG_PLAY" : composite >= b.play ? "PLAY" : "HOLD";
    }
    return { axes, counted: counted.length, composite, verdict };
  }

  /* ---------- per-hole helpers ---------- */
  function relProfile(C, i) {
    const h = C.holes[i];
    if (h && h.profile && h.profile.length) {
      const v = h.profile.filter((p) => p.elev_ft !== null);
      if (v.length >= 2) { const b = v[0].elev_ft; return v.map((p) => p.elev_ft - b); }
    }
    if (C.demo) return demoProfile(C.seed, i);
    return [];
  }

  function holeYds(C, i, teeIdx) {
    const h = C.holes[i];
    if (!h) return null;
    const t = C.teeList[teeIdx] || C.teeList[0];
    if (C.demo && h.demo_yds) return t.id === "black" ? h.demo_yds : Math.round((h.demo_yds * t.f) / 5) * 5;
    if (h.card_yds) return h.card_yds;
    if (h.length_yds) return h.length_yds;
    return null;
  }

  function attributionLine(C) {
    const osm = C && (C.holeSource === "osm");
    const parts = [];
    if (C && C.reg) parts.push('Registry: <a href="https://opengolfapi.org">OpenGolfAPI</a> (ODbL)');
    if (osm) parts.push('Geometry © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (ODbL) · Elevation: USGS 3DEP (public domain)');
    if (C && C.demo) parts.push("Demo layers labeled — no open data rendered for demo fields");
    parts.push('<a href="/attribution">Full attribution & licenses</a>');
    return parts.join(" · ");
  }

  return { slugFromPath, loadCourse, scoreCourse, computeAxes, normalize, relProfile, holeYds, attributionLine, demoProfile };
})();

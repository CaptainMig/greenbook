# GreenBook — course intelligence (Starpoint LLC)

A provenance-gated golf course intelligence layer. Directory pages → instruments.
Two views, one national registry, a build-time data pipeline, no runtime backend.

## Architecture (Phase 2)

- `templates/course.html` — desktop course view, reconciled against the recovered
  original design (`index-original.html`): sticky nav, course switcher, hero +
  verdict plate, 5 axis cards, interactive terrain cross-section with hover
  readout and tee selector, scorecard, per-tee rating cards, provenance ledger
  with flagged-conflict callout, pipeline map.
- `templates/play.html` — mobile on-course card: plays-like yardage, NOAA-fed
  firmness/roll-out (api.weather.gov precip on load, sliders as manual override,
  feed timestamp shown), gated shot verdict with one-way brake, calibration
  ledger (localStorage + JSON export).
- `templates/courses.html` — national index: client-side search + state filter
  over the registry (15,667 U.S. courses).
- `templates/attribution.html` — licenses and credits, linked from every footer.
- `templates/assets/greenbook.js` — shared runtime: loads open + Starpoint trees
  by slug, joins them at render, computes gated axes. build.js executes the SAME
  file to materialize scores, so page and build cannot drift.
- **Routing:** ONE course template + ONE play template serve every slug via
  Vercel rewrites (`/c/:slug` → `/c/course.html`). Registry-only courses fall
  back gracefully with the Terrain axis gated. No per-course HTML generation.

### Composite scale

The composite is **x.x / 10** with verdict bands STRONG PLAY ≥ 8.0 > PLAY ≥ 6.5
> HOLD, per the original design. (A Phase-1 interim rebuild displayed /100 while
the original file was missing; that rescale is reverted.)

## Licensing structure (non-negotiable)

- `data/open/` — **ODbL collective database**: registry (seeded from OpenGolfAPI
  release v2.1.0, sharded by state), hole geometry + elevation profiles
  (`courses/<slug>.json`). Ships with `LICENSE` (ODbL 1.0 text) and
  `ATTRIBUTION.md` (OpenGolfAPI, OpenStreetMap, USGS 3DEP, NOAA).
- `data/starpoint/` — **all rights reserved, Starpoint LLC**: `scoring.json`
  (gates, verdict bands, axis formulas), editorial overlays
  (`courses/<slug>.json`), materialized axis outputs (`scores/<slug>.json`).
- Computed scores are NEVER written into `data/open/`. The trees join only at
  render time, by slug. `build.js` enforces this with a purity gate that fails
  the build if score-like keys appear anywhere in the open tree.
- Registry fields cite OPENGOLFAPI as source — not USGA — until independently
  verified per course. Every page rendering OSM/OpenGolfAPI data carries
  attribution in the footer, linked to `/attribution`.

## Ingest pipeline (`ingest/`)

- `census.js` — nationwide Overpass sweep: 156,027 `golf=hole` ways across
  CONUS, matched to 8,600 named courses → `queue.json` ranked by completeness.
- `dem.js` — zero-dep USGS 3DEP 1/3″ GeoTIFF sampler: HTTP range-reads of tile
  headers + only the 512×512 internal blocks containing sample points (LZW +
  floating-point-predictor decode, bilinear interpolation). Validated to <1 ft
  against EPQS on the Allentown reference profile. EPQS stays as the
  single-course fallback (`ingest.js`).
- `cohort.js` — ingests the top of the queue (single-course layouts, 18–27
  holes, registry-matched) → `data/open/courses/`. Never synthesizes; skips
  honestly on missing coverage.
- `registry.js` — seeds `data/open/registry/` from the OpenGolfAPI bulk release;
  `--enrich slug…` adds per-tee ratings from the API (throttled).
- `ingest.js` — original single-course EPQS path (Allentown was ingested here).

## Non-negotiable rules (carry these into every change)

1. **Provenance statuses per field:** VERIFIED / DERIVED / APPROX / DEMO / WITHHELD.
   Demo layers are labeled, never blended into composites.
2. **Axis gating:** an axis scores only on VERIFIED or DERIVED inputs. Composite
   requires ≥3 qualified axes, else verdict = INSUFFICIENT DATA.
3. **Conflicting sources are flagged, not averaged.** Allentown case: the GAP
   handicap TABLE (72.2/129) is authoritative; the GAP directory marketing PROSE
   (72.4/132) is the flagged claim — and that prose value has propagated into
   OpenGolfAPI via the course-website crawl, so the registry tee card carries
   the flag too. One mismatch, three receipts.
4. **One-way brake in play view:** a HOLD does not upgrade to COMMIT within the same
   hole session.
5. **Attribution:** OSM + OpenGolfAPI data is ODbL — attribute on every page that
   renders it, linked to `/attribution`. USGS 3DEP + NOAA are public domain.
   Respect Overpass, EPQS, api.weather.gov and OpenGolfAPI rate limits.
6. USGA Rule 4.3 note: slope-adjusted advice may be restricted in competition;
   keep the calibration ledger (self-judgment) available in all modes.

## Build & deploy

```
node build.js    # purity gate → materialize scores → dist/ (static only)
vercel deploy    # rewrites: /c/:slug → course template, /c/:slug/play → play
```

# GreenBook — course intelligence (Starpoint LLC)

A provenance-gated golf course intelligence layer. Directory pages → instruments.
Two views, one build-time data pipeline, no runtime backend.

## What exists (prototype)

- `index.html` — desktop course page: verdict plate, 5 gated scoring axes, hole-by-hole
  elevation profiles, full scorecard across tee sets, provenance ledger, pipeline map.
  Three courses loaded: Allentown Municipal (real GAP ratings), Bethpage Black (demo),
  Swope Memorial (demo).
- `play.html` — mobile on-course card: plays-like yardage, firmness/roll-out heuristic,
  gated shot verdict with one-way brake, SUPERCASTER-style calibration ledger.
- `ingest/ingest.js` — Node 18+ zero-dep script: Overpass (OSM golf=hole centerlines
  + hazard polygons) → resample every 20 m → USGS 3DEP EPQS elevation → emits
  `data/courses/<slug>.json`. Emits an honest `coverage:"none"` stub when OSM has
  no centerlines. Never synthesizes.

## Non-negotiable rules (carry these into every change)

1. **Provenance statuses per field:** VERIFIED / DERIVED / APPROX / DEMO / WITHHELD.
   Demo layers are labeled, never blended into composites.
2. **Axis gating:** an axis scores only on VERIFIED or DERIVED inputs. Composite
   requires ≥3 qualified axes, else verdict = INSUFFICIENT DATA.
3. **Conflicting sources are flagged, not averaged** (see the Allentown 72.2/129 vs
   72.4/132 case in index.html).
4. **One-way brake in play view:** a HOLD does not upgrade to COMMIT within the same
   hole session.
5. **Attribution:** OSM data is ODbL — attribute on every page that renders it.
   USGS 3DEP is public domain. Respect Overpass + EPQS rate limits.
6. USGA Rule 4.3 note: slope-adjusted advice may be restricted in competition;
   keep the calibration ledger (self-judgment) available in all modes.

## Task list for Claude Code

1. **Run first ingest:** `node ingest/ingest.js --name "Allentown Municipal" --slug allentown --bbox "40.57,-75.55,40.62,-75.48"`
   (verify bbox against the course at 3400 Tilghman St, Allentown PA before running).
   If coverage:none, the course needs OSM mapping first — do not fake it.
2. **Wire real data:** load `data/courses/<slug>.json` in both views; flip
   `holesDemo:false` only for courses with coverage ≥ partial; activate the Terrain
   axis from real `elev_delta_ft` distribution.
3. **NOAA feed:** replace play.html firmness sliders with NOAA/NWS station precip
   (api.weather.gov, free) fetched at build or on load; keep sliders as manual override.
4. **Persistence:** in the deployed build, persist the calibration ledger on-device
   (localStorage is fine outside claude.ai preview) + JSON export for SUPERCASTER.
5. **Course registry:** script to seed the course list from OpenGolfAPI (ODbL);
   one static page per course generated at build (same v17 flat-file pattern as
   AnthonyCharts).
6. **Deploy:** static Vercel project; per-course routes `/c/<slug>`, play view at
   `/c/<slug>/play`.

## Deploy now (prototype as-is)

```
vercel deploy   # from this folder; it's all static
```

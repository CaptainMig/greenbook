# Attribution — GreenBook open data tree

Everything under `data/open/` is a collective database licensed under the
**Open Database License (ODbL) 1.0** — see [LICENSE](./LICENSE). Share-alike
applies to this tree. The Starpoint scoring layer (`data/starpoint/`) is a
separate, proprietary work that joins this tree only at render time, by slug,
and is not part of this collective database.

## Sources

- **OpenGolfAPI** — course registry: identity, location, pars, stroke index,
  yardages, per-tee ratings where crawled. © OpenGolfAPI contributors, ODbL.
  https://opengolfapi.org · bulk release cited in each registry file's
  `source_release`. Registry fields are cited as OPENGOLFAPI — not USGA —
  until independently verified per course.
- **OpenStreetMap** — hole centerlines, hazard polygons, course boundaries.
  © OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright
  (OpenGolfAPI itself contains information from OpenStreetMap.)
- **USGS 3DEP** — elevation samples along hole centerlines, via staged GeoTIFF
  tiles on the AWS Open Data program and the EPQS point API. Public domain
  (U.S. Government work). https://www.usgs.gov/3d-elevation-program
- **NOAA / National Weather Service** — precipitation observations fetched
  client-side from api.weather.gov at page load (not stored in this tree).
  Public domain. https://www.weather.gov

## What is NOT here

Computed axis scores, verdict states, heuristic parameters, and scoring
configuration are never written into this tree. They live in
`data/starpoint/` (all rights reserved, Starpoint LLC).

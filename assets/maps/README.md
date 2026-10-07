# Travel map

Edit `../../places-data.js` to add a country, city, island, or region. Each place
has a stable `id` for selection. Coordinates use `[longitude, latitude]`.
Country `mapId` values use ISO 3166-1 numeric codes. `familiar: true` adds the larger ring
marker for places that were more than a visit; no dates or durations are shown.
`context` can distinguish names such as Taizhou (Zhejiang) or Madison (Wisconsin).
State, region, island, and desert pins represent those areas, not a particular city,
and get a wider camera than a city.

The page is a MapLibre GL JS globe that turns into a street-level 3D map.
Selecting a city flies down to about zoom 15 with the camera tilted, so terrain
and extruded buildings are visible; countries and regions frame themselves from
just above. `places.html#place=<id>` opens with a place selected. Drag to move,
right-drag or two-finger drag to tilt and turn, scroll or pinch to zoom. Keyboard
controls are arrow keys, plus/minus, and Home to reset; Escape closes the index.
The style lives in `../../places.js`: one warm off-white ink on near-black paper.

MapLibre GL JS 5.24.0 is vendored in `../vendor` with its license (BSD-3-Clause).
The page fetches third-party tiles at runtime, with no API keys or accounts:

- Streets, buildings, water, boundaries, and labels: vector tiles and fonts from
  OpenFreeMap (https://openfreemap.org), in the OpenMapTiles schema
  (© OpenMapTiles, https://www.openmaptiles.org/), built from OpenStreetMap
  data (© OpenStreetMap contributors, ODbL, https://www.openstreetmap.org/copyright).
- Terrain and hillshading: Terrain Tiles on AWS Open Data, terrarium encoding
  (https://registry.opendata.aws/terrain-tiles/), originally from Mapzen. Their
  sources and attribution: https://github.com/tilezen/joerd/blob/master/docs/attribution.md

These attributions are linked in the page's bottom corner. Those hosts see the
visitor's IP address and the tiles they view.

`visited-countries-10m.json` contains the 19 visited countries/territories from
Natural Earth v5.1.2 `ne_10m_admin_0_countries.geojson`, with coordinates rounded
to four decimals and only names and numeric country IDs retained. It draws the
visited-country tint and outline, and frames a country when one is selected.
https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_10m_admin_0_countries.geojson
https://www.naturalearthdata.com/about/terms-of-use/

`countries-50m.json`, `relief-details.json`, `shaded-relief.jpg`, and the
vendored D3 and topojson-client belonged to the earlier hand-built globe and are
no longer loaded by the page.

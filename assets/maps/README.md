# Travel map

Edit `../../places-data.js` to add a country, city, island, or region. Each place
has a stable `id` for selection. Coordinates use `[longitude, latitude]`.
Country `mapId` values use ISO 3166-1 numeric codes. `familiar: true` adds the larger ring
marker for places that were more than a visit; no dates or durations are shown.
`context` can distinguish names such as Taizhou (Zhejiang) or Madison (Wisconsin).
State, region, and island pins represent those areas, not a particular city.

`countries-50m.json` is vendored from world-atlas 2.0.2:
https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json

The geography comes from Natural Earth's public-domain 1:50m country boundaries:
https://github.com/topojson/world-atlas
https://www.naturalearthdata.com/about/terms-of-use/

The full-viewport globe renders simplified geographic context rather than
street-level detail. Drag to rotate, scroll or pinch to zoom, or select a region
to fly there. The list button opens the country and city index. Keyboard controls
are arrow keys, plus/minus, and Home to reset; Escape closes the place index.
The globe opens in a monochrome ink style: hairline outlines, rivers, and
graticule, with visited countries hatched. The pen button (or `?style=relief`)
switches to shaded relief, where familiar places have a pale-blue ring and
visited countries have a blue fill.
D3 7.9.0 and topojson-client 3.1.0 are vendored in `../vendor` with their licenses.
There are no map API keys, tracking requests, or runtime CDN dependencies.

The globe also uses `relief-details.json`, containing Natural Earth v5.1.2
1:50m lakes, rivers/lake centerlines, and state/province boundary lines:
https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson
Source files: `ne_50m_lakes.geojson`, `ne_50m_rivers_lake_centerlines.geojson`,
and `ne_50m_admin_1_states_provinces_lines.geojson`. These public-domain layers
retain geometry (rounded to five decimals), names, and scale ranks. Province
coverage follows the source dataset; not every country has internal boundaries.
Closer views draw province boundaries as a vector overlay. Country outlines and
place markers remain on the globe's surface, without exaggerated heights.

`visited-countries-10m.json` contains the 19 visited countries/territories from
Natural Earth v5.1.2 `ne_10m_admin_0_countries.geojson`, with coordinates rounded
to four decimals and only names and numeric country IDs retained. These finer
coastlines replace the 50m outlines around visited places on the globe.
https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_10m_admin_0_countries.geojson

`shaded-relief.jpg` is a JPEG conversion (quality 82, original 10800×5400 size)
of Natural Earth's public-domain `SR_50M.tif`, version 3.2.0, from:
https://naciscdn.org/naturalearth/50m/raster/SR_50M.zip
https://www.naturalearthdata.com/downloads/50m-raster-data/50m-shaded-relief/
The geographic hillshading is a texture of the terrain. The globe still opens if
this optional image cannot load.

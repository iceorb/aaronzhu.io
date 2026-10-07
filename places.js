/* A globe that becomes a street-level 3D map: vector tiles, terrain, and extruded buildings in ink. */
(async () => {
  const loading = document.querySelector('#loading');
  const regionSelect = document.querySelector('#region-select');
  const browse = document.querySelector('#browse');
  const placeIndex = document.querySelector('#index');
  const caption = document.querySelector('#selection');
  const regions = window.travelPlaces;
  const countries = regions.flatMap(region => region.places.map(country => ({ ...country, region })));
  const points = countries.flatMap(country => country.places?.length
    ? country.places.map(place => ({ ...place, country, region: country.region }))
    : [{ ...country, coordinates: country.center, country, region: country.region }]);
  const visited = new Set(countries.map(country => +country.mapId));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let currentRegion = null, selected = null, outlines = [];

  const ink = '#e6dfcf', paper = '#121212';
  const alpha = (value) => ink + Math.round(value * 255).toString(16).padStart(2, '0');
  const byZoom = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
  const roads = (classes, opacity, widths) => ({
    type: 'line', source: 'streets', 'source-layer': 'transportation',
    filter: ['in', ['get', 'class'], ['literal', classes]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': alpha(opacity), 'line-width': byZoom(...widths) }
  });
  const label = (size, opacity, extra = {}) => ({
    type: 'symbol', source: 'streets',
    layout: { 'text-font': ['Noto Sans Regular'], 'text-size': size, 'text-transform': 'uppercase',
      'text-letter-spacing': .12, 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], ...extra },
    paint: { 'text-color': alpha(opacity), 'text-halo-color': paper, 'text-halo-width': 1.2 }
  });

  // Visited countries reuse the finer Natural Earth outlines that ship with the site.
  const visitedOutlines = await fetch('assets/maps/visited-countries-10m.json').then(response => response.json());
  for (const feature of visitedOutlines.features) feature.properties.mapId = +feature.id;
  outlines = visitedOutlines.features;
  const placeData = {
    type: 'FeatureCollection',
    features: points.map(place => ({ type: 'Feature', geometry: { type: 'Point', coordinates: place.coordinates },
      properties: { id: place.id, name: place.name, familiar: !!place.familiar } }))
  };

  const style = {
    version: 8,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      streets: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      elevation: { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 15,
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'] },
      relief: { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 15,
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'] },
      visited: { type: 'geojson', data: visitedOutlines },
      places: { type: 'geojson', data: placeData }
    },
    terrain: { source: 'elevation', exaggeration: 1.3 },
    sky: { 'sky-color': paper, 'horizon-color': '#26241f', 'fog-color': paper, 'sky-horizon-blend': .7,
      'horizon-fog-blend': .6, 'fog-ground-blend': .7, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, .7, 5, .35, 9, 0] },
    light: { anchor: 'viewport', color: '#fff6e4', intensity: .45, position: [1.2, 200, 25] },
    layers: [
      { id: 'paper', type: 'background', paint: { 'background-color': '#161615' } },
      { id: 'woods', type: 'fill', source: 'streets', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest', 'grass']]], paint: { 'fill-color': alpha(.025) } },
      { id: 'parks', type: 'fill', source: 'streets', 'source-layer': 'park', paint: { 'fill-color': alpha(.035) } },
      { id: 'hills', type: 'hillshade', source: 'relief', paint: { 'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 3, .35, 12, .7],
        'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': alpha(.2), 'hillshade-accent-color': '#0b0b0a' } },
      { id: 'water', type: 'fill', source: 'streets', 'source-layer': 'water', paint: { 'fill-color': '#0c0d0e' } },
      { id: 'shore', type: 'line', source: 'streets', 'source-layer': 'water', minzoom: 4,
        paint: { 'line-color': alpha(.3), 'line-width': byZoom(4, .3, 16, 1) } },
      { id: 'rivers', type: 'line', source: 'streets', 'source-layer': 'waterway',
        paint: { 'line-color': alpha(.22), 'line-width': byZoom(8, .3, 16, 1.4) } },
      { id: 'visited-fill', type: 'fill', source: 'visited', maxzoom: 9,
        paint: { 'fill-color': ink, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, .1, 6, .05, 9, 0] } },
      { id: 'borders', type: 'line', source: 'streets', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': alpha(.45), 'line-width': byZoom(1, .4, 10, 1.2) } },
      { id: 'provinces', type: 'line', source: 'streets', 'source-layer': 'boundary', minzoom: 4,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': alpha(.18), 'line-width': .5, 'line-dasharray': [2, 3] } },
      { id: 'visited-line', type: 'line', source: 'visited', maxzoom: 10,
        paint: { 'line-color': alpha(.8), 'line-width': byZoom(1, .7, 8, 1.4) } },
      { id: 'selected-country', type: 'line', source: 'visited', filter: ['==', ['get', 'mapId'], -1],
        paint: { 'line-color': ink, 'line-width': 1.8 } },
      { ...roads(['path', 'track'], .14, [14, .3, 18, 1]), id: 'paths', minzoom: 14,
        paint: { 'line-color': alpha(.14), 'line-width': byZoom(14, .3, 18, 1), 'line-dasharray': [1, 2] } },
      { ...roads(['minor', 'service'], .22, [12, .2, 18, 5]), id: 'streets', minzoom: 12 },
      { ...roads(['secondary', 'tertiary'], .28, [9, .3, 18, 7]), id: 'avenues', minzoom: 8 },
      { ...roads(['primary', 'trunk'], .36, [6, .3, 18, 8]), id: 'arterials', minzoom: 6 },
      { ...roads(['motorway'], .42, [5, .4, 18, 9]), id: 'motorways', minzoom: 5 },
      { ...roads(['rail', 'transit'], .25, [10, .3, 18, 1.5]), id: 'rail', minzoom: 10,
        paint: { 'line-color': alpha(.25), 'line-width': byZoom(10, .3, 18, 1.5), 'line-dasharray': [3, 3] } },
      { id: 'buildings', type: 'fill-extrusion', source: 'streets', 'source-layer': 'building', minzoom: 13.5,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'render_height'], 0, '#23221f', 40, '#312e29', 150, '#423e37', 400, '#5a544a'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, ['get', 'render_height']],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': .9, 'fill-extrusion-vertical-gradient': true
        } },
      { ...label(byZoom(14, 9, 18, 11), .55, { 'symbol-placement': 'line', 'text-letter-spacing': .08 }),
        id: 'street-names', 'source-layer': 'transportation_name', minzoom: 15 },
      { ...label(11, .45, { 'text-font': ['Noto Sans Italic'], 'text-transform': 'none' }),
        id: 'water-names', 'source-layer': 'water_name' },
      { ...label(byZoom(4, 10, 12, 13), .7), id: 'towns', 'source-layer': 'place', minzoom: 4,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]] },
      { ...label(byZoom(12, 9, 16, 11), .5), id: 'neighbourhoods', 'source-layer': 'place', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood']]] },
      { ...label(10, .5, { 'text-letter-spacing': .25 }), id: 'countries', 'source-layer': 'place', minzoom: 2, maxzoom: 6,
        filter: ['==', ['get', 'class'], 'country'] },
      // Places: ink rings, larger and brighter for the ones that were more than a visit.
      { id: 'place-ring', type: 'circle', source: 'places',
        paint: { 'circle-radius': ['case', ['get', 'familiar'], 7, 4], 'circle-color': 'transparent',
          'circle-stroke-color': ['case', ['get', 'familiar'], alpha(.85), alpha(.6)], 'circle-stroke-width': .9 } },
      { id: 'place-dot', type: 'circle', source: 'places',
        paint: { 'circle-radius': ['case', ['get', 'familiar'], 2.6, 1.6], 'circle-color': ink } },
      { id: 'place-selected', type: 'circle', source: 'places', filter: ['==', ['get', 'id'], ''],
        paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': '#f6f1e6', 'circle-stroke-width': 1.2 } },
      { id: 'place-names', type: 'symbol', source: 'places',
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': .1,
          'text-font': ['case', ['get', 'familiar'], ['literal', ['Noto Sans Italic']], ['literal', ['Noto Sans Regular']]],
          'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 1.1, 'text-optional': true },
        paint: { 'text-color': ['case', ['get', 'familiar'], '#f1ebdd', '#d8d1c1'], 'text-halo-color': paper, 'text-halo-width': 1.5 } }
    ]
  };

  const home = () => {
    const size = Math.min(innerWidth, innerHeight);
    return { center: [-25, 24], zoom: Math.log2(.36 * size * 2 * Math.PI / 512), pitch: 0, bearing: 0 };
  };
  const map = new maplibregl.Map({
    container: 'map', style, ...home(), attributionControl: false, maxPitch: 75,
    canvasContextAttributes: { antialias: true }
  });
  map.getCanvas().setAttribute('aria-label', 'Travel map. Drag to move, right-drag or two-finger drag to tilt, scroll or pinch to zoom. Arrow keys move, plus and minus zoom, Home resets.');
  map.on('error', event => console.warn(event.error?.message || event));

  const button = (name, action) => {
    const node = document.createElement('button');
    node.textContent = name;
    node.addEventListener('click', action);
    return node;
  };
  const move = (camera) => reducedMotion.matches ? map.jumpTo(camera) : map.flyTo({ ...camera, duration: 2600, essential: true });
  const padding = () => innerWidth < 620
    ? { top: 200, bottom: 200, left: 30, right: 30 }
    : { top: 200, bottom: 120, left: 80, right: 80 };
  function boundsOf(target) {
    if (target.bounds) return target.bounds;
    const outline = outlines.find(feature => feature.properties.mapId === +target.mapId);
    if (!outline) return null;
    const box = [[180, 90], [-180, -90]];
    JSON.stringify(outline.geometry.coordinates).replace(/\[(-?[\d.]+),(-?[\d.]+)\]/g, (_, x, y) => {
      box[0][0] = Math.min(box[0][0], +x); box[0][1] = Math.min(box[0][1], +y);
      box[1][0] = Math.max(box[1][0], +x); box[1][1] = Math.max(box[1][1], +y);
    });
    return box[1][0] - box[0][0] > 90 ? null : box;
  }

  // Cities fly down into the streets; countries and regions frame themselves from just above.
  function focus(target) {
    if (!target) return move(home());
    const city = target.coordinates && (!target.mapId || target.tiny);
    if (city) {
      const close = { state: 7, region: 8, island: 10, desert: 12.4 }[target.kind];
      return move({ center: target.coordinates, zoom: close || 15.3, pitch: close ? (target.kind === 'desert' ? 68 : 40) : 62, bearing: close ? 0 : -24 });
    }
    const bounds = boundsOf(target);
    if (!bounds) return move({ center: target.center, zoom: 3.4, pitch: 0, bearing: 0 });
    const camera = map.cameraForBounds(bounds, { padding: padding(), maxZoom: 8 });
    move({ ...camera, pitch: 25, bearing: 0 });
  }

  function updateIndex() {
    placeIndex.replaceChildren();
    for (const country of currentRegion ? countries.filter(c => c.region.id === currentRegion.id) : countries) {
      const group = document.createElement('div');
      const item = button(country.name, () => choose(country));
      item.setAttribute('aria-pressed', String((selected?.country?.id || selected?.id) === country.id));
      group.append(item);
      if (selected?.id === country.id || selected?.country?.id === country.id) {
        const cities = document.createElement('div');
        cities.className = 'cities';
        for (const place of points.filter(point => point.country.id === country.id && point.id !== country.id)) {
          const city = button(place.name, () => choose(place));
          city.setAttribute('aria-pressed', String(selected?.id === place.id));
          if (place.context) {
            const note = document.createElement('small');
            note.textContent = place.context;
            city.append(note);
          }
          cities.append(city);
        }
        group.append(cities);
      }
      placeIndex.append(group);
    }
  }
  function setBrowseOpen(open) {
    placeIndex.hidden = !open;
    browse.setAttribute('aria-expanded', String(open));
  }
  function highlight() {
    const mapId = +(selected?.mapId || selected?.country?.mapId || -1);
    map.setFilter('selected-country', ['==', ['get', 'mapId'], mapId]);
    map.setFilter('place-selected', ['==', ['get', 'id'], selected && !selected.places?.length ? selected.id : '']);
  }

  function choose(place) {
    selected = place;
    currentRegion = place.region;
    regionSelect.value = currentRegion.id;
    updateIndex();
    caption.textContent = [place.name, place.context || place.country?.name]
      .filter((value, index, values) => value && values.indexOf(value) === index).join(', ');
    if (!place.places?.length && !placeIndex.hidden) {
      setBrowseOpen(false);
      browse.focus({ preventScroll: true });
    }
    history.replaceState(null, '', '#place=' + place.id);
    highlight();
    focus(place);
  }
  function reset() {
    selected = currentRegion = null;
    regionSelect.value = '';
    caption.textContent = '';
    history.replaceState(null, '', location.pathname + location.search);
    updateIndex();
    highlight();
    focus(null);
  }

  for (const region of [null, ...regions]) {
    const option = document.createElement('option');
    option.value = region?.id || '';
    option.textContent = region?.name || 'World';
    regionSelect.append(option);
  }
  regionSelect.addEventListener('change', () => {
    currentRegion = regions.find(region => region.id === regionSelect.value) || null;
    selected = null;
    caption.textContent = '';
    updateIndex();
    setBrowseOpen(false);
    highlight();
    focus(currentRegion);
  });
  browse.addEventListener('click', () => setBrowseOpen(placeIndex.hidden));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !placeIndex.hidden) {
      setBrowseOpen(false);
      browse.focus({ preventScroll: true });
    }
    if (event.key === 'Home' && event.target === map.getCanvas()) { event.preventDefault(); reset(); }
  });
  document.addEventListener('pointerdown', event => {
    if (!placeIndex.hidden && !placeIndex.contains(event.target) && !browse.contains(event.target)) setBrowseOpen(false);
  });
  document.querySelector('#zoom-in').onclick = () => map.zoomIn();
  document.querySelector('#zoom-out').onclick = () => map.zoomOut();
  document.querySelector('#reset').onclick = reset;

  map.on('load', () => {
    loading.hidden = true;
    updateIndex();
    const linked = points.concat(countries).find(place => '#place=' + place.id === location.hash);
    if (linked) choose(linked);
  });
  map.on('click', event => {
    const [hit] = map.queryRenderedFeatures([[event.point.x - 10, event.point.y - 10], [event.point.x + 10, event.point.y + 10]],
      { layers: ['place-ring', 'place-names'] });
    if (hit) return choose(points.find(place => place.id === hit.properties.id));
    if (map.getZoom() > 9) return;
    const [country] = map.queryRenderedFeatures(event.point, { layers: ['visited-fill'] });
    if (country) choose(countries.find(c => +c.mapId === country.properties.mapId));
  });
  for (const layer of ['place-ring', 'place-names', 'visited-fill']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
})();

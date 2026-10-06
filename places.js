/* A north-up globe: geographic positions stay on the surface, with no extrusion. */
(async () => {
  const canvas = document.querySelector('#map');
  const overlay = document.querySelector('#map-details');
  const context = overlay.getContext('2d');
  const loading = document.querySelector('#loading');
  const stage = document.querySelector('.map-stage');
  const regionSelect = document.querySelector('#region-select');
  const browse = document.querySelector('#browse');
  const placeIndex = document.querySelector('#index');
  const regions = window.travelPlaces;
  const countries = regions.flatMap(region => region.places.map(country => ({ ...country, region })));
  const points = countries.flatMap(country => country.places?.length
    ? country.places.map(place => ({ ...place, country, region: country.region }))
    : [{ ...country, coordinates: country.center, country, region: country.region }]);
  const visited = new Set(countries.map(country => +country.mapId));
  const radians = Math.PI / 180;
  const camera = { longitude: -25, latitude: 24, zoom: 1 };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
  let currentRegion = null, selected = null, terrain = true, ready = false;
  let width = 1, height = 1, ratio = 1, radius = 1, center = [0, 0];
  let animation = 0, frame = 0, features = [], details, blocked = [];
  let renderGlobe = () => {};
  const labelNodes = new Map();
  const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const button = (name, action, className = '') => {
    const node = document.createElement('button');
    node.textContent = name;
    node.className = className;
    node.addEventListener('click', action);
    return node;
  };
  const finishEntrance = () => stage.classList.remove('is-entering');
  canvas.addEventListener('animationend', finishEntrance);
  // Stop the visual entrance as soon as someone starts exploring.
  document.querySelector('.atlas').addEventListener('pointerdown', finishEntrance, { capture: true });
  canvas.addEventListener('wheel', finishEntrance, { passive: true });
  canvas.addEventListener('keydown', finishEntrance);

  function setBrowseOpen(open) {
    placeIndex.hidden = !open;
    browse.setAttribute('aria-expanded', String(open));
    measureOverlays();
    scheduleDraw();
  }

  function updateIndex() {
    const host = document.querySelector('#index');
    host.replaceChildren();
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
      host.append(group);
    }
    measureOverlays();
  }

  function updateRegions() {
    regionSelect.value = currentRegion?.id || '';
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
    document.querySelector('#selection').textContent = '';
    updateIndex();
    setBrowseOpen(false);
    focus(currentRegion);
  });
  browse.addEventListener('click', () => setBrowseOpen(placeIndex.hidden));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !placeIndex.hidden) {
      setBrowseOpen(false);
      browse.focus({ preventScroll: true });
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!placeIndex.hidden && !placeIndex.contains(event.target) && !browse.contains(event.target)) setBrowseOpen(false);
  });

  function choose(place) {
    selected = place;
    currentRegion = place.region;
    updateRegions();
    updateIndex();
    document.querySelector('#selection').textContent = [place.name, place.context || place.country?.name]
      .filter((value, index, values) => value && values.indexOf(value) === index).join(', ');
    if (!place.places?.length && !placeIndex.hidden) {
      setBrowseOpen(false);
      browse.focus({ preventScroll: true });
    }
    measureOverlays();
    focus(place);
  }

  function focus(target) {
    let longitude = -25, latitude = 24, zoom = 1;
    if (target) {
      [longitude, latitude] = target.coordinates || target.center || [
        (target.bounds[0][0] + target.bounds[1][0]) / 2,
        (target.bounds[0][1] + target.bounds[1][1]) / 2
      ];
      const bounds = target.bounds || (target.mapId && d3.geoBounds(features.find(f => +f.id === +target.mapId) || { type: 'Sphere' }));
      if (target.coordinates) zoom = target.kind === 'state' || target.kind === 'region' ? 5 : 8;
      else if (bounds) {
        const lonSpan = (bounds[1][0] - bounds[0][0] + 360) % 360 || 360;
        const span = Math.max(lonSpan * Math.cos(latitude * radians), bounds[1][1] - bounds[0][1]);
        zoom = clamp(75 / Math.max(10, span), 1.15, 6);
      } else zoom = 4;
    }
    cancelAnimationFrame(animation);
    const start = { ...camera };
    const longitudeDelta = wrap(longitude - start.longitude);
    const begin = performance.now();
    const tick = now => {
      const t = reducedMotion.matches ? 1 : Math.min(1, (now - begin) / 950);
      const ease = t * t * (3 - 2 * t);
      camera.longitude = wrap(start.longitude + longitudeDelta * ease);
      camera.latitude = start.latitude + (latitude - start.latitude) * ease;
      // Pull back slightly during long flights, then settle into the destination.
      camera.zoom = start.zoom + (zoom - start.zoom) * ease - Math.sin(t * Math.PI) * Math.min(start.zoom, zoom) * .18;
      draw();
      if (t < 1) animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  }

  function project([longitude, latitude]) {
    const lon = (longitude - camera.longitude) * radians, lat = latitude * radians;
    const tilt = camera.latitude * radians;
    const x = Math.cos(lat) * Math.sin(lon);
    const y = Math.sin(lat) * Math.cos(tilt) - Math.cos(lat) * Math.cos(lon) * Math.sin(tilt);
    const z = Math.sin(lat) * Math.sin(tilt) + Math.cos(lat) * Math.cos(lon) * Math.cos(tilt);
    const scale = radius * camera.zoom;
    return [center[0] + x * scale, center[1] - y * scale, z];
  }

  function invert(x, y) {
    const scale = radius * camera.zoom;
    const px = (x - center[0]) / scale, py = (center[1] - y) / scale;
    if (px * px + py * py > 1) return null;
    const z = Math.sqrt(Math.max(0, 1 - px * px - py * py));
    const lat = camera.latitude * radians;
    const worldY = py * Math.cos(lat) + z * Math.sin(lat);
    const worldZ = z * Math.cos(lat) - py * Math.sin(lat);
    return [wrap(Math.atan2(px, worldZ) / radians + camera.longitude), Math.asin(clamp(worldY, -1, 1)) / radians];
  }

  function measureOverlays() {
    blocked = [...document.querySelectorAll('.explorer-controls, #index, .header-line, .nav-links, .map-controls, #selection, .map-meta')]
      .map(node => node.getBoundingClientRect()).filter(rect => rect.width && rect.height)
      .map(rect => [rect.left - 10, rect.top - 8, rect.right + 10, rect.bottom + 8]);
  }

  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width; height = rect.height;
    ratio = Math.min(devicePixelRatio || 1, 2);
    for (const surface of [canvas, overlay]) {
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
    }
    const mobile = width <= 620;
    center = [width * .5, height * .53];
    radius = mobile ? Math.min(width * .46, Math.max(60, (height - 340) / 2)) : Math.min(width * .4, height * .37);
    measureOverlays();
    scheduleDraw();
  }

  function draw() {
    if (!ready) return;
    renderGlobe();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const projection = d3.geoOrthographic().rotate([-camera.longitude, -camera.latitude])
      .translate(center).scale(radius * camera.zoom).clipAngle(90).precision(.4);
    const path = d3.geoPath(projection, context);
    // Vector boundaries remain crisp when looking closer at a country.
    if (camera.zoom > 2) {
      context.beginPath(); path(details.provinces);
      context.strokeStyle = '#c7d8f230'; context.lineWidth = .65; context.stroke();
    }
    const selectedFeature = selected && features.find(feature => +feature.id === +(selected.mapId || selected.country?.mapId));
    if (selectedFeature) {
      context.beginPath(); path(selectedFeature);
      context.fillStyle = '#b7ddff26'; context.fill();
      context.strokeStyle = '#dcefffef'; context.lineWidth = 1; context.stroke();
    }
    const projected = points.map(place => ({ place, position: project(place.coordinates) }))
      .filter(({ position: [x, y, z] }) => z > .06 && x > 8 && x < width - 8 && y > 8 && y < height - 8);
    for (const { place, position: [x, y] } of projected) {
      const active = selected?.id === place.id;
      context.beginPath(); context.arc(x, y, active ? 11 : place.familiar ? 7 : 3, 0, Math.PI * 2);
      context.strokeStyle = active ? '#ffffff' : place.familiar ? '#a8d9ffbb' : '#a9bdd8';
      context.lineWidth = 1; context.stroke();
      context.beginPath(); context.arc(x, y, active ? 3.5 : place.familiar ? 3 : 2, 0, Math.PI * 2);
      context.fillStyle = place.familiar || active ? '#e4f3ff' : '#cbd9ee'; context.fill();
    }
    const occupied = [...blocked, ...projected.map(({ position: [x, y] }) => [x - 8, y - 8, x + 8, y + 8])];
    for (const node of labelNodes.values()) node.hidden = true;
    projected.sort((a, b) => Number(b.place.id === selected?.id) - Number(a.place.id === selected?.id)
      || Number(!!b.place.familiar) - Number(!!a.place.familiar));
    for (const { place, position: [x, y, z] } of projected) {
      if (z < .2 || (currentRegion && place.region.id !== currentRegion.id)) continue;
      if (camera.zoom < 1.5 && place.id !== selected?.id) continue;
      const node = labelNodes.get(place);
      const boxWidth = place.name.length * (width <= 620 ? 7 : 7.5) + 18, boxHeight = width <= 620 ? 44 : 30;
      const offset = [[12, -boxHeight / 2], [-boxWidth - 12, -boxHeight / 2], [12, -boxHeight - 10], [12, 12]].find(([dx, dy]) => {
        const left = x + dx, top = y + dy;
        return left > 10 && left + boxWidth < width - 10 && top > 10 && top + boxHeight < height - 10
          && !occupied.some(box => left < box[2] && left + boxWidth > box[0] && top < box[3] && top + boxHeight > box[1]);
      });
      if (!offset) continue;
      const left = x + offset[0], top = y + offset[1];
      node.hidden = false;
      node.style.transform = `translate(${left}px,${top}px)`;
      node.classList.toggle('selected', selected?.id === place.id);
      occupied.push([left - 4, top - 3, left + boxWidth + 4, top + boxHeight + 3]);
    }
  }

  updateRegions();
  updateIndex();
  new ResizeObserver(resize).observe(canvas);
  document.fonts.ready.then(() => { measureOverlays(); scheduleDraw(); });
  if (!gl || !context) {
    loading.textContent = 'Globe unavailable. Browse places above.';
    document.querySelector('.map-controls').hidden = true;
    return;
  }

  try {
    const [topology, geographicDetails, fine] = await Promise.all(['countries-50m.json', 'relief-details.json', 'visited-countries-10m.json'].map(async name => {
      const response = await fetch('assets/maps/' + name);
      if (!response.ok) throw new Error('Map data unavailable');
      return response.json();
    }));
    details = geographicDetails;
    for (const feature of [...details.lakes.features, ...fine.features]) {
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      for (const polygon of polygons) {
        if (d3.geoArea({ type: 'Polygon', coordinates: polygon }) > 2 * Math.PI) {
          for (const ring of polygon) ring.reverse();
        }
      }
    }
    features = topojson.feature(topology, topology.objects.countries).features.filter(feature => !visited.has(+feature.id)).concat(fine.features);
    const terrainImage = new Image();
    terrainImage.src = 'assets/maps/shaded-relief.jpg';
    try { await terrainImage.decode(); } catch { terrain = false; }

    function texture(withTerrain) {
      const surface = document.createElement('canvas');
      surface.width = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      surface.height = surface.width / 2;
      const ctx = surface.getContext('2d');
      const projection = d3.geoEquirectangular().scale(surface.width / (2 * Math.PI)).translate([surface.width / 2, surface.height / 2]);
      const path = d3.geoPath(projection, ctx);
      ctx.fillStyle = '#101a2c'; ctx.fillRect(0, 0, surface.width, surface.height);
      ctx.beginPath(); path(d3.geoGraticule().step([15, 15])());
      ctx.strokeStyle = '#7396ce24'; ctx.lineWidth = .8; ctx.stroke();
      for (const feature of features) {
        const familiar = visited.has(+feature.id);
        ctx.beginPath(); path(feature);
        ctx.fillStyle = familiar ? '#678fe0' : '#39465e'; ctx.fill();
      }
      if (withTerrain) {
        ctx.save(); ctx.beginPath(); path({ type: 'FeatureCollection', features }); ctx.clip();
        ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = .22;
        ctx.drawImage(terrainImage, 0, 0, surface.width, surface.height); ctx.restore();
      }
      for (const feature of features) {
        ctx.beginPath(); path(feature);
        ctx.strokeStyle = visited.has(+feature.id) ? '#bed9ffa6' : '#a8bfdf52';
        ctx.lineWidth = visited.has(+feature.id) ? 1.1 : .6; ctx.stroke();
      }
      ctx.beginPath(); path(details.lakes); ctx.fillStyle = '#101a2c'; ctx.fill();
      const value = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, value);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, surface);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      return value;
    }
    const globeTexture = texture(terrain);
    function shader(type, source) {
      const result = gl.createShader(type);
      gl.shaderSource(result, source); gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
      return result;
    }
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
    `));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
      precision highp float;
      uniform vec2 u_size, u_center, u_rotation;
      uniform float u_radius, u_ratio;
      uniform sampler2D u_texture;
      const float PI = 3.14159265359;
      void main() {
        vec2 pixel = gl_FragCoord.xy / u_ratio;
        vec2 p = (pixel - vec2(u_center.x, u_size.y - u_center.y)) / u_radius;
        float distance = length(p);
        if (distance > 1.0) {
          float halo = exp(-(distance - 1.0) * 55.0) * 0.22;
          gl_FragColor = vec4(0.28, 0.49, 0.95, halo);
          return;
        }
        float z = sqrt(max(0.0, 1.0 - dot(p, p)));
        float s = sin(u_rotation.y), c = cos(u_rotation.y);
        float latitude = asin(clamp(p.y * c + z * s, -1.0, 1.0));
        float longitude = atan(p.x, z * c - p.y * s) + u_rotation.x;
        vec2 uv = vec2(fract(longitude / (2.0 * PI) + 0.5), 0.5 - latitude / PI);
        vec3 color = texture2D(u_texture, uv).rgb;
        vec3 normal = vec3(p, z);
        float light = 0.70 + 0.30 * max(dot(normal, normalize(vec3(-0.45, 0.6, 1.2))), 0.0);
        color *= light;
        float rim = pow(1.0 - z, 4.0);
        color = mix(color, vec3(0.30, 0.48, 0.78), rim * 0.36);
        float edge = 1.0 - smoothstep(1.0 - 1.5 / u_radius, 1.0, distance);
        gl_FragColor = vec4(color, edge);
      }
    `));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = Object.fromEntries(['size', 'center', 'rotation', 'radius', 'ratio', 'texture'].map(name => [name, gl.getUniformLocation(program, 'u_' + name)]));
    renderGlobe = () => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.size, width, height); gl.uniform2fv(uniforms.center, center);
      gl.uniform2f(uniforms.rotation, camera.longitude * radians, camera.latitude * radians);
      gl.uniform1f(uniforms.radius, radius * camera.zoom); gl.uniform1f(uniforms.ratio, ratio);
      gl.uniform1i(uniforms.texture, 0); gl.bindTexture(gl.TEXTURE_2D, globeTexture);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    for (const place of points) {
      const label = button(place.name, () => choose(place), 'map-label' + (place.familiar ? ' familiar' : ''));
      label.setAttribute('aria-label', place.name + (place.familiar ? ', more than a visit' : ''));
      label.hidden = true;
      document.querySelector('#labels').append(label);
      labelNodes.set(place, label);
    }
    ready = true;
    loading.hidden = true;
    resize();
    draw();
    if (!reducedMotion.matches && !selected && !currentRegion) stage.classList.add('is-entering');
  } catch (error) {
    console.error(error);
    loading.textContent = 'Globe unavailable. Browse places above.';
    document.querySelector('.map-controls').hidden = true;
  }

  const local = event => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  function pick(x, y, hitRadius = 16) {
    const nearest = points.map(place => ({ place, screen: project(place.coordinates) }))
      .filter(({ screen }) => screen[2] > .06)
      .map(item => ({ ...item, distance: Math.hypot(x - item.screen[0], y - item.screen[1]) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest?.distance < hitRadius) { choose(nearest.place); return; }
    const coordinate = invert(x, y);
    if (!coordinate) return;
    const feature = features.find(item => visited.has(+item.id) && d3.geoContains(item, coordinate));
    if (feature) choose(countries.find(country => +country.mapId === +feature.id));
  }
  let drag = null, pinch = null;
  const pointers = new Map();
  canvas.addEventListener('pointerdown', event => {
    if (event.button > 0 || !ready) return;
    cancelAnimationFrame(animation);
    const [x, y] = local(event);
    pointers.set(event.pointerId, [x, y]); canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: camera.zoom };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { x, y, longitude: camera.longitude, latitude: camera.latitude, moved: false };
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const [x, y] = local(event);
    pointers.set(event.pointerId, [x, y]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      camera.zoom = clamp(pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1, pinch.distance), .75, 10);
    } else if (drag) {
      drag.moved ||= Math.hypot(x - drag.x, y - drag.y) > 4;
      const speed = 1 / (radians * radius * camera.zoom);
      camera.longitude = wrap(drag.longitude - (x - drag.x) * speed);
      camera.latitude = clamp(drag.latitude + (y - drag.y) * speed, -85, 85);
    }
    scheduleDraw();
  });
  function finishGesture(event, cancelled = false) {
    if (!pointers.has(event.pointerId)) return;
    const click = !cancelled && pointers.size === 1 && drag && !drag.moved && !pinch;
    pointers.delete(event.pointerId); drag = null; pinch = null;
    if (pointers.size === 1) {
      const [x, y] = [...pointers.values()][0];
      drag = { x, y, longitude: camera.longitude, latitude: camera.latitude, moved: true };
    } else if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: camera.zoom };
    }
    if (click) pick(...local(event), event.pointerType === 'touch' ? 24 : 16);
  }
  canvas.addEventListener('pointerup', event => finishGesture(event));
  for (const name of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(name, event => finishGesture(event, true));
  }
  function zoom(factor) {
    cancelAnimationFrame(animation);
    camera.zoom = clamp(camera.zoom * factor, .75, 10);
    scheduleDraw();
  }
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
    zoom(Math.exp(clamp(-delta * .0015, -.4, .4)));
  }, { passive: false });
  canvas.addEventListener('dblclick', event => {
    event.preventDefault();
    const coordinate = invert(...local(event));
    if (coordinate) {
      camera.longitude = coordinate[0]; camera.latitude = coordinate[1];
      zoom(1.6);
    }
  });
  function reset() {
    selected = null; currentRegion = null;
    updateRegions(); updateIndex();
    document.querySelector('#selection').textContent = '';
    setBrowseOpen(false);
    focus(null);
  }
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) return;
    event.preventDefault(); cancelAnimationFrame(animation);
    const step = 12 / camera.zoom;
    if (event.key === 'ArrowLeft') camera.longitude = wrap(camera.longitude - step);
    if (event.key === 'ArrowRight') camera.longitude = wrap(camera.longitude + step);
    if (event.key === 'ArrowUp') camera.latitude = clamp(camera.latitude + step, -85, 85);
    if (event.key === 'ArrowDown') camera.latitude = clamp(camera.latitude - step, -85, 85);
    if (event.key === '+' || event.key === '=') zoom(1.2);
    if (event.key === '-') zoom(1 / 1.2);
    if (event.key === 'Home') reset();
    scheduleDraw();
  });
  document.querySelector('#zoom-in').onclick = () => zoom(1.25);
  document.querySelector('#zoom-out').onclick = () => zoom(.8);
  document.querySelector('#reset').onclick = reset;
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); ready = false; cancelAnimationFrame(animation);
    loading.hidden = false; loading.textContent = 'Globe paused. Reload to resume.';
  });
})();

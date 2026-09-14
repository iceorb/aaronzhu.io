/* A flat geographic surface with real WebGL relief. Heights express familiarity,
   not duration, visit counts, or geographic elevation. */
(async () => {
  const canvas = document.querySelector('#map');
  const loading = document.querySelector('#loading');
  const regions = window.travelPlaces;
  const countries = regions.flatMap(region => region.places.map(country => ({...country, region})));
  const points = countries.flatMap(country => country.places?.length
    ? country.places.map(place => ({...place, country, region:country.region}))
    : [{...country, coordinates:country.center, country, region:country.region}]);
  const countryIds = new Set(countries.map(country => +country.mapId));
  const gl = canvas.getContext('webgl', {alpha:false, antialias:true});
  let currentRegion = null, selected = null, terrainVisible = true;
  const camera = {x:5, y:20, scale:1, angle:-.1, tilt:.85};
  let width=1, height=1, animation=0;
  const labelNodes = new Map();
  const leaderNodes = new Map();
  const meshes = [];
  const reliefHeight = 2.6;
  const mapLabels = [...points, ...countries.filter(country=>country.places?.length).map(country=>({...country,coordinates:country.center,height:reliefHeight,labelOnly:true}))];
  const button = (name, action, className='') => {
    const node=document.createElement('button'); node.textContent=name; node.className=className;
    node.addEventListener('click',action); return node;
  };
  function index() {
    const host=document.querySelector('#index'); host.replaceChildren();
    const list=currentRegion ? countries.filter(c=>c.region.id===currentRegion.id) : [];
    for(const country of list){
      const group=document.createElement('div');
      const countryButton=button(country.name,()=>choose(country));
      countryButton.setAttribute('aria-pressed',String(selected?.id===country.id));group.append(countryButton);
      if(selected?.id===country.id || selected?.country?.id===country.id){
        const cities=document.createElement('div');cities.className='cities';
        for(const place of points.filter(p=>p.country.id===country.id && p.id!==country.id)){
          const item=button(place.name+(place.familiar?' *':''),()=>choose(place),place.familiar?'familiar':'');
          item.setAttribute('aria-pressed',String(selected?.id===place.id));
          if(place.context){const note=document.createElement('small');note.textContent=place.context;item.append(note);}
          cities.append(item);
        }
        group.append(cities);
      }
      host.append(group);
    }
  }
  function regionNav(){
    const host=document.querySelector('#regions');host.replaceChildren();
    for(const region of [null,...regions]){
      const item=button(region?.name||'Everywhere',()=>{
        currentRegion=region;selected=null;regionNav();index();focus(region);
        document.querySelector('#selection').textContent=region?.name||'A few places, so far.';
      });item.setAttribute('aria-pressed',String(currentRegion===region));host.append(item);
    }
  }
  function choose(place){
    selected=place;currentRegion=place.region;regionNav();index();focus(place);
    document.querySelector('#selection').textContent=[place.name,place.context||place.country?.name].filter((v,i,a)=>v&&a.indexOf(v)===i).join(', ')+(place.familiar?' — more than a visit.':'');
  }
  let features=[], refreshDetail=()=>{};
  function focus(target, animate=true){
    let bounds=target?.bounds;
    if(target?.coordinates&&!target.labelOnly){const [x,y]=target.coordinates,r=target.kind==='state'?8:4;bounds=[[x-r,y-r*.7],[x+r,y+r*.7]];}
    if(!bounds&&target?.mapId){const feature=features.find(f=>+f.id===+target.mapId);bounds=feature?d3.geoBounds(feature):null;}
    if(!bounds)bounds=target?.center?[[target.center[0]-9,target.center[1]-7],[target.center[0]+9,target.center[1]+7]]:[[-175,-52],[175,78]];
    const [[west,south],[east,north]]=bounds;
    const minimum=target?.coordinates&&!target.labelOnly?7:18;
    const dest={x:(west+east)/2,y:(south+north)/2,scale:Math.min(width/(Math.max(minimum,east-west)*1.22), (height-110)/(Math.max(minimum,north-south)*.78+8))};
    dest.scale=Math.min(70,Math.max(.6,dest.scale));
    cancelAnimationFrame(animation);
    if(!animate||matchMedia('(prefers-reduced-motion: reduce)').matches){Object.assign(camera,dest);refreshDetail();draw();return;}
    const start={...camera},time=performance.now();
    const tick=now=>{const t=Math.min(1,(now-time)/650),e=1-Math.pow(1-t,3);for(const key of ['x','y','scale'])camera[key]=start[key]+(dest[key]-start[key])*e;draw();if(t<1)animation=requestAnimationFrame(tick);else{refreshDetail();draw();}};
    animation=requestAnimationFrame(tick);
  }
  regionNav();index();
  if(!gl){
    loading.textContent='This browser cannot display the 3D view. The place index is still available.';
    // Keep the content browsable even when the graphics API is unavailable.
    currentRegion=regions[0];regionNav();index();return;
  }
  try {
    const [topology,details,fine]=await Promise.all(['countries-50m.json','relief-details.json','visited-countries-10m.json'].map(async name=>{
      const response=await fetch('assets/maps/'+name);if(!response.ok)throw new Error('Map data unavailable');return response.json();
    }));
    features=topojson.feature(topology,topology.objects.countries).features.filter(f=>+f.id!==10);
    const terrainImage=new Image();terrainImage.src='assets/maps/shaded-relief.jpg';
    await terrainImage.decode();
    // GeoJSON uses the opposite polygon winding convention from D3's spherical paths.
    for(const feature of [...details.lakes.features,...fine.features]){
      const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
      for(const polygon of polygons)if(d3.geoArea({type:'Polygon',coordinates:polygon})>2*Math.PI)for(const ring of polygon)ring.reverse();
    }
    features=features.filter(feature=>!countryIds.has(+feature.id)).concat(fine.features);
    const featureBounds=new Map(features.map(feature=>[feature,d3.geoBounds(feature)]));
    function shader(type,source){const value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(value));return value;}
    const program=gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,`
      attribute vec3 a_position; attribute vec2 a_uv; attribute vec3 a_color;
      uniform vec2 u_center; uniform vec2 u_size; uniform float u_scale;
      uniform float u_angle; uniform float u_tilt; uniform float u_height;uniform vec3 u_pin;
      varying vec2 v_uv; varying vec3 v_color;
      void main(){vec2 world=u_pin.z>0.0?(a_position.xy-u_pin.xy)*u_pin.z+u_pin.xy:a_position.xy;
        vec2 p=world-u_center;float c=cos(u_angle),s=sin(u_angle);
        p=vec2(p.x*c-p.y*s,p.x*s+p.y*c);float z=a_position.z*u_height;
        float y=p.y*cos(u_tilt)+z*sin(u_tilt);float depth=p.y*sin(u_tilt)-z*cos(u_tilt);
        gl_Position=vec4(p.x*u_scale*2.0/u_size.x,y*u_scale*2.0/u_size.y,depth/600.0,1.0);
        v_uv=a_uv;v_color=a_color;}`));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`
      precision mediump float;varying vec2 v_uv;varying vec3 v_color;
      uniform sampler2D u_texture;uniform float u_textured;uniform vec4 u_bounds;
      void main(){vec4 color=u_textured>0.5?texture2D(u_texture,(v_uv-u_bounds.xy)/u_bounds.zw):vec4(v_color,1.0);
        if(color.a<0.2)discard;gl_FragColor=color;}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const uniforms=Object.fromEntries(['center','size','scale','angle','tilt','height','texture','textured','bounds','pin'].map(name=>[name,gl.getUniformLocation(program,'u_'+name)]));
    const attributes=['position','uv','color'].map(name=>gl.getAttribLocation(program,'a_'+name));
    function mesh(data,texture=null,bounds=[-180,-90,180,90],detail=false,pin=null){const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);meshes.push({buffer,count:data.length/8,texture,bounds:[(bounds[0]+180)/360,(90-bounds[3])/180,(bounds[2]-bounds[0])/360,(bounds[3]-bounds[1])/180],detail,pin});}
    const vertex=(x,y,z,color=[1,1,1])=>[x,y,z,(x+180)/360,(90-y)/180,...color];
    const triangle=(data,a,b,c,color)=>data.push(...vertex(...a,color),...vertex(...b,color),...vertex(...c,color));
    function texture(layer,bounds=[-180,-90,180,90],close=false){
      const [west,south,east,north]=bounds;
      const surface=document.createElement('canvas');surface.width=Math.min(close?2048:4096,gl.getParameter(gl.MAX_TEXTURE_SIZE));surface.height=surface.width/2;
      const pixels=surface.width/(east-west);
      const ctx=surface.getContext('2d');const projection=d3.geoEquirectangular().scale(pixels*180/Math.PI).translate([-west*pixels,north*pixels]).clipExtent([[0,0],[surface.width,surface.height]]);
      const path=d3.geoPath(projection,ctx);
      if(layer==='grid'){
        ctx.fillStyle='#141715';ctx.fillRect(0,0,surface.width,surface.height);ctx.beginPath();path(d3.geoGraticule().step(close?[5,5]:[15,15])());ctx.strokeStyle='#293129';ctx.lineWidth=close?.8:1;ctx.stroke();
      }else{
        const layerFeatures=features.filter(feature=>{const [[w,s],[e,n]]=featureBounds.get(feature);return countryIds.has(+feature.id)===(layer==='visited')&&n>=south&&s<=north&&(e<w||e>=west&&w<=east);});
        for(const feature of layerFeatures){const visited=countryIds.has(+feature.id),active=+(selected?.mapId||selected?.country?.mapId)===+feature.id;
          ctx.beginPath();path(feature);ctx.fillStyle=visited?(active&&close?'#899174':'#77836a'):'#3a4337';ctx.fill();ctx.strokeStyle=visited?'#a0aa91':'#555e50';ctx.lineWidth=visited?1.8:1.2;ctx.stroke();}
        ctx.save();ctx.beginPath();path({type:'FeatureCollection',features:layerFeatures});ctx.clip();
        if(terrainVisible){ctx.globalCompositeOperation='multiply';ctx.globalAlpha=.88;ctx.drawImage(terrainImage,(-180-west)*pixels,(north-90)*pixels,360*pixels,180*pixels);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;}
        if(close){ctx.beginPath();path(details.provinces);ctx.strokeStyle=layer==='visited'?'#969f8377':'#727e6144';ctx.lineWidth=1;ctx.setLineDash([5,4]);ctx.stroke();ctx.setLineDash([]);}
        ctx.beginPath();path({type:'FeatureCollection',features:details.rivers.features.filter(feature=>feature.properties.rank<=(close?6:3))});ctx.strokeStyle=layer==='visited'?'#344c4b':'#3e5046';ctx.lineWidth=close?1.6:1.3;ctx.stroke();
        ctx.beginPath();path(details.lakes);ctx.fillStyle='#192624';ctx.fill();ctx.strokeStyle='#71827677';ctx.lineWidth=close?1:.7;ctx.stroke();ctx.restore();
      }
      const value=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,value);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,surface);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.generateMipmap(gl.TEXTURE_2D);return value;
    }
    for(const [layer,z] of [['grid',-1.2],['land',0],['visited',reliefHeight]]){
      const data=[];triangle(data,[-180,-90,z],[180,-90,z],[180,90,z]);triangle(data,[-180,-90,z],[180,90,z],[-180,90,z]);mesh(data,texture(layer));
      meshes[meshes.length-1].layer=layer;
    }
    const walls=[];
    for(const feature of features){
      if(!countryIds.has(+feature.id))continue;
      const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
      for(const polygon of polygons)for(const ring of polygon)for(let i=1;i<ring.length;i++){
        const [x,y]=ring[i-1],[xx,yy]=ring[i];if(Math.abs(xx-x)>180)continue;
        const shade=.25+Math.abs(xx-x)/(Math.hypot(xx-x,yy-y)||1)*.08,color=[shade,shade+.035,shade-.015];
        triangle(walls,[x,y,0],[xx,yy,0],[xx,yy,reliefHeight],color);triangle(walls,[x,y,0],[xx,yy,reliefHeight],[x,y,reliefHeight],color);
      }
    }
    mesh(walls);
    for(const place of points){
      const markers=[];
      const [x,y]=place.coordinates,z=place.familiar?18:5.5,r=place.familiar?1.2:.65;
      place.height=z;
      for(let i=0;i<10;i++){
        const a=i*Math.PI/5,b=(i+1)*Math.PI/5;
        const p=[x+Math.cos(a)*r,y+Math.sin(a)*r],q=[x+Math.cos(b)*r,y+Math.sin(b)*r];
        const shade=.62+Math.cos(a)*.1,color=place.familiar?[shade+.13,shade+.07,shade-.06]:[shade-.1,shade-.04,shade-.12];
        triangle(markers,[...p,reliefHeight],[...q,reliefHeight],[...q,z],color);triangle(markers,[...p,reliefHeight],[...q,z],[...p,z],color);
        triangle(markers,[x,y,z],[...p,z],[...q,z],place.familiar?[.87,.81,.69]:[.7,.75,.65]);
      }
      mesh(markers,null,undefined,false,place.coordinates);
    }
    for(const place of mapLabels){
      const label=button(place.name,()=>choose(place),'map-label'+(place.familiar?' familiar':'')+(place.labelOnly?' country-label':''));
      label.setAttribute('aria-label',place.name+(place.familiar?', more than a visit':''));document.querySelector('#labels').append(label);labelNodes.set(place,label);
      const line=document.createElementNS('http://www.w3.org/2000/svg','line');document.querySelector('#leaders').append(line);leaderNodes.set(place,line);
    }
    refreshDetail=()=>{
      for(let i=meshes.length-1;i>=0;i--)if(meshes[i].detail){gl.deleteBuffer(meshes[i].buffer);gl.deleteTexture(meshes[i].texture);meshes.splice(i,1);}
      if(camera.scale<3.2)return;
      const c=Math.abs(Math.cos(camera.angle)),s=Math.abs(Math.sin(camera.angle)),vertical=height/Math.cos(camera.tilt);
      const span=Math.min(360,Math.max(c*width+s*vertical,2*(s*width+c*vertical))/camera.scale*1.35);
      const x=Math.max(-180+span/2,Math.min(180-span/2,camera.x)),y=Math.max(-90+span/4,Math.min(90-span/4,camera.y));
      const bounds=[x-span/2,y-span/4,x+span/2,y+span/4];
      for(const [layer,z] of [['grid',-1.19],['land',.015],['visited',reliefHeight+.015]]){
        const [west,south,east,north]=bounds,data=[];
        triangle(data,[west,south,z],[east,south,z],[east,north,z]);triangle(data,[west,south,z],[east,north,z],[west,north,z]);mesh(data,texture(layer,bounds,true),bounds,true);
      }
      if(selected?.coordinates&&!selected.labelOnly){
        const ring=[],[x,y]=selected.coordinates,r=12/camera.scale,z=reliefHeight+.04;
        for(let i=0;i<64;i++){const a=i*Math.PI/32,b=(i+1)*Math.PI/32;
          const p=[x+Math.cos(a)*r,y+Math.sin(a)*r,z],q=[x+Math.cos(b)*r,y+Math.sin(b)*r,z];
          const innerA=[x+Math.cos(a)*r*.88,y+Math.sin(a)*r*.88,z],innerB=[x+Math.cos(b)*r*.88,y+Math.sin(b)*r*.88,z];
          triangle(ring,p,q,innerB,[.83,.79,.65]);triangle(ring,p,innerB,innerA,[.83,.79,.65]);
        }mesh(ring,null,undefined,true);
      }
    };
    let detailTimer;
    const scheduleDetail=()=>{clearTimeout(detailTimer);detailTimer=setTimeout(()=>{refreshDetail();draw();},160);};
    gl.enable(gl.DEPTH_TEST);gl.clearColor(17/255,17/255,17/255,1);
    function screen(place){
      const x=place.coordinates[0]-camera.x,y=place.coordinates[1]-camera.y,c=Math.cos(camera.angle),s=Math.sin(camera.angle);
      return [width/2+(x*c-y*s)*camera.scale,height/2-((x*s+y*c)*Math.cos(camera.tilt)+place.height/Math.pow(camera.scale,.65)*Math.sin(camera.tilt))*camera.scale];
    }
    const readout=document.querySelector('#map-readout');
    const coordinateText=([x,y])=>Math.abs(y).toFixed(2)+'° '+(y<0?'S':'N')+'  /  '+Math.abs(x).toFixed(2)+'° '+(x<0?'W':'E');
    function ground(x,y,z=0){
      const px=(x-width/2)/camera.scale,py=((height/2-y)/camera.scale-z/Math.pow(camera.scale,.65)*Math.sin(camera.tilt))/Math.cos(camera.tilt);
      const c=Math.cos(camera.angle),s=Math.sin(camera.angle);
      return [camera.x+px*c+py*s,camera.y-px*s+py*c];
    }
    function local(event){const rect=canvas.getBoundingClientRect();return [event.clientX-rect.left,event.clientY-rect.top];}
    draw=()=>{
      gl.viewport(0,0,canvas.width,canvas.height);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniform2f(uniforms.center,camera.x,camera.y);gl.uniform2f(uniforms.size,width,height);gl.uniform1f(uniforms.scale,camera.scale);gl.uniform1f(uniforms.angle,camera.angle);gl.uniform1f(uniforms.tilt,camera.tilt);gl.uniform1f(uniforms.height,1/Math.pow(camera.scale,.65));gl.uniform1i(uniforms.texture,0);
      for(const item of meshes){gl.bindBuffer(gl.ARRAY_BUFFER,item.buffer);for(let i=0;i<3;i++){gl.enableVertexAttribArray(attributes[i]);gl.vertexAttribPointer(attributes[i],[3,2,3][i],gl.FLOAT,false,32,[0,12,20][i]);}gl.uniform1f(uniforms.textured,item.texture?1:0);gl.uniform4fv(uniforms.bounds,item.bounds);gl.uniform3f(uniforms.pin,item.pin?.[0]||0,item.pin?.[1]||0,item.pin?1/Math.pow(camera.scale,.65):0);if(item.texture)gl.bindTexture(gl.TEXTURE_2D,item.texture);gl.drawArrays(gl.TRIANGLES,0,item.count);}
      document.querySelector('#north-arrow').style.transform='rotate('+Math.atan2(-Math.sin(camera.angle),Math.cos(camera.angle)*Math.cos(camera.tilt))+'rad)';
      readout.textContent=coordinateText(selected?.coordinates||[camera.x,camera.y]);
      // Keep label hit areas away from marker heads, including neighboring pins.
      const occupied=points.map(screen).filter(([x,y])=>x>0&&x<width&&y>0&&y<height).map(([x,y])=>[x-6,y-6,x+6,y+6,true]);
      const priority=[...mapLabels].sort((a,b)=>(b.id===selected?.id)-(a.id===selected?.id)||Number(!!b.familiar)-Number(!!a.familiar)||Number(!!a.labelOnly)-Number(!!b.labelOnly));
      for(const place of priority){const node=labelNodes.get(place),line=leaderNodes.get(place),[x,y]=screen(place);const textWidth=place.name.length*(width<600?6.3:7)+8,textHeight=20;
        const eligible=(!currentRegion||place.region.id===currentRegion.id)&&(currentRegion||place.familiar)&&(!place.labelOnly||camera.scale>3.2)&&x>8&&x<width-8&&y>20&&y<height-65;
        const offsets=place.labelOnly?[[8,-10]]:[[9,-11],[9,-34],[9,12],[-textWidth-10,-11],[-textWidth-10,-34],[-textWidth-10,12],[12,-57],[12,35]];
        const offset=eligible&&offsets.find(([dx,dy])=>{
          const left=x+dx,top=y+dy;
          return left>6&&left+textWidth<width-6&&top>15&&top+textHeight<height-65&&!occupied.some(box=>{const pad=box[4]?1:5;return left<box[2]+pad&&left+textWidth>box[0]-pad&&top<box[3]+2&&top+textHeight>box[1]-2;});
        });
        node.hidden=!offset;line.style.display=offset&&!place.labelOnly?'':'none';
        if(offset){const [dx,dy]=offset,left=x+dx,top=y+dy;node.style.left=left+'px';node.style.top=top+'px';occupied.push([left,top,left+textWidth,top+textHeight]);
          line.setAttribute('x1',x);line.setAttribute('y1',y);line.setAttribute('x2',dx<0?left+textWidth:left);line.setAttribute('y2',top+textHeight/2);
        }
        node.classList.toggle('selected',place.id===selected?.id);
      }
    };
    function resize(){const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;const ratio=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);focus(selected||currentRegion,false);}
    new ResizeObserver(resize).observe(canvas);
    let drag=null,pinch=null;
    const pointers=new Map();
    function constrain(){camera.x=Math.max(-180,Math.min(180,camera.x));camera.y=Math.max(-80,Math.min(80,camera.y));}
    function pick(x,y){
      const point=points.map(place=>({place,at:screen(place)})).map(item=>({...item,distance:Math.hypot(x-item.at[0],y-item.at[1])})).sort((a,b)=>a.distance-b.distance)[0];
      if(point?.distance<17){choose(point.place);return;}
      const position=ground(x,y,reliefHeight);
      const feature=features.find(feature=>{if(!countryIds.has(+feature.id))return false;const [[w,s],[e,n]]=featureBounds.get(feature);return position[1]>=s&&position[1]<=n&&(e<w||position[0]>=w&&position[0]<=e)&&d3.geoContains(feature,position);});
      if(feature)choose(countries.find(country=>+country.mapId===+feature.id));
    }
    canvas.addEventListener('pointerdown',event=>{
      if(event.button>0)return;cancelAnimationFrame(animation);clearTimeout(detailTimer);
      const [x,y]=local(event);pointers.set(event.pointerId,[x,y]);canvas.setPointerCapture(event.pointerId);
      if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a[0]-b[0],a[1]-b[1]),scale:camera.scale,anchor:ground((a[0]+b[0])/2,(a[1]+b[1])/2)};drag=null;}
      else drag={x,y,angle:camera.angle,tilt:camera.tilt,anchor:ground(x,y),pan:event.shiftKey,moved:false};
    });
    canvas.addEventListener('pointermove',event=>{
      const [x,y]=local(event);if(pointers.has(event.pointerId))pointers.set(event.pointerId,[x,y]);
      if(pinch&&pointers.size===2){const [a,b]=[...pointers.values()];camera.scale=Math.max(.5,Math.min(96,pinch.scale*Math.hypot(a[0]-b[0],a[1]-b[1])/Math.max(1,pinch.distance)));const at=ground((a[0]+b[0])/2,(a[1]+b[1])/2);camera.x+=pinch.anchor[0]-at[0];camera.y+=pinch.anchor[1]-at[1];constrain();draw();return;}
      if(!drag){const position=ground(x,y);if(Math.abs(position[0])<=180&&Math.abs(position[1])<=90)readout.textContent=coordinateText(position);return;}
      drag.moved ||= Math.hypot(x-drag.x,y-drag.y)>5;
      if(drag.pan){const at=ground(x,y);camera.x+=drag.anchor[0]-at[0];camera.y+=drag.anchor[1]-at[1];constrain();}
      else{camera.angle=drag.angle+(x-drag.x)*.004;camera.tilt=Math.max(0,Math.min(1.18,drag.tilt+(y-drag.y)*.004));}
      document.querySelector('#tilt').setAttribute('aria-pressed',String(camera.tilt>.1));draw();
    });
    canvas.addEventListener('pointerup',event=>{const [x,y]=local(event),click=drag&&!drag.moved&&!pinch;pointers.delete(event.pointerId);drag=null;pinch=null;if(click)pick(x,y);else scheduleDetail();});
    for(const event of ['pointercancel','lostpointercapture'])canvas.addEventListener(event,eventData=>{pointers.delete(eventData.pointerId);drag=null;pinch=null;scheduleDetail();});
    function zoom(factor,anchor=[width/2,height/2]){cancelAnimationFrame(animation);const before=ground(...anchor);camera.scale=Math.max(.5,Math.min(96,camera.scale*factor));const after=ground(...anchor);camera.x+=before[0]-after[0];camera.y+=before[1]-after[1];constrain();draw();scheduleDetail();}
    canvas.addEventListener('wheel',event=>{event.preventDefault();zoom(Math.exp(-event.deltaY*.001),local(event));},{passive:false});
    canvas.addEventListener('dblclick',event=>{event.preventDefault();zoom(1.8,local(event));});
    canvas.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(event.key))return;event.preventDefault();cancelAnimationFrame(animation);if(event.key==='ArrowLeft')camera.angle-=.1;if(event.key==='ArrowRight')camera.angle+=.1;if(event.key==='ArrowUp')camera.tilt=Math.min(1.18,camera.tilt+.1);if(event.key==='ArrowDown')camera.tilt=Math.max(0,camera.tilt-.1);if(event.key==='+'||event.key==='=')zoom(1.2);if(event.key==='-')zoom(1/1.2);document.querySelector('#tilt').setAttribute('aria-pressed',String(camera.tilt>.1));draw();scheduleDetail();});
    document.querySelector('#zoom-in').onclick=()=>zoom(1.25);document.querySelector('#zoom-out').onclick=()=>zoom(.8);
    document.querySelector('#tilt').onclick=event=>{camera.tilt=camera.tilt>.1?0:.85;event.currentTarget.setAttribute('aria-pressed',String(camera.tilt>.1));refreshDetail();draw();};
    document.querySelector('#terrain').onclick=event=>{terrainVisible=!terrainVisible;event.currentTarget.setAttribute('aria-pressed',String(terrainVisible));for(const item of meshes)if(item.layer){gl.deleteTexture(item.texture);item.texture=texture(item.layer);}refreshDetail();draw();};
    document.querySelector('#reset').onclick=()=>{camera.angle=-.1;camera.tilt=.85;document.querySelector('#tilt').setAttribute('aria-pressed','true');focus(selected||currentRegion);};
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();loading.hidden=false;loading.textContent='The map paused. Reload this page to reopen it.';});
    loading.hidden=true;resize();
  }catch(error){console.error(error);loading.textContent='The map could not open. Please reload to try again.';}
  // Defined before initialization so the text index remains usable without WebGL.
  function draw(){}
})();

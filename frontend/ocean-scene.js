import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const API=`${location.protocol}//${location.hostname}:8000`;
const $=id=>document.getElementById(id);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const flat=(v,a=[])=>{Array.isArray(v)?v.forEach(x=>flat(x,a)):a.push(v);return a};
const get=async u=>{const r=await fetch(u);if(!r.ok)throw Error(`${r.status} ${r.statusText}`);return r.json()};
function asDate(v){const n=Number(v);if(Number.isFinite(n)&&Math.abs(n)>1e14)return new Date(n/1e6);if(Number.isFinite(n)&&Math.abs(n)>1e11)return new Date(n);const d=new Date(v);return isNaN(d)?null:d}
const day=v=>{const d=asDate(v);return d?d.toISOString().slice(0,10):String(v??'—')};
const iso=v=>{const d=asDate(v);return d?d.toISOString():String(v)};
const fmt=v=>!finite(v)?'—':Math.abs(v)>=100?v.toFixed(1):Math.abs(v)>=10?v.toFixed(2):v.toFixed(3);
const ranges={temperature:[0,35],temperature_anomaly:[-5,5],salinity:[30,40],chlorophyll:[0,10]};
const palettes={
 temperature:[[0x1769d1,0],[0x39a9df,.28],[0xf1e36b,.55],[0xf48b35,.78],[0xd9342b,1]],
 temperature_anomaly:[[0x2b66c9,0],[0x9bc9ee,.3],[0xf4f4e8,.5],[0xf09a56,.75],[0xb62925,1]],
 salinity:[[0x2455d8,0],[0x25a9a1,.35],[0x54c96a,.68],[0xd9ef82,1]],
 chlorophyll:[[0xdff5c5,0],[0x8bd66a,.35],[0x2b9a50,.7],[0x07552e,1]]
};
function color(kind,t){const p=palettes[kind]||palettes.temperature;t=Math.max(0,Math.min(1,t));for(let i=0;i<p.length-1;i++){const a=p[i],b=p[i+1];if(t<=b[1])return new THREE.Color(a[0]).lerp(new THREE.Color(b[0]),(t-a[1])/(b[1]-a[1]))}return new THREE.Color(p.at(-1)[0])}
function valueRange(v){let lo=Infinity,hi=-Infinity;flat(v).forEach(x=>{const n=+x;if(finite(n)){lo=Math.min(lo,n);hi=Math.max(hi,n)}});return lo===Infinity?[0,1]:[lo,hi===lo?lo+1:hi]}

let geo,catalog=[],current=null,times=[],depths=[],depthEx=55,playing=false,lastPlay=0,requestId=0;
const cache=new Map();
const scene=new THREE.Scene();scene.background=new THREE.Color(0xe5eef3);
const camera=new THREE.PerspectiveCamera(42,innerWidth/innerHeight,.1,30000);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance',alpha:false});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;$('app').appendChild(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.08;controls.screenSpacePanning=true;controls.minDistance=30;controls.maxDistance=14000;controls.mouseButtons.LEFT=THREE.MOUSE.ROTATE;controls.mouseButtons.RIGHT=THREE.MOUSE.PAN;controls.mouseButtons.MIDDLE=THREE.MOUSE.DOLLY;
scene.add(new THREE.HemisphereLight(0xffffff,0x607b85,2.2));const sun=new THREE.DirectionalLight(0xffffff,2.2);sun.position.set(-500,-600,1500);scene.add(sun);
const root=new THREE.Group();scene.add(root);
const seabed=new THREE.Group(),water=new THREE.Group(),land=new THREE.Group(),coast=new THREE.Group(),eez=new THREE.Group(),fields=new THREE.Group(),currents=new THREE.Group();[seabed,water,land,coast,eez,fields,currents].forEach(g=>root.add(g));
let center={x:0,y:0,size:1000};
function xy(lon,lat,z=0){const b=geo.bounds,lon0=(b[0]+b[1])/2,lat0=(b[2]+b[3])/2;return[(lon-lon0)*111.32*Math.cos(lat0*Math.PI/180),(lat-lat0)*111.32,z]}
function clear(g){while(g.children.length){const o=g.children.pop();o.traverse(q=>{q.geometry?.dispose();q.material?.dispose?.()})}}
function status(s,type='ok'){$('status').textContent=s;$('statusDot').className=`statusdot ${type==='error'?'error':type==='busy'?'busy':''}`}
function cameraFit(){const d=Math.max(650,center.size*1.65);camera.position.set(center.x+d*.72,center.y-d*.82,d*.62);controls.target.set(center.x,center.y,-Math.min(80,center.size*.05));controls.update();camera.far=Math.max(30000,d*10);camera.updateProjectionMatrix()}

function addLandPolygon(p){
  const z=6.5;
  if(p.vertices?.length&&p.triangles?.length){
    const pos=new Float32Array(p.vertices.length*3);
    p.vertices.forEach((q,i)=>{pos[i*3]=q[0];pos[i*3+1]=q[1];pos[i*3+2]=z});
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setIndex(p.triangles.flat());g.computeVertexNormals();
    const m=new THREE.MeshBasicMaterial({color:0x3f9b55,side:THREE.DoubleSide,depthTest:false,depthWrite:false});const mesh=new THREE.Mesh(g,m);mesh.renderOrder=50;land.add(mesh);return;
  }
  if(p.top?.length>=3){
    const s=new THREE.Shape();p.top.forEach((q,i)=>i?s.lineTo(q[0],q[1]):s.moveTo(q[0],q[1]));
    const g=new THREE.ShapeGeometry(s);g.translate(0,0,z);const m=new THREE.MeshBasicMaterial({color:0x3f9b55,side:THREE.DoubleSide,depthTest:false,depthWrite:false});const mesh=new THREE.Mesh(g,m);mesh.renderOrder=50;land.add(mesh);
  }
}
function addLine(group,parts,z,hex,order=60){const m=new THREE.LineBasicMaterial({color:hex,depthTest:false,depthWrite:false});for(const a of parts||[]){if(!a?.length)continue;const g=new THREE.BufferGeometry().setFromPoints(a.map(q=>new THREE.Vector3(q[0],q[1],z)));const l=new THREE.Line(g,m);l.renderOrder=order;group.add(l)}}

function buildBase(){
  clear(seabed);clear(water);clear(land);clear(coast);clear(eez);
  const t=geo.terrain,x=t.x,y=t.y,r=t.rawDepthKm,nx=x.length,ny=y.length;
  const minX=Math.min(...x),maxX=Math.max(...x),minY=Math.min(...y),maxY=Math.max(...y);center={x:(minX+maxX)/2,y:(minY+maxY)/2,size:Math.max(maxX-minX,maxY-minY)};
  const pos=new Float32Array(nx*ny*3),idx=[];
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const k=j*nx+i;pos[3*k]=x[i];pos[3*k+1]=y[j];pos[3*k+2]=finite(r[j][i])?-r[j][i]*depthEx:-1}
  for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){const q=[r[j][i],r[j][i+1],r[j+1][i],r[j+1][i+1]];if(q.every(finite)){const a=j*nx+i,b=a+1,c=a+nx,d=c+1;idx.push(a,c,b,b,c,d)}}
  const bg=new THREE.BufferGeometry();bg.setAttribute('position',new THREE.BufferAttribute(pos,3));bg.setIndex(idx);bg.computeVertexNormals();
  const bm=new THREE.MeshStandardMaterial({color:0x795b43,roughness:.97,metalness:0,side:THREE.DoubleSide});seabed.add(new THREE.Mesh(bg,bm));
  // Water is deliberately a separate, continuous surface. It never replaces the GEBCO seabed.
  const wg=new THREE.PlaneGeometry(maxX-minX,maxY-minY,1,1);const wm=new THREE.MeshPhysicalMaterial({color:0x318fbe,transparent:true,opacity:.20,roughness:.15,metalness:0,clearcoat:.25,side:THREE.DoubleSide,depthWrite:false});const ws=new THREE.Mesh(wg,wm);ws.position.set(center.x,center.y,1.2);ws.renderOrder=5;water.add(ws);
  for(const p of [...(geo.land?.polygons||[]),...(geo.islands?.polygons||[])])addLandPolygon(p);
  addLine(coast,geo.coast,7.2,0x1d4d55,70);addLine(eez,geo.eez,6.9,0xb47c18,65);
  cameraFit();
}
function updateBathymetry(){const mesh=seabed.children[0];if(!mesh)return;const a=mesh.geometry.attributes.position,r=geo.terrain.rawDepthKm,nx=geo.terrain.x.length,ny=geo.terrain.y.length;for(let j=0;j<ny;j++)for(let i=0;i<nx;i++)a.setZ(j*nx+i,finite(r[j][i])?-r[j][i]*depthEx:-1);a.needsUpdate=true;mesh.geometry.computeVertexNormals()}

function renderVariables(){clear(fields);if(!current||!current.available||current.id==='currents')return;const inds=depths.length?layerIndices():[0];Promise.all(inds.map(i=>fetchLayer(depths.length?depths[i]:null))).then(ds=>{if(current?.id!=='currents')drawLayers(ds,inds)}).catch(e=>status(`Field unavailable: ${e.message}`,'error'))}
function layerIndices(){const n=Math.min(5,depths.length),c=+$('depth').value||0;if(!n)return[0];const start=Math.max(0,Math.min(depths.length-n,c-Math.floor(n/2)));return Array.from({length:n},(_,i)=>start+i)}
function selectedDepth(){return depths.length?depths[+$('depth').value||0]:null}
function layerKey(d){return `${current?.id}|${+$('time').value||0}|${d??'surface'}`}
async function fetchLayer(d){const k=layerKey(d);if(cache.has(k))return cache.get(k);const q=new URLSearchParams({file:current.file,variable:current.variable,stride:'3'}),ti=+$('time').value||0;if(times.length){q.set('time_start',iso(times[ti]));q.set('time_end',iso(times[ti]))}if(d!=null){q.set('depth_min',d);q.set('depth_max',d)}const v=await get(`${API}/data/region/array?${q}`);cache.set(k,v);return v}
function drawLayers(ds,inds){clear(fields);let rr=null;ds.forEach(d=>{const r=valueRange(d.data||[]);rr=rr?[Math.min(rr[0],r[0]),Math.max(rr[1],r[1])]:r});if(current.id==='temperature_anomaly'){const a=Math.max(Math.abs(rr[0]),Math.abs(rr[1]));rr=[-a,a]}
  ds.forEach((d,n)=>drawLayer(d,inds[n],rr,n));$('legendMin').textContent=fmt(rr?.[0]);$('legendMax').textContent=fmt(rr?.[1]);water.children[0].visible=false;
}
function drawLayer(d,di,rr,n){const lat=d.coordinates?.latitude||d.coordinates?.lat||[],lon=d.coordinates?.longitude||d.coordinates?.lon||[];if(lat.length<2||lon.length<2)return;const vals=flat(d.data||[]).map(Number),nx=lon.length,ny=lat.length;if(vals.length<nx*ny)return;const z=-(+(depths[di]||0))*depthEx/1000+2.0,p=[],c=[],ix=[];let vi=0;
  for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){const v=[vals[j*nx+i],vals[j*nx+i+1],vals[(j+1)*nx+i],vals[(j+1)*nx+i+1]];if(!v.every(finite))continue;const base=vi;p.push(...xy(lon[i],lat[j],z),...xy(lon[i+1],lat[j],z),...xy(lon[i],lat[j+1],z),...xy(lon[i+1],lat[j+1],z));v.forEach(q=>{const cc=color(current.id,(q-rr[0])/(rr[1]-rr[0]||1));c.push(cc.r,cc.g,cc.b)});ix.push(base,base+2,base+1,base+1,base+2,base+3);vi+=4}
  if(!p.length)return;const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('color',new THREE.Float32BufferAttribute(c,3));g.setIndex(ix);const m=new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity:di===+$('depth').value?.88:Math.max(.32,.65-n*.06),side:THREE.DoubleSide,depthWrite:false});const mesh=new THREE.Mesh(g,m);mesh.renderOrder=20+n;fields.add(mesh);
}
async function currentsLayer(){clear(currents);try{const q=new URLSearchParams({stride:'4'});if(times.length)q.set('time',iso(times[+$('time').value||0]));if(selectedDepth()!=null)q.set('depth',selectedDepth());const d=await get(`${API}/ocean/current-grid?${q}`),la=d.latitude||[],lo=d.longitude||[],u=d.u||[],v=d.v||[];let max=0;for(let j=0;j<la.length;j++)for(let i=0;i<lo.length;i++){const a=+u[j]?.[i],b=+v[j]?.[i];if(finite(a)&&finite(b))max=Math.max(max,Math.hypot(a,b))}const mat=new THREE.LineBasicMaterial({color:0x0b566d,depthTest:false});const z=-(+(selectedDepth()||0))*depthEx/1000+2.5;for(let j=0;j<la.length;j++)for(let i=0;i<lo.length;i++){const a=+u[j]?.[i],b=+v[j]?.[i];if(!finite(a)||!finite(b))continue;const m=Math.hypot(a,b);if(m<(max||1)*.025)continue;const ang=Math.atan2(b,a),[sx,sy]=xy(lo[i],la[j],z),len=7+28*m/(max||1),ex=sx+Math.cos(ang)*len,ey=sy+Math.sin(ang)*len,s=3.5,L=new THREE.Vector3(ex-Math.cos(ang-.55)*s,ey-Math.sin(ang-.55)*s,z),R=new THREE.Vector3(ex-Math.cos(ang+.55)*s,ey-Math.sin(ang+.55)*s,z),A=new THREE.Vector3(sx,sy,z),B=new THREE.Vector3(ex,ey,z);currents.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([A,B]),mat));currents.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([L,B,R]),mat))}}
  water.children[0].visible=false;status(`Current vectors · ${day(times[+$('time').value||0])}`);$('legendMin').textContent='0';$('legendMax').textContent=fmt(max);$('units').textContent='Current vectors · arrow direction = flow direction';
}

function drawUI(){const defs=[['temperature','Temperature','°C','♨'],['temperature_anomaly','Sea surface temp anomaly','°C','△'],['salinity','Salinity','PSU','≈'],['currents','Currents','m/s','↝'],['sea_level','Sea level','dataset unit','≋'],['hazard','Abnormal / hazard','warnings','!'],['chlorophyll','Chlorophyll','dataset unit','●']];const box=$('vars');box.innerHTML='';for(const [id,label,u,ico] of defs){const c=id==='hazard'?null:catalog.find(x=>x.id===id),b=document.createElement('button');b.className=`var ${c?.available?'':'off'} ${current?.id===id?'active':''}`;b.innerHTML=`<i class="ico">${ico}</i><span><strong>${label}</strong><span>${c?.available?(c.units||u):'No matching dataset'}</span></span><i class="dot ${c?.available?'':'off'}"></i>`;if(c?.available)b.onclick=()=>selectVariable(c);box.appendChild(b)}}
async function selectVariable(c){current=c;cache.clear();drawUI();clear(fields);clear(currents);water.children[0].visible=true;depths=[];$('depth').max=0;$('depth').value=0;try{const m=await get(`${API}/metadata/${encodeURIComponent(c.file)}`);depths=(m.coordinates?.depth?.values||[]).filter(finite);$('depth').max=Math.max(0,depths.length-1);$('depthInfo').textContent=depths.length?`${depths.length} measured layers · 5 layers visible around selected depth.`:'Surface variable — no depth coordinate.'}catch(e){status(`Metadata unavailable: ${e.message}`,'error')}
  $('legend').className=`legend ${(c.id==='temperature'?'temp':c.id==='temperature_anomaly'?'anomaly':c.id==='salinity'?'sal':'neutral')}`;$('units').textContent=`${c.label}${c.units?' · '+c.units:''}`;if(c.id==='currents'){await currentsLayer();return}const id=++requestId;try{status('Loading measured layers…','busy');const inds=layerIndices(),ds=await Promise.all(inds.map(i=>fetchLayer(depths.length?depths[i]:null)));if(id!==requestId)return;drawLayers(ds,inds);status(`${ds.length} measured layer${ds.length>1?'s':''} · ${day(times[+$('time').value||0])}`)}catch(e){status(`Field unavailable: ${e.message}`,'error')}}

function timeline(){const t=$('time');t.max=Math.max(0,times.length-1);t.value=0;$('timeStart').textContent=day(times[0]);$('timeEnd').textContent=day(times.at(-1));$('timeCurrent').textContent=day(times[0]);$('timeIndex').textContent=times.length?`1/${times.length}`:'—';const s=$('timelineScale');s.innerHTML='';const n=Math.min(8,times.length);for(let i=0;i<n;i++){const k=n===1?0:Math.round(i*(times.length-1)/(n-1));const e=document.createElement('span');e.className='tick';e.style.left=`${n===1?0:k/(times.length-1)*100}%`;e.textContent=day(times[k]);s.appendChild(e)}}
async function refreshTime(){const i=+$('time').value||0;$('timeCurrent').textContent=day(times[i]);$('timeIndex').textContent=`${i+1}/${times.length}`;cache.clear();if(current?.available)await selectVariable(current)}
async function refreshDepth(){const d=selectedDepth();$('depthValue').textContent=d==null?'Surface':`${fmt(d)} m`;$('depthBadge').textContent=d==null?'Surface':`Depth ${fmt(d)} m`;if(current?.available)await selectVariable(current)}
function setView(v){document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===v));const d=Math.max(600,center.size*1.6);if(v==='top')camera.position.set(center.x,center.y,d);else if(v==='profile')camera.position.set(center.x,center.y-d*.95,80);else if(v==='under')camera.position.set(center.x,center.y,-d*.62);else cameraFit();controls.target.set(center.x,center.y,v==='under'?-80:-Math.min(80,center.size*.05));controls.update()}

$('depth').oninput=refreshDepth;$('time').oninput=refreshTime;$('exaggeration').oninput=()=>{depthEx=+$('exaggeration').value;$('exagValue').textContent=`${depthEx}×`;updateBathymetry();if(current?.available)renderVariables()};$('reset').onclick=()=>setView('3d');$('fullscreen').onclick=()=>document.documentElement.requestFullscreen?.();document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));$('closeReadout').onclick=()=>$('readout').style.display='none';$('play').onclick=()=>{playing=!playing;$('play').textContent=playing?'PAUSE':'PLAY';lastPlay=performance.now()};
renderer.domElement.addEventListener('click',async e=>{const r=renderer.domElement.getBoundingClientRect(),m=new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),ray=new THREE.Raycaster();ray.setFromCamera(m,camera);const hit=ray.intersectObjects([fields,currents],true)[0];if(!hit)return;const b=geo.bounds,lat0=(b[2]+b[3])/2,lon0=(b[0]+b[1])/2,lat=lat0+(hit.point.y-center.y)/111.32,lon=lon0+(hit.point.x-center.x)/(111.32*Math.cos(lat0*Math.PI/180));try{const q=new URLSearchParams({latitude:lat,longitude:lon});if(times.length)q.set('time',iso(times[+$('time').value||0]));if(selectedDepth()!=null)q.set('depth',selectedDepth());const d=await get(`${API}/ocean/point?${q}`);$('coords').textContent=`${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;$('readoutGrid').innerHTML='';for(const x of d.values||[]){if(!x.available)continue;let v=x.value;if(v&&typeof v==='object')v=Object.entries(v).map(([k,z])=>`${k}: ${fmt(+z)}`).join(' · ');else v=fmt(+v);const el=document.createElement('div');el.className='rval';el.innerHTML=`<b>${x.label}</b><span>${v}${x.units?' '+x.units:''}</span>`;$('readoutGrid').appendChild(el)}$('readoutTime').textContent=`${day(times[+$('time').value||0])} · nearest measured point · depth ${selectedDepth()==null?'surface':fmt(selectedDepth())+' m'}`;$('readout').style.display='block'}catch(err){status(`Point lookup failed: ${err.message}`,'error')}});
async function init(){try{geo=await get('/geometry.json');buildBase();const c=await get(`${API}/ocean/catalog`);catalog=c.variables||[];drawUI();const t=await get(`${API}/ocean/time`);times=t.values||[];timeline();$('loading').style.display='none';status(`${catalog.filter(x=>x.available).length} datasets available`);const first=catalog.find(x=>x.available&&x.id==='temperature')||catalog.find(x=>x.available);if(first)await selectVariable(first);setView('3d')}catch(e){$('loading').innerHTML=`<div class="load"><b>SOLVX</b><div>Unable to initialise: ${e.message}</div></div>`;status(e.message,'error')}}
function animate(now){requestAnimationFrame(animate);if(playing&&times.length&&now-lastPlay>900){$('time').value=(+$('time').value+1)%times.length;refreshTime();lastPlay=now}controls.update();renderer.render(scene,camera)}
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
init();animate(performance.now());

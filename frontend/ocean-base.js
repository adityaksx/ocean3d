import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const finite = v => typeof v === 'number' && Number.isFinite(v);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeaf0f3);
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 30000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('app').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.minDistance = 30;
controls.maxDistance = 14000;
controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;

scene.add(new THREE.HemisphereLight(0xffffff, 0x607b85, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(-500, -600, 1500);
scene.add(sun);

const root = new THREE.Group();
const seabedGroup = new THREE.Group();
const waterGroup = new THREE.Group();
const landGroup = new THREE.Group();
const coastGroup = new THREE.Group();
const eezGroup = new THREE.Group();
root.add(seabedGroup, waterGroup, landGroup, coastGroup, eezGroup);
scene.add(root);

let geometryData;
let center = { x: 0, y: 0, size: 1000 };
let depthExaggeration = 55;

function status(text, type = 'ok') {
  const el = $('status');
  const dot = $('statusDot');
  if (el) el.textContent = text;
  if (dot) dot.className = `statusdot ${type === 'error' ? 'error' : type === 'busy' ? 'busy' : ''}`;
}

function fitCamera() {
  const d = Math.max(650, center.size * 1.65);
  camera.position.set(center.x + d * 0.72, center.y - d * 0.82, d * 0.62);
  controls.target.set(center.x, center.y, -Math.min(80, center.size * 0.05));
  controls.update();
  camera.far = Math.max(30000, d * 10);
  camera.updateProjectionMatrix();
}

function addSeabed() {
  const t = geometryData.terrain;
  const x = t.x, y = t.y, raw = t.rawDepthKm;
  const nx = x.length, ny = y.length;
  const positions = new Float32Array(nx * ny * 3);
  const indices = [];

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      positions[3*k] = x[i];
      positions[3*k+1] = y[j];
      positions[3*k+2] = finite(raw[j][i]) ? -raw[j][i] * depthExaggeration : -2;
    }
  }

  for (let j = 0; j < ny-1; j++) {
    for (let i = 0; i < nx-1; i++) {
      const q = [raw[j][i], raw[j][i+1], raw[j+1][i], raw[j+1][i+1]];
      if (!q.every(finite)) continue;
      const a = j*nx+i, b = a+1, c = a+nx, d = c+1;
      indices.push(a,c,b,b,c,d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  seabedGroup.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: 0x76573f,
    roughness: 0.98,
    metalness: 0,
    side: THREE.DoubleSide
  })));
}

function addWater(minX, maxX, minY, maxY) {
  const width = maxX - minX;
  const height = maxY - minY;
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshPhysicalMaterial({
      color: 0x167fb5,
      transparent: true,
      opacity: 0.36,
      roughness: 0.12,
      clearcoat: 0.5,
      clearcoatRoughness: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  surface.position.set(center.x, center.y, 3);
  surface.renderOrder = 5;
  waterGroup.add(surface);

  // A few inexpensive transparent planes give the ocean real volume.
  for (let i = 1; i <= 7; i++) {
    const slice = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        color: 0x126f9f,
        transparent: true,
        opacity: 0.012 + i * 0.002,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    slice.position.set(center.x, center.y, 3 - i * 18);
    slice.renderOrder = 4 - i;
    waterGroup.add(slice);
  }
}

// IMPORTANT: do not create one ExtrudeGeometry/ShapeGeometry per polygon.
// Natural Earth contains many vertices; doing that blocks the browser for a
// long time. The backend already gives us triangulated land, so merge it into
// ONE GPU mesh instead.
function addLand() {
  const polygons = [
    ...(geometryData.land?.polygons || []),
    ...(geometryData.islands?.polygons || [])
  ];

  const positions = [];
  const indices = [];
  let vertexOffset = 0;
  let rendered = 0;

  for (const p of polygons) {
    if (!Array.isArray(p.vertices) || !Array.isArray(p.triangles)) continue;
    if (p.vertices.length < 3 || p.triangles.length === 0) continue;

    for (const q of p.vertices) {
      if (!Array.isArray(q) || !finite(+q[0]) || !finite(+q[1])) continue;
      positions.push(+q[0], +q[1], 14);
    }

    for (const tri of p.triangles) {
      if (!Array.isArray(tri) || tri.length < 3) continue;
      indices.push(
        vertexOffset + (+tri[0]),
        vertexOffset + (+tri[1]),
        vertexOffset + (+tri[2])
      );
    }

    vertexOffset += p.vertices.length;
    rendered++;
  }

  if (!positions.length || !indices.length) {
    status(`No land triangles found · ${polygons.length} polygons`, 'error');
    return 0;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: 0x3f9b55,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false
  });

  const mesh = new THREE.Mesh(g, material);
  mesh.renderOrder = 100;
  landGroup.add(mesh);

  return rendered;
}

function addLines(group, parts, z, color, order) {
  const material = new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false
  });
  for (const part of parts || []) {
    if (!Array.isArray(part) || part.length < 2) continue;
    const points = part.map(p => new THREE.Vector3(+p[0], +p[1], z));
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(g, material);
    line.renderOrder = order;
    group.add(line);
  }
}

function buildScene() {
  const t = geometryData.terrain;
  const minX = Math.min(...t.x);
  const maxX = Math.max(...t.x);
  const minY = Math.min(...t.y);
  const maxY = Math.max(...t.y);
  center = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    size: Math.max(maxX - minX, maxY - minY)
  };

  addSeabed();
  addWater(minX, maxX, minY, maxY);
  const landCount = addLand();

  addLines(coastGroup, geometryData.coast, 15, 0x103f4b, 130);
  addLines(eezGroup, geometryData.eez, 14.6, 0xb57b18, 120);

  fitCamera();
  status(`3D ocean ready · ${landCount} land polygons`);
  $('loading')?.classList.add('hide');
}

function updateDepth() {
  depthExaggeration = +$('exaggeration')?.value || 55;
  if ($('exagValue')) $('exagValue').textContent = `${depthExaggeration}×`;

  const mesh = seabedGroup.children[0];
  if (!mesh) return;
  const a = mesh.geometry.attributes.position;
  const raw = geometryData.terrain.rawDepthKm;
  const nx = geometryData.terrain.x.length;
  const ny = geometryData.terrain.y.length;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = raw[j][i];
      a.setZ(j * nx + i, finite(v) ? -v * depthExaggeration : -2);
    }
  }
  a.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

$('exaggeration')?.addEventListener('input', updateDepth);
$('reset')?.addEventListener('click', fitCamera);
$('fullscreen')?.addEventListener('click', () => document.documentElement.requestFullscreen?.());
$('closeReadout')?.addEventListener('click', () => $('readout')?.classList.remove('show'));

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    const d = Math.max(650, center.size * 1.5);
    if (button.dataset.view === 'top') {
      camera.position.set(center.x, center.y, d * 0.9);
      controls.target.set(center.x, center.y, 0);
    } else if (button.dataset.view === 'under') {
      camera.position.set(center.x + d * 0.45, center.y - d * 0.45, -d * 0.22);
      controls.target.set(center.x, center.y, -120);
    } else if (button.dataset.view === 'profile') {
      camera.position.set(center.x + d * 0.75, center.y, d * 0.18);
      controls.target.set(center.x, center.y, -120);
    } else {
      fitCamera();
    }
    controls.update();
  });
}

async function init() {
  try {
    status('Loading geometry.json…', 'busy');
    geometryData = await fetch(`geometry.json?${Date.now()}`).then(r => {
      if (!r.ok) throw Error(`${r.status} ${r.statusText}`);
      return r.json();
    });
    buildScene();
  } catch (error) {
    console.error(error);
    status(`3D geometry failed: ${error.message}`, 'error');
    $('loading')?.classList.add('hide');
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

init();
animate();

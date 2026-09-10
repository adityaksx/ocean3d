import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const finite = (v) => Number.isFinite(v);

const app = $('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfeaf1);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 50000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minDistance = 20;
controls.maxDistance = 20000;
controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;

scene.add(new THREE.HemisphereLight(0xffffff, 0x58727d, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-500, -700, 1600);
scene.add(sun);

const root = new THREE.Group();
const seabed = new THREE.Group();
const water = new THREE.Group();
const land = new THREE.Group();
const lines = new THREE.Group();
root.add(seabed, water, land, lines);
scene.add(root);

let data = null;
let terrainMesh = null;
let center = { x: 0, y: 0, size: 1000 };
let exaggeration = 55;

function setStatus(text, kind = '') {
  const el = $('status');
  if (el) el.textContent = text;
  const dot = $('statusDot');
  if (dot) dot.className = `statusdot ${kind}`;
}

function fitCamera() {
  const d = Math.max(700, center.size * 1.45);
  camera.position.set(center.x + d * 0.72, center.y - d * 0.82, d * 0.62);
  controls.target.set(center.x, center.y, -Math.min(100, center.size * 0.06));
  camera.far = Math.max(50000, d * 12);
  camera.updateProjectionMatrix();
  controls.update();
}

function buildTerrain() {
  const t = data.terrain;
  const nx = t.x.length;
  const ny = t.y.length;
  const positions = new Float32Array(nx * ny * 3);
  const indices = [];

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const depth = t.rawDepthKm[j][i];
      positions[k * 3] = t.x[i];
      positions[k * 3 + 1] = t.y[j];
      positions[k * 3 + 2] = finite(depth) ? -depth * exaggeration : -1;
    }
  }

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if ([t.rawDepthKm[j][i], t.rawDepthKm[j][i + 1], t.rawDepthKm[j + 1][i], t.rawDepthKm[j + 1][i + 1]].every(finite)) {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  terrainMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x76573f, roughness: 1, side: THREE.DoubleSide }));
  seabed.add(terrainMesh);
}

function buildWater() {
  const t = data.terrain;
  const minX = t.x[0], maxX = t.x[t.x.length - 1];
  const minY = t.y[0], maxY = t.y[t.y.length - 1];
  const material = new THREE.MeshPhysicalMaterial({ color: 0x167fb5, transparent: true, opacity: 0.34, roughness: 0.15, clearcoat: 0.45, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxY - minY), material);
  mesh.position.set(center.x, center.y, 4);
  mesh.renderOrder = 5;
  water.add(mesh);
}

function addLines(parts, z, color) {
  const material = new THREE.LineBasicMaterial({ color, depthTest: false });
  for (const part of parts ?? []) {
    if (!Array.isArray(part) || part.length < 2) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.flatMap(([x, y]) => [x, y, z]), 3));
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 20;
    lines.add(line);
  }
}

function buildLand() {
  const polygons = [...(data.land?.polygons ?? []), ...(data.islands?.polygons ?? [])];
  const positions = [];
  const indices = [];
  let offset = 0;

  for (const p of polygons) {
    if (!Array.isArray(p.vertices) || !Array.isArray(p.triangles)) continue;
    for (const [x, y] of p.vertices) positions.push(x, y, 14);
    for (const [a, b, c] of p.triangles) indices.push(offset + a, offset + b, offset + c);
    offset += p.vertices.length;
  }

  if (!positions.length || !indices.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x3f9b55, side: THREE.DoubleSide, depthTest: false }));
  mesh.renderOrder = 100;
  land.add(mesh);
}

function updateDepth() {
  exaggeration = Number($('exaggeration')?.value ?? 55);
  $('exagValue').textContent = `${exaggeration}×`;
  if (!terrainMesh) return;
  const a = terrainMesh.geometry.attributes.position;
  const raw = data.terrain.rawDepthKm;
  const nx = data.terrain.x.length;
  for (let j = 0; j < data.terrain.y.length; j++) {
    for (let i = 0; i < nx; i++) {
      const v = raw[j][i];
      a.setZ(j * nx + i, finite(v) ? -v * exaggeration : -1);
    }
  }
  a.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
}

async function init() {
  try {
    setStatus('Loading geometry…', 'busy');
    const response = await fetch('/geometry.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    data = await response.json();

    const t = data.terrain;
    const minX = Math.min(...t.x), maxX = Math.max(...t.x), minY = Math.min(...t.y), maxY = Math.max(...t.y);
    center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, size: Math.max(maxX - minX, maxY - minY) };

    setStatus('Building seabed…', 'busy');
    buildTerrain();
    buildWater();
    buildLand();
    addLines(data.coast, 15, 0x103f4b);
    addLines(data.eez, 14.6, 0xb57b18);
    fitCamera();
    $('loading').remove();
    setStatus('3D ocean ready');
  } catch (error) {
    console.error('SOLVX renderer error:', error);
    $('loadingStatus').textContent = 'FAILED — OPEN BROWSER CONSOLE';
    setStatus(`Renderer failed: ${error.message}`, 'error');
  }
}

$('exaggeration')?.addEventListener('input', updateDepth);
$('reset')?.addEventListener('click', fitCamera);
$('fullscreen')?.addEventListener('click', () => document.documentElement.requestFullscreen?.());
$('closeReadout')?.addEventListener('click', () => $('readout')?.classList.remove('show'));

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    const d = Math.max(700, center.size * 1.5);
    if (button.dataset.view === 'top') camera.position.set(center.x, center.y, d * 0.9);
    else if (button.dataset.view === 'under') camera.position.set(center.x + d * 0.45, center.y - d * 0.45, -d * 0.22);
    else if (button.dataset.view === 'profile') camera.position.set(center.x + d * 0.75, center.y, d * 0.18);
    else return fitCamera();
    controls.target.set(center.x, center.y, button.dataset.view === 'top' ? 0 : -120);
    controls.update();
  });
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

init();

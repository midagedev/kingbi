import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { computeSkeleton, footprints } from './skeleton.js';
import { makeSkeletonLines, makeSkeletonFaces } from './skeleton-viz.js';
import { makeMaterials } from '../builder/palette.js';
import { buildFence } from './fence.js';
import { buildGate } from './gate.js';
import { buildParcel } from './parcel.js';
import { buildSkeletonRoof } from './roof-skeleton.js';
import { buildHanok } from './hanok.js';
import { buildCorridor } from './corridor.js';

const q = new URLSearchParams(location.search);
const SHOT = q.get('shot') === '1';
const CASE = q.get('case') || 'parcel-palace';
if (SHOT) document.body.classList.add('shot');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);

const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.position.set(28, 44, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
sun.shadow.camera.far = 160;
sun.shadow.bias = -0.0001;
sun.shadow.normalBias = 0.05;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.95));

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(140, 48),
  new THREE.MeshStandardMaterial({ color: 0xa89c86, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 800);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// content 를 담고, 바운딩박스로 카메라 프레이밍
function frame(group, { az = 38, el = 34, pad = 1.35, targetYFrac = 0.35 } = {}) {
  scene.add(group);
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z, size.y);
  const target = new THREE.Vector3(center.x, box.min.y + size.y * targetYFrac, center.z);
  const r = maxDim * pad + 4;
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  camera.position.set(
    target.x + r * Math.cos(e) * Math.sin(a),
    target.y + r * Math.sin(e),
    target.z + r * Math.cos(e) * Math.cos(a));
  controls.target.copy(target);
  controls.update();
  // 그림자 카메라를 콘텐츠에 맞춤
  const s = Math.max(20, maxDim * 0.8);
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.updateProjectionMatrix();
}

function buildCase(name) {
  const g = new THREE.Group();
  if (name.startsWith('skeleton')) {
    const which = name.split('-')[1] || 'L';
    const fp = which === 'rect' ? footprints.rect(10, 6)
      : which === 'U' ? footprints.U(9, 7, 3, 6, 3)
      : footprints.L(3.5, 2.4);
    // 중심 원점 정렬
    const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
    const cz = fp.reduce((s, p) => s + p.z, 0) / fp.length;
    const centered = fp.map((p) => ({ x: p.x - cx, z: p.z - cz }));
    const sk = computeSkeleton(centered);
    g.add(makeSkeletonFaces(sk, { heightScale: 0.85, y: 0.02 }));
    g.add(makeSkeletonLines(sk, { y: 0.04, heightScale: 0.85 }));
    // 바닥 발자국(높이 0)도 별도로 얇게
    g.add(makeSkeletonLines(sk, { y: 0.01, heightScale: 0 }));
    frame(g, { el: 42, pad: 1.25 });
    return g;
  }
  if (name.startsWith('roof')) {
    const which = name.split('-')[1] || 'L';
    const fp = which === 'rect' ? footprints.rect(11, 7)
      : which === 'U' ? footprints.U(13, 10, 4.5, 8.5, 4)
      : footprints.L(4, 3);
    const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
    const cz = fp.reduce((s, p) => s + p.z, 0) / fp.length;
    const centered = fp.map((p) => ({ x: p.x - cx, z: p.z - cz }));
    const mats = makeMaterials('palace');
    const hanok = buildHanok({ footprint: centered, seed: 11, mats, wallH: 2.7 });
    g.add(hanok);
    frame(g, { az: 40, el: 22, pad: 1.2, targetYFrac: 0.42 });
    return g;
  }
  if (name.startsWith('corridor')) {
    const mats = makeMaterials('palace');
    if (name.includes('court')) {
      const hw = 8, hd = 6;
      const loop = [{ x: -hw, z: hd }, { x: hw, z: hd }, { x: hw, z: -hd }, { x: -hw, z: -hd }];
      const { group } = buildCorridor({ points: loop, closed: true, mats, seed: 4, depth: 2.6 });
      g.add(group);
      frame(g, { az: 38, el: 34, pad: 1.2, targetYFrac: 0.4 });
    } else {
      const { group } = buildCorridor({
        points: [{ x: -10, z: 0 }, { x: 10, z: 0 }], closed: false, mats, seed: 4, depth: 2.6,
      });
      g.add(group);
      frame(g, { az: 28, el: 18, pad: 1.15, targetYFrac: 0.5 });
    }
    return g;
  }
  if (name === 'fence') {
    const mats = makeMaterials('palace');
    // ㄱ자 담장 + 중간 일각문 개구부
    const pts = [{ x: -9, z: 5 }, { x: 9, z: 5 }, { x: 9, z: -5 }];
    const { group } = buildFence({
      points: pts, closed: false, height: 2.1, thickness: 0.46, seed: 7, mats,
      openings: [{ seg: 0, center: 0.5, width: 2.0 }],
    });
    g.add(group);
    frame(g, { az: 32, el: 20, pad: 1.2, targetYFrac: 0.5 });
    return g;
  }
  if (name.startsWith('gate')) {
    const type = name.includes('iljak') ? 'iljakmun' : 'soseuldaemun';
    const mats = makeMaterials('palace');
    const gate = buildGate(type, { mats, seed: 3, width: type === 'iljakmun' ? 1.5 : 2.6 });
    g.add(gate);
    // 양옆 담장 스텁
    const w = type === 'iljakmun' ? 1.1 : 3.4;
    const { group } = buildFence({
      points: [{ x: -12, z: 0 }, { x: 12, z: 0 }], closed: false, height: 2.1,
      thickness: 0.46, seed: 5, mats, openings: [{ seg: 0, center: 0.5, width: w * 2 + 0.6 }],
    });
    g.add(group);
    frame(g, { az: 26, el: 12, pad: 1.15, targetYFrac: 0.55 });
    return g;
  }
  // parcel-*
  const style = name.split('-')[1] || 'palace';
  const parcel = buildParcel({ seed: 20260716, style });
  g.add(parcel);
  frame(g, { az: 40, el: 32, pad: 1.15, targetYFrac: 0.28 });
  return g;
}

buildCase(CASE);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let frames = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  if (++frames === 3) window.__SHOT_READY = true;
});

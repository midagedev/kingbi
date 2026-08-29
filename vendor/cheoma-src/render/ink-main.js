// 수묵화 렌더 모드 독립 엔트리.
// 기존 빌더(buildBuilding)와 프리셋(PRESETS)을 읽기 전용으로 가져와 같은 건물을
// 세우고, 라이트·카메라는 먹 렌더에 맞춰 자체 세팅한 뒤 setupInk 파이프라인으로 그린다.
// shot 모드 URL 파라미터(shot/preset/angle)와 window.__SHOT_READY 신호는 index.html과 동일.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PRESETS, computeLayout } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import { setupInk, INK_PALETTE } from './ink.js';

const q = new URLSearchParams(location.search);
const SHOT = q.get('shot') === '1';
const presetKey = q.get('preset') || 'korea';
const angle = q.get('angle') || 'three-quarter';
if (SHOT) document.body.classList.add('shot');

const PAPER = new THREE.Color(INK_PALETTE.paper);

// ---------- 렌더러 ----------
// 먹 파이프라인이 색을 직접 만들므로 톤매핑은 끈다(OutputPass가 선형→sRGB만 담당).
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = PAPER.clone();
// 안개 = 여백: 원경을 종이색으로 수렴. 바닥 원반 가장자리(먼 거리)는 완전히
// 여백에 잠기고, 근경 건물은 또렷이 남는다. (먹 셰이더의 먹선 페이드와 같은 거리)
const FOG_NEAR = 38, FOG_FAR = 150;
scene.fog = new THREE.Fog(PAPER.clone(), FOG_NEAR, FOG_FAR);

// ---------- 빛 (먹 톤 분리용) ----------
// 강한 대비보다 부드러운 형태감. 검은 기와 지붕은 자연히 최농(적묵)이 되고,
// 벽·기단은 중담, 하늘·원경은 여백으로 수렴한다.
const sun = new THREE.DirectionalLight(0xfff4e6, 1.7);
sun.position.set(28, 40, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -24;
sun.shadow.bias = -0.0001;
sun.shadow.normalBias = 0.05;
scene.add(sun);
// 보조광을 낮춰 그림자·검은 기와가 깊은 적묵으로 남게 한다(인왕제색도의 농묵 덩어리).
scene.add(new THREE.HemisphereLight(0xf2ece0, 0x9c8f78, 0.72));
scene.add(new THREE.AmbientLight(0xffffff, 0.18));

// ---------- 마당 ----------
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(200, 64),
  new THREE.MeshStandardMaterial({ color: 0xd8cfbc, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- 건물 ----------
const P = { ...PRESETS[presetKey] };
const building = buildBuilding(P);
scene.add(building);

// ---------- 카메라 (index.html과 동일 앵글) ----------
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

function setAngle(name) {
  const L = computeLayout(P);
  const maxDim = Math.max(L.W + 4, L.D + 4, L.totalH);
  const target = new THREE.Vector3(0, L.totalH * 0.42, 0);
  const spots = {
    'front':          { az: 0,   el: 7,  r: 2.3 },
    'three-quarter':  { az: 38,  el: 13, r: 2.4 },
    'side':           { az: 90,  el: 8,  r: 2.3 },
    'roof':           { az: 42,  el: 36, r: 2.3 },
    'closeup':        { az: 42,  el: -12, r: 0.6, ty: L.plateY + 0.8 },
  };
  const s = spots[name] || spots['three-quarter'];
  if (s.ty !== undefined) target.y = s.ty;
  const az = (s.az * Math.PI) / 180, el = (s.el * Math.PI) / 180;
  const r = s.r * maxDim;
  camera.position.set(
    target.x + r * Math.cos(el) * Math.sin(az),
    target.y + r * Math.sin(el),
    target.z + r * Math.cos(el) * Math.cos(az)
  );
  controls.target.copy(target);
  controls.update();
}
setAngle(angle);

// ---------- 먹 파이프라인 ----------
// 먹선/여백 페이드를 씬 안개와 같은 월드 거리로 맞춘다.
const ink = setupInk(renderer, scene, camera, {
  uniforms: { fogNear: FOG_NEAR, fogFar: FOG_FAR },
});

// ---------- 루프 ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  ink.setSize(innerWidth, innerHeight);
});

let frames = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  ink.composer.render();
  frames++;
  if (frames === 3) window.__SHOT_READY = true; // 스크린샷 대기 신호
});

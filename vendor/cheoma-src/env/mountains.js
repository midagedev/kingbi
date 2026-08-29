import * as THREE from 'three';
import { makeRng } from '../rng.js';

// 각 능선 층: 방위각(0..2π)을 따라 정수 하모닉 합으로 만든 주기적 높이장.
// 정수 주파수라 360° 이음매가 자연스럽게 닫힌다.
function makeRidgeProfile(rng, octaves) {
  const harm = [];
  for (let o = 0; o < octaves; o++) {
    harm.push({
      freq: 2 + o * 3 + rng.int(0, 2),          // 정수 주파수 (주기성 보장)
      amp: Math.pow(0.62, o) * rng.range(0.7, 1.0),
      phase: rng.range(0, Math.PI * 2),
    });
  }
  let peak = 0;
  for (const h of harm) peak += h.amp;
  return (theta) => {
    let v = 0;
    for (const h of harm) v += h.amp * Math.sin(h.freq * theta + h.phase);
    // 봉우리를 살짝 뾰족하게: 상단을 강조 (0..1)
    const n = (v / peak) * 0.5 + 0.5;
    return Math.pow(n, 1.15);
  };
}

// 세로 실루엣 링(원통 벽). 상단 = 능선, 하단 = 지평 아래 스커트.
function buildRidgeLayer(radius, crestBase, crestSpan, profile, segments, snowUniform) {
  const skirtY = -40;
  const pos = [];
  const snowCap = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const th = t * Math.PI * 2;
    const x = Math.cos(th) * radius;
    const z = Math.sin(th) * radius;
    const ridge01 = profile(th);
    const topY = crestBase + ridge01 * crestSpan;
    const snowlineY = topY - Math.min(10, crestSpan * (0.13 + ridge01 * 0.08));
    pos.push(x, skirtY, z);      snowCap.push(0); // 하단
    pos.push(x, snowlineY, z);   snowCap.push(0); // 눈선 아래
    pos.push(x, topY, z);        snowCap.push(Math.min(1, Math.max(0, (ridge01 - 0.28) / 0.54)));
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSnowCap', new THREE.Float32BufferAttribute(snowCap, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMountainSnow = snowUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSnowCap;\nvarying float vSnowCap;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSnowCap = aSnowCap;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uMountainSnow;\nvarying float vSnowCap;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float cap = smoothstep(0.05, 0.78, vSnowCap) * uMountainSnow;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.91, 0.94), cap * 0.88);`);
  };
  mat.customProgramCacheKey = () => 'mountain-snow-cap-v1';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ridge';
  return { mesh, mat };
}

// 능선 사이 낮은 안개 띠 (인왕제색도/운해). 세로 알파 그라디언트 원통.
function makeMistTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  // 세로: 위·아래 투명 → 가운데 불투명
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.62, 'rgba(255,255,255,1)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0.55)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 128);
  // 가로 밀도 변화 (구름 덩어리 느낌)로 군데군데 옅게
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 512;
    const y = 20 + Math.random() * 70;
    const rr = 24 + Math.random() * 60;
    const rg = g.createRadialGradient(x, y, 0, x, y, rr);
    rg.addColorStop(0, `rgba(0,0,0,${0.15 + Math.random() * 0.3})`);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(4, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildMistBand(radius, yCenter, halfHeight, tex) {
  const geo = new THREE.CylinderGeometry(radius, radius, halfHeight * 2, 96, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, side: THREE.DoubleSide,
    depthWrite: false, fog: true, opacity: 0.85,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = yCenter;
  mesh.name = 'mist';
  mesh.renderOrder = 2;
  return { mesh, mat };
}

// 겹겹 능선 + 안개 띠. setPalette로 시간대별 대기원근 색을 갈아끼운다.
export function buildMountains({ seed = 91117 } = {}) {
  const group = new THREE.Group();
  group.name = 'mountains';

  // [반경, 능선 하단 높이, 능선 진폭, 옥타브] — 멀수록 높고 완만
  const specs = [
    { r: 168, base: 12, span: 26, oct: 6 },
    { r: 232, base: 20, span: 34, oct: 5 },
    { r: 305, base: 30, span: 46, oct: 5 },
    { r: 388, base: 44, span: 60, oct: 4 },
    { r: 470, base: 60, span: 80, oct: 4 },
  ];
  const layers = [];
  const snowUniform = { value: 0 };
  specs.forEach((s, i) => {
    const rng = makeRng(seed + i * 1013);
    const profile = makeRidgeProfile(rng, s.oct);
    const L = buildRidgeLayer(s.r, s.base, s.span, profile, 160, snowUniform);
    L.mesh.renderOrder = -10 + i;      // 가까운 층이 나중(위)에
    group.add(L.mesh);
    layers.push(L);
  });

  const mistTex = makeMistTexture();
  const mists = [
    buildMistBand(190, 26, 18, mistTex),
    buildMistBand(300, 44, 24, mistTex.clone()),
  ];
  mists.forEach((m) => group.add(m.mesh));

  // near/far 색 사이를 층별로 보간 (대기원근). mist 색·투명도도 함께.
  function setPalette(nearHex, farHex, mistHex, mistOpacity) {
    const near = new THREE.Color(nearHex);
    const far = new THREE.Color(farHex);
    layers.forEach((L, i) => {
      const t = layers.length > 1 ? i / (layers.length - 1) : 0;
      L.mat.color.copy(near).lerp(far, t);
    });
    const mc = new THREE.Color(mistHex);
    mists.forEach((m, i) => {
      m.mat.color.copy(mc);
      m.mat.opacity = mistOpacity * (i === 0 ? 1 : 0.85);
    });
  }

  function setSnow(amount) {
    snowUniform.value = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount * 0.72 : 0));
  }

  return { group, setPalette, setSnow };
}

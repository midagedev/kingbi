import * as THREE from 'three';
import { KOREA_COLORS, TILE_LOOK } from './material-colors.js';
import {
  CLOUD_SHADOW_FRAG_DECL, CLOUD_SHADOW_FRAG_BODY,
  CLOUD_SHADOW_VERT_DECL, CLOUD_SHADOW_VERT_BODY,
} from '../env/clouds.js';
import {
  dancheongSourceKey,
  paintDancheongSource,
  resolveDancheong,
} from './dancheong.js';
import {
  MATERIAL_PROGRAM_PATCH,
  addMaterialProgramKey,
} from '../render/material-program-key.js';
import { patchLodScreenDoorMaterial } from '../render/lod-screen-door.js';
import { createPaletteContext } from './palette-context.js';

export { createPaletteContext };

// Module-active palette context. Product path keeps browser defaults
// (document.createElement('canvas') + Math.random). Node gates inject both;
// village seed windows only swap the RNG via setTextureRandom.
// Per-call override: makeMaterials(..., { paletteContext }) temporarily installs
// a context for that build, then restores the previous active context.
let _activeContext = createPaletteContext();

export function getPaletteContext() {
  return _activeContext;
}

/** Install a context, or reset to browser defaults when given null/invalid. */
export function setPaletteContext(ctx) {
  _activeContext = (ctx
    && typeof ctx.random === 'function'
    && typeof ctx.createCanvas === 'function')
    ? ctx
    : createPaletteContext();
}

/** Resolve optional per-call context; null/undefined → module-active context. */
export function resolvePaletteContext(ctx) {
  return (ctx
    && typeof ctx.random === 'function'
    && typeof ctx.createCanvas === 'function')
    ? ctx
    : _activeContext;
}

// Thin back-compat wrapper: only swaps the active context's RNG while preserving
// the installed createCanvas. setTextureRandom(null) restores Math.random.
export function setTextureRandom(fn) {
  _activeContext = createPaletteContext({
    random: typeof fn === 'function' ? fn : Math.random,
    createCanvas: _activeContext.createCanvas,
  });
}

function _texRand() {
  return _activeContext.random();
}

function _createCanvas() {
  return _activeContext.createCanvas();
}

// 하위호환 공개 export. 실제 토큰은 THREE 비의존 모듈에 두어 원경 프록시와 공유한다.
export { KOREA_COLORS };

// 기와 지붕 텍스처: 기왓등·기왓골 세로 줄 + 가로 겹침 라인 (온기 있는 회흑).
// #150 item I: 홈 seam 대비를 낮춰 망원에서 서브픽셀 검은 선으로 뭉치지 않게 한다.
// 근경 기왓골 가독은 bump + 기하 수키와가 담당 — 텍스처 순흑 홈에 의존하지 않는다.
function makeTileTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0.0, '#4a4d54');
  grad.addColorStop(0.18, '#5a5d64');
  grad.addColorStop(0.5, '#666970');   // 기왓등 하이라이트 (과대비 억제)
  grad.addColorStop(0.82, '#5a5d64');
  grad.addColorStop(1.0, '#4a4d54');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  // 겹침 홈: 낮은 alpha·높은 floor — 과거 순흑 50% 홈은 망원에서 검은 줄 뭉침.
  g.fillStyle = 'rgba(48,50,56,0.32)';
  for (let y = 0; y < 256; y += 64) g.fillRect(0, y, 256, 5);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let y = 8; y < 256; y += 64) g.fillRect(0, y, 256, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 창호 텍스처(궁): 붉은 문틀 + 초록 빗꽃살(대각 마름모 그물) + 밝은 한지, 하단 초록 청판.
// 근정전 실물 창호는 밝은 창호지 위 초록 살이 대각으로 교차한 마름모 문양이라, 살 사이로 빛이
// 투과하듯 밝게 읽혀야 한다(구 버전: 어두운 한지 + 촘촘한 직교 정자살 → 역광·그늘서 진흙빛으로 뭉갬).
function makeDoorTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#f2ecda';                       // 밝은 한지(살 사이 광명)
  g.fillRect(0, 0, 256, 512);
  const top = 416;                               // 하단 청판 시작
  // 빗꽃살: 45° 두 방향 살이 교차 → 마름모 그물. 밝은 한지 위라 마름모 안이 흰 빛으로 남는다.
  g.save();
  g.beginPath(); g.rect(0, 0, 256, top); g.clip();
  g.strokeStyle = '#50704e'; g.lineWidth = 5;
  const d = 26;
  for (let k = -512; k < 512; k += d) {          // ╲ 방향
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 512, 512); g.stroke();
  }
  for (let k = 0; k < 1024; k += d) {            // ╱ 방향
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k - 512, 512); g.stroke();
  }
  g.restore();
  // 하단 청판 (초록 널)
  g.fillStyle = '#4e6b52';
  g.fillRect(10, top + 4, 236, 512 - top - 12);
  g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 4;
  g.strokeRect(10, top + 4, 236, 512 - top - 12);
  // 붉은 문틀(주칠) — 얇게(살 문양이 죽지 않게)
  g.strokeStyle = '#7d4030'; g.lineWidth = 20;
  g.strokeRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 정자살문(살림집): 궁궐 문살의 주칠·뇌록을 재사용하지 않고 백골 목재와 한지만 쓴다.
// 패턴 이름은 격자 짜임을 뜻하며 건물의 장식 위계까지 뜻하지 않는다.
function makeCivilianJeongjaTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e8dec5';
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = '#6a4930'; g.lineWidth = 6;
  for (let x = 20; x <= 236; x += 27) {
    g.beginPath(); g.moveTo(x, 8); g.lineTo(x, 502); g.stroke();
  }
  for (let y = 22; y <= 500; y += 31) {
    g.beginPath(); g.moveTo(7, y); g.lineTo(249, y); g.stroke();
  }
  g.strokeStyle = '#563923'; g.lineWidth = 20;
  g.strokeRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 단청 source는 불변 Canvas로 캐시하고 Texture/Material 소유권은 각 팔레트에 둔다. 따라서
// 서로 다른 궁·사찰이 동시에 있어도 한쪽의 슬라이더가 다른 쪽 픽셀을 바꾸지 않으며, 개별 건물
// dispose가 다른 팔레트의 texture를 끊지 않는다. 8구간(9레벨)×2축은 충분히 연속적으로 보이되 LRU가
// 에이전트의 반복 편집 세션에서 source 참조를 무한히 쌓지 않게 한다.
const DANCHEONG_SOURCE_CACHE_MAX = 96;
const dancheongSourceCache = new Map();

function dancheongSource(kind, config) {
  const key = dancheongSourceKey(config, kind);
  const hit = dancheongSourceCache.get(key);
  if (hit) {
    dancheongSourceCache.delete(key);
    dancheongSourceCache.set(key, hit);
    return hit;
  }
  const canvas = _createCanvas();
  canvas.width = kind === 'band' ? 512 : 64;
  canvas.height = 64;
  paintDancheongSource(canvas, kind, config);
  dancheongSourceCache.set(key, canvas);
  while (dancheongSourceCache.size > DANCHEONG_SOURCE_CACHE_MAX) {
    dancheongSourceCache.delete(dancheongSourceCache.keys().next().value);
  }
  return canvas;
}

function makeDancheongTexture(kind, config) {
  const tex = new THREE.CanvasTexture(dancheongSource(kind, config));
  if (kind === 'band') tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.dancheongSourceKey = dancheongSourceKey(config, kind);
  return tex;
}

export function dancheongSourceCacheStats() {
  return { size: dancheongSourceCache.size, max: DANCHEONG_SOURCE_CACHE_MAX };
}

// 합각/박공면. 'palace' = 붉은 세로 널, 'temple' = 노출 가구(가로 도리 + 황토 패널).
function makeGableTexture(style = 'palace') {
  const c = _createCanvas();
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  if (style === 'temple') {
    // 수덕사 박공: 노출된 도리·인방(붉은 목재 가로선) + 황토 패널
    g.fillStyle = '#c29a5c';                      // 황토 패널 바탕
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#7d3f2c';                       // 붉은 목재 가로 부재
    for (let y = 8; y < 128; y += 24) g.fillRect(0, y, 256, 9);
    g.fillStyle = 'rgba(40,22,16,0.35)';
    for (let y = 8; y < 128; y += 24) g.fillRect(0, y + 9, 256, 2);
  } else {
    g.fillStyle = '#8a4634';
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = 'rgba(40,22,16,0.55)'; g.lineWidth = 3;
    for (let x = 14; x < 256; x += 18) {          // 세로 널 이음선
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke();
    }
    g.fillStyle = 'rgba(232,228,216,0.5)';        // 백색 긋기 힌트
    g.fillRect(0, 60, 256, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 황토벽: 미장 질감의 흙벽(절). 은은한 얼룩으로 흙손 자국을 흉내.
function makeHwangtoTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9a06a';
  g.fillRect(0, 0, 256, 256);
  // 얼룩(미장 흙손): 밝고 어두운 붓질을 무작위로 겹침
  for (let i = 0; i < 120; i++) {
    const x = _texRand() * 256, y = _texRand() * 256;
    const r = 10 + _texRand() * 40;
    const dark = _texRand() < 0.5;
    g.fillStyle = dark ? 'rgba(150,112,64,0.10)' : 'rgba(214,180,128,0.12)';
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, _texRand() * Math.PI, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 띠살문(절): 목재색 살 + 한지. 세로살 위주에 가로살은 성기게.
function makeTtisalTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e7ddc4';                        // 한지
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = '#6b4a2e';                       // 목재색 살
  g.lineWidth = 7;
  for (let x = 24; x <= 232; x += 33) {           // 세로살 (간격 1.5배로 과밀 해소)
    g.beginPath(); g.moveTo(x, 12); g.lineTo(x, 500); g.stroke();
  }
  g.lineWidth = 6;
  for (let y = 40; y <= 500; y += 40) {           // 가로살 (격자 밀도 상향)
    g.beginPath(); g.moveTo(6, y); g.lineTo(250, y); g.stroke();
  }
  g.strokeStyle = '#5a3d24'; g.lineWidth = 12;     // 굵은 띠(중간 3줄) 강조
  for (const y of [60, 256, 452]) {
    g.beginPath(); g.moveTo(6, y); g.lineTo(250, y); g.stroke();
  }
  g.lineWidth = 22;                                // 문틀
  g.strokeRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 세살문(반가 상급): 촘촘한 세로살 + 상부에만 성근 가로살 + 하단 넓은 목재 청판. 정자살(격자)·
// 띠살(굵은 띠)과 구별되는 "세로살 지배" 창호. 민가이므로 궁궐 주칠·뇌록은 쓰지 않는다.
function makeSesalTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#e9dfc8';                        // 한지
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = '#6b4a2e'; g.lineWidth = 6;      // 백골 목재 살
  for (let x = 16; x <= 240; x += 15) {           // 촘촘한 세로살(세살)
    g.beginPath(); g.moveTo(x, 6); g.lineTo(x, 404); g.stroke();
  }
  for (let y = 24; y <= 150; y += 34) {           // 상부에만 성근 가로살
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  g.fillStyle = '#765537';                         // 하단 목재 청판(넓게)
  g.fillRect(10, 408, 236, 98);
  g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 4; g.strokeRect(10, 408, 236, 98);
  g.strokeStyle = '#563923'; g.lineWidth = 26;     // 백골 목재 문틀
  g.strokeRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 초가 띠살문: 미색 한지 + 가늘고 성근 살 (감옥 격자 탈피, 세로 비례).
function makeChogaDoorTexture() {
  const c = _createCanvas();
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e0d5b8';                          // 미색 한지(톤 다운)
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#6b4a2e'; g.lineWidth = 3;       // 가는 살
  for (let x = 22; x <= 106; x += 28) {             // 세로살 (성글게)
    g.beginPath(); g.moveTo(x, 8); g.lineTo(x, 248); g.stroke();
  }
  for (const y of [64, 132, 200]) {                 // 가로살 3줄(띠)
    g.beginPath(); g.moveTo(6, y); g.lineTo(122, y); g.stroke();
  }
  g.strokeStyle = '#5a3d24'; g.lineWidth = 10;       // 가는 문틀
  g.strokeRect(0, 0, 128, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 살창(절): 세로 나무 창살 사이로 어두운 실내가 비치는 붙박이 창.
function makeSalchangTexture() {
  const c = _createCanvas();
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#241d16';                         // 어두운 실내
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#6b4a2e';                         // 세로 창살 (간격 1.5배)
  for (let x = 10; x < 118; x += 21) g.fillRect(x, 6, 6, 116);
  g.strokeStyle = '#4a3320'; g.lineWidth = 12;     // 창틀
  g.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 풍판(절): 박공 아래 세로 널빤지 벽.
function makePungpanTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#997048';                         // 목재(밝은 갈색)
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = 'rgba(60,38,18,0.55)'; g.lineWidth = 3;
  for (let x = 12; x < 256; x += 20) {            // 세로 널 이음선
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke();
  }
  g.strokeStyle = 'rgba(255,240,220,0.12)'; g.lineWidth = 2;
  for (let x = 14; x < 256; x += 20) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 볏짚 지붕(초가): 내리방향 짚결이 지배적인 이엉 질감(회백~회갈, 묵은 은회색).
// 집줄(새끼 그물)은 roof.js가 3D 튜브로 얹으므로 여기선 짚결·색편차만 담당(3D 그물과 이중 방지).
// 수평 밴드는 배제 — 경사면에서 등고선 단으로 읽히던 결함 방지.
// 볏짚 이엉 텍스처. age ∈ [0,1]: 0=갓 이은 금빛 → 0.5=한두 해 바랜 황갈 → 1=오래된 회갈(이끼·얼룩).
//   마을 뷰에서 "잘 관리된 집 vs 낡은 집" 이 은근히 읽히도록 상태를 색·얼룩 밀도로 표현.
//   age 미지정 시 0.5(기존 룩 근사) — 하위호환.
export function makeThatchTexture(age = 0.5) {
  const a = Math.max(0, Math.min(1, age));
  const mix = (u, v) => Math.round(u + (v - u) * a);
  const c = _createCanvas();
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  // 바탕: 밝은 금빛(fresh) → 어두운 회갈(old). UV v=경사방향 → canvas y가 내리방향.
  g.fillStyle = `rgb(${mix(0xd6, 0x74)},${mix(0xb4, 0x70)},${mix(0x60, 0x64)})`;
  g.fillRect(0, 0, 256, 256);
  // 색 편차 패치(결 방향 길쭉). 노후일수록 어두운/이끼 얼룩↑, 신선일수록 밝은 금빛↑.
  const patches = 80 + Math.round(a * 60);
  for (let i = 0; i < patches; i++) {
    const x = _texRand() * 256, y = _texRand() * 256, r = 9 + _texRand() * 30;
    const t = _texRand();
    // 신선: 금빛 하이라이트 / 노후: 회갈·암갈
    const fresh = `rgba(${mix(206, 150)},${mix(182, 138)},${mix(118, 100)},0.12)`;
    const dark = `rgba(${mix(150, 96)},${mix(140, 90)},${mix(116, 74)},${0.11 + a * 0.08})`;
    g.fillStyle = t < 0.5 ? dark : fresh;
    g.beginPath(); g.ellipse(x, y, r * 0.55, r * 1.5, 0, 0, Math.PI * 2); g.fill();
  }
  // 노후 이끼·물얼룩(age>0.4): 초록끼 도는 어두운 반점 — 북사면 이끼·빗물 자국.
  if (a > 0.4) {
    const moss = Math.round((a - 0.4) * 180);
    for (let i = 0; i < moss; i++) {
      const x = _texRand() * 256, y = _texRand() * 256, r = 6 + _texRand() * 20;
      g.fillStyle = `rgba(${70 + _texRand() * 26},${84 + _texRand() * 30},${52 + _texRand() * 18},${0.12 + (a - 0.4) * 0.42})`;
      g.beginPath(); g.ellipse(x, y, r * 0.7, r * 1.25, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // 내리방향(경사) 짚결 — 지배적, 길고 촘촘한 세로 스트로크.
  for (let i = 0; i < 900; i++) {
    const x = _texRand() * 256, y = _texRand() * 256, len = 22 + _texRand() * 56;
    const t = _texRand();
    const darkStroke = `rgba(${mix(84, 60)},${mix(74, 52)},${mix(52, 38)},${0.26 + a * 0.08})`;
    const litStroke = `rgba(${mix(210, 150)},${mix(196, 140)},${mix(150, 104)},0.28)`;
    g.strokeStyle = t < (0.42 + a * 0.18) ? darkStroke : litStroke;
    g.lineWidth = 0.8 + _texRand() * 1.3;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (_texRand() - 0.5) * 2.0, y + len); g.stroke();
  }
  // 처마 쪽(하단) 썰린 짚 끝 — 밝게 흩뿌려 겹겹이 쌓인 하단부 강조(신선일수록 밝음).
  for (let i = 0; i < 120; i++) {
    const x = _texRand() * 256, y = 176 + _texRand() * 80, len = 6 + _texRand() * 12;
    g.strokeStyle = `rgba(${mix(212, 156)},${mix(198, 148)},${mix(160, 112)},0.26)`; g.lineWidth = 1.0;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (_texRand() - 0.5) * 1.5, y + len); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 이미 만들어진 초가 재질셋(buildBuilding 산출)의 이엉 상태를 age 로 후처리한다(빌더 코어 불침해).
//   thatch 맵을 age 텍스처로 교체 + 용마름·집줄 색을 노후 정도로 어둡게. 프로토/편집 경로 공용.
export function applyThatchAge(M, age) {
  if (!M) return;
  const a = Math.max(0, Math.min(1, age));
  const lerp = (u, v) => u + (v - u) * a;
  if (M.thatch) {
    M.thatch.map?.dispose?.();
    M.thatch.map = makeThatchTexture(a);
    if (M.thatch.emissiveMap) M.thatch.emissiveMap = M.thatch.map;
    // 색틴트: 신선=따뜻한 금빛, 노후=차분한 회색끼 — 대비 증폭.
    M.thatch.color.setRGB(lerp(1.04, 0.9), lerp(1.0, 0.92), lerp(0.9, 0.94));
    // emissive: 신선일수록 따뜻·밝게(해 안 드는 사면 보정), 노후일수록 어둡고 차갑게.
    M.thatch.emissive.setRGB(lerp(0.15, 0.07), lerp(0.11, 0.08), lerp(0.05, 0.07));
    M.thatch.needsUpdate = true;
  }
  const darken = 1 - a * 0.24;                 // 용마름·집줄 새끼도 노후일수록 탈색·어둠
  M.yongmaru?.color.multiplyScalar(darken);
  M.jipjul?.color.multiplyScalar(darken);
}

// 창호 살 패턴 교체(#55): M.door 텍스처를 살 패턴으로 갈아끼운다(빌더 코어 불침해). buildBuilding 이
//   makeMaterials 직후·부재 조립 전에 호출 → 문짝 클론(map.clone())이 새 패턴을 물려받는다.
//   pattern: 'jeongja'(정자살) | 'ttisal'(띠살) | 'sesal'(세살) | 'choga'(초가 띠살).
export function applyDoorPattern(M, pattern) {
  if (!M || !M.door || !pattern) return;
  const tex = pattern === 'jeongja' ? makeCivilianJeongjaTexture()
    : pattern === 'sesal' ? makeSesalTexture()
    : pattern === 'ttisal' ? makeTtisalTexture()
    : pattern === 'choga' ? makeChogaDoorTexture()
    : null;
  if (!tex) return;
  M.door.map?.dispose?.();
  M.door.map = tex;
  M.door.needsUpdate = true;
}

// 막돌 텍스처 한 타일이 덮는 월드 면적(m). 256×128 캔버스가 이 치수를 덮으므로 픽셀은 월드에서
//   정사각(6.25mm)이고, 돌 하나(지름 16~64px)는 0.10~0.40m — 전형 20~35cm에 든다. 소비처는 담·기단의
//   실치수를 이 값으로 나눠 UV(또는 repeat)를 정해야 한다. 안 그러면 한 타일이 담 한 면 전체로 늘어나
//   돌이 가로로 늘어난 대형 물방울로 읽힌다(docs/architectural-authenticity.md §7.5 W3).
export const FIELDSTONE_TILE = Object.freeze({ w: 1.6, h: 0.8 });

// 막돌 기단·화방벽(초가): 크기가 제각각인 각진 자연석을 흙 줄눈으로 물려 쌓은 거친 돌벽 질감.
function makeFieldstoneTexture() {
  const c = _createCanvas();
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#786951';                          // 흙 줄눈(모르타르) 바탕 — 돌과 명도차를 벌린다
  g.fillRect(0, 0, 256, 128);
  // 각진 막돌 윤곽. 다각형 꼭짓점 지터는 돌 인덱스 해시에서 파생해 _texRand 소비 횟수를 돌당 6회로
  //   보존한다(시드 창을 공유하는 담·소품 스트림 불변 = worker/sync 씬 골든 계약).
  const facet = (i, k) => {
    const h = Math.imul(i * 73856093 ^ k * 19349663, 0x27d4eb2d) >>> 0;
    return h / 0x100000000;
  };
  for (let i = 0; i < 90; i++) {
    const x = _texRand() * 256, y = _texRand() * 128;
    const rw = 10 + _texRand() * 22, rh = 8 + _texRand() * 16;
    const v = 150 + Math.round(_texRand() * 45);
    const rot = _texRand() * 0.6 - 0.3;
    const sides = 6 + (Math.imul(i, 2654435761) >>> 29) % 3;   // 6~8각(모서리가 살아 있는 자연석)
    g.beginPath();
    for (let k = 0; k <= sides; k++) {
      const a = rot + (k / sides) * Math.PI * 2;
      const rk = 0.74 + facet(i, k % sides) * 0.4;             // 반경 요동 → 불규칙 각석
      const px = x + Math.cos(a) * rw * rk, py = y + Math.sin(a) * rh * rk;
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = `rgb(${v + 8},${v - 4},${v - 28})`; // 온기 도는 자연석(황갈)
    g.fill();
    g.strokeStyle = 'rgba(44,35,24,0.62)'; g.lineWidth = 2.1; g.stroke();  // 돌 사이 흙 줄눈 그늘
    g.fillStyle = 'rgba(255,250,238,0.13)';          // 위로 향한 면(층이 세로로도 읽히게)
    g.beginPath(); g.ellipse(x, y - rh * 0.42, rw * 0.62, rh * 0.26, rot, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 용마름 롤 텍스처: 볏짚 결 + 새끼줄(집줄) 감김을 어두운 갈색 띠로 그린다.
// 실린더 UV에서 u=둘레(canvas x), v=길이(canvas y). 둘레 전체를 감는 띠 = 가로 밴드(canvas x 전폭).
// repeat.y를 롤 길이에 맞춰 여러 개로 타일링(호출부). 3D 돌기 없이 표면 밀착.
function makeYongmaruTexture() {
  const c = _createCanvas();
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#83765c';                          // 묵은 이엉 회갈(용마름은 지붕보다 살짝 짙게)
  g.fillRect(0, 0, 64, 64);
  // 엮은(헤링본) 볏짚 덮개: TubeGeometry UV u=둘레(canvas x)·v=길이(canvas y).
  // 능선 길이(canvas y)를 따라 ∧자 엮음을 층층이 쌓아 "길게 엮인 용마름"으로 읽히게 한다.
  const rows = 7;                                    // 길이 방향 엮음 층
  for (let r = 0; r < rows; r++) {
    const y0 = (r / rows) * 64;
    const yc = y0 + 64 / rows * 0.5;
    // 어두운 엮음 골(∧ 꼭짓점이 중앙, 양끝이 아래)
    g.strokeStyle = 'rgba(52,42,26,0.62)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, yc + 6); g.lineTo(32, y0 + 1); g.lineTo(64, yc + 6); g.stroke();
    // 밝은 짚 다발 하이라이트(엮음 위로 눌린 볏짚)
    g.strokeStyle = 'rgba(200,188,152,0.5)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, yc + 3); g.lineTo(32, y0 - 2); g.lineTo(64, yc + 3); g.stroke();
  }
  // 세로(둘레) 눌림 새끼줄 몇 가닥 — 용마름을 능선에 동여맨 자국
  g.strokeStyle = 'rgba(58,48,30,0.35)'; g.lineWidth = 1.4;
  for (let x = 8; x < 64; x += 20) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 64); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 수막새 와당: 처마 끝 수키와 원형 드림새. 진회 기와 바탕 + 연꽃 문양(주연부 구슬).
function makeWadangTexture() {
  const c = _createCanvas();
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const cx = 64, cy = 64;
  g.fillStyle = '#3f4249'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#565961'; g.beginPath(); g.arc(cx, cy, 60, 0, Math.PI * 2); g.fill(); // 와당 면
  // 주연부(테두리) 구슬
  g.fillStyle = '#3a3d43';
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.beginPath(); g.arc(cx + Math.cos(a) * 54, cy + Math.sin(a) * 54, 3, 0, Math.PI * 2); g.fill(); }
  // 연꽃 8판
  g.fillStyle = '#6b6e76';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.save(); g.translate(cx, cy); g.rotate(a);
    g.beginPath(); g.ellipse(0, -30, 12, 22, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.fillStyle = '#787b83'; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fill(); // 씨방
  g.fillStyle = '#4a4d53';
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.beginPath(); g.arc(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6, 2, 0, Math.PI * 2); g.fill(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 적새: 용마루/마루 옆면에 겹쳐 쌓은 암키와 켜(가로 줄). 마루가 "쌓아 올린 것"으로 읽히게.
function makeJeoksaeTexture() {
  const c = _createCanvas();
  c.width = 32; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#43464c'; g.fillRect(0, 0, 32, 128);
  for (let y = 6; y < 128; y += 20) {           // 켜마다: 위 하이라이트 + 아래 그림자 홈
    g.fillStyle = 'rgba(120,124,132,0.5)'; g.fillRect(0, y, 32, 3);
    g.fillStyle = 'rgba(20,21,25,0.55)'; g.fillRect(0, y + 15, 32, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 와구토: 막새 대신 기와골 끝 수키와에 회(灰)물림 한 흰 반달(반가 격식). 처마 끝에 한 골당 하나.
// 처마 스트립(u=처마방향, v=상하)에 매핑. 한 반복 = 한 기왓등 끝의 흰 반달.
function makeWagutoTexture() {
  const c = _createCanvas();
  c.width = 48; c.height = 48;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3d43';                          // 처마 끝 기와 그늘
  g.fillRect(0, 0, 48, 48);
  g.fillStyle = '#ece7db';                          // 흰 회물림 반달(아래로 볼록)
  g.beginPath(); g.arc(24, 4, 17, 0, Math.PI); g.fill();
  g.fillStyle = 'rgba(120,108,86,0.28)';            // 반달 하단 음영(입체감)
  g.beginPath(); g.arc(24, 4, 17, Math.PI * 0.12, Math.PI * 0.88); g.fill();
  g.fillStyle = 'rgba(255,252,244,0.6)';            // 반달 상단 하이라이트
  g.fillRect(8, 3, 32, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 전돌 굴뚝: 회흑 전돌을 켜쌓기(엇쌓기) 한 벽돌 질감 + 회줄눈.
function makeJeondolTexture() {
  const c = _createCanvas();
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#6a625a';                          // 회줄눈(모르타르) 바탕
  g.fillRect(0, 0, 128, 128);
  const bh = 16, bw = 32;                            // 전돌 한 장
  for (let row = 0, y = 0; y < 128; y += bh, row++) {
    const off = (row % 2) * (bw / 2);               // 엇쌓기 오프셋
    for (let x = -bw; x < 128 + bw; x += bw) {
      const bx = x + off + 1.5, by = y + 1.5, w = bw - 3, h = bh - 3;
      // 전돌 낱장: 회흑 바탕 + 미세 색편차
      const t = ((row * 7 + x) % 5) / 5;
      const cval = 62 + Math.round(t * 16);
      g.fillStyle = `rgb(${cval},${cval - 4},${cval - 8})`;
      g.fillRect(bx, by, w, h);
      g.fillStyle = 'rgba(255,255,255,0.05)';       // 윗면 하이라이트
      g.fillRect(bx, by, w, 2);
      g.fillStyle = 'rgba(0,0,0,0.22)';             // 아랫면 그늘
      g.fillRect(bx, by + h - 2, w, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 우물마루: 손 탄 반질한 갈색 마루널 + 井자 장귀틀 격자.
function makeMaruTexture() {
  const c = _createCanvas();
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7a5a38'; g.fillRect(0, 0, 128, 128);
  // 마루널 결(세로) + 널 이음
  for (let i = 0; i < 100; i++) {
    const x = _texRand() * 128, y = _texRand() * 128, len = 8 + _texRand() * 20;
    g.strokeStyle = _texRand() < 0.5 ? 'rgba(60,42,24,0.25)' : 'rgba(150,120,80,0.22)';
    g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + len); g.stroke();
  }
  // 井자 장귀틀(굵은 격자)
  g.strokeStyle = 'rgba(44,30,16,0.55)'; g.lineWidth = 5;
  for (let p = 0; p <= 128; p += 64) { g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 128); g.stroke(); g.beginPath(); g.moveTo(0, p); g.lineTo(128, p); g.stroke(); }
  // 널 이음(가는 세로선)
  g.strokeStyle = 'rgba(44,30,16,0.3)'; g.lineWidth = 1.5;
  for (let x = 16; x < 128; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const standard = (color, roughness = 0.85, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.0, ...extra });

function dancheongMaterials(style, input) {
  const config = resolveDancheong(style, input);
  if (!config) return null;
  const temple = style === 'temple';
  return {
    dancheong: config,
    beamDancheong: standard(0xffffff, 0.86, { map: makeDancheongTexture('band', config) }),
    bracket: standard(temple ? 0x526f5e : KOREA_COLORS.noerok, 0.85),
    bracketAlt: standard(temple ? 0x98533f : KOREA_COLORS.juhong, 0.85),
    bracketFace: standard(0xffffff, 0.85, { map: makeDancheongTexture('face', config) }),
    yeonmokcho: standard(0xffffff, 0.85, { map: makeDancheongTexture('round', config) }),
    bujeoncho: standard(0xffffff, 0.85, { map: makeDancheongTexture('square', config) }),
    rafter: standard(temple ? 0x526f5e : KOREA_COLORS.noerok, 0.85),
    rafterEnd: standard(temple ? 0xd2c7ad : KOREA_COLORS.baek, 0.8),
    accentBlue: standard(KOREA_COLORS.samcheong, 0.85),
  };
}

// 한 컴파운드 안의 격식 위계용 얕은 팔레트. 비단청 리소스는 base를 그대로 빌리고,
// 단청 9재질/4텍스처만 이 변형이 소유한다. 프로그램 종류는 MeshStandard 하나로 불변이다.
export function makeDancheongVariant(base, input) {
  const variation = dancheongMaterials(base?.style, input);
  if (!variation) return base;
  const palette = { ...base, ...variation };
  tagRoles(palette);
  return palette;
}

// style: 'palace'(궁·다포) | 'temple'(절·주심포) | 'choga'(민가·볏짚) | 'giwa'(반가·기와). 벽·창호·재료 계열을 바꾼다.
// options.paletteContext: optional per-build canvas/RNG provider. Null/absent keeps the
// module-active context (product shared materials path unchanged).
export function makeMaterials(style = 'palace', options = {}) {
  const prevContext = _activeContext;
  const injected = options.paletteContext;
  if (injected) _activeContext = resolvePaletteContext(injected);
  try {
    return buildMaterials(style, options);
  } finally {
    if (injected) _activeContext = prevContext;
  }
}

function buildMaterials(style, options) {
  const C = KOREA_COLORS;
  const temple = style === 'temple';
  const choga = style === 'choga';
  // 'hanok'(히어로 종가·반가 안채, parcel.js 전용 스타일)도 giwa 백골 팔레트를 쓴다.
  //   (#139) 종전엔 'hanok' 이 어느 분기도 안 걸려 궁 기본값(석간주 붉은 기둥·회색 회벽)으로
  //   폴백 → 반가가 궁 목재 톤으로 렌더됐다. 마을 인스턴스는 makeMaterials('giwa') 별경로라 불침해.
  const giwa = style === 'giwa' || style === 'hanok';
  const std = standard;
  const dancheong = dancheongMaterials(style, options);

  // 벽: 회벽(궁) / 황토벽(절) / 심벽 회백(초가) / 흰 회벽(기와집 반가)
  const wallMat = temple
    ? std(0xffffff, 0.96, { map: makeHwangtoTexture() })
    : choga
      ? std(0xc9ad84, 0.98, { emissive: 0x322717 }) // 심벽 흙벽(밝은 황토빛 + emissive로 그늘진 측벽도 solid)
      : giwa
        ? std(0xe0dccb, 0.95, { emissive: 0x2e2a22 }) // 반가 흰 회벽(역광면도 밝게)
        : std(C.plaster, 0.95);
  // 정면 창호: 정자살문(궁) / 띠살문(절·기와집) / 가는 미색 띠살(초가)
  const doorMat = std(0xffffff, 0.9, {
    map: choga ? makeChogaDoorTexture() : (temple || giwa) ? makeTtisalTexture() : makeDoorTexture(),
  });
  // 한지 창(민무늬 광창) · 살창(절·기와 측벽)
  const hanjiMat = std(C.hanji, 0.95);
  const salchangMat = std(0xffffff, 0.85, { map: makeSalchangTexture() });
  // ── #66 야간 창호 발광 마스크: 한지 바른 창·문 재질에 "단위면적 발광 계수"를 태그. ──
  //   호롱불·등잔 시대감(저광량). 문(門)은 창호지 면적이 커 창보다 계수를 낮춰 총광량 균형.
  //   문짝은 walls.js/giwa.js 에서 per-mesh clone(M.door.clone) 되지만 Material.copy 가 userData 를
  //   깊은 복사하므로 태그가 클론에 전파 → night-glow.js·adapter.js 가 traverse 로 창·문을 일괄 식별.
  //   role 태그(instanceColor)와 독립된 필드라 마을 색 변주에 불침해.
  doorMat.userData.hanjiGlow = 0.18;
  hanjiMat.userData.hanjiGlow = 0.26;
  salchangMat.userData.hanjiGlow = 0.11;
  // 기단 석재: 절·초가·기와집은 자연석. 초가는 황갈 온기.
  const stoneCol = choga ? 0xaa9878 : (temple || giwa) ? 0xa79f8f : C.stone;
  const stoneDarkCol = choga ? 0x877559 : (temple || giwa) ? 0x847c6c : C.stoneDark;

  // 목재 톤: 궁 석간주 / 절 무단청 / 초가 어두운 고재 / 기와집 백골(회갈)
  const woodCol = choga ? 0x4e3b28 : giwa ? 0x9a8a6f : temple ? 0x87703f : C.seokganju;
  // 기와집 백골 기둥·창방이 역광에서 숯색으로 죽지 않게 미량 emissive(따뜻한 백골 유지).
  const woodExtra = giwa ? { emissive: 0x2a2015 } : {};

  // 결정론 호환: 구 사찰 band painter는 이 정확한 지점에서 얼룩 64개×4회 RNG를 소비했다.
  // 새 단청 픽셀은 source key 전용 RNG라 전역값에 의존하지 않지만, 뒤이어 조립되는 담·소품의
  // seeded stream을 이동시키지 않도록 소비 위치/횟수만 보존한다(worker/sync scene golden 계약).
  if (temple) for (let index = 0; index < 64 * 4; index++) _texRand();

  const M = {
    colors: C,
    style,
    dancheong: dancheong?.dancheong || null,
    wood: std(woodCol, temple ? 0.85 : 0.8, woodExtra),         // 기둥
    // 인방·문틀. 기와집·반가(giwa/hanok)는 궁 기본값(0x6f3626 = 석간주 계열 산화적색)으로 떨어지면
    //   안 된다 — 주칠·석간주는 궁·관아·사찰 채색 위계이고 반가 창호 인방·문틀은 백골 또는 진한 고재다
    //   (docs/architectural-authenticity.md §2.2·§5-4·§7.5 W1). 백골 기둥(0x9a8a6f)과 같은 색조에서
    //   명도만 한 단계 내린 갈색을 쓴다.
    woodDark: std(choga ? 0x37281a : temple ? 0x66512f : giwa ? 0x6a5a44 : 0x6f3626, 0.85),
    woodBoard: std(temple ? 0x574531 : 0x4a3421, 0.85),         // 박공널 목재 보드
    // 단청은 궁·사찰만. 기와/초가 팔레트는 같은 키를 단색 목재로 채워 빌더 계약을 단순하게
    // 유지하되 CanvasTexture를 아예 만들지 않는다.
    beamDancheong: dancheong?.beamDancheong || std(choga ? 0x453320 : 0x8b7960, 0.85),
    bracket: dancheong?.bracket || std(choga ? 0x493823 : 0x817058, 0.85),
    bracketAlt: dancheong?.bracketAlt || std(choga ? 0x5c432a : 0x715d46, 0.85),
    bracketFace: dancheong?.bracketFace || std(choga ? 0x493823 : 0x817058, 0.85),
    yeonmokcho: dancheong?.yeonmokcho || std(choga ? 0x493823 : 0x817058, 0.85),
    bujeoncho: dancheong?.bujeoncho || std(choga ? 0x493823 : 0x817058, 0.85),
    rafter: dancheong?.rafter || std(choga ? 0x6b5138 : 0x817058, 0.85,
      choga ? { emissive: 0x1a150f } : {}),
    rafterEnd: dancheong?.rafterEnd || std(choga ? 0x70543a : 0x9a8a6f, 0.8),
    accentBlue: dancheong?.accentBlue || std(giwa ? 0x8c7c64 : 0x5a4932, 0.85),
    tileTex: makeTileTexture(),
    // TILE_LOOK roughness band — matte 점토 기와. 낮은 roughness 는 망원 sparkle/alias 원인이 된다.
    tileFlat: std(C.tile, TILE_LOOK.tileFlatRoughness),
    tileRidge: std(C.tileDark, TILE_LOOK.tileRidgeRoughness), // 마루: tileDark 분리 톤
    ridgePlaster: std(0xe0d9c6, 0.94),           // 양성바름: 궁 마루(용마루·내림·추녀) 백색 회 도장
    tileConvex: std(0x6a6d73, TILE_LOOK.tileConvexRoughness), // 수키와 볼록 열 (밝은 기와 마루톤)
    wadang: std(0xffffff, 0.85, { map: makeWadangTexture() }),  // 수막새 와당(처마 끝)
    waguto: std(0xffffff, 0.92, { map: makeWagutoTexture() }),  // 와구토(반가 처마 끝 흰 회물림 반달)
    jeoksae: std(0xffffff, 0.9, { map: makeJeoksaeTexture() }), // 적새(마루 옆면 켜)
    maru: std(0xffffff, 0.6, { map: makeMaruTexture() }),       // 우물마루(손 탄 반질 갈색)
    planwall: std(0x4a3a28, 0.85),                              // 판벽(대청 뒷벽, 어두운 널)
    eaveBand: std(0x2e2a28, 0.9),                // 처마 단면 띠
    thatch: std(0xffffff, 1.0, { map: makeThatchTexture(), emissive: 0x1a150e }), // 볏짚 (emissive로 해 안 드는 사면·소프릿이 검게 안 죽게)
    yongmaru: std(0xffffff, 1.0, { map: makeYongmaruTexture(), emissive: 0x0e0a05 }), // 용마름 롤(새끼줄 감김 텍스처)
    mud: std(0x9a7a54, 1.0, { emissive: 0x2a2013 }), // 진흙 굴뚝·부뚜막(초가) — 따뜻한 황토
    jipjul: std(0xb8ad90, 1.0),                  // 집줄(지붕 새끼 그물)·눌림대 새끼 — 바랜 볏짚 회금빛
    // 옹기(장독) 유약: 어두운 갈흑에 약한 반사. 종전엔 woodDark(문틀)를 재사용해 문틀 색을 고치면
    //   장독 색이 함께 흔들렸다 — 재료가 다르므로 전용 색으로 분리한다(§7.5 W1 회귀 주의).
    onggi: std(0x35251b, 0.55),
    fieldstone: std(0xffffff, 0.98, { map: makeFieldstoneTexture() }), // 막돌 기단·화방벽(초가)
    jeondol: std(0xffffff, 0.95, { map: makeJeondolTexture() }), // 전돌 굴뚝(반가)
    plaster: wallMat,                            // 벽·포벽 공용
    gable: std(0xffffff, 0.9, { map: makeGableTexture(style) }),
    pungpan: std(0xffffff, 0.9, { map: makePungpanTexture() }),  // 풍판 세로널(절)
    salchang: salchangMat,                       // 살창(절) — #66 발광 태그
    stone: std(stoneCol, 0.95),
    stoneDark: std(stoneDarkCol, 0.95),
    door: doorMat,
    hanji: hanjiMat,
    // 창호 철물은 작은 FULL 디테일 한 그룹으로만 쓴다. paletteKey는 변주 간 재질 공유를
    // 허용하지만 lodEnvelope를 주지 않아 MID 창호 텍스처와 드로우콜을 그대로 보존한다.
    hardware: std(0x302a24, 0.72, { metalness: 0.42 }),
    ground: std(C.ground, 1.0),
  };
  tagRoles(M);
  return M;
}

// ── 재질 역할 태그(userData.role) — 마을 인스턴싱의 부위별 색 변주(instanceColor)용(태스크 #55). ──
//   지붕/벽/목부재/석재를 부위별 톤으로 독립 곱틴트하려면 어떤 InstancedMesh 가 어느 부위인지
//   식별해야 한다(각 재질=별도 InstancedMesh). 재질 clone 은 userData 를 복제하므로 태그가 전파되고,
//   tileSurfaceMaterial(지붕면 신규 재질)에도 별도로 태그한다. 태그 없는 재질(아궁이·개구부 등)은
//   중립(무틴트) — 개구부는 야간 창호광(emissive)과 충돌 방지, 아궁이는 불빛 액센트 보존.
const MATERIAL_ROLES = {
  roof: ['tileFlat', 'tileRidge', 'ridgePlaster', 'tileConvex', 'wadang', 'waguto', 'jeoksae', 'eaveBand', 'thatch', 'yongmaru', 'jipjul'],
  wall: ['plaster', 'gable', 'pungpan', 'planwall'],
  wood: ['wood', 'woodDark', 'woodBoard', 'beamDancheong', 'bracket', 'bracketAlt', 'bracketFace', 'yeonmokcho', 'bujeoncho', 'rafter', 'rafterEnd', 'accentBlue', 'maru'],
  stone: ['stone', 'stoneDark', 'fieldstone', 'jeondol'],
  opening: ['door', 'hanji', 'salchang'],   // 창호: 중립 틴트(야간 광 충돌 방지) + 변주별 살 패턴 유지 태그
};
function tagRoles(M) {
  // Separately built house variants still describe the same authored palette families.
  // Clones retain userData, letting the village instancer share semantically identical
  // materials across different ㅡ/ㄱ/ㄷ topology without confusing unrelated textures.
  for (const [key, material] of Object.entries(M)) {
    if (material?.isMaterial) material.userData.paletteKey = key;
  }
  for (const role in MATERIAL_ROLES) {
    for (const key of MATERIAL_ROLES[role]) {
      const m = M[key];
      if (m && m.isMaterial) m.userData.role = role;
    }
  }
  // 중거리 LOD는 별도 모형을 새로 그리지 않고 실제 빌더 결과에서 외피 재질만 추출한다.
  // 지붕면·마루·벽·기둥·기단·창호는 남기고, 기와 한 장·공포·서까래·장식처럼 픽셀보다
  // 작은 반복 부재는 full 단계까지 미룬다. 태그는 clone에도 전파돼 변주별 재료/텍스처가 보존된다.
  const envelope = [
    'tileFlat', 'tileRidge', 'eaveBand', 'thatch', 'yongmaru',
    'plaster', 'gable', 'pungpan', 'planwall',
    'wood', 'woodDark', 'woodBoard',
    'stone', 'stoneDark', 'fieldstone',
    'door', 'hanji', 'salchang',
  ];
  for (const key of envelope) {
    const m = M[key];
    if (m && m.isMaterial) m.userData.lodEnvelope = true;
  }
  // Snow follows continuous skins. Small shared ridge/eave ornaments stay
  // unpatched to bound shader variants; authored full-length tile rolls opt in below.
  for (const key of ['tileFlat', 'thatch']) {
    if (M[key]?.isMaterial) M[key].userData.snowSurface = true;
  }
}

// ── 공유 재질 정규화(#149) ────────────────────────────────────────────────
//   궁궐은 전 전각이 한 벌의 재질셋(P.mats)을 공유하지만, 빌더들이 부재별로 재질을 clone 해
//   텍스처 반복(map.repeat)이나 side 만 바꾸는 경우가 많다(창방 색동·문짝 분합·기와면 골·합각·
//   처마 띠·적새). 이 clone 들은 "시각적으로는 같지만 객체는 다른" 재질이라, mergeStatic 이 재질
//   identity 로 병합하는 부감 경로에서 전각마다 별개 메시로 남아 병합 바닥을 끌어올린다.
//   → 서명(시각 관련 필드 전부)이 완전히 같은 재질을 canon 인스턴스 하나로 통일해 병합을 더 무너뜨린다.
//   보수적 원칙: 서명은 렌더에 영향 주는 모든 필드를 담고, onBeforeCompile/customProgramCacheKey 같은
//   숨은 상태가 있으면 통일 대상에서 제외(null 반환) → 통일된 재질은 픽셀 동일이 보장된다.
//
// 텍스처 이미지(Source) 동일성 판정용 안정 id. clone 은 source 를 공유참조하므로 같은 이미지 = 같은 id.
let _srcSeq = 0;
const _srcId = new WeakMap();
function texSig(t) {
  if (!t) return '-';
  const src = t.source || t.image;
  let id;
  if (src && typeof src === 'object') { id = _srcId.get(src); if (id === undefined) { id = ++_srcSeq; _srcId.set(src, id); } }
  else id = String(src);
  return `${id}|${t.repeat.x.toFixed(4)},${t.repeat.y.toFixed(4)}|${t.offset.x.toFixed(4)},${t.offset.y.toFixed(4)}|${t.wrapS},${t.wrapT}|${t.rotation}|${t.colorSpace}|${t.flipY ? 1 : 0}`;
}
function materialSignature(m) {
  if (!m || !m.isMaterial) return null;
  // 커스텀 셰이더/캐시키(구름그림자 등 숨은 상태)가 붙은 재질은 통일 제외 — 궁 빌드 시점엔 없음(방어).
  //   주의: onBeforeCompile·customProgramCacheKey 는 프로토타입에 기본(빈 함수)이 있어 항상 truthy 다.
  //   "직접 대입(own 프로퍼티)된 경우"만 커스텀으로 보고 제외한다(injectCloudShadow 등이 own 대입).
  const has = (k) => Object.prototype.hasOwnProperty.call(m, k);
  if (has('onBeforeCompile') || has('customProgramCacheKey')) return null;
  const ud = m.userData || {};
  return [
    m.type, m.side, m.transparent ? 1 : 0, +(m.opacity ?? 1).toFixed(4), m.vertexColors ? 1 : 0,
    m.flatShading ? 1 : 0, +(m.alphaTest ?? 0).toFixed(4), m.depthWrite ? 1 : 0, m.depthTest ? 1 : 0,
    m.blending, m.wireframe ? 1 : 0, m.name || '',
    m.color ? m.color.getHexString() : '-',
    m.emissive ? m.emissive.getHexString() : '-', +(m.emissiveIntensity ?? 1).toFixed(4),
    +(m.roughness ?? 1).toFixed(4), +(m.metalness ?? 0).toFixed(4),
    +(m.bumpScale ?? 1).toFixed(4), +(m.aoMapIntensity ?? 1).toFixed(4),
    +(m.displacementScale ?? 1).toFixed(4), m.normalScale ? `${m.normalScale.x},${m.normalScale.y}` : '-',
    texSig(m.map), texSig(m.bumpMap), texSig(m.normalMap), texSig(m.emissiveMap),
    texSig(m.roughnessMap), texSig(m.metalnessMap), texSig(m.aoMap), texSig(m.alphaMap),
    // 부위 태그·야간 발광 계수: 서로 다른 역할/발광의 재질을 섞지 않게 서명에 포함.
    ud.role || '-', ud.hanjiGlow ?? '-',
  ].join('~');
}

// root 서브트리의 메시 재질을 서명이 같은 것끼리 canon 인스턴스로 통일한다. canon(Map)을 여러 번
//   넘기면 서브트리를 가로질러(예: 궁 일곽마다 finalize 직전 호출) 누적 통일된다. 반환: 교체 횟수.
export function canonicalizeSharedMaterials(root, canon = new Map()) {
  let replaced = 0;
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const m = o.material;
    if (!m || Array.isArray(m) || !m.isMaterial) return;   // 멀티머티리얼(궁엔 없음)은 스킵
    const sig = materialSignature(m);
    if (sig == null) return;
    const c = canon.get(sig);
    if (c === undefined) { canon.set(sig, m); return; }
    if (c !== m) { o.material = c; replaced++; }
  });
  return replaced;
}

// 지붕면 전용: 표면 크기에 맞춰 기와 골 반복수를 계산한 재질 생성.
// Bump defaults to TILE_LOOK.bumpSurface (callers may pass TILE_LOOK.bumpMatbae etc.).
export function tileSurfaceMaterial(mats, widthMeters, slopeMeters, bumpScale = TILE_LOOK.bumpSurface) {
  const tex = mats.tileTex.clone();
  tex.needsUpdate = true;
  tex.anisotropy = 8;
  tex.repeat.set(Math.max(4, Math.round(widthMeters / 0.34)), Math.max(2, Math.round(slopeMeters / 0.9)));
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tex, roughness: TILE_LOOK.tileSurfaceRoughness, metalness: 0.0,
    bumpMap: tex, bumpScale,
  });
  mat.userData.role = 'roof';   // 지붕면 신규 재질도 부위 태그(마을 기와 톤 변주, 태스크 #55)
  mat.userData.paletteKey = 'tileSurface';
  mat.userData.lodEnvelope = true;
  mat.userData.snowSurface = true;
  return mat;
}

// 수키와 롤 전용: TubeGeometry UV 축에 맞춰 기와 겹침 반복수를 계산한 재질 생성.
// three TubeGeometry: uv.x = 길이(0→1 along path), uv.y = 둘레(0→1 around).
// 물매 겹침 켜 간격은 지붕면 UV v 와 같은 0.9m (across 0.34m 가 아님 — 예전 코드는
// 축을 뒤집어 둘레에 length/0.34 를 걸어 밀도가 과도했고 길이 방향 무늬가 사라졌다).
export function sugiwaMaterial(mats, lengthMeters, bumpScale = TILE_LOOK.bumpSugiwa) {
  const tex = mats.tileTex.clone();
  tex.needsUpdate = true;
  tex.anisotropy = 8;
  const alongPitch = 0.9; // GIWA_ALONG_PITCH — roof-skeleton 면 UV v 와 공유
  // U(길이): 물매 켜 반복, V(둘레): 한 바퀴 1회
  tex.repeat.set(Math.max(1, Math.round(lengthMeters / alongPitch)), 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6a6d73, map: tex, roughness: TILE_LOOK.sugiwaRoughness, metalness: 0.0,
    bumpMap: tex, bumpScale,
  });
  mat.userData.role = 'roof';
  mat.userData.paletteKey = 'sugiwa';
  mat.userData.snowSurface = true;
  return mat;
}

// ── 흐르는 구름 그림자 주입(#110) ─────────────────────────────────────────────
// 밀집 부감(한양급)은 화면 대부분이 지붕이라, 지형 재질에만 얹힌 구름 그늘(populate buildSiteTerrain·
//   env terrain.js)이 지붕에 가려 안 보인다. 지형과 "같은" GLSL(clouds.js export, 같은 uCloudBlobs
//   uniform 공유)을 지붕 재질에 재질별 onBeforeCompile 로 얹어 그늘이 지붕에도 흐르게 한다.
//   cloudUniforms(populate 가 만들어 clouds.js update 가 매 프레임 갱신)가 있을 때만 활성 →
//   env 단일건물(uniforms 미배선)은 미주입(무회귀). uniform 은 공유 참조로 넘겨 갱신이 끊기지 않게 한다.
// 함정 대응:
//   - 인스턴싱: 집 지붕은 InstancedMesh → CLOUD_SHADOW_VERT_BODY 가 USE_INSTANCING 시 instanceMatrix
//     를 합성(clouds.js). 지형·병합 지오는 modelMatrix 경로 그대로.
//   - 체인 순서: 기존 onBeforeCompile(있으면)을 먼저 호출(prev)해 보존. shade 는 곱연산이라 색 패치
//     순서와 무관(교환 가능)하고, color_fragment 앵커는 소비되지 않아(뒤에 append) 재치환 안전.
//   - 캐시키: three 는 onBeforeCompile 변형을 기본 프로그램 캐시키에 반영하지 않는다 → 미주입 동일
//     파라미터 재질과 프로그램을 공유하지 않도록 키를 분리(#52 실증). 기존 커스텀 키가 있으면 접미.
//   - 멱등: 공유 재질을 traverse 로 여러 번 만나도 1회만 패치(__cloudShadowPatched).
// 반환: 실제로 패치했으면 true(검증 카운트용).
export function injectCloudShadow(mat, cloudUniforms) {
  if (!mat || !mat.isMaterial || !cloudUniforms) return false;
  if (mat.userData.__cloudShadowPatched) {
    // Re-entry still enforces the R8 always-on screen-door path (no second cloud inject).
    patchLodScreenDoorMaterial(mat);
    return false;
  }
  mat.userData.__cloudShadowPatched = true;
  // Explicit composition contract for later material patches (notably env/rim.js).  The patch
  // only multiplies diffuseColor at color_fragment and preserves previous callbacks, so it is
  // safe to chain when each participant also composes customProgramCacheKey.
  mat.userData.__cloudShadowPatchVersion = MATERIAL_PROGRAM_PATCH.CLOUD_SHADOW;
  // R8 program diet (#220 residual): every cloud-shadow stock material carries the LOD
  // screen-door shader path so cloud-only vs lod+cloud never forks a WebGLProgram family.
  // Coverage defaults to affine 1 (discard early-out). Matrix channel stays LOD-root only.
  patchLodScreenDoorMaterial(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uCloudTime = cloudUniforms.uCloudTime;
    shader.uniforms.uCloudStr = cloudUniforms.uCloudStr;
    shader.uniforms.uCloudBlobs = cloudUniforms.uCloudBlobs;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CLOUD_SHADOW_VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CLOUD_SHADOW_VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CLOUD_SHADOW_FRAG_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CLOUD_SHADOW_FRAG_BODY}`);
  };
  addMaterialProgramKey(mat, MATERIAL_PROGRAM_PATCH.CLOUD_SHADOW);
  mat.needsUpdate = true;
  return true;
}

// 마을 root(populateVillage 산출)를 traverse 해 지붕(role='roof') 재질에 구름 그림자를 주입한다.
//   부감에서 실제로 보이는 표면은 지붕+지형이며 지형은 이미 그늘을 받으므로, 지붕만 얹어도 "구름이
//   마을 위를 흐르는" 그늘이 완결된다(벽·목부재까지 넓히면 프로그램 수만 늘어 이득 없음). 공유 재질이라
//   실 패치 수는 소수(giwa·choga·궁·절·히어로·시전 지붕 팔레트). 반환: 패치한 고유 재질 수.
export function injectVillageCloudShadow(root, cloudUniforms) {
  if (!root || !cloudUniforms) return 0;
  let n = 0;
  root.traverse((o) => {
    const m = o.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mm of list) {
      if (mm && mm.userData && mm.userData.role === 'roof' && injectCloudShadow(mm, cloudUniforms)) n++;
    }
  });
  return n;
}

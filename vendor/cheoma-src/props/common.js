import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { Kit } from './kit.js';
import { getPropMaterials } from './materials.js';

// ── 장승 ────────────────────────────────────────────────────────
// 목각 벅수. 왕방울 눈 · 주먹코 · 이빨 드러낸 입 · (대장군)관모. 몸통엔 세로 명문.
// kind: 'general'(천하대장군, 관모) | 'lady'(지하여장군, 민머리). label 없으면 kind 기본값.
export function buildJangseung({ seed = 1, scale = 1, kind = 'general', label } = {}) {
  const rng = makeRng(seed);
  const M = getPropMaterials();
  const kit = new Kit(M);
  const general = kind !== 'lady';
  const text = label || (general ? '天下大將軍' : '地下女將軍');

  // 몸통(통나무) + 돌 밑동
  kit.box('graniteDark', 0.5, 0.16, 0.5, [0, 0.08, 0]);
  const H = 2.5;
  kit.cyl('woodPaint', 0.21, 0.27, H, 7, [0, 0.08 + H / 2, 0]);
  const topY = 0.08 + H;

  // 얼굴 구역(정면 +z)
  const fy = topY - 0.42, fz = 0.2;
  // 눈두덩/이마
  kit.box('woodPaint', 0.5, 0.2, 0.16, [0, fy + 0.34, fz + 0.02], [0.12, 0, 0]);
  // 성난 눈썹(가운데로 처짐)
  for (const s of [-1, 1]) kit.box('paintBlack', 0.22, 0.06, 0.1, [s * 0.16, fy + 0.24, fz + 0.16], [0, 0, s * 0.35]);
  // 왕방울 눈(크게 돌출) + 눈동자
  for (const s of [-1, 1]) {
    kit.sphere('paintWhite', 0.15, [s * 0.16, fy + 0.14, fz + 0.14], [1, 1, 0.9]);
    kit.sphere('paintBlack', 0.07, [s * 0.16, fy + 0.13, fz + 0.26]);
  }
  // 주먹코(크고 둥근) — 대장군은 붉게
  kit.box('woodPaint', 0.17, 0.42, 0.2, [0, fy - 0.02, fz + 0.12], [0.1, 0, 0]);
  kit.sphere(general ? 'paintRed' : 'woodPaint', 0.15, [0, fy - 0.16, fz + 0.24], [1.1, 0.9, 1]);
  // 이빨 드러낸 입
  kit.box('dark', 0.42, 0.14, 0.12, [0, fy - 0.42, fz + 0.16]);
  for (let t = 0; t < 5; t++) kit.box('paintWhite', 0.06, 0.11, 0.05, [(t - 2) * 0.08, fy - 0.4, fz + 0.24]);
  // 귀
  for (const s of [-1, 1]) kit.sphere('woodPaint', 0.08, [s * 0.28, fy + 0.05, fz - 0.05], [0.6, 1.2, 0.8]);

  if (general) {
    // 관모(벙거지): 넓은 챙 + 돔
    kit.cyl('paintBlack', 0.42, 0.44, 0.06, 12, [0, topY + 0.02, fz - 0.08]);
    kit.sphere('paintBlack', 0.24, [0, topY + 0.14, fz - 0.08], [1, 0.8, 1]);
  } else {
    // 민머리(둥근 정수리) + 붉은 연지 힌트
    kit.sphere('woodPaint', 0.26, [0, topY - 0.02, fz - 0.05], [1, 0.7, 1]);
    for (const s of [-1, 1]) kit.sphere('paintRed', 0.05, [s * 0.16, fy + 0.02, fz + 0.22]);
  }

  const g = kit.build('jangseung');
  // 세로 명문판(전용 텍스처 재질 — 좌우 글자가 달라 공유 불가)
  const panelMat = new THREE.MeshStandardMaterial({ map: M._jangseungText(text), roughness: 0.85 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.15, 0.06), panelMat);
  panel.position.set(0, 0.08 + H * 0.42, 0.25);
  panel.castShadow = true;
  g.add(panel);

  g.scale.setScalar(scale);
  return g;
}

// 장승 한 쌍(천하대장군 + 지하여장군).
export function buildJangseungPair({ seed = 1, scale = 1, gap = 1.4 } = {}) {
  const g = new THREE.Group();
  g.name = 'jangseung-pair';
  const a = buildJangseung({ seed, scale, kind: 'general' });
  a.position.x = -gap / 2;
  const b = buildJangseung({ seed: seed + 7, scale: scale * 0.94, kind: 'lady' });
  b.position.x = gap / 2;
  g.add(a, b);
  return g;
}

// ── 솟대 ────────────────────────────────────────────────────────
// 긴 장대 위에 나무 새(오리). 마을 어귀 신앙물.
export function buildSotdae({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const lean = (rng() - 0.5) * 0.05;
  const H = 3.5 + rng() * 0.4;
  kit.geom('graniteDark', new THREE.CylinderGeometry(0.18, 0.24, 0.2, 8), [0, 0.1, 0]); // 밑동 돌
  kit.cyl('wood', 0.045, 0.08, H, 7, [Math.sin(lean) * H / 2, H / 2, 0], [0, 0, lean]);
  kit.torus('rope', 0.09, 0.02, [Math.sin(lean) * 0.6, 0.6, 0], [Math.PI / 2, 0, 0], 1, 5, 10);

  // 새(오리) — 장대 끝, +z 바라봄
  const tx = Math.sin(lean) * H, ty = H;
  const yaw = rng() * Math.PI * 2;
  const bird = new Kit(getPropMaterials());
  bird.sphere('woodLight', 0.16, [0, 0, 0], [1.5, 0.9, 1]);           // 몸통
  bird.cyl('woodLight', 0.05, 0.06, 0.28, 6, [0, 0.12, 0.14], [0.7, 0, 0]); // 목
  bird.sphere('woodLight', 0.09, [0, 0.24, 0.26], [1, 0.9, 1.2]);     // 머리
  bird.cyl('wood', 0.01, 0.04, 0.16, 5, [0, 0.22, 0.4], [Math.PI / 2 + 0.3, 0, 0]); // 부리
  bird.box('wood', 0.06, 0.05, 0.28, [0, -0.02, -0.22], [0.3, 0, 0]); // 꼬리
  const bg = bird.build('sotdae-bird');
  bg.position.set(tx, ty, 0);
  bg.rotation.y = yaw;

  const g = kit.build('sotdae');
  g.add(bg);
  g.scale.setScalar(scale);
  return g;
}

// ── 멍석 ────────────────────────────────────────────────────────
// 바닥에 펼친 짚 엮음 자리. 가장자리 테두리 + 한쪽 모서리 살짝 말림.
export function buildStrawMat({ seed = 1, scale = 1, w = 2.0, d = 1.4 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  kit.box('mat', w, 0.035, d, [0, 0.02, 0]);
  // 테두리(짚 꼰 가장자리)
  for (const s of [-1, 1]) {
    kit.cyl('rope', 0.03, 0.03, w, 6, [0, 0.03, s * d / 2], [0, 0, Math.PI / 2]);
    kit.cyl('rope', 0.03, 0.03, d, 6, [s * w / 2, 0.03, 0], [Math.PI / 2, 0, 0]);
  }
  // 한 모서리 말림
  kit.box('mat', w * 0.3, 0.035, d * 0.3, [w / 2 - w * 0.15, 0.06, d / 2 - d * 0.15], [0.5, 0, -0.5]);
  const g = kit.build('straw-mat');
  g.scale.setScalar(scale);
  return g;
}

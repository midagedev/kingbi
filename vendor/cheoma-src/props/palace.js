import { makeRng } from '../rng.js';
import { Kit } from './kit.js';
import { getPropMaterials } from './materials.js';

// ── 해태(獬豸) ──────────────────────────────────────────────────
// 대좌 위에 웅크려 앉은 서수(瑞獸). 개로 안 보이게: 큰 머리 · 목 갈기 고리 · 왕방울 눈 ·
// 들창코 · 이빨 · 정수리 외뿔 · 등줄기 비늘. 로우폴리(화강암 flatShading)로 석조 느낌.
export function buildHaetae({ seed = 1, scale = 1, mirror = false } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const j = () => 0.94 + rng() * 0.12;

  // 대좌
  kit.box('graniteWarm', 1.15, 0.4, 1.5, [0, 0.2, 0]);
  kit.box('granite', 1.3, 0.12, 1.65, [0, 0.46, 0]);       // 갑석
  const top = 0.52;

  // 몸통: 뒤 엉덩이(큰 덩어리) → 앞으로 들린 가슴
  kit.sphere('granite', 0.52, [0, top + 0.42, -0.34], [1.05, 0.95, 1.15]);      // 엉덩이
  kit.sphere('granite', 0.44, [0, top + 0.6, 0.12], [1.0, 1.15, 0.95]);          // 가슴(세워짐)
  // 앞다리 한 쌍(곧게)
  for (const s of [-1, 1]) {
    kit.cyl('granite', 0.15, 0.18, 0.72, 7, [s * 0.28, top + 0.36, 0.42]);
    kit.box('granite', 0.34, 0.14, 0.4, [s * 0.28, top + 0.05, 0.52]);           // 앞발
    for (let t = 0; t < 3; t++) kit.box('graniteDark', 0.08, 0.08, 0.12, [s * 0.28 + (t - 1) * 0.1, top + 0.03, 0.72]); // 발가락
  }
  // 뒷다리(접힘)
  for (const s of [-1, 1]) kit.sphere('granite', 0.24, [s * 0.42, top + 0.24, -0.28], [1, 0.85, 1.1]);

  // 목 + 머리(크게)
  kit.cyl('granite', 0.28, 0.34, 0.4, 7, [0, top + 1.02, 0.16], [0.5, 0, 0]);
  const hy = top + 1.34, hz = 0.34;
  kit.box('granite', 0.5, 0.44, 0.5, [0, hy, hz], [0.08, 0, 0]);                  // 머리통
  // 주둥이(들창코) + 벌린 입
  kit.box('granite', 0.42, 0.26, 0.34, [0, hy - 0.16, hz + 0.32], [0.15, 0, 0]);  // 윗턱/코
  kit.sphere('graniteDark', 0.13, [0, hy - 0.06, hz + 0.5], [1.2, 0.8, 1]);       // 주먹코
  kit.box('dark', 0.34, 0.12, 0.14, [0, hy - 0.3, hz + 0.4]);                     // 입 안(어둠)
  kit.box('granite', 0.4, 0.16, 0.3, [0, hy - 0.42, hz + 0.26], [-0.2, 0, 0]);    // 아래턱
  for (let t = 0; t < 4; t++) kit.box('paintWhite', 0.06, 0.1, 0.05, [(t - 1.5) * 0.09, hy - 0.26, hz + 0.46]); // 이빨
  // 왕방울 눈: 돌출한 돌 눈알 + 새긴 눈동자, 성난 눈두덩(가운데로 치켜)
  for (const s of [-1, 1]) {
    kit.sphere('granite', 0.13, [s * 0.18, hy + 0.05, hz + 0.24], [1, 1.05, 0.85]);          // 눈알(돌)
    kit.sphere('paintDark', 0.055, [s * 0.18, hy + 0.05, hz + 0.35]);                        // 눈동자
    kit.box('granite', 0.26, 0.1, 0.16, [s * 0.17, hy + 0.22, hz + 0.18], [0.35, 0, s * 0.3]); // 눈두덩
  }
  // 정수리 외뿔(짧고 굵게, 뒤로) + 귀
  kit.cyl('granite', 0.05, 0.14, 0.2, 6, [0, hy + 0.3, hz - 0.02], [-0.5, 0, 0]);
  kit.sphere('granite', 0.08, [0, hy + 0.4, hz - 0.13]);                                      // 뿔 끝 혹
  for (const s of [-1, 1]) kit.sphere('granite', 0.1, [s * 0.28, hy + 0.12, hz - 0.14], [0.6, 1.2, 0.7]); // 귀

  // 갈기: 목 둘레 수평 고리 곱슬(대칭) + 얼굴 양볼 곱슬 + 등줄기
  const maneY = top + 1.0, maneCz = hz - 0.16, maneR = 0.42;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    kit.sphere('graniteDark', 0.11 + rng() * 0.03,
      [Math.sin(a) * maneR, maneY + (rng() - 0.5) * 0.1, maneCz - Math.cos(a) * maneR * 0.8], j());
  }
  for (const s of [-1, 1]) for (let k = 0; k < 2; k++)
    kit.sphere('graniteDark', 0.1, [s * (0.3 + k * 0.02), hy + 0.04 - k * 0.22, hz - 0.02], j()); // 양볼
  for (let i = 0; i < 5; i++)
    kit.sphere('graniteDark', 0.1, [0, top + 0.92 - i * 0.03, -0.08 - i * 0.16], [1.2, 0.9, 1]); // 등줄기
  // 꼬리(등 위로 말림)
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    kit.sphere('granite', 0.11 - t * 0.03, [0, top + 0.7 + t * 0.5, -0.6 + t * 0.25], j());
  }

  const g = kit.build('haetae');
  if (mirror) g.scale.set(-scale, scale, scale);
  else g.scale.setScalar(scale);
  return g;
}

// ── 드므 ────────────────────────────────────────────────────────
// 청동 방화수 항아리. 넓게 벌어진 몸통·안으로 오므린 전, 물이 담긴 수면, 양측 고리 손잡이.
export function buildDeumeu({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const j = 0.97 + rng() * 0.06;

  // 넉 다리
  for (const s of [-1, 1]) for (const sz of [-1, 1]) {
    kit.cyl('bronzeDark', 0.08, 0.1, 0.22, 6, [s * 0.34, 0.11, sz * 0.34], [0, 0, s * 0.12]);
  }
  // 몸통(라이드): 넓은 배 → 오므린 전
  const body = [
    [0.001, 0], [0.28, 0], [0.44, 0.06], [0.6, 0.28], [0.63, 0.46],
    [0.58, 0.62], [0.52, 0.72], [0.5, 0.78],       // 전(입)
    [0.46, 0.78], [0.47, 0.66],                     // 안쪽 두께
  ].map(([r, y]) => [r * j, y + 0.2]);
  kit.lathe('bronze', body, 20, [0, 0, 0]);
  kit.cyl('water', 0.46, 0.46, 0.02, 20, [0, 0.82, 0]);   // 수면
  // 고리 손잡이 2개
  for (const s of [-1, 1]) kit.torus('bronze', 0.1, 0.025, [s * 0.6, 0.66, 0], [0, Math.PI / 2, 0]);

  const g = kit.build('deumeu');
  g.scale.setScalar(scale);
  return g;
}

// ── 품계석 열 ──────────────────────────────────────────────────
// 조정(朝廷) 마당에 품계를 새긴 작은 비석 열. 한 줄(N개) 생성 — 도시가 좌우 대칭 배치.
export function buildRankStones({ seed = 1, scale = 1, count = 6, spacing = 1.5 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  for (let i = 0; i < count; i++) {
    const z = i * spacing;
    const h = 0.62 - i * 0.02;         // 품계 내려가며 살짝 낮게
    const lean = (rng() - 0.5) * 0.05;
    kit.box('graniteWarm', 0.4, 0.12, 0.4, [0, 0.06, z]);         // 받침
    kit.box('granite', 0.22, h, 0.15, [0, 0.06 + h / 2, z], [lean, 0, lean]);   // 비신
    kit.cyl('granite', 0.11, 0.11, 0.1, 6, [0, 0.06 + h, z], [Math.PI / 2, 0, 0]); // 둥근 머리
    kit.box('dark', 0.12, h * 0.5, 0.02, [0, 0.06 + h * 0.5, z + 0.08]);         // 각자면(글자)
  }
  const g = kit.build('rank-stones');
  g.scale.setScalar(scale);
  return g;
}

// ── 정(鼎) 향로 ─────────────────────────────────────────────────
// 세 발 청동 향로. 둥근 몸통 · 삼족(三足) · 양이(兩耳) · 뚜껑 꼭지.
export function buildDingCenser({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const j = 0.97 + rng() * 0.06;

  // 삼족
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    kit.cyl('bronzeDark', 0.045, 0.06, 0.34, 6, [Math.cos(a) * 0.24, 0.17, Math.sin(a) * 0.24], [0, 0, 0]);
  }
  // 몸통
  const body = [
    [0.001, 0], [0.2, 0], [0.3, 0.06], [0.34, 0.2], [0.33, 0.34], [0.28, 0.42], [0.27, 0.46],
  ].map(([r, y]) => [r * j, y + 0.32]);
  kit.lathe('bronze', body, 18, [0, 0, 0]);
  // 양이(귀 손잡이)
  for (const s of [-1, 1]) kit.torus('bronze', 0.08, 0.022, [s * 0.28, 0.8, 0], [0, 0, 0], 1, 6, 10, Math.PI);
  // 뚜껑 + 꼭지
  kit.lathe('bronze', [[0.28, 0], [0.24, 0.06], [0.16, 0.13], [0.08, 0.17], [0.001, 0.18]], 18, [0, 0.78, 0]);
  for (const s of [-1, 1]) for (const sz of [-1, 1]) kit.box('dark', 0.03, 0.02, 0.08, [s * 0.1, 0.85, sz * 0.1]); // 연기 구멍
  kit.sphere('bronze', 0.055, [0, 0.98, 0]);

  const g = kit.build('ding-censer');
  g.scale.setScalar(scale);
  return g;
}

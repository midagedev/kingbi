import { makeRng } from '../rng.js';
import { Kit } from './kit.js';
import { getPropMaterials } from './materials.js';
import { onggiProfile, boulderGeometry } from './geom.js';
import { sunkPrism } from '../core/surface-clearance.js';

// 옹기 한 점(뚜껑 포함) — 어깨 넓고 입 좁은 실루엣. y=바닥 높이.
function addOnggi(kit, x, y, z, h, maxR, rng, lidded = true) {
  kit.lathe('onggi', onggiProfile(h, maxR), 14, [x, y, z]);
  if (lidded) {
    kit.lathe('onggiLid', [[0.001, 0.04], [maxR * 0.5, 0.03], [maxR * 0.56, 0], [maxR * 0.44, 0]], 14,
      [x, y + h * 0.985, z]);                               // 뚜껑(전 위에 덮임)
    kit.sphere('onggiLid', maxR * 0.1, [x, y + h * 1.02, z]); // 꼭지
  }
}

// ── 장독대 ──────────────────────────────────────────────────────
// 낮은 돌단 위 옹기 군집(3종 크기). 뒤로 큰 독, 앞으로 작은 단지.
export function buildJangdokdae({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());

  // 돌단(2단)
  kit.box('granite', 2.7, 0.18, 1.9, [0, 0.09, 0]);
  kit.box('graniteWarm', 2.5, 0.14, 1.7, [0, 0.25, 0]);
  const top = 0.32;

  // 항아리 배치: 뒷줄 큰 독, 가운데 항아리, 앞줄 단지
  const rows = [
    { z: -0.5, h: 1.02, r: 0.42, n: 4, dx: 0.62 },
    { z: 0.05, h: 0.72, r: 0.34, n: 5, dx: 0.5 },
    { z: 0.55, h: 0.46, r: 0.26, n: 6, dx: 0.42 },
  ];
  for (const row of rows) {
    const x0 = -((row.n - 1) * row.dx) / 2;
    for (let i = 0; i < row.n; i++) {
      const x = x0 + i * row.dx + (rng() - 0.5) * 0.05;
      const hs = row.h * (0.92 + rng() * 0.16);
      addOnggi(kit, x, top, row.z + (rng() - 0.5) * 0.06, hs, row.r * (0.94 + rng() * 0.12), rng, rng() > 0.15);
    }
  }
  const g = kit.build('jangdokdae');
  g.scale.setScalar(scale);
  return g;
}

// ── 우물 ────────────────────────────────────────────────────────
// 원형 돌우물 + 도르래 기둥(두 기둥·가로대·도르래·두레박).
export function buildWell({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());

  // 우물 돌(원형 켜쌓기)
  const H = 0.62;
  kit.cyl('granite', 0.74, 0.78, H, 12, [0, H / 2, 0], [0, 0, 0], 1, { open: true });
  kit.cyl('graniteDark', 0.6, 0.6, H, 12, [0, H / 2, 0], [0, 0, 0], 1, { open: true }); // 내벽
  kit.torus('graniteWarm', 0.7, 0.08, [0, H, 0], [Math.PI / 2, 0, 0], 1, 6, 14);         // 전(테)
  kit.cyl('water', 0.58, 0.58, 0.02, 12, [0, H * 0.55, 0]);                              // 수면

  // 도르래 기둥 두 개 + 가로대
  const px = 0.78, ph = 2.3;
  for (const s of [-1, 1]) kit.cyl('wood', 0.06, 0.07, ph, 7, [s * px, ph / 2, 0]);
  kit.cyl('wood', 0.05, 0.05, px * 2 + 0.2, 7, [0, ph, 0], [0, 0, Math.PI / 2]);          // 가로대
  kit.cyl('woodDark', 0.13, 0.13, 0.08, 12, [0, ph, 0], [Math.PI / 2, 0, 0]);             // 도르래
  // 두레박 + 줄
  kit.cyl('woodDark', 0.02, 0.02, 0.9, 5, [0.13, ph - 0.45, 0]);                          // 줄
  kit.cyl('wood', 0.12, 0.1, 0.24, 8, [0.13, ph - 1.0, 0]);                               // 두레박
  kit.torus('woodDark', 0.1, 0.015, [0.13, ph - 0.86, 0], [0, 0, 0], 1, 5, 10);           // 손잡이

  const g = kit.build('well');
  g.scale.setScalar(scale);
  return g;
}

// ── 디딤돌 길 ───────────────────────────────────────────────────
// 판석 열(자연석 디딤돌)이 살짝 어긋나며 이어짐. 인스턴싱 친화(단순 지오메트리).
// 돌은 지면에 얹지 않고 박아 앉힌다(beddedStone): 보이는 상면 높이는 그대로 두고 밑동만
//   지면 아래로 내린다. 예전에는 밑면이 배치면(site.heightAt)과 정확히 같은 평면에 놓여
//   4.7m² 가 완전 동일 depth 였고, 삼각분할된 지형 위에서는 절반이 뜨거나 잠겼다.
export function buildSteppingStones({ seed = 1, scale = 1, count = 7, spacing = 0.75 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const bed = sunkPrism(0.1);
  for (let i = 0; i < count; i++) {
    const z = i * spacing;
    const x = (rng() - 0.5) * 0.18;
    const r = 0.3 + rng() * 0.12;
    kit.cyl('granite', r, r * (0.9 + rng() * 0.2), bed.height, 6, [x, bed.center, z], [0, rng() * Math.PI, 0], [1, 1, 0.8 + rng() * 0.3]);
  }
  const g = kit.build('stepping-stones');
  g.scale.setScalar(scale);
  return g;
}

// ── 정원석(자연석) ─────────────────────────────────────────────
// 이끼 낀 큰 자연석 1~3덩이. flatShading 로우폴리 바위.
export function buildGardenRock({ seed = 1, scale = 1, count = 3 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  for (let i = 0; i < count; i++) {
    const r = 0.5 - i * 0.12;
    const mat = rng() > 0.5 ? 'graniteMoss' : 'granite';
    kit.geom(mat, boulderGeometry(rng, r, 1, 0.72),
      [(rng() - 0.5) * 1.0, r * 0.55, (rng() - 0.5) * 0.8], [0, rng() * Math.PI, 0]);
  }
  const g = kit.build('garden-rock');
  g.scale.setScalar(scale);
  return g;
}

// ── 석축(축대) ─────────────────────────────────────────────────
// 막돌 켜쌓기 낮은 축대 한 구간. 뒤로 물려 쌓아(배부름) 자연스러운 결.
export function buildStoneWall({ seed = 1, scale = 1, length = 3.2, courses = 3 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const courseH = 0.34;
  for (let c = 0; c < courses; c++) {
    const y = c * courseH;
    const batter = c * 0.06;                    // 위로 갈수록 뒤로 물림
    let x = -length / 2;
    const offset = (c % 2) * 0.18;              // 켜마다 어긋쌓기
    x += offset;
    while (x < length / 2) {
      const w = 0.4 + rng() * 0.35;
      kit.geom(rng() > 0.4 ? 'granite' : 'graniteDark', boulderGeometry(rng, courseH * 0.62, 1, 0.85),
        [x + w / 2, y + courseH / 2, -batter + (rng() - 0.5) * 0.05], [0, rng() * Math.PI, 0],
        [w / (courseH * 1.1), 1, 1]);
      x += w + 0.02;
    }
  }
  const g = kit.build('stone-wall');
  g.scale.setScalar(scale);
  return g;
}

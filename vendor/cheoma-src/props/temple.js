import { makeRng } from '../rng.js';
import { Kit } from './kit.js';
import { getPropMaterials } from './materials.js';
import { roofStoneGeometry } from './geom.js';

const lerp = (a, b, t) => a + (b - a) * t;

// 기단 면석의 우주·탱주(모서리·가운데 기둥) — 사방 면에 면과 거의 같은 평면의 얕은 돋을선(relief).
function pilasters(kit, w, h, y0) {
  const s = w * 0.1, e = w / 2, cy = y0 + h / 2, ph = h * 0.94;
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) kit.box('graniteDark', s, ph, 0.015, [sx * (e - s / 2), cy, sz * e]); // x면 우주
    kit.box('graniteDark', s * 0.8, ph, 0.015, [0, cy, sz * e]);                                     // x면 탱주
    for (const sx of [-1, 1]) kit.box('graniteDark', 0.015, ph, s, [sz * e, cy, sx * (e - s / 2)]);   // z면 우주
    kit.box('graniteDark', 0.015, ph, s * 0.8, [sz * e, cy, 0]);                                      // z면 탱주
  }
}

// ── 삼층/오층 석탑 ──────────────────────────────────────────────
// 기단 2층 + 탑신·옥개석 N층 + 상륜부. 옥개석은 넓고 얇으며 귀에서 살짝 들린다(전각 반전).
export function buildPagoda({ seed = 1, scale = 1, stories = 3 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const jitter = 0.97 + rng() * 0.06;

  // 기단부 (누적 y)
  let y = 0;
  kit.box('graniteWarm', 2.4 * jitter, 0.22, 2.4 * jitter, [0, y + 0.11, 0]); y += 0.22; // 지대석
  kit.box('granite', 1.95, 0.55, 1.95, [0, y + 0.275, 0]); pilasters(kit, 1.95, 0.55, y); y += 0.55; // 하층기단
  kit.box('graniteWarm', 2.15, 0.16, 2.15, [0, y + 0.08, 0]); y += 0.16;   // 하층 갑석
  kit.box('granite', 1.45, 0.6, 1.45, [0, y + 0.3, 0]); pilasters(kit, 1.45, 0.6, y); y += 0.6; // 상층기단
  kit.box('graniteWarm', 1.72, 0.16, 1.72, [0, y + 0.08, 0]); y += 0.16;   // 상층 갑석

  // 층별 탑신/옥개 치수 (체감률: 1층 탑신 크고, 위로 급감 / 옥개폭 완만 감소)
  const n = stories === 5 ? 5 : 3;
  const tiers = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const bodyW = lerp(1.02, 0.58, f) * (i === 0 ? 1 : 0.98);
    const bodyH = i === 0 ? 0.82 : lerp(0.44, 0.30, (i - 1) / Math.max(1, n - 2));
    const roofW = lerp(1.62, 0.98, f);
    tiers.push({ bodyW, bodyH, roofW });
  }

  for (const t of tiers) {
    kit.box('granite', t.bodyW, t.bodyH, t.bodyW, [0, y + t.bodyH / 2, 0]);
    y += t.bodyH;
    // 층급받침: 옥개 밑 계단식 3단(위로 넓어짐)
    const steps = 3, stepH = 0.052;
    for (let s = 0; s < steps; s++) {
      const sw = lerp(t.bodyW * 1.06, t.roofW * 0.82, s / (steps - 1));
      kit.box('granite', sw, stepH, sw, [0, y + stepH / 2, 0]);
      y += stepH;
    }
    const slopeH = t.roofW * 0.15;
    kit.geom('granite', roofStoneGeometry(t.roofW, { slopeH, crestFrac: 0.30, cornerLift: t.roofW * 0.05 }), [0, y, 0]);
    y += slopeH * 0.66; // 다음 탑신이 낙수면에 안김
  }

  // 상륜부
  y += 0.02;
  kit.box('graniteWarm', 0.34, 0.11, 0.34, [0, y + 0.055, 0]); y += 0.11;      // 노반
  kit.lathe('granite', [[0.001, 0], [0.19, 0], [0.21, 0.06], [0.16, 0.15], [0.08, 0.2], [0.001, 0.2]], 10, [0, y, 0]); y += 0.16; // 복발
  kit.cyl('graniteWarm', 0.20, 0.11, 0.06, 8, [0, y + 0.03, 0]); y += 0.06;    // 앙화
  for (let i = 0; i < 3; i++) { kit.cyl('granite', 0.14 - i * 0.03, 0.15 - i * 0.03, 0.05, 8, [0, y + 0.025, 0]); y += 0.08; } // 보륜
  kit.cyl('granite', 0.03, 0.03, 0.16, 6, [0, y + 0.08, 0]); y += 0.14;         // 찰주
  kit.sphere('graniteWarm', 0.1, [0, y + 0.05, 0]);                             // 보주

  const g = kit.build('pagoda');
  g.scale.setScalar(scale);
  return g;
}

// ── 석등 ────────────────────────────────────────────────────────
// 하대석·간주석·상대석(앙련)·화사석(화창 4방)·옥개석·보주. 화사석은 실제 창을 뚫어 불빛이 새어나온다.
export function buildStoneLantern({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const j = 0.97 + rng() * 0.06;

  let y = 0;
  kit.cyl('granite', 0.42 * j, 0.47 * j, 0.22, 8, [0, y + 0.11, 0], [0, Math.PI / 8, 0]); y += 0.22; // 하대석
  kit.cyl('graniteWarm', 0.30, 0.36, 0.10, 8, [0, y + 0.05, 0], [0, Math.PI / 8, 0]); y += 0.10;      // 하대 굄
  kit.cyl('granite', 0.11, 0.12, 0.78, 8, [0, y + 0.39, 0], [0, Math.PI / 8, 0]); y += 0.78;          // 간주석
  kit.cyl('granite', 0.40, 0.22, 0.2, 8, [0, y + 0.1, 0], [0, Math.PI / 8, 0]); y += 0.2;             // 상대석(앙련)

  // 화사석: 대각 4기둥 + 상하 판 → 정면 4방에 화창(빈 틈). 안쪽에 불빛.
  const chamH = 0.52, chamR = 0.30;
  kit.cyl('granite', 0.34, 0.36, 0.06, 8, [0, y + 0.03, 0], [0, Math.PI / 8, 0]);   // 바닥판
  const post = 0.11;
  for (const a of [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4]) {
    kit.box('granite', post, chamH, post, [Math.cos(a) * chamR, y + 0.06 + chamH / 2, Math.sin(a) * chamR], [0, -a + Math.PI / 4, 0]);
  }
  kit.box('lantern', 0.22, 0.34, 0.22, [0, y + 0.06 + chamH / 2, 0]);               // 불빛(자발광)
  y += 0.06 + chamH;
  kit.cyl('granite', 0.36, 0.34, 0.06, 8, [0, y + 0.03, 0], [0, Math.PI / 8, 0]); y += 0.06; // 천장판

  // 옥개석(팔각, 급한 낙수면) + 보주
  kit.geom('granite', roofStoneGeometry(0.9, { slopeH: 0.30, crestFrac: 0.16, cornerLift: 0.12 }), [0, y, 0]); y += 0.30;
  kit.cyl('granite', 0.05, 0.09, 0.08, 8, [0, y + 0.04, 0]); y += 0.08;
  kit.sphere('graniteWarm', 0.1, [0, y + 0.06, 0]);

  const g = kit.build('stone-lantern');
  g.scale.setScalar(scale);
  return g;
}

// ── 당간지주 ────────────────────────────────────────────────────
// 돌기둥 한 쌍 사이에 당간을 세우던 지주. 상부·중부에 간공(구멍)이 뚫린다.
export function buildDanggan({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const gap = 0.5 + rng() * 0.08;
  const H = 2.6, w = 0.34, d = 0.52;

  kit.box('graniteWarm', gap + w * 2 + 0.5, 0.2, d + 0.4, [0, 0.1, 0]); // 기단
  kit.box('granite', gap + 0.2, 0.16, d * 0.7, [0, 0.28, 0]);            // 당간 받침 복련석

  for (const s of [-1, 1]) {
    const x = s * (gap / 2 + w / 2);
    // 지주: 수직, 위로 갈수록 아주 살짝 좁아지고 꼭대기는 안쪽으로 둥글게 다듬음
    kit.box('granite', w, H, d, [x, 0.2 + H / 2, 0]);
    kit.box('granite', w * 0.9, 0.28, d, [x - s * w * 0.05, 0.2 + H - 0.02, 0], [0, 0, s * 0.25]); // 상단 둥근 어깨
    // 간공(당간을 끼우던 구멍): 안쪽 면에 어두운 홈 2개
    for (const hy of [0.2 + H * 0.88, 0.2 + H * 0.52]) {
      kit.box('dark', 0.1, 0.16, 0.14, [x - s * (w * 0.42), hy, 0]);
    }
  }
  const g = kit.build('danggan');
  g.scale.setScalar(scale);
  return g;
}

// ── 부도(종형) ──────────────────────────────────────────────────
// 승탑. 팔각 기단 위 종(鐘) 모양 탑신 + 보주.
export function buildBudo({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const j = 0.96 + rng() * 0.08;

  let y = 0;
  kit.cyl('graniteWarm', 0.5 * j, 0.55 * j, 0.18, 8, [0, y + 0.09, 0], [0, Math.PI / 8, 0]); y += 0.18; // 지대석
  kit.cyl('granite', 0.32, 0.42, 0.16, 8, [0, y + 0.08, 0], [0, Math.PI / 8, 0]); y += 0.16;             // 하대(복련)
  kit.cyl('granite', 0.3, 0.3, 0.14, 8, [0, y + 0.07, 0], [0, Math.PI / 8, 0]); y += 0.14;               // 중대석
  kit.cyl('granite', 0.42, 0.3, 0.14, 8, [0, y + 0.07, 0], [0, Math.PI / 8, 0]); y += 0.14;              // 상대(앙련)
  // 종형 탑신
  const bell = [
    [0.001, 0], [0.36, 0], [0.31, 0.14], [0.35, 0.34], [0.33, 0.58],
    [0.26, 0.76], [0.17, 0.9], [0.1, 0.97], [0.001, 1.0],
  ].map(([r, t]) => [r, t * 0.92]);
  kit.lathe('granite', bell, 12, [0, y, 0]); y += 0.92;
  kit.cyl('granite', 0.05, 0.09, 0.07, 8, [0, y + 0.02, 0]); y += 0.07;
  kit.sphere('graniteWarm', 0.11, [0, y + 0.07, 0]);                  // 보주

  const g = kit.build('budo');
  g.scale.setScalar(scale);
  return g;
}

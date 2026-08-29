import { makeRng } from '../rng.js';
import { Kit } from './kit.js';
import { getPropMaterials } from './materials.js';

// ── 낟가리 ──────────────────────────────────────────────────────
// 볏짚 원뿔 더미 + 둥근 꼭지 + 새끼줄 두름. 살짝 기울고 불규칙.
export function buildHaystack({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const H = 1.5 + rng() * 0.3, R = 0.85 + rng() * 0.15;
  const lean = (rng() - 0.5) * 0.06;
  kit.cyl('straw', 0.12, R, H, 12, [0, H / 2, 0], [lean, rng() * Math.PI, lean]);
  kit.sphere('straw', R * 0.32, [Math.sin(lean) * H, H * 0.98, 0], [1, 0.8, 1]); // 둥근 꼭지
  // 새끼줄 두름
  for (const t of [0.32, 0.6]) {
    kit.torus('rope', R * (1.02 - t * 0.55), 0.03, [Math.sin(lean) * H * t, H * t, 0], [Math.PI / 2, 0, 0], 1, 5, 14);
  }
  const g = kit.build('haystack');
  g.scale.setScalar(scale);
  return g;
}

// ── 절구 + 공이 ─────────────────────────────────────────────────
// 통나무 절구(속 파인) 옆에 공이가 비스듬히 기대어 있음.
export function buildMortarPestle({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  // 절구
  kit.cyl('wood', 0.34, 0.36, 0.5, 12, [0, 0.25, 0]);
  kit.cyl('woodDark', 0.3, 0.3, 0.5, 12, [0, 0.25, 0]);  // 겉 나이테 톤
  kit.cyl('dark', 0.22, 0.2, 0.4, 12, [0, 0.34, 0]);     // 파인 속(어둠)
  // 공이(기대어): 가는 자루 + 양끝 뭉툭
  const px = 0.5, py = 0.65, tilt = 0.5;
  kit.cyl('woodDark', 0.06, 0.06, 1.2, 8, [px, py, 0], [0, 0, tilt]);
  kit.cyl('wood', 0.09, 0.09, 0.16, 8, [px + Math.sin(tilt) * 0.6, py + Math.cos(tilt) * 0.6, 0], [0, 0, tilt]);
  kit.cyl('wood', 0.09, 0.09, 0.16, 8, [px - Math.sin(tilt) * 0.6, py - Math.cos(tilt) * 0.6, 0], [0, 0, tilt]);
  const g = kit.build('mortar-pestle');
  g.scale.setScalar(scale);
  return g;
}

// ── 지게 ────────────────────────────────────────────────────────
// A자 목재 등짐 지게. 두 다리 + 세장(가로대) + 작대기가 받쳐 비스듬히 섬.
export function buildJige({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const frame = new Kit(getPropMaterials());

  // 프레임(xy평면): 다리 아래 벌어지고 위로 모임
  const legLen = 1.55;
  for (const s of [-1, 1]) {
    frame.cyl('wood', 0.045, 0.06, legLen, 7, [s * 0.16, legLen / 2, 0], [0, 0, s * 0.11]);
    // 가지(등판 걸침) 뒤로 뻗음
    for (const [hy, len] of [[0.5, 0.3], [1.0, 0.34]]) {
      frame.cyl('woodDark', 0.03, 0.035, len, 6, [s * 0.24, hy, -len / 2], [Math.PI / 2 - 0.5, 0, 0]);
    }
  }
  // 세장(가로대)
  for (const hy of [0.35, 0.72, 1.08]) frame.cyl('woodDark', 0.035, 0.035, 0.5, 6, [0, hy, 0.01], [0, 0, Math.PI / 2]);
  // 멜빵(새끼줄)
  for (const s of [-1, 1]) frame.torus('rope', 0.22, 0.02, [s * 0.16, 0.8, -0.04], [0.2, 0, 0], 1, 5, 12, Math.PI);

  // 전체를 뒤로 살짝 눕혀 세움
  const fg = frame.build('jige-frame');
  fg.rotation.x = -0.28;
  fg.position.y = 0.06;
  const g = kit.build('jige');
  g.add(fg);
  // 작대기(받침 지팡이)
  const stick = new Kit(getPropMaterials());
  stick.cyl('wood', 0.03, 0.035, 1.3, 6, [0.02, 0.62, 0.5], [0.6, 0, 0]);
  g.add(stick.build('jige-stick'));
  g.scale.setScalar(scale);
  return g;
}

// ── 싸리 울타리 모듈 ────────────────────────────────────────────
// 기둥 + 가로대 사이에 싸리(가는 나뭇가지)를 촘촘히 세워 엮은 한 칸. 경계 따라 반복.
export function buildBrushFence({ seed = 1, scale = 1, width = 2.0 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const H = 1.25;
  // 기둥
  for (const s of [-1, 1]) kit.cyl('woodDark', 0.06, 0.07, H + 0.15, 7, [s * width / 2, (H + 0.15) / 2, 0]);
  // 가로대 2줄
  for (const hy of [0.35, 0.95]) kit.cyl('woodDark', 0.035, 0.035, width, 6, [0, hy, 0], [0, 0, Math.PI / 2]);
  // 싸리 세움대
  const n = Math.round(width / 0.1);
  for (let i = 0; i <= n; i++) {
    const x = -width / 2 + (i / n) * width;
    const h = H * (0.9 + rng() * 0.16);
    kit.cyl('woodLight', 0.014, 0.02, h, 5, [x, h / 2, (rng() - 0.5) * 0.03], [0, 0, (rng() - 0.5) * 0.04]);
  }
  const g = kit.build('brush-fence');
  g.scale.setScalar(scale);
  return g;
}

// ── 닭장 ────────────────────────────────────────────────────────
// 다리 위 작은 나무 우리. 앞은 살대(수직 창살), 옆·뒤는 널, 지붕은 볏짚.
export function buildChickenCoop({ seed = 1, scale = 1 } = {}) {
  const rng = makeRng(seed);
  const kit = new Kit(getPropMaterials());
  const W = 1.0, D = 0.72, floorY = 0.42, bodyH = 0.6;
  // 다리 4
  for (const s of [-1, 1]) for (const sz of [-1, 1]) kit.cyl('woodDark', 0.04, 0.05, floorY, 6, [s * (W / 2 - 0.1), floorY / 2, sz * (D / 2 - 0.1)]);
  // 바닥
  kit.box('wood', W, 0.08, D, [0, floorY, 0]);
  // 옆·뒤 널판
  kit.box('wood', 0.06, bodyH, D, [-W / 2, floorY + bodyH / 2, 0]);
  kit.box('wood', 0.06, bodyH, D, [W / 2, floorY + bodyH / 2, 0]);
  kit.box('wood', W, bodyH, 0.06, [0, floorY + bodyH / 2, -D / 2]);
  kit.box('dark', W - 0.12, bodyH - 0.1, 0.02, [0, floorY + bodyH / 2, D / 2 - 0.04]); // 앞 안쪽 어둠
  // 앞 살대
  const bars = 7;
  for (let i = 0; i <= bars; i++) kit.cyl('woodLight', 0.016, 0.016, bodyH, 5, [-W / 2 + 0.06 + (i / bars) * (W - 0.12), floorY + bodyH / 2, D / 2]);
  // 볏짚 지붕(맞배 두 면)
  const rh = 0.28;
  for (const s of [-1, 1]) kit.box('thatch', W + 0.2, 0.08, D * 0.62, [0, floorY + bodyH + rh / 2, s * D * 0.16], [s * -0.6, 0, 0]);
  kit.cyl('rope', 0.03, 0.03, W + 0.16, 6, [0, floorY + bodyH + rh, 0], [0, 0, Math.PI / 2]); // 용마루 새끼
  const g = kit.build('chicken-coop');
  g.scale.setScalar(scale);
  return g;
}

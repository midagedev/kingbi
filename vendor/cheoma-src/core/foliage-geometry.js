import * as THREE from 'three';

// 잎덩이(캐노피) 저폴리 어휘 — docs/tree-look.md §1 의 동양화 나무 조형 문법을 기하로 옮긴 것.
//   · 원리 ① 잎은 개체가 아니라 붓점의 군집이다 → 낱개 잎을 만들지 않고, 덩이의 표면을 불규칙하게
//     흔들어 붓점 군집의 리듬을 실루엣으로 대신한다.
//   · 원리 ② 원경은 형태를 잃고 포갠 점의 톤 덩어리가 된다 → 링 2단 요철 돔(foliageDome).
//   · 원리 ③ 소나무는 층으로 벌어진 잎덩이다 → 위도별 반경 프로파일로 층·허리를 만든다(PROFILE).
//   · 원리 ④ 먹은 실루엣에 몰리고 내부에 적다 → 캐노피 전체를 감싸는 구의 노멀을 전사한다
//     (bakeSphericalNormals). ink.js 의 내부 윤곽선은 노멀 Sobel 이므로 노멀이 연속해지면
//     캐노피 안쪽 폴리곤 필선이 셰이더 수정 없이 사라진다(docs/tree-look.md §3.3).
//
// 왜 20면체를 조각하는가: 링 1~2단으로 손수 만든 덩이는 같은 삼각 예산에서 측면 실루엣이 마름모·
//   결정처럼 읽힌다(A/B 실측: scratch trees/ab). 20면체는 20 삼각으로 구를 근사하는 최적해이므로,
//   그 정점을 위도별 반경 프로파일과 위치 기반 지터로 눌러 "둥글되 불규칙한 잎덩이"를 만든다.
//
// 비용 계약: 삼각형 수는 프리미티브가 그대로 정한다(ico 20, dome 4N). 호출부는 기존 프로토의
//   삼각 예산(forest-crunch.js PINE_TRIS/BROAD_TRIS/FAR_TRIS)과 XZ 반경(FOREST_VISUAL_RADIUS,
//   SCATTER_TREE_VISUAL_RADIUS)을 지켜야 한다 — 반경이 커지면 배치 수용 집합이 달라진다.
//   이 모듈은 position·normal 속성만 만든다(재질·드로우콜·프로그램 델타 0).

const TAU = Math.PI * 2;
// 20면체 정점의 위도(y/0.8507 정규화)는 -1, -0.618, 0, +0.618, +1 다섯 밴드뿐이다.
const ICO_LAT = 0.85065080835204;

// 위도별 반경 배율 프리셋. 키는 정규화 위도(-1=바닥 … +1=정수리)에서 보간한다.
//   pine  : 넓은 아래 층 → 허리 → 두 번째 층 → 좁은 정수리 = 층운형 2단(원리 ③).
//   broad : 거의 구형에 정수리만 눌린 뭉치(원리 ①의 지터가 덩이감을 만든다).
//   shrub : 낮고 둥근 무덤(관목).
//   (20면체 밴드의 기본 XZ 반경은 0.526 / 0.851 / 1.0 / 0.851 / 0.526 이므로, 프로파일을 곱한 뒤
//    XZ 정규화를 거친 실효 반경이 실루엣이다. pine 은 1.52 → 0.88 → 1.24 → 0.38 로 허리가 확실히
//    잡혀야 층이 읽힌다 — 얕은 허리는 그냥 통짜 덩어리로 보인다.)
export const FOLIAGE_PROFILE = Object.freeze({
  pine: Object.freeze([0.80, 1.05, 0.52, 0.86, 0.42]),
  broad: Object.freeze([0.90, 1.02, 1.00, 0.94, 0.78]),
  shrub: Object.freeze([0.95, 1.05, 1.00, 0.90, 0.70]),
});

// 20면체 정점 위도의 실제 knot: -1, -1/φ, 0, +1/φ, +1. 등간격(±0.5)으로 보간하면 authoring 값이
//   밴드에 정확히 실리지 않고 뭉개진다(허리가 사라져 통짜 덩어리로 렌더된 실측 원인).
const ICO_LAT_KNOTS = [-1, -0.6180339887498949, 0, 0.6180339887498949, 1];
function profileAt(profile, lat) {
  const n = Math.min(profile.length, ICO_LAT_KNOTS.length);
  if (lat <= ICO_LAT_KNOTS[0]) return profile[0];
  for (let i = 1; i < n; i++) {
    const a = ICO_LAT_KNOTS[i - 1], b = ICO_LAT_KNOTS[i];
    if (lat <= b) return profile[i - 1] + (profile[i] - profile[i - 1]) * ((lat - a) / (b - a));
  }
  return profile[n - 1];
}

// 잎덩이 한 덩이 — 20면체(20 삼각)를 위도 프로파일·위치 기반 지터로 조각한다.
//   ★ 지터는 정점 인덱스가 아니라 좌표의 함수여야 한다. 20면체는 비인덱스라 같은 공간 정점이
//     여러 삼각형에 중복되므로, 인덱스 기반 지터를 쓰면 면이 갈라진다.
//   ★ 조각 후 XZ 를 정규화해 최대 XZ 반경이 정확히 radius 가 되게 한다(배치 반경 계약).
//   inward: true 면 모든 정점이 같은 방향에서 원래 20면체 반경 "이내"에 머문다(프로파일 ≤1, 안쪽 지터,
//     lean·정규화 없음). 프로토 footprint 반경이 배치 수용 판정에 쓰이는 계층(마당 과실수 —
//     yardTreeCanopyRadius)은 이 모드를 써야 한다(회전도 생략). 반경이 방향에 따라 조금이라도 커지면 마당 나무가
//     과잉 기각돼 check:yard 의 PR #36 잔존율 계약이 깨진다(실측: 무보정 시 +0.17m, village:7 3/5).
export function foliageLeafMass({
  radius = 1,
  up = radius,
  down = radius,
  profile = FOLIAGE_PROFILE.broad,
  jitter = 0.14,
  phase = 0,
  lean = 0,          // 위로 갈수록 +x 로 기울기(굽은 축·비대칭 뭉치)
  spin = 0,
  inward = false,
  x = 0, y = 0, z = 0,
}) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  g.deleteAttribute('uv');
  // inward 모드는 회전도 생략한다 — 회전은 최대 반경 정점의 방향을 옮겨 덩이 오프셋과 겹치는 순간
  //   프로토 footprint 를 키운다(실측 +0.06m). 불규칙은 위치 기반 지터가 만든다.
  if (spin && !inward) g.rotateY(spin);
  const p = g.getAttribute('position');
  const count = p.count;
  const px = new Float32Array(count), py = new Float32Array(count), pz = new Float32Array(count);
  const tilt = inward ? 0 : lean;
  let maxR = 0;
  for (let i = 0; i < count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const lat = Math.max(-1, Math.min(1, vy / ICO_LAT));
    // 위치 기반 지터(중복 정점 일치 보장) — 두 주파수를 섞어 규칙적 파형을 피한다.
    const wave = 0.55 * Math.sin(3.10 * vx + 1.70 * vz + phase)
      + 0.45 * Math.cos(2.30 * vy - 1.10 * vx + 1.60 * vz + phase * 1.3);
    const j = inward ? 1 - jitter * (0.5 + 0.5 * wave) : 1 + jitter * wave;
    const prof = profileAt(profile, lat);
    const rad = radius * (inward ? Math.min(1, prof) : prof) * j;
    const ny = (vy >= 0 ? up : down) * (vy / ICO_LAT) * j;
    px[i] = vx * rad + tilt * (ny / Math.max(up, 1e-6));
    py[i] = ny;
    pz[i] = vz * rad;
    maxR = Math.max(maxR, Math.hypot(px[i], pz[i]));
  }
  // XZ 정규화: 조각·지터·lean 후의 실측 최대 반경을 정확히 radius 로 맞춘다(inward 모드는 생략 —
  //   정규화가 최대 반경을 다시 radius 로 밀어 올려 방향 종속 확대를 되살린다).
  const k = inward || maxR <= 1e-6 ? 1 : radius / maxR;
  for (let i = 0; i < count; i++) p.setXYZ(i, x + px[i] * k, y + py[i], z + pz[i] * k);
  p.needsUpdate = true;
  return g;
}

// 원경 수림 "포갠 점" 요철 돔 — 링 2단 + 위·아래 꼭지 = segments × 4 삼각형.
//   미점법(원리 ②)의 겹친 점 덩어리를 표면 요철로 암시한다. 상단 링을 옆으로 밀면 비대칭 매스가 되고,
//   upperSpin 으로 반 스텝 돌리면 평면 윤곽이 2N 각형처럼 잘게 흔들린다.
export function foliageDome({
  segments = 10,
  lowerRadius = 1,
  lowerRadii = null,
  lowerLift = null,
  lowerY = 0.4,
  upperRadius = 0.7,
  upperRadii = null,
  upperLift = null,
  upperY = 0.9,
  upperOffset = [0, 0],
  upperSpin = 0,
  top = 1.3,
  bottom = 0,
  spin = 0,
}) {
  const at = (arr, k, fallback) => (arr && arr.length ? arr[k % arr.length] : fallback);
  const n = Math.max(3, segments | 0);
  const lower = [], upper = [];
  for (let k = 0; k < n; k++) {
    const a = spin + (k / n) * TAU;
    const au = a + upperSpin;
    const cos = Math.cos(a), sin = Math.sin(a);
    const rl = lowerRadius * at(lowerRadii, k, 1);
    const ru = upperRadius * at(upperRadii, k, 1);
    lower.push([cos * rl, lowerY + lowerRadius * at(lowerLift, k, 0), sin * rl]);
    upper.push([
      upperOffset[0] + Math.cos(au) * ru,
      upperY + upperRadius * at(upperLift, k, 0),
      upperOffset[1] + Math.sin(au) * ru,
    ]);
  }
  const apex = [upperOffset[0] * 1.2, top, upperOffset[1] * 1.2];
  const base = [0, bottom, 0];
  const out = [];
  const push = (q) => { out.push(q[0], q[1], q[2]); };
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const a1 = lower[k], b1 = lower[k1], a2 = upper[k], b2 = upper[k1];
    // 바깥을 향하는 와인딩(three 기본 CCW front face).
    push(base); push(a1); push(b1);          // 아래 팬
    push(a1); push(b2); push(b1);            // 측면 밴드
    push(a1); push(a2); push(b2);
    push(apex); push(b2); push(a2);          // 위 팬
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return geometry;
}

// 구체 노멀 전사(Ghibli 폴리지 기법, docs/tree-look.md §2.2) — 캐노피 전체를 감싸는 구의 노멀을
//   정점에 굽는다. 개별 덩이가 하나의 둥근 매스처럼 셰이딩되고, 노멀 불연속이 사라져 수묵 모드의
//   내부 폴리곤 필선과 기본 모드의 패싯이 함께 소멸한다. 런타임 비용 0.
//   ★ 재질의 flatShading: true 는 프래그먼트 도함수로 노멀을 재계산해 이 노멀을 무효화한다 —
//     반드시 함께 끌 것(docs/tree-look.md §3.6-3).
//   ★ 덩이가 여러 개면 덩이별 중심이 아니라 매스 하나의 중심(canopyCenter)을 넘겨야 덩이 경계의
//     노멀 불연속까지 사라진다.
export function bakeSphericalNormals(geometry, center = null) {
  const position = geometry.getAttribute('position');
  if (!position) return geometry;
  let cx = 0, cy = 0, cz = 0;
  if (center) {
    cx = center.x ?? center[0] ?? 0;
    cy = center.y ?? center[1] ?? 0;
    cz = center.z ?? center[2] ?? 0;
  } else {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    cx = (box.min.x + box.max.x) * 0.5;
    cy = (box.min.y + box.max.y) * 0.5;
    cz = (box.min.z + box.max.z) * 0.5;
  }
  const count = position.count;
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const dx = position.getX(i) - cx, dy = position.getY(i) - cy, dz = position.getZ(i) - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      normals[i * 3] = dx / len; normals[i * 3 + 1] = dy / len; normals[i * 3 + 2] = dz / len;
    } else {
      normals[i * 3 + 1] = 1;
    }
  }
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

// 잎덩이 여러 개를 한 매스로 보고 구체 노멀을 전사할 때 쓰는 공통 중심(수관 무게중심 근사).
export function canopyCenter(lumps) {
  let sx = 0, sy = 0, sz = 0, sw = 0;
  for (const l of lumps) {
    const w = Math.max(1e-4, (l.radius ?? 1) ** 2);
    sx += (l.x || 0) * w; sy += (l.y || 0) * w; sz += (l.z || 0) * w; sw += w;
  }
  if (!sw) return { x: 0, y: 0, z: 0 };
  return { x: sx / sw, y: sy / sw, z: sz / sw };
}

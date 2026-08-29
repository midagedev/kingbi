// Pure, renderer-independent layout contract for the hard objects that share a
// parcel yard with fruit trees. `walls.js` consumes the placement helpers while
// `gardens.js` consumes the matching obstacle footprints. Keeping the arithmetic
// here prevents a visually harmless renderer refactor from silently moving a shed
// or jar platform through an already accepted tree.

import * as G from '../core/math/geom2.js';
import {
  parcelEffectiveRoofBounds,
  parcelLocalBodyPolygons,
} from './house-footprint.js';
import {
  localCanopyBlocksSolarAccess,
  parcelHouseTranslation,
} from './parcel-contract.js';
import { VILLAGE_SOLID_WALL_THICKNESS } from './wall-contract.js';
import { auxiliaryHardObstacle } from './auxiliary-building-plan.js';

export const YARD_HARD_GAP = 0.12;
// 소품이 벽체 질량을 관통하지 않게 하는 몸채 이격. 처마(지붕) 아래 배치는 허용한다.
export const YARD_BODY_GAP = YARD_HARD_GAP;
export const YARD_LIFE_MAX_HEIGHT = 1.2;

// 장독 항아리 군집 계약 — walls.js#makeYardProps 의 JAR_GEO(SphereGeometry R) 와 동일.
// js ∈ [JS_MIN, JS_MIN+JS_SPAN] 이라 최대 반경 = R·JS_MAX. 플랫폼·피치는 이 상한으로
// 고정해 인접 항아리 침투와 단 밖 돌출을 결정론적으로 금지한다(실측 스케일과 무관).
export const JANGDOK_JAR_R = 0.3;
export const JANGDOK_JAR_JS_MIN = 0.62;
export const JANGDOK_JAR_JS_SPAN = 0.7;
export const JANGDOK_JAR_JS_MAX = JANGDOK_JAR_JS_MIN + JANGDOK_JAR_JS_SPAN;
export const JANGDOK_JAR_GAP = 0.06;
export const JANGDOK_JAR_MAX_R = JANGDOK_JAR_R * JANGDOK_JAR_JS_MAX;
export const JANGDOK_JAR_PITCH = 2 * JANGDOK_JAR_MAX_R + JANGDOK_JAR_GAP;
export const JANGDOK_JAR_INSET = JANGDOK_JAR_MAX_R;

const JAR_OVERHANG = 0.12;
const GARDEN_STONE_MARGIN = 0.08;
const YARD_LIFE_WALL_GAP = 0.18;
const HEDGE_MAX_BLOB_RADIUS = 0.70;
const HEDGE_MAX_NORMAL_JITTER = 0.04;
// `walls.js#makeHedgeRun` places at most 0.70m-radius blobs with ±0.04m
// normal jitter. Yard-life footprints therefore reserve that whole inward
// vegetation band plus the shared hard-object breathing room.
export const YARD_HEDGE_INWARD_CLEARANCE =
  HEDGE_MAX_BLOB_RADIUS + HEDGE_MAX_NORMAL_JITTER + YARD_HARD_GAP;
const YARD_LIFE_ROOF_GAP = 0.22;
const YARD_LIFE_GATE_GAP = 0.82;

export function yardLifeWallInwardClearance(style = 'stone') {
  if (style === 'hedge') return YARD_HEDGE_INWARD_CLEARANCE;
  const solidThickness = VILLAGE_SOLID_WALL_THICKNESS[style] || 0;
  return Math.max(YARD_LIFE_WALL_GAP, solidThickness * 0.5 + YARD_HARD_GAP);
}

function rectangle(kind, mode, x, z, halfWidth, halfDepth) {
  return { kind, mode, shape: 'rect', x, z, halfWidth, halfDepth };
}

function circle(kind, mode, x, z, radius) {
  return { kind, mode, shape: 'circle', x, z, radius };
}

// ── 마당 소품은 직사각형이 아니라 실제 필지 폴리곤에 앉는다 ────────────────────────
// 담(walls.js)은 parcel.shape 를 따르는데 소품 좌표는 plotW×plotD 직사각형에서 나왔다.
// parcels.js#localParcelShape 의 전단(lean ≤0.22·plotW)·뒷변 오므림(변당 ≤0.105·plotW)·
// 뒤깊이 지터(≤0.18·plotD)는 모두 필지 크기에 비례하므로 저작 슬롯의 상수 0.5m 인셋이
// 흡수할 수 없다. 사용자 지시 "장독대가 자꾸 마당 밖으로 삐져나온다" 의 정확한 기제다.
//   측정(seed 7·11, hamlet~capital, 폴리곤 point-in-poly): 장독대 47~53% · 낟가리 42~67% ·
//   빨래줄 8~43% 가 담 밖(최대 2.9m), 그리고 소품 대부분이 실제 지붕 사각형과 겹쳤다.
//   장독대가 유독 나쁜 이유는 규칙이 그 구석만 틀렸기 때문이 아니라, 뒤안 좌측이 bnL 이
//   집어넣는 바로 그 구석이라서다 — 규칙 전체를 고친다.
// 계약: 저작 슬롯을 순서 있는 후보 목록의 첫 항으로 두고, 각 후보를 실제 폴리곤·담 두께
//   안쪽의 가장 가까운 유효점으로 투영한 뒤 지붕·앞서 확정된 소품과의 간섭을 검사한다.
//   통과하는 첫 후보를 쓰고, 어느 후보도 못 앉으면 소품은 잘리지 않고 생략된다("잘 정돈"
//   은 낀 소품보다 빈 자리를 뜻한다). 결정론: rng 미소비 — 순수 기하만 쓴다.
const YARD_SLOT_EPS = 1e-6;
// walls.js#makeYardProps 가 뽑는 낟가리 반경 상한. 저작 슬롯 x/z 가 반경 종속이라
// 예약 봉투(stackObstacle)는 이 상한으로 고정되고, 렌더는 그 봉투 안에서만 흔들린다.
const YARD_STACK_MAX_RADIUS = 1.05;
// walls.js#makeYardProps: ang = (rng()-0.5)·0.5 → |ang| ≤ 0.25rad. 널린 천 폭 0.42.
const CLOTHESLINE_MAX_SIN = Math.sin(0.25);
const CLOTHESLINE_PAD = 0.28;
const CLOTH_HALF_WIDTH = 0.21;

// 볼록 필지의 각 변을 "소품 봉투가 안쪽으로 들어가야 하는" half-plane 으로 바꾼다.
//   n·p ≥ n·a + support + clearance,  support = halfX·|n.x| + halfZ·|n.z|
function yardInwardPlanes(points, halfX, halfZ, clearance) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }), { x: 0, z: 0 });
  center.x /= points.length;
  center.z /= points.length;
  const planes = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length <= YARD_SLOT_EPS) continue;
    let nx = dz / length, nz = -dx / length;
    if (nx * (center.x - a.x) + nz * (center.z - a.z) < 0) { nx = -nx; nz = -nz; }
    const support = halfX * Math.abs(nx) + halfZ * Math.abs(nz);
    planes.push({ nx, nz, limit: nx * a.x + nz * a.z + support + clearance });
  }
  return planes;
}

const yardPlanesContain = (point, planes) =>
  planes.every((plane) => plane.nx * point.x + plane.nz * point.z >= plane.limit - YARD_SLOT_EPS);

function yardPlanePair(left, right) {
  const det = left.nx * right.nz - right.nx * left.nz;
  if (Math.abs(det) <= YARD_SLOT_EPS) return null;
  return {
    x: (left.limit * right.nz - right.limit * left.nz) / det,
    z: (left.nx * right.limit - right.nx * left.limit) / det,
  };
}

// 볼록 유효영역 안에서 저작 슬롯에 가장 가까운 점. 볼록집합에 대한 점의 투영은 자기 자신,
// 한 변으로의 수선발, 또는 두 변의 교점 중 하나이므로 표본추출이 없다
// (house-footprint.js#closestFitTranslation 과 같은 논법). null = 유효영역 없음.
export function resolveYardSlot(points, preferred, halfX, halfZ, clearance = 0) {
  if (!points || points.length < 3) return { x: preferred.x, z: preferred.z };
  const planes = yardInwardPlanes(points, halfX, halfZ, Math.max(0, clearance));
  if (planes.length < 3) return { x: preferred.x, z: preferred.z };
  if (yardPlanesContain(preferred, planes)) return { x: preferred.x, z: preferred.z };
  const candidates = [];
  for (let i = 0; i < planes.length; i++) {
    const plane = planes[i];
    const slack = plane.limit - (plane.nx * preferred.x + plane.nz * preferred.z);
    candidates.push({ x: preferred.x + plane.nx * slack, z: preferred.z + plane.nz * slack });
    for (let j = i + 1; j < planes.length; j++) {
      const corner = yardPlanePair(plane, planes[j]);
      if (corner) candidates.push(corner);
    }
  }
  let best = null, bestDistance = Infinity;
  for (const candidate of candidates) {
    if (!yardPlanesContain(candidate, planes)) continue;
    const distance = (candidate.x - preferred.x) ** 2 + (candidate.z - preferred.z) ** 2;
    if (distance < bestDistance - YARD_SLOT_EPS
      || (Math.abs(distance - bestDistance) <= YARD_SLOT_EPS && best
        && (candidate.x < best.x - YARD_SLOT_EPS
          || (Math.abs(candidate.x - best.x) <= YARD_SLOT_EPS && candidate.z < best.z)))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

const yardBoxesOverlap = (a, b, gap) =>
  Math.abs(a.x - b.x) < a.halfX + b.halfX + gap && Math.abs(a.z - b.z) < a.halfZ + b.halfZ + gap;

// 히어로(종가·관아)는 rectangularParcelShape 라 담과 직사각형이 정의상 일치하고, 실제 평면도
// impostor 명세가 아닌 컴파운드다. 그래서 히어로는 저작 슬롯을 그대로 쓴다(측정 이탈 0건).
// 일반 주거는 필지 폴리곤 안쪽에 앉히되, 지붕 아래(처마)는 허용하고 벽체 몸채만 배제한다.
// 별채(광)는 auxiliary-building-plan 이 전체 지붕 clearance 를 유지한다 — 여기 몸채 규칙으로
// 완화하지 않는다.
function yardPlacementContext(parcel) {
  const hero = !!parcel?.hero;
  const points = hero ? null : (parcel?.shape?.pts || null);
  return {
    points,
    clearance: yardLifeWallInwardClearance(parcel?.wallType),
    taken: [],
    bodies: hero ? [] : parcelLocalBodyPolygons(parcel),
  };
}

function yardBoxPolygon(box) {
  return [
    { x: box.x - box.halfX, z: box.z - box.halfZ },
    { x: box.x + box.halfX, z: box.z - box.halfZ },
    { x: box.x + box.halfX, z: box.z + box.halfZ },
    { x: box.x - box.halfX, z: box.z + box.halfZ },
  ];
}

function yardBoxClearsBodies(box, bodies, gap = YARD_BODY_GAP) {
  if (!bodies?.length) return true;
  const polygon = yardBoxPolygon(box);
  for (const body of bodies) {
    if (!body?.length) continue;
    if (polygonDistance(polygon, body) <= gap) return false;
  }
  return true;
}

// 소품은 처마(지붕) 아래를 허용하되 벽체 질량을 관통하면 안 된다. 몸채 전면 배제(지붕까지
// 금)는 소품을 열린 마당으로 밀어 별채를 굶겼다. 몸채만 배제하면 처마 밑 자리가 남고
// 별채 하한(≥100)을 지킬 수 있다.
function placeYardObject(context, candidates, halfX, halfZ) {
  const authored = candidates[0];
  if (!context.points) return { x: authored.x, z: authored.z, placed: true };
  for (const candidate of candidates) {
    const point = resolveYardSlot(context.points, candidate, halfX, halfZ, context.clearance);
    if (!point) continue;
    const box = { x: point.x, z: point.z, halfX, halfZ };
    if (context.taken.some((other) => yardBoxesOverlap(box, other, YARD_HARD_GAP))) continue;
    if (!yardBoxClearsBodies(box, context.bodies, YARD_BODY_GAP)) continue;
    context.taken.push(box);
    return { x: point.x, z: point.z, placed: true };
  }
  return { x: authored.x, z: authored.z, placed: false };
}

// 텃밭·빨래줄처럼 "치수가 저작값이 아니라 살림 규모의 표현"인 소품은 이동만으로는 좁은 마당에
// 못 앉는다(측정: 개방 마당 텃밭 24%·빨래줄 69% 만 배치). 이랑 몇 줄짜리 텃밭이나 짧은 빨래줄은
// 고증상 그대로 유효하므로, 전 크기로 모든 후보를 먼저 시도한 뒤 단계적으로 줄이고, 마지막
// 단계에서도 못 앉으면 생략한다. 잘라 넣는(clip) 경로는 없다.
// 몸채 배제 후에도 처마 밑·앞마당 가장자리 후보가 남도록 0.40 단계까지 줄인다.
const YARD_SHRINK_STEPS = Object.freeze([1, 0.82, 0.66, 0.52, 0.40]);

function placeSizedYardObject(context, candidates, halfX, halfZ, steps = YARD_SHRINK_STEPS) {
  for (const scale of steps) {
    const at = placeYardObject(context, candidates, halfX * scale, halfZ * scale);
    if (at.placed) return { ...at, scale };
  }
  return { x: candidates[0].x, z: candidates[0].z, placed: false, scale: steps[steps.length - 1] };
}

// 마당 소품 최종 배치의 단일 진실원. 렌더(walls.js)와 예약(yardHardObstacles)이 같은 이
// 함수를 소비해야 담·나무·부속채·픽킹이 서로 다른 좌표를 추정하지 않는다. 해석 대상 집합은
// parcel 필드만으로 결정되므로(스타일별 렌더 생략과 무관) 두 소비처의 순서가 어긋날 수 없다.
export function yardHardPlacements(parcel) {
  const plotW = parcel.plotW, plotD = parcel.plotD;
  const halfW = plotW / 2, halfD = plotD / 2;
  const context = yardPlacementContext(parcel);
  const out = {};

  // 1) 장독대 — 살림의 중심이라 먼저 자리를 잡는다(뒤안 좌 → 뒤안 우 → 측면 → 앞마당 좌).
  const jangdok = yardJangdokLayout(plotW, plotD, parcel.jangdok || 0);
  if (jangdok.rows > 0) {
    const halfX = jangdok.width / 2 + JAR_OVERHANG;
    const halfZ = jangdok.depth / 2 + JAR_OVERHANG;
    const at = placeYardObject(context, [
      { x: jangdok.x, z: jangdok.z },
      { x: -jangdok.x, z: jangdok.z },
      { x: jangdok.x, z: -plotD * 0.06 },
      { x: jangdok.x, z: plotD * 0.26 },
    ], halfX, halfZ);
    out.jangdok = { ...jangdok, x: at.x, z: at.z, placed: at.placed, halfX, halfZ };
  } else out.jangdok = null;

  // 2) 낟가리 — 뒤안 우(부속채와 배타). 예약은 반경 상한 봉투, 렌더는 그 안에서만 흔들린다.
  if (parcel.yardStack && !parcel.aux) {
    const half = YARD_STACK_MAX_RADIUS;
    const authored = { x: halfW - 1.65, z: -halfD + 1.75 };
    const at = placeYardObject(context, [
      authored,
      { x: -authored.x, z: authored.z },
      { x: authored.x, z: -plotD * 0.06 },
      { x: authored.x, z: plotD * 0.24 },
    ], half, half);
    out.stack = { x: at.x, z: at.z, placed: at.placed, maxRadius: half };
  } else out.stack = null;

  // 3) 빨래줄 — 앞마당 좌. 짧은 빨래줄도 살림으로 유효하므로 좁은 마당에서는 span 을 줄인다.
  //    예약 봉투: walls.js 의 각도는 (rng()-0.5)·0.5 라 |ang| ≤ 0.25rad 로 유계다. 회전 무관 원
  //    (반경 span/2+0.28)은 그 유계 각을 3.5배 과예약해(13.6㎡ vs 7.8㎡) 실제로 광(부속채)이
  //    들어갈 자리를 빨래줄 한 줄이 삼켰다 — 측정에서 광 거절 원인 1위. 실제 유계 봉투로 바꾼다.
  if (parcel.clothesline) {
    const line = yardClotheslineLayout(plotW, plotD, 0);
    const halfX = line.span / 2 + CLOTHESLINE_PAD;
    const halfZ = line.span / 2 * CLOTHESLINE_MAX_SIN + CLOTHESLINE_PAD + CLOTH_HALF_WIDTH;
    // 몸채 날개(ㄱ·ㄷ)가 앞마당 옆을 먹을 수 있어 대문 쪽·중앙 후보를 더 둔다.
    const at = placeSizedYardObject(context, [
      { x: line.x, z: line.z },
      { x: -line.x, z: line.z },
      { x: line.x, z: plotD * 0.34 },
      { x: -line.x, z: plotD * 0.34 },
      { x: line.x, z: plotD * 0.42 },
      { x: -line.x, z: plotD * 0.42 },
      { x: 0, z: plotD * 0.36 },
      { x: plotW * 0.22, z: plotD * 0.40 },
      { x: -plotW * 0.22, z: plotD * 0.40 },
    ], halfX, halfZ);
    out.clothesline = {
      span: line.span * at.scale,
      height: line.height,
      x: at.x, z: at.z, placed: at.placed,
      halfX: halfX * at.scale, halfZ: halfZ * at.scale,
    };
  } else out.clothesline = null;

  // 4) 텃밭(앞마당 우) / 개방 마당 텃밭(앞마당 좌). 이랑 몇 줄로 줄어도 텃밭이다.
  const sizedPatch = (patch, candidates) => {
    const at = placeSizedYardObject(context, candidates, patch.width / 2, patch.depth / 2);
    return {
      ...patch,
      width: patch.width * at.scale,
      depth: patch.depth * at.scale,
      x: at.x, z: at.z, placed: at.placed,
    };
  };
  // 개방 마당(open)은 walls.js 가 vegBed 를 렌더하지 않고 개방 마당 텃밭만 세운다. 예약도 같아야
  // 한다 — 안 그러면 렌더되지 않는 텃밭이 실제로 세워지는 개방 마당 텃밭의 자리를 먼저 차지한다.
  const openYard = (parcel.wallType || 'stone') === 'open';
  if (parcel.vegBed && !openYard) {
    const patch = yardGardenPatchLayout(plotW, plotD, plotW * 0.3, plotD * 0.1);
    out.vegBed = sizedPatch(patch, [
      { x: patch.x, z: patch.z },
      { x: -patch.x, z: patch.z },
      { x: patch.x, z: plotD * 0.38 },
      { x: -plotW * 0.2, z: plotD * 0.38 },
      { x: plotW * 0.28, z: plotD * 0.42 },
      { x: -plotW * 0.28, z: plotD * 0.42 },
      { x: plotW * 0.15, z: plotD * 0.32 },
      { x: 0, z: plotD * 0.40 },
    ]);
  } else out.vegBed = null;

  if (openYard) {
    const patch = yardGardenPatchLayout(plotW, plotD);
    out.openGarden = sizedPatch(patch, [
      { x: patch.x, z: patch.z },
      { x: -patch.x, z: patch.z },
      { x: patch.x, z: plotD * 0.30 },
      { x: plotW * 0.2, z: plotD * 0.30 },
      { x: -plotW * 0.2, z: plotD * 0.30 },
      { x: plotW * 0.28, z: plotD * 0.40 },
      { x: -plotW * 0.28, z: plotD * 0.40 },
      { x: 0, z: plotD * 0.36 },
    ]);
  } else out.openGarden = null;

  return out;
}

// Platform size that fits `perRow` max-radius jars along X and `rows` along Z
// with edge inset = max jar radius and centre pitch = JANGDOK_JAR_PITCH.
export function jangdokPlatformWidth(perRow) {
  const n = Math.max(1, perRow | 0);
  return 2 * JANGDOK_JAR_INSET + Math.max(0, n - 1) * JANGDOK_JAR_PITCH;
}

export function jangdokPlatformDepth(rows) {
  const r = Math.max(0, rows | 0);
  if (r <= 0) return 0;
  return 2 * JANGDOK_JAR_INSET + Math.max(0, r - 1) * JANGDOK_JAR_PITCH;
}

export function yardJangdokLayout(plotW, plotD, level) {
  const rows = Math.max(0, level | 0);
  const perRow = 2 + rows;
  // 예약 봉투 = 실제 돌단. 예전 min(plotW·0.4, perRow·0.62+0.4) / rows·0.56+0.3 는
  // 최대 항아리 지름(~0.79m)보다 좁은 피치·0.3m 가장자리 인셋을 낳아 침투·돌출이 났다.
  const width = jangdokPlatformWidth(perRow);
  const depth = jangdokPlatformDepth(rows);
  return {
    rows,
    perRow,
    width,
    depth,
    x: -plotW / 2 + width / 2 + 0.5,
    z: -plotD / 2 + depth / 2 + 0.5,
  };
}

// Pure jar-centre plan for a platform (local origin at platform centre). Uses the
// same front-row / tapering-back-row grammar as walls.js#makeYardProps; radii are
// the conservative max so a gate can assert no overlap / no overhang without RNG.
export function jangdokJarCentres(rows, perRow, width, depth) {
  const rCount = Math.max(0, rows | 0);
  const basePerRow = Math.max(1, perRow | 0);
  const platW = width ?? jangdokPlatformWidth(basePerRow);
  const platD = depth ?? jangdokPlatformDepth(rCount);
  const out = [];
  for (let r = 0; r < rCount; r++) {
    const n = Math.max(1, basePerRow - r);
    for (let c = 0; c < n; c++) {
      const x = n === 1
        ? 0
        : (-platW / 2 + JANGDOK_JAR_INSET + c * (platW - 2 * JANGDOK_JAR_INSET) / (n - 1));
      const z = -platD / 2 + JANGDOK_JAR_INSET + r * JANGDOK_JAR_PITCH;
      out.push({ x, z, radius: JANGDOK_JAR_MAX_R });
    }
  }
  return out;
}

export function yardClotheslineLayout(plotW, plotD, angle) {
  const span = Math.min(plotW * 0.44, 3.6);
  return {
    span,
    height: 1.7,
    angle,
    x: -plotW * 0.25,
    z: plotD * 0.225,
    dx: Math.cos(angle),
    dz: Math.sin(angle),
  };
}

export function yardGardenPatchLayout(plotW, plotD, offsetX = 0, offsetZ = 0) {
  return {
    width: Math.min(plotW * 0.46, 4.6),
    depth: Math.min(plotD * 0.3, 3.4),
    x: -plotW * 0.16 + offsetX,
    z: plotD * 0.18 + offsetZ,
  };
}

export function yardHwagyePosition(parcel, x, hero = parcel.hero) {
  return { x, z: -parcel.plotD * (hero ? 0.45 : 0.425) };
}

// 반가 점경물도 같은 폴리곤 계약을 쓴다. 히어로는 직사각 필지라 저작 좌표를 그대로 둔다.
// 저작 z(-0.25·plotD)는 본채가 앉는 띠라 좁은 필지에서는 처마 밑이 된다 — 후보 2번(사랑마당)·
// 3번(뒤안 깊이)이 실제 여유가 있는 쪽으로 결정론적으로 옮긴다.
const GWAESEOK_ENVELOPE = 0.5 + GARDEN_STONE_MARGIN;
const SEOKJI_ENVELOPE = 0.58 + GARDEN_STONE_MARGIN;

// null = 어느 후보도 이 필지에 못 앉는다. 호출자(gardens.js·gardenHardObstacles)는 점경물을
// 생략해야 하며, 저작 좌표로 폴백하면 안 된다 — 그 폴백이 남아 있는 동안 잔여 이탈 9건이
// 전부 괴석이었다(town~hanyang 4시드, 0.03~0.28m).
function placeGardenStone(parcel, candidates, envelope, reserved = []) {
  const context = yardPlacementContext(parcel);
  context.taken.push(...reserved);
  const at = placeYardObject(context, candidates, envelope, envelope);
  return at.placed ? { x: at.x, z: at.z } : null;
}

export function yardGwaeseokPosition(parcel, side, hero = parcel.hero) {
  const authored = {
    x: side * parcel.plotW * (hero ? 0.25 : 0.29),
    z: -parcel.plotD * (hero ? 0.43 : 0.25),
  };
  if (hero) return authored;
  return placeGardenStone(parcel, [
    authored,                                                            // 뒤안 측(저작)
    { x: authored.x, z: parcel.plotD * 0.30 },                           // 사랑마당 측
    { x: side * parcel.plotW * 0.33, z: -parcel.plotD * 0.42 },          // 뒤안 깊이
    { x: side * parcel.plotW * 0.33, z: parcel.plotD * 0.38 },           // 앞담 안쪽 모서리
  ], GWAESEOK_ENVELOPE);
}

export function yardSeokjiPosition(parcel, side, hero = parcel.hero) {
  const rock = yardGwaeseokPosition(parcel, side, hero);
  if (!rock) return null;
  if (hero) return { x: rock.x - side * 1.2, z: -parcel.plotD * 0.41 };
  // 석지는 괴석과 한 짝이라 자리를 확정한 괴석 주위를 돈다. 저작 오프셋을 첫 후보로 두고,
  // 남은 궤도(반대쪽 축·바깥쪽)를 순서대로 시도한다 — 궤도 후보 없이 저작 오프셋만 쓰면
  // 좁은 필지에서 석지 유지율이 326→36 으로 떨어졌다(4시드 hanyang 측정).
  const authored = { x: rock.x - side * 1.1, z: rock.z + 1.0 };
  return placeGardenStone(parcel, [
    authored,
    { x: rock.x - side * 1.1, z: rock.z - 1.0 },
    { x: rock.x, z: rock.z + 1.5 },
    { x: rock.x, z: rock.z - 1.5 },
    { x: rock.x + side * 1.5, z: rock.z },
  ], SEOKJI_ENVELOPE, [{ x: rock.x, z: rock.z, halfX: GWAESEOK_ENVELOPE, halfZ: GWAESEOK_ENVELOPE }]);
}

function gardenHardObstacles(parcel, { exact = false, side = 1, hwagyeX = 0 } = {}) {
  const level = parcel.gardenLevel || 0;
  if (!parcel.hero && level < 2) return [];
  const hero = !!parcel.hero;
  const sides = exact ? [side] : [-1, 1];
  const out = [];

  if (hero || level >= 3) {
    const position = yardHwagyePosition(parcel, exact ? hwagyeX : 0, hero);
    out.push(rectangle(
      'hwagye', 'trunk',
      position.x,
      position.z - 0.26,
      1.3 + (exact ? 0 : 1),
      0.54 + GARDEN_STONE_MARGIN,
    ));
  }
  for (const gardenSide of sides) {
    // 못 앉는 점경물은 예약하지 않는다 — 렌더도 생략하므로 그 자리는 마당나무가 다시 쓸 수 있다.
    const rock = yardGwaeseokPosition(parcel, gardenSide, hero);
    if (rock) out.push(circle('gwaeseok', 'trunk', rock.x, rock.z, GWAESEOK_ENVELOPE));
    if (hero || level >= 3) {
      const pond = yardSeokjiPosition(parcel, gardenSide, hero);
      if (pond) out.push(circle('seokji', 'trunk', pond.x, pond.z, SEOKJI_ENVELOPE));
    }
  }
  return out;
}

export function yardHardObstacles(parcel, gardenOptions) {
  const out = [];

  const auxiliary = auxiliaryHardObstacle(parcel.auxiliary);
  if (auxiliary) out.push(auxiliary);

  // 예약 좌표는 렌더와 같은 폴리곤 해석 결과를 읽는다. 앉을 자리를 못 찾아 생략된 소품은
  // 렌더되지 않으므로 마당나무·부속채가 빈 자리를 다시 쓸 수 있어야 한다(placed=false → 미예약).
  const placements = yardHardPlacements(parcel);

  const jangdok = placements.jangdok;
  if (jangdok?.placed) {
    out.push(rectangle('jangdok', 'trunk', jangdok.x, jangdok.z, jangdok.halfX, jangdok.halfZ));
  }

  const stack = placements.stack;
  if (stack?.placed) {
    // 렌더 반경은 [0.7, 1.05] 표본이다. 이 사각형은 그 모든 원의 정확한 XZ 봉투이며
    // 담 RNG 를 소비하지 않는다.
    out.push(rectangle('yard-stack', 'canopy', stack.x, stack.z, stack.maxRadius, stack.maxRadius));
  }

  const line = placements.clothesline;
  if (line?.placed) out.push(rectangle('clothesline', 'canopy', line.x, line.z, line.halfX, line.halfZ));

  const vegBed = placements.vegBed;
  if (vegBed?.placed) {
    out.push(rectangle('vegetable-bed', 'trunk', vegBed.x, vegBed.z, vegBed.width / 2, vegBed.depth / 2));
  }
  const openGarden = placements.openGarden;
  if (openGarden?.placed) {
    out.push(rectangle('open-garden', 'trunk', openGarden.x, openGarden.z, openGarden.width / 2, openGarden.depth / 2));
  }

  out.push(...gardenHardObstacles(parcel, gardenOptions));
  return out;
}

export function yardCircleIntersectsHardObstacle(point, radius, obstacles, gap = YARD_HARD_GAP) {
  const safeRadius = Math.max(0, Number.isFinite(radius) ? radius : 0);
  const safeGap = Math.max(0, Number.isFinite(gap) ? gap : 0);
  for (const obstacle of obstacles || []) {
    if (obstacle.shape === 'polygon') {
      const points = obstacle.points || [];
      if (points.length >= 3 && (
        G.pointInPoly(point, points)
        || points.some((edge, index) =>
          G.distToSeg(point, edge, points[(index + 1) % points.length]).d <= safeRadius + safeGap)
      )) return true;
      continue;
    }
    if (obstacle.shape === 'circle') {
      if (Math.hypot(point.x - obstacle.x, point.z - obstacle.z)
        <= safeRadius + safeGap + obstacle.radius) return true;
      continue;
    }
    const dx = point.x < obstacle.x - obstacle.halfWidth
      ? obstacle.x - obstacle.halfWidth - point.x
      : point.x > obstacle.x + obstacle.halfWidth
        ? point.x - obstacle.x - obstacle.halfWidth : 0;
    const dz = point.z < obstacle.z - obstacle.halfDepth
      ? obstacle.z - obstacle.halfDepth - point.z
      : point.z > obstacle.z + obstacle.halfDepth
        ? point.z - obstacle.z - obstacle.halfDepth : 0;
    if (Math.hypot(dx, dz) <= safeRadius + safeGap) return true;
  }
  return false;
}

function circleIntersectsRectangle(point, radius, rectangle) {
  const dx = point.x < rectangle.minX
    ? rectangle.minX - point.x
    : point.x > rectangle.maxX ? point.x - rectangle.maxX : 0;
  const dz = point.z < rectangle.minZ
    ? rectangle.minZ - point.z
    : point.z > rectangle.maxZ ? point.z - rectangle.maxZ : 0;
  return Math.hypot(dx, dz) <= radius;
}

function normalizedLifeRect(footprint) {
  if (footprint?.shape !== 'rect'
    || !Number.isFinite(footprint.halfX)
    || !Number.isFinite(footprint.halfZ)) return null;
  const yaw = Number.isFinite(footprint.yaw) ? footprint.yaw : 0;
  const halfX = Math.max(0.05, footprint.halfX);
  const halfZ = Math.max(0.05, footprint.halfZ);
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  return {
    shape: 'rect',
    halfX,
    halfZ,
    yaw,
    envelopeX: halfX * c + halfZ * s,
    envelopeZ: halfX * s + halfZ * c,
  };
}

function lifeRectPolygon(point, footprint) {
  const c = Math.cos(footprint.yaw), s = Math.sin(footprint.yaw);
  return [
    { x: footprint.halfX, z: footprint.halfZ },
    { x: -footprint.halfX, z: footprint.halfZ },
    { x: -footprint.halfX, z: -footprint.halfZ },
    { x: footprint.halfX, z: -footprint.halfZ },
  ].map((corner) => ({
    x: point.x + corner.x * c + corner.z * s,
    z: point.z - corner.x * s + corner.z * c,
  }));
}

function polygonDistance(left, right) {
  if (left.some((point) => G.pointInPoly(point, right))
    || right.some((point) => G.pointInPoly(point, left))) return 0;
  let distance = Infinity;
  for (let i = 0; i < left.length; i++) {
    distance = Math.min(
      distance,
      G.segmentPolygonDistance(left[i], left[(i + 1) % left.length], right),
    );
  }
  return distance;
}

function pointToLifeRectDistance(point, center, footprint) {
  const c = Math.cos(footprint.yaw), s = Math.sin(footprint.yaw);
  const dx = point.x - center.x, dz = point.z - center.z;
  const localX = dx * c - dz * s;
  const localZ = dx * s + dz * c;
  const outsideX = Math.max(0, Math.abs(localX) - footprint.halfX);
  const outsideZ = Math.max(0, Math.abs(localZ) - footprint.halfZ);
  return Math.hypot(outsideX, outsideZ);
}

function lifeRectIntersectsHardObstacle(point, footprint, obstacles) {
  const polygon = lifeRectPolygon(point, footprint);
  for (const obstacle of obstacles || []) {
    if (obstacle.shape === 'circle') {
      if (pointToLifeRectDistance(
        { x: obstacle.x, z: obstacle.z },
        point,
        footprint,
      ) <= obstacle.radius + YARD_HARD_GAP) return true;
      continue;
    }
    const obstaclePolygon = obstacle.shape === 'polygon'
      ? obstacle.points
      : [
          { x: obstacle.x - obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
          { x: obstacle.x + obstacle.halfWidth, z: obstacle.z - obstacle.halfDepth },
          { x: obstacle.x + obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
          { x: obstacle.x - obstacle.halfWidth, z: obstacle.z + obstacle.halfDepth },
        ];
    if (!obstaclePolygon?.length) continue;
    if (polygonDistance(polygon, obstaclePolygon) <= YARD_HARD_GAP) return true;
  }
  return false;
}

function circleFitsParcel(
  point,
  radius,
  points,
  edgeClearance = YARD_LIFE_WALL_GAP,
  allowExactClearance = false,
) {
  if (!points?.length || !G.pointInPoly(point, points)) return false;
  const clearance = radius + edgeClearance;
  for (let i = 0; i < points.length; i++) {
    const distance = G.distToSeg(point, points[i], points[(i + 1) % points.length]).d;
    if (allowExactClearance ? distance < clearance : distance <= clearance) {
      return false;
    }
  }
  return true;
}

function lifeRectFitsParcel(
  point,
  footprint,
  points,
  edgeClearance = YARD_LIFE_WALL_GAP,
  allowExactClearance = false,
) {
  if (!points?.length) return false;
  return lifeRectPolygon(point, footprint).every((corner) => G.pointInPoly(corner, points)
    && points.every((edge, index) =>
      allowExactClearance
        ? G.distToSeg(corner, edge, points[(index + 1) % points.length]).d >= edgeClearance
        : G.distToSeg(corner, edge, points[(index + 1) % points.length]).d > edgeClearance));
}

function lifeRectIntersectsRoof(point, footprint, roof) {
  const roofPolygon = [
    { x: roof.minX, z: roof.minZ },
    { x: roof.maxX, z: roof.minZ },
    { x: roof.maxX, z: roof.maxZ },
    { x: roof.minX, z: roof.maxZ },
  ];
  return polygonDistance(lifeRectPolygon(point, footprint), roofPolygon) <= YARD_LIFE_ROOF_GAP;
}

function lifeRectBlocksSolarAccess(parcel, point, footprint) {
  const corridor = parcel.solarAccess;
  if (!corridor) return localCanopyBlocksSolarAccess(
    parcel,
    point,
    Math.hypot(footprint.halfX, footprint.halfZ),
  );
  const corridorPolygon = [
    { x: -corridor.halfWidth, z: corridor.localStart },
    { x: corridor.halfWidth, z: corridor.localStart },
    { x: corridor.halfWidth, z: corridor.localEnd },
    { x: -corridor.halfWidth, z: corridor.localEnd },
  ];
  return polygonDistance(lifeRectPolygon(point, footprint), corridorPolygon) <= 1e-9;
}

function gateApproach(parcel, roof) {
  const house = parcelHouseTranslation(parcel);
  const start = { x: house.x, z: roof.maxZ + 0.15 };
  const gate = parcel.access?.gateLocalPoint;
  if (Number.isFinite(gate?.x) && Number.isFinite(gate?.z)) return { start, gate };
  const front = parcel.shape?.pts?.reduce(
    (best, point) => !best || point.z > best.z ? point : best,
    null,
  );
  return { start, gate: front ? { x: 0, z: front.z } : { x: 0, z: parcel.plotD * 0.5 } };
}

function lifeSlotTemplates(parcel, envelopeX, envelopeZ, slotClass, roof) {
  const halfW = parcel.plotW * 0.5;
  const halfD = parcel.plotD * 0.5;
  const edgeInset = yardLifeWallInwardClearance(parcel.wallType);
  const sideX = Math.max(0, halfW - envelopeX - edgeInset);
  const solarHalfWidth = Number.isFinite(parcel.solarAccess?.halfWidth)
    ? parcel.solarAccess.halfWidth : 0;
  const innerX = Math.min(
    sideX,
    Math.max(envelopeX + YARD_HARD_GAP, solarHalfWidth + envelopeX + YARD_HARD_GAP),
  );
  const roofClearZ = roof.maxZ + envelopeZ + YARD_LIFE_ROOF_GAP;
  const serviceZ = Math.min(
    halfD - envelopeZ - edgeInset,
    Math.max(-parcel.plotD * 0.02, roof.maxZ + envelopeZ + YARD_LIFE_ROOF_GAP),
  );
  const frontZ = Math.min(
    halfD - envelopeZ - edgeInset,
    Math.max(parcel.plotD * 0.24, roofClearZ),
  );
  const middleZ = Math.min(halfD - envelopeZ - edgeInset, parcel.plotD * 0.11);
  if (slotClass === 'open-work-yard') {
    return [
      { id: 'work-right-front', x: sideX, z: frontZ },
      { id: 'work-left-front', x: -sideX, z: frontZ },
      { id: 'work-right-inner-front', x: innerX, z: frontZ },
      { id: 'work-left-inner-front', x: -innerX, z: frontZ },
      { id: 'work-right-middle', x: sideX, z: middleZ },
      { id: 'work-left-middle', x: -sideX, z: middleZ },
      { id: 'work-right-inner-middle', x: innerX, z: middleZ },
      { id: 'work-left-inner-middle', x: -innerX, z: middleZ },
    ];
  }
  return [
    { id: 'service-right-near', x: sideX, z: serviceZ },
    { id: 'service-left-near', x: -sideX, z: serviceZ },
    { id: 'service-right-front', x: sideX, z: frontZ },
    { id: 'service-left-front', x: -sideX, z: frontZ },
  ];
}

// 계절 생활상은 필지 RNG와 독립된 후보 슬롯만 요청한다. 이 함수는 후보 순서를
// 고정하고 실제 지붕·대문 접근·일조·담·기존 hard object를 모두 통과한 자리만 돌려준다.
// 호출자는 parcel 전용 hash RNG로 하나를 고르며, 선택된 모든 계절 record를 flora obstacle로
// 바꿔 아직 심지 않은 마당나무의 trunk를 예약한다.
export function yardLifePotentialSlots(
  parcel,
  { footprint, radius = 0.6, height = 1, slotClass = 'service-edge', obstacles } = {},
) {
  const safeRect = normalizedLifeRect(footprint);
  const safeRadius = Math.max(0.05, Number.isFinite(radius) ? radius : 0.6);
  const safeHeight = Number.isFinite(height) ? height : Infinity;
  if (!parcel || parcel.hero || !['giwa', 'choga'].includes(parcel.kind)
    || !Number.isFinite(parcel.plotW) || !Number.isFinite(parcel.plotD)
    || safeHeight <= 0 || safeHeight > YARD_LIFE_MAX_HEIGHT) return [];

  const roof = parcelEffectiveRoofBounds(parcel);
  if (![roof.minX, roof.maxX, roof.minZ, roof.maxZ].every(Number.isFinite)) return [];
  const hard = obstacles || yardHardObstacles(parcel);
  const approach = gateApproach(parcel, roof);
  const envelopeX = safeRect?.envelopeX ?? safeRadius;
  const envelopeZ = safeRect?.envelopeZ ?? safeRadius;
  const edgeClearance = yardLifeWallInwardClearance(parcel.wallType);
  return lifeSlotTemplates(parcel, envelopeX, envelopeZ, slotClass, roof).filter((slot) => {
    const point = { x: slot.x, z: slot.z };
    if (safeRect) {
      if (!lifeRectFitsParcel(
        point,
        safeRect,
        parcel.shape?.pts,
        edgeClearance,
        true,
      )) return false;
      if (lifeRectIntersectsRoof(point, safeRect, roof)) return false;
      if (lifeRectIntersectsHardObstacle(point, safeRect, hard)) return false;
      if (lifeRectBlocksSolarAccess(parcel, point, safeRect)) return false;
      if (G.segmentPolygonDistance(
        approach.start,
        approach.gate,
        lifeRectPolygon(point, safeRect),
      ) <= YARD_LIFE_GATE_GAP) return false;
      return true;
    }
    if (!circleFitsParcel(
      point,
      safeRadius,
      parcel.shape?.pts,
      edgeClearance,
      true,
    )) return false;
    if (circleIntersectsRectangle(point, safeRadius + YARD_LIFE_ROOF_GAP, roof)) return false;
    if (yardCircleIntersectsHardObstacle(point, safeRadius, hard)) return false;
    if (localCanopyBlocksSolarAccess(parcel, point, safeRadius)) return false;
    if (G.distToSeg(point, approach.start, approach.gate).d <= safeRadius + YARD_LIFE_GATE_GAP) {
      return false;
    }
    return true;
  }).map((slot) => ({
    id: slot.id,
    class: slotClass,
    x: slot.x,
    z: slot.z,
    ...(safeRect ? { footprint: { ...safeRect } } : {}),
    radius: safeRadius,
    height: safeHeight,
  }));
}

export function yardTreeIntersectsHardObstacle(point, footprint, obstacles) {
  for (const obstacle of obstacles || []) {
    const rawRadius = obstacle.mode === 'canopy'
      ? footprint?.canopyRadius : footprint?.trunkRadius;
    const radius = Math.max(0, Number.isFinite(rawRadius) ? rawRadius : 0) + YARD_HARD_GAP;
    if (yardCircleIntersectsHardObstacle(point, radius, [obstacle], 0)) return true;
  }
  return false;
}

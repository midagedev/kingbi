import { impostorHouseSpec } from './impostor-spec.js';
import {
  parcelHouseTranslation,
  parcelWorldPoint,
  preferredParcelHouseTranslation,
} from './parcel-contract.js';
import { assignVariation, variantThatchAge } from './variants.js';
import { giwaVariantFallbacks, minimumGiwaFit } from './house-diversity.js';

const EPS = 1e-9;
const FEASIBLE_EPS = 1e-7;
export const HOUSE_ROOF_CLEARANCE = 0.3;
export const MIN_HOUSE_FIT = 0.7;
export const MIN_EFFECTIVE_HOUSE_SCALE = 0.68;
export const VARIATION_SEED_STEP = 0x9e3779b9;

const finiteScale = (value) => Number.isFinite(value) ? value : 1;

function roofCorners(spec, sx, sz) {
  const points = [];
  for (const roof of spec.roofs) {
    points.push(
      { x: roof.x0 * sx, z: roof.z0 * sz },
      { x: roof.x1 * sx, z: roof.z0 * sz },
      { x: roof.x1 * sx, z: roof.z1 * sz },
      { x: roof.x0 * sx, z: roof.z1 * sz },
    );
  }
  return points;
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum * 0.5;
}

// 각 필지 변을 바깥 법선 half-plane으로 바꾼다. 변수는 집의 로컬 이동(tx,tz)과
// 원래 variant 크기에 곱할 uniform fit factor(f): nx*tx+nz*tz+support*f <= limit.
function fitHalfPlanes(points, corners, clearance) {
  const ccw = signedArea(points) >= 0;
  const planes = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len <= EPS) continue;
    const nx = (ccw ? dz : -dz) / len;
    const nz = (ccw ? -dx : dx) / len;
    let support = -Infinity;
    for (const corner of corners) support = Math.max(support, nx * corner.x + nz * corner.z);
    planes.push({ a: nx, b: nz, c: support, d: nx * a.x + nz * a.z - clearance });
  }
  return planes;
}

function solve3(rows) {
  const m = rows.map((row) => [row.a, row.b, row.c, row.d]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) <= EPS) return null;
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot], m[col]];
    const div = m[col][col];
    for (let j = col; j < 4; j++) m[col][j] /= div;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const mul = m[row][col];
      for (let j = col; j < 4; j++) m[row][j] -= mul * m[col][j];
    }
  }
  return { x: m[0][3], z: m[1][3], f: m[2][3] };
}

function feasible3(candidate, constraints) {
  return constraints.every((h) =>
    h.a * candidate.x + h.b * candidate.z + h.c * candidate.f <= h.d + FEASIBLE_EPS);
}

// 3변수 선형계획의 꼭짓점을 전부 열거한다. 필지 변은 집 이동을 유계로 만들고 f의
// [0,1] 면을 더했으므로 최대 uniform scale은 반드시 이 꼭짓점 중 하나에 있다.
function maximumFitFactor(planes) {
  const constraints = [
    ...planes,
    { a: 0, b: 0, c: 1, d: 1 },
    { a: 0, b: 0, c: -1, d: 0 },
  ];
  let best = null;
  for (let i = 0; i < constraints.length - 2; i++) {
    for (let j = i + 1; j < constraints.length - 1; j++) {
      for (let k = j + 1; k < constraints.length; k++) {
        const candidate = solve3([constraints[i], constraints[j], constraints[k]]);
        if (!candidate || !feasible3(candidate, constraints)) continue;
        if (!best || candidate.f > best.f + EPS) best = candidate;
      }
    }
  }
  return best ? Math.max(0, Math.min(1, best.f)) : 0;
}

function translationFeasible(point, planes, factor) {
  return planes.every((h) => h.a * point.x + h.b * point.z + h.c * factor <= h.d + FEASIBLE_EPS);
}

function lineIntersection(a, b, factor) {
  const ad = a.d - a.c * factor, bd = b.d - b.c * factor;
  const det = a.a * b.b - b.a * a.b;
  if (Math.abs(det) <= EPS) return null;
  return {
    x: (ad * b.b - bd * a.b) / det,
    z: (a.a * bd - b.a * ad) / det,
  };
}

// 최대 크기에서 가능한 이동 영역 중 기존 뒤안 위치와 가장 가까운 점을 고른다. 볼록 영역에
// 대한 점의 투영은 원점, 한 변 위의 수선발, 또는 두 변의 교점 중 하나이므로 샘플링이 없다.
function closestFitTranslation(preferred, planes, factor) {
  if (translationFeasible(preferred, planes, factor)) return { ...preferred };
  const candidates = [];
  for (let i = 0; i < planes.length; i++) {
    const h = planes[i];
    const delta = h.a * preferred.x + h.b * preferred.z + h.c * factor - h.d;
    const projected = { x: preferred.x - h.a * delta, z: preferred.z - h.b * delta };
    if (translationFeasible(projected, planes, factor)) candidates.push(projected);
    for (let j = i + 1; j < planes.length; j++) {
      const corner = lineIntersection(h, planes[j], factor);
      if (corner && translationFeasible(corner, planes, factor)) candidates.push(corner);
    }
  }
  let best = null, bestD2 = Infinity;
  for (const candidate of candidates) {
    const dx = candidate.x - preferred.x, dz = candidate.z - preferred.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2 - EPS
      || (Math.abs(d2 - bestD2) <= EPS
        && (!best || candidate.x < best.x - EPS
          || (Math.abs(candidate.x - best.x) <= EPS && candidate.z < best.z)))) {
      best = candidate; bestD2 = d2;
    }
  }
  return best || { ...preferred };
}

function rearConstrainedFit(preferred, planes) {
  // 본채가 앞마당을 잠식하지 않도록 기존 뒤안 위치의 ±0.5m 띠를 하드 제약으로 둔다.
  // 그 안에서 최대 scale을 구한 뒤 가장 가까운 이동을 골라, 같은 scale이면 z=preferred가
  // 그대로 남고 작은 후퇴/전진으로 축소를 피할 수 있을 때만 움직인다.
  const rearBand = [
    ...planes,
    { a: 0, b: 1, c: 0, d: preferred.z + 0.5 },
    { a: 0, b: -1, c: 0, d: -preferred.z + 0.5 },
  ];
  const factor = maximumFitFactor(rearBand);
  return {
    factor,
    translation: closestFitTranslation(preferred, rearBand, factor),
  };
}

function sourceScales(parcel) {
  const current = {
    x: finiteScale(parcel.sx),
    y: finiteScale(parcel.sy),
    z: finiteScale(parcel.sz),
  };
  const source = parcel.houseFitSource;
  const priorFactor = parcel.houseFitFactor;
  if (!Array.isArray(source) || source.length !== 3 || !Number.isFinite(priorFactor)) return current;
  const sameFit = Math.abs(current.x - source[0] * priorFactor) <= EPS
    && Math.abs(current.y - source[1] * priorFactor) <= EPS
    && Math.abs(current.z - source[2] * priorFactor) <= EPS;
  return sameFit ? { x: source[0], y: source[1], z: source[2] } : current;
}

// assignVariation() 뒤 호출하는 순수 데이터 계약. 실제 variant 지붕의 모든 모서리를
// clearance만큼 안쪽으로 넣되 기존 뒤안의 ±0.5m 띠에서 최대 uniform scale과 최소 이동을
// 계산해 parcel에 고정한다. 최대 scale이 같으면 원래 뒤안 위치를 그대로 선택한다.
// 같은 parcel에 재호출해도 원래 변주 scale에서 다시 계산하므로 누적 축소되지 않는다.
export function fitHouseWithinParcel(parcel, clearance = HOUSE_ROOF_CLEARANCE) {
  const points = parcel.shape?.pts;
  const sourceScale = sourceScales(parcel);
  const preferred = preferredParcelHouseTranslation(parcel);
  const safeClearance = Math.max(0, Number.isFinite(clearance) ? clearance : HOUSE_ROOF_CLEARANCE);
  if (!points || points.length < 3 || (parcel.kind !== 'choga' && parcel.kind !== 'giwa')) {
    parcel.houseLocal = { ...preferred };
    parcel.houseFitFactor = 1;
    delete parcel.houseFitSource;
    return parcel;
  }

  const corners = roofCorners(impostorHouseSpec(parcel), sourceScale.x, sourceScale.z);
  const planes = fitHalfPlanes(points, corners, safeClearance);
  const fit = planes.length >= 3
    ? rearConstrainedFit(preferred, planes)
    : { factor: 1, translation: { ...preferred } };
  const factor = fit.factor;
  const translation = fit.translation;
  const fittedScale = {
    x: sourceScale.x * factor,
    y: sourceScale.y * factor,
    z: sourceScale.z * factor,
  };
  parcel.sx = fittedScale.x;
  parcel.sy = fittedScale.y;
  parcel.sz = fittedScale.z;
  parcel.houseLocal = translation;
  parcel.houseFitFactor = factor;
  if (factor < 1 - EPS) parcel.houseFitSource = [sourceScale.x, sourceScale.y, sourceScale.z];
  else delete parcel.houseFitSource;
  return parcel;
}

function houseFitAcceptable(parcel) {
  if (parcel.hero) return true;
  const limit = parcel.kind === 'giwa'
    ? minimumGiwaFit(parcel.variant | 0)
    : { factor: MIN_HOUSE_FIT, effectiveScale: MIN_EFFECTIVE_HOUSE_SCALE };
  return parcel.houseFitFactor >= limit.factor
    && Math.min(parcel.sx, parcel.sy, parcel.sz) >= limit.effectiveScale;
}

// plan 배치와 runtime 단건 reroll이 공유하는 완결된 변주 계약. 큰 평면이 작은 필지에서
// 장난감처럼 축소되면 같은 살림 축의 작은 variant로 내리고, 그래도 안 맞을 때만 false를 반환한다.
export function assignFittedVariation(parcel, char01 = 0.5, tuning = {}) {
  assignVariation(parcel, char01, tuning);
  const sourceScale = { x: parcel.sx, y: parcel.sy, z: parcel.sz };
  fitHouseWithinParcel(parcel);
  if (houseFitAcceptable(parcel)) return true;

  const originalVariant = parcel.variant | 0;
  const thatchDelta = parcel.kind === 'choga'
    ? (parcel.thatchAge ?? variantThatchAge(parcel)) - variantThatchAge(parcel)
    : 0;
  const fallbacks = parcel.kind === 'choga'
    ? Array.from({ length: originalVariant }, (_, index) => originalVariant - index - 1)
    : giwaVariantFallbacks(originalVariant, parcel.seed);
  for (const variant of fallbacks) {
    parcel.variant = variant;
    parcel.sx = sourceScale.x;
    parcel.sy = sourceScale.y;
    parcel.sz = sourceScale.z;
    fitHouseWithinParcel(parcel);
    if (!houseFitAcceptable(parcel)) continue;
    if (parcel.kind === 'choga') {
      parcel.thatchAge = Math.max(0, Math.min(1, variantThatchAge(parcel) + thatchDelta));
    }
    return true;
  }
  return false;
}

// 배치와 UI 단건 재굴림이 공유하는 제한적 시드 탐색. 부적합한 큰 변주 하나 때문에 같은
// parcel geometry의 뒤 후보까지 영구히 막히지 않게 하되, 시도 수와 순서는 고정해 결정론을 지킨다.
// 성공하면 실제로 채택된 seed가 parcel에 남고, 실패한 호출자는 후보를 버리거나 이전 값을 복원한다.
export function assignFittedVariationSequence(
  parcel,
  char01 = 0.5,
  tuning = {},
  { baseSeed = parcel.seed, attempts = 16 } = {},
) {
  const firstSeed = Number.isFinite(baseSeed) ? baseSeed >>> 0 : 0;
  const limit = Math.max(1, Math.floor(Number.isFinite(attempts) ? attempts : 16));
  for (let attempt = 0; attempt < limit; attempt++) {
    parcel.seed = (firstSeed + Math.imul(attempt, VARIATION_SEED_STEP)) >>> 0;
    if (assignFittedVariation(parcel, char01, tuning)) return true;
  }
  return false;
}

// FULL/MID/FAR가 공유하는 실제 variant 지붕 치수에서 순수 XZ footprint를 파생한다.
// 필지 충돌, 식생 clearance, 회귀 게이트가 서로 다른 상자를 추정하지 않게 하는 단일 진실원이다.
function mjaLocalRoofPolygons(parcel) {
  const plan = parcel?.mjaHouse;
  if (plan?.kind !== 'mja-banga' || !Array.isArray(plan.wings)) return null;
  const polygons = [
    ...plan.wings.map((wing) => wing.roofFootprint),
    plan.gate?.roofFootprint,
  ].filter((polygon) => Array.isArray(polygon) && polygon.length >= 3);
  return polygons.length ? polygons : null;
}

export function parcelLocalRoofRectangles(parcel) {
  const mjaRoofs = mjaLocalRoofPolygons(parcel);
  if (mjaRoofs) {
    return mjaRoofs.map((roof) => {
      const bounds = roof.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x),
        maxX: Math.max(result.maxX, point.x),
        minZ: Math.min(result.minZ, point.z),
        maxZ: Math.max(result.maxZ, point.z),
      }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
      return bounds;
    });
  }
  const spec = impostorHouseSpec(parcel);
  const sx = parcel.sx || 1, sz = parcel.sz || 1;
  const local = parcelHouseTranslation(parcel);
  return spec.roofs.map((roof) => ({
    minX: roof.x0 * sx + local.x,
    maxX: roof.x1 * sx + local.x,
    minZ: roof.z0 * sz + local.z,
    maxZ: roof.z1 * sz + local.z,
  }));
}

export function parcelLocalRoofBounds(parcel) {
  const roofs = parcelLocalRoofRectangles(parcel);
  return roofs.reduce((bounds, roof) => ({
    minX: Math.min(bounds.minX, roof.minX),
    maxX: Math.max(bounds.maxX, roof.maxX),
    minZ: Math.min(bounds.minZ, roof.minZ),
    maxZ: Math.max(bounds.maxZ, roof.maxZ),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

// Runtime edits measure their generated eaves before the parcel transform. Keep
// that committed envelope authoritative for every later spatial consumer instead
// of making vegetation, focus cameras, and future exporters repeat the override.
export function parcelEffectiveRoofBounds(parcel) {
  const explicit = parcel.editRoofBounds;
  if (explicit && [explicit.minX, explicit.maxX, explicit.minZ, explicit.maxZ].every(Number.isFinite)) {
    return explicit;
  }
  return parcelLocalRoofBounds(parcel);
}

export function parcelRoofPolygons(parcel) {
  const mjaRoofs = mjaLocalRoofPolygons(parcel);
  const localRoofs = mjaRoofs || parcelLocalRoofRectangles(parcel).map((roof) => [
    { x: roof.maxX, z: roof.maxZ },
    { x: roof.minX, z: roof.maxZ },
    { x: roof.minX, z: roof.minZ },
    { x: roof.maxX, z: roof.minZ },
  ]);
  return localRoofs.map((roof) => roof.map((point) => parcelWorldPoint(parcel, point)));
}

// 마당 소품이 벽체 질량을 관통하지 않게 하는 필지 로컬 몸채 폴리곤.
// 처마(지붕) 아래 배치는 허용하고, 별채는 별도로 전체 지붕 clearance를 유지한다.
// mja-banga 는 날개 footprint, 일반 주거는 impostor body.polygon 을 sx/sz·houseLocal 로 옮긴다.
// 궁·절·비주거 지번은 빈 배열.
export function parcelLocalBodyPolygons(parcel) {
  if (!parcel || (parcel.kind !== 'giwa' && parcel.kind !== 'choga')) return [];
  const mja = parcel.mjaHouse;
  if (mja?.kind === 'mja-banga' && Array.isArray(mja.wings)) {
    return mja.wings
      .map((wing) => wing?.footprint)
      .filter((polygon) => Array.isArray(polygon) && polygon.length >= 3)
      .map((polygon) => polygon.map((point) => ({ x: point.x, z: point.z })));
  }
  const spec = impostorHouseSpec(parcel);
  const sx = finiteScale(parcel.sx), sz = finiteScale(parcel.sz);
  const local = parcelHouseTranslation(parcel);
  const polygon = (spec.body?.polygon || []).map((point) => ({
    x: point.x * sx + local.x,
    z: point.z * sz + local.z,
  }));
  return polygon.length >= 3 ? [polygon] : [];
}

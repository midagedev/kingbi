// 초가 우진각 지붕의 순수 형상 계약.
//
// roof.js와 walls.js가 서로 다른 근사식을 가지면 벽이 이엉을 뚫거나 지붕 아래에 틈이 생긴다.
// 이 모듈은 렌더러·재질과 무관한 단일 프로파일을 제공해 지붕 메시와 벽 상단이 같은 형상을
// 공유하게 한다. planXZ의 역변환도 함께 두어 임의의 평면 좌표에서 정확한 지붕 높이를 얻는다.

const BASE_PLAN_EXPONENT = 4.2;  // 평면 초승형(둥근사각) 기본 지수
const HIP_EXPONENT = 2.6;        // 우진각 모서리의 둥글기
const SURFACE_EXPONENT = 1.32;   // 이엉 물매 곡률
const RIDGE_SAG = 0.17;          // 용마루 중앙의 완만한 처짐
const WALL_PLAN_MARGIN = 0.01;   // 벽 모서리 바깥으로 확보할 최소 평면 피복

export const THATCH_ROOF_SEGMENTS = Object.freeze({ a: 56, b: 44 });
export const THATCH_WALL_END_OVERLAP = 0.03;

// 벽 상단을 렌더 표면 바로 아래로 숨기는 깊이. 지붕은 단일 표면이므로 큰 간격은 틈으로 보인다.
export const THATCH_WALL_COVER_DEPTH = 0.03;

const gridCache = new WeakMap();

function coveringPlanExponent(P, L, xEave, zEave) {
  const cr = P.columnRadius + THATCH_WALL_END_OVERLAP;
  // 전·후면 벽은 x로 cr만큼, 측면 벽은 z로 cr만큼 기둥 밖까지 이어진다.
  // Lp 둥근사각은 볼록하므로 네 벽 끝점이 안에 있으면 벽선 전체가 안에 있다.
  const corners = [
    [(L.W / 2 + cr + WALL_PLAN_MARGIN) / xEave, (L.D / 2 + WALL_PLAN_MARGIN) / zEave],
    [(L.W / 2 + WALL_PLAN_MARGIN) / xEave, (L.D / 2 + cr + WALL_PLAN_MARGIN) / zEave],
  ];
  if (corners.some(([x, z]) => x >= 1 || z >= 1)) {
    throw new RangeError('Thatch eave overhang is too small to cover the wall footprint');
  }
  const covers = (exponent) => corners.every(([x, z]) => (
    Math.pow(x, exponent) + Math.pow(z, exponent) <= 1
  ));
  if (covers(BASE_PLAN_EXPONENT)) return BASE_PLAN_EXPONENT;

  let high = BASE_PLAN_EXPONENT * 2;
  while (!covers(high) && high < 64) high *= 2;
  if (!covers(high)) throw new RangeError('Thatch wall footprint cannot fit inside the roof plan');

  let low = BASE_PLAN_EXPONENT;
  for (let i = 0; i < 32; i++) {
    const middle = (low + high) / 2;
    if (covers(middle)) high = middle;
    else low = middle;
  }
  return high;
}

function roofGrid(profile) {
  let vertices = gridCache.get(profile);
  if (vertices) return vertices;
  vertices = [];
  for (let ib = 0; ib <= THATCH_ROOF_SEGMENTS.b; ib++) {
    for (let ia = 0; ia <= THATCH_ROOF_SEGMENTS.a; ia++) {
      const a = (ia / THATCH_ROOF_SEGMENTS.a) * 2 - 1;
      const b = (ib / THATCH_ROOF_SEGMENTS.b) * 2 - 1;
      const [x, z] = profile.planXZ(a, b);
      // BufferGeometry가 실제로 보관하는 Float32 좌표와 같은 표면을 샘플한다.
      vertices.push({
        x: Math.fround(x),
        y: Math.fround(profile.heightAB(a, b)),
        z: Math.fround(z),
      });
    }
  }
  gridCache.set(profile, vertices);
  return vertices;
}

function gridVertex(profile, ia, ib) {
  return roofGrid(profile)[ib * (THATCH_ROOF_SEGMENTS.a + 1) + ia];
}

function triangleHeightAt(x, z, a, b, c) {
  const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(det) < 1e-12) return null;
  const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
  const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
  const wc = 1 - wa - wb;
  if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) return null;
  return wa * a.y + wb * b.y + wc * c.y;
}

function cellHeightAt(profile, x, z, ia, ib) {
  const q = gridVertex(profile, ia, ib);
  const w = gridVertex(profile, ia + 1, ib);
  const e = gridVertex(profile, ia, ib + 1);
  const r = gridVertex(profile, ia + 1, ib + 1);
  return triangleHeightAt(x, z, q, e, w) ?? triangleHeightAt(x, z, w, e, r);
}

// 실제 roof.js BufferGeometry의 두 삼각형과 같은 보간 높이. 분석 곡면만 쓰면 큰 편집형의
// 급한 힙 구간에서 삼각 메시와 수 cm 어긋날 수 있으므로 벽 접합부는 이 값을 사용한다.
export function thatchRoofSurfaceHeightAt(profile, x, z) {
  const [a, b] = profile.planABAt(x, z);
  const centerA = Math.max(0, Math.min(
    THATCH_ROOF_SEGMENTS.a - 1,
    Math.floor(((a + 1) / 2) * THATCH_ROOF_SEGMENTS.a),
  ));
  const centerB = Math.max(0, Math.min(
    THATCH_ROOF_SEGMENTS.b - 1,
    Math.floor(((b + 1) / 2) * THATCH_ROOF_SEGMENTS.b),
  ));

  // 역변환점은 보통 해당 param cell 안에 있다. 비선형 초승형 사상 경계만 이웃 cell을 확인한다.
  for (let radius = 0; radius <= 2; radius++) {
    for (let ib = centerB - radius; ib <= centerB + radius; ib++) {
      if (ib < 0 || ib >= THATCH_ROOF_SEGMENTS.b) continue;
      for (let ia = centerA - radius; ia <= centerA + radius; ia++) {
        if (ia < 0 || ia >= THATCH_ROOF_SEGMENTS.a) continue;
        if (radius > 0 && Math.max(Math.abs(ia - centerA), Math.abs(ib - centerB)) !== radius) continue;
        const height = cellHeightAt(profile, x, z, ia, ib);
        if (height != null) return height;
      }
    }
  }

  // 비선형 plan 역변환의 locator 오차가 커지는 새 파라미터도 실제 메시 전수 탐색으로 복구한다.
  for (let ib = 0; ib < THATCH_ROOF_SEGMENTS.b; ib++) {
    for (let ia = 0; ia < THATCH_ROOF_SEGMENTS.a; ia++) {
      const height = cellHeightAt(profile, x, z, ia, ib);
      if (height != null) return height;
    }
  }
  throw new RangeError(`Thatch roof surface does not cover wall point (${x}, ${z})`);
}

export function thatchWallTopAt(profile, x, z) {
  return thatchRoofSurfaceHeightAt(profile, x, z) - THATCH_WALL_COVER_DEPTH;
}

// 벽선과 실제 지붕 삼각 메시의 모든 edge 교차점을 축 좌표로 반환한다. 이 점들을 벽 상단
// 정점으로 쓰면 각 벽 segment가 하나의 roof triangle 안에 머물러 정점 사이에서도 관통하지 않는다.
export function thatchWallBreakpoints(profile, axis, fixed, start, end) {
  const grid = roofGrid(profile);
  const NA = THATCH_ROOF_SEGMENTS.a;
  const NB = THATCH_ROOF_SEGMENTS.b;
  const from = Math.fround(start);
  const to = Math.fround(end);
  const wallFixed = Math.fround(fixed);
  const span = to - from;
  if (Math.abs(span) < 1e-9) return [from];

  const values = [from, to];
  const addAlong = (value) => {
    const t = (value - from) / span;
    if (t < -1e-7 || t > 1 + 1e-7) return;
    values.push(Math.fround(from + span * Math.max(0, Math.min(1, t))));
  };
  const crossEdge = (a, b) => {
    const aPerp = (axis === 'x' ? a.z : a.x) - wallFixed;
    const bPerp = (axis === 'x' ? b.z : b.x) - wallFixed;
    const aAlong = axis === 'x' ? a.x : a.z;
    const bAlong = axis === 'x' ? b.x : b.z;
    if (Math.abs(aPerp) < 1e-8 && Math.abs(bPerp) < 1e-8) {
      addAlong(aAlong);
      addAlong(bAlong);
      return;
    }
    if ((aPerp < -1e-8 && bPerp < -1e-8) || (aPerp > 1e-8 && bPerp > 1e-8)) return;
    const denom = bPerp - aPerp;
    if (Math.abs(denom) < 1e-12) return;
    const u = -aPerp / denom;
    if (u < -1e-8 || u > 1 + 1e-8) return;
    addAlong(aAlong + (bAlong - aAlong) * Math.max(0, Math.min(1, u)));
  };
  const at = (ia, ib) => grid[ib * (NA + 1) + ia];

  // 수평·수직 grid edge와 각 cell의 공유 대각선(w↔e)을 한 번씩만 순회한다.
  for (let ib = 0; ib <= NB; ib++) {
    for (let ia = 0; ia < NA; ia++) crossEdge(at(ia, ib), at(ia + 1, ib));
  }
  for (let ib = 0; ib < NB; ib++) {
    for (let ia = 0; ia <= NA; ia++) crossEdge(at(ia, ib), at(ia, ib + 1));
  }
  for (let ib = 0; ib < NB; ib++) {
    for (let ia = 0; ia < NA; ia++) crossEdge(at(ia + 1, ib), at(ia, ib + 1));
  }

  values.sort((a, b) => (a - b) * Math.sign(span));
  return values.filter((value, index) => index === 0 || Math.abs(value - values[index - 1]) > 1e-6);
}

export function createThatchRoofProfile(P, L) {
  const xEave = L.xEave;
  const zEave = L.zEave;
  const eaveY = L.eaveEdgeY;
  const rise = L.ridgeY - eaveY;
  const ridgeHalfX = Math.max(0.3, L.W / 2 - L.D / 2);
  const ridgeRatio = ridgeHalfX / xEave;
  const thick = P.thatchThick ?? 0.38;
  const planExponent = coveringPlanExponent(P, L, xEave, zEave);

  // 정규화 사각(a,b)∈[-1,1] → 둥근사각 평면 좌표.
  const planXZ = (a, b) => {
    const edge = Math.max(Math.abs(a), Math.abs(b));
    if (edge < 1e-6) return [0, 0];
    const ux = Math.abs(a / edge);
    const uz = Math.abs(b / edge);
    const radius = 1 / Math.pow(
      Math.pow(ux, planExponent) + Math.pow(uz, planExponent),
      1 / planExponent,
    );
    return [a * radius * xEave, b * radius * zEave];
  };

  // 하강량(0=용마루, 1=처마). |a|<ridgeRatio, b=0 구간은 평탄한 용마루다.
  const descend = (a, b) => {
    const side = Math.max(0, (Math.abs(a) - ridgeRatio) / (1 - ridgeRatio));
    return Math.min(1, Math.pow(
      Math.pow(Math.abs(b), HIP_EXPONENT) + Math.pow(side, HIP_EXPONENT),
      1 / HIP_EXPONENT,
    ));
  };

  const heightAB = (a, b) => {
    const drop = descend(a, b);
    const along = Math.max(0, 1 - Math.pow(
      Math.abs(a) / Math.max(1e-3, ridgeRatio),
      2,
    ));
    return eaveY
      + rise * (1 - Math.pow(drop, SURFACE_EXPONENT))
      - RIDGE_SAG * along * (1 - drop);
  };

  // planXZ는 방향을 보존하고 초승형 Lp 노름을 원래 square edge로 보낸다.
  // 이를 역으로 풀면 지붕 그리드와 동일한 (a,b)를 복원할 수 있다.
  const planABAt = (x, z) => {
    const nx = x / xEave;
    const nz = z / zEave;
    const maxNorm = Math.max(Math.abs(nx), Math.abs(nz));
    if (maxNorm < 1e-9) return [0, 0];
    const edge = Math.pow(
      Math.pow(Math.abs(nx), planExponent) + Math.pow(Math.abs(nz), planExponent),
      1 / planExponent,
    );
    const scale = edge / maxNorm;
    return [nx * scale, nz * scale];
  };
  const heightAt = (x, z) => heightAB(...planABAt(x, z));

  return {
    xEave,
    zEave,
    eaveY,
    rise,
    ridgeY: L.ridgeY,
    ridgeHalfX,
    thick,
    planExponent,
    ridgeSag: RIDGE_SAG,
    planXZ,
    descend,
    heightAB,
    planABAt,
    heightAt,
  };
}

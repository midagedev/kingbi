import { makeRng } from '../rng.js';
import * as G from '../core/math/geom2.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallVegetationBlocked,
  worldEdgeClearance,
} from './citywall-contour.js';
import { canopyBlocksSolarAccess, circleIntersectsPolygon } from './parcel-contract.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import {
  STREAM_GUARDIAN_BASE_CLEARANCE,
  streamClearanceAt,
} from './stream-spatial.js';

// 보호수(당산나무) 위치만 다루는 순수 계획 단계. THREE 지오메트리와 분리해 작은 성곽을
// 강제한 경우에도 수관 전체가 성벽·문루·접근로를 침범하지 않는지 빠르게 계약 검사할 수 있다.
// 기존 선형 탐색을 먼저 유지하고, 막혔을 때만 동심 탐색으로 입구 주변의 빈터를 찾는다.
const TAU = Math.PI * 2;
const SEARCH_STEP = 2.4;
const LINEAR_ATTEMPTS = 12;
const RADIAL_RINGS = 18;
// 보호수는 장식 후보가 아니라 scale별 필수 landmark다. 조밀한 도성·필지 확대 뒤에는
// 기존 18-ring 근방이 필지·일조 회랑으로 가득 찰 수 있으므로, 기존 후보 순서는 유지한 채
// 실패할 때만 마을 반경에 비례해 탐색을 이어 간다. 0.55R이면 중앙 기준점(0.15R offset)의
// 의미를 유지하면서 town seed 1·9 와 한양의 실제 빈터까지 닿고, 이미 성공하던 seed의
// 위치/hash는 바뀌지 않는다(탐색 확장만 실패 경로).
const REQUIRED_ROLE_SEARCH_RADIUS_RATIO = 0.55;
export const GUARDIAN_CANOPY_RADIUS_BY_KIND = Object.freeze({ zelkova: 14, ginkgo: 8.4 });
export const GUARDIAN_CANOPY_RADIUS = GUARDIAN_CANOPY_RADIUS_BY_KIND.zelkova;
export const GUARDIAN_BASE_CLEARANCE = 5;

export function guardianCanopyRadius(kind, scale = 1) {
  return (GUARDIAN_CANOPY_RADIUS_BY_KIND[kind] || GUARDIAN_CANOPY_RADIUS) * scale;
}

export function planGuardianTrees(plan, site, seed) {
  const rng = makeRng((seed ^ 0x60a2d) >>> 0);
  const C = site.center, R = site.R, scale = plan.scale;
  const cityWall = plan.features?.cityWall || null;
  const southGate = cityWall?.gates.find((gate) => gate.name === 'south') || null;
  const E = southGate || site.entrance;
  const toC = southGate
    ? { x: -southGate.dirX, z: -southGate.dirZ }
    : G.norm(G.sub(C, E));
  const perp = G.perpL(toC);
  const palace = plan.features?.palace;
  const parcels = [...(plan.parcels || []), ...(palace?.center ? [palace] : [])];
  const paddies = plan.paddies || [];
  const roadSpatial = createRoadSpatialIndex(plan.roads || []);
  const reservations = [];
  const requiredRoleSearchRings = Math.max(
    RADIAL_RINGS + 1,
    Math.ceil(R * REQUIRED_ROLE_SEARCH_RADIUS_RATIO / (SEARCH_STEP * 2)),
  );
  const clearOfParcels = (x, z, visualRadius) => {
    for (const p of parcels) {
      if (circleIntersectsPolygon({ x, z }, visualRadius + 1.5, p.poly)) return false;
      if (canopyBlocksSolarAccess(p, { x, z }, visualRadius)) return false;
    }
    return true;
  };
  const clearAt = (x, z, visualRadius = 0) => clearOfParcels(x, z, visualRadius)
    && paddies.every((field) => !circleIntersectsPolygon({ x, z }, visualRadius, field.poly))
    && reservations.every((tree) => G.dist(tree, { x, z }) >= tree.radius + visualRadius + 2)
    // 수관이 마을길을 그늘지게 하는 것은 허용하되, 밑동 돌단·평상까지 도로 ribbon 위에
    // 생기지는 않게 실제 소품 footprint만큼 중심을 물린다.
    && !roadSpatial.withinRoadClearance({ x, z }, null, GUARDIAN_BASE_CLEARANCE)
    && streamClearanceAt(site, { x, z }) >= STREAM_GUARDIAN_BASE_CLEARANCE
    && (!site.edge || worldEdgeClearance(site.edge, { x, z }) >= visualRadius)
    && !cityWallVegetationBlocked(cityWall, { x, z }, {
      corridor: visualRadius + CITY_WALL_DIMENSIONS.vegetationClearance,
      gateMargin: visualRadius + CITY_WALL_DIMENSIONS.gateVegetationMargin,
      gateApproachMargin: visualRadius,
    });
  const nudge = (x0, z0, dx, dz, visualRadius = 0, radialRings = RADIAL_RINGS) => {
    for (let k = 0; k < LINEAR_ATTEMPTS; k++) {
      const x = x0 + dx * k * SEARCH_STEP, z = z0 + dz * k * SEARCH_STEP;
      if (clearAt(x, z, visualRadius)) return { x, z };
    }
    // 한 방향만 계속 밀지 말고 후보 의미(동구/중심/물가)를 보존하는 가장 가까운 빈터를 찾는다.
    // 무성곽에서도 막힌 원점을 되돌려 수관을 집 위에 얹던 예전 예외는 허용하지 않는다.
    const baseAngle = Math.atan2(dz, dx);
    for (let ring = 1; ring <= radialRings; ring++) {
      const radius = ring * SEARCH_STEP * 2;
      const steps = 8 + ring * 2;
      const phase = baseAngle + ring * Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < steps; i++) {
        const angle = phase + i / steps * TAU;
        const x = x0 + Math.cos(angle) * radius, z = z0 + Math.sin(angle) * radius;
        if (clearAt(x, z, visualRadius)) return { x, z };
      }
    }
    return null;
  };

  const out = [];
  const keepRequired = (pos, radius, fields) => {
    if (!pos) {
      throw new Error(`guardian-plan could not place required ${fields.role} tree for ${scale}:${seed}`);
    }
    reservations.push({ x: pos.x, z: pos.z, radius });
    out.push({ ...pos, radius, ...fields });
  };
  // 동구/남문 보호수: 종류·크기·회전 RNG 순서는 기존 출력과 동일하다.
  {
    const kind = rng() < 0.85 ? 'zelkova' : 'ginkgo';
    const treeScale = rng.range(0.95, 1.15), spin = rng() * TAU;
    const visualRadius = guardianCanopyRadius(kind, treeScale);
    const lateral = southGate
      ? Math.max(R * 0.11, southGate.width * 0.5 + CITY_WALL_DIMENSIONS.gateVegetationMargin + visualRadius + 4)
      : R * 0.11;
    const inward = southGate
      ? Math.max(R * 0.05, CITY_WALL_DIMENSIONS.vegetationClearance + visualRadius + 4)
      : R * 0.05;
    const bx = E.x + perp.x * lateral + toC.x * inward;
    const bz = E.z + perp.z * lateral + toC.z * inward;
    const pos = nudge(bx, bz, perp.x, perp.z, visualRadius, requiredRoleSearchRings);
    keepRequired(pos, visualRadius, {
      role: 'entrance', kind, scale: treeScale, spin, props: true,
    });
  }
  // 중심 명당(종가/관아 옆) — 실제 수관 반경으로 검사한다.
  if (scale === 'town' || scale === 'capital' || scale === 'hanyang') {
    const treeScale = rng.range(1.0, 1.2), spin = rng() * TAU;
    const radius = guardianCanopyRadius('zelkova', treeScale);
    const pos = nudge(
      C.x + perp.x * R * 0.15,
      C.z + perp.z * R * 0.03,
      perp.x,
      perp.z,
      radius,
      requiredRoleSearchRings,
    );
    keepRequired(pos, radius, {
      role: 'central', kind: 'zelkova', scale: treeScale, spin, props: true,
    });
  }
  // 개울가 — 실제 수관 반경으로 검사한다.
  if (scale === 'capital' || scale === 'hanyang') {
    const kind = rng() < 0.6 ? 'zelkova' : 'ginkgo';
    const treeScale = rng.range(0.9, 1.1), spin = rng() * TAU;
    const radius = guardianCanopyRadius(kind, treeScale);
    const x = R * 0.3;
    const z = site.streamZat(x) - site.streamHalf - STREAM_GUARDIAN_BASE_CLEARANCE;
    const pos = nudge(x, z, 1, 0, radius, requiredRoleSearchRings);
    keepRequired(pos, radius, {
      role: 'stream', kind, scale: treeScale, spin, props: false,
    });
  }
  return out;
}

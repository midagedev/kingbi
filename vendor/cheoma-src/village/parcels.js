import { smoothstep } from '../core/math/scalar.js';
import * as G from '../core/math/geom2.js';
import { makeRng } from '../rng.js';
import {
  cityGateApproachFootprint,
  cityWallClearance,
  cityWallContainsPolygon,
  cityWallOutsidePolygon,
  cityWallRadiusAt,
  worldEdgeClearance,
  worldEdgeContainsPolygon,
} from './citywall-contour.js';
import {
  SOUTH,
  attachParcelSpatialContract,
  parcelSolarAccessPolygon,
  rectangularParcelShape,
  terrainAlignedFacing,
} from './parcel-contract.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import {
  assignFittedVariation,
  assignFittedVariationSequence,
  fitHouseWithinParcel,
} from './house-footprint.js';
import {
  buildingBlocksSolarAccess,
  parcelObstructionPolygons,
} from './solar-access.js';
import {
  STREAM_PARCEL_BANK_CLEARANCE,
  STREAM_SATELLITE_BANK_CLEARANCE,
  createStreamSpatialIndex,
} from './stream-spatial.js';
import { terrainRangeOnPolygon } from './placement-search.js';

// 도로변 필지 분할 + 신분 위계 그라디언트 (joseon-city.md 규칙 7·8·9·10).
//   - 필지는 도로 파사드를 따라 양편에 앉되, 집의 로컬 +z는 남향 지세축을 우선한다(규칙 7).
//   - 신분(rank 0..1) → 필지 면적·칸수·유형(기와/초가) 매핑. 1품↔서인 면적차(가대제한).
//   - 중심(종가/관아/궁)·주산(북)·간선에 가까울수록 rank↑(크고 기와), 멀·남·외곽일수록 rank↓
//     (작고 초가). 그라디언트는 단조. 격자는 결코 완성되지 않는다.
//
// planParcels(site, roadsResult, opts, rng, blockers) → parcels[]
//   parcel: { poly, center, frontDir, rank, kind, plotW, plotD, hero?, heroStyle?, seed }


const SCALE_TARGET = { hamlet: 10, village: 32, town: 70, capital: 104, hanyang: 340 };
const ROAD_CURVE_SETBACK = 1.2; // 도로 ribbon 밖의 담·배수 여유(실제 poly↔capsule 검사와 동일 단위)
// 필지 면적 스케일. 집 축척(STRUCTURE_SCALE)과 분리한다 — 둘이 같으면 필지를 키워도
// 마당 길이/채 높이(L/H)가 불변이라 마당이 늘지 않는다(HANDOFF §3.1, authenticity §9).
// 농촌(hamlet~town)을 키우고, 한양 실측(~131평) 근거로 capital/hanyang 는 최소 변경.
// 농촌 확대. 도성·한양은 폭을 더 눌러 호수를 지키되, 깊이는 멍석 하한(2.1m)을 깨지 않게 둔다.
const LOT_W_SCALE = { hamlet: 1.22, village: 1.18, town: 1.12, capital: 0.90, hanyang: 0.80 };
const LOT_D_SCALE = { hamlet: 1.22, village: 1.18, town: 1.12, capital: 0.96, hanyang: 0.90 };
// 기와만 농촌 깊이 추가 부스트. 초가는 채 높이가 낮아 이미 L/H≳3 대; 기와 중형 채 높이
// ~4.0 m 에서 앞마당 ~10 m → L/H≈2.55. capital/hanyang 는 1(도성 밀도·실측 최소 변경).
const GIWA_LOT_D_BOOST = { hamlet: 1.14, village: 1.18, town: 1.12, capital: 1.0, hanyang: 1.0 };
// 집 축척. 농촌은 1(온전한 크기), 도시만 가대 압축. fitHouseWithinParcel 축소와 별개다.
const STRUCTURE_SCALE = { hamlet: 1, village: 1, town: 1, capital: 0.96, hanyang: 0.92 };

// 공간 해시 그리드 — 필지 겹침 판정을 O(배치수)에서 O(근접셀)로. 도성(수백 필지)에서 필수:
//   기존 전수검사(모든 placed 폴리곤 대비 SAT)는 후보수×배치수 = O(n²)라 hanyang 에서 수초 소요.
//   각 폴리곤을 bbox 가 걸치는 셀들에 등록하고, 후보는 자기 bbox 근접 셀의 폴리곤만 대조한다.
//   셀 크기는 최대 필지 치수 상당(≈28m) — 폴리곤이 걸치는 셀이 소수로 유지된다.
function makePlacedGrid(cell = 28) {
  const grid = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  const bboxCells = (poly) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; }
    return { cx0: Math.floor(minX / cell), cx1: Math.floor(maxX / cell), cz0: Math.floor(minZ / cell), cz1: Math.floor(maxZ / cell) };
  };
  return {
    add(poly, item = poly) {
      const entry = { poly, item };
      const b = bboxCells(poly);
      for (let cx = b.cx0; cx <= b.cx1; cx++) for (let cz = b.cz0; cz <= b.cz1; cz++) {
        const k = key(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(entry);
      }
    },
    overlaps(poly) {
      const b = bboxCells(poly);
      const seen = new Set();
      for (let cx = b.cx0; cx <= b.cx1; cx++) for (let cz = b.cz0; cz <= b.cz1; cz++) {
        const arr = grid.get(key(cx, cz)); if (!arr) continue;
        for (const entry of arr) {
          if (seen.has(entry)) continue;
          seen.add(entry);
          if (G.polysOverlap(poly, entry.poly)) return true;
        }
      }
      return false;
    },
    query(poly) {
      const b = bboxCells(poly);
      const seen = new Set(), items = new Set();
      for (let cx = b.cx0; cx <= b.cx1; cx++) for (let cz = b.cz0; cz <= b.cz1; cz++) {
        const arr = grid.get(key(cx, cz)); if (!arr) continue;
        for (const entry of arr) {
          if (seen.has(entry)) continue;
          seen.add(entry);
          items.add(entry.item);
        }
      }
      return items;
    },
  };
}

function reserveParcelSun(parcel, roofGrid, accessGrid) {
  for (const roof of parcelObstructionPolygons(parcel)) roofGrid.add(roof, parcel);
  // Palace solarAccess is a precinct-scale vegetation corridor, not a single
  // 1.5m residential window. Its whole enclosure still obstructs nearby homes.
  if (parcel.solarAccess && parcel.kind !== 'palace') {
    accessGrid.add(parcelSolarAccessPolygon(parcel), parcel);
  }
}

function parcelSunBlocked(parcel, site, roofGrid, accessGrid) {
  const fullAccess = parcelSolarAccessPolygon(parcel);
  for (const blocker of roofGrid.query(fullAccess)) {
    if (blocker.blockingPolygon) {
      if (G.polysOverlap(fullAccess, blocker.blockingPolygon)) return true;
    } else if (buildingBlocksSolarAccess(parcel, blocker, site)) return true;
  }
  for (const roof of parcelObstructionPolygons(parcel)) {
    for (const target of accessGrid.query(roof)) {
      if (buildingBlocksSolarAccess(target, parcel, site)) return true;
    }
  }
  return false;
}
// 간선 우선 배정 순서(대로변 프라임 파사드부터).
const LEVEL_ORDER = { daero: 0, jungno: 1, soro: 2, golmok: 3 };
// 도로 등급별 파사드 간격(전면 폭 + 여유).
const ARTERIAL_BONUS = { daero: 0.26, jungno: 0.18, soro: 0.06, golmok: 0.0 };

// rank + character(char01) → 필지 치수·유형.
//   char01: 민촌(0)일수록 기와 임계를 올려(초가↑) + 필지 축소, 반촌(1)일수록 기와↑ + 필지 확대.
//   상위=대형 기와, 하위=초가. hero 는 상위 극소수(종가·반가).
//   깊이(d)는 앞마당 하한(멍석 2.1m)과 L/H≈2.55 대역을 담기 위해 폭보다 여유 있게 둔다.
//   집 원점이 뒤안 inset에 앉으므로 앞마당 ≈ plotD − inset − roofFrontExtent (HANDOFF §3.1).
function dimsFor(rank, char01) {
  const kindRank = rank + (char01 - 0.5) * 0.62;      // 반촌 +0.31(기와↑) / 민촌 -0.31(초가↑)
  const sizeMul = 0.84 + char01 * 0.40;               // 민촌 0.84 / 여염 1.04 / 반촌 1.24
  let kind, w, d;
  // 버킷 깊이: 기와 중형 F≈6.8·inset 5.2 → plotD≥14 가 멍석 하한.
  // 기와 농촌 앞마당(L/H≈2.55)은 LOT_D_SCALE × GIWA_LOT_D_BOOST 로 키운다 — 버킷을 키우면
  // capital/hanyang 도 같이 깊어져 도성 밀도를 건드린다. 폭은 옆 여백·별채용 소폭 확대.
  if (kindRank >= 0.58) { kind = 'giwa'; w = 17.5; d = 19.5; }
  else if (kindRank >= 0.40) { kind = 'giwa'; w = 14.5; d = 16.5; }
  else if (kindRank >= 0.26) { kind = 'choga'; w = 12; d = 12.5; }
  else { kind = 'choga'; w = 10.5; d = 11.5; }
  return { kind, plotW: w * sizeMul, plotD: d * sizeMul };
}

const lerpN = (a, b, t) => a + (b - a) * t;

// 같은 rank 라도 필지 대소를 변주(찍어낸 인상 완화). 대칭·소폭이라 집 측여백(≈0.20·plotW)을
//   침범하지 않는다. reg 낮을수록(민촌·하급) 변주 큼.
function sizeVary(dims, reg, sr) {
  const sw = 1 + (sr() * 2 - 1) * lerpN(0.13, 0.04, reg);
  const sd = 1 + (sr() * 2 - 1) * lerpN(0.11, 0.035, reg);
  return { kind: dims.kind, plotW: dims.plotW * sw, plotD: dims.plotD * sd };
}

// ── R-P1 필지 부정형화 ──────────────────────────────────────────────
// 정연도(reg): 0=민촌·하급(불규칙) … 1=반가·정연. 신분(rank)·성격(char01) 함수.
//   반가/히어로는 정연(정사각에 가깝게), 민촌 하급은 크게 꺾인 부정형.
//   #54 체감 상향: 앱 부감(oblique·원거리)에서 부정형이 안 읽혀 하한을 대폭 인하하고 곡선을 아래로
//   내렸다. 여염(char01=0.5)도 저·중 rank 는 reg≈0.06~0.29 로 확연히 손그림, 반가 고rank 만 정연.
const regOf = (rank, char01, hero) =>
  hero ? 0.90 : Math.max(0, Math.min(1, 0.06 + rank * 0.46 + (char01 - 0.5) * 0.34));

// reg → 필지 방향 지터 최대각(rad). 정연 마을(격자 지향) 규칙을 완화해 손배치 인상.
const facingJitter = (reg, sr) => (sr() * 2 - 1) * lerpN(0.34, 0.09, reg);   // ±19.5°(민촌)~±5°(반가)

// 로컬 부정형 필지 폴리곤(docs R-P1). 좌표: X=좌우(도로 접선), Z=앞(+hd 도로변)~뒤(-hd).
//   집은 뒤(z=-hd 근처)에 앉고 앞(+hd)은 마당·대문쪽. 앞변(파사드)은 직선·전폭 고정 —
//   담 렌더(walls.buildFrontEdge)가 z=+hd 전폭 직선을 전제하고, 고증상 도로변은 곧은 파사드 +
//   불규칙 후면이 실제 지적 형상에 부합한다. 부정형은 측변 전단·뒷변 오므림/꺾임에 싣고,
//   격자 인상은 필지 방향 지터(호출부 frontDir)가 깬다.
//   · 측변: 전단(lean, 평행사변형 기욺 — 앞·뒤 함께 이동해 폭 보존)으로 크게 꺾음(reg 낮을수록 큼).
//   · 뒷변: 오므림(bn) 은 #45 검증한도(합 ≤0.21·plotW) 내로 클램프(집 뒤폭 보존) + 확률적 바깥
//     (-z) 꺾임(볼록·집 반대로 확장 → 안전, 손그림 능선순응). + 뒤깊이 지터로 좌우 비대칭.
//   결정론: 호출부가 시드 rng 주입. 반환 pts 는 볼록(SAT 겹침판정·offset 패드 안전).
// 반환: { pts:[{x,z}...], roles:[...] } — pts[k]→pts[k+1] 변의 역할 roles[k].
function localParcelShape(plotW, plotD, reg, sr) {
  const hw = plotW / 2, hd = plotD / 2;
  const sym = () => sr() * 2 - 1;
  // 전단: 평행사변형 기욺(앞·뒤 함께 이동 → 뒷폭 보존, 집 안전). 민촌 ±0.22W~반가 ±0.06W
  //   (#45 검증 상한 0.20W 근처 유지 — 집이 앉는 뒷측 여백 보존).
  const lean = sym() * plotW * lerpN(0.22, 0.06, reg);
  // 뒷변 오므림(집 뒤): 좌우 합이 0.21·plotW 를 넘지 않게 각각 0.105·plotW 클램프(#45 검증한도).
  const bnCap = plotW * 0.105;
  const bnL = Math.min(sr() * plotW * lerpN(0.17, 0.04, reg), bnCap);
  const bnR = Math.min(sr() * plotW * lerpN(0.17, 0.04, reg), bnCap);
  // 뒤 깊이 지터(뒷변·측변이 평행하지 않게). 뒤로(-z) 물러남만 허용해 뒷폭·집여백 보존.
  const zjL = -sr() * plotD * lerpN(0.18, 0.045, reg);
  const zjR = -sr() * plotD * lerpN(0.18, 0.045, reg);
  const FR = { x: hw, z: hd }, FL = { x: -hw, z: hd };        // 앞변(직선·전폭 고정)
  const BL = { x: -hw + lean + bnL, z: -hd + zjL };
  const BR = { x: hw + lean - bnR, z: -hd + zjR };
  const pts = [FR, FL, BL];
  const roles = ['front', 'left'];                           // FR→FL 앞, FL→BL 좌
  if (sr() < lerpN(0.72, 0.16, reg)) {
    // 뒷변 꺾임: 중점을 바깥(-z)으로만 밀어 볼록 유지(집 반대 방향 → 관통 무관).
    const mid = { x: (BL.x + BR.x) / 2 + sym() * plotW * 0.10,
                  z: (BL.z + BR.z) / 2 - plotD * (0.07 + sr() * 0.17) };
    pts.push(mid); roles.push('back');
  }
  pts.push(BR); roles.push('back');
  roles.push('right');                                       // BR→FR 우
  return { pts, roles };
}

// 남향 좌향은 길의 법선과 다를 수 있으므로 plotD/2 고정 이격으로는 회전한 필지가
// 자기 길을 다시 덮는다. 실제 shape를 길 반대 방향에 투영해 도로측 끝이 shoulder 밖에
// 놓이는 최소 중심 이격을 구한다.
function roadSetbackForShape(shape, frontDir, awayFromRoad, shoulder) {
  const front = G.norm(frontDir);
  const right = { x: front.z, z: -front.x };
  let nearest = Infinity;
  for (const point of shape.pts) {
    const x = right.x * point.x + front.x * point.z;
    const z = right.z * point.x + front.z * point.z;
    nearest = Math.min(nearest, x * awayFromRoad.x + z * awayFromRoad.z);
  }
  return shoulder - nearest;
}

// ── R-P2 고샅(골목) 폭 ──────────────────────────────────────────────
// 이웃 담 사이 틈 = 고샅. 소로급 1.0~3.4m 변주(민촌·하급 좁게, 반가·반촌 넓게).
function gapWidth(rank, char01, rng) {
  const base = 0.85 + (0.55 * rank + 0.45 * char01) * 2.5;   // 0.85(하급 좁은 고샅) ~ 3.35(반가·반촌)
  return Math.max(0.7, Math.min(3.9, base + rng.range(-0.35, 0.35)));
}

// 점 p 에서 폴리곤 poly(변 집합)까지 최단거리.
function polyDist(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = G.distToSeg(p, poly[i], poly[(i + 1) % poly.length]).d;
    if (d < best) best = d;
  }
  return best;
}

export function planParcels(site, roadsResult, opts, rng, blockers = []) {
  const scale = opts.scale;
  const lotWScale = LOT_W_SCALE[scale] || 1;
  const lotDScale = LOT_D_SCALE[scale] || 1;
  const giwaDBoost = GIWA_LOT_D_BOOST[scale] || 1;
  const structureScale = STRUCTURE_SCALE[scale] || 1;
  const compactLot = (dims) => ({
    ...dims,
    plotW: dims.plotW * lotWScale,
    plotD: dims.plotD * lotDScale * (dims.kind === 'giwa' ? giwaDBoost : 1),
  });
  const char01 = typeof opts.char01 === 'number' ? opts.char01 : 0.5;
  const roads = roadsResult.roads;
  const roadSpatial = createRoadSpatialIndex(roads);
  const streamSpatial = createStreamSpatialIndex(site);
  const C = site.center;
  // 필지 목표수: 연속 스케일(#89)은 plan 이 siteR 파생 연속값(opts.target)을 주입 → tier 경계에서
  //   호수(戶數)가 튀지 않는다. 미주입(구 호출)이면 이산 SCALE_TARGET 폴백(회귀 안전).
  //   target 0 도 유효(#114 외딴집·"절 하나만": 프론티지 0 — 종가 예약 코어는 plan 쪽 소관) — 미주입만 폴백.
  const target = (typeof opts.target === 'number' && opts.target >= 0) ? Math.round(opts.target) : (SCALE_TARGET[scale] || 30);
  const parcels = [];
  const placed = makePlacedGrid();                              // 충돌 폴리곤 공간해시(예약분 포함)
  const placedRoofs = makePlacedGrid();
  const placedSolarAccess = makePlacedGrid();
  for (const blocker of blockers) {
    if (blocker.kind && blocker.seed != null) {
      if (blocker.sx == null) assignFittedVariation(blocker, char01, opts.tuning);
      else fitHouseWithinParcel(blocker);
    }
    if (blocker.poly) {
      placed.add(blocker.poly);
      if (blocker.kind) reserveParcelSun(blocker, placedRoofs, placedSolarAccess);
      else if (blocker.solarObstruction !== false) {
        placedRoofs.add(blocker.poly, { blockingPolygon: blocker.poly });
      }
    }
  }

  const northRef = C.z - site.bowlR * 0.35;    // 최북 거주선(주산 기슭)

  const rankAt = (center, level) => {
    const dC = G.dist(center, C);
    const nearC = 1 - smoothstep(0, site.bowlR * 0.95, dC);
    const north = 1 - smoothstep(northRef, site.streamZ, center.z);  // 북(주산측)→1, 남(개울측)→0
    let r = 0.12 + 0.50 * nearC + 0.22 * north + (ARTERIAL_BONUS[level] || 0);
    r += rng.range(-0.07, 0.07);
    return Math.max(0, Math.min(1, r));
  };

  // 필지 유효성: 분지 안 · 개울/논 회피 · 남한선 · 급경사 회피 · 타도로/타필지 비겹침.
  // 자기 길은 실제 poly↔ribbon 계약으로, 다른 길은 후보 중심 회랑으로 빠르게 검사한다.
  const clearOfRoads = (center, ownRoad) =>
    !roadSpatial.withinRoadClearance(center, ownRoad, 2.5);
  const validate = (parcel, ownRoad) => {
    const { center, poly } = parcel;
    // 필지 전체가 실제 지형 메시와 성곽 안쪽에 있어야 한다. 중심점만 검사하면 큰 필지 모서리가
    // world-edge 밖으로 삐치거나 성벽을 관통한다.
    if (!worldEdgeContainsPolygon(site.edge, poly, 6)) { dbg.edge = (dbg.edge || 0) + 1; return false; }
    if (opts.cityWall && !cityWallContainsPolygon(opts.cityWall, poly, 6)) { dbg.wall = (dbg.wall || 0) + 1; return false; }
    // #120 비원형 분지: 외곽 한계를 방위별 분지 반경(bowlRAt)에 태워 신장 로브까지 필지가 뻗게 한다.
    const bowlLim = site.bowlRAt ? site.bowlRAt(center.x, center.z) : site.bowlR;
    if (G.dist(center, C) > bowlLim * 1.06) { dbg.bowl++; return false; }
    if (streamSpatial.intersectsPolygon(poly, STREAM_PARCEL_BANK_CLEARANCE)) { dbg.stream++; return false; }
    if (site.paddyRegion) {
      const pr = site.paddyRegion;
      if (center.x > pr.xMin - 2 && center.x < pr.xMax + 2 && center.z > pr.zNear - 2 && center.z < pr.zFar + 2) { dbg.paddy++; return false; }
    }
    // 남한선: 씨족촌은 개울 북쪽만, 도성/읍치는 남촌 일부 허용
    const southLimit = (scale === 'hamlet' || scale === 'village')
      ? site.streamZ - 5
      : site.streamZ + site.bowlR * 0.26;
    if (center.z > southLimit) { dbg.south++; return false; }
    if (site.hillAt(center.x, center.z) > 0.52) { dbg.hill++; return false; }    // 능선·안산 급경사 제외
    // 급경사 필지 배제: footprint 지형 낙차가 한 계단(성토 패드)으로 감당 안 되면 제외.
    //   → 거대 축대·집 공중부양 방지. 완경사·언듈레이션 위(낙차 작음)만 통과.
    {
      let gmin = Infinity, gmax = -Infinity;
      for (const c of poly) { const g = site.heightAt(c.x, c.z); if (g < gmin) gmin = g; if (g > gmax) gmax = g; }
      if (gmax - gmin > 1.6) { dbg.steep++; return false; }
    }
    if (!clearOfRoads(center, ownRoad)) { dbg.road++; return false; }
    if (placed.overlaps(poly)) { dbg.overlap++; return false; }
    if (parcelSunBlocked(parcel, site, placedRoofs, placedSolarAccess)) {
      dbg.solar = (dbg.solar || 0) + 1;
      return false;
    }
    if (roadSpatial.intersectsRoadCorridor(poly, 0.2)) {
      dbg.road++;
      return false;
    }
    return true;
  };

  const ordered = roads.slice().sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]));
  let heroCount = 0;
  // 반가(hero) 밀도: 민촌은 0(예약 종가만), 반촌은 다수 — 빈부의 핵심 시각신호.
  const baseCap = scale === 'hanyang' ? 6 : scale === 'capital' ? 6 : scale === 'town' ? 4 : scale === 'village' ? 2 : 1;
  const heroCap = char01 < 0.34 ? 0 : Math.max(1, Math.round(baseCap * (0.3 + char01)));
  const heroRankMin = 0.86 - char01 * 0.16;    // 반촌일수록 반가 승격 문턱 낮음
  const heroDistK = 0.45 + char01 * 0.28;      // 반촌일수록 반가가 중심에서 더 넓게
  const dbg = {
    candidates: 0, bowl: 0, stream: 0, paddy: 0, south: 0, hill: 0,
    steep: 0, road: 0, overlap: 0, houseFit: 0, placed: 0,
  };
  planParcels.lastDebug = dbg;

  const FS = 2.0;              // 커서 정밀도(m)
  for (const road of ordered) {
    if (parcels.length >= target) break;
    const fine = G.resample(road.pts, FS);
    if (fine.length < 4) continue;
    const endPad = Math.round((road.width * 0.6 + 4) / FS);   // 교차·끝부 회피
    // 같은 길의 양편 중 길이 남쪽에 놓이는 필지(대문이 남향하기 쉬운 쪽)를 먼저 채운다.
    // 반대편은 목표 호수를 채울 때만 자연스럽게 사용되어 북향 예외가 무작위로 앞서지 않는다.
    const sides = [1, -1].sort((a, b) => {
      const roadDirA = G.mul(G.perpL(fine[1].tan), -a);
      const roadDirB = G.mul(G.perpL(fine[1].tan), -b);
      return roadDirB.z - roadDirA.z;
    });
    for (const side of sides) {
      // 도로를 따라 커서 전진: 배치 성공 시 필지폭+골 만큼, 실패 시 FS 씩.
      let i = endPad;
      while (i < fine.length - endPad) {
        if (parcels.length >= target) break;
        const smp = fine[i];
        const inward = G.mul(G.perpL(smp.tan), side);
        const provisional = G.add(smp.pt, G.mul(inward, road.width / 2 + 8));
        let rank = rankAt(provisional, road.level);
        let dims = compactLot(dimsFor(rank, char01));
        let hero = false, heroStyle;
        if (rank >= heroRankMin && heroCount < heroCap && G.dist(provisional, C) < site.bowlR * heroDistK) {
          hero = true; heroStyle = 'hanok';
          dims = { kind: 'giwa', plotW: 26, plotD: 24 };
        }
        const pseed = (opts.seed ^ (parcels.length * 2654435761)) >>> 0;
        const reg = regOf(rank, char01, hero);
        if (!hero) dims = sizeVary(dims, reg, makeRng((pseed ^ 0x51fa) >>> 0));  // 같은 rank 내 대소 변주
        const inwardDir = G.norm(G.mul(inward, -1));            // 도로를 향한 기본 방향
        const jitter = hero ? 0 : facingJitter(reg, makeRng((pseed ^ 0x77d1) >>> 0));
        const frontDir = terrainAlignedFacing(inwardDir, SOUTH, jitter);
        const shape = hero ? rectangularParcelShape(dims.plotW, dims.plotD)
          : localParcelShape(dims.plotW, dims.plotD, reg, makeRng((pseed ^ 0xa53f) >>> 0));
        const setback = roadSetbackForShape(
          shape,
          frontDir,
          inward,
          road.width / 2 + ROAD_CURVE_SETBACK,
        );
        const center = G.add(smp.pt, G.mul(inward, setback));
        const parcel = attachParcelSpatialContract({
          shape, center, frontDir, rank, kind: dims.kind,
          plotW: dims.plotW, plotD: dims.plotD, hero, heroStyle, seed: pseed,
          structureScale: hero ? 1 : structureScale,
          placement: 'frontage',
        }, road.id, smp.pt);
        const poly = parcel.poly;
        if (!assignFittedVariationSequence(parcel, char01, opts.tuning, { baseSeed: pseed, attempts: 4 })) {
          dbg.houseFit++;
          i += 1;
          continue;
        }
        dbg.candidates++;
        if (validate(parcel, road)) {
          dbg.placed++;
          parcels.push(parcel);
          placed.add(poly);
          reserveParcelSun(parcel, placedRoofs, placedSolarAccess);
          if (hero) heroCount++;
          const gap = gapWidth(rank, char01, rng);              // R-P2 고샅 폭 변주
          i += Math.max(1, Math.round((dims.plotW + gap) / FS)); // 필지폭 + 고샅만큼 전진
        } else {
          i += 1;                                                   // 다음 자리 시도
        }
      }
    }
  }

  // ── 내부 충전(Poisson) ── 도로 회랑(≤maxRoadDist) 안에 남은 자리를 채운다. 각 집은
  // 가장 가까운 도로를 바라봐 방향 정합 유지 → 안길을 따라 두툼한 유기 군집이 된다.
  // 골목망이 성긴 대도성도 보행 연결 가능한 두세 필지 깊이까지만 충전한다. 예전의
  // 무제한 R 비례식은 한양에서 대문이 길로부터 80m 가까이 떨어진 집을 만들었다.
  const maxRoadDist = Math.min(site.R * 0.16 + 6, scale === 'hanyang' ? 64 : 40);
  const tryInfill = (p0) => {
    const best = roadSpatial.nearest(p0, maxRoadDist);
    if (!best.pt || best.d > maxRoadDist) return false;
    const rank = rankAt(p0, 'golmok');
    const pseed = (opts.seed ^ (parcels.length * 2654435761)) >>> 0;
    const reg = regOf(rank, char01, false);
    const dims = sizeVary(compactLot(dimsFor(rank, char01)), reg,
      makeRng((pseed ^ 0x51fa) >>> 0));
    const frontDir = terrainAlignedFacing(
      G.norm(G.sub(best.pt, p0)),
      SOUTH,
      facingJitter(reg, makeRng((pseed ^ 0x77d1) >>> 0)),
    );
    const shape = localParcelShape(dims.plotW, dims.plotD, reg, makeRng((pseed ^ 0xa53f) >>> 0));
    const awayFromRoad = G.norm(G.sub(p0, best.pt));
    const roadSetback = roadSetbackForShape(
      shape,
      frontDir,
      awayFromRoad,
      (best.road?.width || 0) / 2 + ROAD_CURVE_SETBACK,
    );
    if (best.d < roadSetback) return false;                // 회전된 실제 필지의 도로 침범 방지
    const parcel = attachParcelSpatialContract({
      shape, center: p0, frontDir, rank, kind: dims.kind,
      plotW: dims.plotW, plotD: dims.plotD, hero: false, seed: pseed,
      structureScale,
      placement: 'infill',
    }, best.road?.id, best.pt);
    const poly = parcel.poly;
    if (!assignFittedVariationSequence(parcel, char01, opts.tuning, { baseSeed: pseed, attempts: 4 })) {
      dbg.houseFit++;
      return false;
    }
    dbg.candidates++;
    if (!validate(parcel, best.road)) return false;
    dbg.placed++;
    parcels.push(parcel);
    placed.add(poly);
    reserveParcelSun(parcel, placedRoofs, placedSolarAccess);
    return true;
  };

  // 도로변 배정 뒤 남은 블록의 작은 틈을 결정론적 난수 표본으로 보완한다.
  const radExp = scale === 'capital' ? 0.62 : scale === 'town' ? 0.66 : 0.72;
  let guard = 0;
  while (parcels.length < target && guard < target * 180) {
    guard++;
    const ang = rng.range(0, Math.PI * 2);
    const bowlRad = site.bowlRadiusAt ? site.bowlRadiusAt(ang) : site.bowlR;
    const rad = bowlRad * Math.pow(rng(), radExp);
    tryInfill({ x: C.x + Math.cos(ang) * rad, z: C.z + Math.sin(ang) * rad });
  }

  // ── R-P2 담 변별·공유(고샅 모델) ── 각 변의 이웃 근접도로 담 높이 차등 + 밀착 경계 담 1줄.
  //   앞변(도로/골목변)=높음, 이웃변(측·뒤)=낮음. 밀착(<SHARE)은 낮은 index 필지만 담을 남겨 1줄 공유.
  assignEdgeShare(parcels);

  return parcels;
}

const SHARE_DIST = 1.15;   // 이 이하로 붙은 경계 = 담 1줄 공유(중복 링 제거)
const ALLEY_DIST = 3.8;    // 이 이하 = 고샅/이웃변(담 낮춤), 이상 = 개방·거리변(담 살짝 높임)

// 각 필지 shape 변에 { role, heightK, share } 메타를 채운다(월드 poly 기준 이웃 근접 판정).
//   heightK: 앞 1.0 / 밀착 0.62 / 이웃 0.66 / 개방·거리변 0.85. share: 밀착 시 높은 index 가 담 생략.
function assignEdgeShare(parcels) {
  parcels.forEach((p, i) => { p._idx = i; });
  const nonHero = parcels.filter((p) => !p.hero && p.shape && p.poly);
  for (const P of nonHero) {
    const poly = P.poly, roles = P.shape.roles, n = poly.length;
    const gateEdge = Number.isInteger(P.access?.gateEdge)
      ? P.access.gateEdge
      : roles.indexOf('front');
    const sr = makeRng((P.seed ^ 0x1122b) >>> 0);
    const edges = new Array(n);
    for (let k = 0; k < n; k++) {
      const role = roles[k];
      if (k === gateEdge || role === 'front') {
        edges[k] = { role, heightK: 1.0, share: false, gate: k === gateEdge };
        continue;
      }
      const a = poly[k], b = poly[(k + 1) % n];
      const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      let nearest = Infinity, nearIdx = -1;
      for (const Q of nonHero) {
        if (Q === P) continue;
        const d = polyDist(m, Q.poly);
        if (d < nearest) { nearest = d; nearIdx = Q._idx; }
      }
      let heightK, share = false;
      if (nearest < SHARE_DIST) { heightK = 0.62; share = P._idx > nearIdx; }   // 밀착: 담 1줄
      else if (nearest < ALLEY_DIST) heightK = 0.66;                            // 고샅/이웃변
      else heightK = 0.85;                                                      // 개방·거리변
      heightK *= 0.97 + sr() * 0.06;                                            // 미세 편차
      edges[k] = { role, heightK, share };
    }
    P.shape.edges = edges;
  }
}

// ── 위성 부락(#120) ── 본동에서 조금 떨어진 완사면 포켓에 흩어진 작은 무리(몇 채). 조선 마을이 본동 +
//   외딴 몇 집으로 퍼지는 자연스러움. 분지 밖(minR 바깥)의 낮은 어깨를 스캔해 완경사·비능선·비정북(주산
//   실루엣 보호)·on-mesh 앵커를 고르고, 그 둘레에 남향 초가 위주 2~5채를 한 줄(+뒷줄)로 앉힌다. 반환
//   parcel 은 정규 필지와 동일 형태({poly,shape,center,frontDir,rank,kind,plotW,plotD,seed}) — plan 이
//   parcels 에 편입하면 id·assignVariation·populate 조립·나무 clearance/mask·야경·소동물이 그대로 적용된다.
//   전용 rng(공유 rng·필지 seed 공간 불침해, 결정론). existing = 겹침 회피용 기존 필지·예약 polygon.
export function planSatellites(site, opts, seed, {
  existing = [],
  residential = [],
  solarObstacles = [],
  cityWall = null,
  roads = [],
  riverPort = null,
} = {}) {
  const scale = opts.scale;
  const householdContext = {
    settlementScale01: Number.isFinite(opts.scale01) ? opts.scale01 : undefined,
  };
  const char01 = typeof opts.char01 === 'number' ? opts.char01 : 0.5;
  const nClusters = ({ hamlet: 0, village: 1, town: 1, capital: 2, hanyang: 3 })[scale] || 0;
  if (nClusters <= 0 && !riverPort) return [];
  const rng = makeRng((seed ^ 0x5a7e11) >>> 0);
  const C = site.center, bowlR = site.bowlR, TR = site.terrainR || site.R;
  const baseRLo = bowlR * 1.14;
  const baseRHi = Math.min(TR * 0.9, bowlR * 1.66);
  if (!cityWall && baseRHi <= baseRLo + 8 && !riverPort) return [];

  const foot = 13;                                   // 소형 필지 footprint 상당(완경사 판별)
  const footSlope = (x, z) => {
    let lo = 1e9, hi = -1e9;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const h = site.heightAt(x + i * foot / 2, z + j * foot / 2);
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return hi - lo;
  };
  const nearStream = (x, z, m) => site.stream && Math.abs(z - site.streamZat(x)) < site.streamHalf + m;
  const gateApproaches = cityWall ? cityWall.gates.map((gate) => cityGateApproachFootprint(gate)) : [];

  // 앵커 후보 스캔: (phi, r) 격자에서 완사면·저능선·비정북·비하천 지점 수집·점수화.
  const cands = [];
  const NP = 48;
  for (let p = 0; p < NP; p++) {
    const phi = (p / NP) * Math.PI * 2;
    const dx = Math.cos(phi), dz = Math.sin(phi);
    if (dz < -0.72) continue;                        // 정북(-z) 콘 배제 → 주산 배후 보호
    // 성곽이 있으면 고정 bowl 배수 띠가 아니라 실제 방위별 성벽 바깥에서 스캔을 시작한다. 부정형 벽이
    // r≈340까지 나온 방향을 옛 rHi≈342가 거의 덮어 위성 부락이 0이 되던 문제를 없애고, world edge까지의
    // 얇은 성저 공간을 방향마다 온전히 활용한다.
    const wallAngle = Math.atan2(dx, dz);             // contour 규약(+z=0)
    const scanLo = cityWall
      ? Math.max(bowlR * 1.02, cityWallRadiusAt(cityWall, wallAngle) + foot / 2 + 5)
      : baseRLo;
    const scanHi = cityWall
      ? scanLo + bowlR * 0.55
      : baseRHi;
    if (scanHi <= scanLo + 8) continue;
    const scanStep = bowlR * (cityWall ? 0.04 : 0.06);
    for (let r = scanLo; r <= scanHi; r += scanStep) {
      const x = C.x + dx * r, z = C.z + dz * r;
      const anchor = { x, z };
      if (gateApproaches.some((approach) => G.pointInPoly(anchor, approach))) continue;
      if (worldEdgeClearance(site.edge, anchor) < foot / 2 + 6) continue;
      if (cityWall && cityWallClearance(cityWall, anchor) > -(foot / 2 + 4)) continue;
      if (site.hillAt(x, z) > (cityWall ? 0.54 : 0.44)) continue; // 성저 어깨만 완화; 기존 무성곽 규모 불변
      const slope = footSlope(x, z);
      if (slope > (cityWall ? 4.6 : 4.2)) continue;   // 성저만 중경사 축대 허용; 기존 위성 부락 계약 보존
      if (nearStream(x, z, 4)) continue;
      const south = dz > 0.2 ? 1 : 0;                // 남측(계곡 입구) 외딴집 선호
      const score = -site.hillAt(x, z) * 3 - slope * 1.4 - (r - scanLo) / bowlR * 0.5 + south * 0.6 + rng() * 0.35;
      cands.push({ x, z, phi, r, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  // 각 분리(≈60°) 확보하며 nClusters 앵커 선정.
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= nClusters) break;
    let ok = true;
    for (const q of chosen) { let d = Math.abs(c.phi - q.phi); if (d > Math.PI) d = Math.PI * 2 - d; if (d < 1.05) { ok = false; break; } }
    if (ok) chosen.push(c);
  }
  const clusterPlans = [
    ...chosen,
    ...(riverPort?.wards || []).map((ward) => ({
      ...ward,
      riverbank: true,
      tangent: { x: 1, z: 0 },
      rowDir: { x: 0, z: 1 },
    })),
  ];
  if (!clusterPlans.length) return [];

  const placed = makePlacedGrid();
  const placedRoofs = makePlacedGrid();
  const placedSolarAccess = makePlacedGrid();
  const roadSpatial = createRoadSpatialIndex(roads);
  const streamSpatial = createStreamSpatialIndex(site);
  for (const poly of existing) if (poly) placed.add(poly);
  for (const poly of solarObstacles) if (poly) {
    placedRoofs.add(poly, { blockingPolygon: poly });
  }
  for (const parcel of residential) reserveParcelSun(parcel, placedRoofs, placedSolarAccess);
  const out = [];
  let sidx = 0;
  for (const anchor of clusterPlans) {
    const cseed = anchor.seed ?? ((seed ^ (0x5afe1 * (sidx + 1))) >>> 0);
    const crng = makeRng(cseed);
    const big = scale === 'capital' || scale === 'hanyang';
    const kTarget = anchor.target ?? (2 + Math.floor(crng() * (big ? 4 : 3)));   // 2~4(마을) / 2~5(도성)
    const cellW = 10.5 * (0.86 + char01 * 0.3);
    // 등반경 접선 열(같은 표고대 유지) + 안쪽(저지) 뒷줄 — 방사(고지) 확산을 피해 얇은 완사면대에 앉힌다.
    const rad = G.norm({ x: anchor.x - C.x, z: anchor.z - C.z });   // 바깥 방사
    const tan = anchor.tangent || { x: -rad.z, z: rad.x };          // 접선(등반경)
    const rowDir = anchor.rowDir || rad;                            // 포구만 명시 남안 방향
    // A ferry ward is a single long street frontage. Keeping its households on
    // one south-facing row preserves every solar corridor and reads as a port
    // settlement; generic satellites retain compact 2–3-house rows.
    const perRow = anchor.riverbank
      ? Math.max(2, kTarget)
      : Math.min(3, Math.max(2, kTarget));
    let col = 0, row = 0, made = 0, attempts = 0;
    while (made < kTarget && attempts < kTarget * 7) {
      attempts++;
      const tOff = (col - (perRow - 1) / 2) * cellW + crng.range(-1.0, 1.0);   // 접선 방향(등반경)
      const rowSign = anchor.rowDir ? 1 : -1;                                 // 기본=내측(-rad), 포구=남안
      const rOff = rowSign * row * cellW * 1.05 + crng.range(-1.0, 1.0);
      col++; if (col >= perRow) { col = 0; row++; }
      const px = anchor.x + tan.x * tOff + rowDir.x * rOff;
      const pz = anchor.z + tan.z * tOff + rowDir.z * rOff;
      if (site.hillAt(px, pz) > 0.54) continue;
      if (footSlope(px, pz) > 4.6) continue;                        // 성토 계단(computePadY 축대); 어깨 부락 허용
      if (nearStream(px, pz, 3)) continue;
      const rank = Math.max(0, 0.16 + (char01 - 0.5) * 0.30 + crng.range(-0.06, 0.06)); // 외딴집=하급(초가 우세)
      const pseed = (cseed ^ (made * 2654435761)) >>> 0;
      const reg = regOf(rank, char01, false);
      let dims = sizeVary(dimsFor(rank, char01), reg, makeRng((pseed ^ 0x51fa) >>> 0));
      if (anchor.riverbank) dims = {
        ...dims,
        plotW: dims.plotW * 0.86,
        plotD: dims.plotD * 0.86,
      };
      const frontDir = terrainAlignedFacing(
        SOUTH,
        SOUTH,
        facingJitter(reg, makeRng((pseed ^ 0x77d1) >>> 0)) * 0.7,
      );
      const shape = localParcelShape(dims.plotW, dims.plotD, reg, makeRng((pseed ^ 0xa53f) >>> 0));
      const center = { x: px, z: pz };
      const accessRoad = roadSpatial.nearest(center, anchor.riverbank ? 64 : 32);
      const parcel = attachParcelSpatialContract({
        shape, center, frontDir, rank, kind: dims.kind,
        plotW: dims.plotW, plotD: dims.plotD, hero: false, seed: pseed,
        ...householdContext,
        satellite: true,
        riverbank: anchor.riverbank === true,
        placement: anchor.riverbank ? 'river-port' : 'satellite',
      }, accessRoad.road?.id, accessRoad.pt);
      const poly = parcel.poly;
      if (!assignFittedVariationSequence(parcel, char01, opts.tuning, { baseSeed: pseed, attempts: 4 })) continue;
      if (!worldEdgeContainsPolygon(site.edge, poly, 6)) continue;
      if (cityWall && !cityWallOutsidePolygon(cityWall, poly, 4)) continue;
      if (site.stream?.kind === 'river'
        && terrainRangeOnPolygon(site, poly, 5).range > 2.8) continue;
      if (gateApproaches.some((approach) => G.polysOverlap(poly, approach))) continue;
      if (streamSpatial.intersectsPolygon(poly, STREAM_SATELLITE_BANK_CLEARANCE)) continue;
      if (roadSpatial.intersectsRoadCorridor(poly, 0.2)) continue;
      if (placed.overlaps(poly)) continue;
      if (parcelSunBlocked(parcel, site, placedRoofs, placedSolarAccess)) continue;
      out.push(parcel);
      placed.add(poly);
      reserveParcelSun(parcel, placedRoofs, placedSolarAccess);
      made++;
    }
    sidx++;
  }
  if (out.length) assignEdgeShare(out);   // 위성 군집 내 담 공유·높이 차등
  return out;
}

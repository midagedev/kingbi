import * as G from '../core/math/geom2.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallClearance,
  clampPointInsideCityWall,
  clampPointOutsideCityWall,
  worldEdgeClearance,
} from './citywall-contour.js';
import { attachRoadJunctions } from './road-topology.js';

// 2단계 도로 생성 (joseon-city.md 규칙 3·4·11·12·13·14·17).
//   1) 간선(대로·중로)은 결정론 골격 — 십자/T/남북대로. 곧게(등고 따라 완만 곡선 허용).
//   2) 이면(소로·골목)은 유기 — 간선/스파인에서 가지형으로 분기하며 등고에 순응해 휜다.
//   공통 원칙: 전역 격자는 결코 완성되지 않는다.
//
// planRoads(site, opts, rng) → { roads:[{id,level,width,pts,junctionIds}], nodes, spine }
//   level: 'daero'(17.5) | 'jungno'(5.0) | 'soro'(3.4) | 'golmok'(2.4)  — 경국대전 폭 등급

export const ROAD_WIDTH = { daero: 17.5, jungno: 5.0, soro: 3.4, golmok: 2.4 };

// 유기 경로: a→b 를 잇되 진행방향 수직으로 사인 합성 오프셋을 주어 완만히 휘게 한다.
// 양 끝은 sin(πt) 로 0 수렴 → 접합부 깔끔. amp 로 휨 세기 조절.
function organicPath(a, b, rng, { amp = 6, comps = 2 } = {}) {
  const L = G.dist(a, b);
  if (L < 1e-3) return [a, b];
  const steps = Math.max(6, Math.round(L / 5));
  const d = G.norm(G.sub(b, a));
  const perp = G.perpL(d);
  const waves = [];
  for (let k = 0; k < comps; k++) {
    // 난수 소비량(성분당 3회)은 기존과 동일하게 유지한다. 파장은 저주파에 묶고
    // 고조파 진폭은 제곱 감쇠해 짧은 골목의 톱니형 꺾임을 없앤다.
    waves.push({
      cycles: (0.38 + 0.52 * k) * rng.range(0.85, 1.15),
      ph: rng.range(0, Math.PI * 2),
      a: amp * rng.range(0.5, 1) / ((k + 1) ** 2),
    });
  }
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const base = G.lerp(a, b, t);
    let off = 0;
    for (const wv of waves) off += wv.a * Math.sin(Math.PI * 2 * wv.cycles * t + wv.ph);
    // sin² envelope는 위치뿐 아니라 끝점 미분도 0으로 만들어 분기·T 접합의
    // 접선을 원래 간선 방향에 맞춘다.
    off *= Math.sin(Math.PI * t) ** 2;
    pts.push(G.add(base, G.mul(perp, off)));
  }
  return pts;
}

// 곧은 간선(대로): 등고에 살짝만 순응. amp 작게.
function trunkPath(a, b, rng) { return organicPath(a, b, rng, { amp: G.dist(a, b) * 0.03, comps: 1 }); }

// 간선/스파인에서 가지 분기: 시작점·방향에서 유기 골목을 뻗는다. 분지 밖으로 나가면 자른다.
function branchPath(from, dir, len, rng, site) {
  const end = G.add(from, G.mul(G.norm(dir), len));
  const pts = organicPath(from, end, rng, { amp: len * 0.14, comps: 2 });
  // 분지(bowl) 밖으로 나가면 그 지점에서 종단
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    out.push(pts[i]);
    const r = G.dist(pts[i], site.center);
    if (r > site.bowlR * 1.02) break;
    if (site.stream && Math.abs(pts[i].z - site.streamZat(pts[i].x)) < site.streamHalf + 2) break; // 개울 침범 방지
  }
  return out.length >= 2 ? out : null;
}

// 새 샛길은 기존 길을 가로질러 계속 뻗지 않고 첫 접속점에서 끝난다. 시작점은 부모 길과
// 의도적으로 맞닿으므로 짧은 초기 구간의 교차만 무시한다. 이 한 규칙으로 골목망은
// 교차 낙서가 아니라 간선→안길→막다른 길의 얕은 프랙탈이 된다.
const MIN_USABLE_BRANCH_LENGTH = 12;
const ROAD_HIERARCHY = { daero: 0, jungno: 1, soro: 2, golmok: 3 };

function trimBranchAtRoads(points, roads, minimumAdvance = 2.5) {
  if (!points || points.length < 2 || roads.length === 0) return points;
  let traversed = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const segmentLength = G.dist(a, b);
    let nearest = null;
    for (const road of roads) {
      for (let j = 0; j < road.pts.length - 1; j++) {
        const hit = G.segIntersect(a, b, road.pts[j], road.pts[j + 1]);
        if (!hit) continue;
        const advance = traversed + segmentLength * hit.t;
        if (advance <= minimumAdvance) continue;
        if (!nearest || hit.t < nearest.t) nearest = hit;
      }
    }
    if (nearest) {
      if (traversed + segmentLength * nearest.t < MIN_USABLE_BRANCH_LENGTH) return null;
      return [...points.slice(0, i + 1), { x: nearest.x, z: nearest.z }];
    }
    traversed += segmentLength;
  }
  return points;
}

function roadPairIntersections(a, b) {
  const hits = [];
  let distanceA = 0;
  for (let ai = 0; ai < a.pts.length - 1; ai++) {
    const lengthA = G.dist(a.pts[ai], a.pts[ai + 1]);
    let distanceB = 0;
    for (let bi = 0; bi < b.pts.length - 1; bi++) {
      const lengthB = G.dist(b.pts[bi], b.pts[bi + 1]);
      const hit = G.segIntersect(a.pts[ai], a.pts[ai + 1], b.pts[bi], b.pts[bi + 1]);
      if (hit) {
        const point = { x: hit.x, z: hit.z };
        if (!hits.some((previous) => G.dist2(previous.point, point) < 1e-10)) hits.push({
          point,
          a: { segment: ai, distance: distanceA + lengthA * hit.t },
          b: { segment: bi, distance: distanceB + lengthB * hit.u },
        });
      }
      distanceB += lengthB;
    }
    distanceA += lengthA;
  }
  return hits;
}

function roadSliceToHit(road, hit, keepStart) {
  if (keepStart) {
    const points = [...road.pts.slice(0, hit.segment + 1), hit.point];
    if (G.dist2(points.at(-2), points.at(-1)) < 1e-12) points.pop();
    return points;
  }
  const points = [hit.point, ...road.pts.slice(hit.segment + 1)];
  if (G.dist2(points[0], points[1]) < 1e-12) points.shift();
  return points;
}

// 두 ribbon이 서로 떨어지기도 전에 재교차하면 화면에는 바늘구멍 같은 렌즈가 남는다.
// 낮은 위계의 길을 한 접점에서 끝내 실제 geometry를 T자로 만들고, metadata만 합쳐 숨기지 않는다.
function collapseNarrowRoadLenses(roads) {
  let changed = true, guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    outer: for (let ai = 0; ai < roads.length; ai++) {
      for (let bi = ai + 1; bi < roads.length; bi++) {
        const a = roads[ai], b = roads[bi];
        const hits = roadPairIntersections(a, b);
        const threshold = Math.min(a.width, b.width) * 0.5;
        let lens = null;
        for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
          if (G.dist(hits[i].point, hits[j].point) <= threshold) {
            lens = [hits[i], hits[j]];
            break;
          }
        }
        if (!lens) continue;
        const victimIsA = (ROAD_HIERARCHY[a.level] || 0) > (ROAD_HIERARCHY[b.level] || 0)
          || (a.level === b.level && ai > bi);
        const victimIndex = victimIsA ? ai : bi;
        const victim = roads[victimIndex];
        const key = victimIsA ? 'a' : 'b';
        const ordered = lens.slice().sort((x, y) => x[key].distance - y[key].distance);
        const total = G.polylineLength(victim.pts);
        const before = ordered[0][key].distance;
        const after = total - ordered[1][key].distance;
        if (Math.max(before, after) < MIN_USABLE_BRANCH_LENGTH) {
          roads.splice(victimIndex, 1);
        } else {
          const keepStart = before >= after;
          const chosen = keepStart ? ordered[0] : ordered[1];
          victim.pts = roadSliceToHit(victim, {
            ...chosen[key],
            point: chosen.point,
          }, keepStart);
        }
        changed = true;
        break outer;
      }
    }
  }
}

function clipRoadsToWall(roads, cityWall, except = new Set()) {
  for (let i = roads.length - 1; i >= 0; i--) {
    const road = roads[i];
    if (except.has(road)) continue;
    const margin = road.width * 0.5 + CITY_WALL_DIMENSIONS.roadEdgeMargin;
    let run = [], best = [];
    for (const point of road.pts) {
      if (cityWallClearance(cityWall, point) >= margin) run.push(point);
      else {
        if (run.length > best.length) best = run;
        run = [];
      }
    }
    if (run.length > best.length) best = run;
    if (best.length >= 2) road.pts = best;
    else roads.splice(i, 1);
  }
}

function wallHorizontalInset(cityWall, z, side, inset = 12) {
  if (!cityWall) return null;
  const origin = { x: cityWall.cx, z };
  if (cityWallClearance(cityWall, origin) < inset) return null;
  const limit = Math.max(...cityWall.radii) + inset;
  const step = Math.max(1.5, cityWall.meanRadius / 100);
  let lo = 0, hi = null;
  for (let d = step; d <= limit + step; d += step) {
    const p = { x: cityWall.cx + side * d, z };
    if (cityWallClearance(cityWall, p) >= inset) lo = d;
    else { hi = d; break; }
  }
  if (hi == null) return null;
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) * 0.5;
    const p = { x: cityWall.cx + side * mid, z };
    if (cityWallClearance(cityWall, p) >= inset) lo = mid;
    else hi = mid;
  }
  return { x: cityWall.cx + side * lo, z };
}

function safeHorizontalSpan(cityWall, desiredZ, inset) {
  if (!cityWall) return null;
  // 남쪽 후보가 좁거나 오목하면 중심축(cz) 쪽으로 물러나 첫 연속 횡단 구간을 선택한다.
  for (let i = 0; i <= 24; i++) {
    const z = desiredZ + (cityWall.cz - desiredZ) * i / 24;
    const west = wallHorizontalInset(cityWall, z, -1, inset);
    const east = wallHorizontalInset(cityWall, z, 1, inset);
    if (west && east && east.x - west.x >= inset * 4) return { west, east, z };
  }
  return null;
}

function gateRoadThroatLength(gate, width) {
  return Math.max(
    CITY_WALL_DIMENSIONS.gateDepth * (gate.scale || 1) * 1.25,
    width * 0.75 + CITY_WALL_DIMENSIONS.roadEdgeMargin,
  );
}

function alignGateRoadEnd(pts, gate, width, atStart) {
  if (!gate || pts.length < 2) return pts;
  const inward = { x: -gate.dirX, z: -gate.dirZ };
  const tangent = { x: -inward.z, z: inward.x };
  const throatLength = gateRoadThroatLength(gate, width);
  const transitionEnd = throatLength + Math.max(
    width * 3,
    CITY_WALL_DIMENSIONS.gateDepth * (gate.scale || 1) * 4,
  );
  const minimumAdvance = Math.max(3, width * 0.25);
  const throat = G.add(gate, G.mul(inward, throatLength));
  const ordered = atStart ? pts : [...pts].reverse();
  const aligned = [gate, throat];
  for (const point of ordered.slice(1)) {
    const delta = G.sub(point, gate);
    const along = G.dot(delta, inward);
    if (along <= throatLength + minimumAdvance) continue;
    if (along >= transitionEnd) {
      aligned.push(point);
      continue;
    }
    const lateral = G.dot(delta, tangent);
    const u = (along - throatLength) / (transitionEnd - throatLength);
    const blend = u * u * (3 - 2 * u);
    aligned.push(G.add(gate, G.add(G.mul(inward, along), G.mul(tangent, lateral * blend))));
  }
  if (aligned.length === 2) aligned.push(ordered.at(-1));
  return atStart ? aligned : aligned.reverse();
}

// 내부 도로의 gate endpoint를 옛 동구(site.entrance)까지 잇는다. 문 양쪽 throat는 같은 법선 위에
// 두어 홍예를 정확히 통과하고, 그 뒤에만 완만하게 휘어 개울 다리와 성저 길로 이어진다.
function approachDestination(site, cityWall, gate, width) {
  const margin = width * 0.5 + CITY_WALL_DIMENSIONS.roadEdgeMargin;
  const terrainR = site.terrainR || site.R;
  // road ribbon 전체가 regular terrain grid 영역 안에 있어야 renderer의 exact clip 계약이 성립한다.
  const terrainSafe = (point) => Math.hypot(point.x, point.z) + width * 0.5 <= terrainR - 6;
  if (cityWallClearance(cityWall, site.entrance) <= -margin
    && worldEdgeClearance(site.edge, site.entrance) >= margin
    && terrainSafe(site.entrance)) return site.entrance;
  let best = null;
  const maxDistance = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1);
  for (let distance = 2; distance <= maxDistance; distance += 1) {
    const point = { x: gate.x + gate.dirX * distance, z: gate.z + gate.dirZ * distance };
    if (cityWallClearance(cityWall, point) <= -margin
      && worldEdgeClearance(site.edge, point) >= margin
      && terrainSafe(point)) best = point;
  }
  return best;
}

function smoothApproachTail(start, destination, outward) {
  const distance = G.dist(start, destination);
  if (distance < 1e-6) return [start];
  const chord = G.norm(G.sub(destination, start));
  const c1 = G.add(start, G.mul(outward, distance * 0.45));
  const c2 = G.sub(destination, G.mul(chord, distance * 0.25));
  // Short exterior tails used only two cubic samples, so the first sample could
  // fold more than 35° when a carved stream valley moved the south destination.
  // Denser arc-length sampling preserves the same curve while keeping the road
  // ribbon's actual polyline turn gentle at the gate transition.
  const steps = Math.max(6, Math.ceil(distance / 0.9));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    points.push({
      x: u ** 3 * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * destination.x,
      z: u ** 3 * start.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t ** 3 * destination.z,
    });
  }
  return points;
}

function extendGateRoadOutside(road, gate, site, cityWall, atStart) {
  if (!road || !gate) return;
  const width = road.width;
  const destination = approachDestination(site, cityWall, gate, width);
  if (!destination) return;
  const outward = { x: gate.dirX, z: gate.dirZ };
  const toDestination = G.sub(destination, gate);
  const along = Math.max(0, G.dot(toDestination, outward));
  const throatLength = Math.min(gateRoadThroatLength(gate, width), Math.max(
    CITY_WALL_DIMENSIONS.gateDepth * (gate.scale || 1) * 0.65,
    along * 0.42,
  ));
  const straightLength = Math.min(
    along * 0.58,
    Math.max(throatLength * 2, CITY_WALL_DIMENSIONS.gateApproachLength * 0.48),
  );
  const outerThroat = G.add(gate, G.mul(outward, throatLength));
  const outerStraight = G.add(gate, G.mul(outward, Math.max(throatLength, straightLength)));
  const outsideMargin = width * 0.5 + CITY_WALL_DIMENSIONS.roadEdgeMargin;
  const tail = smoothApproachTail(outerStraight, destination, outward)
    .map((point) => clampPointOutsideCityWall(cityWall, point, outsideMargin));
  const exterior = [gate, outerThroat];
  if (G.dist(outerThroat, outerStraight) > 1e-6) exterior.push(outerStraight);
  exterior.push(...tail.slice(1));
  road.pts = atStart
    ? [...exterior].reverse().concat(road.pts.slice(1))
    : road.pts.slice(0, -1).concat(exterior);
  road.wallApproach = { gate: gate.name, side: atStart ? 'start' : 'end' };
}

function confineGateRoad(pts, cityWall, width, { startGate = null, endGate = null } = {}) {
  const inset = width * 0.5 + CITY_WALL_DIMENSIONS.roadEdgeMargin;
  let confined = pts.map((point, i) => {
    if ((i === 0 && startGate) || (i === pts.length - 1 && endGate)) return point;
    return clampPointInsideCityWall(cityWall, point, inset);
  });
  if (startGate) confined = alignGateRoadEnd(confined, startGate, width, true);
  if (endGate) confined = alignGateRoadEnd(confined, endGate, width, false);
  return confined;
}

export function planRoads(site, opts, rng) {
  const scale = opts.scale;
  const roads = [];
  const W = opts.cityWall || null;
  const gate = (name) => W?.gates.find((candidate) => candidate.name === name) || null;
  const gS = gate('south'), gE = gate('east'), gW = gate('west');
  const E = gS || site.entrance;           // 성곽 ON이면 동구 대신 남문이 모든 tier의 진입점.
  const C = site.center;                   // 명당(북, 종가/관아/궁)
  const coreRoadAnchor = opts.coreRoadAnchor || C; // 예약 코어의 실제 남측 대문
  const wallGateRoads = new Set();
  let southApproach = null;
  const roadOrdinals = { daero: 0, jungno: 0, soro: 0, golmok: 0 };
  const push = (level, pts) => {
    if (!pts || pts.length < 2) return null;
    const ordinal = roadOrdinals[level]++;
    const road = {
      id: `${level}-${String(ordinal).padStart(3, '0')}`,
      level,
      width: ROAD_WIDTH[level],
      pts,
      junctionIds: [],
    };
    roads.push(road);
    return road;
  };

  const nodes = { entrance: E, center: C, crossing: null };

  if (scale === 'hamlet' || scale === 'village') {
    // ── 씨족 촌락: 안길(스파인) + 준방사 골목 (규칙 17·18) ──
    const rawSpine = organicPath(E, coreRoadAnchor, rng, { amp: site.R * 0.06, comps: 2 });
    const spine = W ? confineGateRoad(rawSpine, W, ROAD_WIDTH.soro, { startGate: gS }) : rawSpine;
    const spineRoad = push('soro', spine);
    if (W) { wallGateRoads.add(spineRoad); southApproach = { road: spineRoad, atStart: true }; }
    nodes.spine = spine;

    // 스파인 중간 지점들에서 좌우로 준방사 골목 분기
    const branchN = scale === 'hamlet' ? 4 : 7;
    const samples = G.resample(spine, G.polylineLength(spine) / (branchN + 1));
    let bi = 0;
    for (let s = 1; s < samples.length - 1 && bi < branchN; s++) {
      const smp = samples[s];
      const side = (bi % 2 === 0) ? 1 : -1;
      const perp = G.mul(G.perpL(smp.tan), side);
      // 위로 갈수록(중심 근처) 골목 짧게, 초입은 길게
      const len = site.R * (0.16 + 0.14 * rng());
      const dir = G.norm(G.add(perp, G.mul(smp.tan, rng.range(-0.25, 0.25))));
      push('golmok', trimBranchAtRoads(branchPath(smp.pt, dir, len, rng, site), roads));
      bi++;
    }
    // 중심(종가 앞)에서 좌우로 짧은 안길 — 마을이 중심 안길로 북/남촌 갈림(규칙 17)
    for (const side of [1, -1]) {
      const dir = G.mul(G.perpL(G.norm(G.sub(coreRoadAnchor, E))), side);
      push('golmok', trimBranchAtRoads(
        branchPath(coreRoadAnchor, dir, site.R * 0.20, rng, site), roads,
      ));
    }
    if (scale === 'village') {
      // 마을급: 개울과 평행한 하단 가로(동서) 하나 추가 — 논·물가 접근로
      const midZ = G.lerp(E, C, 0.28);
      const west = { x: -site.bowlR * 0.62, z: midZ.z }, east = { x: site.bowlR * 0.62, z: midZ.z };
      push('soro', organicPath(west, east, rng, { amp: site.R * 0.03, comps: 2 }));
    }
  } else if (scale === 'town') {
    // ── 읍치: 십자 또는 T 간선(규칙 14) + 유기 충전 ──
    const cross = rng() < 0.5 ? 'cross' : 'T';
    // 남북 간선: 동구 → 관아 코어의 남측 대문
    const rawNs = trunkPath(E, coreRoadAnchor, rng);
    const ns = W ? confineGateRoad(rawNs, W, ROAD_WIDTH.jungno, { startGate: gS }) : rawNs;
    const nsRoad = push('jungno', ns);
    if (W) { wallGateRoads.add(nsRoad); southApproach = { road: nsRoad, atStart: true }; }
    nodes.spine = ns;
    // 동서 간선: 관아 앞에서 좌우로
    const xz = { ...coreRoadAnchor };
    nodes.crossing = xz;
    let ew;
    if (W && gE && gW) {
      const westHalf = organicPath(gW, xz, rng, { amp: site.R * 0.03, comps: 1 });
      const eastHalf = organicPath(xz, gE, rng, { amp: site.R * 0.03, comps: 1 });
      ew = confineGateRoad([...westHalf, ...eastHalf.slice(1)], W, ROAD_WIDTH.jungno,
        { startGate: gW, endGate: gE });
    } else {
      ew = organicPath({ x: -site.bowlR * 0.82, z: xz.z }, { x: site.bowlR * 0.82, z: xz.z }, rng,
        { amp: site.R * 0.03, comps: 2 });
    }
    const ewRoad = push('jungno', ew);
    if (W) wallGateRoads.add(ewRoad);
    if (cross === 'cross') {
      // 십자: 동서 간선이 남북축을 관통(이미 관통). 추가로 관아 뒤 짧은 가로.
    }
    // 유기 골목 충전: 두 간선에서 가지 분기 — 골목 밀도↑(읍치 이면부 채움 → 도로변 프론티지 확대,
    //   #45 부정형 여파로 성겼던 town 밀도 보강). town 전용이라 타 규모 회귀 무관.
    fillGolmok([ns, ew], site, rng, 22, roads, push);
  } else if (scale === 'capital') {
    // ── 도성풍: 남북대로 + 동서 간선 T + 피맛길 + 골목 (규칙 3·4·12·13) ──
    // 궁/관아 코어 = C(주산 남쪽 기슭). 남북대로는 궁 앞에서 남으로.
    // 궁이 없으면 plan이 예약 관아의 실제 남문을 넘긴다. 궁이 있는 기존 구성은 anchor가
    // 없으므로 역사적인 식과 RNG 순서를 그대로 보존한다.
    const palaceFront = opts.coreRoadAnchor || { x: 0, z: C.z + site.R * 0.13 };
    const tJoin = G.lerp(palaceFront, E, 0.62);            // 동서 간선과 만나는 T 지점
    nodes.crossing = tJoin;
    nodes.palaceFront = palaceFront;
    // 남북대로(육조거리형)
    const daero = trunkPath(palaceFront, tJoin, rng);
    push('daero', daero);
    nodes.spine = daero;
    // 동서 간선(종로형) — T 지점에서 좌우로, 지형 따라 완만 곡선
    let ew;
    if (W && gE && gW) {
      const westHalf = organicPath(gW, tJoin, rng, { amp: site.R * 0.035, comps: 1 });
      const eastHalf = organicPath(tJoin, gE, rng, { amp: site.R * 0.035, comps: 2 });
      ew = confineGateRoad([...westHalf, ...eastHalf.slice(1)], W, ROAD_WIDTH.daero,
        { startGate: gW, endGate: gE });
    } else {
      ew = organicPath({ x: -site.bowlR * 0.92, z: tJoin.z }, { x: site.bowlR * 0.92, z: tJoin.z }, rng,
        { amp: site.R * 0.035, comps: 3 });
    }
    const ewRoad = push('daero', ew);
    if (W) wallGateRoads.add(ewRoad);
    // 남북대로를 T 아래로 조금 더 연장(동구까지) — 진입
    const rawEntrance = trunkPath(tJoin, E, rng);
    const entrancePath = W ? confineGateRoad(rawEntrance, W, ROAD_WIDTH.jungno, { endGate: gS }) : rawEntrance;
    const entranceRoad = push('jungno', entrancePath);
    if (W) { wallGateRoads.add(entranceRoad); southApproach = { road: entranceRoad, atStart: false }; }
    // 피맛길(규칙 12): 동서 간선 뒤(북)로 평행한 소로 1줄 — 상가 배후
    const pima = ew.map((p) => ({ x: p.x, z: p.z - (ROAD_WIDTH.daero / 2 + 4) }));
    push('soro', pima);
    // 관청 블록 좌우: 남북대로 양편 짧은 소로(관아군 접근)
    for (const side of [1, -1]) {
      for (const t of [0.35, 0.7]) {
        const smp = G.lerp(palaceFront, tJoin, t);
        const dir = G.mul(G.perpL(G.norm(G.sub(tJoin, palaceFront))), side);
        push('soro', trimBranchAtRoads(branchPath(smp, dir, site.R * 0.18, rng, site), roads));
      }
    }
    // 유기 골목: 동서 간선·피맛길·남북대로에서 대량 분기(북촌/남촌 채움)
    fillGolmok([ew, pima, daero], site, rng, 26, roads, push);
  } else if (scale === 'hanyang') {
    // ── 한양 도성: 궁 앵커 + 주작대로(육조거리) + 종로 T + 사대문 연결 + 피맛길 + 북촌/남촌 중로 ──
    const palaceFront = opts.coreRoadAnchor || { x: 0, z: C.z + site.R * 0.11 };
    const tJoin = { x: 0, z: W?.axes?.jongnoZ ?? C.z + site.R * 0.42 }; // 종로와 만나는 T 지점
    nodes.palaceFront = palaceFront; nodes.crossing = tJoin;
    // 주작대로(육조거리형, 최대폭): 궁 정문 → T
    const daero = trunkPath(palaceFront, tJoin, rng);
    push('daero', daero); nodes.spine = daero;
    // 종로(동서 대간선): 서문 → 동문, T 높이에서 지형 완만 곡선
    let jongno;
    if (W && gE && gW) {
      // 두 반쪽을 T에서 정확히 접합한다. 예전에는 gate.x만 쓰고 z를 덮어써 성문과 도로가 어긋났다.
      const westHalf = organicPath(gW, tJoin, rng, { amp: site.R * 0.03, comps: 1 });
      const eastHalf = organicPath(tJoin, gE, rng, { amp: site.R * 0.03, comps: 2 });
      jongno = confineGateRoad([...westHalf, ...eastHalf.slice(1)], W, ROAD_WIDTH.daero,
        { startGate: gW, endGate: gE });
    } else {
      // 성곽 명시 OFF는 기존 단일 유기 종로 계약을 그대로 보존한다.
      jongno = organicPath(
        { x: -site.bowlR * 0.95, z: tJoin.z },
        { x: site.bowlR * 0.95, z: tJoin.z },
        rng, { amp: site.R * 0.03, comps: 3 },
      );
    }
    const jongnoRoad = push('daero', jongno);
    if (W) wallGateRoads.add(jongnoRoad);
    // 남대문로: T → 숭례문(주작대로 남측 연장, 진입 척추)
    if (gS) {
      const s2 = confineGateRoad(trunkPath(tJoin, { x: gS.x, z: gS.z }, rng), W, ROAD_WIDTH.jungno, { endGate: gS });
      const southGateRoad = push('jungno', s2);
      wallGateRoads.add(southGateRoad);
      southApproach = { road: southGateRoad, atStart: false };
    } else push('jungno', trunkPath(tJoin, E, rng));
    // 숙정문(북)은 북악 고지라 접근로가 미미 — 성벽 위 문만 두고 연결로는 생략(급경사 실선 방지).
    // 피맛길: 종로 뒤(북) 평행 소로 — 시전 배후
    const pima = jongno.map((p) => ({ x: p.x, z: p.z - (ROAD_WIDTH.daero / 2 + 4.5) }));
    push('soro', pima);
    // 육조 관청 좌우 소로(주작대로 양편, 대칭 열)
    for (const side of [1, -1]) for (const t of [0.3, 0.6, 0.85]) {
      const smp = G.lerp(palaceFront, tJoin, t);
      const dir = G.mul(G.perpL(G.norm(G.sub(tJoin, palaceFront))), side);
      push('soro', trimBranchAtRoads(branchPath(smp, dir, site.R * 0.17, rng, site), roads));
    }
    // 북촌 중로(궁 동서, 고지대 반가역) + 남촌 중로(종로 남, 초가 우세역)
    push('jungno', organicPath({ x: -site.bowlR * 0.74, z: C.z }, { x: site.bowlR * 0.74, z: C.z }, rng, { amp: site.R * 0.028, comps: 2 }));
    const desiredSouthZ = gS ? (tJoin.z + gS.z) * 0.5 : tJoin.z + site.R * 0.19;
    const southSpan = safeHorizontalSpan(W, desiredSouthZ,
      ROAD_WIDTH.jungno * 0.5 + CITY_WALL_DIMENSIONS.roadEdgeMargin);
    if (southSpan) {
      const path = organicPath(southSpan.west, southSpan.east, rng, { amp: site.R * 0.025, comps: 2 })
        .map((point) => clampPointInsideCityWall(W, point,
          ROAD_WIDTH.jungno * 0.5 + CITY_WALL_DIMENSIONS.roadEdgeMargin));
      push('jungno', path);
    } else if (!W) {
      push('jungno', organicPath(
        { x: -site.bowlR * 0.82, z: desiredSouthZ },
        { x: site.bowlR * 0.82, z: desiredSouthZ },
        rng, { amp: site.R * 0.03, comps: 2 },
      ));
    }
    // 유기 골목 대량 분기(도성 전역 이면부 충전)
    fillGolmok(roads.map((r) => r.pts), site, rng, 64, roads, push);
  }

  if (W) {
    if (southApproach?.road) extendGateRoadOutside(
      southApproach.road, gS, site, W, southApproach.atStart,
    );
    clipRoadsToWall(roads, W, wallGateRoads);
  }

  collapseNarrowRoadLenses(roads);

  const junctions = attachRoadJunctions(roads);
  nodes.junctions = junctions;

  return { roads, nodes };
}

// 간선들에서 골목을 가지형으로 분기해 블록 내부를 유기 충전. 등고 순응·개울/분지 밖 자름.
function fillGolmok(trunks, site, rng, count, roads, push) {
  // 승인된 가지의 절반을 다음 세대 frontier로 편입한다. 간선에서만 빗살처럼 뻗던 예전
  // 한 세대 산포와 달리, 안길→샛길→막다른 골목의 얕은 계층망이 된다. RNG 호출 수를
  // 늘리지 않고 made 순번으로 제한해 결정론과 생성 비용을 안정시킨다.
  const frontier = trunks.slice();
  let made = 0, guard = 0;
  while (made < count && guard < count * 6) {
    guard++;
    const trunk = frontier[Math.floor(rng() * frontier.length)];
    const smps = G.resample(trunk, 8);
    if (smps.length < 3) continue;
    const smp = smps[1 + Math.floor(rng() * (smps.length - 2))];
    const side = rng() < 0.5 ? 1 : -1;
    const perp = G.mul(G.perpL(smp.tan), side);
    const dir = G.norm(G.add(perp, G.mul(smp.tan, rng.range(-0.35, 0.35))));
    const len = site.R * (0.10 + 0.12 * rng());
    const p = trimBranchAtRoads(branchPath(smp.pt, dir, len, rng, site), roads);
    if (p) {
      push('golmok', p);
      made++;
      if (made % 2 === 0) frontier.push(p);
    }
  }
}

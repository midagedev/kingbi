import * as G from '../core/math/geom2.js';
import { terrainGridSize, terrainMeshHeightAt } from './terrain-grid.js';

// 도로 계획선은 필지·숲·시전이 공유하는 공간 계약이다. 렌더러가 그 선을 별도로 평활화하면
// 비워 둔 통행 공간과 보이는 도로가 갈라진다. 각 리본을 실제 terrain 격자 삼각형에 clip해
// 같은 평면 위에 올리므로, 조밀한 균일 tessellation이나 과도한 높이 보정 없이 관통을 막는다.
export const ROAD_SURFACE_MAX_SPAN = 12;
export const ROAD_SURFACE_LIFT = 0.06;
export const ROAD_SURFACE_MAX_JOIN_SAGITTA = 0.015;
export const ROAD_SURFACE_MIN_JOIN_GAP = 0.001;

const CLIP_EPS = 1e-8;
const MIN_TRIANGLE_AREA = 1e-5;

// x-z 투영에서 THREE의 +Y front face에 해당하는 부호.
export function roadSurfaceUpArea(a, b, c) {
  return (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
}

function positiveWinding(triangle) {
  const [a, b, c] = triangle;
  return roadSurfaceUpArea(a, b, c) >= 0 ? triangle : [a, c, b];
}

function terrainPoint(site, point, lift) {
  return { x: point.x, y: terrainMeshHeightAt(site, point.x, point.z) + lift, z: point.z };
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) <= CLIP_EPS && Math.abs(a.z - b.z) <= CLIP_EPS;
}

function compactPolygon(points) {
  const out = [];
  for (const point of points) {
    if (!out.length || !samePoint(point, out.at(-1))) out.push(point);
  }
  if (out.length > 1 && samePoint(out[0], out.at(-1))) out.pop();
  return out;
}

// clipTriangle은 roadSurfaceUpArea가 양수인(+Y) 순서다. 각 변의 안쪽 반평면도 양수다.
function clipConvexPolygon(subject, clipTriangle) {
  let output = subject;
  for (let edge = 0; edge < 3 && output.length; edge++) {
    const a = clipTriangle[edge], b = clipTriangle[(edge + 1) % 3];
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i], next = input[(i + 1) % input.length];
      const currentSide = roadSurfaceUpArea(a, b, current);
      const nextSide = roadSurfaceUpArea(a, b, next);
      const currentInside = currentSide >= -CLIP_EPS;
      const nextInside = nextSide >= -CLIP_EPS;
      if (currentInside) output.push(current);
      if (currentInside !== nextInside) {
        const t = currentSide / (currentSide - nextSide);
        output.push(G.lerp(current, next, Math.max(0, Math.min(1, t))));
      }
    }
    output = compactPolygon(output);
  }
  return output;
}

function terrainCellTriangles(terrainR, step, i, j) {
  const x0 = -terrainR + i * step, x1 = x0 + step;
  const z0 = -terrainR + j * step, z1 = z0 + step;
  const a = { x: x0, z: z0 }, b = { x: x0, z: z1 };
  const c = { x: x1, z: z0 }, d = { x: x1, z: z1 };
  return [[a, b, c], [b, d, c]];
}

// convex primitive과 terrain 삼각형들의 교집합을 각각 fan-triangulate한다. 모든 출력 정점은
// 해당 terrain 평면의 높이를 쓰므로 출력 삼각형 전체가 지면에서 정확히 lift만큼 평행하다.
function clipPrimitiveToTerrain(site, primitive, lift) {
  const terrainR = site.terrainR || site.R;
  const size = terrainGridSize(site);
  const step = 2 * terrainR / size;
  const xs = primitive.map((point) => point.x), zs = primitive.map((point) => point.z);
  const indexAt = (value) => Math.floor((value + terrainR) / step);
  const i0 = Math.max(0, Math.min(size - 1, indexAt(Math.min(...xs))));
  const i1 = Math.max(0, Math.min(size - 1, indexAt(Math.max(...xs))));
  const j0 = Math.max(0, Math.min(size - 1, indexAt(Math.min(...zs))));
  const j1 = Math.max(0, Math.min(size - 1, indexAt(Math.max(...zs))));
  const triangles = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    for (const terrainTriangle of terrainCellTriangles(terrainR, step, i, j)) {
      const polygon = clipConvexPolygon(primitive, terrainTriangle);
      if (polygon.length < 3) continue;
      const anchor = terrainPoint(site, polygon[0], lift);
      for (let k = 1; k < polygon.length - 1; k++) {
        const triangle = positiveWinding([
          anchor,
          terrainPoint(site, polygon[k], lift),
          terrainPoint(site, polygon[k + 1], lift),
        ]);
        if (roadSurfaceUpArea(...triangle) > MIN_TRIANGLE_AREA) triangles.push(triangle);
      }
    }
  }
  return triangles;
}

function makeStrip(site, a, b, width, maxSpan, lift) {
  const length = G.dist(a, b);
  if (length < 1e-6) return null;
  const tangent = G.norm(G.sub(b, a));
  const normal = G.perpR(tangent);
  const chunks = Math.max(1, Math.ceil(length / maxSpan));
  const halfWidth = width * 0.5;
  const triangles = [];
  for (let chunk = 0; chunk < chunks; chunk++) {
    const start = G.lerp(a, b, chunk / chunks);
    const end = G.lerp(a, b, (chunk + 1) / chunks);
    // +Y winding의 직사각형. terrain clip이 이 영역을 빈틈없이 분할한다.
    const primitive = [
      G.add(start, G.mul(normal, halfWidth)),
      G.add(end, G.mul(normal, halfWidth)),
      G.add(end, G.mul(normal, -halfWidth)),
      G.add(start, G.mul(normal, -halfWidth)),
    ];
    triangles.push(...clipPrimitiveToTerrain(site, primitive, lift));
  }
  return { a, b, width, triangles };
}

// 두 butt-cap 리본이 회전 바깥쪽에 남기는 부채꼴만 채운다. 외곽 호는 화면 오차(sagitta)로
// 세분하고, 내부는 terrain clip이 필요한 곳에서만 나눈다. 회전 안쪽은 리본의 자연스러운 겹침이다.
function makeOuterJoin(site, prev, point, next, halfWidth, maxJoinSagitta, lift) {
  const incoming = G.norm(G.sub(point, prev));
  const outgoing = G.norm(G.sub(next, point));
  const turn = incoming.x * outgoing.z - incoming.z * outgoing.x;
  const directionDot = G.dot(incoming, outgoing);
  const turnAngle = Math.abs(Math.atan2(turn, directionDot));
  if ((directionDot > 0 && halfWidth * turnAngle <= ROAD_SURFACE_MIN_JOIN_GAP)
    || halfWidth < 1e-6) return [];
  const turnSide = turn === 0 ? 1 : turn;

  const startNormal = turnSide > 0 ? G.perpL(incoming) : G.perpR(incoming);
  const endNormal = turnSide > 0 ? G.perpL(outgoing) : G.perpR(outgoing);
  const startAngle = Math.atan2(startNormal.z, startNormal.x);
  let sweep = Math.atan2(
    startNormal.x * endNormal.z - startNormal.z * endNormal.x,
    G.dot(startNormal, endNormal),
  );
  if (turnSide > 0 && sweep < 0) sweep += Math.PI * 2;
  if (turnSide < 0 && sweep > 0) sweep -= Math.PI * 2;
  if (Math.abs(sweep) > Math.PI) sweep -= Math.sign(sweep) * Math.PI * 2;

  const maxJoinAngle = 2 * Math.acos(1 - Math.min(maxJoinSagitta, halfWidth) / halfWidth);
  const arcSegments = Math.max(1, Math.ceil(Math.abs(sweep) / maxJoinAngle));
  const triangles = [];
  for (let arc = 0; arc < arcSegments; arc++) {
    const edgePoint = (index) => {
      const angle = startAngle + sweep * index / arcSegments;
      return { x: point.x + Math.cos(angle) * halfWidth, z: point.z + Math.sin(angle) * halfWidth };
    };
    triangles.push(...clipPrimitiveToTerrain(
      site, positiveWinding([point, edgePoint(arc), edgePoint(arc + 1)]), lift,
    ));
  }
  return triangles;
}

export function sampleRoadSurface(site, road, {
  maxSpan = ROAD_SURFACE_MAX_SPAN,
  maxJoinSagitta = ROAD_SURFACE_MAX_JOIN_SAGITTA,
  lift = ROAD_SURFACE_LIFT,
} = {}) {
  const centerline = road.pts;
  const strips = [];
  for (let i = 0; i < centerline.length - 1; i++) {
    const strip = makeStrip(site, centerline[i], centerline[i + 1], road.width, maxSpan, lift);
    if (strip) strips.push(strip);
  }
  const joins = [];
  for (let i = 1; i < centerline.length - 1; i++) {
    const triangles = makeOuterJoin(
      site, centerline[i - 1], centerline[i], centerline[i + 1],
      road.width * 0.5, maxJoinSagitta, lift,
    );
    if (triangles.length) joins.push({ pointIndex: i, triangles });
  }
  return { centerline, strips, joins, maxSpan, maxJoinSagitta, lift };
}

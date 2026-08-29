// 범용 2D 기하 커널. 좌표는 월드 (x, z) 평면이며 y(고도)는 소비자가 담당한다.
// 좌표 규약: +z = 남(앞), -z = 북(뒤). 모든 함수는 부수효과가 없다.

export const V = (x, z) => ({ x, z });
export const add = (a, b) => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
export const mul = (a, s) => ({ x: a.x * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.z * b.z;
export const len = (a) => Math.hypot(a.x, a.z);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
export const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, z: a.z / l }; };
export const perpL = (a) => ({ x: a.z, z: -a.x });
export const perpR = (a) => ({ x: -a.z, z: a.x });
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const facingY = (dir) => Math.atan2(dir.x, dir.z);

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

export function polyCentroid(poly) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cr = p.x * q.z - q.x * p.z;
    cx += (p.x + q.x) * cr; cz += (p.z + q.z) * cr; a += cr;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) {
    const n = poly.length;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, z: poly.reduce((s, p) => s + p.z, 0) / n };
  }
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

export function ensureCCW(poly) {
  return polyArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

export function offsetPoly(poly, d) {
  const n = poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    const e1 = norm(sub(cur, prev)), e2 = norm(sub(next, cur));
    const o1 = { x: e1.z, z: -e1.x }, o2 = { x: e2.z, z: -e2.x };
    const bis = norm({ x: o1.x + o2.x, z: o1.z + o2.z });
    const cosH = Math.max(0.4, bis.x * o1.x + bis.z * o1.z);
    out.push({ x: cur.x + bis.x * d / cosH, z: cur.z + bis.z * d / cosH });
  }
  return out;
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.z > pt.z) !== (b.z > pt.z))
      && (pt.x < (b.x - a.x) * (pt.z - a.z) / (b.z - a.z) + a.x)) inside = !inside;
  }
  return inside;
}

export function distToSeg(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-9) return { d: dist(p, a), t: 0, pt: a };
  let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + abx * t, z: a.z + abz * t };
  return { d: dist(p, q), t, pt: q };
}

export function distToPolyline(p, pts) {
  let best = { d: Infinity, pt: pts[0], tan: { x: 1, z: 0 }, seg: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const r = distToSeg(p, pts[i], pts[i + 1]);
    if (r.d < best.d) best = { d: r.d, pt: r.pt, tan: norm(sub(pts[i + 1], pts[i])), seg: i, t: r.t };
  }
  return best;
}

// 선분과 폴리곤 경계/내부 사이의 실제 최단거리. 도로·개울처럼 폭을 가진 선형 지물을
// 점 하나로 근사하지 않고, 회전된 필지·지붕 전체와 비교할 때 쓰는 공통 커널이다.
export function segmentPolygonDistance(a, b, poly) {
  if (!poly?.length) return Infinity;
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return 0;
  let distance = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    if (segIntersect(a, b, c, d)) return 0;
    distance = Math.min(
      distance,
      distToSeg(a, c, d).d,
      distToSeg(b, c, d).d,
      distToSeg(c, a, b).d,
      distToSeg(d, a, b).d,
    );
  }
  return distance;
}

export function polylinePolygonDistance(pts, poly) {
  if (!pts?.length || !poly?.length) return Infinity;
  if (pts.length === 1) {
    if (pointInPoly(pts[0], poly)) return 0;
    let distance = Infinity;
    for (let i = 0; i < poly.length; i++) {
      distance = Math.min(distance, distToSeg(pts[0], poly[i], poly[(i + 1) % poly.length]).d);
    }
    return distance;
  }
  let distance = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    distance = Math.min(distance, segmentPolygonDistance(pts[i], pts[i + 1], poly));
    if (distance === 0) break;
  }
  return distance;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += dist(pts[i], pts[i + 1]);
  return L;
}

export function resample(pts, spacing) {
  const out = [];
  if (pts.length < 2) return out;
  let acc = 0, carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = dist(a, b);
    if (seg < 1e-6) continue;
    const tan = norm(sub(b, a));
    let d = carry;
    while (d <= seg) {
      out.push({ pt: lerp(a, b, d / seg), tan, s: acc + d });
      d += spacing;
    }
    carry = d - seg;
    acc += seg;
  }
  return out;
}

export function segIntersect(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const rxs = r.x * s.z - r.z * s.x;
  if (Math.abs(rxs) < 1e-9) return null;
  const qp = sub(c, a);
  const t = (qp.x * s.z - qp.z * s.x) / rxs;
  const u = (qp.x * r.z - qp.z * r.x) / rxs;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + r.x * t, z: a.z + r.z * t, t, u };
}

export function boundsOfPts(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, d: maxZ - minZ };
}

export function frontageParcel(base, tan, inward, frontHalf, depth, setback = 0) {
  const t = norm(tan), n = norm(inward);
  const c = add(base, mul(n, setback));
  const bl = add(c, mul(t, -frontHalf));
  const br = add(c, mul(t, frontHalf));
  const tr = add(br, mul(n, depth));
  const tl = add(bl, mul(n, depth));
  return [bl, br, tr, tl];
}

export function polysOverlap(A, B) {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const axis = norm(perpL(sub(b, a)));
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of A) { const d = dot(p, axis); if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const p of B) { const d = dot(p, axis); if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

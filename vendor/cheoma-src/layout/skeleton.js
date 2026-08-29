// Straight skeleton for orthogonal (rectilinear) simple polygons.
// 좌표계: 2D (x, z) 평면. 입력 다각형은 축 정렬 변만 갖는 rect / L자 / U자(ㄷ자) 등.
//
// 핵심 수학 (직교 전용 특수해):
//   일반 straight skeleton은 이벤트 큐(edge/split event) 시뮬레이션이 필요하고
//   "폭 일정한 팔"의 두 평행 장변 동시 붕괴 같은 퇴화에 취약하다. 대신 직교
//   다각형에서는 각 변이 45°로 솟는 지붕면(=straight skeleton)의 높이를
//   "유한 확장(beveled) 거리함수" D_e 로 직접 정의할 수 있다:
//
//     D_e(p) = 변 e 지지선까지의 수직거리 h (내측),
//              단 p 의 발(foot)이 e 의 영향구간 안일 때만 유효. 그 구간은 깊이 h 에서
//              볼록 끝점은 45°로 좁아지고(추녀), 반사 끝점은 45°로 넓어진다(회첨).
//              구간 밖이면 ∞.
//     H(p)   = min_e D_e(p)   ← 이것이 정확히 straight-skeleton 지붕 높이.
//
//   skeleton 은 변 쌍 이등분선들의 배열(arrangement)에서, 중점이 실제로 하부
//   포락(H)에 놓이는 조각만 추려 만든다. 이벤트 시뮬레이션·대칭 퇴화 없음.
//   → rect / L(대칭·비대칭) / U 모두 결정론적으로 정확 (단위 테스트로 좌표 검증).
//
// 출력:
//   nodes   : 내부 마루 절점 [{x,z,h}]   (h = 경계로부터 수직거리 = 지붕 높이)
//   ridges  : 용마루 선분 (마주보는 면 사이)          [{a,b,kind,faces:[i,j]}]
//   valleys : 회첨(골) 선분 (반사 코너에서 위로)
//   hips    : 추녀/내림마루 (볼록 코너로 내려감)
//   segments: 위 셋의 합
//   faces   : 변별 지붕면 [{edgeIndex, base:[A,B], normal, dir, polygon:[{x,z,h}]}]
//   edges   : 원래 변 메타

const EPS = 1e-6;
const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.z * b.z;
const cross = (a, b) => a.x * b.z - a.z * b.x;
const lenv = (a) => Math.hypot(a.x, a.z);

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

function buildEdges(poly) {
  const n = poly.length;
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const d = sub(b, a);
    const L = lenv(d) || 1;
    const dir = { x: d.x / L, z: d.z / L };
    const normal = { x: -dir.z, z: dir.x }; // 좌측(내측) 법선 (CCW)
    edges.push({ index: i, a, b, dir, normal, len: L });
  }
  const convexAt = (i) => {
    const prev = edges[(i - 1 + n) % n];
    return cross(prev.dir, edges[i].dir) > 0; // 좌회전이면 볼록
  };
  for (let i = 0; i < n; i++) {
    edges[i].startConvex = convexAt(i);            // 코너 poly[i]
    edges[i].endConvex = convexAt((i + 1) % n);    // 코너 poly[i+1]
    edges[i].convexAtStart = edges[i].startConvex; // (호환)
  }
  return edges;
}

const planeH = (e, p) => e.normal.x * (p.x - e.a.x) + e.normal.z * (p.z - e.a.z);

// 유한 확장(beveled) 거리함수: 발이 영향구간 밖이면 ∞
function distEdge(e, p) {
  const h = planeH(e, p);
  if (h < -EPS) return Infinity; // 변 바깥쪽
  const hp = Math.max(0, h);
  const t = dot(sub(p, e.a), e.dir); // 변 방향 파라미터 (0..len)
  const cutA = e.startConvex ? hp : -hp;
  const cutB = e.endConvex ? hp : -hp;
  if (t < cutA - 1e-4 || t > e.len - cutB + 1e-4) return Infinity;
  return hp;
}

function heightAt(edges, p) {
  let H = Infinity;
  for (const e of edges) { const d = distEdge(e, p); if (d < H) H = d; }
  return H;
}

// 두 변 지지선의 이등분선: planeH_i = planeH_j → A·p = c
function bisectorLine(ei, ej) {
  const A = { x: ei.normal.x - ej.normal.x, z: ei.normal.z - ej.normal.z };
  const c = dot(ei.normal, ei.a) - dot(ej.normal, ej.a);
  const aLen = lenv(A);
  if (aLen < EPS) return null; // 같은 방향 평행변
  const dir = { x: -A.z / aLen, z: A.x / aLen };
  const p0 = { x: (A.x * c) / (aLen * aLen), z: (A.z * c) / (aLen * aLen) };
  return { dir, p0 };
}

function pointInPolygon(poly, p) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) &&
        p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x)
      inside = !inside;
  }
  return inside;
}

// 직선을 다각형 내부 구간들로 클립
function clipLineToPolygon(poly, p0, dir) {
  const ts = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const e = sub(b, a);
    const denom = cross(dir, e);
    if (Math.abs(denom) < EPS) continue;
    const diff = sub(a, p0);
    const t = cross(diff, e) / denom;
    const s = cross(diff, dir) / denom;
    if (s >= -EPS && s <= 1 + EPS) ts.push(t);
  }
  ts.sort((u, v) => u - v);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if (t1 - t0 < 1e-4) continue;
    const mid = { x: p0.x + dir.x * (t0 + t1) / 2, z: p0.z + dir.z * (t0 + t1) / 2 };
    if (pointInPolygon(poly, mid)) out.push([t0, t1]);
  }
  return out;
}

export function computeSkeleton(inputPoly) {
  let poly = inputPoly.map((p) => ({ x: p.x, z: p.z }));
  if (signedArea(poly) < 0) poly.reverse();
  const n = poly.length;
  const edges = buildEdges(poly);

  // 1) 모든 변 쌍 이등분선을 다각형 내부로 클립
  const candidates = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const line = bisectorLine(edges[i], edges[j]);
      if (!line) continue;
      for (const [t0, t1] of clipLineToPolygon(poly, line.p0, line.dir))
        candidates.push({ line, i, j, t0, t1 });
    }
  }

  // 2) 각 후보를 다른 후보와의 교점에서 분할 (배열 세분)
  const pieces = [];
  for (const cand of candidates) {
    const { line, t0, t1 } = cand;
    const ts = [t0, t1];
    for (const other of candidates) {
      if (other === cand) continue;
      const denom = cross(line.dir, other.line.dir);
      if (Math.abs(denom) < EPS) continue;
      const diff = sub(other.line.p0, line.p0);
      const t = cross(diff, other.line.dir) / denom;
      const s = cross(diff, line.dir) / denom;
      if (t > t0 + 1e-4 && t < t1 - 1e-4 && s > other.t0 - 1e-4 && s < other.t1 + 1e-4)
        ts.push(t);
    }
    ts.sort((u, v) => u - v);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-4) continue;
      pieces.push({ line, i: cand.i, j: cand.j, ta: ts[k], tb: ts[k + 1] });
    }
  }

  // 3) 하부 포락(H) 위에 놓이는 조각만 채택
  const key = (p) => `${Math.round(p.x / 1e-3)}:${Math.round(p.z / 1e-3)}`;
  const rawSegs = [];
  for (const pc of pieces) {
    const { line, i, j, ta, tb } = pc;
    const at = (t) => ({ x: line.p0.x + line.dir.x * t, z: line.p0.z + line.dir.z * t });
    const mid = at((ta + tb) / 2);
    const H = heightAt(edges, mid);
    if (H < EPS) continue;
    const di = distEdge(edges[i], mid), dj = distEdge(edges[j], mid);
    if (Math.abs(di - H) > 1e-3 || Math.abs(dj - H) > 1e-3) continue;
    const pa = at(ta), pb = at(tb);
    pa.h = Math.max(0, planeH(edges[i], pa));
    pb.h = Math.max(0, planeH(edges[i], pb));
    if (lenv(sub(pa, pb)) < 1e-4) continue;
    rawSegs.push({ a: pa, b: pb, faces: [i, j] });
  }

  // 4) 중복 제거 + 면 쌍 병합
  const segMap = new Map();
  for (const s of rawSegs) {
    const k = [key(s.a), key(s.b)].sort().join('|');
    let rec = segMap.get(k);
    if (!rec) { rec = { a: s.a, b: s.b, faces: new Set() }; segMap.set(k, rec); }
    rec.faces.add(s.faces[0]); rec.faces.add(s.faces[1]);
  }

  // 5) 분류 (면 쌍의 인접·볼록성)
  let segments = [];
  for (const rec of segMap.values()) {
    const fs = [...rec.faces];
    let kind = 'ridge';
    // 인접 면 쌍이 하나라도 있으면 그 코너 볼록성으로 판정
    for (let a = 0; a < fs.length; a++) for (let b = a + 1; b < fs.length; b++) {
      const i = fs[a], j = fs[b];
      if (j === (i + 1) % n) { kind = edges[(i + 1) % n].startConvex ? 'hip' : 'valley'; }
      else if (i === (j + 1) % n) { kind = edges[i].startConvex ? 'hip' : 'valley'; }
    }
    segments.push({ a: rec.a, b: rec.b, kind, faces: fs });
  }

  // 6) 동일 종류·공선 인접 선분 병합 (교차점 분할 잔재 제거)
  segments = mergeCollinear(segments);

  const ridges = segments.filter((s) => s.kind === 'ridge');
  const valleys = segments.filter((s) => s.kind === 'valley');
  const hips = segments.filter((s) => s.kind === 'hip');

  // 절점 (h>0 유일 정점)
  const nodeMap = new Map();
  for (const s of segments) for (const p of [s.a, s.b]) {
    if (p.h <= EPS) continue;
    const k = key(p);
    if (!nodeMap.has(k)) nodeMap.set(k, { x: p.x, z: p.z, h: p.h });
  }
  const nodes = [...nodeMap.values()];

  // 7) 면(face): 각 변에서 나온 skeleton 선분 + 밑변 → 중심각 정렬
  const faces = [];
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    const pts = [{ x: e.a.x, z: e.a.z, h: 0 }, { x: e.b.x, z: e.b.z, h: 0 }];
    for (const s of segments) if (s.faces.includes(i)) { pts.push(s.a); pts.push(s.b); }
    const uniq = [];
    for (const p of pts)
      if (!uniq.some((q) => Math.abs(q.x - p.x) < 1e-3 && Math.abs(q.z - p.z) < 1e-3))
        uniq.push({ x: p.x, z: p.z, h: p.h });
    const cx = uniq.reduce((s, p) => s + p.x, 0) / uniq.length;
    const cz = uniq.reduce((s, p) => s + p.z, 0) / uniq.length;
    uniq.sort((p, q) => Math.atan2(p.z - cz, p.x - cx) - Math.atan2(q.z - cz, q.x - cx));
    faces.push({
      edgeIndex: i,
      base: [{ x: e.a.x, z: e.a.z }, { x: e.b.x, z: e.b.z }],
      normal: { x: e.normal.x, z: e.normal.z },
      dir: { x: e.dir.x, z: e.dir.z },
      polygon: uniq,
    });
  }

  return { nodes, ridges, valleys, hips, segments, faces, edges, poly };
}

function mergeCollinear(segs) {
  const list = segs.map((s) => ({ ...s }));
  const same = (p, q) => Math.abs(p.x - q.x) < 1e-3 && Math.abs(p.z - q.z) < 1e-3;
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].kind !== list[j].kind) continue;
        const A = list[i], B = list[j];
        const ends = [[A.a, A.b, B.a, B.b], [A.a, A.b, B.b, B.a],
                      [A.b, A.a, B.a, B.b], [A.b, A.a, B.b, B.a]];
        for (const [a1, mid1, mid2, b2] of ends) {
          if (!same(mid1, mid2)) continue;
          const d1 = sub(mid1, a1), d2 = sub(b2, mid2);
          if (Math.abs(cross(d1, d2)) > 1e-3) continue;
          if (dot(d1, d2) <= 0) continue;
          const faces = [...new Set([...A.faces, ...B.faces])];
          list[i] = { a: a1, b: b2, kind: A.kind, faces };
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return list;
}

// 편의: rect / L / U 표준 발자국 (테스트·데모용)
export const footprints = {
  rect: (w = 8, d = 5) => [
    { x: 0, z: 0 }, { x: w, z: 0 }, { x: w, z: d }, { x: 0, z: d },
  ],
  L: (arm = 4, wing = 2) => [
    { x: 0, z: 0 }, { x: arm * 2, z: 0 }, { x: arm * 2, z: wing },
    { x: wing, z: wing }, { x: wing, z: arm * 2 }, { x: 0, z: arm * 2 },
  ],
  U: (W = 6, D = 5, nx0 = 2, nx1 = 4, nz = 2) => [
    { x: 0, z: 0 }, { x: W, z: 0 }, { x: W, z: D }, { x: nx1, z: D },
    { x: nx1, z: nz }, { x: nx0, z: nz }, { x: nx0, z: D }, { x: 0, z: D },
  ],
};

import * as THREE from 'three';

// skeleton 을 검증용으로 시각화한다.
//   - 발자국(footprint) 폐곡선: 검정
//   - ridges(용마루): 빨강 / valleys(회첨): 파랑 / hips(추녀): 초록
//   - 절점(node): 작은 구
//   - faces(선택): 각 지붕면을 높이 h*pitch 로 들어올린 반투명 면
// heightScale = 지붕 물매 (h[m] → y[m]).

const COLORS = { ridge: 0xd23b3b, valley: 0x2f6fd0, hip: 0x2f9e54, base: 0x1f1b18 };

export function makeSkeletonLines(sk, { y = 0.02, heightScale = 0 } = {}) {
  const group = new THREE.Group();
  const lift = (p) => new THREE.Vector3(p.x, y + (heightScale ? p.h * heightScale : 0), p.z);

  // 발자국 폐곡선
  const fp = [];
  for (let i = 0; i < sk.poly.length; i++) {
    fp.push(lift({ ...sk.poly[i], h: 0 }), lift({ ...sk.poly[(i + 1) % sk.poly.length], h: 0 }));
  }
  group.add(new THREE.LineSegments(
    geomFrom(fp), new THREE.LineBasicMaterial({ color: COLORS.base })));

  for (const [kind, list] of [['ridge', sk.ridges], ['valley', sk.valleys], ['hip', sk.hips]]) {
    const pts = [];
    for (const s of list) pts.push(lift(s.a), lift(s.b));
    if (pts.length) group.add(new THREE.LineSegments(
      geomFrom(pts), new THREE.LineBasicMaterial({ color: COLORS[kind] })));
  }

  // 절점
  const sph = new THREE.SphereGeometry(0.09, 10, 8);
  const nm = new THREE.MeshBasicMaterial({ color: 0x111111 });
  for (const nd of sk.nodes) {
    const m = new THREE.Mesh(sph, nm);
    m.position.copy(lift(nd));
    group.add(m);
  }
  return group;
}

// 각 지붕면을 h*heightScale 로 들어올린 반투명 면 (면 분해 검증용)
export function makeSkeletonFaces(sk, { heightScale = 0.9, y = 0 } = {}) {
  const group = new THREE.Group();
  const palette = [0xe0b072, 0x9ec3a0, 0xc99a9a, 0xb0a7cf, 0xd9c48a, 0x8fb8c4, 0xcaa6c2, 0xa8c98f];
  sk.faces.forEach((face, fi) => {
    if (face.polygon.length < 3) return;
    const pos = [], idx = [];
    face.polygon.forEach((p) => pos.push(p.x, y + p.h * heightScale, p.z));
    for (let i = 1; i + 1 < face.polygon.length; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: palette[fi % palette.length], roughness: 0.9, metalness: 0,
      side: THREE.DoubleSide, transparent: true, opacity: 0.85,
    }));
    group.add(mesh);
  });
  return group;
}

function geomFrom(vecs) {
  const g = new THREE.BufferGeometry();
  const arr = [];
  for (const v of vecs) arr.push(v.x, v.y, v.z);
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

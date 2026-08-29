import * as THREE from 'three';

// 두 링(같은 꼭짓점 수) 사이를 잇는 각뿔대 지오메트리. 상·하면 팬 캡 옵션.
// 링 점: [x,y,z] 배열, CCW(위에서 볼 때) 순서를 가정하고 바깥 법선을 만든다.
export function frustumGeometry(bottom, top, { capTop = true, capBottom = true } = {}) {
  const n = bottom.length;
  const pos = [];
  const idx = [];
  const push = (p) => { pos.push(p[0], p[1], p[2]); return pos.length / 3 - 1; };
  const bI = bottom.map(push);
  const tI = top.map(push);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(bI[i], tI[i], tI[j]);
    idx.push(bI[i], tI[j], bI[j]);
  }
  if (capTop) {
    const c = top.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / n);
    const ci = push(c);
    for (let i = 0; i < n; i++) idx.push(tI[i], ci, tI[(i + 1) % n]);
  }
  if (capBottom) {
    const c = bottom.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / n);
    const ci = push(c);
    for (let i = 0; i < n; i++) idx.push(bI[i], ci, bI[(i + 1) % n]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}

// 석탑 옥개석(지붕돌): 넓고 얇은 처마선이 모서리(전각)에서 살짝 들리고, 위로 완만한 낙수면.
// 팔각 근사(네 모서리가 45°점) — 정면에서 처마가 가운데 낮고 귀에서 들리는 실루엣.
export function roofStoneGeometry(w, { slopeH = 0.24, crestFrac = 0.30, cornerLift = 0.09 } = {}) {
  const h = w / 2;
  const cL = cornerLift;
  // 하부 링: 모서리(대각) 4점은 들리고, 변 중앙 4점은 처마선(낮음)
  const bottom = [
    [h, cL, h], [0, 0, h], [-h, cL, h], [-h, 0, 0],
    [-h, cL, -h], [0, 0, -h], [h, cL, -h], [h, 0, 0],
  ];
  const t = w * crestFrac;
  const tL = slopeH + cL * 0.5;
  const top = [
    [t, tL, t], [0, slopeH, t], [-t, tL, t], [-t, slopeH, 0],
    [-t, tL, -t], [0, slopeH, -t], [t, tL, -t], [t, slopeH, 0],
  ];
  return frustumGeometry(bottom, top, { capTop: true, capBottom: true });
}

// 자연석 바위: 정이십면체를 시드 노이즈로 찌그러뜨린 로우폴리 덩어리(flatShading 전제).
export function boulderGeometry(rng, r = 0.6, detail = 1, squash = 0.7) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 0.72 + rng() * 0.5;              // 반경 방향 불규칙
    v.multiplyScalar(n);
    v.y *= squash;                              // 납작하게(땅에 앉은 느낌)
    if (v.y < 0) v.y *= 0.5;                    // 밑면 평평
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.count * 2), 2));
  return g;
}

// 옹기(항아리) 세로 단면점: 좁은 굽 → 넓은 어깨(상부 60%) → 좁은 입. LatheGeometry용 [r,y].
// bellyFrac: 어깨 최대 반경 / 몸통 높이 기준 폭. mouthFrac: 입 반경 비율.
export function onggiProfile(h, maxR, { mouthFrac = 0.52, footFrac = 0.42, shoulderAt = 0.62 } = {}) {
  const foot = maxR * footFrac;
  const mouth = maxR * mouthFrac;
  return [
    [0.001, 0],
    [foot, 0],
    [foot * 1.02, h * 0.06],
    [maxR * 0.78, h * 0.30],
    [maxR, h * shoulderAt],           // 어깨(최대 폭)
    [maxR * 0.9, h * 0.80],
    [mouth * 1.12, h * 0.92],         // 목
    [mouth, h * 0.97],
    [mouth * 1.06, h],                // 입 전(테)
    [mouth * 0.86, h],                // 입 안쪽(두께)
    [0.001, h * 0.985],
  ];
}

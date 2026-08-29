import * as THREE from 'three';
import { planChogaMindoriFrame } from './choga-frame-plan.js';

// 배흘림 프로파일 LatheGeometry — 기둥 높이의 1/3 지점이 가장 굵다
function columnGeometry(radius, height, entasis) {
  const pts = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // 최대 반경 위치 t≈0.33, 위로 갈수록 좁아짐 (민흘림+배흘림 혼합 근사)
    const bulge = 1 + entasis * 0.30 * Math.sin(Math.PI * Math.min(1, t / 0.66));
    const taper = 1 - 0.14 * t;
    pts.push(new THREE.Vector2(radius * bulge * taper, height * t));
  }
  return new THREE.LatheGeometry(pts, 14);
}

// 외곽 기둥 배치 (내부 고주는 v1에서 생략 — 문이 닫혀 있어 보이지 않음)
export function buildColumns(P, L, M) {
  const g = new THREE.Group();
  const geo = columnGeometry(P.columnRadius, P.columnHeight, P.entasis);
  const geoCorner = columnGeometry(P.columnRadius * 1.06, P.columnHeight + P.cornerRaise, P.entasis);

  const xs = L.xPos, zs = L.zPos;
  const lastX = xs.length - 1, lastZ = zs.length - 1;
  const spots = [];
  for (let i = 0; i <= lastX; i++) {
    spots.push([xs[i], zs[0], i === 0 || i === lastX]);
    spots.push([xs[i], zs[lastZ], i === 0 || i === lastX]);
  }
  for (let j = 1; j < lastZ; j++) {
    spots.push([xs[0], zs[j], false]);
    spots.push([xs[lastX], zs[j], false]);
  }

  // 절 무단청 기둥: 나무마다 고재 색 편차를 넓혀 균일 베이지 탈피(위치 해시로 결정적).
  const templeWood = P.style === 'temple';
  const woodVariants = templeWood
    ? [0x7c6437, 0x8f7846, 0x6f5a34, 0x998153, 0x82693c, 0x746138].map(
        (c) => { const mm = M.wood.clone(); mm.color.setHex(c); return mm; })
    : null;

  for (const [x, z, isCorner] of spots) {
    let mat = M.wood;
    if (woodVariants) {
      const h = Math.abs(Math.round(x * 7.3 + z * 3.1));
      mat = woodVariants[h % woodVariants.length];
    }
    const m = new THREE.Mesh(isCorner ? geoCorner : geo, mat);
    m.position.set(x, L.podTopY + 0.24, z);
    // 안쏠림: 기둥 상부가 건물 중심 쪽으로 살짝 기움
    const lean = P.cornerLean * (isCorner ? 1.4 : 1.0);
    m.rotation.z = -Math.sign(x) * lean * (Math.abs(x) / (L.W / 2 || 1));
    m.rotation.x = Math.sign(z) * lean * (Math.abs(z) / (L.D / 2 || 1));
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }

  // 창방 (기둥머리 연결보) + 평방 (다포의 넓은 받침보) — 사방 둘레
  const choga = P.style === 'choga';
  const mindori = choga ? planChogaMindoriFrame(L) : null;
  const capH = mindori?.changbangHeight ?? 0.34;
  const flatH = 0.20;
  const yCap = mindori?.changbangCenterY ?? (L.colTopY + capH / 2);
  const yFlat = L.colTopY + capH + flatH / 2;
  const mkBeam = (len, h, d) => new THREE.BoxGeometry(len, h, d);

  const runs = mindori?.changbangRuns.map((run) => ({
    ...run,
    len: run.length,
    rotY: run.axis === 'x' ? 0 : Math.PI / 2,
  })) ?? [
    { len: L.W + 0.5, x: 0, z: zs[0], rotY: 0 },
    { len: L.W + 0.5, x: 0, z: zs[lastZ], rotY: 0 },
    { len: L.D + 0.5, x: xs[0], z: 0, rotY: Math.PI / 2 },
    { len: L.D + 0.5, x: xs[lastX], z: 0, rotY: Math.PI / 2 },
  ];
  for (const r of runs) {
    // 창방·평방: 궁·사찰은 위계별 단청 source, 기와·초가는 단색 목재.
    const mat = M.beamDancheong.clone();
    if (M.beamDancheong.map) {
      mat.map = M.beamDancheong.map.clone();
      mat.map.repeat.set(Math.max(1, Math.round(r.len / 3.2)), 1);
      mat.map.needsUpdate = true;
    }
    const cb = new THREE.Mesh(mkBeam(r.len, capH, 0.26), mat);
    if (choga) cb.name = `choga-changbang-${r.id}`;
    cb.position.set(r.x, yCap, r.z); cb.rotation.y = r.rotY;
    cb.castShadow = true; g.add(cb);
    // 초가(민도리집)는 넓은 평방 생략 — 얇은 창방만.
    if (!choga) {
      const fb = new THREE.Mesh(mkBeam(r.len + 0.3, flatH, 0.52), mat);
      fb.position.set(r.x, yFlat, r.z); fb.rotation.y = r.rotY;
      fb.castShadow = true; g.add(fb);
    }
  }

  return g;
}

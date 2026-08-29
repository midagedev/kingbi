import * as THREE from 'three';
import { planChogaMindoriFrame } from './choga-frame-plan.js';

// 다포식 공포. 하나의 포(包) 유닛을 부품 목록으로 정의하고,
// 둘레의 모든 배치 지점에 InstancedMesh로 뿌린다.
// 유닛 로컬 좌표: +z = 바깥 방향, y=0 은 평방 윗면.
export function buildBrackets(P, L, M) {
  const g = new THREE.Group();
  const tiers = P.bracketTiers;
  const s = P.bracketScale;

  // ---- 민도리집(초가): 공포 없이 도리(둥근 보)+장여(받침보)만 사방에 두른다 ----
  if (P.style === 'choga') {
    // 도리 윗면은 우진각 지붕의 전역 최저점인 처마선 아래에 두고, 장여는 그 밑면에
    // 정확히 맞댄다. plateY 기준 배치는 양끝 도리가 지붕을 뚫는 검은 패치를 만들었다.
    const frame = planChogaMindoriFrame(L);
    const dori = (len) => new THREE.CylinderGeometry(
      frame.doriRadius,
      frame.doriRadius,
      len,
      10,
    );
    for (const r of frame.supportRuns) {
      const p = new THREE.Mesh(dori(r.length), M.wood);
      p.name = `choga-dori-${r.id}`;
      if (r.axis === 'x') p.rotation.z = Math.PI / 2; else p.rotation.x = Math.PI / 2;
      p.position.set(r.x, frame.doriCenterY, r.z);
      p.castShadow = true;
      g.add(p);
      const jy = new THREE.Mesh(
        r.axis === 'x' ? new THREE.BoxGeometry(r.length, frame.jangyeoHeight, 0.14)
                       : new THREE.BoxGeometry(0.14, frame.jangyeoHeight, r.length), M.woodDark);
      jy.name = `choga-jangyeo-${r.id}`;
      jy.position.set(r.x, frame.jangyeoCenterY, r.z);
      jy.castShadow = true;
      g.add(jy);
    }
    return g;
  }

  // ---- 유닛 부품 정의 ----
  const parts = [];
  const add = (geo, mat, x, y, z, rotY = 0) => {
    const m = new THREE.Matrix4()
      .makeRotationY(rotY)
      .setPosition(x, y, z);
    parts.push({ geo, mat, local: m });
  };

  // 주심포(절): 주두 아래 기둥머리에서 바깥으로 내미는 헛첨차 팔 1개.
  if (P.style === 'temple') {
    const heot = new THREE.BoxGeometry(0.19 * s, 0.15, 0.52 * s);
    const hm = new THREE.Matrix4().makeRotationX(-0.08).setPosition(0, -0.02, 0.28 * s);
    parts.push({ geo: heot, mat: M.bracket, local: hm });
    // 헛첨차 끝 마구리: 연화 문양
    const htip = new THREE.BoxGeometry(0.17 * s, 0.14, 0.12);
    const htm = new THREE.Matrix4().makeRotationX(-0.08).setPosition(0, -0.01, 0.52 * s);
    parts.push({ geo: htip, mat: M.bracketFace, local: htm });
  }

  // 주두 (아래가 좁은 사다리꼴 블록)
  const judu = new THREE.CylinderGeometry(0.30 * s, 0.22 * s, 0.24, 4, 1);
  judu.rotateY(Math.PI / 4);
  add(judu, M.bracket, 0, 0.12, 0);

  const tierH = 0.34;
  const soro = new THREE.CylinderGeometry(0.11 * s, 0.08 * s, 0.12, 4, 1);
  soro.rotateY(Math.PI / 4);
  // 부재 끝 마구리 캡(얇은 판) — 연화 문양이 부재 끝면에 붙어 다색으로 읽힘.
  const faceCap = new THREE.BoxGeometry(0.035, 0.16, 0.15 * s);

  for (let i = 0; i < tiers; i++) {
    const y = 0.24 + i * tierH;
    // 첨차: 벽 방향(x)으로 뻗는 팔. 위 단일수록 길다. (뇌록 바탕 유지 — 상록)
    const armLen = (0.9 + 0.4 * i) * s;
    const cheomcha = new THREE.BoxGeometry(armLen, 0.18, 0.17 * s);
    add(cheomcha, M.bracket, 0, y + 0.08, 0);
    // 첨차 양끝 마구리: 연화
    add(faceCap, M.bracketFace, armLen / 2, y + 0.08, 0);
    add(faceCap, M.bracketFace, -armLen / 2, y + 0.08, 0);
    // 소로: 첨차 위 양끝 + 중앙 — 주홍 교차(작은 붉은 받침블록 악센트)
    for (const px of [-armLen / 2 + 0.09, 0, armLen / 2 - 0.09]) {
      add(soro, M.bracketAlt, px, y + 0.22, 0);
    }
    // 살미(제공): 바깥(z+)으로 뻗는 팔. 끝이 위로 살짝 들린 쇠서 느낌으로 회전.
    // 출목마다 더 길게·굵게 내밀어 계단식 돌출을 강조한다.
    // 절: 앞으로 내미는 길이는 외목도리 안쪽으로 제한(완만한 지붕 밑에 들어가 관통 방지),
    //     폭(첨차)은 bracketScale로 넓혀 정면 리듬의 주인공은 유지.
    const outLen = (0.62 + 0.46 * i) * (P.style === 'temple' ? 0.85 : s);
    const salmi = new THREE.BoxGeometry(0.20 * s, 0.17, outLen);
    const mm = new THREE.Matrix4()
      .makeRotationX(-0.1)
      .setPosition(0, y + 0.26, outLen / 2 - 0.08);
    parts.push({ geo: salmi, mat: M.bracket, local: mm });
    // 살미 끝 마구리: 연화 문양 (쇠서 끝 다색화)
    const salmiTip = new THREE.BoxGeometry(0.17 * s, 0.16, 0.13);
    const tm = new THREE.Matrix4()
      .makeRotationX(-0.1)
      .setPosition(0, y + 0.27, outLen - 0.07);
    parts.push({ geo: salmiTip, mat: M.bracketFace, local: tm });
    // 외부 가로 첨차(행공): 살미 끝에 얹혀 도리 방향(x)으로 교차 → 출목마다 입체 격자
    const armOut = (0.78 + 0.3 * i) * s;
    const crossCheom = new THREE.BoxGeometry(armOut, 0.14, 0.15 * s);
    add(crossCheom, M.bracket, 0, y + 0.34, outLen - 0.10);
    // 행공 양끝 마구리: 연화
    add(faceCap, M.bracketFace, armOut / 2, y + 0.34, outLen - 0.10);
    add(faceCap, M.bracketFace, -armOut / 2, y + 0.34, outLen - 0.10);
    // 가로 첨차 위 양끝 소로 2개 — 주홍 교차
    add(soro, M.bracketAlt, armOut / 2 - 0.08, y + 0.46, outLen - 0.10);
    add(soro, M.bracketAlt, -(armOut / 2 - 0.08), y + 0.46, outLen - 0.10);
  }

  // ---- 배치 지점 계산 (사방 둘레) ----
  const units = [];
  const lastX = L.xPos.length - 1, lastZ = L.zPos.length - 1;
  const zFront = L.zPos[lastZ], zBack = L.zPos[0];
  const xLeft = L.xPos[0], xRight = L.xPos[lastX];

  const alongX = [];
  for (let i = 0; i <= lastX; i++) {
    alongX.push(L.xPos[i]);
    if (i < lastX) {
      for (let k = 1; k <= P.interBrackets; k++) {
        alongX.push(L.xPos[i] + (L.xPos[i + 1] - L.xPos[i]) * (k / (P.interBrackets + 1)));
      }
    }
  }
  const alongZ = [];
  for (let j = 0; j <= lastZ; j++) {
    alongZ.push(L.zPos[j]);
    if (j < lastZ) {
      for (let k = 1; k <= P.interBrackets; k++) {
        alongZ.push(L.zPos[j] + (L.zPos[j + 1] - L.zPos[j]) * (k / (P.interBrackets + 1)));
      }
    }
  }

  for (const x of alongX) {
    units.push({ x, z: zFront, rotY: 0 });
    units.push({ x, z: zBack, rotY: Math.PI });
  }
  for (const z of alongZ.slice(1, -1)) {
    // makeRotationY(θ)는 로컬 +z를 (sinθ, 0, cosθ)로 보낸다
    units.push({ x: xLeft, z, rotY: -Math.PI / 2 });  // 왼쪽: 바깥 = -x
    units.push({ x: xRight, z, rotY: Math.PI / 2 });  // 오른쪽: 바깥 = +x
  }

  // ---- InstancedMesh 생성 ----
  const tmp = new THREE.Matrix4();
  for (const part of parts) {
    const im = new THREE.InstancedMesh(part.geo, part.mat, units.length);
    units.forEach((u, idx) => {
      tmp.makeRotationY(u.rotY).setPosition(u.x, L.plateY, u.z);
      const m = tmp.clone().multiply(part.local);
      im.setMatrixAt(idx, m);
    });
    im.castShadow = true;
    im.instanceMatrix.needsUpdate = true;
    g.add(im);
  }

  // ---- 포벽(包壁): 공포 유닛 사이 배경 회벽 띠 ----
  // 다포 유닛 하나하나가 흰 배경 위에서 읽히도록, 사방 둘레에 회벽 띠를 두른다.
  const bandH = L.bracketH * 0.88;
  const bandY = L.plateY + bandH / 2; // plateY ~ plateY+bandH 구간의 중앙
  const wallBands = [
    { geo: new THREE.BoxGeometry(L.W, bandH, 0.10), x: 0, z: zFront - 0.12 },
    { geo: new THREE.BoxGeometry(L.W, bandH, 0.10), x: 0, z: zBack + 0.12 },
    { geo: new THREE.BoxGeometry(0.10, bandH, L.D), x: xLeft + 0.12, z: 0 },
    { geo: new THREE.BoxGeometry(0.10, bandH, L.D), x: xRight - 0.12, z: 0 },
  ];
  for (const b of wallBands) {
    const mesh = new THREE.Mesh(b.geo, M.plaster);
    mesh.position.set(b.x, bandY, b.z);
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  // ---- 외목도리: 공포 끝단을 잇는 도리 (처마 받침) ----
  const tipOut = (0.62 + 0.46 * (tiers - 1)) * 0.8;
  const purlinY = L.plateY + 0.24 + (tiers - 1) * tierH + 0.30;
  const purlinGeo = (len) => new THREE.CylinderGeometry(0.13, 0.13, len, 10);
  const beams = [
    { len: L.W + tipOut * 2, x: 0, z: zFront + tipOut, rotZ: Math.PI / 2, rotY: 0 },
    { len: L.W + tipOut * 2, x: 0, z: zBack - tipOut, rotZ: Math.PI / 2, rotY: 0 },
    { len: L.D + tipOut * 2, x: xLeft - tipOut, z: 0, rotZ: Math.PI / 2, rotY: Math.PI / 2 },
    { len: L.D + tipOut * 2, x: xRight + tipOut, z: 0, rotZ: Math.PI / 2, rotY: Math.PI / 2 },
  ];
  for (const b of beams) {
    const p = new THREE.Mesh(purlinGeo(b.len), M.wood);
    p.rotation.set(0, b.rotY, b.rotZ);
    p.position.set(b.x, purlinY, b.z);
    p.castShadow = true;
    g.add(p);
  }

  return g;
}

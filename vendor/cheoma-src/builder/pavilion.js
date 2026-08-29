import * as THREE from 'three';
import { TILE_LOOK } from './material-colors.js';
import { makeMaterials, tileSurfaceMaterial } from './palette.js';
import { PAVILION_DEFAULTS } from './pavilion-spec.js';

// 정자(亭子) — 사모(정사각)·육모(육각) 모임지붕 개방 정자.
//   참조: 경복궁 향원정(육모), 창덕궁 부용정(사모 계열).
//   구성(아래→위): 석재 기단 → 개방 원기둥(벽 없음) → 우물마루+계자난간
//                → 창방·주두 → 곡면 기와 모임지붕 → 절병통(節甁桶).
//
// 지붕 방침: layout/roof-skeleton.js 의 buildSkeletonRoof 는 "직교 전용" straight
//   skeleton(rect/L/U) 이라 60° 변을 가진 육각형은 처리 못 한다(정사각만 꼭짓점 수렴).
//   사모·육모를 한 경로로 지원하기 위해 여기서 n각형 모임지붕을 직접 로프트한다.
//   기와 톤·물매·앙곡·안허리곡·처마 단면 띠는 기존 지붕과 한 가족이 되도록
//   같은 tile 재질(tileSurfaceMaterial)·tileRidge·eaveBand 를 재사용한다.
//
// buildPavilion(opts) → THREE.Group (원점 = 기단 바닥 중심, +y 위).

const TWO_PI = Math.PI * 2;

// n각형 프리즘/뿔대 지오메트리(내가 정한 꼭짓점각과 정확히 정렬). 상면 캡 포함.
// 재질은 호출부에서 DoubleSide 로 클론해 안팎 검게 죽지 않게 한다.
function ngonPrism(n, rBot, rTop, y0, h, rot) {
  const pos = [], idx = [];
  const push = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  const bi = [], ti = [];
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * TWO_PI;
    bi.push(push(Math.cos(a) * rBot, y0, Math.sin(a) * rBot));
  }
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * TWO_PI;
    ti.push(push(Math.cos(a) * rTop, y0 + h, Math.sin(a) * rTop));
  }
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    idx.push(bi[k], ti[k], ti[j], bi[k], ti[j], bi[j]); // 옆면
  }
  const c = push(0, y0 + h, 0);                          // 상면 캡
  for (let k = 0; k < n; k++) idx.push(ti[k], c, ti[(k + 1) % n]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}

// 배흘림 원기둥 프로파일(높이 1/3 지점이 가장 굵음) — columns.js 와 같은 감각.
function pavColumnGeo(radius, height, entasis = 0.5) {
  const pts = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const bulge = 1 + entasis * 0.24 * Math.sin(Math.PI * Math.min(1, t / 0.66));
    const taper = 1 - 0.12 * t;
    pts.push(new THREE.Vector2(radius * bulge * taper, height * t));
  }
  return new THREE.LatheGeometry(pts, 12);
}

// 절병통(節甁桶): 사모·육모 추녀마루가 꼭대기에 모인 위에 올리는 병 모양 장식기와.
//   노반 → 병몸 2단(둥근 배 + 잘록한 목) → 앙화 → 보주. LatheGeometry 병 실루엣.
function buildFinial(M, apexY, scale = 1) {
  const g = new THREE.Group();
  g.name = 'jeolbyeongtong';
  const cera = M.tileRidge; // 장식기와 → 기와 마루 톤과 동일 계열
  let y = apexY;
  // 노반(받침 상자)
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34 * scale, 0.4 * scale, 0.2 * scale, 8), cera);
  base.position.set(0, y + 0.1 * scale, 0); base.castShadow = true; g.add(base);
  y += 0.2 * scale;
  // 병 몸통(둥근 배 → 잘록한 목) 2단 반복 + 보주 — 하나의 LatheGeometry 실루엣
  const prof = [
    [0.001, 0.00], [0.20, 0.00], [0.26, 0.10], [0.24, 0.24], [0.13, 0.38], // 아래 배
    [0.10, 0.46], [0.22, 0.56], [0.25, 0.70], [0.20, 0.84], [0.10, 0.94],  // 위 배
    [0.07, 1.02], [0.14, 1.10], [0.10, 1.20], [0.001, 1.24],               // 목·보주 받침
  ].map(([r, t]) => new THREE.Vector2(r * scale, t * scale));
  const bottle = new THREE.Mesh(new THREE.LatheGeometry(prof, 12), cera);
  bottle.position.set(0, y, 0); bottle.castShadow = true; g.add(bottle);
  y += 1.24 * scale;
  // 보주(꼭대기 구슬)
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.11 * scale, 10, 8), cera);
  bead.position.set(0, y + 0.06 * scale, 0); bead.castShadow = true; g.add(bead);
  return g;
}

export function buildPavilion(opts = {}) {
  const {
    sides = 6,               // 4=사모지붕, 6=육모지붕
    style = 'palace',        // 정자는 대개 단청(궁) 계열
    radius = PAVILION_DEFAULTS.radius,             // 기둥 링 외접원 반경
    postH = PAVILION_DEFAULTS.postH,               // 기둥 높이(개방·벽 없음)
    eaveOverhang = PAVILION_DEFAULTS.eaveOverhang, // 처마 내밈(반경 방향)
    roofRise = PAVILION_DEFAULTS.roofRise,         // 처마→꼭대기 높이(모임지붕 물매)
    cornerLift = PAVILION_DEFAULTS.cornerLift,     // 앙곡(추녀 들림)
    planCurve = PAVILION_DEFAULTS.planCurve,       // 안허리곡(추녀 밖으로)
    profileCurve = PAVILION_DEFAULTS.profileCurve, // 물매(처마로 갈수록 완만)
    entrance = true,         // 한 변 난간 비움(오르는 쪽)
  } = opts;
  const M = opts.materials || makeMaterials(style);
  const n = Math.max(3, Math.round(sides));
  const rot = n === 4 ? Math.PI / 4 : Math.PI / 6; // 정면(+z)에 변이 오게

  const root = new THREE.Group();
  root.name = 'pavilion';

  // ── 수직 레이아웃 ──
  const podH = 0.5;
  const podTopY = podH;
  const floorTopY = podTopY + 0.18;         // 살짝 들린 우물마루
  const colBaseY = podTopY;
  const colTopY = colBaseY + postH;
  const eaveY = colTopY + 0.35;
  const apexY = eaveY + roofRise;

  const dside = (mat) => { const m = mat.clone(); m.side = THREE.DoubleSide; return m; };
  const vtx = (k, r = radius) => {
    const a = rot + (k / n) * TWO_PI;
    return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  };
  const edgeMidAngle = (k) => rot + ((k + 0.5) / n) * TWO_PI;

  // ── 1) 석재 기단(2단 n각형) ──
  const podium = new THREE.Group(); podium.name = 'podium';
  const p1 = new THREE.Mesh(ngonPrism(n, radius + 0.85, radius + 0.9, 0, 0.24, rot), dside(M.stone));
  const p2 = new THREE.Mesh(ngonPrism(n, radius + 0.6, radius + 0.55, 0.24, podH - 0.24, rot), dside(M.stone));
  const cap = new THREE.Mesh(ngonPrism(n, radius + 0.64, radius + 0.62, podH - 0.06, 0.08, rot), dside(M.stoneDark));
  for (const m of [p1, p2, cap]) { m.castShadow = m.receiveShadow = true; podium.add(m); }
  root.add(podium);

  // ── 2) 우물마루(개방 바닥) ──
  const floor = new THREE.Group(); floor.name = 'floor';
  // 개방 정자 마루는 지붕 그늘에 들어가 검게 죽기 쉬워 미량 emissive 로 목재감 유지.
  const maruMat = dside(M.maru); maruMat.emissive = new THREE.Color(0x160f08); maruMat.emissiveIntensity = 1;
  const deck = new THREE.Mesh(ngonPrism(n, radius * 0.97, radius * 0.97, floorTopY - 0.16, 0.16, rot), maruMat);
  deck.castShadow = deck.receiveShadow = true; floor.add(deck);
  const deckEdge = new THREE.Mesh(ngonPrism(n, radius * 0.99, radius * 0.99, floorTopY - 0.2, 0.06, rot), dside(M.woodDark));
  deckEdge.castShadow = true; floor.add(deckEdge);
  root.add(floor);

  // ── 3) 개방 원기둥 + 주두 + 창방(사방 둘레) ──
  const frame = new THREE.Group(); frame.name = 'frame';
  const colGeo = pavColumnGeo(0.16, postH, 0.5);
  const beamMat = M.beamDancheong.clone();
  const edgeLen = 2 * radius * Math.sin(Math.PI / n);
  if (beamMat.map) { beamMat.map = beamMat.map.clone(); beamMat.map.repeat.set(Math.max(1, Math.round(edgeLen / 1.6)), 1); beamMat.map.needsUpdate = true; }
  for (let k = 0; k < n; k++) {
    const P = vtx(k);
    const col = new THREE.Mesh(colGeo, M.wood);
    col.position.set(P.x, colBaseY, P.z); col.castShadow = col.receiveShadow = true; frame.add(col);
    // 주두(기둥머리 받침) + 소로 힌트
    const cap2 = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.32), M.bracket);
    cap2.position.set(P.x, colTopY + 0.02, P.z); cap2.castShadow = true; frame.add(cap2);
    // 창방(다음 기둥까지)
    const A = vtx(k), B = vtx((k + 1) % n);
    const mid = A.clone().lerp(B, 0.5);
    const ang = Math.atan2(B.z - A.z, B.x - A.x);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(edgeLen + 0.1, 0.3, 0.2), beamMat);
    beam.position.set(mid.x, colTopY + 0.2, mid.z); beam.rotation.y = -ang;
    beam.castShadow = true; frame.add(beam);
  }
  root.add(frame);

  // ── 4) 계자난간(개방 정자 격식) — 궁판 + 동자기둥 + 밖으로 내민 돌란대 + 하엽 ──
  const rail = new THREE.Group(); rail.name = 'railing';
  const railH = 0.52;
  // entrance 변: +z(정면)에 가장 가까운 변을 오르는 쪽으로 비운다.
  let entranceEdge = 0, best = -Infinity;
  for (let k = 0; k < n; k++) { const a = edgeMidAngle(k); const s = Math.sin(a); if (s > best) { best = s; entranceEdge = k; } }
  for (let k = 0; k < n; k++) {
    if (entrance && k === entranceEdge) continue;
    const A = vtx(k), B = vtx((k + 1) % n);
    const mid = A.clone().lerp(B, 0.5);
    const ang = Math.atan2(B.z - A.z, B.x - A.x);
    const nrm = new THREE.Vector3(Math.cos(edgeMidAngle(k)), 0, Math.sin(edgeMidAngle(k))); // 바깥 방향
    const y0 = floorTopY;
    // 궁판(하부 널판)
    const panel = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 0.32, 0.2, 0.05), M.woodDark);
    panel.position.set(mid.x, y0 + 0.14, mid.z); panel.rotation.y = -ang; panel.castShadow = true; rail.add(panel);
    // 동자기둥(3개) + 하엽
    const nPost = 3;
    for (let i = 0; i < nPost; i++) {
      const t = (i / (nPost - 1) - 0.5); // -0.5..0.5
      const px = mid.x + (B.x - A.x) * t * 0.72;
      const pz = mid.z + (B.z - A.z) * t * 0.72;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, railH - 0.2, 0.06), M.wood);
      post.position.set(px, y0 + 0.24 + (railH - 0.2) / 2, pz); post.rotation.y = -ang; post.castShadow = true; rail.add(post);
      const hayeop = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.1), M.accentBlue); // 하엽(잎 받침) 힌트
      hayeop.position.set(px + nrm.x * 0.06, y0 + railH - 0.02, pz + nrm.z * 0.06); hayeop.rotation.y = -ang; rail.add(hayeop);
    }
    // 돌란대(둥근 윗난간) — 바깥으로 살짝 내밈(계자난간 특징)
    const rl = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, edgeLen + 0.06, 8), M.wood);
    rl.position.set(mid.x + nrm.x * 0.08, y0 + railH + 0.03, mid.z + nrm.z * 0.08);
    rl.rotation.z = Math.PI / 2; rl.rotation.y = -ang; rl.castShadow = true; rail.add(rl);
  }
  root.add(rail);

  // ── 5) 곡면 기와 모임지붕(n면 스캘럽 원뿔) ──
  const roof = new THREE.Group(); roof.name = 'roof';
  const R0 = radius + eaveOverhang;                  // 처마 기준 반경(변 중앙)
  const NV = 8, NUf = 10, NU = n * NUf;
  const slopeLen = Math.hypot(R0, apexY - eaveY);
  const ends = (u) => Math.pow(Math.abs(2 * u - 1), 3.0); // 코너=1, 중앙=0
  const prof = (v) => Math.pow(v, 1 + profileCurve);       // 물매(오목)

  const pos = [], uv = [], idx = [];
  for (let iu = 0; iu <= NU; iu++) {
    const frac = iu / NU;
    const theta = rot + frac * TWO_PI;
    const facePos = frac * n;
    const u = facePos - Math.floor(facePos + 1e-9);
    const e = ends(u);
    const eaveR = R0 + planCurve * e;
    const eaveYy = eaveY + cornerLift * e;
    for (let iv = 0; iv <= NV; iv++) {
      const v = iv / NV;
      const r = eaveR * (1 - v);
      const y = eaveYy + (apexY - eaveYy) * prof(v);
      pos.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
      uv.push(frac * (TWO_PI * R0 / 0.34), v * (slopeLen / 0.9));
    }
  }
  for (let iu = 0; iu < NU; iu++) for (let iv = 0; iv < NV; iv++) {
    const a = iu * (NV + 1) + iv, b = a + 1, c = a + (NV + 1), d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const rgeo = new THREE.BufferGeometry();
  rgeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  rgeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  rgeo.setIndex(idx);
  rgeo.computeVertexNormals();
  // tileSurfaceMaterial(width=0.34, slope=0.9) → repeat(1,1): 반복수는 위 UV 가 이미 보유.
  const rmat = tileSurfaceMaterial(M, 0.34, 0.9, TILE_LOOK.bumpSurface);
  rmat.side = THREE.DoubleSide;
  const rmesh = new THREE.Mesh(rgeo, rmat);
  rmesh.castShadow = rmesh.receiveShadow = true;
  roof.add(rmesh);

  // 처마 단면 띠(연함·기와 마구리 두께) — 스캘럽 처마선을 따라
  const bandPos = [], bandIdx = [];
  for (let iu = 0; iu <= NU; iu++) {
    const frac = iu / NU, theta = rot + frac * TWO_PI;
    const facePos = frac * n, u = facePos - Math.floor(facePos + 1e-9), e = ends(u);
    const eaveR = R0 + planCurve * e, eaveYy = eaveY + cornerLift * e;
    const x = Math.cos(theta) * eaveR, z = Math.sin(theta) * eaveR;
    bandPos.push(x, eaveYy + 0.03, z, x, eaveYy - 0.14, z);
  }
  for (let iu = 0; iu < NU; iu++) { const a = iu * 2, b = a + 1, c = a + 2, d = a + 3; bandIdx.push(a, b, c, c, b, d); }
  const bgeo = new THREE.BufferGeometry();
  bgeo.setAttribute('position', new THREE.Float32BufferAttribute(bandPos, 3));
  bgeo.setIndex(bandIdx); bgeo.computeVertexNormals();
  const band = new THREE.Mesh(bgeo, dside(M.eaveBand)); band.castShadow = true; roof.add(band);

  // 서까래 마구리(처마 끝 흰 단면) — 둘레로 성기게
  const nRafter = n * 6;
  const rafterGeo = new THREE.BoxGeometry(0.06, 0.06, 0.14);
  for (let i = 0; i < nRafter; i++) {
    const frac = i / nRafter, theta = rot + frac * TWO_PI;
    const facePos = frac * n, u = facePos - Math.floor(facePos + 1e-9), e = ends(u);
    const eaveR = R0 + planCurve * e, eaveYy = eaveY + cornerLift * e;
    const rf = new THREE.Mesh(rafterGeo, M.rafterEnd);
    rf.position.set(Math.cos(theta) * (eaveR - 0.02), eaveYy - 0.03, Math.sin(theta) * (eaveR - 0.02));
    rf.rotation.y = -theta; roof.add(rf);
  }

  // 추녀마루(모임지붕 코너 마루) — 꼭대기→처마 코너로 오목하게, 기와 마루 톤
  for (let k = 0; k < n; k++) {
    const theta = rot + (k / n) * TWO_PI;
    const eaveR = R0 + planCurve, eaveYy = eaveY + cornerLift;
    const pts = [];
    const K = 10;
    for (let i = 0; i <= K; i++) {
      const v = i / K, r = eaveR * (1 - v);
      const y = eaveYy + (apexY - eaveYy) * prof(v) + 0.06;
      pts.push(new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r));
    }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), K, 0.09, 6), M.tileRidge);
    tube.castShadow = true; roof.add(tube);
  }
  root.add(roof);

  // ── 6) 절병통 ──
  root.add(buildFinial(M, apexY - 0.05, 1.0));

  root.userData = {
    kind: 'pavilion', sides: n, radius, materials: M,
    height: apexY + PAVILION_DEFAULTS.finialAllowance, eaveY, floorTopY,
  };
  return root;
}

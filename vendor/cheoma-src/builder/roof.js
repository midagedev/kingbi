import * as THREE from 'three';
import { TILE_LOOK } from './material-colors.js';
import { tileSurfaceMaterial } from './palette.js';
import { createThatchRoofProfile, THATCH_ROOF_SEGMENTS } from './thatch-profile.js';
import {
  ROOF_MARU_SURFACE_CLEAR,
  ROOF_SHELL_THICKNESS,
  ROOF_WALL_TUCK,
} from '../core/surface-clearance.js';
import { addRoofTileShell } from '../layout/roof-shell.js';
import { resolveRoofRank, roofOrnamentPolicy } from './roof-rank.js';

// 팔작지붕.
// 좌표계: x = 정면 방향(폭), z = 깊이(+z가 정면), y = 높이.
//
// 핵심 곡률:
//  - 지붕곡: 물매가 용마루 쪽(s0)에서 처마 쪽(s1=서까래 물매)으로 줄어드는
//    적분형 프로파일 — 처마 끝 기울기가 서까래와 일치해 구조가 맞물린다.
//  - 앙곡: 처마선이 모서리로 갈수록 위로 들리는 입면 곡선
//  - 안허리곡: 처마선이 모서리로 갈수록 밖으로 더 내미는 평면 곡선

const NU = 48, NV = 22;
const smooth = (t) => t * t * (3 - 2 * t);

export function buildRoof(P, L, M) {
  if (P.roofType === 'choga') return buildThatchRoof(P, L, M);
  const g = new THREE.Group();
  const { s0, s1, q, totalDrop, tileLift } = L.profile;
  const isMatbae = P.roofType === 'matbae';
  // 궁 마루 양성바름: 용마루·내림마루·추녀마루를 백색 회(M.ridgePlaster)로 도장하고
  // 취두·토수·잡상 등 장식 종물만 어두운 기와로 남겨 대비를 준다(근정전 지붕의 최대 식별 특징).
  // 절(맞배)·초가는 종전대로 어두운 적새 마루 유지 — 양성바름은 궁 격식.
  // 잡상·취두는 style이 아니라 roof-rank 정책(#150 C)이 소유: palace only.
  // 관아·객사(heroStyle palace → rank magistracy)는 궁 재질을 빌려도 종물을 받지 않는다.
  const isPalace = P.style === 'palace';
  const ornaments = roofOrnamentPolicy(resolveRoofRank(P));
  const maruMat = isPalace ? M.ridgePlaster : M.tileRidge;
  const xr = L.ridgeHalf;
  const yEaveTile = L.eaveEdgeY + tileLift; // 기와면 기준 처마 높이
  // 앙곡 배분 지수: 클수록 처마선이 직선이다가 끝에서만 들린다. 궁=1.7, 절=3.6.
  const cornerEase = (t) => Math.pow(Math.abs(t), P.cornerEasePow ?? 1.7);

  // 낙차 곡선 (0..1 정규화): slope(v)=s1+(s0-s1)(1-v)^q 의 적분
  const dropN = (v) =>
    (s1 * v + ((s0 - s1) * (1 - Math.pow(1 - v, q + 1))) / (q + 1)) / totalDrop;

  // 합각 밑변 높이(hipBreak = 낙차 비율) → 곡선상 위치 v* 를 이분법으로 역산
  let vStar = 0.3;
  {
    let lo = 0.01, hi = 0.95;
    for (let i = 0; i < 40; i++) {
      vStar = (lo + hi) / 2;
      if (dropN(vStar) < P.hipBreak) lo = vStar; else hi = vStar;
    }
  }
  const yGable = L.ridgeY - (L.ridgeY - yEaveTile) * dropN(vStar);
  const zGable = L.zEave * vStar;

  // ---- 전/후면 곡면 점 ----
  function frontPoint(u, v, sign /* +1 정면, -1 배면 */) {
    const e = cornerEase(u);
    let half;
    if (isMatbae) half = xr;               // 맞배: 박공까지 전 폭 일정 (합각 확장 없음)
    else if (v <= vStar) half = xr;
    else half = xr + (L.xEave - xr) * smooth((v - vStar) / (1 - vStar));
    const planExtra = P.planCurve * e * Math.pow(v, 3);
    const x = u * (half + planExtra);
    const z = sign * (L.zEave * v + planExtra);
    // 맞배: 박공(|u|→1)에서 앙곡을 0으로 감쇠 → 박공 쪽 처마는 거의 수평(귀 끝 뿔 방지).
    const lift = isMatbae
      ? P.cornerLift * e * (1 - Math.abs(u))
      : P.cornerLift * e;
    const y = L.ridgeY - (L.ridgeY - yEaveTile) * dropN(v) + lift * Math.pow(v, 2.0);
    return new THREE.Vector3(x, y, z);
  }

  // ---- 측면 곡면 점 ----
  function sidePoint(u, v, sign /* +1 오른쪽(+x), -1 왼쪽 */) {
    const e = cornerEase(u);
    const zHalf = zGable + (L.zEave - zGable) * v;
    const planExtra = P.planCurve * e * Math.pow(v, 3);
    const z = u * (zHalf + planExtra);
    const x = sign * (xr + (L.xEave - xr) * v + planExtra);
    const y = yGable - (yGable - yEaveTile) * dropN(v)
      + P.cornerLift * e * Math.pow(v, 2.0);
    return new THREE.Vector3(x, y, z);
  }

  // ---- 그리드 → BufferGeometry ----
  function surfaceGeometry(pointFn, uvFn) {
    const pos = [], uv = [], idx = [];
    for (let iv = 0; iv <= NV; iv++) {
      for (let iu = 0; iu <= NU; iu++) {
        const u = (iu / NU) * 2 - 1;
        const v = iv / NV;
        const p = pointFn(u, v);
        pos.push(p.x, p.y, p.z);
        const [uu, vv] = uvFn(p, u, v);
        uv.push(uu, vv);
      }
    }
    for (let iv = 0; iv < NV; iv++) {
      for (let iu = 0; iu < NU; iu++) {
        const a = iv * (NU + 1) + iu, b = a + 1;
        const c = a + (NU + 1), d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  const slopeLen = Math.hypot(L.zEave, L.ridgeY - yEaveTile);
  const bump = isMatbae ? TILE_LOOK.bumpMatbae : TILE_LOOK.bumpSurface;
  const matFront = tileSurfaceMaterial(M, L.W + P.eaveOverhang * 2, slopeLen, bump);
  const matSide = tileSurfaceMaterial(M, L.D + P.eaveOverhang * 2, slopeLen * (1 - vStar), bump);
  const underMat = M.eaveBand.clone();
  underMat.side = THREE.FrontSide;

  // 기와골 UV: u는 지면 기준 수평 위치(수직 흐름), v는 지붕면 경사 방향
  const frontUV = (p, u, v) => [(p.x + L.xEave) / (2 * L.xEave), 1 - v];
  const sideUV = (p, u, v) => [(p.z + L.zEave) / (2 * L.zEave), 1 - v];

  // Outer tile + structural 개판 underside (docs/ceiling.md). Avoid zero-thickness
  // DoubleSide coplanar faces that z-fight under the eave during assembly.
  for (const sign of [1, -1]) {
    addRoofTileShell(
      g,
      surfaceGeometry((u, v) => frontPoint(u, v, sign), frontUV),
      matFront.clone(),
      underMat.clone(),
      ROOF_SHELL_THICKNESS,
    );
    if (!isMatbae) {
      addRoofTileShell(
        g,
        surfaceGeometry((u, v) => sidePoint(u, v, sign), sideUV),
        matSide.clone(),
        underMat.clone(),
        ROOF_SHELL_THICKNESS,
      );
    }
  }

  // ---- 수키와 볼록 열 (맞배 전용) ----
  // 맞배는 단면 곡선이 모든 x에서 동일하므로, 중심 낙차 곡선을 따르는 튜브 한 줄을
  // 만들어 x 방향 0.35m 간격으로 InstancedMesh 복제한다. 골 그림자는 표면 텍스처가 담당.
  if (isMatbae) {
    const NT = 22, step = 0.35, r = 0.09;
    for (const sign of [1, -1]) {
      const pts = [];
      for (let i = 0; i <= NT; i++) {
        const p = frontPoint(0, i / NT, sign); // 중심 프로파일(앙곡·안허리곡 0)
        p.y += 0.06;                            // 표면 위로 살짝 띄워 볼록 열
        pts.push(p);
      }
      const tubeGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), NT, r, 6, false);
      const n = Math.max(2, Math.floor((2 * xr - 0.2) / step));
      const im = new THREE.InstancedMesh(tubeGeo, M.tileConvex, n + 1);
      const m = new THREE.Matrix4();
      for (let i = 0; i <= n; i++) {
        m.makeTranslation(-xr + 0.1 + i * step, 0, 0);
        im.setMatrixAt(i, m);
      }
      im.castShadow = im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      g.add(im);
    }
  }

  // ---- 처마 단면 띠 (기와 마구리·연함 두께) ----
  function eaveBand(pointFn, sign) {
    const pos = [], idx = [];
    const N = 40;
    const shellT = ROOF_SHELL_THICKNESS;
    const bandPast = 0.01;
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * 2 - 1;
      const p = pointFn(u, 1, sign);
      // Span outer tile lip → past structural gaepan (avoid coplanar underside edge).
      pos.push(p.x, p.y + 0.02, p.z, p.x, p.y - shellT - bandPast, p.z);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, c, b, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = M.eaveBand.clone();
    mat.side = THREE.FrontSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'roof-eave-band';
    mesh.userData.asmGroup = 'body';
    mesh.castShadow = true;
    return mesh;
  }
  for (const sign of [1, -1]) {
    g.add(eaveBand(frontPoint, sign));
    if (!isMatbae) g.add(eaveBand(sidePoint, sign));
  }

  // ---- 합각 (박공면 삼각형 벽) — 팔작 전용 ----
  if (!isMatbae) for (const sign of [1, -1]) {
    const gx = sign * xr;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      gx, L.ridgeY - 0.06, 0,
      gx, yGable, zGable,
      gx, yGable, -zGable,
    ], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 1, 1, 0, 0, 0], 2));
    geo.setIndex([0, 1, 2]);
    geo.computeVertexNormals();
    const mat = M.gable.clone();
    mat.side = THREE.DoubleSide;
    const tri = new THREE.Mesh(geo, mat);
    tri.castShadow = true;
    g.add(tri);

    // 박공널 (합각 경사변의 어두운 테)
    for (const s2 of [1, -1]) {
      const from = new THREE.Vector3(sign * xr, L.ridgeY - 0.04, 0);
      const to = new THREE.Vector3(sign * xr, yGable, s2 * zGable);
      const len = from.distanceTo(to);
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.26, len), M.woodDark);
      board.position.copy(from).lerp(to, 0.5);
      board.lookAt(to);
      board.castShadow = true;
      g.add(board);
    }
  }

  // ---- 마루(용마루·내림마루·추녀마루) ----
  const tube = (points, r, mat = M.tileRidge) => {
    const curve = new THREE.CatmullRomCurve3(points);
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, r, 8), mat);
    mesh.castShadow = true;
    return mesh;
  };

  // 용마루 (맞배는 얕게 하여 박공 끝단면을 작게). 옆면에 적새(암키와 켜) 텍스처.
  const ridgeDepth = isMatbae ? 0.4 : 0.5;
  const jeoksaeMat = M.jeoksae.clone();
  jeoksaeMat.map = M.jeoksae.map.clone();
  jeoksaeMat.map.repeat.set(Math.max(2, Math.round((xr * 2) / 0.5)), 1);
  jeoksaeMat.map.needsUpdate = true;
  // Seat the ridge stack just above the outer tile — a −0.10 sink put the box
  // bottom coplanar with the shell and z-fought under assembly cameras.
  const ridgeSeat = ROOF_MARU_SURFACE_CLEAR;
  const ridge = new THREE.Mesh(
    new THREE.BoxGeometry(xr * 2 + 0.1, P.ridgeH, ridgeDepth),
    isPalace ? M.ridgePlaster : jeoksaeMat);        // 궁: 양성바름 백색 회 / 그 외: 적새 켜
  ridge.position.set(0, L.ridgeY + P.ridgeH / 2 + ridgeSeat, 0);
  ridge.castShadow = true;
  g.add(ridge);
  if (isPalace) {
    // 양성바름 마루의 상·하 마감: 윗면 어두운 기와 관(수키와 마루장) + 밑 착고/부고 어두운 켜.
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(xr * 2 + 0.2, 0.14, ridgeDepth + 0.1), M.tileRidge);
    cap.position.set(0, L.ridgeY + P.ridgeH + ridgeSeat, 0);
    cap.castShadow = true; g.add(cap);
    // Gogo sits under the ridge body but still above the outer tile.
    const gogo = new THREE.Mesh(
      new THREE.BoxGeometry(xr * 2 + 0.14, 0.09, ridgeDepth + 0.06), jeoksaeMat);
    gogo.position.set(0, L.ridgeY + ridgeSeat + 0.045, 0);
    gogo.castShadow = true; g.add(gogo);
  }

  if (!isMatbae) {
    // 취두는 이 생성기의 궁궐 위계 표지다. 지붕 형식만 팔작으로 바꾼 사찰·민가·관아에
    // 장식이 누출되지 않도록 형태 분기와 roof-rank 분기를 분리한다.
    if (ornaments.chwidu) {
      for (const sign of [1, -1]) {
        const s = new THREE.Shape();
        s.moveTo(0, 0); s.lineTo(0.55, 0); s.lineTo(0.55, 0.35);
        s.quadraticCurveTo(0.5, 0.75, 0.15, 0.9);
        s.quadraticCurveTo(0.28, 0.55, 0.18, 0.4);
        s.lineTo(0, 0.35); s.closePath();
        const geo = new THREE.ExtrudeGeometry(s, { depth: 0.58, bevelEnabled: false });
        geo.translate(0, 0, -0.29); // z 방향 중심 정렬 (depth 반영)
        const chwidu = new THREE.Mesh(geo, M.tileRidge);
        chwidu.name = ornaments.chwiduName;
        // 말린 끝(x+)이 용마루 중앙(x=0) 쪽을 향하게: 오른쪽 끝은 좌우 미러
        chwidu.scale.x = sign === 1 ? -1 : 1;
        chwidu.position.set(sign * (xr - 0.05), L.ridgeY + 0.20, 0);
        chwidu.castShadow = true;
        g.add(chwidu);
        // 십자 교차: 같은 shape을 Y축 90° 회전·축소해 겹쳐 어느 각도에서도 실루엣 유지
        const chwidu2 = new THREE.Mesh(geo, M.tileRidge);
        chwidu2.name = ornaments.chwiduName;
        chwidu2.rotation.y = Math.PI / 2;
        chwidu2.scale.setScalar(0.85);
        chwidu2.position.copy(chwidu.position);
        chwidu2.castShadow = true;
        g.add(chwidu2);
      }
    }

    // 내림마루: 용마루 끝 → 합각 밑변 모서리 (합각 경사변을 따르는 직선). 궁=양성바름.
    // Centreline clears outer tile by r + ROOF_MARU_SURFACE_CLEAR (no shell pierce).
    const naerimR = 0.16;
    const naerimLift = naerimR + ROOF_MARU_SURFACE_CLEAR;
    for (const sx of [1, -1]) for (const sz of [1, -1]) {
      g.add(tube([
        new THREE.Vector3(sx * xr, L.ridgeY + naerimLift, 0),
        new THREE.Vector3(sx * xr, yGable + naerimLift, sz * zGable),
      ], naerimR, maruMat));
    }

    // 추녀마루: 합각 밑변 모서리 → 처마 모서리 (전면 곡면의 u=±1 가장자리)
    const chunyeoR = 0.13;
    const chunyeoLift = chunyeoR + ROOF_MARU_SURFACE_CLEAR;
    for (const sx of [1, -1]) for (const sz of [1, -1]) {
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const v = vStar + (1 - vStar) * (i / 8);
        const p = frontPoint(sx, v, sz);
        p.y += chunyeoLift;
        pts.push(p);
      }
      const last = pts[pts.length - 1].clone();
      const prev = pts[pts.length - 2];
      const hipDir = last.clone().sub(prev).normalize();
      last.add(hipDir.clone().multiplyScalar(0.22));
      pts.push(last);
      g.add(tube(pts, chunyeoR, maruMat));    // 추녀마루: 궁=양성바름

      // 토수: 추녀·사래 끝 마구리에 끼우는 용머리형 장식 캡(추녀 방향으로 뻗음).
      const tosuLen = 0.34;
      const tosuGeo = new THREE.CylinderGeometry(0.10, 0.15, tosuLen, 10);
      tosuGeo.translate(0, tosuLen / 2, 0);                     // 밑동을 원점에, +y로 뻗게
      const tosu = new THREE.Mesh(tosuGeo, M.tileRidge);
      tosu.position.copy(last);
      tosu.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hipDir);
      tosu.castShadow = true; g.add(tosu);
      const snout = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), M.tileRidge);
      snout.position.copy(last).add(hipDir.clone().multiplyScalar(tosuLen));
      snout.castShadow = true; g.add(snout);
    }

    if (ornaments.japsang) {
      // 잡상(궁 rank): 추녀마루 위 홀수 열. 처마쪽(앞)=삿갓 쓴 대당사부 → 위로 손오공·저팔계·사오정(유사 반복).
      // 개수는 추녀마루 길이에 비례(격식 높을수록 많이, 3~11 홀수) — 근정전급 ≈ 7.
      let nJab = Math.round(frontPoint(1, vStar, 1).distanceTo(frontPoint(1, 1, 1)) / 0.65);
      nJab = Math.max(3, Math.min(11, nJab));
      if (nJab % 2 === 0) nJab -= 1;
      // 개수가 늘어도 추녀마루 구간(vStar~0.92) 안에 머물도록 간격 자동 축소
      const jabStep = Math.min(0.09, (0.90 - (vStar + 0.05)) / Math.max(1, nJab - 1));
      for (const sx of [1, -1]) for (const sz of [1, -1]) {
        for (let k = 0; k < nJab; k++) {
          const p = frontPoint(sx, 0.92 - k * jabStep, sz);
          p.y += 0.18;
          const lead = k === 0;
          const s = lead ? 0.20 : 0.15 - k * 0.008;
          const body = new THREE.Mesh(new THREE.BoxGeometry(s * 0.7, s, s * 0.7), M.tileRidge);
          body.name = ornaments.japsangName;
          body.position.set(p.x, p.y + s / 2, p.z); body.castShadow = true;
          body.userData.asmGroup = 'finial'; g.add(body);       // 잡상: 지붕 직후 미니팝
          const head = new THREE.Mesh(new THREE.SphereGeometry(s * 0.42, 8, 6), M.tileRidge);
          head.name = ornaments.japsangName;
          head.position.set(p.x, p.y + s + s * 0.35, p.z); head.castShadow = true;
          head.userData.asmGroup = 'finial'; g.add(head);
          if (lead) {
            const hat = new THREE.Mesh(new THREE.ConeGeometry(s * 0.62, s * 0.4, 8), M.tileRidge);
            hat.name = ornaments.japsangName;
            hat.position.set(p.x, p.y + s + s * 0.72, p.z); hat.castShadow = true;
            hat.userData.asmGroup = 'finial'; g.add(hat);
          }
        }
      }
    }
  } else {
    // 용마루 끝(맞배): 납작한 구형 망새 + 와당(망와) — 어느 각도서도 둥근 실루엣.
    const ridgeCy = L.ridgeY + P.ridgeH / 2 - 0.10;
    for (const sign of [1, -1]) {
      const mangsae = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), M.tileRidge);
      mangsae.scale.set(0.9, 0.82, 1.0);            // 살짝 납작한 끝막이
      mangsae.position.set(sign * (xr + 0.02), ridgeCy, 0);
      mangsae.castShadow = true;
      g.add(mangsae);
      // 망와: 바깥면에 와당 원반
      const wa = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 16), M.wadang);
      wa.rotation.z = Math.PI / 2;                  // 원반 면이 ±x 향함
      wa.position.set(sign * (xr + 0.24), ridgeCy, 0);
      wa.castShadow = true;
      g.add(wa);
    }

    // 박공면(양 끝): 벽체 + 풍판 + 박공널
    buildMatbaeGables(P, L, M, g, frontPoint, xr, yEaveTile);
  }

  // ---- 서까래 (연목 + 부연) ----
  buildRafters(P, L, M, g, frontPoint, sidePoint, !isMatbae);

  // 조립 애니: 지붕은 시맨틱 청크(서까래→통덩어리→잡상 미니팝) 단위로 오른다.
  g.userData.asmChunked = true;
  return g;
}

// 서까래: 처마 밑 InstancedMesh. 지붕면보다 기와 두께만큼 아래에 깔린다.
// 연목(아래 열, -0.48)과 부연(위 열, -0.26)이 두 겹으로 늘어서
// 밑에서 올려다보면 겹처마로 읽힌다.
function buildRafters(P, L, M, g, frontPoint, sidePoint, includeSides = true) {
  const spacing = 0.40;
  const rGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 8);
  rGeo.translate(0, 0.5, 0);
  const bGeo = new THREE.BoxGeometry(0.10, 1, 0.10);
  bGeo.translate(0, 0.5, 0);
  // 연목 마구리(원반). 절은 조금 키워(0.105) 처마 밑이 "정연한 둥근 끝 열"로 읽히게.
  const capR = P.style === 'temple' ? 0.105 : 0.08;
  const capGeo = new THREE.CylinderGeometry(capR, capR, 0.025, 12);
  capGeo.translate(0, -0.01, 0);

  const items = [];
  const collect = (pointFn, signs) => {
    for (const sign of signs) {
      const a = pointFn(-1, 1, sign), b = pointFn(1, 1, sign);
      const n = Math.max(8, Math.round(a.distanceTo(b) / spacing));
      for (let i = 0; i <= n; i++) {
        const u = (i / n) * 2 - 1;
        // 모서리 근처는 선자연(부채살)이 덮으므로 균일 서까래는 스킵
        if (Math.abs(u) > 0.86) continue;
        // 연목 (아래 열). 절은 완만한 지붕에서 기와면 관통 방지로 더 깊이 내림.
        const dn = P.style === 'temple' ? 0.10 : 0;
        const inner = pointFn(u * 0.92, 0.60, sign);
        inner.y -= 0.55 + dn;
        const outer = pointFn(u, 1, sign);
        outer.y -= 0.48 + dn;
        const dir = outer.clone().sub(inner).normalize();
        const tip = outer.clone().add(dir.clone().multiplyScalar(0.10));
        items.push({ from: inner, to: tip, kind: 'round' });
        // 부연 (위 열, 겹처마)
        if (P.doubleEave) {
          const temple = P.style === 'temple';
          const bi = pointFn(u * 0.97, 0.84, sign);
          bi.y -= temple ? 0.40 : 0.34;
          const souter = pointFn(u, 1, sign);
          souter.y -= temple ? 0.34 : 0.26;
          const sdir = souter.clone().sub(bi).normalize();
          const bo = souter.clone().add(sdir.clone().multiplyScalar(0.30));
          // 절: 완만한 지붕에서 부연 끝이 기와면 위로 솟던 결함 → 처마선 아래로 하향 고정.
          if (temple) bo.y = Math.min(bo.y, souter.y - 0.04);
          items.push({ from: bi, to: bo, kind: 'square' });
        }
      }
    }
  };
  collect(frontPoint, [1, -1]);
  if (includeSides) collect(sidePoint, [1, -1]);

  // ---- 선자연 (모서리 부채살): 각 모서리에서 앵커점 하나로 서까래가 부챗살처럼 모임 ----
  // sidePoint 시그니처 (u, v, sign)에서 sign이 ±x 쪽. 모서리 (sx, sz)의 측면 곡면은 sign=sx.
  // 맞배는 측면 처마·추녀가 없으므로 선자연도 생성하지 않는다.
  if (includeSides) for (const sx of [1, -1]) for (const sz of [1, -1]) {
    const anchor = frontPoint(sx * 0.84, 0.52, sz);
    anchor.y -= 0.42;
    for (let k = 1; k <= 5; k++) {
      const t1 = frontPoint(sx * (0.88 + 0.024 * k), 1, sz);
      t1.y -= 0.48;
      items.push({ from: anchor.clone(), to: t1, kind: 'round' });
      const t2 = sidePoint(sz * (0.88 + 0.024 * k), 1, sx);
      t2.y -= 0.48;
      items.push({ from: anchor.clone(), to: t2, kind: 'round' });
    }
  }

  const rounds = items.filter((i) => i.kind === 'round');
  const squares = items.filter((i) => i.kind === 'square');

  const place = (geo, mat, list) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), qt = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
    list.forEach((it, i) => {
      dir.copy(it.to).sub(it.from);
      const len = dir.length();
      qt.setFromUnitVectors(up, dir.normalize());
      m.compose(it.from, qt, new THREE.Vector3(1, len, 1));
      im.setMatrixAt(i, m);
    });
    im.castShadow = true;
    im.instanceMatrix.needsUpdate = true;
    im.userData.asmGroup = 'rafters';   // 서까래: 지붕 통덩어리 직전 청크
    im.userData.roofLayer = 'rafter';
    g.add(im);
  };

  place(rGeo, M.rafter, rounds);
  if (squares.length) place(bGeo, M.rafter, squares);

  // 연목 마구리 = 연목초(목재용 컬러 문양). 청·황·적 동심원 — 회색 수막새(와당)와 구분.
  // (회색 와당은 처마 기와 끝 막새 자리에만 쓴다.)
  const caps = new THREE.InstancedMesh(capGeo, M.yeonmokcho, rounds.length);
  const m = new THREE.Matrix4(), qt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  rounds.forEach((it, i) => {
    dir.copy(it.to).sub(it.from);
    qt.setFromUnitVectors(up, dir.normalize());
    m.compose(it.to, qt, new THREE.Vector3(1, 1, 1));
    caps.setMatrixAt(i, m);
  });
  caps.instanceMatrix.needsUpdate = true;
  caps.userData.asmGroup = 'rafters';
  g.add(caps);

  // 부연 끝 마구리 = 부연초(사각 컬러 문양). 부연 단면에 밀착한 얇은 판(0.02) →
  // 부유 판이 아니라 "칠해진 끝면"으로 읽히게. 방향은 부연 각도에 정렬.
  if (squares.length) {
    const bCapGeo = new THREE.BoxGeometry(0.11, 0.02, 0.11);
    const bcaps = new THREE.InstancedMesh(bCapGeo, M.bujeoncho, squares.length);
    const bm = new THREE.Matrix4(), bq = new THREE.Quaternion();
    const bup = new THREE.Vector3(0, 1, 0), bdir = new THREE.Vector3();
    squares.forEach((it, i) => {
      bdir.copy(it.to).sub(it.from);
      bq.setFromUnitVectors(bup, bdir.normalize());
      bm.compose(it.to, bq, new THREE.Vector3(1, 1, 1));
      bcaps.setMatrixAt(i, bm);
    });
    bcaps.instanceMatrix.needsUpdate = true;
    bcaps.userData.asmGroup = 'rafters';
    g.add(bcaps);
  }
}

// 맞배 박공면(양 끝):
//  - 박공 벽체: 벽 상부~용마루 삼각 (노출 가구 텍스처). 끝 기둥열 평면(x=±W/2)에 세워 뚫림 방지.
//  - 풍판: 박공널 안쪽(살짝 안쪽)에 세로 널판 삼각.
//  - 박공널: 지붕 경사변을 따르는 두꺼운 어두운 목재 보드 2장(전·후 슬로프).
// 좌표계: 벽 단면은 (z, y) 2D 셰이프로 만든 뒤 Y축 -90° 회전해 x=const 평면에 세운다.
function buildMatbaeGables(P, L, M, g, frontPoint, xr, yEaveTile) {
  const W = L.W;
  const zHalf = L.D / 2;
  const vMax = Math.min(0.98, zHalf / L.zEave); // 벽 폭이 걸치는 지붕 파라미터 범위

  // 박공 단면 프로파일(z, y): 앙곡·안허리곡이 없는 중심 곡선(u=0)을 써야
  // 박공면이 평면에 밀착하고 부재가 허공에 뜨지 않는다.
  const prof = (v, sz) => {
    const p = frontPoint(0, v, sz);
    return { z: p.z, y: p.y };
  };

  for (const sx of [1, -1]) {
    const xWall = sx * (W / 2);

    // 1) 박공 벽체 (노출 가구): 뒷경사→용마루→앞경사→밑변 순으로 폴리곤.
    const shape = new THREE.Shape();
    const N = 12;
    // 윗변은 기와 상면(prof.y)보다 확실히 아래로 내려 지붕을 뚫지 않게 한다(기와 두께 여유).
    const yTuck = ROOF_WALL_TUCK;
    for (let i = 0; i <= N; i++) {
      const v = vMax * (1 - i / N);      // 뒷경사: z=-zHalf → 0
      const q = prof(v, -1);
      if (i === 0) shape.moveTo(q.z, q.y - yTuck);
      else shape.lineTo(q.z, q.y - yTuck);
    }
    for (let i = 1; i <= N; i++) {
      const v = vMax * (i / N);          // 앞경사: 0 → z=+zHalf
      const q = prof(v, 1);
      shape.lineTo(q.z, q.y - yTuck);
    }
    const zR = prof(vMax, 1).z, zL = prof(vMax, -1).z;
    shape.lineTo(zR, L.colTopY);         // 밑변 (벽 상부)
    shape.lineTo(zL, L.colTopY);
    shape.closePath();
    const wallGeo = new THREE.ShapeGeometry(shape);
    wallGeo.rotateY(-Math.PI / 2);
    wallGeo.translate(xWall, 0, 0);
    const wall = new THREE.Mesh(wallGeo, M.plaster.clone()); // 황토 바탕
    wall.name = 'matbae-gable-wall';
    wall.material.side = THREE.DoubleSide;
    wall.castShadow = wall.receiveShadow = true;
    g.add(wall);

    // 1b) 노출 가구(수덕사식): 부재를 줄여 명료하게 — 도리 3단 + 중앙 대공 + 솟을합장 ∧.
    //     밝은 무단청 목재(M.wood)로 황토 벽면 위에서 또렷하게 읽히게. 기와 상면보다 -0.26.
    const yf = -0.26, xf = xWall + sx * 0.10;
    // 수평 도리 3단 (종도리·중도리·주심도리)
    for (const v of [0.34, 0.50, 0.66]) {
      const zt = prof(v, 1).z;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 2 * zt), M.wood);
      beam.position.set(xf, prof(v, 1).y + yf, 0);
      beam.castShadow = true;
      g.add(beam);
    }
    // 중앙 대공 (수직 king post): 용마루 밑 중앙에서 최상단 도리까지
    {
      const topY = prof(0.20, 1).y + yf, botY = prof(0.34, 1).y + yf;
      const daegong = new THREE.Mesh(new THREE.BoxGeometry(0.2, Math.abs(topY - botY) + 0.12, 0.16), M.wood);
      daegong.position.set(xf, (topY + botY) / 2, 0);
      daegong.castShadow = true;
      g.add(daegong);
    }
    // 솟을합장 ∧: 용마루 아래 중앙에서 좌우 아래로 벌어지는 대각 합장
    for (const sz of [1, -1]) {
      const top = new THREE.Vector3(xf, prof(0.20, 1).y + yf, 0);
      const foot = new THREE.Vector3(xf, prof(0.50, sz).y + yf, prof(0.50, sz).z);
      const len = top.distanceTo(foot);
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, len), M.wood);
      strut.position.copy(top).lerp(foot, 0.5);
      strut.lookAt(foot);
      strut.castShadow = true;
      g.add(strut);
    }

    // 2) 풍판 (세로 널판): 용마루 밑 작은 삼각 캡만 — 아래 노출 가구가 최대한 드러나게.
    //    기와 상면보다 -0.14 내려 지붕을 뚫지 않게.
    const vc = 0.18, yTk = 0.14;
    const pp = new THREE.Shape();
    pp.moveTo(0, prof(0, 1).y - yTk);
    pp.lineTo(prof(vc, 1).z, prof(vc, 1).y - yTk);
    pp.lineTo(prof(vc, -1).z, prof(vc, -1).y - yTk);
    pp.closePath();
    const ppGeo = new THREE.ShapeGeometry(pp);
    ppGeo.rotateY(-Math.PI / 2);
    ppGeo.translate(sx * (xr - 0.10), 0, 0);
    const pung = new THREE.Mesh(ppGeo, M.pungpan.clone());
    pung.material.side = THREE.DoubleSide;
    pung.castShadow = true;
    g.add(pung);

    // 3) 박공널: 박공면 평면 부재. x는 sx*xr 고정, y·z는 중심 프로파일(prof)로 잡아
    //    앙곡·안허리곡을 먹지 않게 — 처마 끝에서 허공에 뜨는 "검은 갈고리" 방지.
    for (const sz of [1, -1]) {
      const pts = [];
      const NB = 8;
      // 박공 삼각변까지만(용마루~벽 상부, v≤vMax) — 처마 끝까지 끌지 않아 뻗침 방지.
      for (let i = 0; i <= NB; i++) {
        const c = prof((i / NB) * vMax, sz);
        pts.push(new THREE.Vector3(sx * xr, c.y + 0.04, c.z));
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const from = pts[i], to = pts[i + 1];
        const len = from.distanceTo(to);
        const board = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.30, len + 0.03), M.woodBoard);
        board.position.copy(from).lerp(to, 0.5);
        board.lookAt(to);
        board.castShadow = true;
        g.add(board);
      }
    }
  }
}

// ── 볏짚 우진각 지붕(초가) ───────────────────────────────────────────
// 둥근사각(스퀘어클) 평면 위에 힙 높이장을 얹어 두툼한 볏짚 돔을 만든다.
// 지붕면 경계 = 처마 롤 둘레(같은 초승형) → 모서리 삐침(어두운 삼각) 결함 제거.
// 마감: 처마 눌림대(새끼) + 두꺼운 거친 프린지, 내리방향 집줄 그물(3D 튜브),
//       엮은 용마름 롤.
function buildThatchRoof(P, L, M) {
  const g = new THREE.Group();
  const profile = createThatchRoofProfile(P, L);
  const {
    xEave, zEave, eaveY, rise, ridgeY, ridgeHalfX, thick,
    planExponent: ne, ridgeSag, planXZ, descend, heightAB,
  } = profile;

  const straw = () => {
    const m = M.thatch.clone();
    m.map = M.thatch.map.clone();
    m.side = THREE.DoubleSide;
    return m;
  };

  const slopeLen = Math.hypot(zEave, rise);

  // ── 지붕면 그리드 (둥근사각) ── UV: v=하강 → 짚결이 경사 따라 아래로 흐름
  const NA = THATCH_ROOF_SEGMENTS.a, NB = THATCH_ROOF_SEGMENTS.b;
  const pos = [], uv = [], idx = [];
  for (let ib = 0; ib <= NB; ib++) {
    for (let ia = 0; ia <= NA; ia++) {
      const a = (ia / NA) * 2 - 1, b = (ib / NB) * 2 - 1;
      const [x, z] = planXZ(a, b);
      pos.push(x, heightAB(a, b), z);
      uv.push(x / 1.25, descend(a, b) * (slopeLen / 1.25));
    }
  }
  for (let ib = 0; ib < NB; ib++) {
    for (let ia = 0; ia < NA; ia++) {
      const q = ib * (NA + 1) + ia, w = q + 1, e = q + (NA + 1), r = e + 1;
      idx.push(q, e, w, w, e, r);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const surf = new THREE.Mesh(geo, straw());
  surf.castShadow = surf.receiveShadow = true;
  g.add(surf);

  // ── 처마 끝(이엉 프린지) — 지붕면 경계 링에서 경사 접선을 따라 뻗는 거친 볏짚 마감 ──
  // 지붕면 아우터 그리드 링을 순회해 각 경계점의 하강 접선 t(밖+아래)를 구하고, 그 방향으로
  //   ① 썰린 단면 립(밝은 금빛, 약한 지터)  ② 풀린 짚끝(고주파 삐침, 중력 처짐) 2단으로 뻗는다.
  // 폐기: eaveY 수직 낙하 스커트(매끈한 커튼). 경사 연장이라 면이 위-밖을 봐 빛을 받고, 썰린
  //       단면·짚끝을 vertexColor로 지붕면보다 밝게 올려 "천 밑단"이 아니라 볏짚 술로 읽힌다.
  const vAt = (ia, ib) => {
    const q = (ib * (NA + 1) + ia) * 3;
    return new THREE.Vector3(pos[q], pos[q + 1], pos[q + 2]);
  };
  const loop = [];                                   // [경계점, 안쪽이웃] — 하강 접선 산출용
  for (let ia = 0; ia <= NA; ia++) loop.push([[ia, 0], [ia, 1]]);
  for (let ib = 1; ib <= NB; ib++) loop.push([[NA, ib], [NA - 1, ib]]);
  for (let ia = NA - 1; ia >= 0; ia--) loop.push([[ia, NB], [ia, NB - 1]]);
  for (let ib = NB - 1; ib >= 1; ib--) loop.push([[0, ib], [1, ib]]);
  const NL = loop.length;
  const edge = loop.map(([e]) => vAt(e[0], e[1]));
  const down = loop.map(([e, n]) => vAt(e[0], e[1]).sub(vAt(n[0], n[1])).normalize()); // 밖+아래
  const tang = [];                                   // 둘레 접선(짚끝 가로 흔들림)
  for (let i = 0; i < NL; i++) {
    const a = edge[(i - 1 + NL) % NL], b = edge[(i + 1) % NL];
    tang.push(new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize());
  }
  // 결정론 해시(Math.random 금지) — 인덱스 기반 고주파 삐침
  const hsh = (i, k) => { const s = Math.sin(i * (12.9898 + k * 6.71) + k * 4.13) * 43758.5453; return s - Math.floor(s); };
  const faceLen = thick * 0.9;                        // 썰린 단면 두께감(≈35cm)
  const tipLen = thick * 0.85;                        // 풀린 짚끝 삐침 길이
  const vTop = slopeLen / 1.25;                       // 경계 v(짚결 이어짐)
  const fp = [], fu = [], fc = [], fi = [];
  let acc = 0;
  for (let i = 0; i <= NL; i++) {
    const ii = i % NL, e = edge[ii], t = down[ii], tg = tang[ii];
    if (i > 0) acc += e.distanceTo(edge[(i - 1) % NL]);
    const u = acc / 1.25;
    fp.push(e.x, e.y, e.z); fu.push(u, vTop); fc.push(1, 1, 1);                     // 링0: 지붕면 경계(지붕톤)
    const fl = faceLen * (0.82 + hsh(ii, 0) * 0.30);
    const p1 = e.clone().addScaledVector(t, fl);
    fp.push(p1.x, p1.y, p1.z); fu.push(u, vTop + fl / 1.25); fc.push(1.30, 1.18, 0.93); // 링1: 썰린 단면 립(밝은 금빛)
    const tl = tipLen * (0.58 + hsh(ii, 1) * 0.5 + hsh(ii, 4) * 0.22); // 얕은 편차 다중옥타브 → 촘촘한 술
    const droop = 0.05 + hsh(ii, 2) * 0.12;
    const lat = (hsh(ii, 3) - 0.5) * 0.07;
    const p2 = p1.clone().addScaledVector(t, tl).addScaledVector(tg, lat); p2.y -= droop;
    fp.push(p2.x, p2.y, p2.z); fu.push(u, vTop + (fl + tl) / 1.25); fc.push(1.18, 1.08, 0.85); // 링2: 풀린 짚끝(거친 삐침)
  }
  for (let i = 0; i < NL; i++) {
    const a = i * 3, b = a + 3;
    fi.push(a, a + 1, b, b, a + 1, b + 1);            // 링0→링1(단면)
    fi.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2); // 링1→링2(짚끝)
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  fgeo.setAttribute('uv', new THREE.Float32BufferAttribute(fu, 2));
  fgeo.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
  fgeo.setIndex(fi);
  fgeo.computeVertexNormals();
  const fmat = straw();
  fmat.vertexColors = true;
  fmat.emissive.setHex(0x241a0e);                     // 밑면 그늘이 죽은 검정 되지 않게 살짝 밝게
  const fringe = new THREE.Mesh(fgeo, fmat);
  fringe.castShadow = fringe.receiveShadow = true;
  g.add(fringe);

  // 처마 눌림대(새끼로 도리에 눌러 맨 가로 새끼) — 단면 립 위에 얹혀 이엉을 누름. 얇게(커튼 봉 읽힘 방지).
  const bpts = [];
  for (let i = 0; i < NL; i++) bpts.push(edge[i].clone().addScaledVector(down[i], faceLen * 0.32));
  const batten = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bpts, true), 220, thick * 0.13, 6, true), M.jipjul);
  batten.castShadow = batten.receiveShadow = true;
  g.add(batten);

  // ── 집줄(새끼 그물): 내리방향(경사) 새끼가 지배, 가로 링이 성글게 교차 ──
  // 지붕면 위 살짝 띄운 얇은 튜브를 한 BufferGeometry로 병합(드로우콜 최소).
  const netPos = [], netIdx = [];
  const RAD_D = 6, RAD_R = 5; // 튜브 원주 세그
  const addTube = (samplesAB, radius, lift) => {
    const cpts = samplesAB.map(([a, b]) => {
      const [x, z] = planXZ(a, b);
      return new THREE.Vector3(x, heightAB(a, b) + lift, z);
    });
    const curve = new THREE.CatmullRomCurve3(cpts);
    const seg = Math.max(8, cpts.length * 2);
    const tg = new THREE.TubeGeometry(curve, seg, radius, RAD_D, false);
    const base = netPos.length / 3;
    const pArr = tg.attributes.position.array;
    for (let k = 0; k < pArr.length; k++) netPos.push(pArr[k]);
    const iArr = tg.index.array;
    for (let k = 0; k < iArr.length; k++) netIdx.push(iArr[k] + base);
  };
  // 내리방향 새끼: a=const 선(뒤처마→용마루→앞처마로 넘어감). 촘촘.
  const nDown = 26;
  for (let j = 1; j < nDown; j++) {
    const a = -1 + 2 * (j / nDown);
    const line = [];
    const NS = 20;
    for (let k = 0; k <= NS; k++) line.push([a, -1 + 2 * (k / NS)]);
    addTube(line, 0.017, 0.028);
  }
  // 가로 링: 처마→용마루 사이 s배율로 안쪽으로 줄인 초승형 등고 링(성글게 3줄).
  for (const s of [0.62, 0.80, 0.93]) {
    const ring = [];
    const NR = 64;
    for (let k = 0; k <= NR; k++) {
      const th = (k / NR) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      const aB = Math.sign(c) * Math.pow(Math.abs(c), 2 / ne);
      const bB = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / ne);
      ring.push([aB * s, bB * s]);
    }
    addTube(ring, 0.02, 0.03);
  }
  const netGeo = new THREE.BufferGeometry();
  netGeo.setAttribute('position', new THREE.Float32BufferAttribute(netPos, 3));
  netGeo.setIndex(netIdx);
  netGeo.computeVertexNormals();
  const net = new THREE.Mesh(netGeo, M.jipjul);
  net.castShadow = true;
  g.add(net);

  // ── 용마름(엮은 볏짚 마루 덮개) — 능선에 도톰하게 얹혀 실루엣 위로 살짝 솟음 ──
  const rollR = thick * 0.72;
  const rollLen = 2 * ridgeHalfX + rollR;
  const yMat = M.yongmaru.clone();
  yMat.map = M.yongmaru.map.clone();
  yMat.map.repeat.set(1, Math.max(4, Math.round(rollLen / 0.45))); // v=길이 방향 엮음 층 수
  yMat.map.needsUpdate = true;
  const rollPts = [];
  const RN = 12;
  for (let i = 0; i <= RN; i++) {
    const t = i / RN;
    const x = -ridgeHalfX + 2 * ridgeHalfX * t;
    const along = Math.max(0, 1 - Math.pow(Math.abs(x) / Math.max(0.01, ridgeHalfX), 2));
    rollPts.push(new THREE.Vector3(x, ridgeY + rollR * 0.34 - ridgeSag * along, 0));
  }
  const ridgeRoll = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rollPts), RN * 2, rollR * 0.92, 14), yMat);
  ridgeRoll.scale.y = 0.72;             // 살짝 눌린 단면(완전 원통 아님)
  ridgeRoll.castShadow = ridgeRoll.receiveShadow = true;
  g.add(ridgeRoll);
  // 용마름 양끝 마구리(엮여 오므린 볏짚 뭉치 — 낮고 넓게, 공처럼 튀지 않게)
  for (const sx of [1, -1]) {
    const end = new THREE.Mesh(new THREE.SphereGeometry(rollR * 0.72, 12, 8), yMat);
    end.scale.set(0.85, 0.5, 0.82);
    end.position.set(sx * (ridgeHalfX - 0.04), ridgeY + rollR * 0.20, 0);
    end.castShadow = true;
    g.add(end);
  }

  // 조립 애니: 초가 지붕(이엉+집줄 그물+용마름)은 통째로 한 덩어리로 오른다(태그 없이 전부 body).
  g.userData.asmChunked = true;
  return g;
}

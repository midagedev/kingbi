import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE_LOOK } from '../builder/material-colors.js';
import { tileSurfaceMaterial, sugiwaMaterial } from '../builder/palette.js';
import {
  ROOF_MARU_SURFACE_CLEAR,
  ROOF_SHELL_THICKNESS,
} from '../core/surface-clearance.js';
import { resampleChainPreservingKnots } from './chain-sampling.js';
import { giwaRoofEnvelope } from './giwa-roof-envelope.js';
import { addRoofTileShell } from './roof-shell.js';

// 기와 세계좌표 켜 간격(m). 실물은 한 켜에 암키와 1장 + 수키와 1장이므로
// 면 UV across 와 수키와 롤 배치가 같은 피치를 써야 물매를 따라 위상이 어긋나지 않는다.
// (authored 제품 상수 — AURI 해설이 이 수치를 주지는 않는다. docs/architectural-authenticity §2.3)
export const GIWA_ACROSS_PITCH = 0.34;
// 물매 방향 겹침 켜 간격(m). 면 UV v · 수키와 롤 텍스처 길이 방향에 공유.
export const GIWA_ALONG_PITCH = 0.9;

// 다각형 풋프린트 + straight skeleton → 곡면 기와지붕.
// rect / ㄱ자(L) / ㄷ자(U) 지원. skeleton 의 ridge/valley/hip 라인을 마루로 얹고,
// 각 face 를 처마(밑변)→마루로 로프트한 곡면으로 세운다.
//   - 물매(profileCurve): 처마로 갈수록 완만해지는 오목 프로파일
//   - 앙곡(cornerLift): 볼록 코너(추녀)에서 처마 끝이 위로 들림
//   - 안허리곡(planCurve): 볼록 코너에서 처마가 밖으로 더 내밈
//
// footprint: 기둥열(벽선) 2D 다각형 [{x,z}...]. 처마는 eaveOverhang 만큼 밖으로.
// opts: { eaveY, eaveOverhang, riseScale, profileCurve, cornerLift, planCurve,
//         ridgeH, mats, tileBump }
// 반환: THREE.Group (원점 = footprint 좌표계, y=eaveY 가 처마).
export function buildSkeletonRoof(footprint, opts = {}) {
  const {
    eaveY = 0, eaveOverhang = 1.4, riseScale = 0.8,
    profileCurve = 0.5, cornerLift = 0.5, planCurve = 0.35,
    ridgeH = 0.4, mats, tileBump = TILE_LOOK.bumpSurface,
    // 기와집 격상 옵션(기본 off → 정자·기타 스켈레톤 지붕은 영향 없음).
    // sugiwaRolls: 수키와 볼록 롤 3D 지오메트리, rafters: 처마 밑 연목·부연,
    // junctionCaps: ㄱ/ㄷ자 마루 접합부 solid 회첨 캡.
    sugiwaRolls = false, rafters = false, junctionCaps = false,
    // heroDetail(#139): 히어로 종가 전용 근접 격상 — 처마 끝 막새(와구토) 열 +
    //   적새 겹쌓은 용마루/숫마루장 + 망와 마루끝. 신규 메시(마을 인스턴스 드로우콜 침해)라
    //   반드시 opt-in: buildHanok(히어로) 만 켠다. giwa.js(마을) 는 미설정 → 콜·재질 불변.
    heroDetail = false,
  } = opts;
  const M = mats;
  const g = new THREE.Group();
  g.name = 'skeleton-roof';

  const envelope = giwaRoofEnvelope(footprint, {
    eaveY,
    eaveOverhang,
    riseScale,
    cornerLift,
    planCurve,
    ridgeH,
  });
  const sk = envelope.skeleton;
  const poly = sk.poly;
  const n = poly.length;

  const yOf = (h) => eaveY + h * riseScale;

  // ── 처마 다각형(마이터 오프셋) + 코너별 앙곡·안허리곡 ──
  // eaveVertex[i] = poly[i] + (outward_prev + outward_cur) * overhang (+ 볼록 코너 안허리곡)
  const eaveV = envelope.footprint;
  const eaveLift = envelope.eaveLifts;

  const NU = 14, NV = 8;
  const fprofile = (v) => Math.pow(v, 1 + profileCurve);      // 높이 분율(오목)
  const smooth = (t) => t * t * (3 - 2 * t);

  let maxSlopeLen = 3.5;
  // 기와집 격상 어휘 누적기(옵션 켜졌을 때만 채워진다).
  const rollGeoms = [];                 // 수키와 볼록 롤(면별 튜브 → 병합)
  const rafterRound = [], rafterSquare = []; // 연목(원)·부연(각) InstancedMesh 대상
  const capTips = [];                   // 수키와 롤 끝(수막새) 위치
  const dripTips = [];                  // 기왓골(암키와) 끝(암막새) 위치 — heroDetail 처마 끝 리듬

  // ── face 별 곡면 ──
  for (const face of sk.faces) {
    if (face.polygon.length < 3) continue;
    const ei = face.edgeIndex;
    const A = poly[ei], B = poly[(ei + 1) % n];
    const Ae = eaveV[ei], Be = eaveV[(ei + 1) % n];
    const liftA = eaveLift[ei], liftB = eaveLift[(ei + 1) % n];

    // 상단 체인: h>0 정점을 A→B 방향으로 정렬
    const dir = norm(sub(B, A));
    const upper = face.polygon.filter((p) => p.h > 1e-4)
      .map((p) => ({ ...p, t: dot(sub(p, A), dir) }))
      .sort((a, b) => a.t - b.t);
    if (upper.length === 0) continue;
    // 체인 양 끝을 처마 파라미터에 맞춰 확장(삼각 face 는 정점 1개 → 양쪽 동일)
    const chain = upper.length === 1 ? [upper[0], upper[0]] : upper;

    // 처마선 리샘플(직선 Ae→Be), 상단 체인 리샘플(호길이)
    const eavePts = resampleLine(Ae, Be, NU);
    const eaveLifts = resampleScalarEnds(liftA, liftB, NU);
    const upPts = resampleChainPreservingKnots(chain, NU);

    const pos = [], uv = [], idx = [];
    const width = dist(Ae, Be);

    // ── 기와 좌표계: across = "처마 방향 투영 거리"(파라미터가 아니라 세계좌표) ──
    // 한식기와의 기왓골은 처마에 수직으로 곧게 오르고 골 간격은 물매 전체에서 일정하다.
    // 그런데 skeleton face 는 회첨(반사 끝)에서 마루로 갈수록 넓어지고 추녀(볼록 끝)에서 좁아지므로,
    // 로프트의 iso-파라미터 열(iu/NU)은 물리적으로 평행하지 않다 — ㄷ자 가운데 면은 처마선이
    // 3.20m·상단 체인 투영이 9.00m 라, 등파라미터 열의 실제 간격이 처마로 갈수록 3.2배 수렴한다
    // (= 기와가 아래로 흐를수록 좁아지는 고증 오류). 반대로 우진각 앞면은 마루로 5.6배 수렴한다.
    // 그래서 across 를 파라미터에서 떼어내 처마 방향 투영으로 잡는다: face 가 어떻게 부채꼴이 되든
    // 세계좌표 간격이 상수로 유지되고, 골은 추녀·회첨에서 "잘려" 끝난다(실제 기와 잇기 규칙).
    // 물매(v) 도 동일하게 세계좌표: 로프트 열마다 처마→마루 3D 호길이를 먼저 적분해 두고
    // UV.v = 마루로부터의 호길이 / GIWA_ALONG_PITCH. slopeLen 을 iu 루프 안에서 running-max 로
    // 소비하면 같은 면의 열마다 켜 간격이 ~30% 흔들린다.
    const eDir = width > 1e-6
      ? { x: (Be.x - Ae.x) / width, z: (Be.z - Ae.z) / width }
      : { x: 1, z: 0 };
    const acrossOf = (px, pz) => (px - Ae.x) * eDir.x + (pz - Ae.z) * eDir.z;

    // 1st pass: 열별 호길이(arc from eave) + face slope 최댓값.
    const colArc = []; // colArc[iu][iv] = 처마→해당 v 의 3D 호길이
    let faceSlopeLen = 0;
    for (let iu = 0; iu <= NU; iu++) {
      const e = eavePts[iu], u = upPts[iu];
      const eY = eaveY + eaveLifts[iu];
      const uY = yOf(u.h);
      const arcs = new Float64Array(NV + 1);
      let px = e.x, py = eY, pz = e.z;
      for (let iv = 1; iv <= NV; iv++) {
        const v = iv / NV;
        const qx = e.x + (u.x - e.x) * v;
        const qz = e.z + (u.z - e.z) * v;
        const qy = eY + (uY - eY) * fprofile(v);
        arcs[iv] = arcs[iv - 1] + Math.hypot(qx - px, qy - py, qz - pz);
        px = qx; py = qy; pz = qz;
      }
      colArc[iu] = arcs;
      faceSlopeLen = Math.max(faceSlopeLen, arcs[NV]);
    }
    maxSlopeLen = Math.max(maxSlopeLen, faceSlopeLen);

    // 2nd pass: 정점 + UV (across·arc 모두 세계 미터 / 켜 간격).
    for (let iu = 0; iu <= NU; iu++) {
      const e = eavePts[iu], u = upPts[iu];
      const eY = eaveY + eaveLifts[iu];
      const uY = yOf(u.h);
      const arcs = colArc[iu];
      const colLen = arcs[NV];
      for (let iv = 0; iv <= NV; iv++) {
        const v = iv / NV;
        // 평면 위치: 처마→마루 선형, 단 앙곡/안허리곡은 낮은 v 에서만 살아있게 감쇠
        const px = e.x + (u.x - e.x) * v;
        const pz = e.z + (u.z - e.z) * v;
        const py = eY + (uY - eY) * fprofile(v);
        pos.push(px, py, pz);
        // u: 세계좌표 across / 피치 → 기왓골이 평행·등간격.
        // v: 마루로부터의 호길이 / 피치 → 물매 켜 간격이 열마다 흔들리지 않음.
        const arcFromRidge = colLen - arcs[iv];
        uv.push(acrossOf(px, pz) / GIWA_ACROSS_PITCH, arcFromRidge / GIWA_ALONG_PITCH);
      }
    }
    for (let iu = 0; iu < NU; iu++) for (let iv = 0; iv < NV; iv++) {
      const a = iu * (NV + 1) + iv, b = a + 1, c = a + (NV + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = tileSurfaceMaterial(M, Math.max(2, width), Math.max(1.5, faceSlopeLen), tileBump);
    // 이 지붕면 UV는 이미 기와 반복수를 구워 넣음(across/피치, arc/피치) — 재질 repeat까지
    // 곱하면 밀도 제곱으로 무늬가 서브픽셀로 뭉개져 민무늬로 보임(히어로 종가 기와 무늬 실종의 원인).
    mat.map.repeat.set(1, 1);
    // Outer tile + structural 개판 underside (docs/ceiling.md). Not room 반자.
    // Zero-thickness DoubleSide co-owned one plane and z-fought under the eave.
    const underMat = M.eaveBand.clone();
    underMat.side = THREE.FrontSide;
    addRoofTileShell(g, geo, mat, underMat, ROOF_SHELL_THICKNESS);

    // 처마 단면 띠(연함·기와 마구리 두께) — 외피 상단에서 개판 하면까지 물리 두께.
    // Bottom sits 1cm past the gaepan plane so the lip edge is not coplanar with the
    // underside (shared eaveBand material made that read as ceiling static).
    const bandPos = [], bandIdx = [];
    const shellT = ROOF_SHELL_THICKNESS;
    const bandPast = 0.01;
    for (let iu = 0; iu <= NU; iu++) {
      const e = eavePts[iu]; const eY = eaveY + eaveLifts[iu];
      // 처마 끝을 상단 반대 방향으로 약간 더(안허리곡 살린 실제 처마 끝)
      bandPos.push(e.x, eY + 0.03, e.z, e.x, eY - shellT - bandPast, e.z);
    }
    for (let iu = 0; iu < NU; iu++) {
      const a = iu * 2, b = a + 1, c = a + 2, d = a + 3;
      bandIdx.push(a, b, c, c, b, d);
    }
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute('position', new THREE.Float32BufferAttribute(bandPos, 3));
    bgeo.setIndex(bandIdx);
    bgeo.computeVertexNormals();
    const band = new THREE.Mesh(bgeo, M.eaveBand.clone());
    band.name = 'roof-eave-band';
    band.userData.asmGroup = 'body';
    band.material.side = THREE.FrontSide;
    band.castShadow = true;
    g.add(band);

    // ── 기와집 격상: 이 face 곡면 위의 수키와 롤 + 처마 밑 서까래 ──
    if (sugiwaRolls || rafters) {
      // 곡면 점 P(s,v): 표면 그리드와 동일 공식(s=폭 0..1, v=처마0..마루1).
      const pointAt = (s, v) => {
        const ex = Ae.x + (Be.x - Ae.x) * s;
        const ez = Ae.z + (Be.z - Ae.z) * s;
        const ends = Math.pow(Math.abs(2 * s - 1), 4.5);
        const eY = eaveY + (s < 0.5 ? liftA : liftB) * ends;
        const U = interpArr(upPts, s);
        const uY = yOf(U.h);
        return new THREE.Vector3(
          ex + (U.x - ex) * v,
          eY + (uY - eY) * fprofile(v),
          ez + (U.z - ez) * v);
      };
      // 곡면 바깥 법선(위로 향하게).
      const normalAt = (s, v) => {
        const eps = 0.02;
        const dv = pointAt(s, Math.min(1, v + eps)).sub(pointAt(s, Math.max(0.001, v - eps)));
        const ds = pointAt(Math.min(1, s + eps), v).sub(pointAt(Math.max(0, s - eps), v));
        const nrm3 = new THREE.Vector3().crossVectors(dv, ds).normalize();
        if (nrm3.y < 0) nrm3.negate();
        return nrm3;
      };

      if (sugiwaRolls) {
        // 상단 체인의 across 투영. upper 는 A→B 방향 t 로 정렬돼 있고 eDir ∥ dir 이므로
        // projUp 은 단조 증가하며, across(k,v) = (1-v)·(k/NU)·width + v·projUp[k] 도 k 에 대해 단조다
        // (단조 두 수열의 볼록결합) → 역함수를 구간 스캔으로 정확히 풀 수 있다.
        const projUp = upPts.map((p) => acrossOf(p.x, p.z));
        const acrossNode = (k, v) => (1 - v) * (k / NU) * width + v * projUp[k];
        // across = a 인 파라미터 s. 면 밖이면 경계(s=0=추녀/회첨선, s=1)로 클램프된다.
        const solveS = (a, v) => {
          for (let k = 0; k < NU; k++) {
            const lo = acrossNode(k, v), hi = acrossNode(k + 1, v);
            if (a <= hi || k === NU - 1) {
              const span = hi - lo;
              const t = span > 1e-9 ? Math.min(1, Math.max(0, (a - lo) / span)) : 0;
              return (k + t) / NU;
            }
          }
          return 1;
        };
        // 골 격자는 처마선과 상단 체인 투영의 합집합을 덮는다(회첨 쪽은 처마보다 넓다).
        // 암키와 UV across 피치와 동일 — 물매를 따라 골·롤 위상이 어긋나지 않는다.
        const p0a = projUp[0], p1a = projUp[NU];
        const aMin = Math.min(0, p0a), aMax = Math.max(width, p1a);
        const aSpan = Math.max(0.3, aMax - aMin);
        const nRolls = Math.max(2, Math.round(aSpan / GIWA_ACROSS_PITCH));
        const pitch = aSpan / nRolls;
        const rollR = 0.052, KV = 9, V0 = 0.02;
        const dR = p1a - width;
        for (let j = 0; j < nRolls; j++) {
          const a = aMin + (j + 0.5) * pitch;
          // 이 골이 면 안에 실재하는 v 구간. 좌·우 경계의 across 는 v 에 대해 선형이라 해석해가 있다.
          //   볼록(추녀) 끝 → 위로 좁아져 마루 전에 잘린다.  반사(회첨) 끝 → 아래로 좁아져
          //   처마가 아니라 회첨골 중간에서 시작한다. 둘 다 실제 기와 잇기의 절단 규칙이다.
          let vLo = 0, vHi = 1;
          if (p0a > 1e-6) vHi = Math.min(vHi, a / p0a);
          else if (p0a < -1e-6 && a < 0) vLo = Math.max(vLo, a / p0a);
          if (dR < -1e-6) vHi = Math.min(vHi, (width - a) / -dR);
          else if (dR > 1e-6 && a > width) vLo = Math.max(vLo, (a - width) / dR);
          const fromEave = vLo <= V0;
          if (!fromEave && vHi <= vLo + 1e-3) continue;   // 추녀와 회첨 사이에 실체가 없는 골
          const vA = Math.max(V0, vLo);
          // 최소 구간: 추녀 바로 옆의 얇은 조각도 마루 튜브(r=0.1) 안에 묻히는 길이는 남긴다.
          const vB = Math.max(vA + 0.012, Math.min(1, vHi));
          const pts = [];
          for (let iv = 0; iv <= KV; iv++) {
            const v = vA + (vB - vA) * (iv / KV);
            const s = solveS(a, v);
            // Ride fully outside the outer tile (was 0.72r → 28% radius embed → z-fight).
            pts.push(pointAt(s, v).addScaledVector(normalAt(s, v), rollR + ROOF_MARU_SURFACE_CLEAR));
          }
          if (fromEave) {
            // 처마 끝: v=V0 접선 방향으로 처마 밖으로 살짝 내밀어 둥근 마구리 확보.
            const sE = solveS(a, V0), sI = solveS(a, 0.09);
            const e0 = pointAt(sE, V0), e1 = pointAt(sI, 0.09);
            const tipDir = e0.clone().sub(e1).normalize();
            const n0 = normalAt(sE, V0);
            const tip = e0.clone().addScaledVector(tipDir, 0.12)
              .addScaledVector(n0, rollR + ROOF_MARU_SURFACE_CLEAR);
            pts.unshift(tip);
            capTips.push({ p: tip, dir: tipDir, n: n0 });
          }
          const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), KV + 2, rollR, 6, false);
          rollGeoms.push(tube);
        }
        // heroDetail: 롤 사이 기왓골(암키와) 끝에 암막새 자리 — 수막새와 교대로 처마 끝 리듬 완성.
        //   처마선에 닿지 않는 골(회첨에서 시작)은 처마 끝이 없으므로 암막새도 없다.
        if (heroDetail) {
          for (let j = 1; j < nRolls; j++) {
            const a = aMin + j * pitch;
            if (a <= 0 || a >= width) continue;
            const sE = solveS(a, V0), sI = solveS(a, 0.09);
            const q0 = pointAt(sE, V0), q1 = pointAt(sI, 0.09);
            const dv = q0.clone().sub(q1).normalize();
            const t = q0.clone().addScaledVector(dv, 0.09); t.y -= 0.035;   // 골이라 살짝 낮게
            dripTips.push({ p: t, dir: dv });
          }
        }
      }

      if (rafters) {
        // 연목(아래 열)·부연(위 열): 처마 밑에서 밖으로 방사. 코너 근처는 선자연이 덮음.
        // Sit below the structural gaepan along the surface normal (pure −Y was too
        // shallow on steep tiles and z-fought the under-eave ceiling read).
        const clear = ROOF_SHELL_THICKNESS + 0.10;
        const nR = Math.max(6, Math.round(width / 0.42));
        for (let j = 0; j <= nR; j++) {
          const s = j / nR;
          if (Math.abs(2 * s - 1) > 0.88) continue;
          // 연목: 처마 안쪽(v≈0.32) 밑 → 처마 밖으로 내민 끝
          const nIn = normalAt(s, 0.32);
          const inner = pointAt(s, 0.32).addScaledVector(nIn, -(0.22 + clear));
          const edge = pointAt(s, 0.02);
          const dir = edge.clone().sub(pointAt(s, 0.12)).normalize();
          const nEd = normalAt(s, 0.02);
          const tip = edge.clone().addScaledVector(dir, 0.14).addScaledVector(nEd, -(0.14 + clear));
          rafterRound.push({ from: inner, to: tip });
          // 부연(위 열, 겹처마): 연목보다 얕게·바깥으로 더 — still under gaepan
          const nBi = normalAt(s, 0.16);
          const bi = pointAt(s, 0.16).addScaledVector(nBi, -(0.08 + clear));
          const bt = edge.clone().addScaledVector(dir, 0.30).addScaledVector(nEd, -(0.06 + clear));
          rafterSquare.push({ from: bi, to: bt });
        }
      }
    }
  }

  // ── 기와집 격상: 수키와 롤 병합 + 처마 밑 서까래 인스턴싱 ──
  // 회첨골 기와 줄(#223)이 같은 재질 계열을 재사용할 수 있게 호이스팅.
  let roofSugiwaMat = null;
  if (rollGeoms.length) {
    const merged = mergeGeometries(rollGeoms, false);
    rollGeoms.forEach((geo) => geo.dispose());
    // 단색 재질 대신 튜브 경사 길이에 비례해 기와 무늬가 흘러내리는 전용 텍스처 재질 적용
    roofSugiwaMat = sugiwaMaterial(M, maxSlopeLen, TILE_LOOK.bumpSugiwa);
    const rolls = new THREE.Mesh(merged, roofSugiwaMat);
    rolls.castShadow = true; rolls.receiveShadow = false;
    rolls.name = 'sugiwa-rolls';
    g.add(rolls);
    // 수키와 롤 끝 둥근 마구리(처마 끝 원형 단면)
    if (capTips.length) {
      const capGeo = new THREE.SphereGeometry(0.052, 8, 6);
      const caps = new THREE.InstancedMesh(capGeo, roofSugiwaMat, capTips.length);
      const m4 = new THREE.Matrix4();
      capTips.forEach((c, i) => { m4.makeTranslation(c.p.x, c.p.y, c.p.z); caps.setMatrixAt(i, m4); });
      caps.instanceMatrix.needsUpdate = true;
      caps.castShadow = true; caps.name = 'sugiwa-caps';
      g.add(caps);
    }
    // ── heroDetail: 처마 끝 막새(와구토) 열 — 수키와 롤 끝(capTips)마다 흰 회물림 반원. ──
    //   실사 한식기와의 상징 디테일(부석사·근정전 처마 끝 구슬 열). 어두운 지붕에 밝은 회(灰)
    //   원판이 리듬 있게 박혀 근접에서 "찍어낸 톤"을 깬다. 원판 축 = 처마 밖 방향(tipDir).
    if (heroDetail && capTips.length) {
      const wGeo = new THREE.CylinderGeometry(0.078, 0.078, 0.06, 12);
      const wag = new THREE.InstancedMesh(wGeo, M.waguto, capTips.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
      capTips.forEach((c, i) => {
        d.copy(c.dir).normalize(); q.setFromUnitVectors(up, d);
        pos.copy(c.p).addScaledVector(d, 0.02);
        m4.compose(pos, q, one); wag.setMatrixAt(i, m4);
      });
      wag.instanceMatrix.needsUpdate = true;
      wag.castShadow = true; wag.name = 'wadang-row'; wag.userData.asmGroup = 'body';
      g.add(wag);
    }
    // ── heroDetail: 암막새 열 — 수막새(밝은 회) 사이 기왓골 끝에 어두운 드림판. ──
    //   밝은 수막새·어두운 암막새가 교대로 박혀 처마 끝이 톱니처럼 촘촘히 읽힌다(실사 리듬).
    if (heroDetail && dripTips.length) {
      const dGeo = new THREE.CylinderGeometry(0.055, 0.05, 0.05, 10);
      const drp = new THREE.InstancedMesh(dGeo, M.tileRidge, dripTips.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
      dripTips.forEach((c, i) => {
        d.copy(c.dir).normalize(); q.setFromUnitVectors(up, d);
        pos.copy(c.p).addScaledVector(d, 0.015);
        m4.compose(pos, q, one); drp.setMatrixAt(i, m4);
      });
      drp.instanceMatrix.needsUpdate = true;
      drp.castShadow = true; drp.name = 'ammaksae-row'; drp.userData.asmGroup = 'body';
      g.add(drp);
    }
  }
  const placeRafters = (list, geo, mat) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
    list.forEach((it, i) => {
      dir.copy(it.to).sub(it.from);
      const len = dir.length() || 1e-3;
      qt.setFromUnitVectors(up, dir.normalize());
      m4.compose(it.from, qt, new THREE.Vector3(1, len, 1));
      im.setMatrixAt(i, m4);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = false;
    im.userData.asmGroup = 'rafters';   // 조립 애니: 서까래는 지붕 통덩어리 직전 청크(rafters 옵션=기와집 전용)
    im.userData.roofLayer = 'rafter';
    g.add(im);
  };
  if (rafterRound.length || rafterSquare.length) {
    // 백골 목재 톤(반가): 처마 밑이 검게 후퇴하지 않도록 미량 emissive.
    const rmat = M.wood.clone(); rmat.emissive = new THREE.Color(0x241d12);
    const rGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 8); rGeo.translate(0, 0.5, 0);
    const bGeo = new THREE.BoxGeometry(0.075, 1, 0.075); bGeo.translate(0, 0.5, 0);
    placeRafters(rafterRound, rGeo, rmat);
    placeRafters(rafterSquare, bGeo, rmat);
  }

  // ── 마루(마루선) ──
  const tube = (a, b, r, mat) => {
    const va = new THREE.Vector3(a.x, a.y, a.z), vb = new THREE.Vector3(b.x, b.y, b.z);
    const len = va.distanceTo(vb);
    const geo = new THREE.CylinderGeometry(r, r, len, 8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(va).lerp(vb, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    mesh.castShadow = true;
    return mesh;
  };
  const p3 = (p, dy = 0) => ({ x: p.x, y: yOf(p.h) + dy, z: p.z });

  // 용마루: 각형 큰 마루
  const ZAX = new THREE.Vector3(0, 0, 1), YAX = new THREE.Vector3(0, 1, 0);
  for (const s of sk.ridges) {
    const a = p3(s.a, ridgeH * 0.5), b = p3(s.b, ridgeH * 0.5);
    const va = new THREE.Vector3(a.x, a.y, a.z), vb = new THREE.Vector3(b.x, b.y, b.z);
    const len = va.distanceTo(vb);
    const axis = vb.clone().sub(va).normalize();
    const mid = va.clone().lerp(vb, 0.5);
    const surfMid = mid.y - ridgeH * 0.5;   // 지붕면 마루선 y(p3 가 +ridgeH*0.5 올린 값 복원)
    if (heroDetail) {
      // ── 적새(겹쌓은 암키와) 몸통 + 숫마루장(둥근 상단) + 망와(마루끝 와당) ──
      const bodyH = ridgeH * 1.55;
      // 적새 켜(가로 줄)가 길이·높이에 맞춰 촘촘히 읽히도록 jeoksae 클론에 repeat 지정(공유재질 불침해).
      const jmat = M.jeoksae.clone();
      jmat.map = M.jeoksae.map.clone();
      jmat.map.wrapS = jmat.map.wrapT = THREE.RepeatWrapping;
      jmat.map.repeat.set(Math.max(1, Math.round(len / 0.9)), Math.max(3, Math.round(bodyH / 0.11)));
      jmat.map.needsUpdate = true;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, bodyH, len), jmat);
      // Seat above the outer tile — coplanar bottom face on the shell z-fights.
      body.position.copy(mid); body.position.y = surfMid + bodyH * 0.5 + ROOF_MARU_SURFACE_CLEAR;
      body.quaternion.setFromUnitVectors(ZAX, axis);
      body.castShadow = body.receiveShadow = true; body.userData.asmGroup = 'finial';
      g.add(body);
      // 숫마루장: 마루 위 둥근 수키와 마루(반원통 상단 캡)
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, len, 12), M.tileRidge);
      cap.position.copy(mid); cap.position.y = surfMid + bodyH + ROOF_MARU_SURFACE_CLEAR;
      cap.quaternion.setFromUnitVectors(YAX, axis);
      cap.castShadow = true; cap.userData.asmGroup = 'finial';
      g.add(cap);
      // 망와: 용마루 양 끝 상향 와당(반가 — 취두/치미 아님)
      for (const end of [va, vb]) {
        const outw = (end === va ? va : vb).clone().sub(mid).normalize();
        const mw = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.07, 14), M.wadang);
        mw.position.copy(end).addScaledVector(outw, 0.03);
        mw.position.y = surfMid + bodyH * 0.7 + ROOF_MARU_SURFACE_CLEAR;
        mw.quaternion.setFromUnitVectors(YAX, outw);
        mw.rotateX(-0.35);   // 끝을 살짝 위로 세운 바래기(망와) 느낌
        mw.castShadow = true; mw.userData.asmGroup = 'finial';
        g.add(mw);
      }
    } else {
      // 각진 용마루(BoxGeometry 로 단면 두껍게) — 마을 giwa 기존 경로(콜 불변).
      // Bottom face must clear the outer tile (mid is surface + ridgeH/2).
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, ridgeH, len), M.tileRidge);
      box.position.copy(mid);
      box.position.y += ROOF_MARU_SURFACE_CLEAR;
      box.quaternion.setFromUnitVectors(ZAX, axis);
      box.castShadow = true;
      g.add(box);
    }
  }
  // Surface point on the hip/valley path (no ornament offset).
  const pathSurf = (top, botPlan, botY, v) => {
    const x = botPlan.x + (top.x - botPlan.x) * v;
    const z = botPlan.z + (top.z - botPlan.z) * v;
    const y = botY + (yOf(top.h) - botY) * fprofile(v);
    return new THREE.Vector3(x, y, z);
  };
  // Unit exterior normal ≈ ∂p/∂v × horizontal cross-slope, forced up-facing.
  // Pure +Y lift under-offsets on steep tiles and still pierces the shell.
  const pathNormal = (top, botPlan, botY, v) => {
    const eps = 0.03;
    const a = pathSurf(top, botPlan, botY, Math.max(0, v - eps));
    const b = pathSurf(top, botPlan, botY, Math.min(1, v + eps));
    const along = b.clone().sub(a);
    if (along.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0);
    along.normalize();
    // Prefer a plan-horizontal cross direction from the path's xz run.
    const runX = top.x - botPlan.x;
    const runZ = top.z - botPlan.z;
    let cross = new THREE.Vector3(-runZ, 0, runX);
    if (cross.lengthSq() < 1e-12) cross.set(1, 0, 0);
    cross.normalize();
    const n = new THREE.Vector3().crossVectors(along, cross);
    if (n.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0);
    n.normalize();
    if (n.y < 0) n.negate();
    return n;
  };
  // 오목 곡면을 따라 마루선을 휘게 하는 곡선 튜브.
  // Centreline = surface + n̂ · (r + clear) so the whole tube clears the outer tile.
  const curvedTube = (top, botPlan, botY, r, name) => {
    const clear = r + ROOF_MARU_SURFACE_CLEAR;
    const pts = [];
    const K = 10;
    for (let i = 0; i <= K; i++) {
      const v = i / K; // 0=처마, 1=절점
      const p = pathSurf(top, botPlan, botY, v);
      p.addScaledVector(pathNormal(top, botPlan, botY, v), clear);
      pts.push(p);
    }
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), K, r, 8), M.tileRidge);
    mesh.castShadow = true;
    if (name) mesh.name = name;
    // 게이트·디버그용: 처마쪽 끝(계획 좌표). TubeGeometry 중심선 복원 대신 계약 끝점을 고정.
    mesh.userData.botPlan = { x: botPlan.x, z: botPlan.z };
    mesh.userData.topPlan = { x: top.x, z: top.z };
    mesh.userData.maruClear = clear;
    return mesh;
  };
  // 내림·추녀마루(hip): 절점 → 처마 코너(앙곡 반영)로 오목하게 내려감.
  for (const s of sk.hips) {
    const hi = s.a.h >= s.b.h ? s.a : s.b;
    const lo = s.a.h >= s.b.h ? s.b : s.a;
    const ci = poly.findIndex((v) => Math.abs(v.x - lo.x) < 1e-3 && Math.abs(v.z - lo.z) < 1e-3);
    const botPlan = ci >= 0 ? eaveV[ci] : lo;
    const botY = eaveY + (ci >= 0 ? eaveLift[ci] : 0);
    // heroDetail: 내림·추녀마루를 굵게(적새 톤) — 근접에서 마루선이 실하게 보이게
    const hipR = heroDetail ? 0.13 : 0.1;
    g.add(curvedTube(hi, botPlan, botY, hipR, 'hip-maru'));
  }
  // 회첨(valley): 반사 코너 → 처마 코너(eaveV, 추녀와 같은 계약). 벽 코너(poly)를 쓰면
  // ㄷ자 오목 코너에서 처마 overhang 만큼(~2m) 짧아져 면 끝·수키와 절단선과 어긋난다.
  // #223: sugiwaRolls(giwa FULL) 에서는 회첨골을 면 수키와와 같은 켜 간격의 기와 줄로 읽힌다.
  //   경로·botPlan 은 #171 그대로. 드로우 1/골 유지, 재질 계열은 sugiwa(신규 프로그램 없음).
  //   UV.x 에 호길이/GIWA_ALONG_PITCH 를 구워 넣어 builder/giwa.js 의 map.repeat=(1,1)
  //   후처리 뒤에도 물매 켜가 0.9m 로 남는다(면 UV 와 같은 베이크 계약).
  //   면 롤 병합 메시에는 넣지 않는다 — across 피치 게이트가 회첨 방향을 면 롤로 오인한다.
  let valleyCourseMat = null;
  for (const s of sk.valleys) {
    const hi = s.a.h >= s.b.h ? s.a : s.b;
    const lo = s.a.h >= s.b.h ? s.b : s.a;
    const ci = poly.findIndex((v) => Math.abs(v.x - lo.x) < 1e-3 && Math.abs(v.z - lo.z) < 1e-3);
    const botPlan = ci >= 0 ? eaveV[ci] : lo;
    const botY = eaveY + (ci >= 0 ? eaveLift[ci] : 0) + 0.05;
    if (sugiwaRolls) {
      if (!valleyCourseMat) {
        valleyCourseMat = makeValleyCourseMaterial(M, roofSugiwaMat, maxSlopeLen);
      }
      g.add(buildValleyTileCourse(hi, botPlan, botY, yOf, fprofile, valleyCourseMat));
    } else {
      g.add(curvedTube(hi, botPlan, botY, 0.085, 'valley-maru'));
    }
  }

  // ── ㄱ/ㄷ자 마루 접합부 solid 캡 ──
  // 두 용마루가 만나는 절점에서 상단이 열려 하늘이 비치던 삼각 공극을,
  // 마루 방향 사이(회첨이 열린 안쪽)를 채우는 solid 회첨 봉으로 봉합한다.
  if (junctionCaps) {
    const rkey = (p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
    const junc = new Map();
    for (const s of sk.ridges) for (const [p, o] of [[s.a, s.b], [s.b, s.a]]) {
      const k = rkey(p);
      if (!junc.has(k)) junc.set(k, { node: p, dirs: [] });
      junc.get(k).dirs.push(norm(sub(o, p)));
    }
    for (const info of junc.values()) {
      if (info.dirs.length < 2) continue; // 마루 교차 절점만
      const J = info.node;
      const surfY = yOf(J.h), topY = surfY + ridgeH * 0.5;
      // 열린 안쪽 방향(회첨 쪽) = 마루 방향들의 반대 합
      let ox = 0, oz = 0;
      for (const d of info.dirs) { ox -= d.x; oz -= d.z; }
      const od = norm({ x: ox, z: oz });
      const perp = { x: -od.z, z: od.x };
      // 상단 절점 봉우리 → 안쪽·아래로 벌어지는 삼각 솔리드(양면)로 공극 봉합
      const A = [J.x, topY + 0.04, J.z];
      const w = 0.34, fwd = 0.62;
      const B = [J.x + od.x * fwd + perp.x * w, surfY + 0.02, J.z + od.z * fwd + perp.z * w];
      const C = [J.x + od.x * fwd - perp.x * w, surfY + 0.02, J.z + od.z * fwd - perp.z * w];
      const D = [J.x + od.x * 0.18, surfY + ridgeH * 0.35, J.z + od.z * 0.18];
      const pos = [...A, ...B, ...C, ...D];
      // A(apex)-B-C 바닥 삼각 + D 로 지붕(A-D-B, A-C-D) → 닫힌 회첨 봉
      const idx = [0, 1, 2, 0, 3, 1, 0, 2, 3, 3, 2, 1];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx); geo.computeVertexNormals();
      const capMat = M.tileRidge.clone(); capMat.side = THREE.DoubleSide;
      const cap = new THREE.Mesh(geo, capMat);
      cap.castShadow = true; cap.name = 'junction-cap';
      g.add(cap);
      // 절점 위 둥근 회첨 보주(작은 눌린 돔)로 봉우리 마감
      const boss = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), M.tileRidge);
      boss.scale.set(1, 0.8, 1);
      boss.position.set(J.x, topY + 0.02, J.z);
      boss.castShadow = true;
      g.add(boss);
    }
  }

  g.userData = { skeleton: sk };
  return g;
}

// 회첨골 기와 줄 (#223 / #171 residual).
// 경로: 절점(top) → 처마 코너(botPlan) — curvedTube 와 동일한 #171 eave 정렬.
// 형태: 골 안쪽에 앉는 한 줄 튜브. 면 수키와 롤(r=0.052)보다 조금 굵어 골 라인으로
//   읽히고, 옛 단색 valley-maru(r=0.085)보다 얇아 마루 캡처럼 보이지 않게 한다.
// 켜: TubeGeometry UV.x(경로 0→1) 에 pathLen/GIWA_ALONG_PITCH 를 곱해 구워 넣음.
//   재질 map.repeat 는 (1,1) — 면 타일과 같이 제품 후처리에 안전.
// 드로우: 골당 Mesh 1 (기존 valley-maru 와 동일). 프로그램: sugiwa 계열 재사용
//   (지붕당 재질 인스턴스 1 — 모든 회첨이 공유, 베이크 UV 라 길이별 repeat 불필요).
const VALLEY_COURSE_R = 0.072;
const VALLEY_TUBE_SEGS = 10;
const VALLEY_TUBE_RADIAL = 8;

function makeValleyCourseMaterial(mats, sharedSugiwaMat, lengthHint) {
  let mat;
  if (sharedSugiwaMat) {
    mat = sharedSugiwaMat.clone();
    if (mat.map) {
      mat.map = mat.map.clone();
      mat.map.repeat.set(1, 1);
      mat.map.needsUpdate = true;
    }
  } else {
    mat = sugiwaMaterial(mats, lengthHint || 3.5, TILE_LOOK.bumpSugiwa);
    if (mat.map) {
      mat.map.repeat.set(1, 1);
      mat.map.needsUpdate = true;
    }
  }
  mat.userData.paletteKey = 'sugiwa';
  mat.userData.valleyTileCourse = true;
  return mat;
}

function buildValleyTileCourse(top, botPlan, botY, yOf, fprofile, mat) {
  const pts = [];
  let pathLen = 0;
  let prev = null;
  const clear = VALLEY_COURSE_R + ROOF_MARU_SURFACE_CLEAR;
  for (let i = 0; i <= VALLEY_TUBE_SEGS; i++) {
    const v = i / VALLEY_TUBE_SEGS; // 0=처마, 1=절점 (curvedTube 와 동일)
    const x = botPlan.x + (top.x - botPlan.x) * v;
    const z = botPlan.z + (top.z - botPlan.z) * v;
    const y = botY + (yOf(top.h) - botY) * fprofile(v);
    // Normal-offset into the open trough (same contract as curvedTube).
    const eps = 0.03;
    const v0 = Math.max(0, v - eps), v1 = Math.min(1, v + eps);
    const a = new THREE.Vector3(
      botPlan.x + (top.x - botPlan.x) * v0,
      botY + (yOf(top.h) - botY) * fprofile(v0),
      botPlan.z + (top.z - botPlan.z) * v0,
    );
    const b = new THREE.Vector3(
      botPlan.x + (top.x - botPlan.x) * v1,
      botY + (yOf(top.h) - botY) * fprofile(v1),
      botPlan.z + (top.z - botPlan.z) * v1,
    );
    const along = b.sub(a);
    let n = new THREE.Vector3(0, 1, 0);
    if (along.lengthSq() > 1e-12) {
      along.normalize();
      const runX = top.x - botPlan.x;
      const runZ = top.z - botPlan.z;
      const cross = new THREE.Vector3(-runZ, 0, runX);
      if (cross.lengthSq() > 1e-12) {
        cross.normalize();
        n.crossVectors(along, cross);
        if (n.lengthSq() > 1e-12) {
          n.normalize();
          if (n.y < 0) n.negate();
        } else {
          n.set(0, 1, 0);
        }
      }
    }
    const p = new THREE.Vector3(x, y, z).addScaledVector(n, clear);
    if (prev) pathLen += p.distanceTo(prev);
    prev = p;
    pts.push(p);
  }
  const geo = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(pts), VALLEY_TUBE_SEGS, VALLEY_COURSE_R, VALLEY_TUBE_RADIAL, false,
  );
  // 물매 켜 UV 베이크 — 재질 repeat 에 의존하지 않는다.
  const alongCourses = Math.max(1, pathLen / GIWA_ALONG_PITCH);
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * alongCourses);
  uv.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.name = 'valley-maru';
  mesh.userData.botPlan = { x: botPlan.x, z: botPlan.z };
  mesh.userData.topPlan = { x: top.x, z: top.z };
  mesh.userData.valleyTileCourse = true;
  mesh.userData.pathLen = pathLen;
  mesh.userData.alongCourses = alongCourses;
  return mesh;
}

// ── 벡터 유틸 ──
const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.z * b.z;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const norm = (a) => { const l = Math.hypot(a.x, a.z) || 1; return { x: a.x / l, z: a.z / l }; };

// 배열(리샘플된 상단 체인)에 분율 인덱스 s∈[0,1]로 선형 보간.
function interpArr(arr, s) {
  const n = arr.length - 1;
  const f = Math.max(0, Math.min(n, s * n));
  const i = Math.min(n - 1, Math.floor(f)), t = f - i;
  const a = arr[i], b = arr[i + 1];
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: a.h + (b.h - a.h) * t };
}
function resampleLine(A, B, N) {
  const out = [];
  for (let i = 0; i <= N; i++) { const t = i / N; out.push({ x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t }); }
  return out;
}
function resampleScalarEnds(a, b, N) {
  // 앙곡: 처마 끝(추녀) 근처에서만 들림. 끝 ~25% 구간에 집중(고power)해
  // 처마 전체가 출렁이지 않게 한다.
  const out = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const ends = Math.pow(Math.abs(2 * t - 1), 4.5); // 0(중앙)→1(끝), 끝에 급집중
    const side = t < 0.5 ? a : b;
    out.push(side * ends);
  }
  return out;
}

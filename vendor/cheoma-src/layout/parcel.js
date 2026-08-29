import * as THREE from 'three';
import { hanokFootprint } from './hanok-footprint.js';
import { PRESETS } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import { makeMaterials } from '../builder/palette.js';
import { makeRng } from '../rng.js';
import { buildFence } from './fence.js';
import { buildGate } from './gate.js';
import { buildHanok } from './hanok.js';
import { buildCorridor } from './corridor.js';
import { attachOverlayLanterns } from './props.js';
import { COURTYARD_SURFACE_LIFT, beddedStone } from '../core/surface-clearance.js';
import { parcelCompoundPlan } from './parcel-compound-plan.js';

// 담장으로 둘린 대지 + 남측 대문 + 마당 + 북측 중앙 몸채 + 행각/행랑.
// 좌표계: 남쪽 = +z(대문·진입), 북쪽 = -z(몸채·배산). 몸채는 +z(남)을 향해 앉는다.
//
// buildParcel({ seed, style, plotW, plotD, roofOpts, wallH, presetOverrides, materials }) → THREE.Group
//   roofOpts·wallH 는 hanok 분기의 buildHanok 으로 전달 (히어로 필지 편집 반영용)
//   presetOverrides 는 비-hanok 분기(palace/temple/choga)의 PRESETS 병합 — 특수 건물 편집 반영용
//   materials 는 테스트·외부 조립기가 소유한 공유 재질셋을 주입하는 선택 계약(미지정이면 자체 생성)
//   style: 'palace' | 'temple' | 'choga' | 'hanok'(ㄱ자 반가 안채)
//   lanterns: 필지 등롱(대문·마당 걸이등롱, #83)을 루트 직속에 심을지. 기본 true(focus 오버레이·뷰어).
//     mergeStatic 병합 경로(populate 히어로·절·궁 코어)는 false 로 넘겨 PointLight 유실·bulb 오염을 막는다.
// 반가 안채(hanok) 풋프린트 생성 — 평면형(single=ㅡ자 / l=ㄱ자 / u=ㄷ자) × 칸수(bays, 본채 정면 칸).
//   좌표계는 buildParcel 과 동일(원점 기준, +z=남). 본채는 -hd..hd 깊이의 가로 채, 날개는 +z(남)로
//   뻗어 안뜰을 감싼다. bayW·wingLen·wingW 는 기본 ㄱ자(bays=3)가 기존 하드코딩 풋프린트와 정확히
//   일치하도록 고른 값 — 미편집 종가의 픽셀 불변을 보장한다. 날개폭은 안뜰/본채 앞면이 붕괴하지 않게
//   본채 폭에 종속 클램프(ㄷ자는 양 날개가 겹치지 않게, ㄱ자는 본채 앞면이 날개보다 넓게).
export function buildParcel({
  seed = 20260716,
  style = 'palace',
  plotW,
  plotD,
  roofOpts,
  wallH = 2.7,
  presetOverrides,
  lanterns = true,
  materials = null,
  roofRank = null,
} = {}) {
  const compound = parcelCompoundPlan({ style, plotW, plotD });
  const cfg = compound.config;
  const rng = makeRng(seed);
  const W = compound.width;
  const D = compound.depth;
  const hw = compound.halfW, hd = compound.halfD;
  const mats = materials || makeMaterials(cfg.preset === 'korea' ? 'palace' : cfg.preset);

  const root = new THREE.Group();
  root.name = `parcel-${style}`;

  // ── 마당 (밝은 흙) ──
  const yard = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: 0xcabfa2, roughness: 1.0 }));
  yard.name = 'courtyard-ground';
  yard.rotation.x = -Math.PI / 2;
  yard.position.y = COURTYARD_SURFACE_LIFT;
  yard.receiveShadow = true;
  root.add(yard);

  // ── 담장 (폐곡선) + 남측 대문 개구부 ──
  // 코너: SW(-hw,+hd) → SE(+hw,+hd) → NE(+hw,-hd) → NW(-hw,-hd)
  const { group: fence } = buildFence({
    points: compound.fence.points,
    closed: true,
    height: compound.fence.height,
    thickness: compound.fence.thickness,
    seed,
    mats,
    wallStyle: compound.fence.wallStyle,
    openings: [compound.fence.opening],
  });
  root.add(fence);

  // ── 대문 ──
  const gate = buildGate(compound.gate.type, { mats, seed, width: compound.gate.width });
  gate.position.set(compound.gate.position.x, 0, compound.gate.position.z);
  gate.rotation.y = compound.gate.rotationY;
  root.add(gate);

  // ── 몸채 (북측 중앙, 남향) ──
  let building, frontZ, buildingZ;
  if (cfg.preset === 'hanok') {
    // 반가 안채 평면형·칸수 편집(#146): planShape(ㅡ/ㄱ/ㄷ)·bays 는 roofOpts 채널로 흘러온다
    //   (adapter heroEditOpts 가 np.roofOpts 를 통째로 포워딩 → 여기 roofOpts 에 실림). buildHanok 은
    //   footprint 다각형·straight-skeleton 지붕·reflex 안뜰 개구를 모두 임의 폴리곤에서 지원하므로,
    //   여기서 풋프린트만 형태·칸수에 맞춰 생성하면 지붕/창호/굴뚝이 전부 자동 정합한다. 미지정
    //   (랜딩·리플레이)이면 기본 ㄱ자·3칸 → 기존 하드코딩 풋프린트와 완전 동일(픽셀 불변).
    const { planShape, bays, ...roofRest } = roofOpts || {};
    const fp = hanokFootprint(planShape || 'l', bays);
    const cz = fp.reduce((s, p) => s + p.z, 0) / fp.length;
    const centered = fp.map((p) => ({ x: p.x, z: p.z - cz }));
    building = buildHanok({ footprint: centered, seed, mats, wallH, roofOpts: roofRest });
    const zExtent = Math.max(...centered.map((p) => p.z)) + 1.15; // 처마 포함 남단
    buildingZ = -hd + (Math.max(...centered.map((p) => p.z)) - Math.min(...centered.map((p) => p.z))) / 2 + 3.5;
    building.position.set(0, 0, buildingZ);
    frontZ = buildingZ + zExtent;
  } else {
    const base = PRESETS[cfg.preset];
    const P = {
      ...(presetOverrides ? { ...base, ...presetOverrides } : base),
      // Magistracy/gaeksa cores borrow palace materials but must not inherit palace
      // japsang/chwidu — roof-rank is the sole ornament gate (#150 C).
      ...(roofRank != null ? { roofRank } : {}),
    };
    building = buildBuilding(P);
    const L = building.userData.layout;
    const halfDepth = L.zEave + P.podiumMarginS + 1.0;
    buildingZ = -hd + halfDepth + 1.5;
    building.position.set(0, 0, buildingZ);
    frontZ = buildingZ + L.zEave + 0.6;
  }
  root.add(building);

  // ── 행각 (동·서, 마당 감싸기) — 대지 넉넉한 궁·반가 ──
  for (const wing of compound.wings) {
    // 마당 안쪽을 바라보도록 innerSide 로 방향 결정 (동쪽 채는 -x 가 마당)
    const { group } = buildCorridor({
      points: wing.points,
      closed: false,
      mats,
      seed: seed + wing.seedOffset,
      depth: wing.depth,
      colH: wing.colH,
      innerSide: wing.innerSide,
    });
    root.add(group);
  }

  // ── 디딤돌 길 (대문 → 몸채) ──
  // 디딤돌은 서로 떨어져 놓인 개별 돌이고, 마당에 얹힌 판이 아니라 밟아 다져 박힌 돌이다.
  //   ① 간격: 예전 `max(3, round(span / 1.4))` 은 짧은 마당(초가)에 세 개를 억지로 밀어넣어
  //      간격 0.45m < 돌 길이 1.008m 가 됐다. 겹친 돌들의 상면이 전부 같은 높이라 그 겹침
  //      전체가 depth 를 다퉜고, 근접에서 길이 통째로 깜빡였다. 이제 간격이 돌 길이보다
  //      좁아질 수 없도록 개수를 span 에서 역산한다(부족하면 하나만).
  //   ② 종점: 몸채 자신의 댓돌·디딤돌 앞에서 끊는다. 예전에는 마지막 돌이 댓돌 안으로 파고
  //      들어 두 돌의 밑면이 정확히 같은 평면을 공유했다.
  //   ③ 깊이: 마당면 위로 솟는 몫만 authored 높이로 두고 밑동은 지면 아래로 묻는다.
  //      마당 아래 지형이 출렁여도 돌이 뜨거나 잠기지 않는다.
  const stoneHalfDepth = 0.42 * 1.2;                    // z 스케일 반영 반길이
  const stonePitch = Math.max(1.4, stoneHalfDepth * 2 + 0.14);
  // 몸채가 스스로 놓은 디딤돌(종가 댓돌·초가 디딤돌)의 남단을 실제로 재서 그 앞에서 끊는다.
  //   고정 오프셋으로 어림하면 좁은 초가 마당에서 길이 통째로 사라지거나 여전히 겹친다.
  //   `Box3.setFromObject` 은 `updateWorldMatrix(false, false)` 만 하므로 조립 중인 트리에서는
  //   부모 변환이 빠진 좌표를 준다 — 먼저 몸채 서브트리 행렬을 한 번 갱신해야 실제 z 를 읽는다.
  building.updateMatrixWorld(true);
  let houseStoneZ = -Infinity;
  const stoneBox = new THREE.Box3();
  building.traverse((o) => {
    if (o.isMesh && o.name === 'stepping-stone') {
      stoneBox.setFromObject(o);
      if (stoneBox.max.z > houseStoneZ) houseStoneZ = stoneBox.max.z;
    }
  });
  const pathZ0 = hd - 1.2;
  const pathZ1 = Number.isFinite(houseStoneZ)
    ? Math.max(frontZ, houseStoneZ + stoneHalfDepth + 0.12)
    : frontZ;
  const span = pathZ0 - pathZ1;
  const steps = span >= stonePitch
    ? Math.floor(span / stonePitch) + 1
    : (span >= stoneHalfDepth * 2 ? 1 : 0);
  // 마당 디딤돌은 몸채 댓돌보다 얕게 앉은 낮은 돌 — 상면 높이가 몸채 석재와 겹치지 않는다.
  const stoneBed = beddedStone(COURTYARD_SURFACE_LIFT, 0.05);
  if (steps > 0) {
    for (let i = 0; i < steps; i++) {
      const z = steps > 1 ? pathZ0 - span * (i / (steps - 1)) : pathZ0 - span * 0.5;
      const st = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, stoneBed.height, 8),
        mats.stone);
      st.name = 'stepping-stone';
      st.scale.set(1, 1, 1.2);
      st.position.set((rng() - 0.5) * 0.2, stoneBed.center, z);
      st.receiveShadow = true; st.castShadow = true;
      root.add(st);
    }
  }

  // ── 행랑 자리 마커 (행각 없는 넉넉한 대지: 절 등) ──
  if (!cfg.wings && W > 22) {
    const markMat = new THREE.MeshStandardMaterial({ color: 0x9a8f7c, roughness: 1.0 });
    for (const sx of [1, -1]) {
      const n = 2;
      for (let i = 0; i < n; i++) {
        const z = -hd * 0.1 + i * 4.5 + 2;
        const mk = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.35, 2.4), markMat);
        mk.position.set(sx * (hw - 3.2), 0.17, z);
        mk.receiveShadow = true; mk.castShadow = true;
        root.add(mk);
        // 초석 4개
        for (const cx of [-1.2, 1.2]) for (const cz of [-0.9, 0.9]) {
          const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.4, 10), mats.stone);
          base.position.set(sx * (hw - 3.2) + cx, 0.2, z + cz);
          base.castShadow = true;
          root.add(base);
        }
      }
    }
  }

  // ── 필지 등롱 (대문·마당 걸이등롱, #83) ──
  //   루트 직속에 발광 bulb → focus 링(env/motes.js setupLanternSway)이 직속 자식을 훑어 흔들림 구동.
  //   PointLight 는 심지 않는다(#141 emitLight:false) — focus-in/out·hop 로 오버레이가 add/remove 될 때
  //   numPointLights 가 요동해 셰이더 폭풍을 일으키므로, 국소 조명은 env/focus.js 링 고정 풀이 담당.
  //   병합 경로는 lanterns:false 로 skip.
  if (lanterns) attachOverlayLanterns(root, { style, W, D, seed, emitLight: false });

  root.userData = { style, W, D, mats };
  return root;
}

import * as THREE from 'three';
import {
  hasOnlyMaterialProgramKeys,
  MATERIAL_PROGRAM_PATCH,
  addMaterialProgramKey,
} from '../render/material-program-key.js';
import { patchLodScreenDoorMaterial } from '../render/lod-screen-door.js';
import { VILLAGE_LENS, dollyScaleForFov } from '../camera/optics.js';

// 재질 프레넬 골든아워 림 (태스크 #76 도입 · #101 전 오브젝트 확장) — RimPass(스크린스페이스) 대체.
//
//   createFresnelRim(scene) → { apply, setColor, setStrength, setPower, setWrap,
//                               setScale, setNearFar, setSunViewDir, patchedCount, coverage, dispose }
//
// 왜 재질로 옮기나(#76):
//  - RimPass 는 매 프레임 씬을 노멀 오버라이드로 한 번 더 렌더(지오 2배 제출)라 마을·hanyang
//    부감에서 OFF 게이팅해야 했다. 재질 프레넬은 상시 ON — 추가 지오 제출 0.
//  - 스크린스페이스 엣지 검출은 깊이 불연속을 무차별 선화해 "가려진 뒷건물 실루엣"이 앞 표면
//    위로 새는 X-ray 누출을 낳는다. 프레넬은 각 프래그먼트가 자기 노멀·뷰벡터만으로 림을 산출 →
//    가려진 건물은 애초에 래스터되지 않아 앞 표면 픽셀에 기여 불가. X-ray 구조적 해소.
//
// 대상(#101 — 사용자: "집뿐 아니라 모든 오브젝트"): 실루엣이 있는 조명(lit) 재질 전반.
//   나무(마을/외곽 스캐터·마당 과실수·보호수)·풀(focus grass)·담장·소품(장독대·해태·정원석 등)·
//   동물·정자·다리 + 기존 건물(role). 구 RimPass 의 "나무 실루엣 금빛 림"이 재질 전환(#76)에서
//   상실됐던 것을 포함해 복원한다. 대상/제외는 allowlist(role) 대신 명시 제외 규칙으로 판정.
//
// 제외(그리고 그 근거):
//  - 비-lit 재질(MeshBasic/ShaderMaterial 등): vViewPosition·nonPerturbedNormal 이 없어 주입 시
//    컴파일 실패. 타입 게이트(Standard/Physical 만)로 하늘·능선·구름·Shader 기반 디테일 입자·
//    원경 창불(nightlights)·먹 스프라이트가 자동 제외된다.
//  - 반투명: 오버레이·유리·입자성(빗물 리벌릿·웅덩이 등). 실루엣 대상이 아님.
//  - 개구부(role 'opening')·야간 발광(userData.hanjiGlow: 창호·문·석등 화창)·자체발광 지배
//    재질(#66/#70): 림이 발광과 충돌.
//  - 알려지지 않은 customProgramCacheKey 재질(#52 snowvol shell/ground): 델리킷한 프로그램 캐시키
//    분리에 변형을 얹으면 캐시키 충돌·AO 오재사용 회귀 위험 → 건드리지 않는다. diffuseColor 곱셈과
//    callback/key 체인을 명시한 cloudshadow-v2만 안전 합성 대상으로 허용한다.
//  - 지형·물면(넓은 완사면·수면): 프레넬은 이웃 샘플이 없어 "평면의 실루엣 에지"와 "평면 내부의
//    그레이징"을 구분할 수 없다(그게 프레넬의 본질). 넓은 지면이 그레이징에서 전면 금빛으로 물드는
//    오탐(구 RimPass 가 깊이-이차미분 엣지 게이트로 힘겹게 막던 것)을 재질 프레넬로는 막을 방법이
//    없다. → 이름으로 명시 제외: env 경로는 패치 자체를 건너뛰고(SKIP_NAMES), 마을 경로는 패치를
//    유지한 채 그룹 계수를 0 으로 눌러(GROUND_NAMES) 프로그램 분기 없이 기여만 없앤다.
//    나무·풀·소품은 곡률/소형 지오라 프레넬이 실루엣에 자연 집중하므로 오탐이 없다.
//
// 강도 정책(#101): 재질군별 계수. 건물은 온전(처마 킥 주인공), 소품·담장·동물은 절제, 나무·풀 등
//   유기물은 실루엣만 은은한 금빛(전면 금빛 도배 방지 — 구 RimPass 인상 계승). 계수는 상수 노출.
//
// onBeforeCompile 함정 회피:
//  - 노멀: 구현 초기엔 vNormal 을 직접 참조했으나, flatShading 재질(나무·granite prop·동물)은
//    three 가 vNormal varying 을 선언하지 않아(#ifndef FLAT_SHADED) 컴파일 실패한다. 대신
//    normal_fragment_begin 이 산출하는 `nonPerturbedNormal`(bump/normalMap 교란 전 지오메트리 노멀,
//    flat=파생·smooth=vNormal·double-side=faceDirection 보정)을 쓴다. smooth 단면 재질(건물)에선
//    normalize(vNormal)과 동일 → #76 건물 룩 완전 무회귀. 양면 풀은 faceDirection 보정으로 뒤집힘 방지.
//  - 색 uniform 은 THREE.Color 값(three setValueV3f 가 .r/.g/.b 지원) → Vector3.copy(Color)=NaN 무관.
//  - 배열 uniform 동적 인덱싱 없음(전부 스칼라 vec3/float).
//  - 인젝션 토큰은 <opaque_fragment>(outgoingLight 선언 직후). seasons 는 나무=vertex 만, terrain=
//    <color_fragment>(제외 대상)에 주입하므로 토큰이 겹치지 않는다. grass 는 <emissivemap_fragment>
//    까지만 → 역시 겹침 없음. 프래그먼트 <common> 은 여러 패치가 앞에 append 하되 uniform 이름이
//    uRim* 로 유일해 충돌 없음(체이닝 시 prev 먼저 실행 → 마지막에 내 uRim 블록이 append).

const RIM_ROLES = new Set(['roof', 'wall', 'wood', 'stone']);

// 재질군별 강도 계수(상수 노출). 건물=온전, 소품/담장/동물=절제, 유기물(나무/풀/마당초목)=은은.
// ground=0: 넓은 지면·수면은 패치는 유지하되(프로그램 분기 방지) 기여를 0 으로 눌러 제외한다.
export const RIM_GROUP_MUL = { building: 1.5, misc: 1.0, organic: 0.7, ground: 0.0 };

// Silhouette gate: full strength to ~6° of the tangent, closed by ~25° so a continuous eave /
// wall edge reads while a broad plaster plane stays a surface (not a wash).
export const RIM_FACING_GATE = Object.freeze({ full: 0.10, cutoff: 0.42 });

// Anti-stipple layers for reverse-light gold dots (docs/surface-materials.md):
//   1) RIM_FRESNEL_AA — fwidth damp of high-frequency Fresnel (MSAA does not fix shading alias).
//   2) RIM_TILE_SURFACE_MUL — tile *fields* carry no material rim; eaveBand / wood keep the kick.
//   3) RIM_DOF_GATE — neighbours outside the DoF plane lose rim so eave threads do not seed bokeh dots.
// Separate product axis: TILE_LOOK roughness/bump (PBR specular on corrugation, not this shader).
export const RIM_FRESNEL_AA = Object.freeze({
  ndvFull: 0.012,
  ndvCutoff: 0.09,
  normalFull: 0.025,
  normalCutoff: 0.16,
  fresnelW: 3.5, // Toksvig-style peak soften vs fwidth(Fresnel)
});

// paletteKey for corrugated tile fields (not eaveBand / wadang / jeoksae ornaments).
const TILE_SURFACE_KEYS = new Set([
  'tileSurface', 'sugiwa', 'tileFlat', 'tileConvex', 'tileRidge',
]);
// Zero: field ridges must not light as gold threads; eave kick lives on eaveBand + timber.
export const RIM_TILE_SURFACE_MUL = 0.0;

// The tangent edge is meant to clip and seed bloom — that overexposed thread along the eave is
// the look. Cap only far enough to stop a whole pale plaster face or grass clump from becoming a
// flat HDR-white emitter. Group multipliers remain outside the cap, preserving
// building > misc > organic hierarchy at both ordinary and peak strength.
export const RIM_BASE_ENERGY_CAP = 0.34;

// The physical conditions still shape the rim, but as attenuation rather than as an all-or-nothing
// switch. Real backlit edges glow even in shadow and even somewhat off the sun axis, because the
// whole sky is a source at golden hour — so each condition keeps a floor. The stock lighting loop
// captures the already-shadowed first sun; combining that visibility with directDiffuse keeps a
// later unshadowed fill from reviving a full-strength rim inside the sun's shadow, without another
// sampler fetch or program variant.
export const RIM_SOLAR_GATE = Object.freeze({
  facingStart: -0.05,
  facingFull: 0.12,
  backlitStart: 0.02,
  backlitFull: 0.45,
  // 순광·측광 뷰에 남기는 최소 강도. 골든이 전역 backlit 게이트에 두었던 0.18 바닥과 같은 뜻 —
  // 림은 역광에서 읽히는 것이 본질이므로 이 값이 커지면 방향성이 무너진다.
  backlitFloor: 0.20,
  directStart: 0.002,
  directFull: 0.08,
  shadowFloor: 0.45,
});

// The distance fade exists to drop rim off *apparent* background — distant ridges and far
// buildings — but it reads raw view-space depth. A compensated telephoto dolly holds the
// subject's projected size while moving the camera 2.3× (close parcel) to 3.0× (hero) farther,
// so the authored 24/175m band must scale with the *live* lens, not a fixed parcel dolly.
// post.js updates uRimNear/Far each frame via rimDistanceGateForFov(camera.fov).
// Hero settle (~170 m at 7°) was at ~33% strength with parcel-only scaling — the flagship
// eave rim at choreography end never peaked.
export const RIM_DISTANCE_BASE = Object.freeze({ near: 24, far: 175 });
export function rimDistanceGateForFov(fovDegrees, referenceFov = VILLAGE_LENS.parcel.referenceFov) {
  const live = Number.isFinite(fovDegrees) && fovDegrees > 0
    ? dollyScaleForFov(referenceFov, fovDegrees)
    : dollyScaleForFov(referenceFov, VILLAGE_LENS.parcel.fov);
  return {
    near: RIM_DISTANCE_BASE.near * live,
    far: RIM_DISTANCE_BASE.far * live,
  };
}
// Parcel-lens defaults for init / pure gates that do not have a live camera.
export const RIM_DISTANCE_GATE = Object.freeze(
  rimDistanceGateForFov(VILLAGE_LENS.parcel.fov),
);

// Axial defocus damp (same units as BokehPass focus = -viewZ metres). amount=0 leaves inert.
export const RIM_DOF_GATE = Object.freeze({
  near: 5,     // start past ~one parcel of axial defocus
  far: 28,     // full damp by mid-village depth
  floor: 0.12, // soft residual, not a hard cutout
});

// Anti-solar silhouette residual (the former `uRimWrap`). post.js authors this for the legacy
// screen pass and scales it down for the material path, which lands below the value at which a
// shaded edge still reads at all. Floor it here: the material rim owns its own sky-scatter term.
export const RIM_WRAP_FLOOR = 0.10;

// Capture Three's first directional light immediately before and after its stock shadow
// attenuation.  WebGLLights orders shadow-casting directionals first, and the
// product owns exactly one such sun followed by an unshadowed village fill.  Capturing here is
// both more exact and cheaper than sampling directionalShadowMap a second time in the rim
// block; the fill can no longer make a main-sun-shadowed fragment look sunlit.
//
// Three is pinned to r185.1.  Expand only this one stock chunk and splice two assignments around
// its directional shadow attenuation.  All nested chunks and the unroll pragmas remain stock, so
// material/light program keys and variants stay unchanged.
function rimLightsFragmentBegin() {
  const source = THREE.ShaderChunk.lights_fragment_begin;
  const directionalStart = source.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const infoCall = '\t\tgetDirectionalLightInfo( directionalLight, directLight );';
  const directCall = '\t\tRE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const infoAt = source.indexOf(infoCall, directionalStart);
  const callAt = source.indexOf(directCall, directionalStart);
  if (directionalStart < 0 || infoAt < 0 || callAt < 0) {
    throw new Error('cheoma rim: unsupported Three lights_fragment_begin contract');
  }
  const beforeShadow = `
\t\t#if ( UNROLLED_LOOP_INDEX == 0 )
\t\t\t_rimMainSunUnshadowed = directLight.color;
\t\t#endif`;
  const afterShadow = `#if ( UNROLLED_LOOP_INDEX == 0 )
\t\t\t_rimMainSunShadowed = directLight.color;
\t\t#endif

`;
  const infoEnd = infoAt + infoCall.length;
  return `${source.slice(0, infoEnd)}${beforeShadow}${source.slice(infoEnd, callAt)}${afterShadow}${source.slice(callAt)}`;
}

const RIM_LIGHTS_FRAGMENT_BEGIN = rimLightsFragmentBegin();

// 유기물 그룹 판정용 조상 그룹 이름(나무 스캐터·마당 초목·봄 개화 관목·focus 풀).
//   'trees'/'focusGrass' 는 단일건물·focus 링 경로, 'village-*' 는 마을 경로다. 마을 이름이
//   빠져 있던 동안 숲·스캐터 나무·개화 관목이 misc(×1.0)로 분류돼 건물급 림을 받았다.
//   숲은 'village-forest' 가 아니라 'forest-trees' 로 지정한다 — 같은 부모 아래의 화강암
//   노두(forest-rocks)는 유기물이 아니고 절제 대상도 아니므로 misc 로 남아야 한다.
const ORGANIC_NAMES = new Set([
  'trees', 'focusGrass',
  'village-flora', 'village-trees', 'forest-trees', 'village-bloom',
]);

// 그레이징 오탐(넓은 완사면·도로 광역 금빛)·수면은 프레넬로 실루엣 분리가 불가 → 이름으로 명시 제외.
//   (하늘·능선·구름·디테일 입자·원경 창불 등은 MeshBasic/Shader/Points/Sprite 타입이라 이미 제외.)
const SKIP_NAMES = new Set(['terrain', 'stream', 'paddyField', 'village-roads-m0']);

// 같은 근거의 마을 경로 이름. 위 목록은 env 하네스 이름이고 제품 마을은 'village-' 접두를 쓰므로
// 제품의 지형·수면은 이 제외를 한 번도 받지 못했다. 9° 눈높이에서는 지면 전체가 그레이징에 들어와
// 프레임이 단일 주황 워시로 물든다(docs/look-grammar.md §2-3 채도 규율 위반, 전 프레임 평균 +25/255 측정).
//
// 여기서 패치 자체를 건너뛰면 안 된다: 이 재질들은 seasons·cloudshadow·snow 패치를 이미 갖고 있어
// rim 프로그램 키만 빠지면 같은 설정을 공유했던 재질과 프로그램이 갈라진다(hanyang 근경 +8 실측).
// 대신 소스는 그대로 두고 그룹 계수 uniform 을 0 으로 준다 — 프로그램 변형 0, 림 기여 정확히 0.
// 그룹 계수를 셰이더 리터럴이 아니라 uniform 으로 나눈 설계의 목적이 바로 이런 분기다.
const GROUND_NAMES = new Set(['village-terrain', 'village-stream']);

export function createFresnelRim(scene) {
  // 모든 패치 재질이 참조 공유하는 uniform(seasons 패턴). 한 번 갱신하면 패치된 전 재질에 반영.
  const u = {
    // r185 Color(hex)는 sRGB 입력을 working-linear로 자동 변환한다. 추가 변환하면 이중 디코드된다.
    uRimColor: { value: new THREE.Color(0xffc070) },
    uSunViewDir: { value: new THREE.Vector3(0, 0, 1) }, // 뷰공간 태양 방향(post 가 매 프레임 세팅)
    uRimStrength: { value: 0.0 },   // cur.rim × altGate(저고도) × runtime 보정 — 물리 역광은 fragment가 판정
    uRimPower: { value: 1.92 },     // 프레넬 지수(담백하고 예리한 에지 실선 복원)
    uRimWrap: { value: RIM_WRAP_FLOOR }, // 태양 반대편 실루엣 잔여(하늘 산란광) — 0이면 그늘 에지 소거
    uRimScale: { value: 1.0 },      // 부감/enable 마스터(focus=1, aerial=0)
    uRimNear: { value: RIM_DISTANCE_GATE.near }, // 근경 거리 게이트 시작(뷰공간 깊이·렌즈 보정)
    uRimFar: { value: RIM_DISTANCE_GATE.far },   // 원경 능선·far 건물 제외(#119 비율 유지·렌즈 보정)
    // DoF defocus gate (axial metres; matches BokehPass focus). amount 0 → no damp.
    uRimFocusDepth: { value: 40 },
    uRimDofAmount: { value: 0 },
    uRimDofNear: { value: RIM_DOF_GATE.near },
    uRimDofFar: { value: RIM_DOF_GATE.far },
    uRimDofFloor: { value: RIM_DOF_GATE.floor },
  };

  // 그룹 계수는 셰이더 리터럴이 아니라 재질별 uniform으로 전달한다. onBeforeCompile 클로저의
  // toString()은 캡처값을 구분하지 않으므로 리터럴을 구우면 서로 다른 셰이더가 같은 프로그램
  // 캐시키를 갖는다. 소스는 하나로 유지하고 uniform만 나누면 프로그램 변형 없이 의도가 보존된다.
  const groupUniforms = {
    building: { value: RIM_GROUP_MUL.building },
    misc: { value: RIM_GROUP_MUL.misc },
    organic: { value: RIM_GROUP_MUL.organic },
    ground: { value: RIM_GROUP_MUL.ground },
  };
  // Shared across all non-tile materials (1) vs tile fields (RIM_TILE_SURFACE_MUL). Same program.
  const tileSurfaceMulFull = { value: 1.0 };
  const tileSurfaceMulDamp = { value: RIM_TILE_SURFACE_MUL };

  // 커버리지 카운트(검증 로그): 재질군별 패치 수 — 나무·풀·소품 포함 증명·제외 준수 확인.
  const counts = {
    total: 0, building: 0, misc: 0, organic: 0, ground: 0, cloudShadow: 0, cloudRoof: 0,
  };

  // 자체발광 지배 판정: 선형 emissive 휘도 × emissiveIntensity. 임계 낮게(0.2) 잡되 지붕 볏짚·
  //   진흙·정자 마루의 미량 anti-crush emissive(휘도 <0.02)는 통과시킨다.
  function emissiveDominant(mat) {
    const e = mat.emissive;
    if (!e) return false;
    const lum = (0.2126 * e.r + 0.7152 * e.g + 0.0722 * e.b) * (mat.emissiveIntensity ?? 1);
    return lum > 0.2;
  }

  // These stock-material patches own explicit order-independent key tokens and disjoint shader
  // anchors. Bespoke keys remain excluded: silently composing an unknown callback can still alias
  // programs or consume the same anchor.
  const composableProgramKeys = new Set([
    MATERIAL_PROGRAM_PATCH.LOD_SCREEN_DOOR,
    MATERIAL_PROGRAM_PATCH.INST_FADE,
    MATERIAL_PROGRAM_PATCH.CLOUD_SHADOW,
    MATERIAL_PROGRAM_PATCH.SNOW,
    // 소동물 관절 패치는 vertex 의 begin_vertex 만 소비하고 물리 림은 fragment 만 소비한다.
    // 두 앵커가 겹치지 않으므로 개·고양이·까치도 역광 림에 그대로 참여한다.
    MATERIAL_PROGRAM_PATCH.CRITTER_ARTICULATION,
  ]);
  function hasIncompatibleCustomCacheKey(mat) {
    return !hasOnlyMaterialProgramKeys(mat, composableProgramKeys);
  }

  function includable(mat) {
    if (!mat || !mat.isMaterial || mat.userData.__rimPatched) return false;
    if (!(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial)) return false;
    if (mat.transparent) return false;
    if (mat.userData.role === 'opening') return false;
    if (mat.userData.hanjiGlow) return false;
    // Structural 개판 underside: broad under-eave plane — rim here is static sparkle, not silhouette.
    if (mat.userData.isRoofGaepan || mat.userData.paletteKey === 'gaepan') return false;
    if (emissiveDominant(mat)) return false;
    if (hasIncompatibleCustomCacheKey(mat)) return false;
    return true;
  }

  // 재질군 판정: 지면·수면이면 ground(기여 0), 조상 그룹이 유기물이면 organic,
  //   role 이 건물 부위면 building, 그 외 lit=misc.
  function groupOf(o, mat) {
    if (o.name && GROUND_NAMES.has(o.name)) return 'ground';
    let n = o, hops = 0;
    while (n && hops < 4) { if (ORGANIC_NAMES.has(n.name)) return 'organic'; n = n.parent; hops++; }
    const role = mat.userData.role;
    return (role && RIM_ROLES.has(role)) ? 'building' : 'misc';
  }

  function patchMaterial(mat, group) {
    if (!includable(mat)) return;
    mat.userData.__rimPatched = true;
    counts.total++; counts[group]++;
    if (mat.userData.__cloudShadowPatchVersion === MATERIAL_PROGRAM_PATCH.CLOUD_SHADOW) {
      counts.cloudShadow++;
      if (mat.userData.role === 'roof') counts.cloudRoof++;
    }
    // R8 program diet: every rim-eligible stock material carries the LOD screen-door shader
    // path (coverage default 1 → discard early-out). Matrix channel remains object-local on
    // true LOD roots only — plain+rim and lod+rim must not fork WebGLProgram families.
    patchLodScreenDoorMaterial(mat);
    const groupUniform = groupUniforms[group] || groupUniforms.misc;
    const tileSurfaceUniform = TILE_SURFACE_KEYS.has(mat.userData.paletteKey)
      ? tileSurfaceMulDamp
      : tileSurfaceMulFull;
    const facingFull = RIM_FACING_GATE.full.toFixed(2);
    const facingCutoff = RIM_FACING_GATE.cutoff.toFixed(2);
    const energyCap = RIM_BASE_ENERGY_CAP.toFixed(2);
    const solarFacingStart = RIM_SOLAR_GATE.facingStart.toFixed(3);
    const solarFacingFull = RIM_SOLAR_GATE.facingFull.toFixed(2);
    const backlitStart = RIM_SOLAR_GATE.backlitStart.toFixed(2);
    const backlitFull = RIM_SOLAR_GATE.backlitFull.toFixed(2);
    const backlitFloor = RIM_SOLAR_GATE.backlitFloor.toFixed(2);
    const directStart = RIM_SOLAR_GATE.directStart.toFixed(3);
    const directFull = RIM_SOLAR_GATE.directFull.toFixed(2);
    const shadowFloor = RIM_SOLAR_GATE.shadowFloor.toFixed(2);
    const aaNdvFull = RIM_FRESNEL_AA.ndvFull.toFixed(3);
    const aaNdvCutoff = RIM_FRESNEL_AA.ndvCutoff.toFixed(2);
    const aaNormalFull = RIM_FRESNEL_AA.normalFull.toFixed(3);
    const aaNormalCutoff = RIM_FRESNEL_AA.normalCutoff.toFixed(2);
    const aaFresnelW = RIM_FRESNEL_AA.fresnelW.toFixed(2);
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prev) prev(shader, r);
      shader.uniforms.uRimColor = u.uRimColor;
      shader.uniforms.uSunViewDir = u.uSunViewDir;
      shader.uniforms.uRimStrength = u.uRimStrength;
      shader.uniforms.uRimPower = u.uRimPower;
      shader.uniforms.uRimWrap = u.uRimWrap;
      shader.uniforms.uRimScale = u.uRimScale;
      shader.uniforms.uRimNear = u.uRimNear;
      shader.uniforms.uRimFar = u.uRimFar;
      shader.uniforms.uRimFocusDepth = u.uRimFocusDepth;
      shader.uniforms.uRimDofAmount = u.uRimDofAmount;
      shader.uniforms.uRimDofNear = u.uRimDofNear;
      shader.uniforms.uRimDofFar = u.uRimDofFar;
      shader.uniforms.uRimDofFloor = u.uRimDofFloor;
      shader.uniforms.uRimGroupMul = groupUniform;
      shader.uniforms.uRimTileMul = tileSurfaceUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uRimColor;
          uniform vec3 uSunViewDir;
          uniform float uRimStrength;
          uniform float uRimPower;
          uniform float uRimWrap;
          uniform float uRimScale;
          uniform float uRimNear;
          uniform float uRimFar;
          uniform float uRimFocusDepth;
          uniform float uRimDofAmount;
          uniform float uRimDofNear;
          uniform float uRimDofFar;
          uniform float uRimDofFloor;
          uniform float uRimGroupMul;
          uniform float uRimTileMul;`)
        .replace('#include <lights_fragment_begin>', `
          vec3 _rimMainSunUnshadowed = vec3(0.0);
          vec3 _rimMainSunShadowed = vec3(0.0);
          ${RIM_LIGHTS_FRAGMENT_BEGIN}`)
        .replace('#include <opaque_fragment>', `
          {
            // 프레넬(그레이징): 자기 실루엣 에지에서 최대. 이웃/타표면 샘플 전무 → X-ray 불가.
            // nonPerturbedNormal = normal_fragment_begin 이 산출한 지오메트리 노멀(bump/normalMap
            //   교란 전). flatShading 나무·prop 은 파생 노멀, smooth 건물은 normalize(vNormal),
            //   양면 풀은 faceDirection 보정 → 재질군 전반에서 안전하고 #76 건물 룩과 동일.
            vec3 _rn = nonPerturbedNormal;
            vec3 _rv = normalize(vViewPosition);              // 표면→카메라(뷰공간)
            float _ndv = clamp(dot(_rn, _rv), 0.0, 1.0);
            float _fres = pow(1.0 - _ndv, uRimPower);
            // (1) Fresnel AA — high-frequency grazing damp (fwidth). Continuous eaves pass more.
            float _ndvW = fwidth(_ndv);
            float _nW = length(fwidth(_rn));
            float _fresW = fwidth(_fres);
            float _fresAa = 1.0 - smoothstep(${aaNdvFull}, ${aaNdvCutoff}, _ndvW);
            float _normAa = 1.0 - smoothstep(${aaNormalFull}, ${aaNormalCutoff}, _nW);
            float _peakAa = _fres / max(_fres + _fresW * ${aaFresnelW}, 1e-4);
            float _aa = min(_fresAa, _normAa) * clamp(_peakAa, 0.0, 1.0);
            // Front-facing wash gate (broad wall must not become an HDR emitter).
            float _silhouette = 1.0 - smoothstep(${facingFull}, ${facingCutoff}, _ndv);
            // Solar: floored attenuation (facing · backlight · main-sun shadow ratio).
            vec3 _sunDir = normalize(uSunViewDir);
            #if ( NUM_DIR_LIGHTS > 0 )
              _sunDir = normalize(directionalLights[0].direction);
            #endif
            float _sunN = dot(_rn, _sunDir);
            float _sunFacing = mix(uRimWrap, 1.0,
              smoothstep(${solarFacingStart}, ${solarFacingFull}, _sunN));
            float _backlit = mix(${backlitFloor}, 1.0,
              smoothstep(${backlitStart}, ${backlitFull}, -dot(_rv, _sunDir)));
            vec3 _rimLuma = vec3(0.2126, 0.7152, 0.0722);
            float _mainSunBefore = dot(_rimMainSunUnshadowed, _rimLuma);
            float _mainSunAfter = dot(_rimMainSunShadowed, _rimLuma);
            float _mainSunVisibility = clamp(_mainSunAfter / max(_mainSunBefore, 1e-5), 0.0, 1.0);
            float _directLuma = dot(reflectedLight.directDiffuse, _rimLuma);
            float _directGate = mix(${shadowFloor}, 1.0,
              smoothstep(${directStart}, ${directFull}, _directLuma) * _mainSunVisibility);
            // Distance fade (far ridges) + (3) axial defocus damp (neighbour DoF sparkle).
            float _df = 1.0 - smoothstep(uRimNear, uRimFar, length(vViewPosition));
            float _axial = max(-vViewPosition.z, 0.0);
            float _defocus = abs(_axial - uRimFocusDepth);
            float _dofInFocus = 1.0 - smoothstep(uRimDofNear, uRimDofFar, _defocus);
            float _dofDamp = mix(1.0, mix(uRimDofFloor, 1.0, _dofInFocus), clamp(uRimDofAmount, 0.0, 1.0));
            // (2) uRimTileMul: tile fields 0, eaveBand/wood 1.
            float _rim = _fres * _silhouette * _aa * _sunFacing * _backlit * _directGate
              * _df * _dofDamp * uRimStrength * uRimScale * uRimTileMul;
            // Linear HDR add before bloom / ACES. Group mul keeps building > misc > organic.
            outgoingLight += uRimColor * min(max(_rim, 0.0), ${energyCap}) * uRimGroupMul;
          }
          #include <opaque_fragment>`);
    };
    // Preserve every known prior patch token. The same helper is used by cloud/snow/LOD, making
    // clear→snow rerolls and post warm order cache-safe in both directions.
    addMaterialProgramKey(mat, MATERIAL_PROGRAM_PATCH.PHYSICAL_RIM);
    mat.needsUpdate = true;
  }

  // 씬(또는 하위 그룹)을 훑어 대상 재질을 패치. 이미 패치된 재질은 즉시 스킵(멱등·저비용).
  //   마을 리롤·focus-in 오버레이(풀·소동물) 등 새 재질이 붙어도 재호출로 self-heal(post 가 throttle 로 호출).
  //   Points·스프라이트·물면/지형(이름)은 오브젝트 단위로 스킵하고 Shader 입자는 재질 타입에서 빠진다.
  function apply(root = scene) {
    if (!root) return;
    root.traverse((o) => {
      if (o.isPoints || o.isSprite) return;
      if (o.name && SKIP_NAMES.has(o.name)) return;
      const m = o.material;
      if (!m) return;
      const g = groupOf(o, Array.isArray(m) ? (m[0] || {}) : m);
      if (Array.isArray(m)) { for (const mm of m) patchMaterial(mm, g); }
      else patchMaterial(m, g);
    });
  }

  return {
    uniforms: u,
    apply,
    setColor(c) { u.uRimColor.value.copy(c); },
    setStrength(s) { u.uRimStrength.value = s; },
    setPower(p) { u.uRimPower.value = p; },
    // post 는 구 스크린패스 기준값을 축소해 넘긴다(cur.rimWrap × 0.4). 재질 프레넬의 반대편
    // 실루엣 잔여는 그보다 커야 그늘 처마선이 읽히므로 바닥값으로 받친다.
    setWrap(w) {
      u.uRimWrap.value = Math.max(RIM_WRAP_FLOOR, Number.isFinite(w) ? w : 0);
    },
    setScale(s) { u.uRimScale.value = s; },
    setNearFar(n, f) { u.uRimNear.value = n; u.uRimFar.value = f; },
    setSunViewDir(v) { u.uSunViewDir.value.copy(v); },
    // Product DoF plane. focusDepth = BokehPass axial focus (metres); amount 0 disables damp.
    setDofGate({ focusDepth, amount } = {}) {
      if (Number.isFinite(focusDepth) && focusDepth > 0) u.uRimFocusDepth.value = focusDepth;
      if (Number.isFinite(amount)) {
        u.uRimDofAmount.value = Math.min(1, Math.max(0, amount));
      }
    },
    get patchedCount() { return counts.total; },
    get coverage() { return { ...counts }; },
    get groupMultipliers() {
      return {
        building: groupUniforms.building.value,
        misc: groupUniforms.misc.value,
        organic: groupUniforms.organic.value,
        ground: groupUniforms.ground.value,
      };
    },
    // 패치 자체는 되돌리지 않되(셰이더는 무해히 잔존), 강도·마스터를 0 으로 눌러 잔여 림 소거.
    dispose() { u.uRimStrength.value = 0; u.uRimScale.value = 0; },
  };
}

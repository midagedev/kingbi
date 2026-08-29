import * as THREE from 'three';
import {
  addMaterialResource,
  addMaterialTextures,
  collectObjectResources,
  disposeObjectResources,
  disposeObjectTree,
} from '../../core/three-resources.js';
import { PRESETS, computeLayout } from '../../params.js';
import { buildBuilding } from '../../builder/index.js';
import { buildParcel } from '../../layout/parcel.js';
import { makeMaterials, applyThatchAge } from '../../builder/palette.js';
import { resolveDancheong } from '../../builder/dancheong.js';
import { buildPalaceCompound, disposePalaceCompound } from '../../village/palace.js';
import { buildTempleCompound, disposeTempleCompound } from '../../temple/compound.js';
import {
  TEMPLE_VARIANT_SPECS,
  planTempleCompound,
  templeVariantsForSize,
} from '../../temple/plan.js';
import { houseMatrix, parcelMatrix } from '../../village/instancing.js';
import { buildVillageWall } from '../../village/walls.js';
import { buildAuxiliaryBuilding } from '../../village/auxiliary-building-geometry.js';
import { planParcelAuxiliary } from '../../village/auxiliary-building-plan.js';
import { toneOf, variantMirrorX, variantOv } from '../../village/variants.js';
import {
  parcelHouseTranslation,
  parcelLocalPoint,
  parcelWorldPoint,
} from '../../village/parcel-contract.js';
import { parcelRoofPolygons } from '../../village/house-footprint.js';
import { impostorHouseSpec } from '../../village/impostor-spec.js';
import { parcelGroundY } from '../../village/solar-access.js';
import {
  captureParcelRebuildEnvelope,
  planParcelRebuild,
} from '../../village/parcel-rebuild.js';
import { setupClouds } from '../../env/clouds.js';
import * as G from '../../core/math/geom2.js';
import { withVillageRandomSeed } from './random-window.js';
import {
  createVillageLightRig,
  VILLAGE_LIGHT_BY_TIME,
} from './lighting.js';
import {
  applyMaterialRoleTints,
  buildParcelSpec,
  clampBuildingDimensions,
  isResidentialHouseOnlyEdit,
  isResidentialOpeningsOnlyEdit,
  isResidentialRoofToneOnlyEdit,
  isResidentialThatchOnlyEdit,
  parcelWallType,
  palaceCompoundDefaults,
  residentialRoofBoundsMatch,
  residentialYardSignature,
  resolveResidentialEdit,
} from './parcel-edit.js';
import {
  buildParcelPickProxies,
  buildLandmarkPickProxies,
  cloneCameraFraming,
  createParcelHighlight,
  focusTerrainCutawayForProxy,
  refreshPalacePickProxy,
  refreshParcelPickProxy,
  refreshTemplePickProxy,
} from './picking.js';
import { createVillageNightGlow } from './night-glow.js';
import { createVillageSnowController } from './snow.js';
import { createVillageAmbientFieldController } from './ambient-field.js';
import { createVillageFaunaController } from './fauna.js';
import {
  parcelRepresentationState,
  setParcelBaseHidden,
  setParcelBaseExportHidden,
} from './parcel-representation.js';
import { createVillageDetailLodState, villageDetailWeightAt } from './detail-lod.js';
import { createThresholdLifeRuntime } from './threshold-life.js';
import { yardHardObstacles, yardTreeIntersectsHardObstacle } from '../../village/yard-layout.js';
import { yardLifeRecordsToHardObstacles } from '../../village/yard-life-plan.js';
import { yardCanopyBlocked } from '../../village/vegetation-spatial.js';
import { RESIDENTIAL_OPENING_PARAM_KEYS } from '../../layout/residential-openings.js';
import { createPrimaryDoorRuntime } from '../../interaction/primary-door.js';
import { createVillageDoorOcclusion } from './door-occlusion.js';
import { buildMjaHouse, disposeMjaHouse } from '../../village/mja-house-geometry.js';

const PERSISTENT_YARD_FIELDS = Object.freeze([
  'wallType', 'aux', 'jangdok', 'yardStack', 'clothesline', 'vegBed',
]);

function isProductPrimaryDoorParcel(parcel) {
  if (!parcel || (parcel.kind !== 'giwa' && parcel.kind !== 'choga')) return false;
  if (parcel.mjaHouse) return false;
  // `hero` is a camera/editing class, not a residential role: town/capital use
  // heroStyle=palace for magistracy/guest-house cores. Require the authored
  // hanok role explicitly instead of treating every hero as the head household.
  return parcel.hero === true ? parcel.heroStyle === 'hanok' : parcel.heroStyle == null;
}

// v4 마을 어댑터 — 앱 실시간 파이프라인과 마을 생성기 사이의 단일 계약면.
//   createVillage(opts) → VillageHandle
//     opts: { scale, character, includePalace, includeTemple, seed }
//
// VillageHandle (UI 소비 API):
//   .group            THREE.Group — scene 에 add 할 마을 루트(지형·집·랜드마크·수목 포함)
//   .plan             planVillage 원본 데이터(집 목록·통계·경계)
//   .getPickProxy(id) / .getPickProxies() → [{ parcelId, mesh, bbox, buildingSpec, worldCenter, cameraFraming }]
//   .raycast(raycaster) → 위 프록시 디스크립터 | null (히트한 필지)
//   .rebuildParcel(parcelId, newParams) → 해당 필지만 풀디테일로 재생성(집 편집 반영)
//   .highlightParcel(parcelId, on)      → 먹선 아웃라인 하이라이트 토글(호버 표시)
//   .setTime(name, opts) / .setSeason(name, opts) / .setWeather(name, opts)  → env 상태 전파
//   .update(dt)       매 프레임(개울 물결·야간 촛불 일렁임)
//   .prepareWavePresentation(app)                   → 새 마을 scene-direct 앰비언스만 사전 연결
//   .enterVillageMode(app) / .exitVillageMode(app)  → 앱 단일건물 씬 ↔ 마을 씬 스왑
//   .dispose()        지오·텍스처 해제
//
// 성능: 정규 주택은 instancing.js 로 재질별 InstancedMesh, 담·도로·논·랜드마크는 재질별
//   정적 병합(populate.js optimize) → capital 68호 드로우콜 8,700+ → 수백 규모.
// 픽킹: 실제 메시가 아닌 필지 프록시(바운딩 박스) 레이캐스트 — 지붕·담·마당 어디든 그 집이 잡힘.

// plan+group 이후 핸들(VillageHandle) 조립 — 동기/비동기 경로가 공유(THREE 오브젝트 확정 후, 시드창 무관).
export function createVillageHandle(opts, seed, plan, group) {
  let disposed = false;
  const char01 = typeof plan.opts.char01 === 'number' ? plan.opts.char01 : 0.5;
  const site = plan.site;

  // 오버레이 재생성(단일 필지 리롤 #100)용 결정론 난수 창 — createVillage 진입부와 동형(같은 시드→같은
  //   텍스처·싸리문·소품). 새 필지 시드로 감싸 buildBuilding/buildParcel/buildPalaceCompound 를 굴린 뒤 원복.
  const withSeededBuild = withVillageRandomSeed;
  const handle = group.userData.houseHandle;   // { giwa, choga } InstancedMesh 그룹(또는 null)
  const treeOccluder = group.getObjectByName('village-trees')?.userData?.occluder || null;
  // focus 컷어웨이 동반 은닉: near plane 이 전경 능선을 걷어내면 그 능선에 서 있던 산 나무만 남아
  //   공중에 뜬다(지형면은 near 안쪽, 수관은 near 밖). 같은 instFade 어휘로 컷 구간 인스턴스를 통째로
  //   걷으면 색·DoF depth·먹 노멀 패스가 이미 동일 픽셀을 discard 하므로 새 패스·재질·드로우콜이 없다.
  //   숲은 화면중심 오클루전 페이드에는 참여하지 않는다(cutOnly) — 능선 숲은 원래 보여야 한다.
  treeOccluder?.register(group.getObjectByName('village-forest'), { canopyY: 0, cutOnly: true });
  // Pointer input must not raycast Hanyang's tens of thousands of visible
  // instances. Build a renderer-free semantic grid once, then refresh only the
  // parcel/flora records whose authoritative plan data actually changes.
  const primaryDoorOcclusion = createVillageDoorOcclusion({
    plan,
    site,
    yardTrees: group.userData.yardTreeAnchors,
    guardianTrees: group.userData.guardianAnchors,
  });
  const primaryDoorOcclusionQuery = {
    excludeParcelId: null,
    season: 'summer',
  };

  // ── 편집 오버레이 계층: rebuildParcel 이 만든 개별(풀디테일) 필지를 담는다. ──
  const overrides = new THREE.Group(); overrides.name = 'village-overrides';
  group.add(overrides);
  const overrideById = new Map();                 // parcelId -> THREE.Group
  // A committed edit remains authoritative in the aerial scene, but only the
  // parcel currently in focus must be excluded from the camera-proximity
  // ambience field. Keeping persistence and focus ownership separate prevents
  // a rebuilt house from permanently losing chimney smoke after focus-out.
  const focusedResidentialIds = new Set();
  const persistentOverrideIds = new Set();        // edited/rebuilt parcels remain authoritative in aerial view
  // Last accepted declarative state for each authoritative residential overlay.
  // Geometry is disposable; this renderer-free snapshot survives focus hops and
  // makes every optional rebuild payload a patch rather than an accidental reset.
  const committedResidentialSpecs = new Map();    // parcelId -> normalized buildParcelSpec-compatible value
  // URL/share may serialize only kind + the six opening axes. Mark a parcel
  // only when one of those values actually diverges; roof/yard-only edits and a
  // full parcel reroll cannot be truthfully reconstructed by that compact form.
  const shareableResidentialIds = new Set();
  // Residential FULL overlays have one authored household primary door. Palace,
  // temple, and palace-style magistracy compounds deliberately stay out: their
  // hierarchy has no product-authorized single leaf, and optimized roots may
  // merge semantics.
  const primaryDoorById = new Map();              // no listeners or GPU ownership
  const rebuildEnvelopeById = new Map(plan.parcels.map((parcel) => [
    parcel.id,
    captureParcelRebuildEnvelope(parcel),
  ]));
  const editWallMats = makeMaterials('giwa');      // 편집 담장 공유 재질(base 씬 wallMats 와 동일 팔레트)
  let representationDirty = false;                 // base/overlay caster 소유권 변경 → 그림자 캐시 1회 갱신

  function releasePrimaryDoor(parcelId) {
    const runtime = primaryDoorById.get(parcelId);
    if (!runtime) return;
    runtime.dispose();
    primaryDoorById.delete(parcelId);
    representationDirty = true;
  }

  function activatePrimaryDoor(parcelId, root) {
    releasePrimaryDoor(parcelId);
    const parcel = plan.parcels.find((candidate) => candidate.id === parcelId);
    if (!isProductPrimaryDoorParcel(parcel)) return null;
    const runtime = createPrimaryDoorRuntime(root);
    if (runtime) primaryDoorById.set(parcelId, runtime);
    return runtime;
  }

  function setResidentialBaseHidden(parcel, hidden) {
    if (setParcelBaseHidden(handle, parcel, hidden)) representationDirty = true;
  }

  function setResidentialBaseExportHidden(parcel, hidden) {
    setParcelBaseExportHidden(handle, parcel, hidden);
  }

  // ── #129 오버레이 셰이더 프로그램 앵커(반복 focus-in/hop 재컴파일 방지) ────────────
  //   focus-in/hop/리롤마다 오버레이(비인스턴스 풀디테일)가 makeMaterials/buildParcel 로 새 재질을
  //   만들고 focus-out 에서 disposeTree 로 dispose 한다. three 는 재질 dispose 시 그 프로그램의
  //   usedTimes 를 0 으로 떨궈 GL 프로그램을 캐시에서 삭제 → 다음 오버레이가 동일 cacheKey 재질을 다시
  //   컴파일한다(전환 히치 잔여, #128 후속). 인스턴스드 마을 재질은 USE_INSTANCING define 으로 cacheKey 가
  //   달라 비인스턴스 오버레이 프로그램을 공유하지 못한다 → 오버레이 프로그램은 오버레이 전용으로,
  //   매번 삭제·재컴파일된다.
  //   대책: 오버레이 "종류(kind×눈상태)"의 첫 빌드 재질 1벌을 __kept 로 표시해 영구 미dispose 앵커로
  //   삼는다. 앵커 재질은 그 오버레이가 최소 1프레임 렌더될 때 프로그램을 획득하고, 이후 오버레이가
  //   dispose 돼도(disposeTree 가 __kept 건너뜀) 살아 usedTimes≥1 을 유지 → 프로그램이 캐시에 남는다.
  //   그 뒤 빌드의 새 재질은 동일 cacheKey 로 컴파일 없이 재사용(색은 uniform 이라 cacheKey 불변 —
  //   부위별 곱틴트 #55·편집 라이브 반영 #48 무영향). #131 눈틴트: injectSnow 후 retain 하고 anchorKey 에
  //   |snow 를 붙여 snowtint cacheKey 변형까지 앵커에 포함(맑음/눈 각각 1벌). 앵커는 dispose() 에서만 해제.
  const _anchoredKinds = new Set();
  const keptMats = [];   // 프로그램 앵커(영구 보존) — 전 마을 수명 동안 미dispose
  function retainOverlayPrograms(root, anchorKey) {
    if (!root || _anchoredKinds.has(anchorKey)) return;
    _anchoredKinds.add(anchorKey);
    root.traverse((o) => {
      const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of list) {
        if (m && m.userData && !m.userData.__kept) { m.userData.__kept = true; keptMats.push(m); }
      }
    });
  }
  // 편집 담장 공유 재질은 전 오버레이가 재사용하는 영구 1벌 → 앵커로 고정(오버레이 dispose 가 이를
  //   해제하던 잠재 결함도 차단: 공유 재질이 dispose 되면 다음 오버레이가 그 재질을 재컴파일했다).
  for (const k in editWallMats) {
    const m = editWallMats[k];
    if (m && m.isMaterial && m.userData && !m.userData.__kept) { m.userData.__kept = true; keptMats.push(m); }
  }

  // ── 하이라이트(실제 지붕 처마 모서리 표식) — 깊이 가림되는 선 자원 1벌을 재사용. ──
  const hi = createParcelHighlight();
  hi.clear();
  group.add(hi.group);
  let highlighted = null;

  function residentialHighlightMarker(parcel, proxy) {
    const baseY = parcelGroundY(parcel, site);
    const explicit = parcel.editRoofBounds;
    if (explicit && [explicit.minX, explicit.maxX, explicit.minZ, explicit.maxZ].every(Number.isFinite)) {
      const params = proxy.buildingSpec?.params || {};
      const kind = proxy.buildingSpec?.kind === 'giwa' ? 'giwa' : 'choga';
      const layout = computeLayout({ ...PRESETS[kind], ...params });
      const scaleY = (Number.isFinite(parcel.sy) ? parcel.sy : 1)
        * (Number.isFinite(params.footprintScale) ? params.footprintScale : 1);
      return {
        contours: [{
          polygon: [
            parcelWorldPoint(parcel, { x: explicit.maxX, z: explicit.maxZ }),
            parcelWorldPoint(parcel, { x: explicit.minX, z: explicit.maxZ }),
            parcelWorldPoint(parcel, { x: explicit.minX, z: explicit.minZ }),
            parcelWorldPoint(parcel, { x: explicit.maxX, z: explicit.minZ }),
          ],
          y: baseY + layout.eaveEdgeY * scaleY,
        }],
        source: 'edited-roof-footprint',
      };
    }

    const polygons = parcelRoofPolygons(parcel);
    if (parcel.mjaHouse?.kind === 'mja-banga') {
      const wingEaves = parcel.mjaHouse.wings.map((wing) => (
        wing.building.podiumTierH + wing.building.columnHeight + 0.35
      ));
      const gateWing = parcel.mjaHouse.wings.find((wing) => wing.id === parcel.mjaHouse.gate?.wingId);
      const gateEave = gateWing
        ? gateWing.building.podiumTierH + gateWing.building.columnHeight + 0.35
        : wingEaves.at(-1);
      return {
        contours: polygons.map((polygon, index) => ({
          polygon,
          y: baseY + (index < wingEaves.length ? wingEaves[index] : gateEave),
        })),
        source: 'roof-footprints',
      };
    }

    const spec = impostorHouseSpec(parcel);
    const scaleY = Number.isFinite(parcel.sy) ? parcel.sy : 1;
    return {
      contours: polygons.map((polygon, index) => ({
        polygon,
        y: baseY + (spec.roofs[index]?.eaveY ?? spec.body.y1) * scaleY,
      })),
      source: polygons.length > 1 ? 'roof-footprints' : 'roof-footprint',
    };
  }

  // ── 픽킹 프록시(필지 바운딩) — 렌더 트리에 넣지 않고 레이캐스트 전용. ──
  const proxies = buildParcelPickProxies(plan, site);
  const proxyGroup = new THREE.Group();          // scene 미포함(렌더 안 함) — 월드좌표 프록시
  for (const p of proxies) proxyGroup.add(p.mesh);
  proxyGroup.updateMatrixWorld(true);
  const proxyById = new Map(proxies.map((p) => [p.parcelId, p]));

  // 소유 경계 밖으로는 가변 Vector/Box를 복제해 내보낸다. 전체·단건 API가 같은
  // 디스크립터 계약을 공유해 hero 카메라용 치수 필드가 누락되지 않게 한다.
  function describePickProxy(p) {
    if (!p) return null;
    return {
      parcelId: p.parcelId, mesh: p.mesh, bbox: p.bbox.clone(),
      focusBounds: p.focusBounds?.clone?.() || p.bbox.clone(),
      focusSubject: p.focusSubject ? structuredClone(p.focusSubject) : null,
      buildingSpec: p.buildingSpec, worldCenter: p.worldCenter.clone(),
      baseCameraFraming: cloneCameraFraming(p.baseCameraFraming || p.cameraFraming),
      cameraFraming: cloneCameraFraming(p.cameraFraming),
      cameraVisibility: p.cameraVisibility ? structuredClone(p.cameraVisibility) : null,
      baseHeroCameraFraming: p.baseHeroCameraFraming
        ? cloneCameraFraming(p.baseHeroCameraFraming) : null,
      heroCameraFraming: p.heroCameraFraming
        ? cloneCameraFraming(p.heroCameraFraming) : null,
      heroCameraVisibility: p.heroCameraVisibility
        ? structuredClone(p.heroCameraVisibility) : null,
      dims: p.dims.clone(), rotY: p.rotY,
      H: p.dims.y, maxDim: Math.max(p.dims.x, p.dims.y, p.dims.z),
    };
  }

  // ── env 상태 ──
  let time = 'day', season = 'summer', weather = 'clear';
  const thresholdLife = createThresholdLifeRuntime();
  const thresholdLifeCondition = () => weather === 'rain' ? 'wet' : 'dry';

  function refreshFocusedThresholdLife() {
    for (const parcelId of focusedResidentialIds) {
      thresholdLife.attach(overrideById.get(parcelId), thresholdLifeCondition());
    }
    for (const record of heroOverrides.values()) {
      thresholdLife.attach(record.group, thresholdLifeCondition());
    }
  }
  let detailLod = null;
  const yardLifeWeightAt = (point) => villageDetailWeightAt(detailLod, point);
  const nightGlow = createVillageNightGlow(
    group,
    (dt, level) => group.userData.updateNightLights?.(dt, level, detailLod?.lensScale ?? 1),
  );
  // FULL overlays own fresh hanji materials and renderer-authored opening
  // anchors. Keep material emissive ownership and the single physical batch owner slot
  // in lockstep, but only at overlay lifecycle events (never per frame).
  const residentialGlowById = new Map();
  const refreshNightLightOwner = (ownerId, overlayRoot = null) => {
    group.userData.refreshNightLights?.(ownerId, overlayRoot);
  };
  // Transient suppress for one owner's physical nightlight rows (hero assembly /
  // landing). Does not delete permanent ownership — only zeroes emitted slots.
  const setNightLightOwnerSuppressed = (ownerId, suppressed = true) =>
    group.userData.setNightLightOwnerSuppressed?.(ownerId, suppressed) || false;
  function registerResidentialGlow(parcelId, root) {
    const previous = residentialGlowById.get(parcelId);
    if (previous) nightGlow.remove(previous);
    const owner = nightGlow.add(root, `residential:${parcelId}`);
    residentialGlowById.set(parcelId, owner);
    refreshNightLightOwner(parcelId, root);
  }
  function releaseResidentialGlow(parcelId, restoreBase = true) {
    const owner = residentialGlowById.get(parcelId);
    if (owner) nightGlow.remove(owner);
    residentialGlowById.delete(parcelId);
    // Always clear assembly suppress before restoring base anchors so a focus
    // teardown cannot leave the permanent owner dark in aerial night.
    setNightLightOwnerSuppressed(parcelId, false);
    if (restoreBase) refreshNightLightOwner(parcelId, null);
  }

  // ── 마을 전용 조명 리그(태스크 #44). scene 에 add/remove 로 마을 활성 동안만 유효. ──
  const vlights = createVillageLightRig();

  // ── 마을 fog 거리 모디파이어(태스크 #50). env 가 시간대 크로스페이드 중 매 틱 base fog 를
  //    다시 쓰므로(near/far=시간대 값), 마을 부감에 맞는 넓은 거리로 다시 늘린다. 색은 env 소유
  //    (시간대 크로스페이드)로 두고 near/far 만 오버라이드 — engine.reapplyVillageFog 와 동일 값
  //    (R*2.2/R*7.0)이라 멱등. enterVillageMode 에서 env.addFogModifier 로 등록. ──
  const villageFogR = (site && typeof site.R === 'number' && site.R > 0) ? site.R : 150;
  vlights.setSiteRadius(villageFogR);   // 규모 인지 골든아워 감쇠(#119) — 큰 규모 능선 화염 억제
  const villageFog = (scn) => {
    if (scn.fog) {
      scn.fog.near = villageFogR * 2.2; scn.fog.far = villageFogR * 7.0;
      // 지형 엣지 소실 헤이즈·운해 링 색을 대기(fog)색과 동기화(#50 시간대 크로스페이드 자동 정합).
      group.userData.setEnvHaze?.(scn.fog.color);
    }
  };

  // ── 흐르는 구름 그림자 빌보드(태스크 #57) ──────────────────────────────────
  // 빌보드는 태양 상태를 매 프레임 판독하므로 sun 이 필요 → 마을 진입(enterVillageMode)에서 scene 의
  //   sun 을 찾아 마을 그룹에 붙인다(env.group.visible 토글에 안 묶임). 그림자 uniform 은 populate 가
  //   지형 재질과 공유(group.userData.cloudUniforms) → 빌보드 update 가 그 uniform 을 갱신해 지면에 그늘.
  //   이탈 시 정리. 재진입마다 새로 붙여 중복·표류 누적 방지(shot·?clouds=0 은 clouds.js 가 처리).
  let cloudsHandle = null;
  function attachClouds(scene) {
    if (cloudsHandle) return;
    const sun = findSun(scene);
    if (!sun) return;
    cloudsHandle = setupClouds(group, {
      sun, edge: group.userData.edge || site.edge,
      terrainMax: group.userData.terrainMax || site.terrainR || 150,
      uniforms: group.userData.cloudUniforms,
      mistBillboards: false,   // 마을은 유기적 운해 링·능선 물안개(populate)가 산허리 물안개 역할 — 중복 제거
      highCloudCount: 4,       // 뭉게구름 4장(=대응 그림자 블롭 4). 마을에 드리우는 그림자 가독 확보(#68)
      // 구름 그림자 커버리지 정밀화(#108 후속): 어댑터가 아는 마을 실반경(site.R)을 프레임 반경으로 넘겨
      //   블롭·그림자를 마을 중심 원(원점)에 가둔다(terrainMax*0.42 파생 대신 실측 — 프레임 밖 표류 감소).
      siteCenter: { x: 0, z: 0 }, coverR: villageFogR,
      getHaze: () => scene.fog?.color || null,
    });
  }
  function detachClouds() {
    if (!cloudsHandle) return;
    group.remove(cloudsHandle.group);
    cloudsHandle.dispose?.();
    cloudsHandle = null;
    // 지형 그림자 uniform 을 0 으로 되돌려(빌보드 없는 상태) 잔여 그늘이 남지 않게.
    const cu = group.userData.cloudUniforms;
    if (cu) cu.uCloudStr.value = 0;
  }

  // ── 히어로(종가) 포커스 — 랜딩·클로즈업·리플레이·편집을 위한 풀디테일 오버레이(#62·#59). ──
  //   종가는 정자·다리·소품과 함께 'village-landmarks' 로 정적 병합돼 개별 분리가 안 된다. populate
  //   가 히어로를 개별 그룹으로 노출(root.userData.heroHandle: Map<id,group>)하면 그 그룹만 가리고,
  //   없으면 merged 랜드마크를 통째로 가리는 폴백(랜딩/리플레이는 먹안개로 마스킹, 근접 소품 일시 은닉).
  //   오버레이는 buildParcel 컴파운드(병합본과 동일 지오) → playAssembly 로 조립·리플레이, 편집 시
  //   roofOpts 를 buildParcel 로 포워딩(코어 지원 시 반영).
  const heroHandle = group.userData.heroHandle instanceof Map ? group.userData.heroHandle : null;
  const heroParcels = plan.parcels.filter((p) => p.hero);
  const primaryHero = heroParcels.find((p) => p.heroStyle === 'hanok') || heroParcels[0] || null;
  const landmarksGroup = () => group.getObjectByName('village-landmarks');
  // 히어로 필지 편집 가능 여부(heroHandle 있어야 종가만 분리 은닉 가능). 프록시 스펙에 반영 —
  //   editable: 패널이 컨트롤을 열지 판단, compound: 컴파운드(hanok 종가)라 유형탭·칸수 대신 매무새만 노출.
  for (const p of proxies) {
    if (p.buildingSpec && p.buildingSpec.hero) {
      const parcel = heroParcels.find((candidate) => candidate.id === p.parcelId);
      p.buildingSpec.editable = !!heroHandle && !parcel?.mjaHouse;
      p.buildingSpec.compound = true;
    }
  }
  const heroOverrides = new Map();   // hero parcelId -> { id, group, glow }; hop 동안 A/B 동시 소유
  let activeHeroId = null;           // 기존 무인자 heroDetailGroup()이 돌려줄 마지막 hero
  let landmarksHidden = false;   // 폴백: merged 랜드마크 통째 은닉 여부

  // building 편집 파라미터 → buildHanok roofOpts(eaveOverhang·profileCurve·riseScale=물매).
  //   패널 키: roofCurve/profileCurve → profileCurve, eaveOverhang → eaveOverhang. 물매(riseScale)는
  //   전용 축 범위가 필요해 #48 에서 확장(현재 roofPitch/riseScale 직결은 하위호환 유지).
  function heroRoofOpts(building) {
    if (!building) return null;
    const o = {};
    if (building.roofPitch != null) o.riseScale = building.roofPitch;
    if (building.riseScale != null) o.riseScale = building.riseScale;
    if (building.eaveOverhang != null) o.eaveOverhang = building.eaveOverhang;
    if (building.profileCurve != null) o.profileCurve = building.profileCurve;
    if (building.roofCurve != null) o.profileCurve = building.roofCurve;
    return Object.keys(o).length ? o : null;
  }
  // 특수 필지 편집(#48) — heroStyle 별로 buildParcel 편집 계약을 조립한다.
  //   hanok(종가): buildHanok roofOpts(지붕 매무새) + wallH(벽 높이).
  //   palace(관아·객사, 다포 전각): buildBuilding presetOverrides(공포·월대·지붕·평면 등).
  //   레거시 building 오버라이드 경로(구 패널)는 heroRoofOpts / presetOverrides 폴백으로 계속 수용.
  function heroEditOpts(parcel, np) {
    if ((parcel.heroStyle || 'hanok') === 'hanok') {
      const roofOpts = { ...(np.roofOpts || {}) };
      const legacy = heroRoofOpts(np.building);
      if (legacy) for (const k in legacy) if (roofOpts[k] == null) roofOpts[k] = legacy[k];
      const eo = {};
      if (Object.keys(roofOpts).length) eo.roofOpts = roofOpts;
      if (np.wallH != null) eo.wallH = np.wallH;
      return eo;
    }
    const presetOverrides = { ...(np.presetOverrides || np.building || {}) };
    return Object.keys(presetOverrides).length ? { presetOverrides } : {};
  }
  function buildHeroCompound(parcel, editOpts = {}) {
    const g = new THREE.Group();
    g.name = `hero-override-${parcel.id}`;
    g.userData.snowRoofKind = 'giwa';   // 종가(한옥)=기와 지붕 — 눈 흰틴트 게이트(#131)
    g.userData.W = parcel.plotW || 20;
    g.userData.D = parcel.plotD || 18;
    g.userData.style = parcel.heroStyle || 'hanok';
    g.userData.parcel = parcel;
    if (parcel.mjaHouse) {
      const compound = buildMjaHouse(parcel.mjaHouse);
      g.add(compound);
      // Exact reusable lifecycle first; remove the released subtree so the
      // generic outer overlay cleanup can safely dispose threshold/glow extras
      // without double-disposing compound resources.
      g.userData.disposeCompound = () => {
        const disposed = disposeMjaHouse(compound);
        compound.removeFromParent();
        return disposed;
      };
      g.userData.mjaHouse = true;
    } else {
      const heroStyle = parcel.heroStyle || 'hanok';
      const opts = {
        seed: parcel.seed || 7,
        style: heroStyle,
        plotW: parcel.plotW,
        plotD: parcel.plotD,
        roofRank: parcel.roofRank
          ?? (heroStyle === 'palace' ? 'magistracy' : null),
      };
      if (editOpts.roofOpts) opts.roofOpts = editOpts.roofOpts;
      if (editOpts.presetOverrides) opts.presetOverrides = editOpts.presetOverrides;
      if (editOpts.wallH != null) opts.wallH = editOpts.wallH;
      g.add(buildParcel(opts));
    }
    g.rotation.y = G.facingY(parcel.frontDir);
    g.position.set(parcel.center.x, parcel.baseY != null ? parcel.baseY : 0, parcel.center.z);
    return g;
  }
  // 히어로를 풀디테일 오버레이로 표시(원본 종가는 가림). 반환: 오버레이 그룹(조립·편집 대상).
  //   editOpts 무전달(랜딩·리플레이)이면 기본 컴파운드, 편집 시엔 heroEditOpts 결과를 포워딩.
  function showHeroDetail(parcelId, editOpts) {
    const parcel = heroParcels.find((p) => p.id === parcelId);
    if (!parcel) return null;
    // 같은 hero의 편집/리롤만 교체한다. 다른 hero A는 hop 도착까지 유지하고 엔진이 A id로 해제한다.
    hideHeroDetail(parcelId);
    const opts = editOpts || {};
    const g = buildHeroCompound(parcel, opts);
    if (!parcel.mjaHouse) thresholdLife.attach(g, thresholdLifeCondition());
    overrides.add(g);
    if (snow.isActive()) snow.inject(g);
    const rec = { id: parcelId, group: g };
    heroOverrides.set(parcelId, rec);
    activeHeroId = parcelId;
    // 생성 뒤 얹는 focus overlay의 한지 재질도 현재 시간대의 창호 발광 수명에 합류시킨다.
    const hg = nightGlow.add(g, `hero:${parcelId}`);
    if (hg.length) rec.glow = hg;
    refreshNightLightOwner(parcelId, g);
    if (heroHandle && heroHandle.get(parcelId)) heroHandle.get(parcelId).visible = false;
    else { const lm = landmarksGroup(); if (lm) { lm.visible = false; landmarksHidden = true; } }
    representationDirty = true;
    if (!parcel.mjaHouse) {
      retainOverlayPrograms(
        g,
        'hero-' + (parcel.heroStyle || 'hanok') + (snow.isActive() ? '|snow' : ''),
      );
    }
    activatePrimaryDoor(parcelId, g);
    // Stamp a panel-facing editSpec and refresh the pick proxy so commit / re-focus
    // cannot reseat the inspector from pre-edit hero defaults (live-edit pointer-up).
    const proxy = proxyById.get(parcelId);
    if (proxy?.buildingSpec) {
      const params = { ...(proxy.buildingSpec.params || {}) };
      if (opts.roofOpts) Object.assign(params, opts.roofOpts);
      if (opts.presetOverrides) Object.assign(params, opts.presetOverrides);
      if (opts.wallH != null) params.wallH = opts.wallH;
      const editSpec = { ...proxy.buildingSpec, params };
      g.userData.editSpec = editSpec;
      proxy.buildingSpec = editSpec;
    }
    return g;
  }
  function hideHeroDetail(parcelId = null) {
    const ids = parcelId == null ? [...heroOverrides.keys()] : [parcelId];
    let changed = false;
    for (const id of ids) {
      const rec = heroOverrides.get(id);
      if (!rec) continue;
      releasePrimaryDoor(id);
      nightGlow.remove(rec.glow);
      // Clear assembly suppress first so base-anchor restore can emit again.
      setNightLightOwnerSuppressed(id, false);
      refreshNightLightOwner(id, null);
      rec.group.userData.disposeCompound?.();
      disposeTree(rec.group); overrides.remove(rec.group); heroOverrides.delete(id);
      if (heroHandle?.get(id)) heroHandle.get(id).visible = true;
      changed = true;
    }
    if (!heroOverrides.size && landmarksHidden) {
      const lm = landmarksGroup();
      if (lm) lm.visible = true;
      landmarksHidden = false;
      changed = true;
    }
    if (activeHeroId && !heroOverrides.has(activeHeroId)) {
      const remaining = [...heroOverrides.keys()];
      activeHeroId = remaining.length ? remaining[remaining.length - 1] : null;
    }
    if (changed) representationDirty = true;
  }

  // ── 궁궐 다일곽 컴파운드 focus·편집(#93) ─────────────────────────────────────
  //   #88 이 마을 궁을 features.palace 다일곽 컴파운드로 격상하며 편집 승격 규약을 노출했다.
  //   populate 는 palace-core 를 landmarks 병합에서 빼 미병합 그룹으로 root.userData.palaceCore 에 노출
  //   (히어로와 동형 — 병합본이면 편집용 분리가 불가하므로). 그 규약이 아직 안 깔린 빌드에선 palaceCore
  //   가 없어 아래 전부 graceful no-op(궁 focus 는 프록시만 있고 편집 불가로 폴백).
  //   focus-in: palaceCore 를 가리고 buildPalaceCompound 오버레이(편집 가능)를 같은 자리에 얹는다.
  //   편집: 오버레이를 presetOverrides 로 재생성(일곽 단위 병합 유지 — 드로우콜 회귀 없음).
  //   focus-out: 오버레이 폐기 + palaceCore 복원.
  const palaceCore = group.userData.palaceCore || null;                        // 미병합 palace-core 그룹(편집 메타 소스) | null
  // #140-B 부감 병합본. optimize 시 populate 가 palaceCore 를 재질별로 접어(palace-merged) 씬에 얹고
  //   palaceCore 지오는 dispose(메타·재질만 보존) → 부감 −~350 콜·힙. focus-in 은 이 병합본을 가리고
  //   미병합 오버레이(buildPalaceCompound)로 교체(히어로 heroHandle #62 동형). 비최적화·구빌드면 null 이라
  //   palaceCore(씬에 상주) 를 대신 토글(폴백). 아래 palaceVisNode 가 "부감에 보이는 궁 노드"를 가리킨다.
  const palaceMerged = group.userData.palaceMerged || null;                    // 부감 병합본(씬 상주) | null
  const palaceVisNode = palaceMerged || palaceCore;                            // focus 시 가릴 대상(병합본 우선, 없으면 미병합)
  const palaceCompound = palaceCore ? (palaceCore.userData.palaceCompound || null) : null;  // buildPalaceCompound 루트(편집 메타)
  const palaceInner = palaceCompound ? palaceCompound.parent : null;           // 배치 변환(위치·회전) 보유 그룹
  const palaceHandle = palaceCompound ? (palaceCompound.userData.palaceHandle || null) : null;
  let palaceOverride = null;     // { group, comp, glow } 표시 중 오버레이
  let palaceHidden = false;      // palaceCore 은닉 여부
  let palaceCurrentOverrides = {};
  let palaceDancheong = resolveDancheong('palace', palaceHandle?.dancheong || PRESETS.korea);
  const palaceEditable = () => !!(palaceCompound && palaceInner && palaceHandle);

  // 편집 오버레이 컴파운드 — 원본과 동일 배치·재질·seed 로 재생성, presetOverrides 만 얹는다.
  function buildPalaceOverlay(presetOverrides) {
    const ph = palaceHandle;
    const g = new THREE.Group();
    g.name = 'palace-override';
    g.userData.snowRoofKind = 'giwa';   // 궁 전각=기와 지붕 — 눈 흰틴트 게이트(#131)
    const comp = buildPalaceCompound({
      w: ph.regionW, d: ph.regionD, tier: ph.tier, variant: ph.variant,
      seed: ph.seed != null ? ph.seed : 5,
      presetOverrides: presetOverrides || null,      // 코어 B 미반영 빌드에선 palace.js 가 무시(안전)
      dancheong: palaceDancheong,
    });
    g.add(comp);
    g.rotation.y = palaceInner.rotation.y;
    g.position.copy(palaceInner.position);           // palace-core 은 root 직속·무변환 → inner 로컬 = group 로컬 = overrides 로컬
    return g;
  }
  function showPalaceDetail(presetOverrides) {
    if (!palaceEditable()) return null;
    if (presetOverrides) {
      palaceCurrentOverrides = { ...palaceCurrentOverrides, ...presetOverrides };
      palaceDancheong = resolveDancheong('palace', {
        ...palaceDancheong,
        ...palaceCurrentOverrides,
      });
    }
    hidePalaceDetail();
    const activeOverrides = Object.keys(palaceCurrentOverrides).length ? palaceCurrentOverrides : null;
    const g = buildPalaceOverlay(activeOverrides);
    overrides.add(g);
    palaceOverride = { group: g, comp: g.children[0], glow: nightGlow.add(g, 'palace') };
    refreshNightLightOwner('palace', g);
    if (palaceVisNode) palaceVisNode.visible = false; palaceHidden = true;   // #140-B 부감 병합본(또는 미병합 폴백) 은닉
    representationDirty = true;
    // Panel commit path reads userData.editSpec first so pointer-up cannot reseat
    // sliders from a stale pick-proxy snapshot.
    g.userData.editSpec = palaceSpec();
    return g;
  }
  function hidePalaceDetail() {
    const changed = !!palaceOverride || palaceHidden;
    if (palaceOverride) {
      // 오버레이는 독립 팔레트를 소유한다. 원본과 texture source 픽셀은 캐시해도 Texture/Material
      // 객체는 공유하지 않으므로 다른 궁의 단청 상태와 dispose 수명이 서로 오염되지 않는다.
      nightGlow.remove(palaceOverride.glow);
      refreshNightLightOwner('palace', null);
      disposePalaceCompound(palaceOverride.comp);
      overrides.remove(palaceOverride.group); palaceOverride = null;
    }
    if (palaceHidden && palaceVisNode) { palaceVisNode.visible = true; palaceHidden = false; }   // #140-B 병합본 복원
    if (changed) representationDirty = true;
  }
  // 궁 편집 패널 명세(#93). family 'palace-compound' 로 edit-schema 가 궁 전용 스키마를 연다.
  //   editable 은 palaceCore(미병합 핸들) 유무 — 없으면 focus·프레이밍만 되고 편집은 비활성.
  //   축은 전 전각 일괄(공포·지붕·처마) 만 — 일곽 구조 종속(칸수·월대단수)은 배제(다일곽 일관성).
  function palaceSpec() {
    const tier = palaceHandle ? palaceHandle.tier : (plan.features?.palace?.tier || 'capital');
    return {
      parcelId: 'palace', family: 'palace-compound', style: 'palace', palace: true,
      tier, editable: palaceEditable(),
      params: {
        ...palaceCompoundDefaults(),
        ...palaceCurrentOverrides,
        dancheongClarity: palaceDancheong.dancheongClarity,
        dancheongSplendor: palaceDancheong.dancheongSplendor,
      },
    };
  }

  // ── 재사용 사찰 컴파운드 focus·편집 (#12) ────────────────────────────────
  // The optimized aerial compound and the site apron/path are separate. Focus
  // swaps only the architecture, so the approach never disappears under the
  // camera. All edits regenerate a pure TemplePlan inside the footprint that
  // site planning already reserved.
  const templeCore = group.userData.templeCore || null;
  const templeMerged = group.userData.templeMerged || null;
  const templeVisNode = templeMerged || templeCore;
  const templeCompound = templeCore?.userData?.templeCompound || null;
  const templeInner = templeCore?.userData?.templeInner || templeCompound?.parent || null;
  const templeHandle = templeCompound?.userData?.templeHandle || null;
  const templeFeature = plan.features?.temple || null;
  const templeLimit = Math.max(
    templeFeature?.compoundWidth || templeHandle?.width || 0,
    templeFeature?.compoundDepth || templeHandle?.depth || 0,
  );
  const templeVariantOptions = templeVariantsForSize(templeLimit);
  let templeSeed = templeHandle?.seed ?? templeFeature?.seed ?? 11;
  let templeCurrentPlan = templeHandle?.plan || templeFeature?.compound || null;
  let templeDancheong = resolveDancheong('temple', templeHandle?.dancheong || PRESETS.temple);
  let templeOverride = null; // { group, compound, glow }
  let templeHidden = false;
  const templeEditable = () => !!(templeCompound && templeInner && templeCurrentPlan);

  function templePlanFromOptions(options = {}) {
    const base = templeHandle?.plan || templeFeature?.compound || templeCurrentPlan;
    const resolved = { ...(templeCurrentPlan?.settings || base.settings || {}), ...options };
    const requested = templeVariantOptions.includes(resolved.variant) ? resolved.variant : (templeCurrentPlan?.variant || base.variant);
    const preserveReservedVariantSize = requested === base.variant;
    return planTempleCompound({
      seed: templeSeed,
      variant: requested,
      ...(preserveReservedVariantSize ? { width: base.width, depth: base.depth } : {}),
      hallCount: resolved.hallCount,
      axisBend: resolved.axisBend,
      courtScale: resolved.courtScale,
      includeBellPavilion: resolved.includeBellPavilion,
      pagoda: resolved.pagoda,
      stoneLanterns: resolved.stoneLanterns,
      includeDanggan: resolved.includeDanggan,
      includeBudo: resolved.includeBudo,
    });
  }

  function buildTempleOverlay(options) {
    templeDancheong = resolveDancheong('temple', { ...templeDancheong, ...options });
    templeCurrentPlan = templePlanFromOptions(options);
    const wrapper = new THREE.Group();
    wrapper.name = 'temple-override';
    wrapper.userData.snowRoofKind = 'giwa';
    const compound = buildTempleCompound(templeCurrentPlan, { dancheong: templeDancheong });
    wrapper.add(compound);
    wrapper.rotation.y = templeInner.rotation.y;
    wrapper.position.copy(templeInner.position);
    wrapper.userData.W = templeCurrentPlan.width;
    wrapper.userData.D = templeCurrentPlan.depth;
    wrapper.userData.style = 'temple';
    return { wrapper, compound };
  }

  function showTempleDetail(options = {}) {
    if (!templeEditable()) return null;
    hideTempleDetail();
    const built = buildTempleOverlay(options);
    overrides.add(built.wrapper);
    templeOverride = { group: built.wrapper, compound: built.compound };
    if (templeVisNode) templeVisNode.visible = false;
    templeHidden = true;
    if (snow.isActive()) snow.inject(built.wrapper);
    retainOverlayPrograms(built.wrapper, `temple${snow.isActive() ? '|snow' : ''}`);
    templeOverride.glow = nightGlow.add(built.wrapper, 'temple');
    refreshNightLightOwner('temple', built.wrapper);
    representationDirty = true;
    built.wrapper.userData.editSpec = templeSpec();
    return built.wrapper;
  }

  function hideTempleDetail() {
    const changed = !!templeOverride || templeHidden;
    if (templeOverride) {
      nightGlow.remove(templeOverride.glow);
      refreshNightLightOwner('temple', null);
      disposeTempleCompound(templeOverride.compound);
      overrides.remove(templeOverride.group);
      templeOverride = null;
    }
    if (templeHidden && templeVisNode) templeVisNode.visible = true;
    templeHidden = false;
    if (changed) representationDirty = true;
  }

  function templeSpec() {
    const current = templeCurrentPlan || templeFeature?.compound;
    const base = templeHandle?.plan || templeFeature?.compound || current;
    const variantDefaults = Object.fromEntries(templeVariantOptions.map((variant) => {
      const useReservedSize = variant === base?.variant;
      const planned = planTempleCompound({
        seed: templeSeed,
        variant,
        ...(useReservedSize ? { width: base.width, depth: base.depth } : {}),
      });
      return [variant, { ...planned.settings }];
    }));
    return {
      parcelId: 'temple', family: 'temple', style: 'temple', temple: true,
      landmark: true, editable: templeEditable(),
      variantOptions: templeVariantOptions.slice(),
      variantDefaults,
      hallRange: current ? {
        min: TEMPLE_VARIANT_SPECS[current.variant].minHalls,
        max: current.variant === 'compact' && Math.min(current.width, current.depth) < 25
          ? 1
          : TEMPLE_VARIANT_SPECS[current.variant].maxHalls,
      } : { min: 1, max: 2 },
      params: current ? {
        variant: current.variant,
        ...current.settings,
        dancheongClarity: templeDancheong.dancheongClarity,
        dancheongSplendor: templeDancheong.dancheongSplendor,
      } : {},
    };
  }

  function refreshPalaceProxy() {
    const proxy = proxyById.get('palace');
    const activeHandle = palaceOverride?.comp?.userData?.palaceHandle || palaceHandle;
    if (proxy) {
      refreshPalacePickProxy(proxy, activeHandle);
      proxy.buildingSpec = palaceSpec();
    }
    return proxy;
  }

  function refreshTempleProxy() {
    const proxy = proxyById.get('temple');
    if (proxy) {
      refreshTemplePickProxy(proxy, templeCurrentPlan);
      proxy.buildingSpec = templeSpec();
    }
    return proxy;
  }

  // Palace and temple proxies join the same address space as residential parcels.
  for (const proxy of buildLandmarkPickProxies(plan, site, {
    palaceHandle, palaceInner, palaceSpec,
    templeHandle, templeInner, templeSpec,
  })) {
    proxies.push(proxy);
    proxyGroup.add(proxy.mesh);
    proxyById.set(proxy.parcelId, proxy);
  }
  proxyGroup.updateMatrixWorld(true);

  // Camera-proximity ambience and post-generation fauna own their update state.
  const ambientField = createVillageAmbientFieldController({
    plan, site, proxyById, excludedParcelIds: focusedResidentialIds, findSun,
  });
  // 필드는 scene 직속 셀/연기/조명을 소유해 village root만 순회하는 wave가 그대로는 찾지 못한다.
  // 빈 bridge를 root 데코로 등록해 wave multiplier만 전달하고, 실제 가시성·CPU sleep은 필드가 합성한다.
  const ambientWaveOwner = new THREE.Group();
  ambientWaveOwner.name = 'village-ambient-wave-owner';
  ambientWaveOwner.userData.waveFade = { setWeight: (value) => ambientField.setWaveFade(value) };
  ambientWaveOwner.userData.debugAmbient = () => ambientField.debug();
  group.add(ambientWaveOwner);
  const snow = createVillageSnowController(group);
  const fauna = createVillageFaunaController({ group, plan, site, seed, time, season });
  function refreshVillageFlora() {
    const kindByParcel = new Map();
    for (const [parcelId, spec] of committedResidentialSpecs) {
      if (spec?.kind) kindByParcel.set(parcelId, spec.kind);
    }
    const flora = group.userData.replaceFlora?.(season, { kindByParcel });
    if (!flora) return null;
    fauna.setTreePerches(flora.guardianAnchors, flora.yardTreeAnchors);
    primaryDoorOcclusion.refreshFlora(flora);
    representationDirty = true;
    return flora;
  }
  function residentialLodState(parcelId) {
    const parcel = plan.parcels.find((candidate) => candidate.id === parcelId && !candidate.hero);
    if (!parcel) return null;
    return parcelRepresentationState(handle, parcel, overrideById.has(parcelId));
  }

  // focus 생활 디테일이 집 내부 자식이 아니라 필지의 실제 월드 변환·치수·마당 데이터를 쓰게 한다.
  // show/reroll/hop 경로가 모두 이 서술자를 공유해 닭·풀·낙엽 링이 엉뚱한 원점에 생기지 않는다.
  function focusAmbientDescriptor(parcelId, overlayGroup = null) {
    if (!parcelId || parcelId === 'palace' || parcelId === 'temple') return null;
    const parcel = plan.parcels.find((candidate) => candidate.id === parcelId);
    if (!parcel) return null;
    const root = overlayGroup
      || (parcel.hero ? heroOverrides.get(parcelId)?.group : overrideById.get(parcelId));
    if (!root) return null;
    root.userData.W = root.userData.W || parcel.plotW || 20;
    root.userData.D = root.userData.D || parcel.plotD || 18;
    root.userData.style = root.userData.style
      || (parcel.hero ? parcel.heroStyle || 'hanok' : parcel.kind === 'giwa' ? 'giwa' : 'choga');
    root.userData.parcel = parcel;
    // The focus ring rebuilds its grass from the selected parcel's local frame.
    // Reserve the same all-season livelihood union as aerial flora so a motif
    // never appears through grass when its season fades in. The adapter already
    // includes the physical footprint gap; grass only needs a stable point test.
    const grassObstacles = yardLifeRecordsToHardObstacles(
      group.userData.yardLifeRecords,
      parcelId,
    );
    return {
      group: root,
      parcel,
      radius: Math.max(12, Math.min(22, Math.max(parcel.plotW || 20, parcel.plotD || 18) * 0.72)),
      seed: ((parcel.seed ?? seed) ^ 0xf0c5) >>> 0,
      season,
      // populate가 이미 둔 닭은 마을 공통 거리 LOD가 계속 소유한다. 같은 필지 focus ring은
      // 두 번째 flock을 만들지 않고, base가 없는 필지에서만 근접 닭을 생성한다.
      chickens: !fauna.hasResidentialFlock(parcelId),
      grassObstacles,
    };
  }

  // The selected FULL-detail subtree is the sole source for architectural
  // semantics that optimized aerial instances intentionally discard. Keep the
  // lookup independent from primaryDoorById: optical focus belongs to the
  // fixed portal even when product door interaction is unavailable or moving.
  function activeDetailRoot(parcelId) {
    if (parcelId === 'palace') return palaceOverride?.group || null;
    if (parcelId === 'temple') return templeOverride?.group || null;
    return heroOverrides.get(parcelId)?.group || overrideById.get(parcelId) || null;
  }

  const architecturalFocusScratch = new THREE.Vector3();

  // Event-time resolver for focus-in/hop/rebuild transitions. Callers cache
  // the returned world point; the render loop must not traverse the subtree.
  // Compounds with zero or multiple authored primaries fail closed so an
  // arbitrary hall can never become the optical focus by child order.
  function architecturalFocusPoint(parcelId, target) {
    const root = activeDetailRoot(parcelId);
    if (!root || !target?.copy) return null;

    let anchor = null;
    let count = 0;
    root.traverse((object) => {
      if (object.name !== 'primary-opening-anchor') return;
      count++;
      if (count === 1) anchor = object;
    });
    if (count !== 1 || !anchor) return null;

    const focus = anchor.userData?.openingDetailPlan?.anchors?.focus;
    if (!focus
      || !Number.isFinite(focus.u)
      || !Number.isFinite(focus.y)
      || !Number.isFinite(focus.outward)) return null;

    root.updateWorldMatrix(true, true);
    architecturalFocusScratch
      .set(focus.u, focus.y, focus.outward)
      .applyMatrix4(anchor.matrixWorld);
    if (!Number.isFinite(architecturalFocusScratch.x)
      || !Number.isFinite(architecturalFocusScratch.y)
      || !Number.isFinite(architecturalFocusScratch.z)) return null;
    return target.copy(architecturalFocusScratch);
  }

  // ── #224 hop overlay CPU chunks (cold residential only) ────────────────────
  // Detached house mesh first; courtyard wall/aux + scene install only after a
  // yield. Base instances stay visible until finish — never parent a partial tree.
  function beginResidentialHopOverlay(parcelId) {
    const parcel = plan.parcels.find((p) => p.id === parcelId);
    if (!parcel || parcel.hero) return null;
    if (overrideById.has(parcelId)) return null;

    const previousEditSpec = committedResidentialSpecs.get(parcelId) || null;
    const previousAcceptedSpec = previousEditSpec || buildParcelSpec(parcel);
    const edit = resolveResidentialEdit(parcel, previousEditSpec, {});
    const gk = edit.kind;
    const bld = { ...edit.building };
    const variantParcel = gk === parcel.kind ? parcel : { ...parcel, kind: gk, variant: 0 };
    const changedKind = gk !== parcel.kind;

    const preset = { ...PRESETS[gk], ...variantOv(variantParcel), ...bld };
    clampBuildingDimensions(preset, gk);
    const house = buildBuilding(preset);
    if (gk === 'choga') applyThatchAge(house.userData.materials, edit.top.thatchAge);
    // Match rebuildParcel({}, {}) roof-tone policy for an unedited hop promote.
    const preserveGeneratedRoofTone = !previousEditSpec && !changedKind;
    const roofTint = preserveGeneratedRoofTone
      ? (parcel.roofTone || toneOf(gk, parcel.toneIdx || 0))
      : toneOf(gk, edit.top.roofTone);
    applyMaterialRoleTints(house, {
      roof: roofTint,
      wall: changedKind ? null : parcel.wallTone,
      wood: changedKind ? null : parcel.woodTone,
      stone: changedKind ? null : parcel.stoneTone,
    });
    const local = parcelHouseTranslation(parcel);
    house.position.set(local.x, 0, local.z);
    const fs = edit.top.footprintScale;
    const mirrorX = variantMirrorX(variantParcel);
    house.scale.set(mirrorX * (parcel.sx || 1) * fs, (parcel.sy || 1) * fs, (parcel.sz || 1) * fs);
    house.userData.variantMirrorX = mirrorX;

    const g = new THREE.Group();
    g.name = `override-${parcelId}`;
    g.userData.exportPersistentParcel = false;
    g.userData.parcelId = parcelId;
    g.userData.snowRoofKind = gk;
    g.userData.W = parcel.plotW || 20;
    g.userData.D = parcel.plotD || 18;
    g.userData.style = gk;
    g.userData.parcel = parcel;
    g.userData.editSpec = edit.spec;
    g.userData.houseRoot = house;
    g.add(house);

    house.updateWorldMatrix(true, true);
    const buildingBox = new THREE.Box3().setFromObject(house);
    const editRoofBounds = {
      minX: buildingBox.min.x, maxX: buildingBox.max.x,
      minZ: buildingBox.min.z, maxZ: buildingBox.max.z,
    };
    const editBuildingBounds = {
      minX: buildingBox.min.x, maxX: buildingBox.max.x,
      minY: buildingBox.min.y, maxY: buildingBox.max.y,
      minZ: buildingBox.min.z, maxZ: buildingBox.max.z,
    };
    g.userData.editRoofBounds = editRoofBounds;
    g.userData.editBuildingBounds = editBuildingBounds;

    return {
      parcelId,
      parcel,
      edit,
      gk,
      previousEditSpec,
      previousAcceptedSpec,
      g,
      house,
      editRoofBounds,
      editBuildingBounds,
    };
  }

  function abortResidentialHopOverlay(draft) {
    if (!draft?.g) return;
    // Never installed — dispose detached geometry/materials only.
    disposeTree(draft.g);
    draft.g = null;
  }

  function finishResidentialHopOverlay(draft) {
    if (!draft?.g || !draft.parcel) return null;
    const {
      parcelId, parcel, edit, gk, previousEditSpec, previousAcceptedSpec,
      g, editRoofBounds, editBuildingBounds,
    } = draft;
    // Another path may have claimed this parcel while we yielded.
    if (overrideById.has(parcelId)) {
      abortResidentialHopOverlay(draft);
      return null;
    }

    const { wallType, jangdok, yardStack, clothesline, vegBed } = edit.top;
    const auxRequested = !!edit.top.aux;
    const auxiliaryParcel = {
      ...parcel,
      kind: gk,
      wallType,
      aux: edit.top.aux,
      auxRequested,
      jangdok,
      yardStack,
      clothesline,
      vegBed,
      editRoofBounds,
      auxiliary: null,
    };
    const auxiliary = planParcelAuxiliary(auxiliaryParcel, {
      site,
      peers: [
        ...plan.parcels,
        ...(plan.features?.palace?.center ? [plan.features.palace] : []),
      ],
      hardObstacles: yardHardObstacles(auxiliaryParcel),
    });
    const aux = !!auxiliary;
    edit.top.aux = aux;
    edit.spec.params.aux = aux;
    g.userData.auxiliarySpec = auxiliary;
    g.userData.yardSignature = residentialYardSignature(gk, edit.top);
    g.userData.editRoofBounds = editRoofBounds;
    g.userData.editBuildingBounds = editBuildingBounds;

    const wallRoot = buildVillageWall(parcel.shape, editWallMats, {
      style: wallType, kind: gk, seed: parcel.seed, char01, aux, auxRequested,
      plotW: parcel.plotW, plotD: parcel.plotD,
      gateEdge: parcel.access?.gateEdge, gateT: parcel.access?.gateT,
      parcel, site, baseY: parcel.baseY,
      wallHeightK: parcel.wallHeightK, jangdok,
      yardStack, clothesline, vegBed,
    });
    g.userData.wallRoot = wallRoot;
    g.add(wallRoot);
    if (auxiliary) {
      const auxRoot = buildAuxiliaryBuilding(auxiliary, editWallMats);
      g.userData.auxRoot = auxRoot;
      g.add(auxRoot);
    }

    g.applyMatrix4(parcelMatrix(parcel));
    overrides.add(g);
    overrideById.set(parcelId, g);
    activatePrimaryDoor(parcelId, g);
    // Focus-only hop promote — same as rebuildParcel(parcelId, {}) without persist.
    void previousEditSpec;
    void previousAcceptedSpec;

    if (snow.isActive()) snow.inject(g);
    retainOverlayPrograms(g, gk + (snow.isActive() ? '|snow' : ''));
    registerResidentialGlow(parcelId, g);
    focusedResidentialIds.add(parcelId);
    thresholdLife.attach(g, thresholdLifeCondition());
    representationDirty = true;
    setResidentialBaseHidden(parcel, true);

    return {
      group: g,
      compound: false,
      assembly: g.children[0] || g,
      ambient: focusAmbientDescriptor(parcelId, g),
    };
  }

  const api = {
    group,
    plan,
    seed,

    // ── 히어로(종가) 포커스 (마을 우선 진입·모드 일원화·리플레이) ──
    heroParcelId: () => (primaryHero ? primaryHero.id : null),
    isHero: (id) => heroParcels.some((p) => p.id === id),
    heroEditable: () => !!heroHandle,     // 편집 반영 가능(populate 언머지 필요). 아니면 오버레이 폴백은 근접 소품 은닉
    showHeroDetail, hideHeroDetail,
    heroDetailGroup: (parcelId = activeHeroId) => heroOverrides.get(parcelId)?.group || null,
    setNightLightOwnerSuppressed,

    // 검증용(#48): 현재 편집 오버레이(정규 override 또는 특수 hero override)의 월드 바운딩 크기.
    //   편집 전후로 비교해 지오가 실제로 바뀌었는지 정량 확인(스크린샷 육안 검수와 병행).
    overlayBox(parcelId) {
      const g = activeDetailRoot(parcelId);
      if (!g) return null;
      g.updateWorldMatrix(true, true);
      const b = new THREE.Box3().setFromObject(g);
      const s = b.getSize(new THREE.Vector3());
      return { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) };
    },

    // 검증·후속 interaction용: base 인스턴싱은 순수 anchor Group을 의도적으로 버리고,
    // 선택된 비인스턴스 overlay가 rebuild될 때 정확히 하나를 다시 만든다.
    openingDetailState(parcelId) {
      const root = activeDetailRoot(parcelId);
      if (!root) return null;
      const counts = {
        anchor: 0, panel: 0, frameBatch: 0, hardwareBatch: 0, thresholdLifeBatch: 0,
        leafDetails: 0, recess: 0, doorPivot: 0,
      };
      let plan = null;
      root.traverse((object) => {
        if (object.name === 'primary-opening-anchor') {
          counts.anchor++;
          plan = object.userData.openingDetailPlan || plan;
        }
        if (object.name === 'primary-opening-panel') counts.panel++;
        if (object.name === 'opening-frame-details') {
          counts.frameBatch++;
          counts.recess += object.userData.primaryDoorRecesses?.length || 0;
        }
        if (object.name === 'opening-hardware-details') counts.hardwareBatch++;
        if (object.name === 'threshold-life-detail') counts.thresholdLifeBatch++;
        if (object.name === 'primary-opening-leaf-details') counts.leafDetails++;
        if (object.name === 'primary-door-pivot') counts.doorPivot++;
      });
      return {
        ...counts,
        valid: counts.anchor === 1 && counts.panel === 1
          && counts.frameBatch === 1 && counts.hardwareBatch === 1
          && counts.leafDetails === 1 && counts.doorPivot === 1,
        plan: plan ? {
          id: plan.id,
          kind: plan.kind,
          style: plan.style,
          primary: plan.primary,
          hardware: plan.hardware.length,
          meoreum: plan.meoreum?.height ?? null,
          lowerPanel: plan.lowerPanel?.height ?? null,
          pivot: !!plan.anchors?.pivot,
          footwear: !!plan.anchors?.footwear,
        } : null,
        door: primaryDoorById.get(parcelId)?.snapshot() || null,
      };
    },

    architecturalFocusPoint,

    primaryDoorState(parcelId) {
      return primaryDoorById.get(parcelId)?.snapshot() || null;
    },
    raycastPrimaryDoor(raycaster, parcelId) {
      const hit = primaryDoorById.get(parcelId)?.raycast(raycaster);
      if (hit) {
        primaryDoorOcclusionQuery.excludeParcelId = parcelId;
        primaryDoorOcclusionQuery.season = season;
        if (primaryDoorOcclusion.find(
          raycaster.ray,
          hit.distance,
          primaryDoorOcclusionQuery,
        )) return null;
      }
      return hit ? {
        distance: hit.distance,
        point: hit.point.clone(),
        objectName: hit.object.name || null,
      } : null;
    },
    togglePrimaryDoor(parcelId) {
      const runtime = primaryDoorById.get(parcelId);
      if (!runtime) return null;
      representationDirty = true;
      return runtime.toggle();
    },
    seekPrimaryDoor(parcelId, progress) {
      const runtime = primaryDoorById.get(parcelId);
      if (!runtime) return null;
      representationDirty = true;
      return runtime.seek(progress);
    },
    primaryDoorWorldPoints(parcelId) {
      return primaryDoorById.get(parcelId)?.worldTargets() || [];
    },
    primaryDoorWorldFrame(parcelId) {
      return primaryDoorById.get(parcelId)?.worldFrame() || null;
    },

    // 검증용 LOD 소유권 스냅샷. 각 정규 필지는 어느 순간에도 far/mid/full/overlay 중
    // 정확히 하나만 논리적으로 보여야 한다. id 생략 시 전체 요약과 실패 필지를 함께 반환한다.
    lodState(parcelId = null) {
      if (parcelId) return residentialLodState(parcelId);
      const parcels = plan.parcels.filter((parcel) => !parcel.hero)
        .map((parcel) => residentialLodState(parcel.id));
      const counts = { fullDetail: 0, midDetail: 0, farMass: 0, impostor: 0, overlay: 0, far: 0 };
      for (const state of parcels) {
        if (state.fullDetail) counts.fullDetail++;
        if (state.midDetail) counts.midDetail++;
        if (state.farMass) counts.farMass++;
        if (state.impostor) counts.impostor++;
        if (state.overlay) counts.overlay++;
        if (state.far) counts.far++;
      }
      return {
        valid: parcels.every((state) => state.valid),
        counts,
        failures: parcels.filter((state) => !state.valid).map((state) => state.parcelId),
        parcels,
      };
    },

    // 종가 랜딩(enterVillageHero)이 나선 줌인 구도를 직접 산출할 때 dims/rotY/H/maxDim까지
    // 필요하다. 미노출 시 카메라 값이 NaN이 되므로 단건·전체 모두 같은 헬퍼를 쓴다.
    getPickProxy(parcelId) {
      return describePickProxy(proxyById.get(parcelId));
    },

    getPickProxies() {
      return proxies.map(describePickProxy);
    },

    // Focus-only camera cutaway. The handle owns the exact rendered terrain
    // contract and fitted subject volume; the app supplies only its live camera
    // frame and receives one projection near distance with no render resources.
    focusTerrainCutaway(parcelId, position, target) {
      const proxy = proxyById.get(parcelId);
      if (!proxy || !position || !target) return null;
      return focusTerrainCutawayForProxy(proxy, plan, site, { position, target });
    },

    // 컷어웨이가 실제로 적용된 near plane 을 받아 그 앞 식생을 동반 은닉한다. 0/미적용이면 해제.
    //   호출자는 카메라 near 하나만 알면 된다 — 어느 인스턴스가 그 평면에 걸치는지는 나무 기하를
    //   소유한 코어(tree-occluder 의 인스턴스 바운딩 구)가 판정한다.
    setFocusVegetationCut(nearPlane) {
      treeOccluder?.setCut(Number.isFinite(nearPlane) && nearPlane > 0 ? nearPlane : 0);
    },

    // 레이캐스터(마우스→광선) 로 히트한 필지 디스크립터 반환(없으면 null).
    raycast(raycaster) {
      const hits = raycaster.intersectObjects(proxyGroup.children, false);
      if (!hits.length) return null;
      const id = hits[0].object.userData.parcelId;
      const p = proxyById.get(id);
      return p ? {
        parcelId: id, point: hits[0].point.clone(), worldCenter: p.worldCenter.clone(),
        buildingSpec: p.buildingSpec, cameraFraming: cloneCameraFraming(p.cameraFraming), bbox: p.bbox.clone(),
      } : null;
    },

    // 한 필지만 풀디테일로 재생성 — 인스턴스는 은닉, 오버레이에 개별 집을 얹는다.
    //   newParams(전부 선택, 하위호환): {
    //     kind?, building?,        // building = buildBuilding 프리셋 오버라이드:
    //                              //   frontBays·sideBays·roofPitch·eaveOverhang·cornerLift·profileCurve[=roofCurve]
    //                              //   + 치수축 columnHeight(기둥높이)·ridgeH(지붕높이)·podiumTierH(기단높이)
    //     footprintScale?,         // 전체 풋프린트 스케일(변주 스케일에 곱)
    //     wallType?,               // 담장 유형 'tile'|'stone'|'brush'
    //     roofTone?,               // 지붕/집 톤 인덱스(variants.TONE) — 곱틴트
    //     thatchAge?,              // 초가 이엉 상태 0(신선 금빛)~1(노후 회갈·이끼)
    //     aux?,                    // 부속채 토글
    //   }
    //   편집 기준은 필지의 실제 변주(variantOv) — 슬라이더 미조정 축은 렌더된 집 그대로 유지.
    //   격식 가드(clampDims): 서민 초가가 궁 비례가 되지 않게 kind별 치수 클램프(가사제한 정신).
    rebuildParcel(parcelId, newParams = {}, { persist = false, refreshFlora = persist } = {}) {
      // 궁궐 컴파운드(#93): presetOverrides 로 오버레이 재생성(일곽 병합 유지). 특수 커밋 경로(pointerup).
      if (parcelId === 'palace') {
        if (!palaceEditable()) return null;
        const group = showPalaceDetail(newParams.presetOverrides || null);
        refreshPalaceProxy();
        return group;
      }
      if (parcelId === 'temple') {
        if (!templeEditable()) return null;
        const group = showTempleDetail(newParams.templeOptions || newParams);
        refreshTempleProxy();
        return group;
      }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      // 기존 오버라이드 제거
      const prev = overrideById.get(parcelId);
      // Geometry-slider previews can rebuild the house many times per second.
      // Carry the small batch only while its complete opening placement
      // signature remains unchanged; topology/width/landing changes regenerate
      // the pure plan and mesh below.
      const retainedLife = persist && !refreshFlora && focusedResidentialIds.has(parcelId)
        ? prev?.getObjectByName('threshold-life-detail') || null
        : null;
      retainedLife?.parent?.remove(retainedLife);

      if (parcel.hero) {
        if (prev) {
          releasePrimaryDoor(parcelId);
          releaseResidentialGlow(parcelId);
          disposeTree(prev); overrides.remove(prev); overrideById.delete(parcelId);
        }
        persistentOverrideIds.delete(parcelId);
        // 특수 필지(종가·관아)는 풀디테일 오버레이로 편집 반영(#48·#62·#59). populate 언머지(heroHandle)
        // 전엔 근접 소품이 함께 가려지는 폴백을 피하려 편집 미지원(null) — 랜딩·리플레이는 showHeroDetail 경유.
        if (!heroHandle) return null;
        return showHeroDetail(parcelId, heroEditOpts(parcel, newParams));
      }
      // Authoritative previous state is only the committed map. Overlay
      // userData.editSpec is a debug/cache tag and must not outlive a reroll that
      // deliberately clears committed edits (footprintScale etc. would stick).
      const previousEditSpec = committedResidentialSpecs.get(parcelId) || null;
      const previousAcceptedSpec = previousEditSpec || buildParcelSpec(parcel);
      const edit = resolveResidentialEdit(
        parcel,
        previousEditSpec,
        newParams,
      );
      const gk = edit.kind;

      // ── Fast path: thatchAge-only (choga). Re-tint the map without rebuild. ──
      if (prev && isResidentialThatchOnlyEdit(previousAcceptedSpec, edit)) {
        const house = prev.userData.houseRoot || prev.children[0];
        if (house?.userData?.materials) {
          applyThatchAge(house.userData.materials, edit.top.thatchAge);
          prev.userData.editSpec = edit.spec;
          if (persist) {
            persistentOverrideIds.add(parcelId);
            prev.userData.exportPersistentParcel = true;
            committedResidentialSpecs.set(parcelId, edit.spec);
            parcel.thatchAge = edit.top.thatchAge;
            if (refreshFlora) refreshVillageFlora();
          }
          // Map re-tint only — no caster/geometry ownership change, so do not
          // thrash the directional shadow cache on every thatchAge drag tick.
          return prev;
        }
      }

      // ── Fast path: roofTone-only. Re-apply role tints from stored base RGB. ──
      if (prev && isResidentialRoofToneOnlyEdit(previousAcceptedSpec, edit)) {
        const house = prev.userData.houseRoot || prev.children[0];
        if (house) {
          const roofTint = toneOf(gk, edit.top.roofTone);
          applyMaterialRoleTints(house, {
            roof: roofTint,
            wall: gk !== parcel.kind ? null : parcel.wallTone,
            wood: gk !== parcel.kind ? null : parcel.woodTone,
            stone: gk !== parcel.kind ? null : parcel.stoneTone,
          });
          prev.userData.editSpec = edit.spec;
          if (persist) {
            persistentOverrideIds.add(parcelId);
            prev.userData.exportPersistentParcel = true;
            committedResidentialSpecs.set(parcelId, edit.spec);
            parcel.toneIdx = edit.top.roofTone;
            parcel.roofTone = roofTint;
            if (refreshFlora) refreshVillageFlora();
          }
          return prev;
        }
      }

      const nextYardSig = residentialYardSignature(gk, edit.top);
      const openingsOnly = !!(prev && isResidentialOpeningsOnlyEdit(previousAcceptedSpec, edit));
      const houseOnly = !!(prev && isResidentialHouseOnlyEdit(previousAcceptedSpec, edit));
      const bld = { ...edit.building };
      // 프리셋 ← 변주 ov(실제 렌더 기준) ← 편집 오버라이드. 격식 가드로 치수 클램프.
      // A cross-kind edit starts from that kind's base variant instead of interpreting a
      // choga variant index as a giwa mirror (or vice versa).
      const variantParcel = gk === parcel.kind ? parcel : { ...parcel, kind: gk, variant: 0 };
      const changedKind = gk !== parcel.kind;

      const assembleHouse = () => {
        const preset = { ...PRESETS[gk], ...variantOv(variantParcel), ...bld };
        clampBuildingDimensions(preset, gk);
        const house = buildBuilding(preset);
        if (gk === 'choga') applyThatchAge(house.userData.materials, edit.top.thatchAge);
        const preserveGeneratedRoofTone = !previousEditSpec
          && newParams.roofTone === undefined && !changedKind;
        const roofTint = preserveGeneratedRoofTone
          ? (parcel.roofTone || toneOf(gk, parcel.toneIdx || 0))
          : toneOf(gk, edit.top.roofTone);
        applyMaterialRoleTints(house, {
          roof: roofTint,
          wall: changedKind ? null : parcel.wallTone,
          wood: changedKind ? null : parcel.woodTone,
          stone: changedKind ? null : parcel.stoneTone,
        });
        const local = parcelHouseTranslation(parcel);
        house.position.set(local.x, 0, local.z);
        const fs = edit.top.footprintScale;
        const mirrorX = variantMirrorX(variantParcel);
        house.scale.set(mirrorX * (parcel.sx || 1) * fs, (parcel.sy || 1) * fs, (parcel.sz || 1) * fs);
        house.userData.variantMirrorX = mirrorX;
        return house;
      };

      // Measure parcel-local AABB before parenting under an already-transformed
      // overlay group (setFromObject would otherwise pick up world matrix).
      const measureHouseLocalBounds = (house) => {
        house.updateMatrixWorld(true);
        const buildingBox = new THREE.Box3().setFromObject(house);
        return {
          editRoofBounds: {
            minX: buildingBox.min.x, maxX: buildingBox.max.x,
            minZ: buildingBox.min.z, maxZ: buildingBox.max.z,
          },
          editBuildingBounds: {
            minX: buildingBox.min.x, maxX: buildingBox.max.x,
            minY: buildingBox.min.y, maxY: buildingBox.max.y,
            minZ: buildingBox.min.z, maxZ: buildingBox.max.z,
          },
        };
      };

      const orderOverlayChildren = (root, house, wall, aux) => {
        if (house?.parent === root) root.remove(house);
        if (wall?.parent === root) root.remove(wall);
        if (aux?.parent === root) root.remove(aux);
        if (house) root.add(house);
        if (wall) root.add(wall);
        if (aux) root.add(aux);
      };

      // ── Fast path: house-only (openings + roof shell). Keep the overlay group
      // matrix; swap house mesh; keep wall when roof AABB still fits, otherwise
      // rebuild courtyard in place without disposeTree of the whole override.
      if (houseOnly
        && prev?.userData?.wallRoot
        && prev.userData.yardSignature === nextYardSig
        && prev.userData.houseRoot) {
        releasePrimaryDoor(parcelId);
        releaseResidentialGlow(parcelId);
        const oldHouse = prev.userData.houseRoot;
        prev.remove(oldHouse);
        disposeTree(oldHouse);
        const house = assembleHouse();
        const { editRoofBounds, editBuildingBounds } = measureHouseLocalBounds(house);
        const prevRoofBounds = prev.userData.editRoofBounds || null;
        // Openings never move the shell; pitch/eave may — only then rebuild wall.
        let canReuseWall = openingsOnly
          || residentialRoofBoundsMatch(prevRoofBounds, editRoofBounds);
        let wall = prev.userData.wallRoot;
        let aux = prev.userData.auxRoot || null;
        let auxiliary = prev.userData.auxiliarySpec || null;
        const { wallType, jangdok, yardStack, clothesline, vegBed } = edit.top;
        const auxRequested = !!edit.top.aux;

        if (!canReuseWall) {
          if (wall) { wall.parent?.remove(wall); disposeTree(wall); wall = null; }
          if (aux) { aux.parent?.remove(aux); disposeTree(aux); aux = null; }
          auxiliary = null;
          const auxiliaryParcel = {
            ...parcel,
            kind: gk,
            wallType,
            aux: edit.top.aux,
            auxRequested,
            jangdok,
            yardStack,
            clothesline,
            vegBed,
            editRoofBounds,
            auxiliary: null,
          };
          auxiliary = planParcelAuxiliary(auxiliaryParcel, {
            site,
            peers: [
              ...plan.parcels,
              ...(plan.features?.palace?.center ? [plan.features.palace] : []),
            ],
            hardObstacles: yardHardObstacles(auxiliaryParcel),
          });
          const auxOk = !!auxiliary;
          edit.top.aux = auxOk;
          edit.spec.params.aux = auxOk;
          wall = buildVillageWall(parcel.shape, editWallMats, {
            style: wallType, kind: gk, seed: parcel.seed, char01, aux: auxOk, auxRequested,
            plotW: parcel.plotW, plotD: parcel.plotD,
            gateEdge: parcel.access?.gateEdge, gateT: parcel.access?.gateT,
            parcel, site, baseY: parcel.baseY,
            wallHeightK: parcel.wallHeightK, jangdok,
            yardStack, clothesline, vegBed,
          });
          if (auxiliary) aux = buildAuxiliaryBuilding(auxiliary, editWallMats);
        }

        prev.userData.houseRoot = house;
        prev.userData.wallRoot = wall;
        prev.userData.auxRoot = aux || null;
        prev.userData.auxiliarySpec = auxiliary;
        prev.userData.editSpec = edit.spec;
        prev.userData.snowRoofKind = gk;
        prev.userData.yardSignature = residentialYardSignature(gk, edit.top);
        prev.userData.editRoofBounds = editRoofBounds;
        prev.userData.editBuildingBounds = editBuildingBounds;
        orderOverlayChildren(prev, house, wall, aux);
        // Openings previews need a live door runtime (leaf size changes). Roof-shell
        // previews skip door/glow re-arm until commit — pure build cost only.
        const armInteraction = persist || openingsOnly;
        if (armInteraction) activatePrimaryDoor(parcelId, prev);
        if (persist) {
          persistentOverrideIds.add(parcelId);
          prev.userData.exportPersistentParcel = true;
          setResidentialBaseExportHidden(parcel, true);
          committedResidentialSpecs.set(parcelId, edit.spec);
          if (RESIDENTIAL_OPENING_PARAM_KEYS.some((key) => (
            edit.spec.params[key] !== previousAcceptedSpec.params[key]
          ))) {
            shareableResidentialIds.add(parcelId);
          }
          for (const key of PERSISTENT_YARD_FIELDS) {
            parcel[key] = edit.top[key];
          }
          parcel.auxiliary = auxiliary;
          parcel.auxRequested = auxRequested;
          parcel.editRoofBounds = editRoofBounds;
          parcel.editBuildingBounds = editBuildingBounds;
          const proxy = proxyById.get(parcelId);
          if (proxy) refreshParcelPickProxy(proxy, parcel, site, edit.spec, proxies, plan);
          if (refreshFlora) {
            primaryDoorOcclusion.refreshParcel({ ...parcel, kind: gk });
            refreshVillageFlora();
          }
        }
        if (snow.isActive()) snow.inject(house);
        retainOverlayPrograms(house, gk + (snow.isActive() ? '|snow' : ''));
        if (!canReuseWall && wall) {
          if (snow.isActive()) snow.inject(wall);
          if (aux) { if (snow.isActive()) snow.inject(aux); }
          retainOverlayPrograms(prev, gk + (snow.isActive() ? '|snow' : ''));
        }
        // Glow must re-arm every house swap (night hanji anchors live on the mesh).
        registerResidentialGlow(parcelId, prev);
        if (focusedResidentialIds.has(parcelId) && armInteraction) {
          if (retainedLife) thresholdLife.reattach(prev, retainedLife, thresholdLifeCondition());
          else if (!prev.getObjectByName('threshold-life-detail')) {
            thresholdLife.attach(prev, thresholdLifeCondition());
          }
        }
        // Live previews may leave the shadow map one mesh behind until pointer-up
        // (same deferral spirit as flora/ring). Commit always invalidates casters.
        if (persist) representationDirty = true;
        setResidentialBaseHidden(parcel, true);
        return prev;
      }

      // Yard mesh can survive a full overlay rebuild when the courtyard signature
      // and roof AABB still match (fallback when house-only prerequisites fail).
      const prevRoofBounds = prev?.userData?.editRoofBounds || null;
      let retainedWall = null;
      let retainedAux = null;
      let retainedAuxiliarySpec = null;
      if (prev
        && prev.userData?.yardSignature === nextYardSig
        && prev.userData?.wallRoot) {
        // Bounds check against the *new* house happens after build; stage here.
        retainedWall = prev.userData.wallRoot;
        retainedAux = prev.userData.auxRoot || null;
        retainedAuxiliarySpec = prev.userData.auxiliarySpec || null;
        retainedWall.parent?.remove(retainedWall);
        retainedAux?.parent?.remove(retainedAux);
      }

      if (prev) {
        releasePrimaryDoor(parcelId);
        releaseResidentialGlow(parcelId);
        // Detached wall/aux are not in the tree — dispose only the rest.
        disposeTree(prev); overrides.remove(prev); overrideById.delete(parcelId);
      }
      persistentOverrideIds.delete(parcelId);

      const g = new THREE.Group();
      g.name = `override-${parcelId}`;
      g.userData.exportPersistentParcel = false;
      g.userData.parcelId = parcelId;
      g.userData.snowRoofKind = gk;   // 이 집 종류(giwa/choga) — 눈 흰틴트 게이트(#131, 초가 톤다운)
      g.userData.W = parcel.plotW || 20;
      g.userData.D = parcel.plotD || 18;
      g.userData.style = gk;
      g.userData.parcel = parcel;
      g.userData.editSpec = edit.spec;
      const house = assembleHouse();
      g.userData.houseRoot = house;
      g.add(house);
      // Before the parcel transform is applied, this is the exact edited eave
      // envelope in parcel-local coordinates. Runtime flora consumes it instead
      // of guessing from the original instanced variant.
      house.updateWorldMatrix(true, true);
      const buildingBox = new THREE.Box3().setFromObject(house);
      const editRoofBounds = {
        minX: buildingBox.min.x, maxX: buildingBox.max.x,
        minZ: buildingBox.min.z, maxZ: buildingBox.max.z,
      };
      // Exact committed FULL obstruction in the parcel's unrotated local frame.
      // Door picking consumes this alongside baseY instead of reconstructing an
      // edited/cross-kind house from the original variant and stale sx/sy/sz.
      const editBuildingBounds = {
        minX: buildingBox.min.x, maxX: buildingBox.max.x,
        minY: buildingBox.min.y, maxY: buildingBox.max.y,
        minZ: buildingBox.min.z, maxZ: buildingBox.max.z,
      };

      // Confirm wall reuse against the *new* roof AABB. Staged extraction used
      // the previous yard signature only; bounds must still fit. Openings-only
      // edits keep the shell AABB, so they always pass when yard signature matched.
      const canReuseWall = !!retainedWall
        && (openingsOnly || residentialRoofBoundsMatch(prevRoofBounds, editRoofBounds));
      if (retainedWall && !canReuseWall) {
        disposeTree(retainedWall);
        retainedWall = null;
        if (retainedAux) { disposeTree(retainedAux); retainedAux = null; }
        retainedAuxiliarySpec = null;
      }

      // 담·마당(개별) — 유형·부속채 어휘 + 마당 소품 편집(#96). newParams 오버라이드 우선, 없으면 필지 원본값.
      const { wallType, jangdok, yardStack, clothesline, vegBed } = edit.top;
      const auxRequested = !!edit.top.aux;
      let auxiliary = retainedAuxiliarySpec;
      if (!canReuseWall) {
        const auxiliaryParcel = {
          ...parcel,
          kind: gk,
          wallType,
          aux: edit.top.aux,
          auxRequested,
          jangdok,
          yardStack,
          clothesline,
          vegBed,
          editRoofBounds,
          auxiliary: null,
        };
        auxiliary = planParcelAuxiliary(auxiliaryParcel, {
          site,
          peers: [
            ...plan.parcels,
            ...(plan.features?.palace?.center ? [plan.features.palace] : []),
          ],
          hardObstacles: yardHardObstacles(auxiliaryParcel),
        });
      }
      // A toggle is a request for a safe independent building, not permission
      // to overlap the house or gate. Fail closed and keep the accepted editor
      // spec truthful when an unusually small edited lot has no valid slot.
      const aux = !!auxiliary;
      edit.top.aux = aux;
      edit.spec.params.aux = aux;
      g.userData.auxiliarySpec = auxiliary;
      g.userData.yardSignature = residentialYardSignature(gk, edit.top);
      g.userData.editRoofBounds = editRoofBounds;
      g.userData.editBuildingBounds = editBuildingBounds;

      if (canReuseWall) {
        g.userData.wallRoot = retainedWall;
        g.add(retainedWall);
        if (retainedAux) {
          g.userData.auxRoot = retainedAux;
          g.add(retainedAux);
        }
      } else {
        const wallRoot = buildVillageWall(parcel.shape, editWallMats, {
          style: wallType, kind: gk, seed: parcel.seed, char01, aux, auxRequested,
          plotW: parcel.plotW, plotD: parcel.plotD,
          gateEdge: parcel.access?.gateEdge, gateT: parcel.access?.gateT,
          parcel, site, baseY: parcel.baseY,
          wallHeightK: parcel.wallHeightK, jangdok,
          yardStack, clothesline, vegBed,
        });
        g.userData.wallRoot = wallRoot;
        g.add(wallRoot);
        if (auxiliary) {
          const auxRoot = buildAuxiliaryBuilding(auxiliary, editWallMats);
          g.userData.auxRoot = auxRoot;
          g.add(auxRoot);
        }
      }
      g.applyMatrix4(parcelMatrix(parcel));
      overrides.add(g);
      overrideById.set(parcelId, g);
      activatePrimaryDoor(parcelId, g);
      if (persist) {
        persistentOverrideIds.add(parcelId);
        g.userData.exportPersistentParcel = true;
        setResidentialBaseExportHidden(parcel, true);
        committedResidentialSpecs.set(parcelId, edit.spec);
        if (edit.kind !== previousAcceptedSpec.kind
          || RESIDENTIAL_OPENING_PARAM_KEYS.some((key) => (
            edit.spec.params[key] !== previousAcceptedSpec.params[key]
          ))) {
          shareableResidentialIds.add(parcelId);
        }
        for (const key of PERSISTENT_YARD_FIELDS) {
          parcel[key] = edit.top[key];
        }
        parcel.auxiliary = auxiliary;
        parcel.auxRequested = auxRequested;
        parcel.editRoofBounds = editRoofBounds;
        parcel.editBuildingBounds = editBuildingBounds;
        primaryDoorOcclusion.refreshParcel({ ...parcel, kind: gk });
        const proxy = proxyById.get(parcelId);
        if (proxy) refreshParcelPickProxy(proxy, parcel, site, edit.spec, proxies, plan);
        if (refreshFlora) refreshVillageFlora();
      }
      if (snow.isActive()) snow.inject(g);
      retainOverlayPrograms(g, gk + (snow.isActive() ? '|snow' : ''));
      registerResidentialGlow(parcelId, g);
      if (focusedResidentialIds.has(parcelId)) {
        if (retainedLife) thresholdLife.reattach(g, retainedLife, thresholdLifeCondition());
        else thresholdLife.attach(g, thresholdLifeCondition());
      }
      representationDirty = true;     // 새 오버레이 지오/캐스터(편집 교체 포함)

      // 부감 표현의 소유권을 오버레이로 넘긴다. 풀디테일 인스턴스·담뿐 아니라 현재 청크의
      // 필지별 임포스터까지 함께 접어 줌/홉/복귀 전환 중에도 단 하나의 집만 보이게 한다.
      setResidentialBaseHidden(parcel, true);
      return g;
    },

    // Canonical reloads replay committed parcels with flora refresh deferred.
    // Rebuild the shared batch once after every accepted roof/yard bound exists.
    refreshCommittedFlora() {
      return refreshVillageFlora();
    },

    // ── focus 오버레이 통합(#92) — 어느 필지든 풀디테일 오버레이로 승격 ──
    //   mode-integration §4: "focus 필지는 풀디테일 오버레이(buildParcel)". 종가·궁만이 아니라 정규
    //   필지도 focus-in 하면 개별 집으로 승격 → (1) 편집이 즉시 반영되고 (2) 조립 리플레이가 가능하며
    //   (3) 앰비언스 근접 링(#79)이 붙을 앵커(굴뚝·마당·지붕)가 생긴다. 부감에선 인스턴스로 남는다.
    //   반환 { group, compound, assembly }:
    //     group    = 오버레이 루트(편집·링 앵커·focus-out 해제 대상).
    //     compound = 조립을 playCompoundAssembly(청크 단위)로 할지 여부(종가=true, 정규 집=false).
    //     assembly = 조립 애니 대상 노드(정규=단일 집 그룹, 특수=컴파운드 루트).
    showParcelDetail(parcelId) {
      if (parcelId === 'palace') {
        const g = showPalaceDetail();   // 편집 없는 기본 오버레이(원본 palaceCore 가림) — 조립·편집 앵커
        return g ? { group: g, compound: true, assembly: g, ambient: null } : null;
      }
      if (parcelId === 'temple') {
        const g = showTempleDetail();
        return g ? { group: g, compound: true, assembly: g, ambient: null } : null;
      }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      if (parcel.hero) {
        const g = showHeroDetail(parcelId);
        if (!g) return null;
        return { group: g, compound: true, assembly: g, ambient: focusAmbientDescriptor(parcelId, g) };
      }
      const persistent = overrideById.get(parcelId);
      if (persistent && persistentOverrideIds.has(parcelId)) {
        activatePrimaryDoor(parcelId, persistent);
        focusedResidentialIds.add(parcelId);
        setResidentialBaseHidden(parcel, true);
        thresholdLife.attach(persistent, thresholdLifeCondition());
        refreshNightLightOwner(parcelId, persistent);
        return {
          group: persistent,
          compound: false,
          assembly: persistent.children[0] || persistent,
          ambient: focusAmbientDescriptor(parcelId, persistent),
        };
      }
      const g = this.rebuildParcel(parcelId, {});   // 기본(변주) 오버레이 + 인스턴스 은닉
      if (!g) return null;
      focusedResidentialIds.add(parcelId);
      thresholdLife.attach(g, thresholdLifeCondition());
      return { group: g, compound: false, assembly: g.children[0] || g, ambient: focusAmbientDescriptor(parcelId, g) };
    },

    // House→house hop (#224): promote B without blocking the click frame.
    //   · First yieldFrame lets the engine paint the hop camera tween.
    //   · Cheap paths (persistent / hero / palace / temple) then promote sync.
    //   · Cold residential splits house mesh vs courtyard wall/aux so one long
    //     rebuild does not freeze the main thread for a full frame budget.
    //   · Base instancing stays visible until the final install — no incomplete
    //     overlay is ever parented into the scene (no wrong-parcel flash).
    // Live-edit / focus-in / rebuild keep the synchronous showParcelDetail path.
    async showParcelDetailChunked(parcelId, { yieldFrame, isCancelled } = {}) {
      const cancelled = () => !!isCancelled?.();
      const pause = async () => {
        if (typeof yieldFrame === 'function') await yieldFrame();
      };

      if (parcelId === 'palace' || parcelId === 'temple') {
        await pause();
        if (cancelled()) return null;
        return this.showParcelDetail(parcelId);
      }

      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;

      if (parcel.hero) {
        await pause();
        if (cancelled()) return null;
        return this.showParcelDetail(parcelId);
      }

      const persistent = overrideById.get(parcelId);
      if (persistent && persistentOverrideIds.has(parcelId)) {
        await pause();
        if (cancelled()) return null;
        return this.showParcelDetail(parcelId);
      }

      // Cold residential: house CPU chunk → yield → wall/aux + atomic scene install.
      await pause();
      if (cancelled()) return null;

      // Any residual overlay (non-persistent) falls back to the full sync rebuild
      // after the first yield — hop normally arrives with no prior B override.
      if (overrideById.has(parcelId)) {
        return this.showParcelDetail(parcelId);
      }

      let draft = null;
      try {
        draft = beginResidentialHopOverlay(parcelId);
        if (!draft) return null;

        await pause();
        if (cancelled()) {
          abortResidentialHopOverlay(draft);
          return null;
        }
        const detail = finishResidentialHopOverlay(draft);
        draft = null; // ownership moved into overrides (or aborted inside finish)
        return detail;
      } catch (err) {
        if (draft) abortResidentialHopOverlay(draft);
        throw err;
      }
    },

    focusAmbientDescriptor,
    // focus-out: 오버레이 해제 + 원본 복원. 정규=인스턴스 재노출, 특수(종가)=병합본 복원.
    hideParcelDetail(parcelId) {
      if (parcelId === 'palace') { hidePalaceDetail(); return; }
      if (parcelId === 'temple') { hideTempleDetail(); return; }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (parcel && parcel.hero) {
        hideHeroDetail(parcelId);
        return;
      }
      focusedResidentialIds.delete(parcelId);
      releasePrimaryDoor(parcelId);
      const g = overrideById.get(parcelId);
      if (g && persistentOverrideIds.has(parcelId)) {
        thresholdLife.detach(g);
        setResidentialBaseHidden(parcel, true);
        return;
      }
      if (g) {
        releaseResidentialGlow(parcelId);
        disposeTree(g); overrides.remove(g); overrideById.delete(parcelId);
      }
      if (parcel) {
        setResidentialBaseHidden(parcel, false);   // 부감 인스턴스·담·임포스터 원상복원(픽셀 일치)
      }
    },
    // 현재 표시 중 focus 오버레이(정규/특수) — 리플레이(#92 再 일반화)가 조회. 재생성 없이 현 오버레이
    //   (편집 상태 보존)를 반환: group=링 앵커, assembly=조립 대상 노드, compound=playCompoundAssembly 여부.
    focusAssembly(parcelId) {
      if (parcelId === 'palace') {
        if (!palaceOverride) return null;
        refreshNightLightOwner(parcelId, palaceOverride.group);
        return { group: palaceOverride.group, assembly: palaceOverride.group, compound: true };
      }
      if (parcelId === 'temple') {
        if (!templeOverride) return null;
        refreshNightLightOwner(parcelId, templeOverride.group);
        return { group: templeOverride.group, assembly: templeOverride.group, compound: true };
      }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      if (parcel.hero) {
        const rec = heroOverrides.get(parcelId);
        if (!rec) return null;
        refreshNightLightOwner(parcelId, rec.group);
        return { group: rec.group, assembly: rec.group, compound: true };
      }
      const g = overrideById.get(parcelId);
      if (g) refreshNightLightOwner(parcelId, g);
      return g ? { group: g, assembly: g.children[0] || g, compound: false } : null;
    },

    // Compact JSON-safe handoff for URL/share restoration. Only authoritative
    // residential overlays participate; generated untouched parcels reproduce
    // from the village seed and need no redundant entry.
    residentialOpeningEdits() {
      const edits = [];
      for (const parcel of plan.parcels) {
        if (parcel.hero) continue;
        const spec = committedResidentialSpecs.get(parcel.id);
        if (!spec || !shareableResidentialIds.has(parcel.id)) continue;
        edits.push({
          parcelId: parcel.id,
          kind: spec.kind,
          params: Object.fromEntries(RESIDENTIAL_OPENING_PARAM_KEYS.map((key) => (
            [key, spec.params[key]]
          ))),
        });
      }
      return edits;
    },

    // ── 이 필지만 다시 굴리기(#100) — 새 시드로 이 필지의 변주(유형은 유지)만 재유도 → 오버레이 재생성. ──
    //   마을 전체·이웃 필지는 불변(집 focus 리롤이 마을 리롤로 새던 배선 분리). 기존 편집 오버라이드는
    //   폐기하고 새 시드의 기본 변주로 리셋한다. 프록시 buildingSpec 도 갱신 → 패널 기본값 동기(desync 금지).
    //   반환 { group, compound, assembly, spec } — 엔진이 조립 재생 + 링 재부착 + 패널 재시드에 사용.
    rerollParcel(parcelId) {
      if (parcelId === 'palace') {
        if (!palaceEditable()) return null;
        palaceHandle.seed = (Math.random() * 0x100000000) >>> 0;    // 궁 다일곽 배치 변주 재굴림
        const g = withSeededBuild(palaceHandle.seed, () => showPalaceDetail(null));
        const px = refreshPalaceProxy();
        return g ? { group: g, compound: true, assembly: g, spec: px ? px.buildingSpec : palaceSpec() } : null;
      }
      if (parcelId === 'temple') {
        if (!templeEditable()) return null;
        templeSeed = (Math.random() * 0x100000000) >>> 0;
        const g = withSeededBuild(templeSeed, () => showTempleDetail());
        const px = refreshTempleProxy();
        return g ? { group: g, compound: true, assembly: g, spec: px ? px.buildingSpec : templeSpec() } : null;
      }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      const rerollSeed = (Math.random() * 0x100000000) >>> 0;
      const baseEnvelope = rebuildEnvelopeById.get(parcelId);
      const committedKind = committedResidentialSpecs.get(parcelId)?.kind;
      // Type is a durable user decision, while every other edit is intentionally
      // reset by a house reroll. Feed that kind into the immutable lot envelope
      // before deriving a fresh variant; never mutate the original envelope.
      const envelope = committedKind && committedKind !== baseEnvelope?.kind
        ? { ...baseEnvelope, kind: committedKind }
        : baseEnvelope;
      // Explore a broader form repertoire than first placement and prefer a
      // candidate that is not a near-duplicate of the house currently focused.
      // Kind stays fixed; rank/lot still gate ㄷ eligibility and fit fallbacks.
      const previousHouse = {
        kind: parcel.kind,
        variant: parcel.variant,
        wallType: parcel.wallType,
        aux: parcel.aux,
        sx: parcel.sx,
        sy: parcel.sy,
        sz: parcel.sz,
        thatchAge: parcel.thatchAge,
      };
      const candidate = planParcelRebuild(envelope, rerollSeed, {
        char01,
        tuning: plan.opts.tuning || {},
        pavilion: plan.features?.pavilion || null,
        site,
        solarPeers: [
          ...plan.parcels,
          ...(plan.features?.palace?.center ? [plan.features.palace] : []),
        ],
        exploreReroll: true,
        previous: previousHouse,
      });
      if (!candidate) return null;
      // Keep the object identity consumed by plan, focus ambience, and LOD maps,
      // but atomically replace its data only after the pure planner succeeds.
      committedResidentialSpecs.delete(parcelId);
      shareableResidentialIds.delete(parcelId);
      for (const key of Object.keys(parcel)) delete parcel[key];
      Object.assign(parcel, candidate);
      const px = proxyById.get(parcelId);
      if (parcel.hero) {
        if (px) px.buildingSpec = buildParcelSpec(parcel);
        const detail = withSeededBuild(parcel.seed, () => this.showParcelDetail(parcelId));
        if (detail) detail.spec = px ? px.buildingSpec : buildParcelSpec(parcel);
        return detail;
      }
      // Residential rebuilds become persistent authoritative overlays. Their
      // exact roof and randomized yard vocabulary are committed before the flora
      // batch is deterministically regenerated, so focus-out cannot restore the
      // stale instanced house or leave a tree through a new hard object.
      const detail = withSeededBuild(parcel.seed, () => {
        const g = this.rebuildParcel(parcelId, {}, { persist: true });
        return g ? {
          group: g,
          compound: false,
          assembly: g.children[0] || g,
          ambient: focusAmbientDescriptor(parcelId, g),
        } : null;
      });
      if (detail) detail.spec = px ? px.buildingSpec : buildParcelSpec(parcel);
      return detail;
    },

    parcelRebuildState(parcelId) {
      const parcel = plan.parcels.find((candidate) => candidate.id === parcelId);
      if (!parcel) return null;
      const trees = (group.userData.yardTreeAnchors || [])
        .filter((tree) => tree.parcelId === parcelId)
        .map((tree) => {
          const local = parcelLocalPoint(parcel, tree);
          const footprint = {
            canopyRadius: tree.radius || 0,
            trunkRadius: tree.trunkRadius || 0,
          };
          return {
            x: +local.x.toFixed(3), z: +local.z.toFixed(3),
            radius: +footprint.canopyRadius.toFixed(3),
            hardConflict: yardTreeIntersectsHardObstacle(
              local,
              footprint,
              yardHardObstacles(parcel),
            ),
            roofOrSolarConflict: yardCanopyBlocked(parcel, local, footprint.canopyRadius),
          };
        });
      const proxy = proxyById.get(parcelId);
      return {
        persistent: persistentOverrideIds.has(parcelId),
        seed: parcel.seed >>> 0,
        rebuildSeed: parcel.rebuildSeed == null ? null : parcel.rebuildSeed >>> 0,
        plotW: +parcel.plotW.toFixed(3),
        plotD: +parcel.plotD.toFixed(3),
        kind: proxy?.buildingSpec?.kind || parcel.kind,
        params: { ...(proxy?.buildingSpec?.params || {}) },
        trees,
        conflicts: trees.filter((tree) => tree.hardConflict || tree.roofOrSolarConflict).length,
        lod: residentialLodState(parcelId),
      };
    },

    // Verification-only geometry probe. Measuring an alternate yard vocabulary
    // must not destroy a committed edit or leave the base instancing hidden.
    // Temporarily detach the current overlay, build and dispose the probe, then
    // restore the exact same group and persistence ownership without touching
    // flora, proxy specs, or the parcel seed.
    parcelBuildStats(parcelId, newParams = {}) {
      const parcel = plan.parcels.find((candidate) => candidate.id === parcelId && !candidate.hero);
      if (!parcel) return null;
      const existing = overrideById.get(parcelId) || null;
      const wasPersistent = persistentOverrideIds.has(parcelId);
      // Keep the exact interactive runtime alive while its authoritative root is
      // temporarily detached. Recreating it would close an open or moving door.
      const existingDoor = existing ? (primaryDoorById.get(parcelId) || null) : null;
      if (existingDoor) primaryDoorById.delete(parcelId);
      if (existing) {
        releaseResidentialGlow(parcelId);
        overrideById.delete(parcelId);
        persistentOverrideIds.delete(parcelId);
        overrides.remove(existing);
      }
      let probe = null;
      let meshes = 0, verts = 0, mirrorX = 1;
      try {
        probe = this.rebuildParcel(parcelId, newParams);
        probe?.traverse((object) => {
          if (object.userData?.variantMirrorX != null) mirrorX = object.userData.variantMirrorX;
          if (!object.isMesh || !object.geometry?.attributes?.position) return;
          meshes++;
          verts += object.geometry.attributes.position.count;
        });
        return probe ? { meshes, verts, mirrorX } : null;
      } finally {
        // A failed build may throw after registering a partial overlay but before
        // returning it. Remove whichever transient group owns the slot, then
        // restore the exact pre-probe representation even if disposal itself
        // fails. This diagnostic API must never consume user-authored state.
        try {
          const transient = overrideById.get(parcelId);
          if (transient && transient !== existing) {
            // Detach first so even a defensive cleanup exception cannot leave a
            // second house visible beside the restored authoritative overlay.
            overrideById.delete(parcelId);
            overrides.remove(transient);
            releasePrimaryDoor(parcelId);
            releaseResidentialGlow(parcelId);
            disposeTree(transient);
          }
        } finally {
          if (existing) {
            overrides.add(existing);
            overrideById.set(parcelId, existing);
            if (existingDoor) primaryDoorById.set(parcelId, existingDoor);
            else activatePrimaryDoor(parcelId, existing);
            registerResidentialGlow(parcelId, existing);
            if (wasPersistent) persistentOverrideIds.add(parcelId);
            setResidentialBaseHidden(parcel, true);
          } else {
            setResidentialBaseHidden(parcel, false);
          }
          representationDirty = true;
        }
      }
    },

    // 주거는 실제 fitted 처마 footprint, landmark는 지면 focus footprint의 절제된
    // 모서리 표식만 쓴다. 레이캐스트용 픽킹 box는 렌더하지 않는다.
    highlightParcel(parcelId, on) {
      if (!on) {
        if (highlighted === parcelId) {
          hi.clear();
          highlighted = null;
        }
        return;
      }
      const p = proxyById.get(parcelId);
      if (!p) return;
      const parcel = plan.parcels.find((candidate) => candidate.id === parcelId);
      const residential = parcel && (parcel.kind === 'giwa' || parcel.kind === 'choga')
        ? residentialHighlightMarker(parcel, p)
        : null;
      const volume = p.focusVolume;
      hi.show(parcelId, {
        ...residential,
        center: volume?.center || p.worldCenter,
        half: volume?.half || { x: p.dims.x * 0.5, z: p.dims.z * 0.5 },
        rotationY: volume?.rotationY ?? p.rotY,
        y: p.worldCenter.y + 0.14,
        source: residential?.source || 'focus-footprint',
      });
      highlighted = parcelId;
    },

    setTime(name, { immediate = false } = {}) {
      time = name;
      const V = VILLAGE_LIGHT_BY_TIME[name] || VILLAGE_LIGHT_BY_TIME.day;
      nightGlow.setBoost(V.glowBoost ?? 1.0);
      nightGlow.setTime(name, { immediate });
      vlights.apply(name, { immediate });      // 마을 전용 헤미 리프트 + 안티솔라 웜 필
      group.userData.setWaterTime?.(name);   // 개울 물 글린트·하늘반사 시간대 하향(야간 흰 띠 방지)
      group.userData.setAnimalsTime?.(name); // 마당 닭 야간 홰 자세(소동물 #41)
      fauna.setTime(name);                   // 개·고양이·까치·새 떼(밤엔 새 떼 숨김·활동 저하)
      ambientField.setTime(name, immediate);  // 카메라 앵커 필드 앰비언스 시간대(연기·모트, #105)
    },
    setSeason(name, { immediate = false } = {}) {
      season = name;
      group.userData.setSeason?.(name, { immediate });
      fauna.setSeason(name);
      ambientField.setSeason(name, immediate);
    },  // 마당 과실수 잎·꽃·열매 계절 토글(#41)
    setWeather(name, opts = {}) {
      weather = name;
      group.userData.setWeather?.(name, opts);
      snow.setWeather(name, opts);
      refreshFocusedThresholdLife();
    },
    get time() { return time; }, get season() { return season; }, get weather() { return weather; },

    update(dt) {
      let doorMoved = false;
      for (const runtime of primaryDoorById.values()) {
        if (runtime.update(dt)) doorMoved = true;
      }
      vlights.update(dt);                          // 마을 조명 리그 시간대 크로스페이드(태스크 #50)
      const yardLifeChanged = !!group.userData.update?.(dt); // 물결 + 계절 생활상 screen-door 전환
      fauna.update(dt);                            // 개·고양이·까치·새 떼 앰비언트(마을 루트 자식)
      cloudsHandle?.update(dt);                    // 산 구름·물안개 표류 + 흐르는 구름 그림자(태양 판독, #57)
      nightGlow.update(dt);                        // 창호 발광 크로스페이드 + 촛불 일렁임(밤)
      snow.update(dt);
      // 캐시된 햇빛 그림자도 불투명 screen-door coverage와 같은 프레임으로 갱신되어야 한다.
      return doorMoved || yardLifeChanged;
    },
    // 대규모 주택 청크 LOD(매 프레임, 카메라 필요) — FAR↔MID↔FULL 거리 전환.
    //   engine.js 가 camera 를 넘겨 호출. LOD 정책이 꺼진 규모(R<340)는 no-op.
    updateLod(camera, target = null, dt = 1 / 60) {
      cloudsHandle?.updateView?.(camera);              // 화면 밖 원경 뱅크·빛줄기는 렌더 제출 전에 sleep
      detailLod = createVillageDetailLodState(camera, target, site, detailLod);
      const swaps = group.userData.updateChunkLod?.(
        camera, detailLod.lensScale, detailLod.chunkReach,
      ) || 0;
      const yardLifeChanged = group.userData.yardLife
        ?.updateLod(camera, detailLod, yardLifeWeightAt) || false;
      treeOccluder?.setSubject(target);              // 부감 중심이 아니라 현재 선택/시선 필지를 가리는 나무를 판정
      treeOccluder?.update(camera, dt);              // 색 렌더 횟수와 무관하게 애니메이션 프레임당 1회
      const faunaChanged = fauna.updateLod(camera, detailLod);  // 새 떼 + 카메라 셀 근접 소동물
      ambientField.update(dt, camera, detailLod);   // 카메라 앵커 앰비언스 필드(#105)
      // 오버레이가 base house/wall/impostor caster 소유권을 바꾼 프레임도 LOD swap과 같은 그림자
      // 캐시 무효화 신호로 합친다. focus-out 마지막 프레임의 잔상 그림자를 남기지 않는다.
      const ownershipChanged = representationDirty;
      representationDirty = false;
      return swaps + Number(ownershipChanged) + Number(faunaChanged) + Number(yardLifeChanged);
    },

    // focus ring·검증 도구가 같은 프레임의 생활 디테일 강도를 공유한다(복제 임계값 금지).
    detailLodState() {
      const state = detailLod || createVillageDetailLodState(null, null, site);
      return { ...state, anchor: { ...state.anchor } };
    },

    debugYardLife() {
      return group.userData.debugYardLife?.() || null;
    },

    // 웨이브 중 새 마을은 아직 fog·조명·구름·단일집 가시성을 소유하면 안 되지만, scene 직속
    // 비선택 필지 앰비언스는 건물과 함께 0→1로 들어와야 한다. 이 한 레이어만 미리 붙이고
    // PointLight 풀·전역 lookahead는 옛 필드와 겹치지 않게 승격까지 미룬다. enterVillageMode의
    // 같은 호출은 기존 필드를 승격만 해 완료 프레임에도 총 조명 개수와 리소스 수명을 일정하게 둔다.
    prepareWavePresentation(app = {}) {
      if (app.scene) ambientField.enter(app.scene, { deferSceneServices: true });
    },

    // 앱 단일건물 씬 → 마을 씬 스왑. app: { scene, building?, ground?, env? }.
    //   sky/fog/sun 은 scene 레벨이라 그대로 유지(앱 env.setTime 이 구동) → 마을이 재사용.
    //   env 의 지면 레이어(env.group)는 숨겨 마을 자체 지형이 드러나게 한다.
    enterVillageMode(app = {}) {
      if (!app.scene) return;
      // 마을 부감 fog 거리(near/far)를 env fog 합성에 모디파이어로 등록(태스크 #50). env 가 시간대
      // 크로스페이드로 fog 색은 이어가고, 거리는 이 훅이 매 틱 마을 스케일(R*2.2/R*7.0)로 오버라이드.
      app.env?.addFogModifier?.(villageFog);
      nightGlow.resetTransition(); // 진입은 현재 시간대 창빛으로 스냅, 이후 다이얼만 크로스페이드.
      this._prev = {
        building: app.building?.visible, ground: app.ground?.visible, env: app.env?.group?.visible,
      };
      app.scene.add(group);
      app.scene.add(vlights.rig);            // 마을 전용 조명(활성 동안만) — 단일 씬 공유 조명 불침해
      vlights.apply(time, { immediate: true }); // 진입은 스냅(씬 스왑), 이후 setTime 다이얼은 크로스페이드
      attachClouds(app.scene);               // 산 구름·물안개 빌보드(마을 그룹 자식 — env.group 토글 무관, #57)
      ambientField.enter(app.scene);         // 카메라 앵커 앰비언스 필드(#105) — 씬 직속(마을 활성 동안만)
      if (app.building) app.building.visible = false;
      if (app.ground) app.ground.visible = false;
      if (app.env?.group) app.env.group.visible = false;
      // 단일집 env의 원점 고정 motes/seasonLeaves는 env.group과 함께 숨긴다. 마을의 대기 디테일은
      // 카메라 추종 petals(weather)·비선택 ambientField·선택 focusRing이 각각 한 번만 소유한다.
    },
    exitVillageMode(app = {}) {
      if (!app.scene) return;
      app.env?.removeFogModifier?.(villageFog); // 마을 fog 거리 오버라이드 해제(태스크 #50)
      detachClouds();                            // 구름 빌보드 정리(재진입마다 새로 붙임, #57)
      ambientField.exit();                       // 카메라 앵커 앰비언스 필드 해제(#105)
      app.scene.remove(group);
      app.scene.remove(vlights.rig);         // 리그 제거 → 씬 조명은 단일 씬 상태로 완전 복귀
      const pv = this._prev || {};
      if (app.building && pv.building !== undefined) app.building.visible = pv.building;
      if (app.ground && pv.ground !== undefined) app.ground.visible = pv.ground;
      if (app.env?.group && pv.env !== undefined) app.env.group.visible = pv.env;
    },

    // 검증/디버그: 프록시 박스를 와이어프레임으로 씬에 노출(픽킹 프록시 시각화 컷).
    debugShowProxies(on) {
      if (on && !this._proxyViz) {
        this._proxyViz = new THREE.Group(); this._proxyViz.name = 'proxy-viz';
        for (const p of proxies) {
          const wire = new THREE.LineSegments(
            new THREE.EdgesGeometry(p.mesh.geometry),
            new THREE.LineBasicMaterial({ color: 0x1b6ec8 }));
          wire.position.copy(p.mesh.position); wire.quaternion.copy(p.mesh.quaternion);
          this._proxyViz.add(wire);
        }
        group.add(this._proxyViz);
      }
      if (this._proxyViz) this._proxyViz.visible = !!on;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const parcelId of [...primaryDoorById.keys()]) releasePrimaryDoor(parcelId);
      for (const parcelId of [...residentialGlowById.keys()]) {
        releaseResidentialGlow(parcelId, false);
      }
      for (const record of heroOverrides.values()) nightGlow.remove(record.glow);
      for (const record of heroOverrides.values()) record.group.userData.disposeCompound?.();
      for (const base of heroHandle?.values?.() || []) base.userData.disposeCompound?.();
      if (palaceOverride) nightGlow.remove(palaceOverride.glow);
      hideTempleDetail();
      nightGlow.dispose();
      group.userData.nightLights?.dispose?.();
      detachClouds();
      ambientField.exit();
      treeOccluder?.dispose();
      group.userData.deactivateMist?.();
      group.userData.yardLife?.dispose?.();
      disposeTree(group, keptMats);
      thresholdLife.dispose();
      // #129 프로그램 앵커 최종 해제 — 오버레이 dispose 는 __kept 를 건너뛰므로 마을 파기 시 여기서 정리.
      disposeMaterials(keptMats);
      keptMats.length = 0;
      vlights.dispose();
      disposeObjectTree(proxyGroup);
      proxyGroup.clear();
    },
  };

  // dispose 이후의 handle은 완전히 불활성이다. 공개 메서드를 한 번 감싸면 새 API가 추가돼도
  // enter/debug/detail 경로가 자원을 다시 만들거나 씬에 재부착하는 종료 후 누수를 자동으로 막는다.
  const nullAfterDispose = new Set([
    'heroParcelId', 'heroDetailGroup', 'overlayBox', 'openingDetailState', 'architecturalFocusPoint',
    'getPickProxy', 'focusTerrainCutaway', 'raycast',
    'rebuildParcel', 'refreshCommittedFlora', 'showParcelDetail', 'showParcelDetailChunked', 'focusAssembly', 'rerollParcel', 'parcelRebuildState', 'parcelBuildStats',
    'primaryDoorState', 'raycastPrimaryDoor', 'togglePrimaryDoor', 'seekPrimaryDoor',
    'primaryDoorWorldPoints', 'primaryDoorWorldFrame',
  ]);
  for (const key of Object.keys(api)) {
    const method = api[key];
    if (key === 'dispose' || typeof method !== 'function') continue;
    api[key] = (...args) => {
      if (!disposed) return method.apply(api, args);
      if (key === 'getPickProxies') return [];
      if (key === 'isHero' || key === 'heroEditable') return false;
      if (key === 'updateLod') return 0;
      return nullAfterDispose.has(key) ? null : undefined;
    };
  }

  return api;
}

// ───────────────────────── 헬퍼 ─────────────────────────

// 씬의 태양 DirectionalLight 를 찾는다(구름 빌보드가 태양 방향·색·세기를 매 프레임 판독).
//   engine.js 는 그림자 캐스터 DirectionalLight 를 scene 직속으로 add(유일). 마을 조명 리그의
//   안티솔라 필(fill)은 castShadow=false 이고 rig 그룹 안(중첩)이라 걸러진다.
function findSun(scene) {
  if (!scene) return null;
  for (const o of scene.children) if (o.isDirectionalLight && o.castShadow) return o;
  // 폴백: 중첩 포함 첫 그림자 캐스터(예외적 씬 구성 대비).
  let found = null;
  scene.traverse((o) => { if (!found && o.isDirectionalLight && o.castShadow) found = o; });
  return found;
}

function disposeTree(root, retainedMaterials = []) {
  const resources = collectObjectResources(root);
  // #129 프로그램 앵커는 overlay 수명보다 길다. 앵커가 공유하는 모든 texture slot/uniform도
  // 함께 보호하고, 최종 VillageHandle.dispose에서 identity-dedupe해 정확히 한 번 해제한다.
  const retained = new Set(retainedMaterials);
  for (const material of resources.materials) if (material.userData?.__kept) retained.add(material);
  for (const material of retained) {
    resources.materials.delete(material);
    const keptTextures = new Set();
    addMaterialTextures(material, keptTextures);
    for (const texture of keptTextures) resources.textures.delete(texture);
  }
  disposeObjectResources(resources);
}

function disposeMaterials(materials) {
  const resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
  for (const material of materials) addMaterialResource(material, resources.materials, resources.textures);
  disposeObjectResources(resources);
}

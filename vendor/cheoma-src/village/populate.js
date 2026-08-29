import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { makeMaterials, injectVillageCloudShadow } from '../builder/palette.js';
import { collectOpeningGlowAnchors } from '../builder/opening-glow-anchors.js';
import { createWaterUniforms } from '../env/water.js';
import {
  createCloudUniforms, buildEdgeMistRing, buildRidgeMist,
} from '../env/clouds.js';
import {
  buildHouseInstances,
  buildHouseEnvelopeInstances,
  buildChunkImpostor,
  createImpostorMaterials,
  mergeStatic,
  parcelMatrix,
} from './instancing.js';
import {
  partitionParcels,
  combineHouseHandles,
  combineSourceHideHandles,
  combineWallHandles,
} from './chunks.js';
import { villageChunkLodPolicy } from './lod-policy.js';
import { buildCityWall } from './citywall.js';
import { buildVillageFlora } from './gardens.js';
import { planYardLife } from './yard-life-plan.js';
import { buildSpringBloom } from '../layout/bloom.js';
import { buildForest } from './forest.js';
// #123: forest 입력 빌더(마스크·거리필드·외곽신축·고정반경)는 워커 공유 위해 forest-crunch 로 이설.
import { makeEdgeWarp, makeTreeMask, makeClearance } from './forest-crunch.js';
import { terrainWarpInner } from './terrain-surface.js';
import { buildNightLights } from './nightlights.js';
import { setupAnimals } from '../env/animals.js';
import * as G from '../core/math/geom2.js';
import { buildParcelPads, computePadY } from '../generators/village/pads.js';
import {
  buildFeatureObjects,
  buildHeroParcel,
  buildPaddyFields,
  buildVillageSijeon,
  collectMaterialSets,
} from '../generators/village/features.js';
import {
  buildSiteTerrain,
  buildWaterRibbon,
  computeRidgeMistAnchors,
  setVillageWaterTime,
} from '../generators/village/terrain.js';
import { scatterTrees } from '../generators/village/trees.js';
import { buildRoads } from '../generators/village/roads.js';
import { buildDrainage } from './drainage-geometry.js';
import { buildDangsan } from './dangsan-geometry.js';
import {
  buildAuxiliaryBuilding,
  disposeAuxiliaryBuilding,
} from './auxiliary-building-geometry.js';
import {
  attachChunkLodSwap,
  buildCourtyard,
  buildKindDecomps,
  makeHouseProtos,
  placeParcel,
} from '../generators/village/houses.js';
import { createVillageYardLife } from '../generators/village/yard-life-product.js';
import { parcelRotY } from '../generators/shared/parcel-transform.js';

// 기존 내부 import 경로 호환. 신규 소비자는 generators/village/*를 사용한다.
export {
  buildCourtyard,
  buildHeroParcel,
  computePadY,
  makeHouseProtos,
  placeParcel,
  setVillageWaterTime,
};

// VillagePlan(순수 데이터) → THREE.Group 인스턴스화.
//   자연(지형·개울·논·수목) → 도로 → 필지(집·담·문) → 공용(정자·다리·소품) → 절·궁 순으로 쌓는다.
//   집은 프로토타입 1벌을 clone(지오메트리·재질 공유)해 대량 배치(메모리 고정, 스틸 렌더 충분).

// 지형 최외곽 신축 매핑(makeEdgeWarp)·나무마스크(makeTreeMask)·구조물 거리필드(makeClearance)는
// forest-crunch.js, 고정반경(terrainWarpInner)은 terrain-surface.js에서 워커와 공유한다.





// ───────────────────────── 최상위 ─────────────────────────
// populateVillage(plan, { optimize })
//   optimize(기본 true): 정규 주택 → 재질별 InstancedMesh, 담·도로·논·랜드마크 → 재질별
//     정적 병합. 드로우콜을 "재질 수" 규모로 눌러 60fps 확보(instancing.js). userData 로
//     인스턴스 핸들·재질셋을 노출해 adapter.js 가 픽킹·편집·야간광에 쓴다.
//   optimize=false: 기존 필지별 clone 경로(디버그·개별 검증용).

// 동기 진입점(기존 계약 불변) — 아래 제너레이터를 완전 소진해 root 를 반환한다.
//   shoot/verify 도구·adapter sync 경로가 이 시그니처를 그대로 쓴다(결정론·픽셀 동일).
export function populateVillage(plan, opts = {}) {
  const it = populateVillageSteps(plan, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

// 조립 제너레이터(#123) — 마을 조립을 "의미 단위 스텝"으로 쪼개, 각 스텝 뒤 yield 로 제어를 넘긴다.
//   · 동기 소진(populateVillage) == 기존 body 를 일직선 실행 → 픽셀·결정론 완전 동일(리팩터 등가).
//   · createVillageAsync(adapter) 는 이 스텝들을 rAF 프레임에 분산 구동(롱프레임 스파이크 해소).
//   yield 값(라벨)은 진행 리포트·프레임 예산 판정용. 전역 Math.random 소비 스텝(parcels/features 등)은
//   adapter 가 매 .next() 슬라이스를 시드창으로 감싸 소비 순서를 동기 경로와 byte-identical 하게 유지한다.
export function* populateVillageSteps(plan, opts = {}) {
  const optimize = opts.optimize !== false;
  const site = plan.site;
  const root = new THREE.Group();
  root.name = `village-${plan.opts.scale}`;
  opts.onRoot?.(root);
  const char01 = typeof plan.opts.char01 === 'number' ? plan.opts.char01 : 0.5;
  // 필지 담 팔레트 참조를 이 스코프로 끌어올린다(생성 시점은 아래 필지 단계 그대로 — makeMaterials 는
  //   시드 창의 _texRand 를 소비하므로 호출을 앞으로 옮기면 이어지는 담·소품 스트림이 밀린다).
  //   시전행랑 지붕이 이 팔레트의 공유 기와 캔버스를 재사용한다(§7.5 W2-2).
  let villagePalette = null;

  // 물 uniform(개울 공유)
  const waterU = createWaterUniforms();
  // 흐르는 구름 그림자 uniform(지형 재질 ↔ clouds 빌보드 공유). 빌보드 자체는 sun 이 필요해
  //   어댑터가 마을 진입 시 붙인다(populate 는 uniform·그림자 패치·운해 링까지만 — sun 무관 결정론).
  const cloudU = createCloudUniforms();

  // 1) 지형 · 2) 개울 (단일 메시 — 병합 대상 아님)
  //   지형 최외곽은 site.edge 로 신축(비정형 테두리). warpInner 안쪽(마을·논·개울·필지·랜드마크)은 불변.
  // terrainWarpInner가 plan 콘텐츠와 R*0.9 바닥을 terrainR 안으로 캡한다. forest worker도 같은
  // 순수 helper를 호출하므로 외곽 신축 좌표와 동기 경로가 byte-identical하다.
  const warpInner = terrainWarpInner(plan, site);
  // 구조물 거리 필드(#115) — 지형 황토색·숲 침투 식재가 공유(개활지=집 윤곽, 비원형).
  const clearDist = makeClearance(plan, site);
  yield 'setup+clearance';
  const terrain = buildSiteTerrain(site, cloudU, warpInner, clearDist);
  root.add(terrain.mesh);
  yield 'terrain';
  // 저층 운해 링 — 비정형 외곽선을 따라 지형 등고에 밀착(groundY)해 분지 가장자리에 고인다.
  //   yCap 아래에서만 등고를 따르므로 능선은 운해 위로 솟고 낮은 절단면만 잠긴다(운무 절단).
  //   부감에선 "테두리를 지우는 운해", 아이레벨에선 "사면 원경 물안개"로 함께 읽힌다.
  const mist = site.edge
    ? buildEdgeMistRing(site.edge, {
        groundY: site.heightAt,
        // R5/U1 #211: 불투명 정점(rMid)을 지형 테두리에 맞춘다. 안쪽 시작을 0.58→0.78 로 물려 분지
        //   내부·산 매스를 흐리게 덮던 탁한 룩(골든의 대가)으로 돌아가지 않으면서, 부감에서
        //   절단면·외곽 수관 실루엣만 대기로 지운다. rOut 을 더 늘리면 밖으로 뻗은 밴드가 시선에
        //   거의 나란해져 프레임을 가로지르는 하드한 웨지로 읽히므로 1.17 이 상한이다.
        rIn: 0.78, rMid: 0.99, rOut: 1.17,
        yBase: Math.max(5, site.Hmax * 0.09), yAmp: Math.max(2.5, site.Hmax * 0.05),
        // #211: 부감에서 절단면을 덮을 수직 두께·외곽 처짐을 상향(수관 실루엣까지). 링 반경 폭은 유지.
        thickness: Math.max(6, site.Hmax * 0.24), outerDrop: site.Hmax * 0.10,
        // #20: yCap 을 살짝 내려 능선 상부가 운해 위로 더 명확히 솟게(운무 절단). 분지·절단면은
        //   여전히 잠긴다. strengthAt 의 제곱 pool 과 한 몸.
        // #211: 링 불투명도 상향 — scene fog 가 절단면까지 미치지 않는 capital/hanyang 부감을
        //   링·지형 edge haze 가 대신 녹인다(지형 radius 확장 금지).
        yCap: site.Hmax * 0.40, opacity: 0.64,
        seed: (plan.seed ^ 0x3117) >>> 0,
      })
    : null;
  if (mist) root.add(mist.mesh);
  // 배산 능선 물안개(아이레벨 원경) — 뒤(북) 반원의 "분지를 바라보는 근사면" 중턱에 카메라 대면
  //   소프트 뱅크. 각 방위에서 안쪽(bowl)→밖으로 표고를 스캔해 목표 중턱높이 첫 교차점(근사면)을
  //   찾아 그 지형면 살짝 위에 얹는다 → 진입 시점에서 능선에 걸친 원경 물안개로 읽힌다.
  const ridgeMistAnchors = site.edge ? computeRidgeMistAnchors(site) : [];
  const ridgeMist = ridgeMistAnchors.length
    ? buildRidgeMist(ridgeMistAnchors, { opacity: 0.40, seed: (plan.seed ^ 0x5a3d) >>> 0 })
    : null;
  if (ridgeMist) root.add(ridgeMist.group);
  const water = buildWaterRibbon(site, waterU);
  if (water) root.add(water);
  yield 'mist+water';

  const landmarks = [];    // 유일 지오(정자·다리·소품·궁·절) → 재질별 정적 병합
  const matSets = [];      // 야간 창호광 등 env 패치 대상 공유 재질셋
  const houseHandle = { giwa: null, choga: null };
  // 히어로 필지(종가·반가 대형)만 병합 제외·개별 그룹 — 어댑터가 visible 토글 + buildParcel 오버레이로
  //   교체(랜딩 조립·클로즈업·편집, #62). 키=parcel.id(=`p${i}`, 픽킹·rebuildParcel 과 동일 키공간).
  const heroHandle = new Map();
  // Renderer-authored opening coordinates only. Regular prototype variants stay
  // local until the parcel transform is known; unique compounds are captured in
  // village/world coordinates before their source hierarchy is merged away.
  const nightLightSources = {
    regular: { giwa: null, choga: null },
    owners: new Map(),
  };

  // 3) 도로·배수 · 4) 논 (병합 후 추가)
  const roadsGroup = (plan.roads && plan.roads.length) ? buildRoads(site, plan.roads) : null;
  const drainageGroup = plan.drainage
    && (plan.drainage.runs?.length || plan.drainage.crossings?.length)
    ? buildDrainage(plan.drainage)
    : null;
  const paddyGroup = plan.paddies ? buildPaddyFields(site, plan.paddies) : null;
  // Keep the established progress label: callers treat this as one static
  // surface assembly checkpoint rather than a list of every child layer.
  yield 'roads+paddy';

  // 5) 필지(집·담·문)
  if (plan.parcels && plan.parcels.length) {
    // 담장 공유 재질셋(전 필지 1벌) — 유형(tile/stone/brush) 무관 단일 팔레트라 병합 후 드로우콜 최소.
    const wallMats = makeMaterials('giwa');
    villagePalette = wallMats;
    // 필지 성토 패드 높이(집·마당·담이 한 레벨). 인접 필지 낙차 → 계단식 단차.
    for (const p of plan.parcels) p.baseY = computePadY(p, site);
    root.add(buildParcelPads(plan.parcels, site));   // 기단 상면 + 축대(옹벽) — 2 드로우콜

    // 대규모 주택 청크 런타임 LOD(#92 자유 줌: 부감 mass가 다가가도 남던 문제).
    //   구현은 모듈 스코프 attachChunkLodSwap(L818) — chunkGroup.userData.lodUpdate 에 부착하고 렌더 루프
    //   (engine → adapter.updateLod → root.updateChunkLod)가 매 프레임 카메라로 구동한다. (구 onBeforeRender
    //   방식은 imp 가 Group 이라 three 렌더러가 콜백을 안 불러 무동작 → #140-E 에서 제거·이관 완결.)
    const heroes = plan.parcels.filter((p) => p.hero);
    const regular = plan.parcels.filter((p) => !p.hero);
    const regGiwa = regular.filter((p) => p.kind === 'giwa');
    const regChoga = regular.filter((p) => p.kind !== 'giwa');

    if (optimize) {
      // ── 링-청크 인스턴싱(#47) ── 정규 주택·담을 앵커 방사 청크로 분할해 각 청크를 독립 그룹으로
      //   짓는다(청크별 InstancedMesh + 청크별 병합 담) → 바운딩이 좁아져 frustum culling 이 살아난다.
      //   재질셋(변주 decomp)은 kind당 1벌 재사용(청크 간 공유) — 텍스처·재질 수는 불변, 드로우콜만
      //   청크 수만큼 분할된다. 소규모(≤70호)는 단일 청크라 기존 룩·드로우콜 회귀 없음(chunks.sectorsFor).
      const giwaPool = regGiwa.length ? buildKindDecomps('giwa') : null;
      const chogaPool = regChoga.length ? buildKindDecomps('choga') : null;
      if (giwaPool) nightLightSources.regular.giwa = {
        variants: giwaPool.glowAnchors,
        variantAware: true,
      };
      if (chogaPool) nightLightSources.regular.choga = {
        variants: chogaPool.glowAnchors,
        variantAware: true,
      };
      if (giwaPool) matSets.push(giwaPool.matset);
      if (chogaPool) matSets.push(chogaPool.matset);
      // An independent outbuilding is one parcel-planned physical object, not a
      // FULL-only wall decoration or three separate LOD copies. Bake every safe
      // spec into one small material-partitioned root that remains stable while
      // the owning house moves FAR ↔ MID ↔ FULL. Per-parcel source ranges keep
      // focus/edit/export ownership as precise as houses and walls.
      const auxiliarySources = [];
      try {
        for (const parcel of regular.filter((candidate) => candidate.auxiliary)) {
          const source = buildAuxiliaryBuilding(parcel.auxiliary, wallMats);
          auxiliarySources.push({ parcel, source });
          source.applyMatrix4(parcelMatrix(parcel));
        }
        if (auxiliarySources.length) {
          const auxiliaryMerged = mergeStatic(
            auxiliarySources.map((entry) => entry.source),
            'village-auxiliaries',
            { ids: auxiliarySources.map((entry) => entry.parcel.id) },
          );
          root.add(auxiliaryMerged);
          houseHandle.auxiliaries = combineSourceHideHandles([auxiliaryMerged]);
        } else {
          houseHandle.auxiliaries = null;
        }
      } finally {
        for (const entry of auxiliarySources) disposeAuxiliaryBuilding(entry.source);
      }
      // 대규모 주택 3단계 LOD: 한양의 모든 정규 청크를 FAR mass / 실제 외피 MID / FULL로 만든다.
      //   중앙 청크를 항상 FULL로 남기면 부감에서도 수백 draw와 수백만 tri를 제출해, 외곽만 줄인
      //   성능 이득을 대부분 잃는다. 카메라-소유 필지 3D 거리가 현재 단계를 정하므로 중앙/외곽이
      //   같은 줌 문법을 쓰고, 접근한 청크만 자연스럽게 실제 외피와 전체 디테일로 승격한다.
      //   정책은 대규모(#89 연속 → 2026-07 perf: R≥220, town+capital+hanyang)에서 켜진다.
      //   village 는 단일 풀디테일을 유지한다(lod-policy.minSiteR).
      const lodPolicy = villageChunkLodPolicy(site);
      const chunks = partitionParcels(regular, site.center, lodPolicy);
      const impostorMaterials = lodPolicy.enabled ? createImpostorMaterials() : null;
      const chunkMeta = [];
      const giwaGroups = [], chogaGroups = [], wallGroups = [], impostorGroups = [];
      for (const chunk of chunks) {
        const cg = new THREE.Group();
        cg.name = `village-chunk-${chunk.ring}-${chunk.sector}`;
        cg.userData.chunk = {
          ring: chunk.ring, sector: chunk.sector, order: chunk.order,
          dist: chunk.dist, center: chunk.center, far: chunk.far,
          lod: lodPolicy.enabled,
        };
        const buildHouses = (into, tier = 'full', screenDoor = false) => {
          const cGiwa = chunk.parcels.filter((p) => p.kind === 'giwa');
          const cChoga = chunk.parcels.filter((p) => p.kind !== 'giwa');
          const build = tier === 'mid' ? buildHouseEnvelopeInstances : buildHouseInstances;
          if (cGiwa.length && giwaPool) { const hg = build('giwa', cGiwa, giwaPool.decomps, { screenDoor }); into.add(hg); giwaGroups.push(hg); }
          if (cChoga.length && chogaPool) { const hg = build('choga', cChoga, chogaPool.decomps, { screenDoor }); into.add(hg); chogaGroups.push(hg); }
        };
        const buildFullDetail = (into, screenDoor = false) => {
          buildHouses(into, 'full', screenDoor);
          const walls = chunk.parcels.map((p) => buildCourtyard(p, wallMats, char01, site));
          // #148: ids 로 필지별 정점 레인지 기록 → focus 오버레이가 그 필지 병합 담만 접어 이중 렌더 제거.
          const wg = mergeStatic(walls, `village-walls-${chunk.ring}-${chunk.sector}`, {
            ids: chunk.parcels.map((p) => p.id), screenDoor,
          });
          into.add(wg); wallGroups.push(wg);
        };
        if (lodPolicy.enabled) {
          // 모든 한양 청크: 저폴리 mass + 실제 빌더 외피 + 풀디테일. 중거리 외피는 같은 재질·지붕선을
          // 써 집이 갑자기 다른 모형/색으로 바뀌지 않으며, 미세 반복부재와 담은 근거리까지 미룬다.
          const imp = buildChunkImpostor(
            chunk.parcels, `impostor-${chunk.ring}-${chunk.sector}`, impostorMaterials,
            { screenDoor: true },
          );
          impostorGroups.push(imp);
          cg.add(imp);
          const mid = new THREE.Group();
          mid.name = `chunk-mid-${chunk.ring}-${chunk.sector}`;
          buildHouses(mid, 'mid', true);
          mid.visible = false;
          cg.add(mid);
          const full = new THREE.Group();
          full.name = `chunk-full-${chunk.ring}-${chunk.sector}`;
          buildFullDetail(full, true);
          full.visible = false;
          cg.add(full);
          attachChunkLodSwap(cg, imp, mid, full, chunk, lodPolicy);   // #140-E lodUpdate 를 cg 에 부착(모듈 스코프)
        } else {
          // LOD 비활성 규모: 기존 풀디테일 변주 인스턴싱 + 병합 담.
          buildFullDetail(cg);
        }
        root.add(cg);
        chunkMeta.push(cg.userData.chunk);
      }
      // 결합 은닉 핸들(픽킹·편집이 id 로 필지 은닉 — 청크 가로질러 dispatch). scene 추가 안 함(청크가 담음).
      //   LOD 청크의 MID/FULL도 giwaGroups/chogaGroups 에 포함되므로 단계 전환 뒤 은닉 dispatch 정상.
      houseHandle.giwa = giwaGroups.length ? { userData: combineHouseHandles('giwa', giwaGroups) } : null;
      houseHandle.choga = chogaGroups.length ? { userData: combineHouseHandles('choga', chogaGroups) } : null;
      houseHandle.chunks = chunkMeta;
      // 원경 임포스터도 필지별 은닉 핸들을 합친다. 포커스 오버레이가 청크 전환 전부터 해당
      // 필지의 저폴리 표현을 접어, 줌/홉/복귀 어느 프레임에도 두 표현이 겹치지 않는다.
      houseHandle.impostors = impostorGroups.length ? combineSourceHideHandles(impostorGroups) : null;
      // #148: 병합 담 필지별 은닉 핸들 — focus 오버레이가 자기 필지 병합 담을 접어 이중 렌더 제거.
      houseHandle.walls = wallGroups.length ? combineWallHandles(wallGroups) : null;
    } else {
      const protos = makeHouseProtos();
      matSets.push(protos.giwa.userData.materials, protos.choga.userData.materials);
      nightLightSources.regular.giwa = {
        variants: [collectOpeningGlowAnchors(protos.giwa, { space: 'local' })],
        variantAware: false,
      };
      nightLightSources.regular.choga = {
        variants: [collectOpeningGlowAnchors(protos.choga, { space: 'local' })],
        variantAware: false,
      };
      for (const p of regular) root.add(placeParcel(p, protos, wallMats, char01, site));
    }
    // 히어로(종가·반가 대형) — landmarks 전체 병합에선 빼되 "히어로별 개별 병합" 그룹으로 root 직속.
    //   개별 그룹이라 어댑터가 하나씩 visible 토글 + buildParcel 풀디테일 오버레이로 교체(랜딩·클로즈업·
    //   편집, #62). 히어로별 병합(mergeStatic)이라 컴파운드 수십 메시가 재질별로 접혀 드로우콜은 소수.
    //   병합 전 원본에서 재질셋(door/hanji) 수집(야간 창호광) — 병합 후 메시엔 userData.materials 없음.
    for (const p of heroes) {
      const raw = buildHeroParcel(p, site);
      collectMaterialSets(raw, matSets);
      nightLightSources.owners.set(
        p.id,
        collectOpeningGlowAnchors(raw, { space: 'world' }),
      );
      if (p.mjaHouse) {
        // The reusable compound already owns shadow-correct semantic chunks
        // and a lifecycle. Re-merging it would erase chimney/hearth ambience
        // and bypass disposeMjaHouse().
        root.add(raw);
        heroHandle.set(p.id, raw);
        continue;
      }
      const g = mergeStatic([raw], `hero-${p.id}`);
      // mergeStatic owns cloned world-space geometry while retaining the source
      // material identities. Release the now-unreachable compound geometry
      // immediately; this closes the latent leak in the existing head-house path.
      raw.traverse((object) => {
        if (object.isMesh || object.isInstancedMesh) object.geometry?.dispose?.();
      });
      root.add(g);
      heroHandle.set(p.id, g);
    }
  }
  yield 'parcels/houses';

  // 6) 공용: 정자·다리·소품·절·궁 (유일 지오 → 랜드마크 병합군)
  //   단, 궁(palace-core)은 히어로(종가)처럼 랜드마크 병합에서 제외한다 — mergeStatic 이 일곽 그룹·
  //   palaceHandle 구조를 재질별로 접으면 편집 핸들이 소멸하므로 미병합으로 root 직속(#93). palace.js 가
  //   이미 일곽 단위 내부 병합(궁역 ~778콜)이라 미병합 노출해도 net 드로우콜 동등. 재질셋(야간 창호광)은
  //   병합 여부와 무관하게 병합 전 원본에서 그대로 수집(parity). 절 등 나머지 랜드마크는 그대로 병합.
  let palaceCore = null;
  let templeCore = null;
  if (plan.features) {
    for (const o of buildFeatureObjects(plan, site)) {
      collectMaterialSets(o, matSets);
      if (o.name === 'palace-core') {
        palaceCore = o;
        nightLightSources.owners.set(
          'palace',
          collectOpeningGlowAnchors(o, { space: 'world' }),
        );
      } else if (o.name === 'temple-cluster') {
        templeCore = o;
        nightLightSources.owners.set(
          'temple',
          collectOpeningGlowAnchors(o, { space: 'world' }),
        );
      } else {
        if (o.name === 'pavilion') {
          const anchors = collectOpeningGlowAnchors(o, { space: 'world' });
          if (anchors.length) nightLightSources.owners.set('pavilion', anchors);
        }
        landmarks.push(o);
      }
    }
  }

  // 6.5) 성곽·사대문 + 시전행랑(한양) — 링 전체를 두르는 큰 오브젝트라 랜드마크 병합(중심 바운딩)에
  //   넣지 않고 자체 그룹으로 추가한다(성곽은 소수 재질, 시전은 자체 병합).
  if (plan.features && plan.features.cityWall) root.add(buildCityWall(plan.features.cityWall, site));
  if (plan.features && plan.features.sijeon && plan.features.sijeon.length) {
    root.add(buildVillageSijeon(plan.features.sijeon, site, villagePalette));
  }
  yield 'features+wall+sijeon';

  // 병합 반영(optimize) — 로드·논·랜드마크를 재질별로 접는다.
  // 도로는 buildRoads가 처음부터 단일 indexed mesh로 조립한다. mergeStatic을 다시 거치면
  // 불필요하게 non-indexed 복제되어 정점·메모리만 약 4배 늘어난다.
  if (roadsGroup) root.add(roadsGroup);
  // 배수도 세계 좌표의 두 indexed mesh(도랑·건넘) 이하로 이미 정적 조립된다. 별도 병합은
  // vertex color와 독립 lifecycle만 흐리고 성능 이득이 없으므로 그대로 한 그룹으로 붙인다.
  if (drainageGroup?.children.length) root.add(drainageGroup);
  // Optional dangsan under a guardian canopy: ≤2 borrowed-mat draws, no new material family.
  // Built after the shared village palette exists so stone/wood are the same role-tagged mats
  // used by walls and landmarks; empty plans allocate nothing.
  let dangsanGroup = null;
  if (plan.dangsan?.sites?.length) {
    let palette = villagePalette;
    if (!palette) {
      palette = makeMaterials('choga');
      matSets.push(palette);
    }
    dangsanGroup = buildDangsan(plan.dangsan, {
      materials: { stone: palette.stone, wood: palette.wood },
    });
    if (dangsanGroup?.children.length) root.add(dangsanGroup);
  }
  if (optimize) {
    if (paddyGroup) root.add(mergeStatic([paddyGroup], 'village-paddies'));
    if (landmarks.length) root.add(mergeStatic(landmarks, 'village-landmarks'));
  } else {
    if (paddyGroup) root.add(paddyGroup);
    for (const o of landmarks) root.add(o);
  }

  // 궁 코어 — 부감=전곽 재질별 병합본(드로우콜 −350), focus/편집=미병합 오버레이(#140-B, 히어로 #62 동형).
  //   #88 이 palace.js 에서 일곽 단위로만 병합해 palace-core 는 여전히 ~428 메시(편집 핸들 보존 #93)로
  //   부감에도 상시 미병합이었다. 여기서 optimize 시 전곽을 한 번 더 재질별로 접어(mergeStatic) 부감엔
  //   병합본만 렌더하고, 미병합 palace-core 는 편집 오버레이의 메타데이터(핸들·변환·재질) 소스로만 보존한다
  //   (씬 미추가). 병합은 지오를 clone 하므로 원본 지오는 dispose 해 힙 중복을 없앤다(재질은 공유 — 오버레이·
  //   병합본이 같은 재질 refs 를 재사용하므로 야간 창호광·#129 앵커·픽셀 정합 불변). 어댑터가
  //   palaceMerged.visible 을 부감↔focus 로 토글하고, palaceCore.userData(palaceCompound 핸들)로 오버레이를 짓는다.
  let palaceMerged = null;
  if (palaceCore) {
    if (optimize) {
      palaceMerged = mergeStatic([palaceCore], 'palace-merged');
      palaceCore.traverse((o) => { if (o.isMesh || o.isInstancedMesh) o.geometry?.dispose?.(); });
      root.add(palaceMerged);
    } else {
      root.add(palaceCore);   // 디버그(비최적화) 경로: 미병합 그대로 노출
    }
  }

  // Temple site and architecture have separate focus ownership. The pad and
  // approach remain visible while the aerial compound merge is replaced by an
  // editable full-detail overlay; this avoids a terrain/path pop during dolly-in.
  let templeMerged = null;
  let templeSiteMerged = null;
  if (templeCore) {
    if (optimize) {
      const inner = templeCore.userData.templeInner;
      const siteObjects = templeCore.userData.templeSiteObjects || [];
      if (siteObjects.length) {
        templeSiteMerged = mergeStatic(siteObjects, 'temple-site-merged');
        root.add(templeSiteMerged);
      }
      if (inner) {
        templeMerged = mergeStatic([inner], 'temple-compound-merged');
        root.add(templeMerged);
      }
      templeCore.traverse((o) => { if (o.isMesh || o.isInstancedMesh) o.geometry?.dispose?.(); });
    } else {
      root.add(templeCore);
    }
  }
  yield 'merges';

  // 7) 수목(맨 마지막: 건물 마스크 확정 후) — 이미 InstancedMesh(vertexColors)라 병합 제외
  //    warpInner 를 넘겨 나무를 지형 메시와 동일한 신축면에 앉힌다(#86 부유 차단).
  const mask = makeTreeMask(plan, site);
  const treeDensityK = (plan.opts.tuning && plan.opts.tuning.treeDensityK != null) ? plan.opts.tuning.treeDensityK : 1;
  root.add(scatterTrees(site, mask, plan.seed, warpInner, treeDensityK));
  yield 'trees';

  // 7.5) 산 숲(#113) — 캐노피 쉘(빽빽한 활엽 사면) + 화강암 암괴 노두. 배산 사면을 "듬성한 나무 꽂힌
  //     언덕"이 아니라 "숲으로 덮인 한국 산"으로. 나무와 동일 신축면(warp)·마스크(도로·필지·논 제외).
  //     쉘 1 + 바위 1 = 신규 +2 드로우콜, 쉘은 구름 그림자·엣지 헤이즈를 지형과 동형으로 수신.
  // #123 워커 오프로드: createVillageAsync 가 워커에서 미리 계산한 forest 크런치 버퍼를 opts.forestCrunchRef
  //   로 주입하면 그 버퍼로 조립만(메인 스레드 배치 루프 생략 → 롱프레임 제거). 없으면 메인에서 크런치
  //   (동기 createVillage·?worker=0·shoot 도구 — 결정론 동일, warp/mask/clearDist 재사용).
  const preForest = opts.forestCrunchRef ? opts.forestCrunchRef.value : (opts.forestCrunch || null);
  const forest = buildForest(plan, site, makeEdgeWarp(site, warpInner), mask, cloudU, clearDist, preForest);
  root.add(forest.group);
  yield 'forest';

  // 8) 드문 계절 생업상 + 마당 과실수·반가 정원·마을 보호수(당산나무).
  //    세 계절의 잠재 생활 슬롯을 한 번에 예약해 flora가 어느 계절에서도 그 자리를 침범하지
  //    않게 한다. renderer는 여름/원경에서 잠들지만 같은 물리 geometry를 계속 소유한다.
  const yardLifeHeightAt = (x, z, parcel = null) => (
    Number.isFinite(parcel?.baseY) ? parcel.baseY : site.heightAt(x, z)
  );
  let yardLifeSeason = 'summer';
  let yardLifeWeather = 'clear';
  let yardLifeRecords = planYardLife(plan.parcels, {
    seed: plan.seed,
    heightAt: yardLifeHeightAt,
  });
  const yardLife = createVillageYardLife(yardLifeRecords, {
    heightAt: yardLifeHeightAt,
    season: yardLifeSeason,
    weather: yardLifeWeather,
  });
  // Async generation can abort immediately after the `flora` yield, before the
  // final root metadata is installed. Expose the lifecycle owner now so partial
  // cleanup can release source materials plus custom depth/distance materials.
  root.userData.yardLife = yardLife;
  root.userData.yardLifeRecords = yardLifeRecords;
  root.add(yardLife.group);

  let flora;
  try {
    flora = buildVillageFlora(plan, site, plan.seed, { yardLifeRecords });
  } catch (error) {
    yardLife.dispose();
    throw error;
  }
  root.add(flora.group);
  yield 'flora';

  // Runtime parcel edits keep the village flora batched at a constant layer
  // count. Rebuilding the whole deterministic flora batch is cheaper than
  // promoting every yard to several permanent draw calls, and lets the shared
  // yard-layout contract move or omit a tree when a shed, jar terrace, stack, or
  // edited roof now occupies its former slot.
  const planCurrentYardLife = (kindByParcel = null) => {
    const planningParcels = kindByParcel?.size
      ? plan.parcels.map((parcel) => {
        const kind = kindByParcel.get(parcel.id);
        return kind && kind !== parcel.kind ? { ...parcel, kind } : parcel;
      })
      : plan.parcels;
    return planYardLife(planningParcels, {
      seed: plan.seed,
      heightAt: yardLifeHeightAt,
    });
  };
  const replaceFlora = (season = yardLifeSeason, { kindByParcel = null } = {}) => {
    const nextRecords = planCurrentYardLife(kindByParcel);
    const next = buildVillageFlora(plan, site, plan.seed, { yardLifeRecords: nextRecords });
    next.setSeason(season);
    try {
      yardLife.rebuild(nextRecords, { heightAt: yardLifeHeightAt });
    } catch (error) {
      next.dispose?.();
      throw error;
    }
    yardLifeRecords = nextRecords;
    root.remove(flora.group);
    flora.dispose?.();
    flora = next;
    root.add(flora.group);
    if (root.userData) {
      root.userData.flora = flora;
      root.userData.guardianAnchors = flora.guardianAnchors;
      root.userData.yardTreeAnchors = flora.yardTreeAnchors;
      root.userData.gardenAnchors = flora.gardenAnchors;
      root.userData.yardLifeRecords = yardLifeRecords;
    }
    return flora;
  };

  // 9) 소동물(마당 닭·논 소) — 필지 마당·논 앵커 재사용, 필지별 시드 결정론·과밀 금지.
  const animals = buildVillageAnimals(root, plan, site);

  // 10) 실제 고정 한지 면 기반 원경 창불(#60/#81). 위치는 위 prototype/compound renderer가
  //     확정했고 이 레이어는 단일 물리 instanced batch로 표현한다. 깊이 가림과 근경 emissive handoff를 유지한다.
  const nightLights = buildNightLights(plan, site, nightLightSources);
  root.add(nightLights.group);

  // 11) 봄 개화 관목(진달래·개나리, #107) — 봄을 가을만큼의 백미로. 진달래는 나무와 동일 신축면(warp)
  //     위 뒷산 사면 군락, 개나리는 담장 밖·길가(고샅 가장자리) 노랑 띠. 봄에만 가시(setSeason).
  //     종별 단일 InstancedMesh + instanceColor → +2 드로우콜. 나무 마스크 재사용(도로·필지 회피).
  const bloom = buildSpringBloom(plan, site, makeEdgeWarp(site, warpInner), mask);
  root.add(bloom.group);

  // 12) 지붕 구름 그림자(#110) — 지형과 같은 cloudU 를 지붕 재질에 얹어 밀집 부감(한양)에서도 그늘이
  //     지붕 위를 흐르게 한다. 어댑터 진입 시 setupClouds 가 이 cloudU 를 갱신하므로 지형·지붕·빌보드가
  //     한 uniform 으로 정합. 순수 셰이더 패치라 드로우콜·재질 수 불변, 첫 렌더 전(반환 전) 수행.
  injectVillageCloudShadow(root, cloudU);
  yield 'animals+night+bloom+cloudshadow';

  root.userData = {
    plan, waterU, matSets, houseHandle, heroHandle, optimize,
    flora, yardLife, yardLifeRecords, animals, nightLights, bloom, forest, drainageGroup, dangsanGroup,
    palaceCore,   // 궁 편집 핸들(#93) — 미병합 palace-core 그룹(궁 없으면 null), userData.palaceCompound 로 일곽 접근
    palaceMerged, // #140-B 부감 병합본(궁 없거나 비최적화면 null) — 어댑터가 focus-in 시 가리고 오버레이로 교체(히어로 #62 동형)
    templeCore, templeMerged, templeSiteMerged,

    // 흐르는 구름 그림자 공유 uniform(어댑터가 진입 시 setupClouds 에 넘겨 빌보드가 갱신) + 외곽선.
    cloudUniforms: cloudU, edge: site.edge, terrainMax: site.terrainR,
    setWaterTime: (name) => setVillageWaterTime(waterU, name),   // 개울 물 시간대 톤(어댑터 setTime 이 호출)
    setAnimalsTime: (name) => { for (const a of animals.handles) a.setTime(name); },
    setSeason: (name, opts = {}) => {
      yardLifeSeason = name;
      terrain.setSeason(name);
      flora.setSeason(name);
      yardLife.setSeason(name, opts);
      bloom.setSeason(name);
      forest.setSeason(name);
      for (const a of animals.handles) a.setSeason(name);
    },
    setWeather: (name, opts = {}) => {
      yardLifeWeather = name;
      yardLife.setWeather(name, opts);
    },
    replaceFlora,
    deactivateMist: () => { mist?.deactivate(); ridgeMist?.deactivate(); },
    // 엣지 헤이즈·운해 링·능선 물안개 색을 대기(fog)색과 동기화 — 어댑터 fog 모디파이어가 매 틱 호출(#50 정합).
    setEnvHaze: (fogColor) => { terrain.setHaze(fogColor); forest.setHaze(fogColor); mist?.update(fogColor); ridgeMist?.update(fogColor); },
    // 검증 앵커(하네스 프레이밍용)
    guardianAnchors: flora.guardianAnchors, yardTreeAnchors: flora.yardTreeAnchors,
    gardenAnchors: flora.gardenAnchors,
    flockCenters: animals.flockCenters, cowAnchors: animals.cowAnchors,
    debugFlockCenter: () => animals.flockCenters[0] || null,
    debugCowAnchor: () => animals.cowAnchors[0] || null,
    // 창불 한지 면 점등 레벨 갱신(어댑터 stepNightGlow 가 vnight 를 넘겨줌, #60/#50 정합).
    updateNightLights: (dt, level, lensScale) => nightLights.update(dt, level, lensScale),
    refreshNightLights: (ownerId, overlayRoot = null) => nightLights.refreshOwner(ownerId, overlayRoot),
    setNightLightOwnerSuppressed: (ownerId, suppressed = true) =>
      nightLights.setOwnerSuppressed(ownerId, suppressed),
    debugNightLights: () => nightLights.debugState(),
    debugNightLightOwner: (ownerId) => nightLights.debugOwner(ownerId),
    debugYardLife: () => yardLife.debug(),
    update: (dt) => {
      waterU.uTime.value += dt;
      const yardLifeChanged = yardLife.update(dt);
      for (const a of animals.handles) a.update(dt);
      return yardLifeChanged;
    },
    // 런타임 LOD — 대규모 주택 청크 FAR↔MID↔FULL(매 프레임, 카메라 필요).
    //   engine.js 렌더 루프에서 camera 넘겨 호출. 정책이 꺼진 규모(R<340)는 빈 배열이라 no-op.
    updateChunkLod: (camera, lensScale = 1, detailReach = 1) => {
      let swaps = 0;   // #140-E 이 프레임에 FAR/MID/FULL 전환이 일어난 청크 수(그림자 1프레임 갱신 트리거)
      for (const child of root.children) {
        if (child.userData.lodUpdate?.(camera, lensScale, detailReach)) swaps++;
      }
      return swaps;
    },
  };
  return root;
}

// 소동물 배치: 초가 마당(닭 무리)·논(소). setupAnimals(env/animals.js) API 재사용.
//   과밀·드로우콜 방지로 규모별 상한. 지면 Y 는 필지 성토 패드(baseY)·논면(f.y) 상수로 얹는다.
function buildVillageAnimals(root, plan, site) {
  const scale = plan.opts.scale;
  const rng = makeRng((plan.seed ^ 0x0a2117) >>> 0);
  const handles = [], flockCenters = [], cowAnchors = [];
  // 닭은 필지 focus 링과 같은 마당을 점유하므로 안정적인 소유 필지 id를 갖는다.
  // 논의 소는 필지 오버레이 소유가 아니어서 null — 집 focus가 소까지 숨기지 않는다.
  const register = (animal, ownerParcelId = null) => {
    animal.ownerParcelId = ownerParcelId;
    animal.group.userData.ownerParcelId = ownerParcelId;
    handles.push(animal);
    return animal;
  };
  // 닭: 초가 필지 ~1/4, 규모별 상한(초가 있으면 최소 1 보장·결정론적 분산 선택).
  const chickenCap = { hamlet: 1, village: 2, town: 3, capital: 4 }[scale] || 2;
  const choga = (plan.parcels || []).filter((p) => !p.hero && p.kind !== 'giwa' && p.poly);
  const nWant = Math.min(chickenCap, Math.max(choga.length ? 1 : 0, Math.round(choga.length * 0.25)));
  const scored = choga.map((p) => ({ p, k: makeRng((p.seed ^ 0xc4c0) >>> 0)() })).sort((a, b) => a.k - b.k);
  for (let i = 0; i < nWant; i++) {
    const p = scored[i].p;
    const lx = p.plotW * 0.08, lz = p.plotD * 0.24;                  // 앞마당(대문 안쪽) 살짝 off-axis
    const pm = new THREE.Matrix4().makeTranslation(p.center.x, p.baseY || 0, p.center.z)
      .multiply(new THREE.Matrix4().makeRotationY(parcelRotY(p)));
    const v = new THREE.Vector3(lx, 0, lz).applyMatrix4(pm);
    const baseY = p.baseY != null ? p.baseY : site.heightAt(p.center.x, p.center.z);
    register(setupAnimals(root, {
      heightAt: () => baseY,
      yard: { x: v.x, z: v.z, r: 1.6 },
      seed: (p.seed ^ 0x6b17) >>> 0,
    }), p.id);
    flockCenters.push({ x: v.x, y: baseY + 0.4, z: v.z });
  }
  // 소: 논 필지 1~2(규모별) — 큰 논 우선, 분산 선택.
  const cowCap = (scale === 'town' || scale === 'capital') ? 2 : 1;
  const paddies = (plan.paddies || []).slice().sort((a, b) => Math.abs(G.polyArea(b.poly)) - Math.abs(G.polyArea(a.poly)));
  const nCow = Math.min(cowCap, paddies.length);
  for (let i = 0; i < nCow; i++) {
    const f = paddies[Math.floor(i * paddies.length / nCow)];
    const c = G.polyCentroid(f.poly);
    register(setupAnimals(root, {
      heightAt: () => f.y,
      cowSite: { x: c.x, z: c.z, yaw: rng.range(0, Math.PI * 2) },
      seed: (plan.seed ^ (0x50 + i)) >>> 0,
      chickens: false,
    }));
    cowAnchors.push({ x: c.x, y: f.y + 1.0, z: c.z });
  }
  return { handles, flockCenters, cowAnchors };
}

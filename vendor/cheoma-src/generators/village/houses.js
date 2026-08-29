import * as THREE from 'three';
import { buildBuilding } from '../../builder/index.js';
import {
  collectOpeningGlowAnchors,
  mirrorOpeningGlowAnchorsX,
} from '../../builder/opening-glow-anchors.js';
import { applyThatchAge } from '../../builder/palette.js';
import { PRESETS } from '../../params.js';
import { parcelMatrix, decomposeByMaterial, mirrorDecomp, shareMaterials } from '../../village/instancing.js';
import { parcelRotY } from '../shared/parcel-transform.js';
import { buildVillageWall } from '../../village/walls.js';
import { buildAuxiliaryBuilding } from '../../village/auxiliary-building-geometry.js';
import { CHOGA_VARIANTS, GIWA_VARIANTS } from '../../village/variants.js';
import { chunkLodDistance } from '../../village/chunks.js';
import {
  CHUNK_LOD_LEVEL,
  createChunkLodPresentation,
  stepChunkLodPresentation,
} from '../../village/lod-policy.js';
import { parcelHouseTranslation } from '../../village/parcel-contract.js';

// ───────────────────────── 집 프로토타입 ─────────────────────────
// buildBuilding(초가/기와) 로 프로토타입을 만들어 clone. 종가·궁·절은 풀디테일 별도.
export function makeHouseProtos() {
  return {
    choga: buildBuilding(PRESETS.choga),
    giwa: buildBuilding(PRESETS.giwa),
  };
}

// 평면 변주 풀 → 변주 인덱스별 decompose 결과 배열(미러 포함). 서로 다른 토폴로지라도 같은
//   팔레트 의미·시각 상태의 재질은 공유하고, 파생 UV 반복과 창호 패턴은 고유하게 보존한다.
//   드로우콜은 변주×재질 규모. matset(=canon 프로토 재질)은 야간 창호광용.
export function buildKindDecomps(kind) {
  const VAR = kind === 'giwa' ? GIWA_VARIANTS : CHOGA_VARIANTS;
  const base = PRESETS[kind];
  const isChoga = kind !== 'giwa';
  const decomps = new Array(VAR.length);
  const glowAnchors = new Array(VAR.length);
  let canon = null, matset = null;
  for (let i = 0; i < VAR.length; i++) {
    if (VAR[i].mirrorOf != null) continue;                 // 미러 항목은 2패스에서
    const proto = buildBuilding({ ...base, ...(VAR[i].ov || {}) });
    const M = proto.userData.materials;
    glowAnchors[i] = collectOpeningGlowAnchors(proto, { space: 'local' });
    // 재질 공유 제외(변주별 고유 유지): (1) choga 이엉 상태 채(thatch/yongmaru/jipjul, 민가=낡음↔부농=신선),
    //   (2) giwa 창호 살 패턴(#55, 변주별 doorPattern 텍스처 — 공유 시 g-base 띠살이 g-wide 를 덮어씀).
    //   choga 창호는 패턴 단일이라 공유 유지(텍스처 절약).
    let ownSet = null;
    if (isChoga) {
      applyThatchAge(M, VAR[i].thatchAge != null ? VAR[i].thatchAge : 0.5);
      ownSet = new Set([M.thatch, M.yongmaru, M.jipjul]);
    }
    const keepOwn = (m) => (ownSet && ownSet.has(m))
      || (!isChoga && m && m.userData && m.userData.role === 'opening');
    if (!matset) matset = M;                                // canon 재질셋(창호광)
    let d = decomposeByMaterial(proto);                     // 프로토로컬 병합(지오 clone)
    d = canon ? shareMaterials(canon, d, keepOwn) : d;      // 재질 refs 를 canon 으로 통일(이엉 제외)
    if (!canon) canon = d;
    decomps[i] = d;
  }
  for (let i = 0; i < VAR.length; i++) {
    if (VAR[i].mirrorOf != null) {
      decomps[i] = mirrorDecomp(decomps[VAR[i].mirrorOf]);
      glowAnchors[i] = mirrorOpeningGlowAnchorsX(glowAnchors[VAR[i].mirrorOf]);
    }
  }
  return { decomps, matset, glowAnchors: Object.freeze(glowAnchors) };
}

// 필지 → 컴파운드(집 + 마당 담). rot 은 로컬 +z 를 도로쪽(frontDir+yaw)으로. 비최적화(디버그) 경로.
export function placeParcel(parcel, protos, wallMats, char01 = 0.5, site = null) {
  const g = new THREE.Group();
  g.name = `parcel-${parcel.kind}`;
  const kind = parcel.kind;
  // 집 본체(디버그 경로는 기본 프로토만 — 변주 스케일은 반영, 평면 변주는 최적화 경로 전용)
  const house = (kind === 'giwa' ? protos.giwa : protos.choga).clone(true);
  const local = parcelHouseTranslation(parcel);
  house.position.set(local.x, 0, local.z);
  house.scale.set(parcel.sx || 1, parcel.sy || 1, parcel.sz || 1);
  g.add(house);
  // 마당 담 — 유형(tile/stone/brush)·부속채 어휘. 필지 부정형 shape 를 따라 변별 담.
  g.add(buildVillageWall(parcel.shape, wallMats, {
    style: parcel.wallType || 'stone', kind: parcel.kind, seed: parcel.seed, char01,
    aux: parcel.aux, auxRequested: parcel.auxRequested,
    plotW: parcel.plotW, plotD: parcel.plotD,
    gateEdge: parcel.access?.gateEdge, gateT: parcel.access?.gateT,
    parcel, site, baseY: parcel.baseY,
    wallHeightK: parcel.wallHeightK, jangdok: parcel.jangdok,
    yardStack: parcel.yardStack, clothesline: parcel.clothesline, vegBed: parcel.vegBed,
  }));
  if (parcel.auxiliary) g.add(buildAuxiliaryBuilding(parcel.auxiliary, wallMats));
  g.rotation.y = parcelRotY(parcel);
  g.position.set(parcel.center.x, parcel.baseY || 0, parcel.center.z);
  g.userData.parcel = parcel;
  return g;
}

// 대규모 주택 청크 런타임 LOD — 저폴리 mass → 실제 재료 외피 → 풀디테일의 3단계 전환.
//   #92 자유 줌 이후 한양 스케일에서 줌인해도 원경 박스 매스가 그대로 보이던 문제 해소.
//   카메라-청크 소유 필지의 최소 3D 거리를 렌즈 보상 전 화면등가 거리로 환산해 visible 토글.
//   히스테리시스(진입/복귀 분리)로
//   경계 왕복 플리커 방지. 한양에서는 중앙·외곽 청크가 모두 이 계약을 쓴다.
export function attachChunkLodSwap(chunkGroup, farMass, midDetail, fullDetail, chunk, policy) {
  // 공개 API의 기존 5인자 계약도 보존한다:
  //   (chunkGroup, impostor, fullDetail, chunk, bowlR)
  // 구 소비자는 원래의 FAR↔FULL 두 단계로 동작하고, 새 6인자 호출만 MID envelope를 사용한다.
  const legacy = policy == null && Number.isFinite(chunk);
  if (legacy) {
    const oldFullDetail = midDetail;
    const oldChunk = fullDetail;
    const bowlR = chunk;
    midDetail = null;
    fullDetail = oldFullDetail;
    chunk = oldChunk;
    policy = {
      fullIn: bowlR * 0.45,
      fullOut: bowlR * 0.53,
      midIn: bowlR * 0.45,
      midOut: bowlR * 0.53,
    };
  }
  // far 분류와 카메라 LOD 임계는 별개이며, 순수 정책의 히스테리시스로 경계 왕복 시
  // 깜빡임을 막는다. 같은 state를 청크와 두 표현에 달아 검증 도구가 내부 탐색 없이 읽는다.
  const presentation = createChunkLodPresentation(CHUNK_LOD_LEVEL.FAR);
  const state = {
    ...presentation,
    chunkId: chunkGroup.name,
    level: CHUNK_LOD_LEVEL.FAR,
    distance: Infinity,
    physicalDistance: Infinity,
    detailReach: 1,
    midIn: policy.midIn,
    midOut: policy.midOut,
    fullIn: policy.fullIn,
    fullOut: policy.fullOut,
    transitionWidth: policy.transitionWidth ?? null,
    swapIn: policy.fullIn,
    swapOut: policy.fullOut,
    parcelIds: new Set(chunk.parcels.map((parcel) => parcel.id)),
    farRoot: farMass,
    impostorRoot: farMass,   // 하위호환 디버그 이름
    midRoot: midDetail,
    fullRoot: fullDetail,
  };
  chunkGroup.userData.lod = state;
  farMass.userData.lod = state;
  if (midDetail) midDetail.userData.lod = state;
  fullDetail.userData.lod = state;

  const screenDoorControllers = (root) => {
    const controllers = [];
    const seen = new Set();
    root?.traverse?.((object) => {
      const controller = object.userData?.screenDoor;
      if (!controller?.set || seen.has(controller)) return;
      seen.add(controller);
      controllers.push(controller);
    });
    return controllers;
  };
  const channels = legacy ? null : {
    far: screenDoorControllers(farMass),
    mid: screenDoorControllers(midDetail),
    full: screenDoorControllers(fullDetail),
  };

  function showOnly(level) {
    state.weights.far = level === CHUNK_LOD_LEVEL.FAR ? 1 : 0;
    state.weights.mid = level === CHUNK_LOD_LEVEL.MID ? 1 : 0;
    state.weights.full = level === CHUNK_LOD_LEVEL.FULL ? 1 : 0;
    farMass.visible = level === CHUNK_LOD_LEVEL.FAR;
    if (midDetail) midDetail.visible = level === CHUNK_LOD_LEVEL.MID;
    fullDetail.visible = legacy
      ? level !== CHUNK_LOD_LEVEL.FAR
      : level === CHUNK_LOD_LEVEL.FULL;
  }
  function showPresentation() {
    farMass.visible = state.weights.far > 0;
    if (midDetail) midDetail.visible = state.weights.mid > 0;
    fullDetail.visible = state.weights.full > 0;
    for (let i = 0; i < channels.far.length; i++) {
      channels.far[i].set(state.channels.far);
    }
    for (let i = 0; i < channels.mid.length; i++) {
      channels.mid[i].set(state.channels.mid);
    }
    for (let i = 0; i < channels.full.length; i++) {
      channels.full[i].set(state.channels.full);
    }
  }
  if (legacy) showOnly(state.level);
  else showPresentation();

  // 반환: 이 프레임에 FAR/MID/FULL 표현 전환이 일어나면 true — 렌더 루프(#140-E)가 그림자 캐시
  //   모드에서 캐스터 구성 변경(FAR castShadow=false ↔ 실제 외피 캐스팅)을 1프레임 반영하는 데 쓴다.
  chunkGroup.userData.lodUpdate = (camera, lensScale = 1, detailReach = 1) => {
    if (!camera?.position) return false;
    const physicalDistance = chunkLodDistance(
      chunk, camera.position.x, camera.position.z, camera.position.y,
    );
    const scale = Number.isFinite(lensScale) && lensScale > 1e-6 ? lensScale : 1;
    // 깊이 배율은 화면 등가 거리 위에 곱해진다(lod-policy.js villageDetailReach). 1이면 이전과
    // 완전히 같은 키이므로 부감·히어로 착지·격리 fixture 는 픽셀 단위로 무회귀다.
    const reach = Number.isFinite(detailReach) && detailReach > 1e-6 ? detailReach : 1;
    const d = physicalDistance / (scale * reach);
    state.physicalDistance = physicalDistance;
    state.detailReach = reach;
    state.distance = d;
    if (legacy) {
      const next = state.level === CHUNK_LOD_LEVEL.FULL
        ? (d > policy.fullOut ? CHUNK_LOD_LEVEL.FAR : state.level)
        : (d < policy.fullIn ? CHUNK_LOD_LEVEL.FULL : state.level);
      if (next === state.level) return false;
      state.level = next;
      showOnly(next);
      return true;
    }
    const changed = stepChunkLodPresentation(state, d, policy);
    if (changed) showPresentation();
    return changed;
  };
}

// 필지 담·마당(어휘 격상: tile/stone/brush + 부속채) 을 필지 배치 변환까지 얹어 반환 — mergeStatic 이 구워 붙인다.
export function buildCourtyard(parcel, wallMats, char01, site = null) {
  const g = buildVillageWall(parcel.shape, wallMats, {
    style: parcel.wallType || 'stone', kind: parcel.kind, seed: parcel.seed, char01,
    aux: parcel.aux, auxRequested: parcel.auxRequested,
    plotW: parcel.plotW, plotD: parcel.plotD,
    gateEdge: parcel.access?.gateEdge, gateT: parcel.access?.gateT,
    parcel, site, baseY: parcel.baseY,
    // #55: 담 높이 연속 변주 + 마당 부속 소품(신분 상관). 전부 공유 재질 → 병합 후 드로우콜 불변.
    wallHeightK: parcel.wallHeightK, jangdok: parcel.jangdok,
    yardStack: parcel.yardStack, clothesline: parcel.clothesline, vegBed: parcel.vegBed,
  });
  g.applyMatrix4(parcelMatrix(parcel));
  return g;
}

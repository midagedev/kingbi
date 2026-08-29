import { DEFAULT_DETAIL_BANDS } from '../core/lod.js';
import { smoothstep } from '../core/math/scalar.js';

// 한양급 주택 청크의 단일 LOD 정책. 계획·런타임·계약 검사가 같은 임계값과
// 히스테리시스 전이를 사용하도록 THREE 없는 순수 모듈에 둔다.
export const CHUNK_LOD_LEVEL = Object.freeze({
  FAR: 'far',
  // 이전 디버그/하네스가 쓰던 이름. 값은 FAR와 같아 표현 상태가 둘로 갈라지지 않는다.
  IMPOSTOR: 'far',
  MID: 'mid',
  FULL: 'full',
});

export const VILLAGE_CHUNK_LOD = Object.freeze({
  // capital R≈280 / town R≈240 used to sit under the old 340 floor, so every regular
  // house stayed FULL while the camera orbit only needed nearby detail. 220 admits
  // town + capital into the same FAR/MID/FULL stack as Hanyang; village (R≈180)
  // stays single-representation for look stability at small scales.
  minSiteR: 220,
  farDistanceFactor: 0.40,
  ringWidthFactor: 0.50,
  maxArcFactor: 0.30,
  // 원거리 mass는 넓은 부감에서만 쓴다. 그보다 가까우면 실제 빌더에서 추출한
  // envelope로 넘어가 색·지붕선이 갑자기 다른 집처럼 바뀌지 않게 한다.
  midInFactor: 0.75,
  midOutFactor: 0.90,
  fullInFactor: 0.45,
  fullOutFactor: 0.53,
  // 화면상 약 10m(Hanyang bowlR=280) 안에서만 인접 두 단계를 보색 screen-door로
  // 이행한다. 가장 좁은 FULL hysteresis dead band보다 짧아 방향 반전에도 안정적이다.
  transitionWidthFactor: 0.035,
});

// screen-door coverage의 고정 단계 수. 순수 정책이 먼저 양자화해 같은 거리의 반복 평가가
// draw-local 채널 변경이나 그림자 캐시 무효화를 만들지 않는다.
export const CHUNK_LOD_TRANSITION_STEPS = 127;

// 상세 표현(FULL/MID)이 카메라로부터 뻗는 깊이. 청크 LOD 키는 화면 등가 거리이므로 보정 dolly가
// 클수록 같은 임계값이 더 먼 물리 거리까지 FULL 을 승격시킨다. 주거 근접 렌즈에서는 그 반경이
// 도성 전체(≈290m)를 덮어, 눈높이 시선이 프레임에 담는 원경 필지 수백 채가 전부 FULL 로 올라온다.
//
// 시선 피치로 그 깊이를 다시 건다. 부감(survey)에서는 지붕 평면이 화면을 채우므로 먼 필지도 실제로
// 읽히지만, 눈높이에서는 앞줄 집·담·나무가 뒤를 가려 원경 FULL 은 화면에 기여하지 않고 비용만 낸다
// (이 엔진에는 occlusion culling 이 없으므로 그 비용은 전부 실비다). 따라서 낮은 시선일수록
// FULL/MID 반경을 줄인다 — "가까운 것만 FULL, 낮은 카메라라도 원경 필지는 MID/FAR".
//
// 렌더 시점 가중치일 뿐이라 plan/populate 산출에는 전혀 들어가지 않는다(worker/sync 해시 불변).
export const VILLAGE_DETAIL_REACH = Object.freeze({
  // 히어로 착지(24°)·부감(31°)은 온전한 깊이를 유지한다.
  surveyPitchDeg: 22,
  // 주거 근접(9°)·1인칭 보행(≈0°)이 최소 깊이를 받는다.
  eyeLevelPitchDeg: 11,
  eyeLevelFactor: 0.56,
});

/** 시선 피치(수평 아래 각도, 도)에 따른 FULL/MID 깊이 배율. 피치를 모르면 부감으로 간주한다. */
export function villageDetailReach(pitchDeg, policy = VILLAGE_DETAIL_REACH) {
  if (!Number.isFinite(pitchDeg)) return 1;
  const survey = smoothstep(policy.eyeLevelPitchDeg, policy.surveyPitchDeg, pitchDeg);
  return policy.eyeLevelFactor + (1 - policy.eyeLevelFactor) * survey;
}

// 카메라가 보는 지면 셀의 생활 디테일 정책. 절대 월드 Y가 아니라 카메라-시선 타깃의 수직차를
// 사용하므로 산지의 높은 필지에서도 근접 동물·입자가 사라지지 않는다. spatial은 소동물,
// altitude는 비선택 필지 앰비언스, particles는 낙엽/꽃잎처럼 지면 맥락이 필요한 입자에 쓴다.
//
// 여기에 속하지 않는 두 표현이 있다(look-audit R3·R4):
//  - 강수(비·눈 낙하)는 하늘·대기 소속이라 `core/lod.js` PRECIPITATION_BAND 를 쓴다. 이 밴드로
//    게이트하면 부감에서 0이 되어 "비 오는 날인데 비가 없는" 상태가 된다.
//  - 굴뚝 연기는 부감에서 마을이 살아있음을 전하는 표현이라 `core/lod.js` AERIAL_LIFE_BAND 로
//    강도만 낮추고 0으로 닫지 않는다. 서브픽셀이 되는 소동물·모트·풀만 이 밴드가 소거한다.
export const VILLAGE_DETAIL_LOD = Object.freeze({
  spatial: Object.freeze({ full: 32, hidden: 72 }),
  view: Object.freeze({ full: 56, hidden: 104 }),
  particleView: DEFAULT_DETAIL_BANDS.particleView,
  altitude: DEFAULT_DETAIL_BANDS.altitude,
  particles: DEFAULT_DETAIL_BANDS.particles,
});

export function villageChunkLodPolicy(site) {
  const siteR = Number(site?.R) || 0;
  const bowlR = Number(site?.bowlR) || 0;
  const enabled = siteR >= VILLAGE_CHUNK_LOD.minSiteR && bowlR > 0;
  const ringW = enabled ? bowlR * VILLAGE_CHUNK_LOD.ringWidthFactor : undefined;
  const fullIn = bowlR * VILLAGE_CHUNK_LOD.fullInFactor;
  const fullOut = bowlR * VILLAGE_CHUNK_LOD.fullOutFactor;
  return {
    enabled,
    farDist: enabled ? bowlR * VILLAGE_CHUNK_LOD.farDistanceFactor : Infinity,
    ringW,
    maxArcLength: enabled ? bowlR * VILLAGE_CHUNK_LOD.maxArcFactor : undefined,
    midIn: bowlR * VILLAGE_CHUNK_LOD.midInFactor,
    midOut: bowlR * VILLAGE_CHUNK_LOD.midOutFactor,
    fullIn,
    fullOut,
    transitionWidth: bowlR * VILLAGE_CHUNK_LOD.transitionWidthFactor,
    // 하위호환: 기존 소비자의 swap 경계는 full-detail 경계를 뜻한다.
    swapIn: fullIn,
    swapOut: fullOut,
  };
}

function quantizedProgress(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * CHUNK_LOD_TRANSITION_STEPS) / CHUNK_LOD_TRANSITION_STEPS;
}

function setStablePresentation(state, level) {
  state.level = level;
  state.transition.active = false;
  state.transition.from = null;
  state.transition.to = null;
  state.transition.progress = 0;
  state.transition.start = 0;
  state.transition.direction = 0;
  state.weights.far = level === CHUNK_LOD_LEVEL.FAR ? 1 : 0;
  state.weights.mid = level === CHUNK_LOD_LEVEL.MID ? 1 : 0;
  state.weights.full = level === CHUNK_LOD_LEVEL.FULL ? 1 : 0;
  state.channels.far = 1;
  state.channels.mid = 1;
  state.channels.full = 1;
}

function setActivePresentation(state, from, to, progress, start, direction) {
  const fromWeight = 1 - progress;
  state.level = from;
  state.transition.active = true;
  state.transition.from = from;
  state.transition.to = to;
  state.transition.progress = progress;
  state.transition.start = start;
  state.transition.direction = direction;
  state.weights.far = 0;
  state.weights.mid = 0;
  state.weights.full = 0;
  state.channels.far = 1;
  state.channels.mid = 1;
  state.channels.full = 1;
  state.weights[from] = fromWeight;
  state.weights[to] = progress;
  // 양수(outgoing)는 낮은 IGN 부분집합, 음수(incoming)는 그 보집합을 소유한다.
  // 따라서 모든 진행도에서 픽셀 구멍·중복 없이 정확히 한 표현만 깊이를 쓴다.
  state.channels[from] = fromWeight;
  state.channels[to] = -progress;
}

export function createChunkLodPresentation(level = CHUNK_LOD_LEVEL.FAR) {
  const state = {
    level,
    transition: {
      active: false, from: null, to: null, progress: 0, start: 0, direction: 0,
    },
    weights: { far: 0, mid: 0, full: 0 },
    channels: { far: 1, mid: 1, full: 1 },
  };
  setStablePresentation(state, level);
  return state;
}

// THREE/DOM/시간에 의존하지 않는 거리 기반 상태 머신. state를 제자리 갱신해 매 프레임 할당을
// 피하고, 실제 표현 또는 screen-door 단계가 달라진 경우에만 true를 반환한다.
export function stepChunkLodPresentation(state, distance, policy) {
  if (!state || !Number.isFinite(distance)) return false;
  const width = Number.isFinite(policy?.transitionWidth) && policy.transitionWidth > 1e-6
    ? policy.transitionWidth : 1;
  const previousLevel = state.level;
  const previousActive = state.transition.active;
  const previousFrom = state.transition.from;
  const previousTo = state.transition.to;
  const previousProgress = state.transition.progress;

  // A wheel/teleport can cross both boundaries between frames. Settle completed adjacent hops in
  // this same distance sample so the final presentation is independent of callback/frame count;
  // an in-band hop still exposes exactly its adjacent pair. Three levels require at most two hops.
  for (let hop = 0; hop < 3; hop++) {
    let from = null, to = null, start = 0, direction = 0;
    if (state.transition.active) {
      ({ from, to, start, direction } = state.transition);
    } else if (state.level === CHUNK_LOD_LEVEL.FAR && distance < policy.midIn) {
      from = CHUNK_LOD_LEVEL.FAR; to = CHUNK_LOD_LEVEL.MID;
      start = policy.midIn; direction = -1;
    } else if (state.level === CHUNK_LOD_LEVEL.MID && distance < policy.fullIn) {
      from = CHUNK_LOD_LEVEL.MID; to = CHUNK_LOD_LEVEL.FULL;
      start = policy.fullIn; direction = -1;
    } else if (state.level === CHUNK_LOD_LEVEL.MID && distance > policy.midOut) {
      from = CHUNK_LOD_LEVEL.MID; to = CHUNK_LOD_LEVEL.FAR;
      start = policy.midOut; direction = 1;
    } else if (state.level === CHUNK_LOD_LEVEL.FULL && distance > policy.fullOut) {
      from = CHUNK_LOD_LEVEL.FULL; to = CHUNK_LOD_LEVEL.MID;
      start = policy.fullOut; direction = 1;
    }
    if (!from) break;
    const progress = quantizedProgress(direction < 0
      ? (start - distance) / width : (distance - start) / width);
    if (progress <= 0) setStablePresentation(state, from);
    else if (progress >= 1) setStablePresentation(state, to);
    else {
      setActivePresentation(state, from, to, progress, start, direction);
      break;
    }
  }

  return state.level !== previousLevel
    || state.transition.active !== previousActive
    || state.transition.from !== previousFrom
    || state.transition.to !== previousTo
    || state.transition.progress !== previousProgress;
}

export function nextChunkLodLevel(level, distance, policy) {
  if (!Number.isFinite(distance)) return level;
  if (level === CHUNK_LOD_LEVEL.FULL) {
    if (distance > policy.midOut) return CHUNK_LOD_LEVEL.FAR;
    return distance > policy.fullOut ? CHUNK_LOD_LEVEL.MID : level;
  }
  if (level === CHUNK_LOD_LEVEL.MID) {
    if (distance < policy.fullIn) return CHUNK_LOD_LEVEL.FULL;
    if (distance > policy.midOut) return CHUNK_LOD_LEVEL.FAR;
    return level;
  }
  if (distance < policy.fullIn) return CHUNK_LOD_LEVEL.FULL;
  return distance < policy.midIn ? CHUNK_LOD_LEVEL.MID : CHUNK_LOD_LEVEL.FAR;
}

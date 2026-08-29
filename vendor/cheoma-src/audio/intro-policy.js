// 첫 진입 BGM 뮤트·복원 상태기계 — three·AudioContext·DOM 무의존 순수 모듈.
//
// 왜 분리했나: 타이틀 구간은 조용해야 하므로 히어로 arm() 이 BGM 볼륨을 0 으로 내린다(의도된 뮤트).
// 그런데 복원이 엔진 곳곳(폴백·랜딩 페이드인·리빌 종료 감시·스킵)에 흩어져 있어서 **뮤트만 하고
// 복원하지 않는 경로가 하나라도 생기면 음악은 영구 무음이고 효과음만 들린다**. 실제 사용자 신고가
// 그 증상이었다. 볼륨 복원은 "상태기계 속성"이지 화면 문제가 아니므로 여기로 끌어내고
// tools/check-audio-policy.mjs 가 모든 경로의 종착 볼륨을 순수 계약으로 단언한다.
//
// 사건(engine 이 호출):
//   arm    — 타이틀 표시(hero.arm). BGM 무음.
//   enter  — 사용자가 타이틀을 눌러 랜딩 시작. 진입 트랙을 INTRO_FADE 동안 0→1 로 스웰.
//   settle — 랜딩이 정착. 볼륨 1 확정 + 시간대 트랙으로 인계(트랙 null = 시간대 소유).
//   skip   — 랜딩을 건너뜀/예외 폴백. settle 과 동일한 종착(즉시 1 + 인계).
//
// 불변식(순수 게이트가 검사):
//   1. volume < 1 인 국면은 'armed'/'entering' 뿐이다.
//   2. 어떤 상태에서든 settle·skip 은 volume 1 + track null 로 끝난다(페이드 중 중단해도 부분 볼륨 잔류 없음).
//   3. 'entering' 을 INTRO_FADE 이상 진행시키면 volume 1 이다.
//   4. volume < 1 인 모든 상태에는 volume 1 로 나가는 사건이 존재한다(영구 무음 사각지대 없음).

import { ENTRY_TRACK } from './track-policy.js';

export const INTRO_FADE = 2.5;                 // 진입 스웰 길이(초) — 레거시 hero.enter 의 2500ms 계승
export const INTRO_PHASES = Object.freeze(['idle', 'armed', 'entering', 'settled']);
export const INTRO_EVENTS = Object.freeze(['arm', 'enter', 'settle', 'skip']);

const SETTLED = Object.freeze({ phase: 'settled', volume: 1, elapsed: INTRO_FADE, track: null });

export function introInitialState() {
  // 히어로 없는 진입(?hero=0·?village=1·shot)은 처음부터 들린다.
  return Object.freeze({ phase: 'idle', volume: 1, elapsed: INTRO_FADE, track: null });
}

// 사건 → 다음 상태. 상태는 불변(freeze)이고 변화가 없으면 **같은 객체**를 돌려준다
// (호출부가 identity 비교로 "전환됨" 을 판정해 bgm.play 를 중복 호출하지 않는다).
export function introReduce(state, event) {
  const s = state || introInitialState();
  switch (event) {
    case 'arm':
      if (s.phase === 'armed') return s;
      return Object.freeze({ phase: 'armed', volume: 0, elapsed: 0, track: null });
    case 'enter':
      // 이미 스웰 중이거나 이미 정착했으면 다시 시작하지 않는다(연타·중복 랜딩 안전).
      if (s.phase === 'entering' || s.phase === 'settled') return s;
      return Object.freeze({ phase: 'entering', volume: 0, elapsed: 0, track: ENTRY_TRACK });
    case 'settle':
    case 'skip':
      if (s.phase === 'settled') return s;
      return SETTLED;
    default:
      return s;
  }
}

// 프레임 진행(초). 'entering' 에서만 볼륨이 오르고, 다른 국면은 무비용 no-op(같은 객체 반환).
export function introAdvance(state, dt) {
  const s = state || introInitialState();
  if (s.phase !== 'entering' || s.volume >= 1) return s;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const elapsed = s.elapsed + step;
  const volume = INTRO_FADE > 0 ? Math.min(1, elapsed / INTRO_FADE) : 1;
  return Object.freeze({ phase: 'entering', volume, elapsed, track: s.track });
}

// 이 국면이 BGM 을 들리게 하는가(진단·계약용).
export function introAudible(state) {
  return (state || introInitialState()).volume >= 1;
}

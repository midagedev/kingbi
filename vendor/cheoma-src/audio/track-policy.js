// BGM 트랙 선택 정책 — three·AudioContext·DOM 무의존 순수 모듈(node 에서 그대로 import 가능).
//
// 왜 분리했나: 트랙 "선택"은 오디오 그래프가 아니라 상태→이름 함수다. 그런데 이 규칙이 bgm.js
// 안에만 있던 동안 assets/audio/genesis.mp3 는 getTracks() 선택지로만 노출되고 **자동 선택 경로가
// 없어 한 번도 재생되지 않았다**(첫 진입 전용으로 준비된 트랙인데 코드가 부르지 않음). 그런 배선
// 누락은 브라우저 없이 판정 가능한 사실이므로 여기로 끌어내고 tools/check-audio-policy.mjs 가
// 파일 존재·이름·도달성까지 순수 계약으로 잠근다.
//
// 계약:
//   · TIME_TRACK  — 시간대 자동 매핑(setTime 이 크로스페이드로 전환).
//   · ENTRY_TRACK — 첫 진입(타이틀 → 히어로 랜딩) 전용. 랜딩이 정착하면 시간대 트랙으로 인계.
//   · MANUAL_TRACKS — 자동 선택 경로가 없는 트랙. **이유를 반드시 적는다**. 이유 없는 고아 mp3 는
//     순수 게이트가 FAIL 시킨다(genesis 회귀 재발 방지).

export const TIME_TRACK = Object.freeze({
  dawn: 'dawn',
  day: 'main-theme',
  sunset: 'sunset',
  night: 'night',
});

// 첫 진입 전용 트랙. 타이틀에서 프리페치하고 랜딩 동안 재생한다.
export const ENTRY_TRACK = 'genesis';

// 자동 선택 경로가 없는 트랙 + 그 이유(빈 문자열 금지).
export const MANUAL_TRACKS = Object.freeze({
  village: 'BGM 선택지 전용. 마을 모드 자동 배선은 미결 제품 결정 — 켤 때 TIME_TRACK 과 겹치는 구간을 먼저 정해야 한다.',
});

// 시간대 자동 선택 트랙 + 진입 트랙. "자동으로 소리가 나는" 트랙의 전체 집합.
export const AUTO_TRACKS = Object.freeze([...new Set([...Object.values(TIME_TRACK), ENTRY_TRACK])]);

// 저장소에 존재해야 하는 트랙 전체(자동 + 수동 선택지).
export const ALL_TRACKS = Object.freeze([...new Set([...AUTO_TRACKS, ...Object.keys(MANUAL_TRACKS)])]);

// getTracks() 로 노출되는 추가 선택지(수동 트랙 + 진입 트랙 — 진입 트랙도 오디션 가능해야 한다).
export const OPTION_TRACKS = Object.freeze([...Object.keys(MANUAL_TRACKS), ENTRY_TRACK]);

// 시간대 이름 → 트랙. 알 수 없는 시간대는 주 테마로 폴백한다(무음 금지).
export function trackForTime(time) {
  return TIME_TRACK[time] || TIME_TRACK.day;
}

// 첫 진입 트랙.
export function trackForEntry() {
  return ENTRY_TRACK;
}

// 진입 트랙 → 시간대 트랙 인계 대상. 현재 트랙이 진입 트랙이 **아니면** null(사용자가 랜딩 중
// 시간대를 직접 바꿨다면 그 선택을 덮지 않는다).
export function handOffTrack(currentTrack, time) {
  return currentTrack === ENTRY_TRACK ? trackForTime(time) : null;
}

export function isKnownTrack(name) {
  return ALL_TRACKS.includes(name);
}

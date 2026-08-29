import { smoothstep } from '../core/math/scalar.js';
// 결정론적 바람 필드 — 비·눈·낙엽 파티클과 나무 흔들림이 "같은 바람"에 함께 반응하게 하는
// 단일 소스. Math.random 을 쓰지 않고 시간 t 의 사인/밸류노이즈 합성만 사용하므로 shot 재현성이
// 보장된다(같은 t → 같은 바람).
//
//   getWind(t) → { dirX, dirZ, speed, gust, angle }
//     dirX,dirZ : 바람이 부는 수평 단위 방향(파티클이 밀려가는 쪽). 서서히 배회한다.
//     speed     : 기저+거스트를 합친 전체 세기(≈0.15~1.3). 파티클 기울기·횡류·sway 배율.
//     gust      : 순간 돌풍 성분 0~1 — 나무가 크게 휘고 낙엽이 소용돌이치는 트리거.
//     angle     : 방향(라디안). 디버그/회전용.
//
// 소비 측(weather.js·seasons.js)은 각자의 계수로 speed 를 곱해 쓴다. 필드 자체가 하나라
// 거스트 타이밍이 전 파티클·나무에서 동기화되어 "바람이 분다"가 화면 전체에서 읽힌다.

const TAU = Math.PI * 2;

// 정수 → [0,1) 결정론 해시. sin 기반이라 순수 함수 → shot 재현성 유지.
function hash1(n) {
  const x = Math.sin(n * 127.13 + 11.7) * 43758.5453;
  return x - Math.floor(x);
}

// 1D 밸류 노이즈(부드러운 보간). 저주파 배회·거스트 포락선에 사용.
function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

// 기저 방향(라디안). 화면 좌→우로 살짝 비껴부는 남서풍 느낌. 여기서 서서히 배회한다.
const BASE_ANGLE = 2.5;

export function getWind(t) {
  // 방향: 기저각 + 아주 느린 배회(±0.6rad). 급변하지 않아 자연스럽다.
  const wander = (vnoise(t * 0.021) - 0.5) * 1.2;
  const angle = BASE_ANGLE + wander;

  // 기저 세기: 완만한 오르내림(정적이지 않게 항상 미풍).
  const base = 0.18 + 0.22 * vnoise(t * 0.06 + 3.1);

  // 거스트: 밸류노이즈 상단만 통과시켜 "이따금 훅" 부는 돌풍. 두 주기를 겹쳐 리듬을 흐트린다.
  const gRaw = 0.6 * vnoise(t * 0.11 + 17.3) + 0.4 * vnoise(t * 0.27 + 5.9);
  const gust = smoothstep(0.55, 0.92, gRaw); // 대부분 0, 이따금 1 근처

  // 전역 세기 배율(기본 1). shot 하네스가 window.__windScale 로 무풍(0)·강풍 비교 컷을 만든다.
  const scale = (typeof window !== 'undefined' && window.__windScale != null) ? window.__windScale : 1;
  const speed = (base + gust * 0.85) * scale;
  return { dirX: Math.cos(angle), dirZ: Math.sin(angle), speed, gust: gust * scale, angle };
}


export { TAU };

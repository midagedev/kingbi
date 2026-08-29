import { smoothstep } from './math/scalar.js';

// 지면 맥락이 필요한 생활 디테일의 기본 수직 밴드. 카메라의 절대 Y가 아니라 시선 타깃과의
// 수직차에 적용한다. 마을·단일 건물·산지 필지가 같은 전환 감각을 공유할 수 있는 가벼운 기본값이다.
export const DEFAULT_DETAIL_BANDS = Object.freeze({
  altitude: Object.freeze({ full: 38, hidden: 62 }),
  particles: Object.freeze({ full: 40, hidden: 52 }),
  particleView: Object.freeze({ full: 46, hidden: 82 }),
});

// 강수(비·눈 낙하)는 하늘·대기 소속이므로 위 지면 디테일 밴드를 공유하지 않는다. 지면 밴드는
// "카메라가 그 지면 셀을 읽고 있는가"를 묻고 0으로 닫는 것이 맞지만, 비 오는 날 부감에서 비가
// 사라지면 날씨 자체가 소거된다(look-audit R3). 그래서 이 밴드는 절대 0을 반환하지 않고,
// 화면 등가 거리에 따라 낙하 볼륨 배율(boxScale)과 빗줄기 길이만 올려 화면상 존재감을 유지하고,
// 비용은 밀도(density = 그리는 인스턴스 비율)로만 낸다.
//
// 입자의 화면 크기 하한은 이 밴드가 아니라 정점 셰이더가 입자별 투영 깊이에서 직접 잡는다
// (weather-physical-geometry.js). 거리 하나로 월드 치수를 통째로 키우면 볼륨 깊이만큼 폭이 갈려
// 앞쪽 입자가 흰 막대로 부푼다(#116 계열). 볼륨 배율은 커버리지만 담당한다.
export const PRECIPITATION_BAND = Object.freeze({
  // 볼륨·밀도·길이는 이 두 화면 등가 거리 사이에서만 움직인다(그 이하 = 근접 물리 스케일).
  nearView: 56,
  farView: 380,
  // 낙하 볼륨(±46m 박스)의 최대 배율. 부감 프레임이 담는 지면 폭을 덮는 값.
  boxScale: 6.2,
  // 원경 빗줄기 길이 배율. 폭은 화면 하한이 잡으므로 길이만 올려 원경에서도 "줄기"로 읽히게 한다.
  rainLengthScale: 4.2,
  // 최소 밀도(그리는 인스턴스 비율). 부감 비용은 밴드 0이 아니라 이 값으로만 낸다.
  density: 0.8,
});

// 부감 생명감 밴드(look-audit R4). 지면 생활 디테일(동물·풀·모트)은 원경에서 서브픽셀이므로
// 0으로 닫는 것이 옳지만, 같은 밴드가 굴뚝 연기까지 함께 지워 부감 마을이 정지한 디오라마가 됐다.
// 연기 기둥은 6m 높이·3m 폭이라 도성 부감에서도 화면 수십 px로 읽히는, 마을이 살아있음을 전하는
// 최대 장치다. 그래서 원경에서 강도만 낮추고(floor) 절대 0으로 닫지 않는 별도 밴드를 둔다.
// 서브픽셀이 되는 표현(소동물·모트·풀)에는 쓰지 않는다 — 그쪽 컬링은 유지가 맞다.
export const AERIAL_LIFE_BAND = Object.freeze({ full: 62, hidden: 300, floor: 0.72 });

/**
 * 화면 등가 거리에서 읽는 생명감 표현 상태.
 *   weight: 강도 배율(floor..1) — 절대 0이 되지 않는다.
 *   boost : 부감 임포스터 전환도(0=근접 실제 스케일, 1=원경 확대 표현). 근접 6m 굴뚝 연기 기둥은
 *           도성 부감에서 십여 px에 불과해 사실상 보이지 않는다. 원경에서만 기둥을 키워
 *           "마을이 살아있음"을 전한다 — 근접 프레임의 실제 스케일은 건드리지 않는다.
 */
export function aerialLifePresence(visualDistance, band = AERIAL_LIFE_BAND) {
  const near = fadeBeyond(visualDistance, band.full, band.hidden);
  const close = Number.isFinite(near) ? near : 0;
  return { weight: band.floor + (1 - band.floor) * close, boost: 1 - close };
}

/**
 * 강수 표현의 거리 종속 조정값. boxScale 은 낙하 볼륨(오브젝트) 스케일, rainLength 는 빗줄기 길이
 * 배율, density(0<d≤1) 는 그릴 인스턴스 비율이다.
 * 어떤 입력에서도 0을 반환하지 않는다 — 강수는 부감에서도 발현한다(look-audit R3).
 */
export function precipitationPresence(visualDistance, band = PRECIPITATION_BAND) {
  const distance = Number(visualDistance);
  const view = Number.isFinite(distance) ? Math.max(0, distance) : band.nearView;
  const k = smoothstep(band.nearView, band.farView, view);
  return {
    k,
    boxScale: 1 + (band.boxScale - 1) * k,
    rainLength: 1 + (band.rainLengthScale - 1) * k,
    density: 1 + (band.density - 1) * k,
  };
}

/** Smoothly keep full detail through `fullUntil`, then fade to zero at `hiddenAt`. */
export function fadeBeyond(value, fullUntil, hiddenAt) {
  if (!Number.isFinite(value)) return 0;
  if (!(hiddenAt > fullUntil)) return value <= fullUntil ? 1 : 0;
  return 1 - smoothstep(fullUntil, hiddenAt, value);
}

// 서로 다른 런타임 소유자(거리 LOD·focus handoff·wave)가 같은 표현의 최종 강도를
// 덮어쓰지 않고 곱으로 합성한다. 비정상 입력은 보이게 남기지 않고 0으로 닫는다.
export function presentationWeight(...weights) {
  let result = 1;
  for (const value of weights) {
    if (!Number.isFinite(value)) return 0;
    result *= Math.max(0, Math.min(1, value));
  }
  return result;
}

// wave가 일반 Object3D visible/material을 직접 소유하면 거리 LOD와 last-writer-wins가 된다.
// 동적 표현은 이 작은 duck-typed controller를 userData.waveFade에 달아 자기 내부에서
// detail/focus/wave 강도를 합성한다. THREE 없는 순수 계약이라 코어·검증 도구가 함께 쓴다.
export function waveFadeController(object) {
  const controller = object?.userData?.waveFade;
  return typeof controller?.setWeight === 'function' ? controller : null;
}

/** Horizontal distance without temporary vectors; useful for camera-local detail cells. */
export function distance2D(a, b) {
  if (!a || !b) return Infinity;
  const ax = Number(a.x), az = Number(a.z), bx = Number(b.x), bz = Number(b.z);
  if (!Number.isFinite(ax) || !Number.isFinite(az)
    || !Number.isFinite(bx) || !Number.isFinite(bz)) return Infinity;
  return Math.hypot(ax - bx, az - bz);
}

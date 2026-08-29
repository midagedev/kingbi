import {
  giwaFootprintMetrics,
  giwaFootprintPoints,
} from './layout/giwa-footprint.js';
import { normalizeChogaShape } from './layout/choga-shape.js';

// 파라미터 정의와 프리셋.
// 길이 단위: 미터. 칸 폭은 어칸(중앙) > 협칸 > 퇴칸(끝) 순으로 좁아진다.

import { DANCHEONG_DEFAULTS } from './builder/dancheong.js';

export const PRESETS = {
  korea: {
    label: 'Korea · Joseon Hall (dapo, hip-and-gable)',
    seed: 20260716,

    // 평면 (칸 체계)
    frontBays: 5,          // 정면 칸수 (홀수)
    sideBays: 3,           // 측면 칸수 (홀수)
    centerBayW: 3.7,       // 어칸 폭
    middleBayW: 3.1,       // 협칸 폭
    endBayW: 2.7,          // 퇴칸 폭
    centerBayD: 3.3,       // 측면 중앙칸 깊이
    endBayD: 2.7,          // 측면 끝칸 깊이

    // 기둥
    columnHeight: 4.0,
    columnRadius: 0.27,
    entasis: 0.55,         // 배흘림 정도 (0~1)
    cornerLean: 0.015,     // 안쏠림 (기둥 상부가 안쪽으로 기우는 비율)
    cornerRaise: 0.07,     // 귀솟음 (모서리 기둥 추가 높이)

    // 기단
    podiumTiers: 2,
    podiumTierH: 0.85,
    podiumMarginF: 2.8,    // 전면 여유
    podiumMarginS: 1.7,    // 측·후면 여유

    // 공포 (다포)
    bracketTiers: 2,       // 출목 수 (제공 단수)
    interBrackets: 2,      // 주간포 수 (기둥 사이)
    bracketScale: 1.0,

    // 지붕
    roofType: 'paljak',    // paljak(팔작) | matbae(맞배) | ujingak(우진각)
    eaveOverhang: 1.55,    // 처마 내밀기 (수평)
    eaveDrop: 0.35,        // 처마 서까래의 하향 물매 (수평 1당 하강)
    roofPitch: 0.82,       // 지붕 전체 물매 (평균 rise/run)
    profileCurve: 0.55,    // 지붕면 오목 곡률 (0=직선)
    cornerLift: 0.75,      // 앙곡: 추녀 끝 들림 (m)
    planCurve: 0.45,       // 안허리곡: 모서리 처마 추가 내밀기 (m)
    hipInsetBays: 1.15,    // 합각이 끝에서 안으로 들어오는 거리(퇴칸 폭 배수)
    hipBreak: 0.50,        // 합각 밑변의 높이 위치 — 용마루~처마 낙차의 비율 (0=용마루)
    gableOverhang: 0,      // (맞배 전용) 박공이 끝 기둥열 밖으로 내미는 거리
    ridgeH: 0.55,          // 용마루 높이
    doubleEave: true,      // 겹처마 (부연)

    // 기단/스타일
    podiumRailing: true,   // 월대 돌난간 (궁 전용)
    ...DANCHEONG_DEFAULTS.palace,
    style: 'palace',       // palace | temple — 재질/창호/단청 계열 선택
  },

  temple: {
    label: 'Korea · Buddhist Hall (jusimpo, gable roof)',
    seed: 20260716,

    // 평면 (칸 체계) — 정면 3칸, 측면 4칸(짝수)
    frontBays: 3, sideBays: 4,
    centerBayW: 4.2, middleBayW: 3.4, endBayW: 3.4,
    centerBayD: 2.4, endBayD: 2.4,

    // 기둥 — 배흘림 절제(술통 방지). entasis 0.40 → 중앙 지름 +12%
    columnHeight: 3.9, columnRadius: 0.27, entasis: 0.40,
    cornerLean: 0.015, cornerRaise: 0.05,

    // 기단 — 높은 장대석 단일 기단, 돌난간 없음
    podiumTiers: 1, podiumTierH: 1.5, podiumMarginF: 2.2, podiumMarginS: 1.4,
    podiumRailing: false,

    // 공포 (주심포) — 기둥 위에만, 리듬의 주인공이 되도록 크게
    bracketTiers: 1, interBrackets: 0, bracketScale: 1.4,

    // 지붕 (맞배) — 볼륨 낮춘 단아한 고려 불전. 지붕높이 ≈ 벽높이 1:1 목표
    roofType: 'matbae',
    eaveOverhang: 1.7, eaveDrop: 0.30, roofPitch: 0.58,
    profileCurve: 0.5, cornerLift: 0.20, planCurve: 0.08,
    cornerEasePow: 3.6,    // 앙곡을 끝 20% 구간에만 몰아 귀 끝 "뿔" 제거 (궁=기본 1.7)
    gableOverhang: 0.9,    // 박공이 끝 기둥열 밖으로 내미는 거리
    hipInsetBays: 1.15,    // (미사용: matbae 경로에서 참조 안 함)
    hipBreak: 0.50,
    ridgeH: 0.4, doubleEave: true,

    ...DANCHEONG_DEFAULTS.temple,
    style: 'temple',
  },

  choga: {
    label: 'Korea · Thatched Cottage (minori, hip roof)',
    seed: 20260716,

    // 평면 — 一자형 가로로 긴 초가삼간 (정면 3칸 넓게, 측면 2칸 얕게). W:D ≈ 1.85:1
    frontBays: 3, sideBays: 2,
    centerBayW: 3.0, middleBayW: 2.6, endBayW: 2.6,
    centerBayD: 2.2, endBayD: 2.2,

    // 기둥 — 가는 각재, 배흘림 없음. 벽 낮고 지붕이 눌러앉는 비례
    columnHeight: 2.2, columnRadius: 0.12, entasis: 0,
    cornerLean: 0, cornerRaise: 0,

    // 기단 — 낮은 외벌대(거의 지면), 벽선 가까이
    podiumTiers: 1, podiumTierH: 0.3, podiumMarginF: 0.5, podiumMarginS: 0.4,
    podiumRailing: false,

    // 공포 없음 (민도리집) — brackets는 도리+장여만
    bracketTiers: 0, interBrackets: 0, bracketScale: 1.0,

    // 지붕 — 볏짚 우진각 (둥근 두툼 실루엣)
    roofType: 'choga',
    eaveOverhang: 1.0, eaveDrop: 0.30, roofPitch: 0.6,
    profileCurve: 0.35, cornerLift: 0.05, planCurve: 0.0,
    cornerEasePow: 1.7,
    gableOverhang: 0, hipInsetBays: 1.0, hipBreak: 0.5,
    ridgeH: 0.3, doubleEave: false,
    thatchThick: 0.38,     // 볏짚 두께(처마 롤·스커트)

    style: 'choga',
  },

  giwa: {
    label: 'Korea · Yangban Tiled House (ㄱ-plan)',
    seed: 20260716,
    style: 'giwa',
    roofType: 'skeleton',

    // 정규 반가 평면. 마을 변주는 같은 계약에서 ㅡ/ㄱ/ㄷ을 선택한다.
    planShape: 'l',
    bays: 3,
    mainHalfW: 4.2,   // 본채 반폭(x)
    mainHalfD: 2.2,   // 본채 반깊이(z)
    wingW: 2.6,       // 날개 폭(x)
    wingLen: 4.0,     // 날개 길이(+z)
    bay: 2.2,         // 주칸 간격

    // 기둥 — 백골 목재
    columnHeight: 3.0, columnRadius: 0.16, entasis: 0.25,

    // 기단 — 낮은 장대석
    podiumTierH: 0.5,

    // 지붕(스켈레톤) 파라미터
    eaveOverhang: 1.4, riseScale: 0.9, profileCurve: 0.5,
    cornerLift: 0.55, planCurve: 0.35, ridgeH: 0.42,
  },
};

// 기와집 풋프린트 정규화의 공개 호환면. 실제 ㅡ/ㄱ/ㄷ 문법과 ㄷ 최소 4칸 규칙은
// layout/giwa-footprint.js 한 곳에 있고 builder/FULL·impostor/FAR·fit이 모두 이를 소비한다.
export function giwaFootprint(P) {
  return giwaFootprintMetrics(P);
}

// 기둥·벽·지붕과 geometry gate가 공유하는 정규화된 평면(CW).
export function giwaFootprintPolygon(P) {
  return giwaFootprintPoints(P);
}

// 팔작 용마루 최소 길이 = 합각폭의 이 배수(#97). ≥1 이면 용마루가 항상 측면 합각보다
// 길어 소전각에서도 뚜렷한 가로 마루로 선다(X자 교차 방지). 넓은 전각은 기본식이 지배.
const RIDGE_MIN_GABLE_K = 1.25;

// 홀수 칸 배열: [퇴칸, 협칸.., 어칸, .., 퇴칸] → 중심 기준 누적 좌표
export function bayPositions(n, centerW, middleW, endW) {
  const widths = [];
  for (let i = 0; i < n; i++) {
    const fromCenter = Math.abs(i - (n - 1) / 2);
    if (fromCenter < 0.6) widths.push(centerW);
    else if (i === 0 || i === n - 1) widths.push(endW);
    else widths.push(middleW);
  }
  const total = widths.reduce((a, b) => a + b, 0);
  const pos = [-total / 2];
  for (const w of widths) pos.push(pos[pos.length - 1] + w);
  return { positions: pos, total };
}

// 파라미터 → 전체 배치 치수 계산
export function computeLayout(P) {
  const params = P.style === 'choga' ? { ...P, ...normalizeChogaShape(P) } : P;
  return computeNormalizedLayout(params);
}

function computeNormalizedLayout(P) {
  // 기와집: 그리드 대신 정규 ㅡ/ㄱ/ㄷ 풋프린트. 카메라·조립용 최소 치수만 산출.
  if (P.style === 'giwa') {
    const { planShape, a, b, c } = giwaFootprint(P);  // 평면 정규화(buildGiwa 와 공유)
    const W = 2 * a;
    const D = 2 * b + (planShape === 'single' ? 0 : c);
    const podTopY = P.podiumTierH;
    const colTopY = podTopY + P.columnHeight;
    const eaveY = colTopY + 0.35;                     // 창방+도리 위 처마 높이
    const ridgeY = eaveY + b * P.riseScale;           // 본채 마루 높이 근사
    return {
      xPos: [], zPos: [], W, D, podTopY, colTopY,
      plateY: colTopY + 0.3, bracketH: 0.24, plateH: 0.3,
      eaveInnerY: eaveY, eaveEdgeY: eaveY, xEave: W / 2 + P.eaveOverhang,
      zEave: D / 2 + P.eaveOverhang, ridgeY, ridgeHalf: 0,
      profile: { s0: 1, s1: 0.3, q: 2, totalDrop: 1, tileLift: 0.22 },
      // Preserve the established ㄱ standalone framing; the new symmetric ㄷ
      // needs its bounding-depth center because both forward wings are visible.
      center: { x: 0, y: (podTopY + ridgeY) / 2, z: planShape === 'u' ? c * 0.5 : 0 },
      totalH: ridgeY + P.ridgeH,
    };
  }
  const fx = bayPositions(P.frontBays, P.centerBayW, P.middleBayW, P.endBayW);
  const fz = bayPositions(P.sideBays, P.centerBayD, P.centerBayD, P.endBayD);

  const W = fx.total;                    // 정면 폭 (기둥 중심 기준)
  const D = fz.total;                    // 측면 깊이
  const podTopY = P.podiumTiers * P.podiumTierH;
  const colTopY = podTopY + P.columnHeight;
  // 창방+평방 높이 (초가 민도리집은 창방만 → 낮게, 지붕이 기둥머리 바로 위에 앉음)
  const plateH = P.style === 'choga' ? 0.18 : 0.34 + 0.20;
  // 공포 스택 높이: 주두 + 제공단 * 단높이
  const bracketH = 0.24 + P.bracketTiers * 0.34;
  const plateY = colTopY + plateH;       // 평방 윗면
  // 외목도리 돌출량: 최상단 살미 길이에 비례
  const purlinOut = (0.55 + 0.42 * (P.bracketTiers - 1)) * 0.8;
  // 서까래 물매선이 외목도리 위를 지나 벽선(주심)에서 갖는 높이.
  // 외목도리(공포 상단)보다 purlinOut*eaveDrop 만큼 높아야 도리가 지붕 밑에 들어간다.
  const eaveInnerY = plateY + bracketH + purlinOut * P.eaveDrop;
  // 처마 끝 높이: 벽선에서 밖으로 나가며 eaveDrop 물매로 하강
  const eaveEdgeY = eaveInnerY - P.eaveOverhang * P.eaveDrop;

  const zEave = D / 2 + P.eaveOverhang;
  const xEave = W / 2 + P.eaveOverhang;
  // 지붕곡 프로파일: 물매가 용마루 쪽 s0에서 처마 쪽 s1(=서까래 물매)로 감소.
  // slope(v) = s1 + (s0-s1)(1-v)^q 를 적분한 낙차 곡선 → 처마 끝 기울기가
  // 서까래 물매와 일치해 외목도리가 지붕면 밑에 정확히 들어간다.
  const s0 = P.roofPitch * 2.0;
  const s1 = P.eaveDrop;
  const q = 1 + P.profileCurve * 2;
  const tileLift = 0.22; // 서까래 위 기와층 두께
  const totalDrop = s1 + (s0 - s1) / (q + 1);
  const ridgeY = eaveEdgeY + zEave * totalDrop + tileLift;
  // 맞배는 용마루가 전 폭 + 박공 내밀기까지 뻗는다(합각 안쏠림 없음).
  // 팔작은 합각이 끝에서 hipInset 만큼 들어온 곳에서 용마루가 끝난다.
  const matbae = P.roofType === 'matbae';
  let ridgeHalf;
  if (matbae) {
    ridgeHalf = W / 2 + (P.gableOverhang || 0);
  } else {
    // 팔작 용마루 반길이. 기본식은 정면폭에서 합각 후퇴(hipInset)를 뺀 값이지만, 이 식은
    // 측면깊이(D)를 반영하지 않아 정면폭≈측면깊이인 소전각에선 용마루가 합각 밑변 깊이보다
    // 짧아진다 → 용마루 소실·내림마루 X자 교차 파탄(#97). 고증상 팔작 용마루는 측면 합각보다
    // 길다. 그래서 합각 반깊이 zGable(roof.js 와 동일한 낙차곡선으로 역산)을 구해, 용마루가
    // 합각폭(2·zGable)의 RIDGE_MIN_GABLE_K 배 이상이 되도록 하한을 건다. 넓은 전각(정전 등)은
    // 기본식이 이 하한보다 크므로 불변.
    const dropN = (v) =>
      (s1 * v + ((s0 - s1) * (1 - Math.pow(1 - v, q + 1))) / (q + 1)) / totalDrop;
    let vStar = 0.3, lo = 0.01, hi = 0.95;
    for (let i = 0; i < 40; i++) { vStar = (lo + hi) / 2; if (dropN(vStar) < P.hipBreak) lo = vStar; else hi = vStar; }
    const zGable = zEave * vStar;
    const base = W / 2 - P.hipInsetBays * P.endBayW;
    const ridgeMin = Math.max(W * 0.12, RIDGE_MIN_GABLE_K * zGable);
    // 안전 상한: 합각이 벽선 밖으로 밀려 측면 회첨이 뒤집히지 않도록 정면폭의 0.46 이내.
    ridgeHalf = Math.min(Math.max(base, ridgeMin), W * 0.46);
  }

  return {
    xPos: fx.positions, zPos: fz.positions,
    W, D, podTopY, colTopY, plateY, bracketH, plateH,
    eaveInnerY, eaveEdgeY, xEave, zEave, ridgeY, ridgeHalf,
    profile: { s0, s1, q, totalDrop, tileLift },
    center: { x: 0, y: (podTopY + ridgeY) / 2, z: 0 },
    totalH: ridgeY + P.ridgeH,
  };
}

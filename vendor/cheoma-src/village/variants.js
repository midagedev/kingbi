// 집 변주 설정 — 순수 데이터/로직(THREE 비의존). parcels.js(배치 데이터)·populate.js(프로토 풀)·
//   walls.js(담장 유형)가 공유한다. 순환참조를 피하려고 렌더 스택과 분리한 얇은 계약면.
//
// 변주 축(부감에서 집집이 다른 표정):
//   · 이산(discrete): 평면 프로토 풀 — 칸수·규모·ㄱ자 방향(flip). 프로토별 InstancedMesh 그룹.
//   · 연속(continuous): 지붕/집 톤 — instanceColor 곱틴트(드로우콜 0). yaw·scale 은 인스턴스 행렬.
//   전부 parcel.seed 결정론 → 같은 seed 는 픽셀 동일. 편집(override)이 이 기본값을 덮는다.

import { makeRng } from '../rng.js';
import {
  householdDiversityProfile,
  pickChogaHouseVariant,
  pickGiwaHouseVariant,
} from './house-diversity.js';

// ── 프로토 풀(평면·치수·상태 사다리). st=스테이처(0=웅크린 민가 … 1=당당한 대가), 신분(rank)과 상관 ──
//   치수(기둥높이·기단높이·용마루높이)를 변주에 baking → 스카이라인 처마선이 들쭉날쭉(드로우콜 불변).
//   flip 항목은 mirrorOf 인덱스의 지오를 X-미러(ㄱ자 방향 반전, 재질 재사용).
// choga: 一자 초가 — 칸수·칸 너비 비율(어칸>협칸)·물매·이엉 두께·기둥/기단/용마루 높이 + 이엉 상태
//   (thatchAge) 사다리 + 창호 개수·폭·높이·하방 판벽·툇마루 스타일을 변주별로 확연히 달리한다(#55/#10).
//   민가(작고 낮고 좁은 균등칸·낡은 회갈 이엉·창 적음) ↔ 여염 ↔ 부농(크고 높고 어칸 강조·금빛 이엉·창 많음).
//   opening 여섯 축은 residential-openings가 shape capacity와 안전 범위로 다시 정규화한다.
export const CHOGA_VARIANTS = [
  // 민가: 좁고 균등한 칸(어칸≈협칸), 낮은 벽, 얕은 툇마루, 창 최소(정면 살창만).
  { name: 'choga-min', st: 0.15, thatchAge: 0.85,
    ov: { frontBays: 3, centerBayW: 2.5, middleBayW: 2.35, endBayW: 2.3, sideBays: 2, columnHeight: 1.95, podiumTierH: 0.2, ridgeH: 0.28, roofPitch: 0.66, thatchThick: 0.34, cornerLift: 0.03,
          doorCount: 1, windowCount: 2, doorWidthK: 0.36, windowWidthK: 0.2,
          doorHeightK: 0.94, windowHeightK: 0.86,
          plankBase: false, maruStyle: 'short' } },
  // 여염: 중간 규모, 어칸이 협칸보다 확연히 넓음, 후면 창 1, 하방 판벽, 온전한 툇마루.
  { name: 'choga-mid', st: 0.5, thatchAge: 0.45,
    ov: { frontBays: 4, centerBayW: 2.7, middleBayW: 2.4, endBayW: 2.2, columnHeight: 2.25, podiumTierH: 0.32, ridgeH: 0.31,
          doorCount: 1, windowCount: 3, doorWidthK: 0.4, windowWidthK: 0.24,
          doorHeightK: 1, windowHeightK: 1,
          plankBase: true, maruStyle: 'full' } },
  // 부농: 정면 5칸 대형. 칸 수로 길이를 늘리되 한 칸 자체를 궁궐처럼 키우지 않아
  // 넓은 일반 필지에서 축소 fallback 없이 살아남고 인간 척도를 보존한다.
  { name: 'choga-bunong', st: 0.9, thatchAge: 0.12,
    ov: { frontBays: 5, centerBayW: 3.0, middleBayW: 2.4, endBayW: 2.1, columnHeight: 2.55, podiumTierH: 0.46, ridgeH: 0.37, roofPitch: 0.57, thatchThick: 0.42,
          doorCount: 1, windowCount: 7, doorWidthK: 0.48, windowWidthK: 0.3,
          doorHeightK: 1.06, windowHeightK: 1.15,
          plankBase: true, maruStyle: 'full' } },
];
// giwa: 활성 그룹 수 4를 그대로 유지하면서 ㅡ 1 + ㄱ 좌우 2 + ㄷ 1로 평면 어휘를 넓힌다.
//   ㄷ은 최소 4칸이며 큰 필지/상위 살림에서만 후보가 되고 실제 roof fit을 통과해야 한다.
//   mirrorOf는 ㄱ 방향만 뒤집어 재질·창호를 공유한다. ㅡ/ㄷ도 토폴로지가 달라도 같은 팔레트
//   의미·시각 상태를 공유해 draw-call/texture 예산을 평면 다양성과 교환하지 않는다.
//   doorPattern은 buildBuilding이 기존 재료에 적용하고 변주별 소유를 유지한다(#55).
export const GIWA_VARIANTS = [
  { name: 'giwa-l', st: 0.52,
    ov: { planShape: 'l', bays: 4, mainHalfW: 4.4, mainHalfD: 2.2, wingLen: 3.8, wingW: 2.2,
      columnHeight: 2.9, podiumTierH: 0.46, ridgeH: 0.4, doorPattern: 'ttisal',
      doorCount: 3, windowCount: 4, doorWidthK: 0.9, windowWidthK: 0.5,
      doorHeightK: 1, windowHeightK: 1 } },
  { name: 'giwa-l-flip', st: 0.52, mirrorOf: 0 },
  { name: 'giwa-single', st: 0.2,
    ov: { planShape: 'single', bays: 3, mainHalfW: 3.3, mainHalfD: 1.8, columnHeight: 2.65, podiumTierH: 0.38, ridgeH: 0.36, doorPattern: 'ttisal',
      doorCount: 1, windowCount: 2, doorWidthK: 0.82, windowWidthK: 0.42,
      doorHeightK: 0.94, windowHeightK: 0.9 } },
  { name: 'giwa-u', st: 0.88,
    ov: { planShape: 'u', bays: 5, mainHalfW: 5.5, mainHalfD: 2.3, wingLen: 4.2, wingW: 2.3, columnHeight: 3.35, podiumTierH: 0.7, ridgeH: 0.49, doorPattern: 'jeongja',
      doorCount: 4, windowCount: 6, doorWidthK: 0.92, windowWidthK: 0.55,
      doorHeightK: 1.04, windowHeightK: 1.14 } },
];

// 지붕/집 톤 곱틴트(instanceColor) — 레거시 단일 톤(rebuildParcel·야간 fallback 용). 재채색이 아니라
//   재료 노화·개별차로 읽히게 1.0 근방으로 미세. #55: 부위별 독립 톤(roofTone/wallTone/…)이 주 경로,
//   이 배열은 부위 톤 미지정 시의 하위호환 단일 곱틴트.
export const TONE = {
  choga: [[1, 1, 1], [1.07, 1.0, 0.9], [0.9, 0.88, 0.82], [1.0, 0.95, 0.86], [0.85, 0.84, 0.8]],
  giwa: [[1, 1, 1], [0.9, 0.94, 1.02], [1.04, 1.01, 0.96], [0.87, 0.89, 0.93], [0.96, 0.98, 1.0]],
};

// ── 부위별 곱틴트 팔레트(#55): 지붕·벽을 독립 샘플 → 같은 변주 이웃도 지붕색·벽색이 달라 "찍어낸" 인상 소멸.
//   재질 복제 없이 각 부위 InstancedMesh 의 instanceColor 만 달리 세팅(드로우콜 불변). 1.0 근방 미세 곱.
const clampCh = (v) => Math.min(1.12, Math.max(0.72, v));
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit3 = (c, rng, amt) => [clampCh(c[0] + (rng() * 2 - 1) * amt), clampCh(c[1] + (rng() * 2 - 1) * amt), clampCh(c[2] + (rng() * 2 - 1) * amt)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// 초가 이엉: 관리 좋은 집(부유)=따뜻한 금빛, 낡은 집=차분한 회갈(개체 햇빛바램·이끼 곱). 부감에서
//   이웃 지붕색이 확연히 갈리도록 스프레드를 넉넉히(회갈↔금빛).
const CHOGA_ROOF = { poor: [0.82, 0.83, 0.81], rich: [1.1, 1.02, 0.87] };
// 기와: 회흑 근처 좁은 곱틴트. 과거 lo≈0.82 쿨 청회 스프레드는 망원에서 일부 지붕을 거의 검게
//   밀어 텍스처 홈과 함께 검은 선 뭉침을 키웠다(#150 item I). 이웃 차이는 유지하되 채널 끝은
//   TILE_LOOK.roofToneChannel* 밴드 안. wealth 약상관은 유지.
export const GIWA_ROOF = {
  lo: [0.90, 0.93, 0.99],
  hi: [1.03, 1.01, 0.99],
  jitter: 0.025,
};
// 초가 토벽: 미색 황토(밝음) ~ 적갈(짙음). 개체 풍화차 커서 이웃이 확연히 다른 벽색.
const CHOGA_WALL = { pale: [1.06, 1.03, 0.96], deep: [0.9, 0.78, 0.63] };
// 기와 회벽: 백(밝음) ~ 미색(누런끼).
const GIWA_WALL = { white: [1.05, 1.04, 1.0], cream: [0.95, 0.92, 0.83] };

// 부위별 톤 4종 → parcel 에 저장. buildHouseInstances 가 material.userData.role 로 분배.
//   dK(#91 다양성 강도): 개체 톤 지터(jit3 amt)만 배율 — rng 소비수·기저 색믹스 불변(dK=1=현행).
function assignRoleTones(parcel, kind, wealth, rng, dK = 1) {
  if (kind === 'giwa') {
    parcel.roofTone = jit3(
      mix3(GIWA_ROOF.lo, GIWA_ROOF.hi, clamp01(rng() * 0.85 + wealth * 0.15)),
      rng,
      GIWA_ROOF.jitter * dK,
    );
    parcel.wallTone = jit3(mix3(GIWA_WALL.white, GIWA_WALL.cream, rng()), rng, 0.03 * dK);
  } else {
    parcel.roofTone = jit3(mix3(CHOGA_ROOF.poor, CHOGA_ROOF.rich, clamp01(wealth * 0.65 + (rng() * 2 - 1) * 0.34)), rng, 0.065 * dK);
    parcel.wallTone = jit3(mix3(CHOGA_WALL.pale, CHOGA_WALL.deep, clamp01(0.45 - (wealth - 0.5) * 0.5 + (rng() * 2 - 1) * 0.3)), rng, 0.03 * dK);
  }
  // 목부재·석재는 은은하게(백골·장대석의 개체차) — 부유할수록 석재 살짝 정연(밝은 다듬돌).
  parcel.woodTone = jit3([1, 1, 1], rng, 0.06 * dK);
  parcel.stoneTone = jit3([0.97 + wealth * 0.06, 0.97 + wealth * 0.05, 0.96 + wealth * 0.04], rng, 0.05 * dK);
}

function variantsFor(kind) { return kind === 'giwa' ? GIWA_VARIANTS : CHOGA_VARIANTS; }
const clampIdx = (list, i) => Math.min(list.length - 1, Math.max(0, i | 0));

// parcel.variant 의 프리셋 오버라이드(ov). 미러 항목은 원본(mirrorOf)의 ov. 편집 기준·치수 표시에 사용.
export function variantOv(parcel) {
  const list = variantsFor(parcel.kind === 'giwa' ? 'giwa' : 'choga');
  const v = list[clampIdx(list, parcel.variant)] || list[0];
  if (v.mirrorOf != null) return list[v.mirrorOf].ov || {};
  return v.ov || {};
}

// FULL/MID/FAR와 focus/edit 오버레이가 같은 좌우 평면을 읽는 단일 계약.
// geometry를 미리 반전하는 인스턴스 경로와 달리 개별 buildBuilding 경로는 이 값을
// Object3D scale.x에 적용한다. 현재 미러 어휘는 giwa ㄱ자에만 존재한다.
export function variantMirrorX(parcel) {
  if (parcel.kind !== 'giwa') return 1;
  const variant = GIWA_VARIANTS[clampIdx(GIWA_VARIANTS, parcel.variant)] || GIWA_VARIANTS[0];
  return variant.mirrorOf != null ? -1 : 1;
}

// parcel.variant 의 이엉 상태(choga). 미러 없음. 기본 0.5.
export function variantThatchAge(parcel) {
  const list = variantsFor(parcel.kind === 'giwa' ? 'giwa' : 'choga');
  const v = list[clampIdx(list, parcel.variant)] || list[0];
  return v.thatchAge != null ? v.thatchAge : 0.5;
}

// 담장 유무·유형 확률 테이블(R-P3, docs/village-walls-parcels.md Q3). 편집(override)으로 덮임.
//   "모든 집에 담"은 고증 오류 — 서민 초가는 개방 마당(open)·생울(hedge)·싸리울(brush)이 흔함.
//   등급(신분 rank + kind) 행 → 유형 확률. char01(민촌↔반촌)로 시프트(반촌↑=담·격식, 민촌↑=울·개방).
//   유형: tile(기와담)·stone(돌담)·mud(토담)·brush(싸리/바자울)·hedge(생울)·open(개방 마당). 비율은 실증 방향 추정치.
export function pickWallType(parcel, char01 = 0.5, rng = Math.random, wallWeights = null) {
  if (parcel.hero) return 'tile';
  const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
  const r = parcel.rank != null ? parcel.rank : 0.5;
  let w;
  if (kind === 'giwa') {
    if (r >= 0.6)      w = { tile: 0.75, stone: 0.25 };
    else if (r >= 0.4) w = { tile: 0.30, stone: 0.55, mud: 0.10, brush: 0.05 };
    else               w = { tile: 0.15, stone: 0.55, mud: 0.20, brush: 0.10 };
  } else {
    if (r >= 0.45)     w = { stone: 0.45, mud: 0.30, brush: 0.15, hedge: 0.05, open: 0.05 };
    else if (r >= 0.3) w = { stone: 0.30, mud: 0.25, brush: 0.25, hedge: 0.08, open: 0.12 };
    else               w = { stone: 0.15, mud: 0.20, brush: 0.30, hedge: 0.12, open: 0.23 };
  }
  // char01 시프트: 반촌(+)일수록 담(tile/stone/mud) 가중↑·울/개방↓, 민촌(−)일수록 반대.
  const s = char01 - 0.5;
  const openish = { brush: 1, hedge: 1, open: 1 };
  let sum = 0; const adj = {};
  for (const k in w) { const v = Math.max(0, w[k] * (openish[k] ? 1 - s * 0.8 : 1 + s * 0.5)); adj[k] = v; sum += v; }
  // #91 담장 스타일 분포 배율(패널 노출) — 유형별 가중 곱(기본 1=무영향). rng 소비수 불변(분포만 시프트).
  //   전부 0으로 소거되면(sum≈0) 배율 무시하고 char01 조정 분포 폴백(파탄 방지).
  if (wallWeights) {
    let ws = 0; const wa = {};
    for (const k in adj) { const v = adj[k] * (wallWeights[k] != null ? Math.max(0, wallWeights[k]) : 1); wa[k] = v; ws += v; }
    if (ws > 1e-6) { for (const k in wa) adj[k] = wa[k]; sum = ws; }
  }
  let x = rng() * sum;
  for (const k in adj) { x -= adj[k]; if (x <= 0) return k; }
  return kind === 'giwa' ? 'stone' : 'brush';
}

// ── 마당 과실수·정원 (docs Q4·R-G1/R-G2, 태스크 #41) ────────────────────────────
//   마당 중앙은 비우고(困 자 금기) 뒤안·담 모퉁이에 과실수. 신분·성격 상관 분포.
//   수종은 순수 문자열(THREE 비의존) — 지오메트리는 gardens.js 가 소비. 편집 노출은 #38③.
export const YARD_SPECIES = ['persimmon', 'jujube', 'apricot', 'plum', 'pomegranate', 'quince'];
// 민가 실용 과실수(감·대추·살구) vs 반가 관상·화목(매화·석류·모과). 감나무 우세.
const PRACTICAL = [['persimmon', 0.5], ['jujube', 0.3], ['apricot', 0.2]];
const ORNAMENTAL = [['plum', 0.45], ['pomegranate', 0.3], ['quince', 0.25]];
const pickWeighted = (list, rng) => {
  let sum = 0; for (const [, w] of list) sum += w;
  let x = rng() * sum;
  for (const [k, w] of list) { x -= w; if (x <= 0) return k; }
  return list[0][0];
};

// ── 필지 등롱(대문·마당 걸이등롱, #83) ────────────────────────────────────────
//   대문 걸이등롱은 반가(giwa)에 흔하고 민가(choga)엔 드물다(부유 상관). 마당 기둥걸이 등롱은
//   대문 있는 부유한 반가에서 가끔. 배치 개수만 결정(위치는 layout/props.js lanternLayout).
//   전용 rng(호출자 시퀀스 불침해) — 결정론·#89 앵커 회귀 방지.
export function pickLanterns(kind, wealth, rng) {
  const gateProb = kind === 'giwa' ? 0.4 + wealth * 0.45 : 0.05 + wealth * 0.22;
  const gate = rng() < gateProb ? 1 : 0;
  const yardProb = (gate && kind === 'giwa') ? 0.2 + wealth * 0.32 : (gate ? 0.04 : 0);
  const yard = rng() < yardProb ? 1 : 0;
  return { gate, yard };
}

// gardenLevel: 0 없음(텃밭·장독대) · 1 과실수 1~2 · 2 여염+화목 · 3 반가 화계·괴석·석지.
export function gardenLevelFor(parcel, char01 = 0.5) {
  if (parcel.hero) return 3;
  const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
  const r = parcel.rank != null ? parcel.rank : 0.5;
  if (kind === 'giwa') return r >= 0.6 ? 3 : r >= 0.4 ? 2 : 1;
  if (r >= 0.45) return 1;
  return char01 > 0.42 ? 1 : 0;             // 민촌 하급은 텃밭(0) 비중↑
}

// 마당 과실수 구성 → { count, species:[...] }. gardenLevel·신분·성격으로 그루수·수종 분포.
function pickYardTrees(parcel, char01, rng) {
  const gl = parcel.gardenLevel != null ? parcel.gardenLevel : gardenLevelFor(parcel, char01);
  let count = gl === 0 ? (rng() < 0.35 ? 1 : 0)         // 텃밭 위주라도 담가 과실수 1 확률
    : gl === 1 ? (rng() < 0.68 ? 1 : 2)
    : gl === 2 ? (rng() < 0.65 ? 2 : 1)
    : 2;                                                // 반가: 관상수+과실수 2
  const r = parcel.rank != null ? parcel.rank : 0.5;
  const ornChance = Math.max(0, Math.min(0.9, 0.12 + r * 0.55 + (char01 - 0.5) * 0.4));
  const species = [];
  for (let i = 0; i < count; i++) {
    species.push(pickWeighted(rng() < ornChance ? ORNAMENTAL : PRACTICAL, rng));
  }
  return { count, species };
}

// parcel 에 변주 필드를 채운다(결정론: parcel.seed). 히어로는 안전 기본값.
//   #55 잠재변수 wealth(신분 rank + 성격 char01 + 노이즈)로 전 축을 상관 샘플링 — 가난한 집은
//   낮은 채·낡은 이엉·짙은 벽·작은 장독대·부속채 없음이 한 몸으로, 부유한 집은 반대로. 개별 독립
//   랜덤을 지양해 "일관된 살림 규모"가 읽히게 하되, 각 축에 개체 노이즈를 남겨 이웃 변별.
//   설정: variant, yaw, sx/sy/sz, wealth, roofTone/wallTone/woodTone/stoneTone(부위별 곱틴트),
//         toneIdx(레거시), wallType, wallHeightK, aux, jangdok(장독 규모), yardStack/clothesline/vegBed,
//         thatchAge, gardenLevel, courtyardTree.
export function assignVariation(parcel, char01 = 0.5, tuning = {}) {
  const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
  // #91 다양성 강도(dK) + 담장 스타일 분포(wallWeights) — 무옵션(dK=1·weights 미지정) 시 현행 정확 재현.
  //   dK 는 개체 지터(yaw·규모 노이즈·톤·담높이·이엉상태)의 진폭만 배율 → wealth 기반 평균·rng 소비수 불변.
  // Focus "다시 짓기" may raise dK and flatten form bands via exploreForms without
  // touching village placement (which never sets those flags).
  const exploreForms = !!tuning.exploreForms;
  const baseDk = tuning.diversityK != null ? tuning.diversityK : 1;
  const dK = Math.min(2, Math.max(0, exploreForms ? Math.max(baseDk, 1.7) : baseDk));
  const wallWeights = tuning.wallWeights || null;
  if (parcel.hero) {
    parcel.variant = 0; parcel.yaw = 0; parcel.sx = parcel.sy = parcel.sz = 1;
    parcel.toneIdx = 0; parcel.wallType = 'tile'; parcel.aux = false; parcel.thatchAge = 0.3;
    parcel.wealth = 1; parcel.wallHeightK = 1;
    parcel.roofTone = parcel.wallTone = parcel.woodTone = parcel.stoneTone = [1, 1, 1];
    parcel.jangdok = 3; parcel.yardStack = false; parcel.clothesline = false; parcel.vegBed = false;
    // 반가 종가: 뒤안 화계 + 사랑마당 괴석·석지 + 매화·감 과실수(gardenLevel 3).
    parcel.gardenLevel = 3;
    parcel.courtyardTree = { count: 2, species: ['plum', 'persimmon'] };
    parcel.lantern = { gate: 2, yard: 1 };   // 종가·관아: 대문 한 쌍 + 마당 걸이등롱(#83)
    return parcel;
  }
  const rng = makeRng((parcel.seed ^ 0x5a17c0de) >>> 0);
  const rank = parcel.rank != null ? parcel.rank : 0.5;
  // 첫 RNG 값은 프로토 선택에만 쓴다. 뒤의 wealth/색/살림 RNG 시퀀스는 평면 정책과 독립이라
  // 새 평면을 넣어도 같은 seed의 연속 변주 축이 불필요하게 전부 바뀌지 않는다.
  const variantRoll = rng();
  // 잠재변수: 신분(주) + 마을 성격(부) + 개체 노이즈. [0,1] 클램프.
  // Rerolls widen wealth noise so stature/scale/tone leave the rank pin more.
  const wealthNoise = exploreForms ? 0.22 : 0.12;
  const wealth = clamp01(rank * 0.72 + (char01 - 0.5) * 0.34 + (rng() * 2 - 1) * wealthNoise);
  parcel.wealth = wealth;
  const household = householdDiversityProfile(parcel, char01, wealth);
  // One correlated stature signal reaches continuous width/height and color;
  // plan/bays use the same profile below.  This makes actual lot and settlement
  // tier matter without turning legal ceilings into literal dimensions.
  const stature = clamp01(wealth * 0.72 + household.household01 * 0.28);
  parcel.variant = kind === 'giwa'
    ? pickGiwaHouseVariant(parcel, char01, wealth, variantRoll, household, { explore: exploreForms })
    : pickChogaHouseVariant(household, variantRoll, { explore: exploreForms });
  // 좌향은 plan의 frontDir 하나가 필지 poly·패드·집·담·픽킹을 모두 결정한다. 예전의 별도
  // yaw는 검증 뒤 실제 렌더만 최대 ±6° 돌려 필지 경계와 집을 어긋나게 했다. RNG 한 칸은
  // 이후 색·살림 변주의 seed 계약을 보존하려고 소비하되 두 번째 공간 회전은 만들지 않는다.
  rng();
  parcel.yaw = 0;
  // 규모: 부유할수록 넓고 높게(스카이라인 처마선 리플 확대) + 개체 노이즈. 폭 0.82~1.19.
  // 도로가 먼저 정한 도시 가구의 structureScale은 필지와 실제 집을 함께 줄인다. plot만
  // 압축해 처마가 담과 이웃집을 뚫는 보정은 허용하지 않는다.
  const structureScale = parcel.structureScale || 1;
  const scaleJitter = exploreForms ? 0.10 : 0.06;
  const heightJitter = exploreForms ? 0.11 : 0.07;
  parcel.sx = (0.9 + stature * 0.16 + (rng() * 2 - 1) * scaleJitter * dK) * structureScale;
  parcel.sz = (0.9 + stature * 0.16 + (rng() * 2 - 1) * scaleJitter * dK) * structureScale;
  parcel.sy = (0.86 + stature * 0.22 + (rng() * 2 - 1) * heightJitter * dK) * structureScale;
  // 부위별 독립 톤(#55 핵심) + 레거시 단일 톤(하위호환).
  assignRoleTones(parcel, kind, clamp01(wealth * 0.8 + household.household01 * 0.2), rng, dK);
  parcel.toneIdx = Math.floor(rng() * TONE[kind].length);
  parcel.wallType = pickWallType(parcel, char01, rng, wallWeights);
  // 담 높이 연속 변주(유무 확률은 pickWallType): 부유할수록 높게 + 개체차. walls.js baseH 에 곱.
  parcel.wallHeightK = 0.82 + wealth * 0.32 + (rng() * 2 - 1) * 0.12 * dK;
  const auxProb = Math.min(0.6, 0.06 + wealth * 0.6);       // 부속채(광·헛간): 부유 상관
  parcel.aux = rng() < auxProb;
  // 장독대 규모(옹기 수): 부유할수록 큼(0~3열). 가난해도 최소 1은 흔함.
  parcel.jangdok = Math.max(0, Math.min(3, Math.round(0.6 + wealth * 2.4 + (rng() * 2 - 1) * 0.7)));
  // 소품: 낟가리(농가·중하 신분 우세), 빨래줄(흔함), 텃밭(중하 신분 우세). 상관+노이즈.
  parcel.yardStack = kind !== 'giwa' && rng() < (0.15 + (1 - wealth) * 0.4);
  parcel.clothesline = rng() < 0.4;
  parcel.vegBed = rng() < (0.2 + (1 - wealth) * 0.45);
  // 이엉 상태(choga) — 변주 사다리 baking 을 wealth 로 미세 시프트(가난=더 낡음). 편집 시 rebuild 가 덮음.
  parcel.thatchAge = clamp01(variantThatchAge(parcel) + (0.5 - wealth) * 0.24 + (rng() * 2 - 1) * 0.08 * dK);
  // 마당 과실수·정원 — 뒤에 뽑아 rng 시퀀스 안정.
  parcel.gardenLevel = gardenLevelFor(parcel, char01);
  parcel.courtyardTree = pickYardTrees(parcel, char01, rng);
  // 필지 등롱(#83) — 전용 rng(위 rng 시퀀스·기존 필드·#89 앵커 불침해).
  parcel.lantern = pickLanterns(kind, wealth, makeRng((parcel.seed ^ 0x1a27ee) >>> 0));
  return parcel;
}

// 변주 인덱스 → 톤 곱틴트 [r,g,b].
export function toneOf(kind, idx) {
  const t = TONE[kind === 'giwa' ? 'giwa' : 'choga'];
  return t[((idx | 0) % t.length + t.length) % t.length];
}

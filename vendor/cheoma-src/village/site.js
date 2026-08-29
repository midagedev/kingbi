import { smoothstep } from '../core/math/scalar.js';
import { makeRng } from '../rng.js';
import { makeWorldEdge } from '../core/math/world-edge.js';
import { createValueNoise2D } from '../core/math/value-noise2.js';
import { createSettlementRelief } from './settlement-relief.js';

// 마을 전용 사이트 지형 — 배산임수(背山臨水)의 토대. (joseon-city.md 규칙 1·2·16)
//   기존 env/terrain.js 는 단일 건물용(평탄 24m + -x 고정 개울축)이라 마을 스케일과
//   배산임수 축(뒤 -z 능선, 앞 +z 물)에 안 맞아, 마을 스케일 heightfield 를 여기서 새로 만든다.
//
// 구도(부감에서 읽혀야 하는 것):
//   - 주산(主山): 북(-z)에 가장 높은 능선. 마을의 등.
//   - 좌청룡·우백호: 동(+x)·서(-x)로 감싸 내려오는 옆 능선(팔).
//   - 명당(明堂): 주산 남쪽 기슭의 완만한 분지 — 마을이 앉는 자리(약간 북고남저).
//   - 명당수(明堂水): 마을 앞(남, +z)을 동서로 가로지르는 개울. 그 남쪽은 안산(案山) 낮은 언덕.
//   - 진입은 남(+z)에서 개울을 건너 북으로 오르며 위계가 상승(동구→…→종가).
//
// makeSite({ scale, seed }) → 순수 데이터 + heightAt/hillAt 클로저.

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerpN = (a, b, t) => a + (b - a) * t;

// ── 규모 연속축(#89) ── siteR(분지 반경, m) 스칼라 하나에서 지형·기복·능선·지형범위를 파생.
//   기존 5 이산 프리셋을 "연속 함수의 앵커(제어점)"로 재해석한다. 각 앵커에서 정확히 재현(회귀 안전),
//   중간 임의 R 은 보간. 사용자 피드백: 4버튼 대신 스케일 슬라이더 하나(hamlet↔hanyang 매끈 연결).
//   benchDrop = 분지 내부 완경사 총 낙차(주산측 → 개울측), undAmp = 저진폭 언듈레이션 진폭.
//
// ── 뒷산(주산) 완만화 ── 사용자 지시: "뒷산의 높이를 좀 낮추면 림패스 만들어내기가 훨씬 유리할 것
//   같아. 하늘도 보기 좋고. 이거 좀 더 완만하게 만들자". ridgeH 는 배산 매스의 유일한 고도 스칼라
//   (ridgeMass·mainPeaks·안산·능선 노이즈·운해 밴드가 모두 Hmax=ridgeH·rHK 종속)라 여기 한 곳만 내리면
//   전 소비처가 비례 추종한다. 근거 세 가지:
//   (1) 광학 — 석양 태양은 고도 9.5°(sunDir [-16,8,-45])이고 방위가 주산(-z)쪽이다. 부감 프레임의
//       상단 광선은 -8°(부감 31° 하향 × 46° 렌즈)이므로, 능선 크레스트가 카메라 기준 -8° 아래로
//       내려가야 능선 위에 하늘 밴드가 열린다. 구값에서 hamlet/village/capital 은 크레스트가 -0.9~-6°
//       라 프레임 상단이 통째로 산이었다(측정: aerialRidgeDeg).
//   (2) 고증 — 실제 배산임수 취락의 주산은 마을에서 수백 m~수 km 떨어져 앙각 10~20°다. 렌더 예산 때문에
//       지형 반경을 마을+버퍼로 조인(#143) 이 씬에서 구 ridgeH 는 마을 중심 앙각 43~49°(=협곡 벽)였다.
//       지형 반경을 넓히는 것은 금지된 레버이므로, 고도를 낮추는 것이 실제 산세에 가까워지는 유일한 축이다.
//   (3) 룩 — 처마선 실루엣은 하늘(또는 소실된 원경 대기)에 걸려야 읽힌다. 어두운 산 벽 앞의 지붕선은
//       역광 림을 받아도 대비를 못 얻는다(docs/look-grammar.md §3 건물·지형 항).
//   분지 서사는 유지한다: 산은 여전히 마을보다 높고 감싸며(앙각 25~33°), 스케일이 커질수록 앙각이
//   완만해지는 기존 위계도 그대로다. 숲 밀도·지형 반경은 불침해(hillAt·bowlR 정규화가 Hmax 종속).
// siteR 농촌 확대: 필지 깊이·LOT_SCALE 확대(parcels.js)에 맞춰 같은 호수가 앉을 분지 여유를
// 확보한다. 숲 밀도는 면적당 불변 — 면적이 늘면 나무 수는 늘고, 밀도를 줄여 비용을 숨기지 않는다.
// capital 은 소폭, hanyang siteR 은 유지(한양 실측 필지 근거, HANDOFF §3.1).
export const SCALE_ANCHORS = [
  { name: 'hamlet',  siteR: 105, ridgeH: 30,  benchDrop: 2.9, undAmp: 0.53 },
  { name: 'village', siteR: 180, ridgeH: 52,  benchDrop: 4.1, undAmp: 0.66 },
  { name: 'town',    siteR: 240, ridgeH: 68,  benchDrop: 5.1, undAmp: 0.76 },
  { name: 'capital', siteR: 280, ridgeH: 90,  benchDrop: 5.9, undAmp: 0.84 },
  // 한양 도성급(#47): capital 대비 선형 ~1.8배 = 면적 ~3.2배. 내사산이 도성을 감싸는 큰 분지.
  { name: 'hanyang', siteR: 500, ridgeH: 112, benchDrop: 8.0, undAmp: 1.02 },
];
// 외딴집 하한(#114): 슬라이더 매핑(scale01)·명명 tier 는 hamlet 앵커 그대로 두고, 절대 siteR 로만
//   그 아래(집 한 채·절 하나 스케일)까지 내려간다. tier 는 'hamlet' 유지 → populate 문법 무수정 감쇠.
const SOLO_FIELD = { siteR: 30, ridgeH: 18, benchDrop: 1.6, undAmp: 0.42 };
export const VILLAGE_SITE_R_MIN = SOLO_FIELD.siteR;       // 외딴집(집 한 채) 분지 하한
export const VILLAGE_SITE_R_MAX = SCALE_ANCHORS[SCALE_ANCHORS.length - 1].siteR * 1.04;
const R_MIN = VILLAGE_SITE_R_MIN;
const R_MAX = VILLAGE_SITE_R_MAX;
const clampR = (R) => clampN(R, R_MIN, R_MAX);

// ── 산·숲·지형 외곽 = 숲 near LOD 밴드에 밀착(#143) ──
//   지형 메시·능선 외곽을 forest-crunch.js 의 원경 나무 LOD 경계(nearR)에 바짝 붙인다. nearR 밖은 원래
//   개별 나무가 아니라 저폴리 캐노피 "블롭"으로 뭉개지던 밴드(#137 forest-far) — 사용자 지시: 이 far 블롭
//   밴드를 지형째 소멸시킨다(맵 테두리를 훨씬 더 잘라냄). 지형이 nearR 를 크게 넘겨 far 블롭이 33~74m
//   폭으로 깔리던 구식(#127 분지비례 버퍼)을 대체한다.
//   설계: (1) terrainR = nearR + 소버퍼 → far 블롭 밴드가 얇은 마감 밴드로만 남고 그 밖은 worldedge
//   먹안개(mist)가 마감. (2) 능선 크레스트(ridgeR)를 near 밴드 안으로 당겨 배산 매스가 통째로 "진짜 숲"
//   (far 블롭 아님)이 되게 한다 — 레퍼런스(한국 산): 마을 바로 뒤 가파른 숲 매스. proportional(terrainMul·R)
//   은 무해한 상한 안전장치로 남긴다. 주거 콘텐츠(필지·위성)는 전 규모에서 nearR 안(측정 확인)이라 절단해도
//   안 잘린다. 사찰 터는 실제 terrain/world 경계를 검사하고 terrain-surface가 경내·진입로를 fixed radius에
//   포함하므로 능선 반경 튜닝과 독립적으로 렌더 지형 안에 남는다.
//   대규모(한양)일수록 nearR/R 가 작아(≈0.80R) 절대 절단폭이 크다 — 사용자 "한양급 더 크게" 부합.
const TERR_EDGE_BUF = 12;     // 지형 가장자리 = nearR + 이 소버퍼(얇은 far 마감 밴드 + worldedge 안개 여유)
const RIDGE_NEAR_INSET = 14;  // 능선 크레스트를 near 밴드 안쪽으로(배산=진짜 숲, 항상 ridgeR<terrainR)
// #143 대규모 추가 절단(사용자 "한양급은 더 크게 많이 잘라내야"): nearR 의 원경항(bowlR·0.28)을 상한해
//   대규모에서 nearR·ridgeR·terrainR 을 함께 안쪽으로 당긴다. terrainR 은 ridgeR(배산 크레스트) 아래로
//   못 내려가므로(내리면 능선이 메시 밖에서 잘림) 지형만 단독 절단 불가 → nearR 을 당기는 것이 유일한
//   결맞는 레버다. 상한은 bowlR·0.28 이 이 값을 넘는 규모(≈R>290, 즉 한양권)에서만 발동 → capital·이하는
//   불변(기존 base 규칙이 이미 capital 273→~212 큰 절단). 한양: 원경항 78→46 → nearR 400→368,
//   terrainR 438→~380(절단 ~58m, capital 절단폭과 대등)·ridgeR 402→~354(배산 더 가파르고 가까이, 실루엣 보존).
const NEAR_FAR_CAP = 46;      // nearR 원경항 상한(m) — 대규모 전용 발동, 배산 매스 압축(능선 실루엣 게이트 검증)

// 앵커 필드(ridgeH·benchDrop·undAmp)의 R-구간 선형보간. 밖은 끝 앵커로 클램프.
//   hamlet 아래(#114)는 가상 solo 앵커로 보간 — 지형·능선이 집 한 채 스케일로 아늑하게 줄어든다.
function anchorField(R, key) {
  const A = SCALE_ANCHORS;
  if (R <= SOLO_FIELD.siteR) return SOLO_FIELD[key];
  if (R < A[0].siteR) return lerpN(SOLO_FIELD[key], A[0][key], (R - SOLO_FIELD.siteR) / (A[0].siteR - SOLO_FIELD.siteR));
  for (let i = 1; i < A.length; i++) {
    if (R <= A[i].siteR) return lerpN(A[i - 1][key], A[i][key], (R - A[i - 1].siteR) / (A[i].siteR - A[i - 1].siteR));
  }
  return A[A.length - 1][key];
}

// 한양 전용 특수 계수(#77·#78·#86 산물)를 보간축에 흡수: capital(R=250)=기본, hanyang(R=500)=압축.
//   도시가 커질수록 주변 개활지·산 범위를 도성 + 적정 버퍼로 조여(terrainMul↓·ridgeMul↓) 불필요한
//   원경 지형 렌더를 없앤다(사용자 반복 피드백: 지형 반경은 마을 반경에 비례 종속). 능선을 도성 뒤로
//   바짝 당기고(mtnMul) 안산을 앞으로 당겨(ansanMul) 성저십리 폭을 압축. R<250 은 기본값(전 규모 불변).
function specialCoeffs(R) {
  const t = clampN((R - 250) / (500 - 250), 0, 1);
  return {
    ridgeMul:   lerpN(1.45, 1.00, t),   // 능선 바깥 런(완만 사면)
    terrainMul: lerpN(1.55, 1.06, t),   // 지형 메시·수목 범위(마을 대비 버퍼)
    mtnMul:     lerpN(-1.02, -0.98, t), // 주산 능선 z(도성 뒤로 당김)
    ansanMul:   lerpN(0.92, 0.86, t),   // 안산 z(앞으로 당김)
  };
}

// siteR(연속) → 사이트 파생 파라미터. 5 이산 앵커에서 기존값 정확 재현.
export function siteConfigFor(R) {
  return {
    siteR: R, dry: false,
    ridgeH: anchorField(R, 'ridgeH'),
    benchDrop: anchorField(R, 'benchDrop'),
    undAmp: anchorField(R, 'undAmp'),
    ...specialCoeffs(R),
  };
}

// scale 입력 정규화: 프리셋명 | 절대 siteR(m, >1) | 0..1 정규화(슬라이더). → siteR(m).
//   숫자 문자열(URL 파라미터·폼 입력, 예 '370')도 숫자로 해석한다.
export function resolveSiteR(scale) {
  if (typeof scale === 'string') {
    if (scale === 'solo') return SOLO_FIELD.siteR;   // 외딴집(#114) — 슬라이더 최소 앵커(집 한 채)
    const a = SCALE_ANCHORS.find((x) => x.name === scale);
    if (a) return a.siteR;
    const n = parseFloat(scale);
    if (isFinite(n)) scale = n; else return SCALE_ANCHORS[1].siteR;
  }
  if (typeof scale === 'number' && isFinite(scale)) {
    if (scale >= 0 && scale <= 1) return scale01ToR(scale);
    return clampR(scale);
  }
  return SCALE_ANCHORS[1].siteR;
}

// 0..1 정규화 ↔ siteR: 5앵커를 균등 구간(0/0.25/0.5/0.75/1.0)에 매핑 → 슬라이더 사분점이 명명 tier.
export function scale01ToR(t) {
  const A = SCALE_ANCHORS, n = A.length - 1;
  const f = clampN(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(f));
  return lerpN(A[i].siteR, A[i + 1].siteR, f - i);
}
export function rToScale01(R) {
  const A = SCALE_ANCHORS, n = A.length - 1;
  R = clampN(R, A[0].siteR, A[n].siteR);
  for (let i = 1; i <= n; i++) {
    if (R <= A[i].siteR) return (i - 1 + (R - A[i - 1].siteR) / (A[i].siteR - A[i - 1].siteR)) / n;
  }
  return 1;
}

// R → 이산 tier(토폴로지·성곽·궁 임계 분기용). 지형은 연속이되, 도로망·성곽·시전·궁 tier 처럼
//   본질적으로 불연속인 문법은 임계에서 스냅한다(joseon-city 문법). 앵커 재현: SCALE_ANCHORS
//   siteR(105·180·240·280·500) → hamlet·village·town·capital·hanyang. 경계는 앵커 산술중점
//   (단, capital↔hanyang 은 성곽 등장을 R400 으로 잡아 R370=성곽없는 대형 도성, R440=성곽 도성).
export function tierForR(R) {
  if (R < 143) return 'hamlet';
  if (R < 210) return 'village';
  if (R < 260) return 'town';
  if (R < 400) return 'capital';
  return 'hanyang';
}

export function makeSite({ scale = 'village', siteR, seed = 20260716,
  undAmpK = 1, ridgeHK = 1, streamMeanderK = 1, stream = true, river = false, bowlK = 1 } = {}) {
  const R = clampR(typeof siteR === 'number' && isFinite(siteR) ? siteR : resolveSiteR(scale));
  const cfg = siteConfigFor(R);
  // ── 분지 크기 = 건축 footprint 종속(#120) ── bowlK 는 plan.js 가 houseTarget/nominal 비로 넘기는
  //   footprint 계수(집 적음→아담한 분지, 많음→넓은 분지). 기본 1(무영향, 현행 반경 재현). 대규모
  //   궁·성곽 붕괴 방지로 여기서도 안전 클램프. bowlR·terrainR·능선·필지·나무가 모두 이 값을 자동 추종.
  const bK = clampN(typeof bowlK === 'number' && isFinite(bowlK) ? bowlK : 1, 0.68, 1.28);
  // ── 지형 옵션 표면화(#91) ── 무옵션 기본(K=1·stream=true)에서 현행 정확 재현. 전부 "현행값에 대한
  //   배율/토글"이라 절대값 하드코딩 이식 없음. 극단에서도 필지 유효성 검사(parcels)가 파탄을 흡수.
  const uAmpK = clampN(undAmpK, 0, 2.2);      // 기복(언듈레이션) 진폭 배율
  const rHK = clampN(ridgeHK, 0.5, 1.6);      // 배산 능선·봉우리 높이 배율(Hmax)
  const meK = clampN(streamMeanderK, 0, 2.5); // 개울 사행(굽이) 정도 배율
  const dry = stream === false ? true : cfg.dry;   // 개울 유무(off=내륙 마른 마을: 개울·다리·논 소멸)
  const riverMode = !dry && river === true && R >= 213;
  const benchDrop = cfg.benchDrop, undAmp = cfg.undAmp * uAmpK;
  const { fbm } = createValueNoise2D(seed ^ 0x51a1, { signed: true });

  // ── 주요 앵커 (z: 음수=북/뒤, 양수=남/앞) ──
  const center = { x: 0, z: -0.24 * R };      // 명당(종가·마을 중심) — 주산 남쪽 기슭
  // A generic capital can straddle a river inside its basin. Hanyang keeps the
  // historical city north of a Han-scale river, while the whole generated
  // settlement extends to both banks outside the wall.
  const streamZ = (riverMode ? (R >= 400 ? 0.47 : 0.18) : 0.30) * R;
  const bowlR = 0.56 * R * bK;                // 분지(마을) 평균 반경 — footprint 계수(bK) 반영(#120)
  const Hmax = cfg.ridgeH * rHK;

  // ── 비원형(부정형) 분지 윤곽(#120) ── 원형 그릇 대신 계곡을 따라 길쭉하거나 굽은 유기적 윤곽.
  //   bowlR 에 방위(theta=atan2(dz,dx)) 종속 배율을 곱한다: 완만한 신장(elongation)축 + 저주파 파동.
  //   신장축은 시드로 잡되 정동/정서(±x, theta≈0)에서 크게 벗어나지 않게 제한 → 주산(북) 실루엣을
  //   흔들지 않는다(북 방향 신장은 능선 압박). 이 배율은 능선 사면 시작선(ridgeMass)·산 매스 게이트
  //   (bowlGate)·필지 외곽(bowlRAt)·흙터 색 경계가 함께 따르므로 부감에서 "원형 마을터" 인상이 풀린다.
  //   ※ bowlGate 도 이 배율에 태운다(구: 스칼라) — 안 그러면 봉우리·좌청룡·우백호가 원형 반경으로
  //   leak-in 해 숲 onset(개활지 윤곽)이 원형으로 굳었다. 봉우리 좌표(mainPeaks)는 제자리(실루엣 보존),
  //   게이트 반경만 방위 종속. 전용 rng(공유 rng·노이즈 불침해, 결정론).
  const bs = makeRng((seed ^ 0xb0513a) >>> 0);
  const shapeAxis = (bs() * 2 - 1) * 0.62;            // 신장축(±x 기준 ±35°) — 정북 신장 배제로 주산 보호
  const shapeElong = 0.14 + bs() * 0.10;              // 신장 강도(0.14~0.24) — 뚜렷한 타원(원형 인상 해소)
  // 유기 굽이: 비대칭 로브(k1, 계곡 한쪽이 더 열림)+저주파 굽이(k2)+중주파 요철(k3) 다중 파동을 겹쳐
  //   "늘인 원"이 아닌 손그림 계곡 윤곽을 만든다. w0(k1) 은 분지를 한쪽으로 부풀려 좌우 대칭을 깬다.
  const w0 = { a: (bs() * 2 - 1) * 0.085, k: 1, p: bs() * 6.2832 };   // 비대칭 로브(계곡 열림 방향)
  const w1 = { a: (bs() * 2 - 1) * 0.100, k: 2, p: bs() * 6.2832 };   // 저주파 굽이(계곡의 휨)
  const w2 = { a: (bs() * 2 - 1) * 0.066, k: 3, p: bs() * 6.2832 };   // 중주파 요철
  function bowlRadial(theta) {
    let m = 1 + shapeElong * Math.cos(2 * (theta - shapeAxis));   // 신장축 양단에서 최대
    m += w0.a * Math.sin(w0.k * theta + w0.p)
       + w1.a * Math.sin(w1.k * theta + w1.p)
       + w2.a * Math.sin(w2.k * theta + w2.p);
    return clampN(m, 0.74, 1.33);
  }
  const bowlRadiusAt = (theta) => bowlR * bowlRadial(theta);       // 방위별 분지 반경(m)
  const bowlRAt = (x, z) => bowlR * bowlRadial(Math.atan2(z - center.z, x - center.x));

  // 산·숲·지형 외곽 = 숲 near LOD 밴드 밀착(#143). nearR 은 forest-crunch.js 원경 나무 LOD 경계와
  //   동일 공식 — 아래 site.nearR 로 노출해 forest-crunch 가 그 값을 소비(단일 진실원, 드리프트 0).
  //   지형/능선을 nearR 에 붙여 far 블롭(nearR 밖 캐노피 블롭) 밴드를 지형째 소멸시킨다. proportional
  //   (terrainMul·R)은 무해한 상한 안전장치. bloom·adapter·populate·worldedge·forest 샘플러가 terrainR 을
  //   자동 추종하므로 여기 한 곳 절단이 전 소비처로 전파된다.
  const nearR = bowlR * 1.15 + Math.min(Math.max(34, bowlR * 0.28), NEAR_FAR_CAP);   // ★ = forest-crunch.js crunchForestTrees nearR(폴백 동일공식)
  // 한강급 물길은 성저에서 끝나는 장식 리본이 아니라 남안에도 나루·취락이
  // 살아야 한다. 여기서만 near LOD 외곽에 최대 60m의 충적 평야를 더한다. 기본 개울·
  // 기본 한양은 0m라 #143의 잘라낸 지형/숲 예산을 그대로 보존한다.
  const riverPlainExtension = riverMode ? Math.max(0, Math.min(60, (R - 250) * 0.24)) : 0;
  const terrainR = Math.min(
    (cfg.terrainMul || 1.55) * R,
    nearR + TERR_EDGE_BUF + riverPlainExtension,
  ); // 지형 메시·수목 외곽
  // 능선 크레스트: near 밴드 안쪽에서 Hmax 도달 → 배산 매스 전체가 진짜 숲(far 블롭 아님)이고 terrainR 안.
  let ridgeR = Math.min((cfg.ridgeMul || 1.45) * R, nearR - RIDGE_NEAR_INSET);
  ridgeR = Math.min(ridgeR, terrainR - 8);                   // 안전: 크레스트는 항상 지형 안
  // 봉우리·좌청룡·우백호 팔(±1.08R)을 clamp 된 지형 메시(±terrainR) 안에 앉힌다 — 안 하면 팔이 메시 밖으로
  //   나가 잘린다. 대규모에서만 <1 → 산 매스가 분지 쪽으로 압축(현행 소규모는 1=불변).
  const mtnK = Math.min(1, (terrainR * 0.94) / (1.08 * R));
  const mountainZ = (cfg.mtnMul || -1.02) * R * mtnK; // 주산 능선(도성 뒤). 대규모=분지+버퍼로 압축
  // 안산(앞산) — 앞은 열림(배산임수). #143 절단으로 terrainR 이 작아진 대규모에선 안산도 지형 안으로 당겨
  //   프레이밍 언덕이 메시 밖에서 잘리지 않게 한다(논은 zFar≤0.4R 라 불침해 — 측정 확인). 소·중규모는 무영향.
  const ansanZ = Math.min((cfg.ansanMul || 0.92) * R, terrainR * 0.92);

  // 비정형 월드 외곽선(worldedge) — 단일 씬(env/terrain.js)과 같은 makeWorldEdge 를 공유하되
  // 마을 스케일로 파라미터화. 지형 메시가 원점 중심 정사각형(-terrainR..terrainR)이라 중심은 원점.
  // populate.buildSiteTerrain 이 최외곽 정점을 edgeRadiusAt(theta) 로 신축하고 저층 운해 링을 두른다.
  // 평균 반경은 지형 범위(terrainR)에 맞춰, 내부(마을·논·개울·필지)는 신축 밴드 밖이라 불변.
  const edge = makeWorldEdge({ cx: 0, cz: 0, radius: terrainR, seed: (seed ^ 0x9e37) >>> 0, amp: 0.14, band: 0.24 });

  // ── 명당수 중심선(사행) ── 동서로 가로지르며 완만히 굽는다.
  const streamMeander = (x) => streamZ + R * 0.05 * meK * Math.sin(x / R * 3.0 + 1.1) + R * 0.03 * meK * Math.sin(x / R * 6.7);
  const streamZat = (x) => streamMeander(x);
  const creekHalf = 0.018 * R + 0.9;
  // A creek caps before becoming a river. Large settlements can opt into a
  // separate alluvial watercourse whose wet channel and planning banks scale
  // together; small settlements never silently turn into river towns.
  const streamWaterHalf = riverMode
    ? Math.min(68, Math.max(30, R * 0.12))
    : Math.min(4, Math.max(1.4, creekHalf * 0.5));
  const streamHalf = riverMode
    ? streamWaterHalf + Math.min(12, Math.max(8, R * 0.024))
    : creekHalf;                                      // 제방을 포함한 하도 반폭
  // A stream cannot climb the enclosing ridge. Reserve a broad, scale-relative
  // valley whose center bed descends monotonically toward -x (the shader flow).
  // The broad shoulder avoids replacing the old buried ribbon with a slot canyon.
  const streamValleyHalf = streamHalf + Math.max(
    riverMode && R >= 400 ? 50 : 8,
    R * (riverMode && R >= 400 ? 0.22 : 0.10),
  );
  // Keep the wet channel and one coarse terrain-cell margin level. Otherwise the
  // triangulated terrain can interpolate a high shoulder across a ribbon edge even
  // though the analytic centerline itself is clear.
  const streamValleyFlatHalf = streamWaterHalf + 3;
  const streamPts = [];
  // 물길 중심선이 비정형 world edge에 닿는 지점을 양쪽에서 따로 찾는다. 과거의
  // ±(terrainR-4) 사각 클램프는 한강급 폭에서 수면이 지형 밖으로 큰 직사각형으로 삐져
  // 나왔다. 끝 9%는 습지·안개 밴드 안에서 점진적으로 좁혀 화면 경계에 자연스럽게 녹인다.
  const edgeClearanceAt = (x, z) => {
    const dx = x - edge.cx, dz = z - edge.cz;
    return edge.edgeRadiusAt(Math.atan2(dz, dx)) - Math.hypot(dx, dz);
  };
  const findStreamEnd = (side) => {
    const limit = Math.min(R * 1.02, terrainR - 4);
    let inside = 0, outside = limit;
    for (let d = 2; d <= limit; d += 2) {
      if (edgeClearanceAt(side * d, streamZat(side * d)) >= 7) inside = d;
      else { outside = d; break; }
    }
    for (let step = 0; step < 28; step++) {
      const mid = (inside + outside) * 0.5;
      if (edgeClearanceAt(side * mid, streamZat(side * mid)) >= 7) inside = mid;
      else outside = mid;
    }
    return side * inside;
  };
  const legacyStreamExtent = Math.min(R * 1.02, terrainR - 4);
  const sx0 = riverMode ? findStreamEnd(-1) : -legacyStreamExtent;
  const sx1 = riverMode ? findStreamEnd(1) : legacyStreamExtent;
  const SN = 72;
  for (let i = 0; i <= SN; i++) {
    const t = i / SN;
    const x = sx0 + (sx1 - sx0) * t;
    streamPts.push({ x, z: streamZat(x), half: streamWaterHalf });
  }
  for (let i = 0; i <= SN; i++) {
    const p = streamPts[i];
    const a = streamPts[Math.max(0, i - 1)], b = streamPts[Math.min(SN, i + 1)];
    const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / tl, nz = (b.x - a.x) / tl;
    const envelope = riverMode
      ? smoothstep(0, 0.09, i / SN) * smoothstep(1, 0.91, i / SN)
      : 1;
    let lo = 0, hi = streamWaterHalf * envelope;
    for (let step = 0; step < 24; step++) {
      const half = (lo + hi) * 0.5;
      const safe = edgeClearanceAt(p.x + nx * half, p.z + nz * half) >= 6
        && edgeClearanceAt(p.x - nx * half, p.z - nz * half) >= 6;
      if (safe) lo = half; else hi = half;
    }
    p.half = lo;
  }
  const streamCross = { x: 0, z: streamZat(0) };  // 진입 스파인이 개울을 건너는 지점(다리)
  const riverNorthLanding = riverMode
    ? { x: 0, z: streamCross.z - streamHalf - 6 }
    : null;
  const riverSouthLanding = riverMode
    ? { x: 0, z: streamCross.z + streamHalf + 6 }
    : null;
  const streamGradeDrop = Math.max(0.6, R * 0.006);
  const streamBedY = (x) => {
    const clamped = Math.max(sx0, Math.min(sx1, x));
    const progress = (clamped - sx0) / Math.max(1e-6, sx1 - sx0) - 0.5;
    return -benchDrop * 0.38 + progress * streamGradeDrop;
  };

  // 능선 융기: 분지 밖으로 갈수록 상승, 뒤(북)가 가장 높고 앞(남, +z)은 열려(물·진입) 낮다.
  // 분지 가장자리에서 가파르게 솟아(가시적 사면) 바깥에서 완만해지도록 rise 곡선을 앞당긴다.
  function ridgeMass(x, z) {
    const dx = x - center.x, dz = z - center.z;
    const r = Math.hypot(dx, dz);
    // #120 비원형: 사면 시작선(피에몬트)을 방위별 분지 반경에 태워 유기적 윤곽으로. 능선 정상 런(ridgeR)도
    //   같은 배율로 신축해 밴드 폭 비례 유지. 신장 방향은 분지가 더 뻗고, 압축 방향은 사면이 일찍 솟는다.
    const mul = bowlRadial(Math.atan2(dz, dx));
    const bR = bowlR * mul, rR = ridgeR * mul;
    // 피에몬트 프로파일(#115-0): 분지 옆을 절벽처럼 세우지 않고, 마을 바로 밖은 완만한 구릉으로 길게
    //   깔다가 바깥에서 본산으로 상승("산사태 압박감" 해소). 멱함수(^1.55)로 하부를 눌러 완경사 런을
    //   늘리고 매스를 바깥으로 민다 — 능선 최고점(ridgeR=Hmax)은 유지, 접근만 완만.
    const rise = Math.pow(smoothstep(bR * 0.98, rR, r), 1.55);   // 긴 완경사 피에몬트
    if (rise <= 0) return 0;
    // 방향 가중: 북(-z)=1, 남(+z)=열림. dirN = (북쪽일수록 +1)
    const dirN = (center.z - z) / Math.max(r, 1e-3);
    const backW = 0.30 + 0.70 * smoothstep(-0.35, 0.9, dirN);
    // 앞 중앙(진입/물)은 골짜기 입처럼 더 낮게 뚫는다.
    const frontNotch = 1 - 0.55 * smoothstep(0.35, -0.15, dirN) * Math.exp(-(x * x) / (0.20 * R * R + 1));
    return Hmax * rise * backW * frontNotch;
  }

  // 주산 봉우리(뚜렷한 실루엣) — 북쪽 능선에 2~3개 융기점.
  function mainPeaks(x, z) {
    // Rm = R·mtnK: 대규모(한양)에서 봉우리·팔을 분지 쪽으로 압축(#127) — 소규모는 mtnK=1 이라 현행 불변.
    const Rm = R * mtnK;
    // 뒷산 완만화: 크레스트 초과분만 깎는다(주봉 1.18→1.12, 부봉 0.86·0.92→0.80·0.86, 팔 0.60→0.56).
    //   초과분이 부감 프레임 상단에서 하늘을 가장 먼저 막는 지점이라서다. 주봉은 여전히 크레스트보다
    //   12% 솟아 실루엣의 정점을 갖는다(1.04 까지 내려 A/B 해보니 능선이 매끈한 호로 뭉개져 실루엣
    //   우선 규율에 어긋났다 — docs/look-grammar.md §2-2). 절대 고도는 ridgeH 가 이미 내렸다.
    const peaks = [
      { x: -0.10 * Rm, z: mountainZ,             h: Hmax * 1.12, s: 0.52 * Rm },
      { x: -0.52 * Rm, z: mountainZ + 0.16 * Rm, h: Hmax * 0.80, s: 0.44 * Rm },
      { x:  0.50 * Rm, z: mountainZ + 0.12 * Rm, h: Hmax * 0.86, s: 0.44 * Rm },
      // 좌청룡·우백호: 옆으로 감싸 내려오는 팔(동·서 중턱). #115-0: 바깥으로 밀어(±1.08R) 마을 옆 벽 압박 완화.
      { x: -1.08 * Rm, z: -0.34 * Rm, h: Hmax * 0.56, s: 0.42 * Rm },
      { x:  1.08 * Rm, z: -0.34 * Rm, h: Hmax * 0.56, s: 0.42 * Rm },
    ];
    let h = 0;
    for (const p of peaks) {
      const d2 = (x - p.x) ** 2 + (z - p.z) ** 2;
      h = Math.max(h, p.h * Math.exp(-d2 / (2 * p.s * p.s)));
    }
    return h;
  }

  // 안산(앞산): 개울 남쪽의 낮고 부드러운 언덕(앞 프레임). 중앙은 트여 원경이 보이게.
  function ansanMass(x, z) {
    if (z < streamZ + 0.06 * R) return 0;
    const rise = smoothstep(streamZ + 0.10 * R, ansanZ + 0.15 * R, z);
    const openMid = 0.5 + 0.5 * smoothstep(0.10 * R, 0.42 * R, Math.abs(x)); // 중앙 낮게(원경 열림)
    return Hmax * 0.42 * rise * openMid;
  }

  const settlementRelief = createSettlementRelief({
    R,
    seed,
    streamZ,
    mountainZ,
    benchDrop,
    undAmp,
    undAmpK: uAmpK,
    macroNoise: fbm,
  });

  // 개울 골짜기(명당수). 기존의 고정 2.2m 감산은 양끝 산 매스를 따라 수면도 다시
  // 10~46m 솟게 했다. 렌더·계획이 공유하는 단조 하상으로 넓게 보간해 물이 산에 묻히지 않는다.
  function streamValleyWeight(x, z) {
    if (dry) return 0;
    const cz = streamZat(x);
    const d = Math.abs(z - cz);
    const weight = smoothstep(streamValleyHalf, streamValleyFlatHalf, d);
    // A large river forms a broad alluvial floor instead of a creek-like notch
    // cut into the front hill. The eased shoulder leaves dry bank elevation yet
    // removes the abrupt ansan slope where ferry wards and fields must settle.
    return riverMode && R >= 400 ? Math.pow(weight, 0.65) : weight;
  }

  // 분지 게이트: 분지 안 0 → 밖 1. 산 덩어리(봉우리 포함)가 분지 바닥으로 새어 들지 않게.
  //   #120 비원형: 게이트 반경도 방위별 분지 반경(bowlRadial)에 태운다. 안 그러면 봉우리·좌청룡·우백호
  //   매스가 스칼라 반경으로 leak-in 해 숲/산 경계가 원형으로 굳는다(ridgeMass 의 비원형을 덮어씀).
  //   이제 압축 방위는 산이 일찍(가까이) 새어들고 신장 방위는 늦게(멀리) — 개활지 윤곽이 유기적으로 늘어난다.
  function bowlGate(x, z) {
    const mul = bowlRadial(Math.atan2(z - center.z, x - center.x));
    const r = Math.hypot(x - center.x, z - center.z);
    return smoothstep(bowlR * mul * 0.92, bowlR * mul * 1.28, r);
  }
  // 산 덩어리(분지 밖만) — 능선·봉우리·안산 중 최대.
  function hillMass(x, z) {
    const g = bowlGate(x, z);
    const ans = ansanMass(x, z);                 // 안산은 개울 남쪽 자체 게이트
    if (g <= 0.001) return Math.max(0, ans);
    return Math.max(ridgeMass(x, z), mainPeaks(x, z) * g, ans);
  }

  function heightAt(x, z) {
    const hilly = hillMass(x, z);
    // The settlement floor owns local relief and broad benches. Fade it toward
    // mountain mass so the ridge keeps its own rock/forest noise grammar.
    const floor = settlementRelief.heightAt(x, z);
    const floorMask = 1 - Math.min(1, hilly / (0.12 * Hmax));
    let h = Math.max(settlementRelief.benchAt(x, z), hilly);
    if (floorMask > 0.001) h += floorMask * (floor - settlementRelief.benchAt(x, z));
    // 능선·산에만 굴곡 노이즈(분지 벤치는 완만 유지 → 집 앉히기 안정)
    if (hilly > 1.5) {
      const n = fbm(x * 0.016, z * 0.016, 4) * (0.09 * Hmax) + fbm(x * 0.05 + 4, z * 0.05 - 3, 3) * (0.03 * Hmax);
      h += n * smoothstep(1.5, 10, hilly);
    }
    const valley = streamValleyWeight(x, z);
    if (valley > 0) h = h + (streamBedY(x) - h) * valley;
    return h;
  }

  // hillAt: 이 점이 "산·능선"인 정도(0..1) — 나무 밀도·숲 마스크·필지 급경사 제외용.
  function hillAt(x, z) {
    return Math.min(1, hillMass(x, z) / (0.28 * Hmax)) * (1 - streamValleyWeight(x, z));
  }

  // 개울 수면 y — 실제 파인 바닥 바로 위(파묻힘 방지).
  const streamY = (x) => heightAt(x, streamZat(x)) + 0.12;

  return {
    scale: tierForR(R), siteR: R, seed, R, terrainR, Hmax,
    edge,                                       // 비정형 외곽선(worldedge) — 지형 신축·운해 링·구름 공유
    center,
    // Creek villages enter across the water. Han-scale river roads terminate at
    // the north ferry landing; no renderer may draw a road ribbon through water.
    entrance: riverMode ? riverNorthLanding : { x: 0, z: streamCross.z + 0.06 * R },
    mountainZ, streamZ, ansanZ, bowlR, ridgeR, nearR,   // nearR: 숲 원경 LOD 경계 단일 진실원(#143, forest-crunch 소비)
    // 비원형 분지 반경(#120) — 필지 외곽·충전 반경이 유기적 윤곽을 따르게(forest 는 bowlR 스칼라 사용, 불침해).
    bowlRAt, bowlRadiusAt,
    heightAt, hillAt,
    streamZat, streamY, streamHalf, streamWaterHalf, streamValleyHalf, streamValleyFlatHalf,
    relief: settlementRelief.config,
    stream: dry ? null : {
      pts: streamPts,
      kind: riverMode ? 'river' : 'creek',
      width: streamHalf * 2,
      cross: streamCross,
      half: streamHalf,
      waterHalf: streamWaterHalf,
      valleyHalf: streamValleyHalf,
      valleyFlatHalf: streamValleyFlatHalf,
      floodplainHalf: riverMode ? streamValleyHalf : streamHalf,
      northLanding: riverNorthLanding,
      southLanding: riverSouthLanding,
      flow: { x: -1, z: 0.12 },
    },
    // 다랑이 논 후보역: 개울 남쪽 ~ 안산 기슭 사이 저지.
    paddyRegion: dry ? null : {
      xMin: -0.7 * R, xMax: 0.7 * R,
      zNear: riverMode ? streamZ + streamHalf + 8 : streamZ + 0.05 * R,
      zFar: riverMode ? Math.min(ansanZ - 0.05 * R, terrainR - 20) : ansanZ - 0.05 * R,
    },
    bounds: { minX: -R, maxX: R, minZ: -R, maxZ: R },
  };
}

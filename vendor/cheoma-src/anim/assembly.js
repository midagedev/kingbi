// 조립(시공) 애니메이션 — 프레임워크 무관 ES 모듈.
//   playAssembly(building, { duration=5, onDone, amp=1 }) →
//     { update(dt) → done:boolean, skip(), seek(t01), isDone() }
//
// 파라메트릭 모델이 "지어지는" 순간을 보여준다. 시공 순서대로 파트가 스태거되며,
// 각 파트는 제자리 아래에서 떠올라 안착한다. 안착 순간 **두부 물리**(스쿼시&스트레치)로
// 눌렸다 펴지며 출렁 복원한다 — 수묵 산수(정적) 위에 통통한 두부 물리의 대비가 이 앱의
// 시그니처 감성. 이 이징 언어는 조립·칸 확장·머지·마을 리롤 웨이브가 공유한다
// (아래 tofuRise/tofuBob/tofuScale export 가 단일 출처 — 방언을 새로 만들지 말 것).
//
// 시맨틱 조립 그룹: 지붕은 **강체 한 덩어리**로 오른다(그룹 transform 하나만).
// 자식별 독립 Y/스케일은 기와 외피·방 천장 하면·서까래의 authored 깊이 스택을 깨
// z-fighting 을 만든다. 등장 순서만 시맨틱 청크(서까래→통덩어리→잡상)와 켜 흐름으로
// visible 스태거한다. 빌더가 지붕 그룹에 userData.asmChunked=true 를 달면 자식을
// userData.asmGroup 태그로 묶어 청크 등장 순서를 정하고, 태그 없는 자식은 'body' 청크.
// 청크 **내부** 켜 흐름: 처마(낮은 면)→용마루(높은 면) 순으로 드러난다.
//
// 부재 리플("다라라락", 사용자 지시 2026-07-26): 반복 부재(기둥열·기단 켜·횡부재 켜)는
// 한꺼번에 올라오지 않고 **아주 약간의 시간차**로 흐른다. 종전에도 자식별 스태거는
// 있었지만 (a) 배열 인덱스 순서라 공간적으로 무의미했고 (b) 이웃 간격이 ~26ms(60fps 1.5
// 프레임)라 수학적으로 비가시였다. 지금은 순서를 **기하에서 유도**하고(아래 ORDER)
// 이웃 간격에 하한(MIN_RIPPLE_SEC)을 둔다.
//
// 원상복구 보장: position.y·scale·visible 만 건드리고, 종료·중단·seek 시 원값으로 정확히
// 복원한다. 시작 시 각 자식의 원 transform 을 저장하므로 regenerate 와 경합해도 skip()으로
// 안전히 되돌린다. (기존 ?assemble=1 데모 셸 seek/skip 경로 호환 유지.)

const PART_ORDER = ['podium', 'columns', 'walls', 'brackets', 'roof'];

// Depth-critical under-eave stack: outer tile + structural 개판 (+ eave band lip)
// + rafters. Room 반자 is deferred (docs/ceiling.md).
// Hiding only the shell left rafters free to rise through the plate/창방 band
// ("기둥 위에 반자" residual after the shell-only gate).
const ROOF_SHELL_NAMES = new Set(['roof-tile-outer', 'roof-gaepan', 'roof-eave-band']);

function isRoofShellPiece(obj) {
  if (!obj) return false;
  if (ROOF_SHELL_NAMES.has(obj.name)) return true;
  // Builders may omit names on intermediate clones; still tag gaepan materials.
  if (obj.userData?.roofLayer === 'gaepan') return true;
  if (obj.material?.userData?.isRoofGaepan) return true;
  if (obj.material?.userData?.paletteKey === 'gaepan') return true;
  return false;
}

/** Shell + rafters: coplanar scrape risk against plate/창방 while the rigid roof rises. */
function isUnderEaveCritical(obj) {
  if (!obj) return false;
  if (isRoofShellPiece(obj)) return true;
  if (obj.userData?.asmGroup === 'rafters') return true;
  if (obj.userData?.roofLayer === 'rafter') return true;
  return false;
}

/** Keep each roof-tile-outer / roof-gaepan pair on the same visible bit. */
function lockRoofShellVisibility(roofGroup) {
  if (!roofGroup?.children?.length) return;
  for (let i = 0; i < roofGroup.children.length - 1; i++) {
    const a = roofGroup.children[i];
    const b = roofGroup.children[i + 1];
    if (a?.name === 'roof-tile-outer' && b?.name === 'roof-gaepan') {
      b.visible = a.visible;
    }
  }
  // Eave band sits on the same physical shell stack; if the outer is hidden the
  // band alone reads as a coplanar lip on the rising gaepan.
  for (let i = 0; i < roofGroup.children.length; i++) {
    const band = roofGroup.children[i];
    if (band?.name !== 'roof-eave-band') continue;
    // Prefer the preceding outer on this face (add order: outer, gaepan, band).
    let outer = null;
    for (let j = i - 1; j >= 0; j--) {
      if (roofGroup.children[j]?.name === 'roof-tile-outer') {
        outer = roofGroup.children[j];
        break;
      }
    }
    if (outer) band.visible = outer.visible;
  }
}

// 파트별 타임라인 윈도(전체 duration 대비 비율). 시공 순서 스태거, 살짝 겹쳐 흐름을 만든다.
const PART_WINDOWS = {
  podium:   [0.00, 0.26],
  columns:  [0.18, 0.48],
  walls:    [0.42, 0.64],
  brackets: [0.58, 0.82],
  roof:     [0.74, 1.00],
};

// 파트별 낙하 거리 배수(묵직함 차등 — 기단은 작게, 지붕은 크게 떠오른다).
const PART_DROP = { podium: 0.7, columns: 1.0, walls: 0.9, brackets: 0.85, roof: 1.15 };

// 파트별 두부 탄성 진폭(스쿼시&스트레치 강도). 기둥은 스프링처럼 튀고, 지붕은 절제한다.
//   지붕 0.32 → 0.22: 구 모델은 접촉에서 변형이 정확히 0 이라 스트레치가 **상승 중에만**(대부분
//   시야 밖) 보였다. 모멘텀 연속 모델은 접촉 순간에도 변형이 남으므로, 같은 게인이면 팔작 지붕의
//   들린 처마 끝이 낫처럼 과장돼 보인다(캡처 판정 cont-34). 처마 선은 이 프로젝트의 서명이므로
//   (look-grammar: 실루엣 우선) 지붕만 게인을 낮춘다 — 정착 스쿼시는 여전히 읽힌다(≈3%).
const PART_TOFU = { podium: 0.13, columns: 0.28, walls: 0.17, brackets: 0.20, roof: 0.22 };

// 지붕 시맨틱 청크 순서(작을수록 먼저). 태그 없는 부재의 기본 청크는 'body'.
//  rafters(서까래) → body(기와/이엉 통덩어리) → finial(잡상 등 미니팝).
const ROOF_SEQ = { rafters: 0, body: 1, finial: 2 };
const DEFAULT_CHUNK = 'body';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// 접촉 시점(자식 로컬 진행도 u 기준). u<IMPACT 는 제자리로 떠오르는 구간, 이후는 두부 정착.
const IMPACT = 0.5;
// Under-eave reveal progress on the roof motion (u). IMPACT alone is too early:
// contact lands at rest Y for one sample, then tofu bob overshoots and the
// gaepan/rafters scrape the plate/창방 band ("기둥 위에 반자"). Wait until the
// settle spring has mostly damped (≈70% of the post-contact window).
// Shell-only gate left rafters free mid-rise; both now share this threshold.
const SHELL_REVEAL_UU = IMPACT + (1 - IMPACT) * 0.70;

// ── 두부 물리: 모멘텀 연속 정착(2026-07-26 사용자 지시 3차) ─────────────────────────────
// 이력과 사용자 판정을 그대로 남긴다(다음 사람이 코드에서 옛 규칙을 재유도하지 않게).
//   ① 최초: 접촉 후 cos 1.6사이클 감쇠 진동을 **별도 단계**로 붙였다 → "다 지어진 다음에 그
//      이후 영역만 한번 덜렁거리고 만다"고 기각. 원인은 진폭이 아니라 **구조**였다: 상승이
//      easeOutCubic 이라 IMPACT 에서 속도가 정확히 0 → 그 뒤 어떤 탄성도 물려받을 운동량이
//      없으니 임의 진폭의 독립 흔들림밖에 될 수 없었다.
//   ② #126: 반동 단계를 아예 삭제(오버슈트 0, 단조). "띠용"은 사라졌지만 정착의 질감도 사라졌다.
//   ③ 현행(사용자 재지시): 탄성 자체는 원한다. 원하는 건 **"바닥에서 올라오는 그 가속도 그대로
//      푸딩 같은 느낌"** — 하나의 연속 운동. 그래서 상승이 **0 이 아닌 속도로 접촉**하고
//      (VEND), 정착은 그 접촉 속도를 초기속도로 갖는 감쇠 스프링이다. 스쿼시 진폭은 상수로
//      적는 게 아니라 **접촉 속도에서 유도**되므로, 무거운 부재(지붕)는 접근 속도·drop 이 커서
//      자연히 더 묵직하게 읽힌다.
// 계약:
//   · 상승(u<IMPACT): 정규 속도가 1 → VEND 로 감속하지만 0 이 되지 않는다(모멘텀 보존).
//   · 정착(u≥IMPACT): 위치는 접촉 속도를 초기속도로 갖는 감쇠 스프링(작은 오버슈트→복귀),
//     변형은 그 수직 속도에 비례(올라갈 때 stretch sy>1, 되돌아올 때 squash sy<1·sxz>1).
//   · u=1 에서 위치·스케일이 **정확히** 원상 — 포락 (1-w²) 이 w=1 에서 0 이므로 잔여 오프셋 0.
//   · 접촉에서 값·도함수 모두 연속(C1) → "이제부터 흔들림" 하는 단절이 없다.
const VEND = 0.6;                                  // 접촉 순간 남는 정규 상승 속도(0=구 무반동 모델)
const RISE_N = VEND + (1 - VEND) / 3;              // 상승 속도 프로파일의 적분(위치 정규화 상수)
const SETTLE_W = 2 * Math.PI * 1.25;               // 정착 스프링 각속도(정착창 1.25 사이클)
const SETTLE_Z = 2.2;                              // 정착 감쇠(클수록 한 번에 잦아든다)
const CONTACT_V = VEND / (RISE_N * IMPACT);        // 접촉 속도 [drop/u]
const BOB_V0 = CONTACT_V * (1 - IMPACT);           // 정착창 로컬(w) 초기속도

// 정규 상승 속도(k=u/IMPACT): 1 → VEND. 이 형상의 적분이 상승 위치를 만들고, 이 값 자체가
//   스쿼시&스트레치를 구동한다(속도 결합 — 단일 출처).
const riseVel = (k) => VEND + (1 - VEND) * (1 - k) * (1 - k);
// 정착 포락: w=1 에서 정확히 0(잔여 오프셋 0), w=0 에서 값 1·도함수 0(접촉 C1 보존).
const settleEnv = (w) => 1 - w * w;

// TOFU_STRETCH: 속도→변형 결합 게인(1=또렷한 스쿼시&스트레치, 0=변형·정착 없이 순수 상승 A/B).
//   window.__tofuStretch(런타임 튜닝)·window.__tofuLegacy(①의 구 반동 A/B) 오버라이드.
//   하위호환: setTofuBounce/getTofuBounce 는 이 게인의 별칭으로 유지(외부 API 시그니처 불변).
let TOFU_STRETCH = 0.7;
export function setTofuBounce(k) { TOFU_STRETCH = Math.max(0, Math.min(1, k)); }
export function getTofuBounce() { return TOFU_STRETCH; }
function stretchK() {
  if (typeof window !== 'undefined' && typeof window.__tofuStretch === 'number') return window.__tofuStretch;
  if (typeof window !== 'undefined' && typeof window.__tofuBounce === 'number') return window.__tofuBounce; // 구 훅 호환
  return TOFU_STRETCH;
}
function tofuLegacy() { return typeof window !== 'undefined' && !!window.__tofuLegacy; }

// 상승 오프셋 계수(1→0, drop 배수). caller: position.y = y0 - tofuRise(u) * drop + tofuBob(...) * drop.
//   IMPACT 에서 0 이지만 **속도는 CONTACT_V** — 그 운동량이 곧 정착의 초기조건이다.
export function tofuRise(u) {
  if (u <= 0) return 1;
  if (u >= IMPACT) return 0;
  const k = u / IMPACT;
  if (tofuLegacy()) return 1 - easeOutCubic(k);
  const area = VEND * k + (1 - VEND) * (1 - (1 - k) ** 3) / 3;
  return 1 - area / RISE_N;
}

// 정착 오버슈트 계수(drop 배수, 0 → 작은 양수 → 작은 음수 → 정확히 0).
//   접촉 속도를 초기속도로 갖는 감쇠 스프링. 진폭은 상수가 아니라 모멘텀에서 나온다(≈drop 의 7%).
//   stretchK()==0 이면 탄성 없음(순수 상승 A/B). amp 는 legacy 경로 호환용으로만 쓰인다.
export function tofuBob(u, amp = 0.2) {
  if (u < IMPACT || u >= 1) return 0;
  const w = (u - IMPACT) / (1 - IMPACT);
  if (tofuLegacy()) return amp * Math.exp(-w * 4.5) * Math.sin(w * Math.PI * 2 * 1.6) * 0.6;
  if (stretchK() <= 0) return 0;
  return (BOB_V0 / SETTLE_W) * Math.exp(-SETTLE_Z * w) * Math.sin(SETTLE_W * w) * settleEnv(w);
}

// 정규 변형량(발사 시 1 기준). 상승 구간은 상승 속도 그대로(빠를수록 늘어난다).
//   정착 구간은 **접촉 순간의 변형 VEND 에서 풀려나는 자유 감쇠 응답** — 상승이 늘려 둔 두부가
//   접촉으로 밑동이 멈추면서 저장된 변형을 놓아주는 형태다. 초기 도함수가 0 이라 상승 구간과
//   값·도함수 모두 연속(C1)이고, 진폭은 authored 상수가 아니라 접촉 속도 VEND 에서 나온다.
//   포락이 w=1 에서 0 이므로 잔여 변형 없이 정확히 항등으로 수렴한다.
function tofuDeform(u) {
  if (u <= 0 || u >= 1) return 0;
  if (u < IMPACT) return riseVel(u / IMPACT);
  const w = (u - IMPACT) / (1 - IMPACT);
  const osc = Math.cos(SETTLE_W * w) + (SETTLE_Z / SETTLE_W) * Math.sin(SETTLE_W * w);
  return VEND * Math.exp(-SETTLE_Z * w) * osc * settleEnv(w);
}

// 두부 스쿼시&스트레치 배율. u(자식 진행 0..1), amp(진폭) → { sy, sxz }. 부피보존 1차 근사.
//   상승 중엔 진행방향(수직)으로 늘어나고(sy>1, sxz<1), 정착에서 되돌아오는 동안 눌린다
//   (sy<1, sxz>1) — 하나의 속도 함수가 양쪽을 다 만들므로 "이제부터 흔들림" 단절이 없다.
export function tofuScale(u, amp = 0.2) {
  if (u <= 0 || u >= 1) return { sy: 1, sxz: 1 };
  if (tofuLegacy()) {
    if (u < IMPACT) {
      const k = u / IMPACT;
      const s = amp * 0.30 * Math.sin(k * Math.PI * 0.5);
      return { sy: 1 + s, sxz: 1 - s * 0.5 };
    }
    const w = (u - IMPACT) / (1 - IMPACT);
    const decay = Math.exp(-w * 4.2);
    const osc = Math.cos(w * Math.PI * 2 * 1.6);
    return { sy: 1 - amp * decay * osc, sxz: 1 + amp * 0.55 * decay * osc };
  }
  const s = amp * stretchK() * tofuDeform(u);
  return { sy: 1 + s, sxz: 1 - s * 0.5 };
}

// 하위호환 별칭(구 로컬 이름). 신규 호출자는 tofuRise 를 쓴다.
const fallOffset = tofuRise;

// ── 부재 순서(ORDER) — 기하에서 유도하는 결정론 정렬 ────────────────────────────────────
// 규칙 하나로 세 가지 고증 순서를 동시에 만족한다:
//   ① 아래 켜부터 위 켜로  — 기단 장대석 켜(지대석→몸통→갑석), 횡부재 켜(기둥→중인방→창방),
//      지붕 기와(처마→용마루). 실제 시공은 늘 아래에서 위로 쌓인다.
//   ② 같은 켜 안에서는 긴 축을 따라 한 방향 훑기 — 칸(bay) 단위로 골조를 세워 나가는 순서.
//      앞·뒤 기둥은 같은 x(=같은 칸)라 한 랭크로 묶여 짝으로 선다.
// 좌표는 그룹 로컬(원 rest 포즈)에서 읽고 rng 를 쓰지 않으므로 worker/sync 해시에 영향 없다.
const QY = 0.12;     // 켜 양자화(m) — 장대석 한 켜·기와 한 켜 규모
const QS = 0.9;      // 훑기 양자화(m) — 칸(≈2.5m)은 나누고 앞뒤 짝은 묶는 폭

// 자식 서브트리의 로컬 중심(회전·스케일은 이 트리에서 항등이라 무시). THREE import 없이 순수 계산.
function accumCenter(obj, ox, oy, oz, acc) {
  const px = ox + (obj.position?.x ?? 0);
  const py = oy + (obj.position?.y ?? 0);
  const pz = oz + (obj.position?.z ?? 0);
  const geo = obj.geometry;
  if (geo) {
    if (!geo.boundingSphere) { try { geo.computeBoundingSphere(); } catch { /* 비정상 지오는 건너뜀 */ } }
    const c = geo.boundingSphere?.center;
    if (c) { acc.x += px + c.x; acc.y += py + c.y; acc.z += pz + c.z; acc.n++; }
  }
  const kids = obj.children;
  if (kids) for (const k of kids) accumCenter(k, px, py, pz, acc);
}
function localCenter(obj) {
  const acc = { x: 0, y: 0, z: 0, n: 0 };
  accumCenter(obj, 0, 0, 0, acc);
  if (!acc.n) return { x: obj.position?.x ?? 0, y: obj.position?.y ?? 0, z: obj.position?.z ?? 0 };
  return { x: acc.x / acc.n, y: acc.y / acc.n, z: acc.z / acc.n };
}
// 결정론 미세 지터용 정수 해시(FNV-1a + 확산). rng 미사용 → 시드 스트림 불침해.
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// 정렬 후 (켜, 훑기) 동일 좌표를 한 랭크로 묶어 rank 인덱스를 부여한다.
function rankOrdered(entries, sweepAxis) {
  for (const e of entries) {
    e.cy = Math.round(e.center.y / QY);
    e.cs = Math.round((sweepAxis === 'x' ? e.center.x : e.center.z) / QS);
  }
  entries.sort((a, b) => a.cy - b.cy || a.cs - b.cs || a.first - b.first);
  let rank = -1, py = null, ps = null;
  for (const e of entries) {
    if (e.cy !== py || e.cs !== ps) { rank++; py = e.cy; ps = e.cs; }
    e.rank = rank;
  }
  return rank + 1;   // 랭크 개수
}
// 긴 축 판정(같은 켜 안 훑기 방향).
function sweepAxisOf(entries) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const e of entries) {
    if (e.center.x < minX) minX = e.center.x; if (e.center.x > maxX) maxX = e.center.x;
    if (e.center.z < minZ) minZ = e.center.z; if (e.center.z > maxZ) maxZ = e.center.z;
  }
  return (maxX - minX) >= (maxZ - minZ) ? 'x' : 'z';
}

// 이웃 부재 간 최소 시간차(초). 60fps 에서 4~5 프레임 — "아주 약간의 시간차"이면서 눈에 보이는 하한.
//   종전은 이 하한이 없어 (창폭*0.4)/(부재수-1) 이 ~26ms(1.5 프레임)로 떨어져 리플이 비가시였다.
const MIN_RIPPLE_SEC = 0.075;
const SPREAD_SHARE = 0.45;   // 파트 창에서 유닛 스태거에 쓰는 비율(나머지는 유닛 애니 길이)
const JITTER_SHARE = 0.28;   // 이웃 간격 대비 결정론 지터 폭(±) — 메트로놈처럼 안 들리게
const INTRA_SHARE = 0.30;    // 청크 내부(처마→용마루) 켜 흐름이 쓰는 유닛 애니 길이 비율

export function playAssembly(building, { duration = 5, onDone, amp = 1 } = {}) {
  const L = building.userData?.layout;
  const totalH = L?.totalH ?? 12;
  // 낙하 기준 거리: 건물 높이에 비례하되 절제된 범위로 클램프.
  const dropBase = Math.min(2.2, Math.max(1.2, totalH * 0.13));

  // 애니메이션 대상 수집: 각 파트 그룹을 조립 유닛 목록으로 분해.
  //   - 지붕(name==='roof'): 그룹 자체 1유닛 강체 모션 + 자식 visible 청크/켜 스태거.
  //   - 일반 그룹: (켜, 칸) 랭크 하나 = 유닛 하나 — 같은 칸의 앞뒤 기둥처럼 한 랭크에 든 부재는
  //     동시에 서고, 랭크 간에 리플 스태거가 걸린다(순서는 ORDER 규칙, 배열 인덱스 아님).
  const groups = [];
  for (const name of PART_ORDER) {
    const grp = building.getObjectByName(name);
    if (!grp || grp.children.length === 0) continue;
    const [ws, we] = PART_WINDOWS[name];
    const drop = dropBase * (PART_DROP[name] ?? 1);
    const tofu = (PART_TOFU[name] ?? 0.16) * amp;
    const rigid = name === 'roof';

    const mkItem = (child, i) => ({
      child,
      first: i,
      center: localCenter(child),
      lag: 0,
      y0: child.position.y,
      sx0: child.scale.x, sy0: child.scale.y, sz0: child.scale.z,
      vis0: child.visible,
    });
    const entries = grp.children.map(mkItem);
    const axis = sweepAxisOf(entries);

    let units, nR, visUnits = null;
    if (rigid) {
      // Roof moves as one rigid body (group transform). Child-local Y/scale stay at rest
      // so outer tile / underside / rafters keep their authored depth stack.
      units = [{
        rank: 0,
        first: 0,
        items: [mkItem(grp, 0)],
      }];
      nR = 1;
      // Visibility-only stagger: semantic chunks (rafters→body→finial) + course flow.
      if (grp.userData?.asmChunked) {
        const byKey = new Map();
        entries.forEach((it) => {
          const key = it.child.userData?.asmGroup || DEFAULT_CHUNK;
          let c = byKey.get(key);
          if (!c) {
            c = {
              key,
              seq: ROOF_SEQ[key] ?? ROOF_SEQ[DEFAULT_CHUNK],
              first: it.first,
              items: [],
            };
            byKey.set(key, c);
          }
          c.items.push(it);
        });
        visUnits = [...byKey.values()].sort((a, b) => a.seq - b.seq || a.first - b.first);
        for (const u of visUnits) {
          const nI = rankOrdered(u.items, axis);
          for (const it of u.items) it.lag = nI > 1 ? it.rank / (nI - 1) : 0;
          // Under-eave critical pieces must not course-lag independently:
          // eave→ridge lag on gaepan alone opens sky holes, and rafter lag
          // scrapes plate/창방 while the rigid roof is still rising.
          // Ornaments (마루·잡상·수키와) keep the eave→ridge flow.
          for (const it of u.items) {
            if (isUnderEaveCritical(it.child)) it.lag = 0;
          }
          u.first = u.items[0].first;
        }
        visUnits.forEach((u, i) => { u.rank = i; });
      } else {
        visUnits = [{ rank: 0, first: 0, items: entries, lag: 0 }];
        for (const it of entries) it.lag = 0;
      }
    } else {
      // 일반 그룹: 켜·칸 랭크 하나 = 유닛 하나. 같은 랭크 부재(앞뒤 기둥 짝 등)는 동시에 선다.
      nR = rankOrdered(entries, axis);
      const byRank = new Map();
      for (const it of entries) {
        let u = byRank.get(it.rank);
        if (!u) { u = { rank: it.rank, first: it.first, items: [] }; byRank.set(it.rank, u); }
        u.items.push(it);
      }
      units = [...byRank.values()].sort((a, b) => a.rank - b.rank);
    }

    // ── 리플 타이밍 ──
    //   기본 이웃 간격 = 창폭*SPREAD_SHARE/(랭크-1), 유닛 애니 길이 = 창폭 − 총 스프레드
    //   (→ 마지막 부재가 정확히 `we` 에 정착하므로 파트 순서가 다음 파트로 새지 않는다).
    //   그 간격이 지각 하한(MIN_RIPPLE_SEC)보다 좁으면 — 부재가 아주 많은 경우(마을 giwa 기둥 34본
    //   → 24 랭크) — **창을 넓히지 않고 랭크를 슬롯으로 병합**한다. 인접 칸이 두세 개씩 함께 서지만
    //   이웃 간격은 눈에 보이고, 기단→기둥→벽→지붕 순서의 가독성은 그대로다.
    //   지붕 강체: 모션 유닛은 1개. visible 청크 스태거는 별도 visUnits 창에서 깐다.
    const winDur = we - ws;
    const minItem = winDur * 0.35;
    const maxSpread = winDur - minItem;
    const minOffset = duration > 0 ? MIN_RIPPLE_SEC / duration : 0;
    let slots = nR;
    let offset = nR > 1 ? (winDur * SPREAD_SHARE) / (nR - 1) : 0;
    if (nR > 1 && offset < minOffset) {
      const maxSlots = Math.max(2, 1 + Math.floor(maxSpread / Math.max(minOffset, 1e-9)));
      slots = Math.min(nR, maxSlots);
      offset = slots > 1 ? Math.min(minOffset, maxSpread / (slots - 1)) : 0;
    }
    let itemDur = Math.max(minItem, winDur - offset * (slots - 1));
    if (ws + offset * (slots - 1) + itemDur > 1) {       // t=1 안전(원상복구 계약)
      itemDur = Math.max(winDur * 0.3, 1 - (ws + offset * (slots - 1)));
      if (slots > 1 && ws + offset * (slots - 1) + itemDur > 1) {
        offset = Math.max(0, (1 - ws - itemDur) / (slots - 1));
      }
    }
    for (const u of units) {
      u.slot = (nR > 1 && slots < nR) ? Math.round((u.rank * (slots - 1)) / (nR - 1)) : u.rank;
      const j = offset > 0 ? (hash01(`${name}:${u.slot}`) * 2 - 1) * JITTER_SHARE * offset : 0;
      u.start = Math.max(0, ws + u.slot * offset + j);
    }

    // Roof visibility stagger: spread chunk reveals across the same part window.
    let visItemDur = itemDur;
    let visOffset = 0;
    let visSlots = 1;
    let visHasLag = false;
    if (rigid && visUnits) {
      const vN = visUnits.length;
      visSlots = vN;
      visOffset = vN > 1 ? (winDur * SPREAD_SHARE) / (vN - 1) : 0;
      if (vN > 1 && visOffset < minOffset) {
        const maxSlots = Math.max(2, 1 + Math.floor(maxSpread / Math.max(minOffset, 1e-9)));
        visSlots = Math.min(vN, maxSlots);
        visOffset = visSlots > 1 ? Math.min(minOffset, maxSpread / (visSlots - 1)) : 0;
      }
      visItemDur = Math.max(minItem, winDur - visOffset * (visSlots - 1));
      if (ws + visOffset * (visSlots - 1) + visItemDur > 1) {
        visItemDur = Math.max(winDur * 0.3, 1 - (ws + visOffset * (visSlots - 1)));
        if (visSlots > 1 && ws + visOffset * (visSlots - 1) + visItemDur > 1) {
          visOffset = Math.max(0, (1 - ws - visItemDur) / (visSlots - 1));
        }
      }
      for (const u of visUnits) {
        u.slot = (vN > 1 && visSlots < vN)
          ? Math.round((u.rank * (visSlots - 1)) / (vN - 1))
          : u.rank;
        const j = visOffset > 0
          ? (hash01(`${name}:vis:${u.slot}`) * 2 - 1) * JITTER_SHARE * visOffset
          : 0;
        u.start = Math.max(0, ws + u.slot * visOffset + j);
      }
      visHasLag = visUnits.some((u) => u.items.some((it) => it.lag > 0));
    }

    const hasLag = rigid
      ? visHasLag
      : units.some((u) => u.items.some((it) => it.lag > 0));
    groups.push({
      name, ws, we, drop, tofu, units, itemDur, offset, hasLag,
      slots: rigid ? visSlots : slots,
      rigid,
      visUnits,
      visItemDur,
      visOffset,
      rawVisRanks: visUnits ? visUnits.length : units.length,
    });
  }

  let elapsed = 0;
  let done = false;

  // 한 부재에 진행도 uu 를 적용(공중 낙하 → 두부 출렁 복원). 원 transform 기준 상대.
  // allowScale=false: 지붕 강체는 스케일 항등(비등방 스쿼시가 깊이 스택을 찌그러뜨림).
  // setVisible=false: 강체 지붕 그룹은 항상 보이되, 자식 visible 은 별도 스태거가 소유.
  function applyItem(it, uu, drop, tofu, allowScale = true, setVisible = true) {
    if (uu <= 0) {
      // 아직 순서 전 → 숨김(공중에 어색하게 떠 있지 않게).
      if (setVisible) it.child.visible = false;
      it.child.position.y = it.y0 - drop;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
    } else if (uu >= 1) {
      if (setVisible) it.child.visible = it.vis0;
      it.child.position.y = it.y0;
      it.child.scale.set(it.sx0, it.sy0, it.sz0);
    } else {
      if (setVisible) it.child.visible = it.vis0;
      it.child.position.y = it.y0 - fallOffset(uu) * drop + tofuBob(uu, tofu) * drop;
      if (allowScale) {
        const s = tofuScale(uu, tofu);
        it.child.scale.set(it.sx0 * s.sxz, it.sy0 * s.sy, it.sz0 * s.sxz);
      } else {
        it.child.scale.set(it.sx0, it.sy0, it.sz0);
      }
    }
  }

  // 진행도 t(0..1) 상태를 계산·적용. 유닛 간은 리플 스태거(u.start), 유닛 내부는 켜 흐름(it.lag).
  function applyAt(t) {
    for (const g of groups) {
      if (g.rigid) {
        // One shared rise/bob on the roof group; children keep rest local transforms.
        const u0 = g.units[0];
        const uu = clamp01((t - u0.start) / g.itemDur);
        applyItem(u0.items[0], uu, g.drop, g.tofu, /*allowScale*/ false, /*setVisible*/ false);
        u0.items[0].child.visible = true;
        // The roof rises from below the plate/창방. ANY roof child that appears
        // mid-rise scrapes the column band or coplanar shell halves and reads as
        // ceiling sparkle (product frames at t≈0.90 showed body 수키와/마루 alone
        // as white z-fight dots while shell was still gated). Hold the whole roof
        // dark until settle is mostly damped, then re-base eave→ridge course flow
        // in the remaining post-reveal window of the rigid roof motion (uu space).
        const shellLanded = uu >= SHELL_REVEAL_UU;
        const postSpan = Math.max(1e-9, 1 - SHELL_REVEAL_UU);
        const postUu = shellLanded ? (uu - SHELL_REVEAL_UU) / postSpan : 0;
        // Child reveal only (no per-child Y/scale).
        const postIntra = g.hasLag ? INTRA_SHARE : 0;
        const postBody = Math.max(1e-9, 1 - postIntra);
        for (const u of g.visUnits) {
          for (const it of u.items) {
            let show = false;
            if (uu >= 1) {
              show = true; // rest pose — every member on
            } else if (shellLanded) {
              if (isUnderEaveCritical(it.child)) {
                // Shell + rafters land together (lag forced 0 above).
                show = true;
              } else {
                // Ornaments cascade eave→ridge across the post-reveal window.
                const local = (postUu - it.lag * postIntra) / postBody;
                show = local > 0;
              }
            }
            it.child.visible = show ? it.vis0 : false;
            it.child.position.y = it.y0;
            it.child.scale.set(it.sx0, it.sy0, it.sz0);
          }
        }
        // Tile outer + gaepan are one physical shell. Course-flow lag by height can
        // desync them for a few frames and flash coplanar depth; lock visibility.
        lockRoofShellVisibility(u0.items[0].child);
        continue;
      }
      const intra = g.hasLag ? g.itemDur * INTRA_SHARE : 0;
      const body = g.itemDur - intra;   // 켜 흐름을 뺀 실제 부재 애니 길이
      for (const u of g.units) {
        for (const it of u.items) {
          const uu = clamp01((t - u.start - it.lag * intra) / body);
          applyItem(it, uu, g.drop, g.tofu, true, true);
        }
      }
    }
  }

  function restore() {
    for (const g of groups) {
      for (const u of g.units) for (const it of u.items) {
        it.child.position.y = it.y0;
        it.child.scale.set(it.sx0, it.sy0, it.sz0);
        it.child.visible = it.vis0;
      }
      if (g.visUnits) {
        for (const u of g.visUnits) for (const it of u.items) {
          it.child.position.y = it.y0;
          it.child.scale.set(it.sx0, it.sy0, it.sz0);
          it.child.visible = it.vis0;
        }
      }
    }
  }

  // 시작 상태(빈 터) 즉시 적용 — 첫 프레임부터 조립 전 상태.
  applyAt(0);

  return {
    update(dt) {
      if (done) return true;
      elapsed += dt;
      const t = elapsed / duration;
      if (t >= 1) { restore(); done = true; onDone?.(); return true; }
      applyAt(t);
      return false;
    },
    // 정지 프레임(스크린샷/검증용) — 진행도 t 를 그대로 적용, 자동 진행 안 함.
    seek(t01) { applyAt(clamp01(t01)); },
    skip() {
      if (done) return;
      restore();
      done = true;
      onDone?.();
    },
    isDone() { return done; },
    // 검증용 타이밍 계획(초 단위). 리플 이웃 간격·랭크 수·켜 흐름을 게이트가 수치로 단언한다.
    plan() {
      return groups.map((g) => {
        const motionUnits = g.units;
        const reveal = g.visUnits || g.units;
        const off = g.rigid ? g.visOffset : g.offset;
        const iDur = g.rigid ? g.visItemDur : g.itemDur;
        return {
          part: g.name,
          window: [g.ws, g.we],
          ranks: g.slots,                     // 실제 리플/등장 단계 수(랭크 병합 후)
          rawRanks: g.rigid ? g.rawVisRanks : motionUnits.length,
          members: g.rigid
            ? reveal.reduce((n, u) => n + u.items.length, 0)
            : motionUnits.reduce((n, u) => n + u.items.length, 0),
          rippleSec: +(off * duration).toFixed(4),
          itemSec: +(iDur * duration).toFixed(4),
          endSec: +((g.ws + off * (g.slots - 1) + iDur) * duration).toFixed(4),
          courseFlow: g.hasLag,
          rigid: !!g.rigid,
          starts: [...new Set(reveal.map((u) => +(u.start * duration).toFixed(4)))].sort((a, b) => a - b),
        };
      });
    },
  };
}

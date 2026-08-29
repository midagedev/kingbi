// 소동물(하늘 무리·개·고양이) 순수 계획 — THREE·DOM 없음, 전역 RNG 없음, 반환은 JSON-safe.
//   critters.js(렌더러)와 tools/check-critter-contract.mjs(계약 게이트)가 이 모듈 하나를 공유한다.
//
// 세 축을 소유한다.
//   1) 하늘 무리의 계절별 종 정책 + 기러기 V자 편대(skein) 기하·적분기.
//   2) 규모·필지수 기반 지상 개체수(개·고양이·까치).
//   3) 필지 실측 앵커(대문·앞담 상단·마당)에서 파생하는 개의 순찰 구간과 고양이 페르치·자세표.
//
// 고증 근거는 docs/architectural-authenticity.md "소동물(개·고양이·기러기)" 절에 남긴다.
// 요약: 기러기는 한국의 겨울철새(가을 도래·봄 북상)이고 V자 편대로 이동한다 → 가을·겨울 하늘만
// 편대가 뜨고, 사철 텃새(까치 등) 무리는 봄·여름 하늘을 맡는다.

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const shortAngle = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;

// ============================================================================
// 1) 하늘 무리 — 계절 종 정책
// ============================================================================

// 두 종만 둔다. 편대(goose)는 실루엣이 크고 느린 날갯짓, 텃새 무리(resident)는 작고 빠른 먹점.
// 크기는 실측 기준: 기러기 날개폭 1.4~1.7m(프로토 지오메트리 폭 1.16 × scale), 텃새는 그보다 작다.
export const SKY_FLOCK_SPECIES = Object.freeze({
  goose: Object.freeze({
    id: 'goose', formation: true,
    countLo: 9, countHi: 15,
    sizeLo: 1.20, sizeHi: 1.46,
    flapRate: 6.4, flapBase: 0.45, flapDepth: 0.85,
    speed: 12.5,
    // 고도는 텃새 무리와 같은 밴드를 쓴다. 실측(2026-07-26 부감 A/B)에서 편대를 1.35배 높이면
    // 프레임에서 위로 올라가 하늘이 아니라 능선 수관 띠와 겹쳐 오히려 판독이 나빠졌다 —
    // 부감 카메라는 아래를 보므로 하늘 밴드는 지형 실루엣 위에만 있다. 편대의 정면 무대는
    // 능선을 가로질러 보는 히어로/낮은 시선 프레이밍이다.
    altitudeK: 1,
  }),
  resident: Object.freeze({
    id: 'resident', formation: false,
    countLo: 12, countHi: 16,
    sizeLo: 0.60, sizeHi: 1.05,
    flapRate: 11, flapBase: 0.35, flapDepth: 0.95,
    speed: 8,
  }),
});

// 기러기는 겨울철새다 — 가을에 도래해 겨울을 보내고 봄에 북상한다. 그 계절에만 편대가 뜬다.
export const SKY_FLOCK_SEASON = Object.freeze({
  spring: 'resident',
  summer: 'resident',
  autumn: 'goose',
  winter: 'goose',
});

export function skyFlockSpeciesFor(season) {
  return SKY_FLOCK_SEASON[season] || 'resident';
}

// ============================================================================
// 1b) V자 편대(skein) 기하
// ============================================================================

export const SKEIN = Object.freeze({
  // 같은 팔(arm) 안에서 앞 개체와의 간격. 실제 편대는 날개폭의 1~2배로 붙어 난다.
  spacing: 3.6,
  spacingJitter: 0.18,      // ±비율. 자(尺)로 그린 V가 되지 않게.
  crossJitter: 0.24,        // m. 횡방향 개체 편차(편대는 흔들린다). 누적되지 않는다.
  riseStep: -0.16,          // 뒤 개체가 조금 낮게 — 앞 개체 날개끝 상승기류 밖.
  // V의 반각(진행축 기준). 실측 편대는 20~40°이고 천천히 여닫힌다.
  halfAngleBase: 0.62,
  halfAngleSwing: 0.09,
  halfAnglePeriod: 41,
  // 어떤 추종 개체도 바로 앞 개체의 뒤(정후방)에 서지 않는다 — echelon 의 정의.
  minCrossOffset: 1.1,
  // 선회는 무리 전체가 한 몸으로 기운다.
  bankGain: 2.6,
  maxBank: 0.42,
  maxTurnRate: 0.55,        // rad/s — 선회 반경 ≈ speed/maxTurnRate ≈ 23m
  turnEase: 0.7,
  // 선두 교대(실제 편대도 선두를 돌린다).
  leadRotateMean: 26,
  leadRotateLo: 13,
  leadRotateHi: 52,
  // 개체가 자기 슬롯으로 수렴하는 시간상수(초). 선회 중 자연스러운 지연을 남긴다.
  formLerp: 1.5,
});

/** 천천히 여닫히는 V 반각. */
export function skeinHalfAngle(t, policy = SKEIN) {
  return policy.halfAngleBase
    + policy.halfAngleSwing * Math.sin(TAU * t / policy.halfAnglePeriod);
}

/**
 * 편대 슬롯(편대 로컬: +along = 진행방향, +cross = 진행방향 오른쪽).
 * 0번은 선두(원점). 이후는 두 팔에 번갈아 배정되고, 각 개체는 "같은 팔의 앞 개체"보다
 * 뒤·옆에 앉는다(echelon). jitter 는 [0,1) 값 배열(결정론 입력)이며 없으면 정연한 V.
 */
export function skeinSlots(count, { halfAngle = SKEIN.halfAngleBase, spacing = SKEIN.spacing, jitter = null, policy = SKEIN } = {}) {
  const n = Math.max(1, count | 0);
  const slots = [{ arm: 0, rank: 0, along: 0, cross: 0, rise: 0 }];
  const rank = [0, 0];
  // 팔마다 누적 좌표를 들고 간다. 개체 지터를 계급에 곱하면(누적) 뒤 개체가 앞 개체를
  // 추월하거나 간격이 붕괴한다 — 지터는 "한 칸 간격"에만 걸고 누적은 실제 합으로 만든다.
  const accum = [{ along: 0, cross: 0 }, { along: 0, cross: 0 }];
  for (let i = 1; i < n; i++) {
    const armIndex = (i - 1) % 2;             // 0 = 왼팔(-cross), 1 = 오른팔(+cross)
    const arm = armIndex === 0 ? -1 : 1;
    rank[armIndex] += 1;
    const k = rank[armIndex];
    const j0 = jitter ? jitter[(i * 2) % jitter.length] : 0.5;
    const j1 = jitter ? jitter[(i * 2 + 1) % jitter.length] : 0.5;
    const step = spacing * (1 + (j0 * 2 - 1) * policy.spacingJitter);
    const cell = accum[armIndex];
    cell.along -= step * Math.cos(halfAngle);
    cell.cross += step * Math.sin(halfAngle);
    // 누적되지 않는 개체 편차(편대는 흔들린다). 한 칸 간격보다 항상 작다.
    let cross = arm * cell.cross + (j1 * 2 - 1) * policy.crossJitter;
    // 정후방 금지: 횡방향 최소 이격을 팔 방향으로 보장한다.
    if (Math.abs(cross) < policy.minCrossOffset) cross = arm * policy.minCrossOffset;
    if (Math.sign(cross) !== arm) cross = arm * Math.abs(cross);
    slots.push({
      arm, rank: k, along: cell.along, cross,
      rise: k * policy.riseStep,
    });
  }
  return slots;
}

/**
 * 편대 상태(순수). rng 는 makeRng 계열의 () => [0,1) 함수.
 *   center/altitude/radius: 마을 중심·순항 고도·마을 반경. 편대는 마을 상공을 길게 가로지른다.
 */
export function createSkein({
  count = 12, rng = Math.random, center = { x: 0, z: 0 },
  altitude = 40, radius = 120, policy = SKEIN,
} = {}) {
  const n = Math.max(1, count | 0);
  const jitter = [];
  for (let i = 0; i < n * 2 + 2; i++) jitter.push(rng());
  const heading = rng() * TAU;
  // 편대는 "마을 상공을 계속 가로지르는" 것이라야 기본 부감 프레이밍에 늘 들어온다. 반경을
  // 분지보다 크게 잡으면(종전 원정 반경 radius*1.7+70) 편대가 프레임 밖에서 대부분의 시간을
  // 보내고, 사용자에게는 "새가 없다"로 보인다. 그래서 통과 반경을 분지 안쪽으로 묶는다.
  const outR = radius * 0.45 + 16;
  const entry = outR * 0.9;
  const state = {
    policy, count: n, jitter,
    cx: center.x, cz: center.z, alt: altitude, radius, outR,
    // 선두는 화면 바깥에서 들어와 마을 상공을 가로지른다.
    lx: center.x - Math.cos(heading) * entry,
    ly: altitude,
    lz: center.z - Math.sin(heading) * entry,
    heading, turn: 0, bank: 0, pitch: 0,
    speed: SKY_FLOCK_SPECIES.goose.speed,
    t: 0, halfAngle: policy.halfAngleBase,
    // 선두 교대: order[birdIndex] = slotIndex. 순환 이동만 하므로 항상 순열이다.
    order: Array.from({ length: n }, (_, i) => i),
    tRotate: policy.leadRotateLo + rng() * (policy.leadRotateMean - policy.leadRotateLo),
    rotations: 0,
    crossings: 0,
    outside: false,
    // 가로지르기 목표 오프셋(중심을 매번 정확히 통과하지 않게). 통과 반경 안으로 제한한다.
    aim: jitter.map((v) => (v * 2 - 1) * Math.min(radius * 0.45, outR * 0.5)),
    aimIndex: 0,
    slots: null,
  };
  state.slots = skeinSlots(n, { halfAngle: state.halfAngle, jitter, policy });
  return state;
}

/** 편대 한 스텝. 선두 경로(느린 선회 + 마을 재통과) + 뱅크 + 선두 교대 + 슬롯 재계산. */
export function stepSkein(state, dt, rng = Math.random) {
  const P = state.policy;
  state.t += dt;
  const dx = state.lx - state.cx, dz = state.lz - state.cz;
  const dist = Math.hypot(dx, dz);
  let want = state.heading;
  if (dist > state.outR) {
    // 반대편으로 다시 가로지른다 — 화면을 길게 통과하는 경로. 목표점은 경계를 넘는 순간
    // 한 번만 고른다. 매 프레임 새로 고르면 want 가 진동해 편대가 선회를 끝내지 못하고
    // 그대로 프레임 밖으로 빠져나간다(실측: 반경 88m 마을에서 1,026m 이탈).
    if (!state.outside) {
      state.outside = true;
      state.aimIndex++;
      state.crossings++;
    }
    const aimX = state.cx + state.aim[state.aimIndex % state.aim.length];
    const aimZ = state.cz + state.aim[(state.aimIndex + 3) % state.aim.length];
    want = Math.atan2(aimZ - state.lz, aimX - state.lx);
  } else {
    state.outside = false;
    // 순항 중에는 아주 느린 사행(두 개의 느린 사인) — 직선 자국이 남지 않게.
    want = state.heading
      + 0.10 * Math.sin(state.t * 0.09 + state.jitter[0] * TAU)
      + 0.05 * Math.sin(state.t * 0.23 + state.jitter[1] * TAU);
  }
  const targetTurn = clamp(shortAngle(want - state.heading), -P.maxTurnRate, P.maxTurnRate);
  state.turn += (targetTurn - state.turn) * Math.min(1, dt / P.turnEase);
  state.heading = (state.heading + state.turn * dt) % TAU;
  // 무리 전체가 한 몸으로 선회 안쪽으로 기운다.
  state.bank = clamp(-state.turn * P.bankGain, -P.maxBank, P.maxBank);
  state.pitch = clamp((state.alt - state.ly) * 0.02, -0.12, 0.12);
  state.ly += (state.alt - state.ly) * Math.min(1, dt * 0.25);
  state.lx += Math.cos(state.heading) * state.speed * dt;
  state.lz += Math.sin(state.heading) * state.speed * dt;
  state.halfAngle = skeinHalfAngle(state.t, P);
  state.slots = skeinSlots(state.count, {
    halfAngle: state.halfAngle, jitter: state.jitter, policy: P,
  });
  if (state.t >= state.tRotate) {
    // 선두 교대: 순환 이동 한 칸(선두는 자기 팔의 맨 뒤로 물러난다).
    state.order.push(state.order.shift());
    state.rotations++;
    const u = Math.max(1e-6, rng());
    state.tRotate = state.t + clamp(-P.leadRotateMean * Math.log(u), P.leadRotateLo, P.leadRotateHi);
  }
  return state;
}

/**
 * 개체별 목표 자세(월드). out 배열을 재사용해 프레임 할당을 만들지 않는다.
 * yaw 는 three 의 Y 회전 규약(모델 로컬 +X 가 정면) — 렌더러는 그대로 쓴다.
 */
export function skeinTargets(state, out = []) {
  const cos = Math.cos(state.heading), sin = Math.sin(state.heading);
  for (let i = 0; i < state.count; i++) {
    const slot = state.slots[state.order[i]] || state.slots[0];
    const target = out[i] || (out[i] = { x: 0, y: 0, z: 0, yaw: 0, roll: 0, pitch: 0, rank: 0, arm: 0 });
    target.x = state.lx + slot.along * cos - slot.cross * sin;
    target.z = state.lz + slot.along * sin + slot.cross * cos;
    target.y = state.ly + slot.rise;
    target.yaw = -state.heading;
    target.roll = state.bank;
    target.pitch = state.pitch;
    target.rank = slot.rank;
    target.arm = slot.arm;
  }
  out.length = state.count;
  return out;
}

// ============================================================================
// 2) 지상 개체수 — 규모가 아니라 "필지 밀도"가 1차 결정자다
// ============================================================================
//
// 종전 정책은 마을 전체에 개 2·고양이 2였다. 지상 소동물의 가시성은 공유 시선-셀 LOD
// (village/lod-policy.js spatial full 32m / hidden 72m)가 결정하므로, 개체수가 아니라
// "지금 보고 있는 필지 근처에 한 마리가 있는가"가 체감 존재감이다. village 33필지에서
// 개 2마리는 필지의 24%만 32m 안에 개를 갖는다는 뜻이었다. 밀도로 바꾸고 상한만 남긴다.
// 전부 인스턴싱이라 드로우콜은 개체수와 무관하다(종별 1콜).
// perParcel 은 필지 수 기준. 필지·siteR 확대 뒤 중심 간 거리가 32m full-detail
// 창보다 커질 수 있어 밀도를 소폭 올려 근접 커버리지를 유지한다.
export const GROUND_DENSITY = Object.freeze({
  dog: Object.freeze({ perParcel: 0.34, min: 1 }),
  cat: Object.freeze({ perParcel: 0.44, min: 1 }),
  magpie: Object.freeze({ perParcel: 0.24, min: 2 }),
});

export const GROUND_CAP = Object.freeze({
  hamlet: Object.freeze({ dog: 4, cat: 5, magpie: 3 }),
  village: Object.freeze({ dog: 12, cat: 15, magpie: 8 }),
  town: Object.freeze({ dog: 16, cat: 20, magpie: 12 }),
  capital: Object.freeze({ dog: 18, cat: 22, magpie: 14 }),
  hanyang: Object.freeze({ dog: 34, cat: 42, magpie: 24 }),
});

export function groundPopulation(scale, parcelCount) {
  const cap = GROUND_CAP[scale] || GROUND_CAP.village;
  const parcels = Math.max(0, parcelCount | 0);
  const out = {};
  for (const key of ['dog', 'cat', 'magpie']) {
    const density = GROUND_DENSITY[key];
    if (!parcels) { out[key] = 0; continue; }
    out[key] = Math.min(cap[key], Math.max(density.min, Math.round(parcels * density.perParcel)));
  }
  return out;
}

// ============================================================================
// 3) 개 — 대문 앞 고샅 순찰 구간
// ============================================================================
//
// 종전에는 필지 앞마당 앵커 주위 반경 6.5m 를 랜덤워크했다. 앵커가 앞담에서 2m 남짓 밖에
// 있으므로 그 원의 절반가량이 담 안쪽이었고, 개가 자기 집 담을 통과해 걸었다. 대문 앞
// 고샅(길)을 따라 담 밖으로만 뻗은 선분을 순찰 구간으로 준다 — 담 통과가 기하적으로 불가능하고,
// 길을 따라 걷는 횡방향 모션이 카메라에 가장 잘 읽힌다.
export const DOG_BEAT = Object.freeze({
  standoff: 1.5,        // 담(대문선)에서 밖으로 띄우는 거리(m)
  standoffJitter: 0.9,
  halfLength: 4.2,      // 순찰 선분 반길이(m)
  halfLengthJitter: 1.4,
  wobble: 0.55,         // 선분에 수직인 흔들림 폭(m)
  speedLo: 0.75,
  speedHi: 1.5,
  restLo: 3.5,
  restHi: 11,
  gateFaceChance: 0.45, // 쉴 때 대문을 향해 앉는 비율
  // 처마 아래로 들어가도 되는 깊이(m). 처마 내밀이보다 작아 몸채 벽면을 침범하지 않는다.
  eaveWalkIn: 0.5,
});

// ── 필지 로컬 기하 헬퍼(THREE 없음) ──
function insidePoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z)
      && x < (b.x - a.x) * (z - a.z) / ((b.z - a.z) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}
function edgeDistance(pts, x, z) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    const ex = b.x - a.x, ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1e-9;
    const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / len2, 0, 1);
    best = Math.min(best, Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t)));
  }
  return best;
}
function insideRect(rect, x, z, margin = 0) {
  if (!rect) return false;
  return Math.abs(x - rect.x) <= rect.hw + margin && Math.abs(z - rect.z) <= rect.hd + margin;
}
/** 필지 안 + 담에서 clearance 이상 + 집 발자국 밖인 점인가. */
export function stationPointOk(record, x, z, clearance = 0.6, houseMargin = 0.5) {
  const pts = record.pts;
  if (!pts || pts.length < 3) return true;
  if (!insidePoly(pts, x, z)) return false;
  if (edgeDistance(pts, x, z) < clearance) return false;
  if (insideRect(record.house, x, z, houseMargin)) return false;
  return true;
}

/**
 * 개 한 마리의 순찰 구간(필지 로컬). 대문 안쪽 접근로를 담과 나란히 왕복한다.
 *   record: { pts, gate:{x,z}, inward:{x,z}, tangent:{x,z}, edgeLen, house, wallThickness }
 * 담 통과가 기하적으로 불가능하도록 후보를 좁혀 가며 실제 다각형·집 발자국으로 검증한다.
 * 어떤 후보도 통과하지 못하면 half=0(제자리 대기)로 닫는다 — 억지로 밀어넣지 않는다.
 */
export function dogBeatFor(record, rng = Math.random, policy = DOG_BEAT) {
  const gate = record.gate || { x: 0, z: 0 };
  const inward = record.inward || { x: 0, z: -1 };
  const tangent = record.tangent || { x: 1, z: 0 };
  const edgeLen = record.edgeLen || 8;
  const clearance = (record.wallThickness || 0.5) * 0.5 + 0.45;
  // house 는 처마(지붕) 경계다. 개는 처마 아래 그늘까지 걸어도 되고 몸채 벽만 피하면 된다 →
  // 처마 사각형을 처마 내밀이만큼 줄여 벽면 근사로 쓴다(마당 소품·정지 앵커와 다른 여유).
  const houseMargin = -policy.eaveWalkIn;
  const standoff0 = policy.standoff + rng() * policy.standoffJitter;
  const halfWish = Math.min(
    policy.halfLength + rng() * policy.halfLengthJitter,
    Math.max(0.8, edgeLen * 0.42),
  );
  const jitter = rng();
  const sample = (ox, oz, dx, dz, half) => {
    // 0.3m 간격 이상으로 촘촘히 훑는다. 필지는 부정형 사각형이라 끝점만 보면 오목한 변
    // 사이로 구간이 삐져나갈 수 있다.
    const steps = Math.max(4, Math.min(48, Math.ceil(half * 2 / 0.3)));
    for (let i = 0; i <= steps; i++) {
      const u = half === 0 ? 0 : (i / steps) * 2 - 1;
      const px = ox + dx * half * u, pz = oz + dz * half * u;
      if (!stationPointOk(record, px, pz, clearance, houseMargin)) return null;
    }
    return {
      ax: ox - dx * half, az: oz - dz * half,
      bx: ox + dx * half, bz: oz + dz * half,
      gateX: gate.x, gateZ: gate.z,
      inX: inward.x, inZ: inward.z,
      standoff: Math.hypot(ox - gate.x, oz - gate.z), half,
    };
  };
  // 대문 안쪽 접근로에서 방향·길이 후보를 훑어 "가장 긴 합법 구간"을 고른다. 담과 나란한 순찰이
  // 1지망이고(길·대문이 배경이라 모션이 잘 읽힌다), 좁은 필지에서는 접근로 축이 더 길다.
  const axes = [
    { x: tangent.x, z: tangent.z },
    { x: inward.x, z: inward.z },
    { x: (tangent.x + inward.x) * 0.7071, z: (tangent.z + inward.z) * 0.7071 },
    { x: (-tangent.x + inward.x) * 0.7071, z: (-tangent.z + inward.z) * 0.7071 },
  ];
  let best = null;
  for (const standoff of [standoff0, standoff0 * 1.5, standoff0 * 2.1, standoff0 * 2.8]) {
    const ox = gate.x + inward.x * standoff, oz = gate.z + inward.z * standoff;
    for (const axis of axes) {
      for (const half of [halfWish, halfWish * 0.72, halfWish * 0.5, halfWish * 0.3, 0]) {
        const beat = sample(ox, oz, axis.x, axis.z, half);
        if (!beat) continue;
        if (!best || beat.half > best.half + 1e-6) best = beat;
        break;                       // 이 축·오프셋의 최장 구간만 채택
      }
    }
    // 충분히 걷을 수 있으면 더 안쪽(마당 중앙)까지 밀지 않는다.
    if (best && best.half >= policy.halfLength * (0.55 + jitter * 0.3)) break;
  }
  // 어떤 자리도 담·집을 지키지 못하면 이 필지에는 개를 두지 않는다. 억지로 밀어넣지 않는다.
  return best;
}

// 개 털색(instanceColor 곱틴트) — 누렁이 일변도에서 벗어나 지면 대비를 만든다.
// 기본 정점색이 누렁이(0xc79a5b)이므로 곱으로 백구·검둥이·바둑이를 얻는다.
// 흰 개는 1을 넘는 곱을 쓴다(선형 공간에서 유효). 가중치는 실제 재래 진돗개 분포에 가깝게.
export const DOG_COATS = Object.freeze([
  Object.freeze({ id: 'nureongi', tint: [1.00, 1.00, 1.00], weight: 0.40 }),  // 누렁이
  Object.freeze({ id: 'baekgu', tint: [1.42, 1.48, 1.62], weight: 0.28 }),    // 백구
  Object.freeze({ id: 'geomdungi', tint: [0.34, 0.32, 0.34], weight: 0.20 }), // 검둥이
  Object.freeze({ id: 'chestnut', tint: [0.78, 0.62, 0.52], weight: 0.12 }),  // 짙은 밤색
]);

// 고양이 털색. 변상벽의 고양이는 갈색 얼룩(태비)이고, 검은 고양이·치즈·삼색도 흔하다.
// 기본 정점색이 짙은 회흑(0x303138)이라 밝은 털은 큰 곱이 필요하다.
export const CAT_COATS = Object.freeze([
  Object.freeze({ id: 'tabby', tint: [2.60, 1.95, 1.30], weight: 0.34 }),     // 갈색 얼룩
  Object.freeze({ id: 'black', tint: [0.80, 0.80, 0.86], weight: 0.22 }),     // 검은 고양이
  Object.freeze({ id: 'cheese', tint: [3.20, 2.10, 1.05], weight: 0.22 }),    // 치즈(주황 태비)
  Object.freeze({ id: 'grey', tint: [1.70, 1.72, 1.80], weight: 0.14 }),      // 회색
  Object.freeze({ id: 'calico', tint: [2.90, 2.50, 2.05], weight: 0.08 }),    // 삼색
]);

/** 가중 선택(결정론). 반환은 배열 인덱스. */
export function pickWeighted(list, roll) {
  let total = 0;
  for (const item of list) total += item.weight;
  let r = clamp(roll, 0, 1) * total;
  for (let i = 0; i < list.length; i++) {
    r -= list[i].weight;
    if (r <= 0) return i;
  }
  return list.length - 1;
}

// ============================================================================
// 4) 고양이 — 페르치와 자세표
// ============================================================================
//
// 실제 마을 고양이가 앉는 자리가 매력의 전부다: 담장 위, 대문 기둥, 햇볕 든 마당.
// 담장 상단은 하늘을 배경으로 실루엣이 서서 원경에서도 "고양이"로 읽히는 유일한 자리다.
// 지붕은 쓰지 않는다 — 필지 기록에는 정확한 지붕면 높이가 없고, 추정으로 얹으면 뜬다(까치는
// 종전대로 지붕 추정 페르치를 유지한다).
export const CAT_PERCH = Object.freeze({
  wallInset: 0.9,        // 대문 개구에서 담을 따라 비켜 앉는 최소 거리(m)
  wallSpread: 0.34,      // 담 길이 대비 좌우 배치 폭
  postDrop: 0.06,        // 대문 기둥 상단에서 내려앉는 보정(m)
  yardStandoff: 0.30,    // 마당 앵커 주변 배치 반경 비율
  hopUp: 0.55,           // 담으로 뛰어오를 때의 호 높이(m)
  hopDown: 0.22,         // 내려올 때는 낮게(중력)
});

// 자세: 전부 강체 변환으로 표현 가능한 스쿼시/스트레치 + 미세 회전. 진폭은 미세 스케일 원칙을
// 지키고(눈에 띄면 과하다), dash 만 의도된 간헐 이벤트다.
export const CAT_POSES = Object.freeze({
  sit: Object.freeze({ id: 'sit', squash: 1.0, stretch: 1.0, lift: 0, tail: 1.0, hold: [6, 16] }),
  loaf: Object.freeze({ id: 'loaf', squash: 0.86, stretch: 1.06, lift: -0.02, tail: 0.45, hold: [8, 22] }),
  groom: Object.freeze({ id: 'groom', squash: 0.94, stretch: 1.0, lift: 0, tail: 0.8, hold: [3, 7] }),
  stretch: Object.freeze({ id: 'stretch', squash: 0.80, stretch: 1.22, lift: 0, tail: 1.4, hold: [1.1, 2.0] }),
  alert: Object.freeze({ id: 'alert', squash: 1.05, stretch: 0.98, lift: 0.01, tail: 1.2, hold: [2, 5] }),
});
export const CAT_POSE_IDS = Object.freeze(['sit', 'loaf', 'groom', 'stretch', 'alert']);
// 정지 자세의 등장 비율. loaf(웅크림)와 sit 이 대부분이고 stretch 는 드문 비트다.
export const CAT_POSE_WEIGHTS = Object.freeze([0.30, 0.32, 0.20, 0.06, 0.12]);

export const CAT_MOVE = Object.freeze({
  walkSpeed: 1.1,        // m/s 사뿐 이동
  dashSpeed: 4.6,        // m/s 짧은 질주(의도된 비트)
  dashChance: 0.22,
  restLo: 9,
  restHi: 34,
});

/**
 * 고양이 한 마리의 페르치(필지 로컬). 높은 자리(담장 상단 또는 대문 기둥) + 마당 자리.
 * y 는 필지 baseY 기준 상대 높이 — 담 상단은 실제 담 높이 계약값이므로 뜨거나 잠기지 않는다.
 * 담이 없는 필지(개방·생울)는 대문 기둥 상단을 높은 자리로 쓴다.
 */
export function catPerchesFor(record, rng = Math.random, policy = CAT_PERCH) {
  const gate = record.gate || { x: 0, z: 0 };
  const inward = record.inward || { x: 0, z: -1 };
  const tangent = record.tangent || { x: 1, z: 0 };
  const edgeLen = record.edgeLen || 8;
  const halfGap = record.gateHalfGap || 1.1;
  const perches = [];
  // 대문에서 담을 따라 좌우로 남은 길이(대문 개구와 필지 모서리 여유를 뺀 실제 여유).
  const gateT = Number.isFinite(record.gateT) ? record.gateT : 0.5;
  const roomPlus = (1 - gateT) * edgeLen - halfGap - policy.wallInset - 0.35;
  const roomMinus = gateT * edgeLen - halfGap - policy.wallInset - 0.35;
  let side = rng() < 0.5 ? -1 : 1;
  if ((side > 0 ? roomPlus : roomMinus) <= 0) side = -side;   // 여유가 있는 쪽으로
  const room = side > 0 ? roomPlus : roomMinus;
  const offset = halfGap + policy.wallInset
    + rng() * Math.max(0, Math.min(room, edgeLen * policy.wallSpread));
  const facing = rng() < 0.5 ? 1 : -1;   // 길(밖) 또는 마당(안)
  if (room > 0 && Number.isFinite(record.wallTop) && record.wallTop > 0.6) {
    perches.push({
      kind: 'walltop',
      x: gate.x + tangent.x * side * offset, z: gate.z + tangent.z * side * offset,
      y: record.wallTop,
      dirX: inward.x * facing, dirZ: inward.z * facing,
    });
  } else if (room > 0 && Number.isFinite(record.gatePostTop) && record.gatePostTop > 0.6) {
    perches.push({
      kind: 'gatepost',
      x: gate.x + tangent.x * side * halfGap, z: gate.z + tangent.z * side * halfGap,
      y: record.gatePostTop - policy.postDrop,
      dirX: inward.x * facing, dirZ: inward.z * facing,
    });
  }
  // 마당 햇볕 자리 — 항상 하나는 확보한다. 필지 안·담 이격·집 발자국 밖을 검증한다.
  const yard = record.yard || { x: gate.x + inward.x * 2.4, z: gate.z + inward.z * 2.4 };
  const clearance = (record.wallThickness || 0.5) * 0.5 + 0.4;
  let placed = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const a = rng() * TAU, r = attempt < 6 ? 0.3 + rng() * 1.5 : 0;
    const x = yard.x + Math.cos(a) * r, z = yard.z + Math.sin(a) * r;
    if (stationPointOk(record, x, z, clearance, 0.5)) { placed = { x, z }; break; }
  }
  if (!placed && stationPointOk(record, yard.x, yard.z, clearance * 0.6, 0.3)) {
    placed = { x: yard.x, z: yard.z };
  }
  if (placed) {
    perches.push({
      kind: 'yard', x: placed.x, z: placed.z, y: 0,
      dirX: inward.x * -1, dirZ: inward.z * -1,   // 마당에서는 대문(길) 쪽을 본다
    });
  }
  // 검증된 자리가 없으면 이 필지에는 고양이를 두지 않는다(뜨거나 담을 뚫는 자리 금지).
  if (!perches.length) return null;
  return perches;
}

/** 자세 선택(결정론). roll ∈ [0,1). */
export function pickCatPose(roll) {
  let total = 0;
  for (const w of CAT_POSE_WEIGHTS) total += w;
  let r = clamp(roll, 0, 1) * total;
  for (let i = 0; i < CAT_POSE_IDS.length; i++) {
    r -= CAT_POSE_WEIGHTS[i];
    if (r <= 0) return CAT_POSES[CAT_POSE_IDS[i]];
  }
  return CAT_POSES.sit;
}

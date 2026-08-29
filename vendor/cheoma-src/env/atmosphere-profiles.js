// Renderer-independent atmosphere profiles. A "time" keeps the simulation contract
// (animals, lanterns, water, audio), while sunsetLook varies only the presentation.
// Keeping sky, lighting, haze, ridge and post values in one profile prevents a purple
// sky from retaining an unrelated orange rim or fog treatment.

export const DEFAULT_SUNSET_LOOK = 'gold';
export const SUNSET_LOOK_IDS = Object.freeze(['gold', 'crimson', 'violet']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const profile = (atmosphere, post) => deepFreeze({ atmosphere, post });

const DAWN = profile({
  sky: [[0.0, '#e7d0b8'], [0.35, '#d9c3bb'], [0.7, '#8f9bbf'], [1.0, '#5d6a97']],
  sunDir: [26, 9, 34], sunColor: 0xffd7ac, sunInt: 1.7,
  hemiSky: 0xc3bcd0, hemiGround: 0x6f6252, hemiInt: 0.75,
  fog: 0xe4cfbd, fogNear: 55, fogFar: 430, exposure: 1.02,
  ridgeNear: 0x4a5069, ridgeFar: 0xcfc1c4, mist: 0xf1e2d4, mistOp: 0.72,
  lantern: 0.0,
}, {
  bloomStrength: 0.55, bloomRadius: 0.55, bloomThreshold: 0.82,
  rim: 1.15, rimColor: 0xffd6bc, rimPower: 2.1, rimWrap: 0.14,
  sunGlow: 0.70, sunGlowSize: 70, sunGlowColor: 0xffdcb4, sat: 1.12,
  flare: 0.55, flareColor: 0xffd9b4,
});

const DAY = profile({
  sky: [[0.0, '#d3dfe8'], [0.4, '#a9c4de'], [0.75, '#7ba6d6'], [1.0, '#5f8fca']],
  sunDir: [30, 42, 26], sunColor: 0xfff3e0, sunInt: 2.6,
  hemiSky: 0xbcd4ec, hemiGround: 0x8a7a63, hemiInt: 0.9,
  fog: 0xcfdde8, fogNear: 95, fogFar: 500, exposure: 1.05,
  ridgeNear: 0x445f6d, ridgeFar: 0xbdd0dc, mist: 0xeef4f8, mistOp: 0.6,
  lantern: 0.0,
}, {
  bloomStrength: 0.42, bloomRadius: 0.5, bloomThreshold: 0.92,
  rim: 0.45, rimColor: 0xfff6ea, rimPower: 2.6, rimWrap: 0.12,
  sunGlow: 0.55, sunGlowSize: 46, sunGlowColor: 0xfff4e6, sat: 1.0,
  flare: 0.24, flareColor: 0xfff2e2,
});

// #150-H night depth legibility + #212 U2 night aerial moon-in-frame:
// form-model eaves/columns/walls with the *existing* moon (directional sun slot),
// hemisphere fill, fog layering, and post grade/rim. No new lights, material families,
// or emissive paths. Day/dawn/sunset are untouched.
// bloomThreshold stays 0.32 — moon-optics soft-knee is calibrated to that night floor.
// sunDir y is a low positive elevation so the product night aerial (15°) admits disc
// + corona in the upper sky band while light still arrives from above (raking moonlight).
const NIGHT = profile({
  // Slightly lifted mid-sky so the cool lunar band reads as haze rather than crushed navy.
  sky: [[0.0, '#2f3f60'], [0.4, '#1f2e4e'], [0.75, '#16233a'], [1.0, '#0d1424']],
  // Azimuth unchanged (north-ridge moon); elevation lowered for aerial framing (was y=5).
  sunDir: [-7, 3, -32], sunColor: 0xa8bce6, sunInt: 1.14,
  // Hemi fill lifts soffits and wall faces the moon never reaches without erasing direction.
  hemiSky: 0x3d4c6e, hemiGround: 0x1c2436, hemiInt: 0.44,
  // Near architecture stays readable; far fog still layers ridges for aerial depth.
  fog: 0x1e2c46, fogNear: 70, fogFar: 420, exposure: 1.24,
  ridgeNear: 0x26324e, ridgeFar: 0x4a5a78, mist: 0x5a6a92, mistOp: 0.55,
  lantern: 1.0, moon: true,
}, {
  bloomStrength: 0.72, bloomRadius: 0.62, bloomThreshold: 0.32,
  // Softer, wider moon rim so eave silhouettes and column edges separate from walls.
  rim: 0.58, rimColor: 0xb4c8ec, rimPower: 2.30, rimWrap: 0.17,
  sunGlow: 0.0, sunGlowSize: 0, sunGlowColor: 0xa8bce6, sat: 1.0,
  flare: 0.0, flareColor: 0xa8bce6,
});

export const SUNSET_LOOKS = deepFreeze({
  gold: {
    label: { ko: '금빛 노을', en: 'Golden sunset' },
    ...profile({
      // 기본 노을 = 훨씬 따뜻한 붉은 골든아워. 사용자 지시: "붉은 노을의 느낌을 좋아해".
      //
      // 채도 규율(docs/look-grammar.md §2-3)을 지키면서 붉게 가는 방법은 축을 나누는 것이다.
      //   과감하게 붉히는 축 = 하늘 스톱·태양색·림·태양 글로우·플레어(=하이라이트·발광·역광).
      //   중성에 가깝게 지키는 축 = hemiGround(지면 바운스)·hemiSky(천정 산란)·fog 계열.
      // Phase 1 에서 crimson 프로필이 실패한 이유가 후자였다: 장미빛 앰비언트·대기색이 아래에서
      //   올라와 회벽·그림자·미드톤까지 물들여 "붉은 노을"이 아니라 단일 장미색 워시가 됐다.
      //   그래서 여기서도 hemiGround 0x9c7856·hemiSky 0x8593bd 는 손대지 않는다 — 태양 반대편
      //   (그림자면)은 여전히 차갑고 중성이며, 그 결과 실제 붉은 노을 사진 특유의 높은 색온도
      //   대비(따뜻한 수광면 ↔ 중성 암부)가 생긴다. fog·ridgeFar·mist 는 하늘과 하이라이트가
      //   붉어진 만큼만 살짝 따라간다(원경 대기와 하늘 사이 색상 하드컷 방지, §3 하늘 항).
      // 하늘 스톱 규약: pos 0.5=지평. 0.55 스톱이 "능선 바로 위" 밴드로, 뒷산 완만화(site.js)로
      //   방금 열린 하늘 밴드가 정확히 여기다 → 진홍(0xc2495c)을 그 자리에 놓고, 천정은 남색
      //   (0x3c4a86)으로 남겨 진홍→자주→남색 그라디언트를 만든다. 천정까지 붉히면 하늘 전체가
      //   한 색이 되어 대비가 죽는다.
      // 실측 근거(A/B): 부감 프레임은 31° 하향 × 46° 렌즈라 상단 광선이 지평 아래 −8° 다. 즉 화면에
      //   보이는 하늘 밴드는 돔 pos≈0.44~0.50 구간이고, 그 구간은 DOME_HAZE(alpha 0.66~0.93)가
      //   대기색으로 수렴시킨다(sky.js — 지형 절단면 하드컷 방지 계약). 따라서 "부감에서 붉은 노을"은
      //   fog 계열이 담당하고 프로필 하늘 스톱은 아이레벨·히어로 화각에서 발현한다. fog 를 마젠타가
      //   아닌 주홍 쪽(hue≈20°)으로만 올려 원경 대기는 노을빛으로 물들이되, 마을 바닥 미드톤은
      //   불변으로 유지한다(town 부감 A/B 실측: 하늘 밴드 r−b 45→96·원경 능선 밴드 32→63 =
      //   노을은 대기가 받고, 마을 바닥은 r−b 30.5→31.8·luma 43.8→42.3 = 미드톤 워시 없음).
      sky: [[0.0, '#ff9d52'], [0.26, '#f26334'], [0.55, '#c2495c'], [1.0, '#3c4a86']],
      sunDir: [-16, 8, -45], sunColor: 0xff9448, sunInt: 2.38,
      hemiSky: 0x8593bd, hemiGround: 0x9c7856, hemiInt: 0.72,
      fog: 0xcc9376, fogNear: 70, fogFar: 470, exposure: 1.13,
      ridgeNear: 0x574863, ridgeFar: 0xcc9678, mist: 0xdeb69c, mistOp: 0.6,
      lantern: 0.15,
    }, {
      // rim 2.05 는 그대로 둔다 — tools/check-rim-facing.mjs 의 HDR 에너지 상한(2.05×1.85)이
      //   이 숫자를 기준으로 캘리브레이션돼 있고, 붉힘은 rimColor 로만 가져간다(휘도는 오히려 감소).
      bloomStrength: 0.66, bloomRadius: 0.38, bloomThreshold: 0.80,
      rim: 2.05, rimColor: 0xffa757, rimPower: 1.7, rimWrap: 0.13,
      sunGlow: 0.98, sunGlowSize: 42, sunGlowColor: 0xff8f45, sat: 1.20,
      flare: 1.0, flareColor: 0xffa155,
    }),
  },
  crimson: {
    label: { ko: '붉은 노을', en: 'Crimson sunset' },
    ...profile({
      // A clearer, aerosol-rich afterglow: hot peach at the horizon, red lower sky,
      // restrained plum above. Ambient light stays mauve so foliage does not turn brown.
      //
      // 채도 규율(docs/look-grammar.md §2-3): 붉은 노을의 정체성은 하늘·태양·플레어가 갖고,
      //   앰비언트와 대기색은 중성에 가까워야 한다. 이전 hemiGround 0x925f50 / fog 0xbd8d89 는
      //   장미빛 자체가 아래에서 올라와 회벽·그림자·미드톤까지 물들였고(A/B 실측: 같은 컷의
      //   gold 대비 프레임 평균 채도는 같은데 밝기 −16%, 흰 재질의 색조가 마젠타로 이동),
      //   결과가 "붉은 노을"이 아니라 단일 장미색 워시였다. 마젠타 성분만 덜어 흙빛으로 옮긴다
      //   — 하늘 스톱·태양색·플레어는 불변이므로 룩 정체성은 유지된다.
      sky: [[0.0, '#f6a266'], [0.26, '#d96862'], [0.57, '#8d587e'], [1.0, '#3d4d80']],
      sunDir: [-16, 8, -45], sunColor: 0xff9168, sunInt: 2.25,
      hemiSky: 0x8a90b6, hemiGround: 0x8e6a54, hemiInt: 0.70,
      fog: 0xc09a8b, fogNear: 70, fogFar: 462, exposure: 1.11,
      ridgeNear: 0x54465b, ridgeFar: 0xbc9184, mist: 0xd3b0a4, mistOp: 0.61,
      lantern: 0.15,
    }, {
      bloomStrength: 0.61, bloomRadius: 0.37, bloomThreshold: 0.80,
      rim: 1.98, rimColor: 0xffad7d, rimPower: 1.75, rimWrap: 0.13,
      sunGlow: 0.90, sunGlowSize: 39, sunGlowColor: 0xff9974, sat: 1.14,
      flare: 0.96, flareColor: 0xffad86,
    }),
  },
  violet: {
    label: { ko: '보랏빛 노을', en: 'Violet sunset' },
    ...profile({
      // Late civil twilight: a warm solar band remains at the horizon while scattered
      // blue light mixes with red afterglow into mauve and indigo higher in the dome.
      sky: [[0.0, '#e9aa82'], [0.27, '#c37c99'], [0.58, '#756a9c'], [1.0, '#354777']],
      sunDir: [-16, 8, -45], sunColor: 0xffbea0, sunInt: 2.14,
      hemiSky: 0x7d83b8, hemiGround: 0x806078, hemiInt: 0.72,
      fog: 0xa291a9, fogNear: 68, fogFar: 455, exposure: 1.12,
      ridgeNear: 0x4b4c68, ridgeFar: 0x978ca8, mist: 0xbdb1c0, mistOp: 0.62,
      lantern: 0.18,
    }, {
      bloomStrength: 0.60, bloomRadius: 0.39, bloomThreshold: 0.79,
      rim: 1.90, rimColor: 0xe9bec5, rimPower: 1.82, rimWrap: 0.13,
      sunGlow: 0.86, sunGlowSize: 38, sunGlowColor: 0xf2ad9f, sat: 1.20,
      flare: 0.88, flareColor: 0xe5b4c5,
    }),
  },
});

export const TIME_PROFILES = deepFreeze({ dawn: DAWN, day: DAY, night: NIGHT });

// Backward-compatible atmosphere-only view for consumers that only need the canonical
// direction or lighting values. `sunset` intentionally remains the flagship gold look.
export const TIME_PRESETS = deepFreeze({
  dawn: DAWN.atmosphere,
  day: DAY.atmosphere,
  sunset: SUNSET_LOOKS[DEFAULT_SUNSET_LOOK].atmosphere,
  night: NIGHT.atmosphere,
});

export function normalizeSunsetLook(value) {
  return SUNSET_LOOK_IDS.includes(value) ? value : DEFAULT_SUNSET_LOOK;
}

export function resolveAtmosphereProfile(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  if (time === 'sunset') return SUNSET_LOOKS[normalizeSunsetLook(sunsetLook)].atmosphere;
  return (TIME_PROFILES[time] || TIME_PROFILES.day).atmosphere;
}

export function resolvePostProfile(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  if (time === 'sunset') return SUNSET_LOOKS[normalizeSunsetLook(sunsetLook)].post;
  return (TIME_PROFILES[time] || TIME_PROFILES.day).post;
}

export function atmosphereProfileKey(time, sunsetLook = DEFAULT_SUNSET_LOOK) {
  return time === 'sunset' ? `sunset:${normalizeSunsetLook(sunsetLook)}` : (time in TIME_PROFILES ? time : 'day');
}

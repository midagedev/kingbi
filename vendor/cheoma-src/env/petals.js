import * as THREE from 'three';
import { DEFAULT_DETAIL_BANDS, fadeBeyond } from '../core/lod.js';
import { makeRng } from '../rng.js';
import { createPetalWorldRepresentation } from './detail-particle-geometry.js';

// 계절 입자 필드(태스크 #111) — 봄 벚꽃 꽃잎 · 가을 낙엽의 "카메라 추종 볼륨".
//
// 배경: 기존 계절 낙엽/꽃잎(env/seasons.js seasonLeaves)은 나무 수관에서 방출돼 env 원점(≈마을
//   중심)에 고정된다. 마을 focus 근경(원점에서 벗어난 집)에선 나무가 화면 밖이라 낙엽/꽃잎이
//   안 보였다("가을만큼 봄의 흩날리는 벚꽃이 백미인데" 사용자 피드백). 이 모듈은 눈·비와 동일한
//   "카메라 타깃을 따라오는 낙하 볼륨"을 계절 입자로 만들어, 보는 곳 어디서나 꽃잎·낙엽이 흩날리게
//   한다. seasons.js 원점 방출분과 공존(마을 중심 근경에선 둘 다, 원점 밖 focus 근경에선 이 필드만).
//
// 소유·구동: 이 필드는 weather.js 가 소유해 scene 루트에 붙이고(눈·비처럼 env.group 은닉을 우회 →
//   마을에서도 보임), 매 프레임 setWeatherCenter 로 카메라 타깃에 이설한다. season 은 weather 가
//   setSeason 으로 전달(env.setSeason → window.__wx.setSeason 브릿지). present(조기노출 게이트)·
//   viewHeight(시선 타깃 대비 카메라 높이)도 weather 가 넘긴다.
//
// 눈과의 차이(팔랑거림): 눈은 거의 수직 낙하 + 미세 흔들림. 꽃잎/낙엽은 (1) 훨씬 느린 부유 낙하,
//   (2) 개별 위상·진폭의 큰 좌우 플러터(사인 합성 → 변위 시계열 비단조), (3) 월드 곡면의 개별 회전.
//   낙엽은 꽃잎보다 크고 회전이 격해 "구르듯" 떨어진다.

const TAU = Math.PI * 2;
const FIELD_SEED = 0x9e7a1;

// 계절별 팔레트·형상·물성. 봄=분홍~흰 둥근 꽃잎(느리고 가벼움), 가을=주홍·주황·황·갈 뾰족한 잎(구름).
const SEASON_CFG = {
  spring: {
    colors: [0xffe3ec, 0xffd0dd, 0xf9b8cc, 0xfff2f6, 0xf6c6d7, 0xffdce6],
    size: [1.3, 2.8],     // 월드 곡면 배율: 최종 장축 약 1.9–4.0cm.
    fall: [0.75, 1.7],    // 낙하 속도(부유감 — 눈 2.4~6.0 보다 훨씬 느림)
    flutter: [1.3, 2.9],  // 좌우 팔랑 진폭
    freq: [0.5, 1.25],    // 팔랑 주파수(rad/s)
    rot: [0.5, 1.7],      // 월드 곡면 회전 속도
    windCarry: 3.2,
  },
  autumn: {
    colors: [0xc7452a, 0xd8792a, 0xd9a531, 0xb85a26, 0xa8662e, 0xcf8b3a, 0xbf5a2b],
    // 사용자 지시(2026-07-25) 2단계: "낙엽같은게 조금 더 컸으면" → "윤곽을 알아볼 수 있게 살짝 과장해서
    // 키우고". 구 [1.9,4.0](5.7~12cm)의 2.4배. 장축 약 13.7–28.8cm로, 실물 오동·플라타너스
    // (20~30cm) 상단에 해당한다 — 단풍 기준으로는 과장이지만 수종 밴드 안이라 고증 주장은 유지된다.
    // 주의: `detail-particle-geometry.js`의 `speciesScale = mix(0.48, 1.0, step(0.5, aSpecies))`는
    // 가을 수종(은행 1·단풍 2) 둘 다 1.0이고 0.48은 **봄 꽃잎(0)에만** 적용된다. 즉 가을 잎에는
    // 작은 쪽 안전판이 없고 전량이 이 범위를 쓴다 — 여기가 실질 상한이다.
    // seasons.js 수관 방출 낙엽의 `sizeScale` 2.4와 같은 비율 — 두 계통이 한 화면에서 어긋나지 않는다.
    size: [4.56, 9.6],    // 월드 곡면 장축 약 13.7–28.8cm(꽃잎보다 크게 유지)
    fall: [1.2, 2.6],     // 낙엽은 꽃잎보다 조금 빠르되 여전히 느림
    flutter: [1.6, 3.3],
    freq: [0.45, 1.15],
    rot: [1.1, 3.2],      // 구르듯 격한 회전
    windCarry: 4.0,
  },
};

// 수직 디테일 게이트: 절대 world Y가 아니라 카메라와 현재 시선 타깃/지면 사이의 높이에
// 적용한다. 산지와 평지가 동일한 줌 단계에서 40m→52m로 자연스럽게 소거된다.
export function petalDetailWeight(viewHeight, camDist = NaN, sharedWeight = null) {
  let weight = 1;
  let measured = false;
  if (Number.isFinite(viewHeight)) {
    const { full, hidden } = DEFAULT_DETAIL_BANDS.particles;
    weight = Math.min(weight, fadeBeyond(viewHeight, full, hidden));
    measured = true;
  }
  // 낮은 앙각으로 멀리 보는 구도도 입자 시뮬레이션을 쉬게 한다. 3인자 구 API 역시
  // 이 거리 밴드만으로 자연스럽게 동작하고, 마을은 같은 값이 sharedWeight로 한 번 더 고정된다.
  if (Number.isFinite(camDist)) {
    const { full, hidden } = DEFAULT_DETAIL_BANDS.particleView;
    weight = Math.min(weight, fadeBeyond(camDist, full, hidden));
    measured = true;
  }
  if (Number.isFinite(sharedWeight)) {
    weight = Math.min(weight, Math.max(0, Math.min(1, sharedWeight)));
    measured = true;
  }
  return measured ? weight : 1; // 신호 없음(env 단독 하네스 초기) → 근경 취급
}

// 가을 잎 종별 팔레트: 은행=순수 황금, 단풍=진홍~주황(#116).
const GINKGO_COLS = [0xf2c53d, 0xf0b429, 0xe8b21f, 0xf5ce4a];
const MAPLE_COLS = [0xc0392b, 0xd35400, 0xe0491f, 0xb83a1e, 0xd9622b];

// createPetalField({ getWind }) →
//   { object, setSeason(name), update(dt, {t, camDist, viewHeight, present, wind}), get level, get count, get season, aabb(), dispose() }
export function createPetalField({ getWind, getLightDirection = null } = {}) {
  // #125 대폭 감축(사용자: "색종이 축제 아니라 바람에 이따금 지는 잎"). 기존 1200 → 460. 실제 동시
  //   가시 수는 아래 돌풍 게이트(uActive)가 더 조인다 — 잔잔할 땐 한 자릿수~십수 장, 돌풍에 잠깐 늘었다
  //   잦아든다. per-frame 갱신 루프도 N 감축분만큼 저비용(성능 우선).
  // 460 은 전 디바이스 공통이다 — 종전의 폰 220 은 계절감을 절반으로 깎으면서 아낀 것이 단일
  //   InstancedMesh 안의 인스턴스 240개(드로우콜·프로그램 델타 0)뿐이었다(docs/mobile-effects-audit.md M17).
  // 2026-07-25 사용자: "좀 더 많이 날려도 좋겠어 가을 분위기 나게" → 460→680(1.5배). 드로우콜·프로그램
  //   델타 0(단일 InstancedMesh), 비용은 per-frame 궤적 루프뿐. 실제 체감 밀도를 정하는 것은 N이 아니라
  //   아래 가을 `gustBase`이므로 그쪽을 함께 올렸다.
  const N = 680;
  // 계절별 볼륨. 눈(46)에 맞춘 88×88×41m 박스는 근접 focus 프레임(거리 47m·fov 20° ≈ 폭 16m) 밖에
  //   잎을 대부분 두어, N을 올려도 화면에는 몇 장만 남는다(2026-07-25 판정 실측: 680장 중 프레임 내
  //   판독 가능 18장, 화면 점유 0.048%). 가을만 볼륨을 조여 **같은 N·같은 드로우콜로 화면 밀도만** 올린다.
  //   봄 꽃보라는 넓은 볼륨을 유지한다 — 벚꽃은 성기게 흩날리는 것이 정격이고, 같은 조임을 적용하면
  //   3.75배가 되어 #125가 거부한 색종이로 넘어간다.
  const SEASON_VOLUME = { spring: { half: 44, yTop: 40 }, autumn: { half: 28, yTop: 26 } };
  let half = SEASON_VOLUME.spring.half;   // 수평 반경(카메라 타깃 주변 볼륨)
  const yBottom = -1.0;
  let yTop = SEASON_VOLUME.spring.yTop;
  let H = yTop - yBottom;

  const rng = makeRng(FIELD_SEED);

  // 위치·물성 버퍼(계절 무관 궤적 파라미터는 고정, 색/형상/속도만 setSeason 으로 갱신)
  const pos = new Float32Array(N * 3);
  const aSize = new Float32Array(N);
  const aColor = new Float32Array(N * 3);
  const aRot = new Float32Array(N);      // 회전 위상(초기)
  const aRotSpd = new Float32Array(N);   // 회전 속도
  const aOpacity = new Float32Array(N);
  const aSpecies = new Float32Array(N);  // 잎 종(0=꽃잎,1=은행,2=단풍) — setSeason 에서 배정
  const aThresh = new Float32Array(N);   // #125 돌풍 게이트 임계값(개체별) — uActive 가 이걸 넘어야 보임

  // CPU 궤적 상태(월드 로컬 — object.position 이 카메라 타깃으로 이설)
  const bx = new Float32Array(N), bz = new Float32Array(N), py = new Float32Array(N);
  const phase = new Float32Array(N);     // 팔랑 위상
  const fAmp = new Float32Array(N);      // 팔랑 진폭
  const fFreq = new Float32Array(N);     // 팔랑 주파수
  const fall = new Float32Array(N);      // 낙하 속도

  for (let i = 0; i < N; i++) {
    bx[i] = (rng() * 2 - 1) * half;
    bz[i] = (rng() * 2 - 1) * half;
    py[i] = yBottom + rng() * H;
    phase[i] = rng() * TAU;
    aRot[i] = rng() * TAU;
    aOpacity[i] = rng.range(0.7, 1.0);
    aThresh[i] = rng();
    pos[i * 3] = bx[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = bz[i];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geo.setAttribute('aRot', new THREE.BufferAttribute(aRot, 1));
  geo.setAttribute('aRotSpd', new THREE.BufferAttribute(aRotSpd, 1));
  geo.setAttribute('aOpacity', new THREE.BufferAttribute(aOpacity, 1));
  geo.setAttribute('aSpecies', new THREE.BufferAttribute(aSpecies, 1));
  geo.setAttribute('aThresh', new THREE.BufferAttribute(aThresh, 1));

  // A single world-space geometry owns the color and exact packed-depth paths.
  // The source geometry below is CPU state only; its attributes are shared by
  // the instanced view and never submitted as a second draw.
  const worldDetail = createPetalWorldRepresentation(geo, { renderOrder: 18 });
  const object = worldDetail.object;
  let disposed = false;
  let season = 'summer';          // 'spring'|'autumn' 이면 활성, 그 외 OFF
  let level = 0;                  // 현재 유효 강도(season*present*altGate)
  let activeSmooth = 0;           // #125 돌풍 게이트 평활값(간헐 리듬)
  const tmpColor = new THREE.Color();

  // 계절별 색/형상/속도/회전 재생성(결정론 — 같은 계절이면 같은 배치). 궤적 위상/기저 좌표는 불변.
  function setSeason(name) {
    const active = name === 'spring' || name === 'autumn';
    season = name;
    if (!active) {
      object.visible = false;
      level = 0;
      return;
    }
    const cfg = SEASON_CFG[name];
    const autumn = name === 'autumn';
    // 볼륨 전환은 기존 궤적을 **비율 유지로 재척도**한다(재생성이 아니라). 그래야 계절 전환이 위상 점프
    //   없이 이어지고, 상태가 이전 상태의 순수 함수라 결정론도 유지된다.
    const vol = SEASON_VOLUME[name] || SEASON_VOLUME.spring;
    if (vol.half !== half || vol.yTop !== yTop) {
      const sxz = vol.half / half;
      const nextH = vol.yTop - yBottom;
      const sy = nextH / H;
      for (let i = 0; i < N; i++) {
        bx[i] *= sxz; bz[i] *= sxz;
        py[i] = yBottom + (py[i] - yBottom) * sy;
      }
      // 팔랑 진폭(fAmp)은 아래 루프에서 계절 cfg 로 재생성되므로 여기서 손대지 않는다.
      half = vol.half; yTop = vol.yTop; H = nextH;
    }
    const cr = makeRng(FIELD_SEED ^ (name === 'spring' ? 0x5091 : 0xa07a));
    for (let i = 0; i < N; i++) {
      // 가을=은행(황금 부채꼴)·단풍(주홍 장상) 개체별 배정, 봄=벚꽃 꽃잎.
      let hex, species;
      if (autumn) {
        const isGinkgo = cr() < 0.5;
        species = isGinkgo ? 1 : 2;
        hex = cr.pick(isGinkgo ? GINKGO_COLS : MAPLE_COLS);
      } else {
        species = 0;
        hex = cr.pick(cfg.colors);
      }
      tmpColor.setHex(hex);
      aColor[i * 3] = tmpColor.r; aColor[i * 3 + 1] = tmpColor.g; aColor[i * 3 + 2] = tmpColor.b;
      aSpecies[i] = species;
      aSize[i] = cr.range(cfg.size[0], cfg.size[1]);
      aRotSpd[i] = cr.range(cfg.rot[0], cfg.rot[1]) * (cr() < 0.5 ? -1 : 1);
      fall[i] = cr.range(cfg.fall[0], cfg.fall[1]);
      fAmp[i] = cr.range(cfg.flutter[0], cfg.flutter[1]);
      fFreq[i] = cr.range(cfg.freq[0], cfg.freq[1]);
    }
    geo.attributes.aColor.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aRotSpd.needsUpdate = true;
    geo.attributes.aSpecies.needsUpdate = true;
    worldDetail.syncSeasonAttributes();
  }

  const posAttr = geo.attributes.position;

  // update(dt, { t, camDist, viewHeight, present, wind })
  //   t: 누적 시간(회전·팔랑 위상), present: 조기노출 게이트(0..1, weather 판정),
  //   viewHeight: 시선 타깃/지면 대비 카메라 높이, camDist: 구 API 하위호환 근사치,
  //   wind: getWind(t) 결과(공유 바람).
  function update(dt, {
    t = 0, camDist = NaN, viewHeight = null, detailWeight = null,
    present = 1, wind = null,
  } = {}) {
    const active = season === 'spring' || season === 'autumn';
    const alt = petalDetailWeight(viewHeight, camDist, detailWeight);
    level = active ? Math.max(0, Math.min(1, present)) * alt : 0;
    worldDetail.material.uniforms.uFade.value = level;
    worldDetail.material.uniforms.uTime.value = t;
    const lightDirection = getLightDirection?.();
    if (lightDirection?.isVector3 && lightDirection.lengthSq() > 1e-8) {
      worldDetail.material.uniforms.uLightDir.value.copy(lightDirection).normalize();
    }
    const visible = level > 0.002;
    object.visible = visible;
    if (!visible) return;   // 비가시면 CPU 궤적 갱신 생략(성능)

    const cfg = SEASON_CFG[season];
    const w = wind || (getWind ? getWind(t) : { dirX: 1, dirZ: 0, speed: 0.2, gust: 0 });
    // #125 돌풍 게이트: 계절 기저(봄=꽃보라로 조금 더 풍성, 가을=희소) + 돌풍 가산, 완만 평활
    //   → "잠깐 늘었다 잦아드는" 리듬(기존 바람 필드 gust 재사용). 잔잔할 땐 한 자릿수~십수 장만 보임.
    // 가을 기저는 #125에서 0.12(희소)였다. 2026-07-25 사용자 지시("가을 분위기 나게 좀 더 많이")로
    //   올렸고, 1차 판정이 "개선은 크지만 아직 가을 분위기 아님"(프레임 내 18장·점유 0.048%)이라
    //   0.30까지 올린다 — 봄 꽃보라(0.34)보다는 여전히 성기고, 돌풍 가산이 남아 "잠깐 늘었다 잦아드는"
    //   리듬은 유지된다. 0.34 이상으로 올리면 #125가 금지한 색종이 축제로 되돌아간다.
    const gustBase = season === 'spring' ? 0.34 : 0.30;
    const gustTarget = Math.min(1, gustBase + (w.gust || 0) * 0.85);
    activeSmooth += (gustTarget - activeSmooth) * Math.min(1, dt * 1.4);
    worldDetail.material.uniforms.uActive.value = activeSmooth;
    const wx = w.dirX * w.speed, wz = w.dirZ * w.speed;
    const carry = cfg.windCarry;
    const swirl = 1.0 + w.gust * 1.8;   // 돌풍에 팔랑이 격해진다
    const arr = posAttr.array;
    for (let i = 0; i < N; i++) {
      // 낙하(단조 감소) — 부유감
      py[i] -= fall[i] * dt;
      // 기저 좌표를 바람에 실어 나르고 박스 내 랩(순환)
      bx[i] += wx * carry * dt;
      bz[i] += wz * carry * dt;
      if (bx[i] > half) bx[i] -= 2 * half; else if (bx[i] < -half) bx[i] += 2 * half;
      if (bz[i] > half) bz[i] -= 2 * half; else if (bz[i] < -half) bz[i] += 2 * half;
      if (py[i] < yBottom) py[i] += H;   // 바닥 도달 시 상단 재순환
      // 팔랑(비단조 좌우 변위 — 사인 합성). x 는 강한 1차 + 약한 2차, z 는 위상차 코사인.
      const ph = phase[i];
      arr[i * 3] = bx[i]
        + Math.sin(t * fFreq[i] + ph) * fAmp[i] * swirl
        + Math.sin(t * fFreq[i] * 2.3 + ph * 1.7) * fAmp[i] * 0.35;
      arr[i * 3 + 1] = py[i];
      arr[i * 3 + 2] = bz[i]
        + Math.cos(t * fFreq[i] * 0.85 + ph) * fAmp[i] * 0.8 * swirl;
    }
    posAttr.needsUpdate = true;
    worldDetail.syncPosition();
  }

  function aabb() {
    const box = new THREE.Box3().setFromBufferAttribute(posAttr);
    box.translate(object.position);   // 카메라 이설분 반영(월드 AABB)
    return box;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    object.visible = false;
    geo.dispose();
    worldDetail.dispose();
  }

  return {
    object, setSeason, update, aabb, dispose,
    get level() { return level; },
    get count() { return level > 0.01 ? N : 0; },
    get season() { return season; },
  };
}

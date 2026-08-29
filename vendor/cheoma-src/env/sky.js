import * as THREE from 'three';
import { candleFlicker } from './night-glow.js';
import { disposeObjectTree } from '../core/three-resources.js';
import {
  DEFAULT_SUNSET_LOOK,
  TIME_PRESETS,
  atmosphereProfileKey,
  normalizeSunsetLook,
  resolveAtmosphereProfile,
} from './atmosphere-profiles.js';
import {
  DEFAULT_MOON_OPTICS,
  MOON_CORONA_ENERGY,
  MOON_CORONA_PROFILE,
  MOON_RENDER_ORDER,
} from './moon-optics.js';

export { TIME_PRESETS } from './atmosphere-profiles.js';

// 달 코로나 텍스처. 직접광 원반 안쪽은 비워 단단한 0.52° 경계를 보존하고,
// 바로 바깥의 회절광에서 시작해 5° 안에서 낮은 에너지로 사라진다.
function makeMoonCoronaTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const half = c.width * 0.5;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  for (const [position, alpha] of MOON_CORONA_PROFILE) {
    grad.addColorStop(position, `rgba(255,255,255,${alpha})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// All profiles keep exactly four sky stops (bottom to top), so time/look transitions can
// interpolate position and sRGB colour one-to-one without reallocating the canvas texture.

// 가을 능선 훅: season=autumn 일 때 원경 능선·안개를 단풍든 산자락 색조로 살짝 물들인다.
// 낮엔 분명히(따뜻한 산), 석양엔 이미 따뜻하니 약하게, 밤엔 거의 무채색으로 가라앉힌다.
// 값은 setPalette 와 같은 공간(THREE.Color(hex) 직접) — sRGB 디코드 없이 대기원근 색과 섞인다.
const AUTUMN_RIDGE = {
  near: new THREE.Color(0x8a6440),   // 가까운 능선: 단풍든 숲(대기감쇠로 채도 낮음)
  far: new THREE.Color(0xceac78),    // 원경: 따뜻한 haze (옅은 청색 능선을 상쇄해 회색화 방지)
  mist: new THREE.Color(0xead2ab),   // 능선 사이 안개도 살짝 온기
};
const AUTUMN_RIDGE_AMT = { dawn: 0.16, day: 0.36, sunset: 0.12, night: 0.04 };
const WINTER_RIDGE = {
  near: new THREE.Color(0x687078),
  far: new THREE.Color(0xb8c2ca),
  mist: new THREE.Color(0xd7dde2),
};
const WINTER_RIDGE_AMT = { dawn: 0.22, day: 0.42, sunset: 0.18, night: 0.10 };

// ── 돔 ↔ 대기(fog) 결합 (R5 / U1) ────────────────────────────────────────────
// 돔은 fog:false 라 대기 원근에 참여하지 않는다. 그래서 지평 아래(=지형이 끝난 뒤의 배경)까지
// 노을 그라디언트가 그대로 깔리면 지형 절단면이 하늘에 하드컷으로 붙어 "떠 있는 디오라마 원반"이
// 된다. 해법: 돔 텍스처에 현재 대기색을 알파 램프로 덮어 지평 아래를 fog 색으로 수렴시킨다
//   — scene.background(=fog 색)와 돔 지평이 같은 색이 되므로 지형 외곽·수관 실루엣이
//     "끝"이 아니라 대기로 소실되는 방향으로 읽힌다(운해 링·능선 물안개가 그 위를 마감).
// 지평 위에도 낮은 잔여 헤이즈를 남겨(HAZE_TOP) 하늘만 채도가 튀고 지형이 눌리는 대비를 완화한다.
// pos 규약: 0=천저(nadir) · 0.5=지평 · 1=천정(zenith) — 프로필 sky 스톱과 동일 공간.
// 지평 아래는 사실상 대기색으로 수렴시킨다(docs/look-grammar §3 "지평 밴드는 fog색 수렴"):
// 남긴 프로필 계조가 배경을 지형 헤이즈보다 밝게 만들면 절단면에 다시 단차가 생긴다(A/B 실측).
// 배경의 시각적 흥미는 칠해진 그라디언트가 아니라 능선 겹침·운무가 만든다.
// #211 U1: 부감은 지평 위·아래를 더 넓게 본다. 지평 밴드의 fog 수렴을 조금 더 올려 절단면 뒤
//   분홍 스카이 그라디언트가 하드컷 대비를 만들지 않게 한다(천정 채도는 유지 — 하늘은 죽이지 않음).
const DOME_HAZE = [
  { pos: 1.00, a: 0.07 },   // 천정: 프로필 색 거의 그대로(하늘은 유지 — 되돌리면 밋밋한 공백)
  { pos: 0.62, a: 0.28 },   // 지평 위 ≈+22°: 옅은 대기 헤이즈(부감 상단 밴드 대비 완화)
  { pos: 0.52, a: 0.74 },   // 지평 바로 위: 대기색 우세 + 노을 온기 잔향(아이레벨·히어로 화각)
  { pos: 0.44, a: 0.96 },   // 지평 아래 ≈−11°: 대기색 = scene.background 와 사실상 동일
  { pos: 0.00, a: 0.98 },
];
const HAZE_EPS = 1 / 512;   // sRGB 1/2 LSB — 이보다 작은 변화로는 텍스처를 다시 올리지 않는다

// 전환 길이·이징 ---------------------------------------------------------------
const DUR_TIME = 1.8;      // 시간대 크로스페이드(초) — 짧은 타임랩스감(그림자가 스윽 돈다)
const SEASON_RATE = 2.6;   // 가을 능선 틴트 지수 접근 속도(seasons.js 수목 틴트와 결이 맞게)
const easeInOut = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

// '#rrggbb' → {r,g,b} 원시 sRGB(0..1, 디코드 없음). 캔버스 그라디언트가 스톱 사이를 sRGB 로
// 보간하므로, 시간대 간 스톱 색도 sRGB 로 보간해야 캔버스 룩과 일치한다.
function parseHexSRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// 하늘 돔 + 등불. mountains(setPalette) 를 함께 물려 대기원근을 동기화.
export function createSky({ scene, sun, hemi, renderer, group, mountains, layout }) {
  // Celestial presentation is scene-level. Village mode hides `group` to swap the
  // single-house terrain, but the sky must remain continuous behind both scenes.
  const skyRoot = new THREE.Group();
  skyRoot.name = 'sky-atmosphere';
  skyRoot.visible = false;
  scene.add(skyRoot);

  // 하늘 돔: 큰 구, 안쪽면, fog 미적용(하늘 자체). 텍스처는 재사용(트윈 중 매 프레임 재그림).
  const domeGeo = new THREE.SphereGeometry(720, 32, 20);
  const domeCanvas = document.createElement('canvas');
  domeCanvas.width = 4; domeCanvas.height = 256;
  const domeCtx = domeCanvas.getContext('2d');
  const domeTex = new THREE.CanvasTexture(domeCanvas);
  domeTex.colorSpace = THREE.SRGBColorSpace;
  const domeMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false, map: domeTex });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'skyDome';
  dome.renderOrder = -100;
  // A sky sphere is angular scenery, not world geometry. Follow the render camera so
  // Hanyang aerials and telephoto parcel focus cannot leave the 720 m shell.
  dome.onBeforeRender = (rend, sc, camera) => {
    dome.position.copy(camera.position);
    dome.updateMatrixWorld();
  };
  skyRoot.add(dome);

  // 현재 대기(fog)색의 원시 sRGB — 돔 헤이즈 오버레이 색. syncHaze 가 갱신한다.
  const hazeSRGB = { r: 0.77, g: 0.64, b: 0.56 };
  const _hazeTmp = { r: 0, g: 0, b: 0 };

  // 스톱 배열({pos, r,g,b})로 돔 캔버스를 다시 그린다(텍스처 재사용).
  //   + 대기 결합 오버레이(DOME_HAZE): 지평 아래를 현재 fog 색으로 수렴시킨다.
  function buildDomeFromStops(stops) {
    const grad = domeCtx.createLinearGradient(0, 0, 0, 256);
    for (const s of stops) {
      const R = Math.round(s.r * 255), G = Math.round(s.g * 255), B = Math.round(s.b * 255);
      grad.addColorStop(1 - s.pos, `rgb(${R},${G},${B})`);
    }
    domeCtx.fillStyle = grad;
    domeCtx.fillRect(0, 0, 4, 256);
    const hR = Math.round(hazeSRGB.r * 255), hG = Math.round(hazeSRGB.g * 255), hB = Math.round(hazeSRGB.b * 255);
    const haze = domeCtx.createLinearGradient(0, 0, 0, 256);
    for (const s of DOME_HAZE) haze.addColorStop(1 - s.pos, `rgba(${hR},${hG},${hB},${s.a})`);
    domeCtx.fillStyle = haze;
    domeCtx.fillRect(0, 0, 4, 256);
    domeTex.needsUpdate = true;
  }

  // 최종 합성 대기색(날씨 틴트·마을 모디파이어 이후)으로 돔 헤이즈를 맞춘다. env 의 fog 합성 훅이
  //   매 프레임 호출하므로 실변화가 없으면 텍스처를 다시 올리지 않는다(정착 상태 비용 0).
  function syncHaze(color) {
    if (!color) return;
    color.getRGB(_hazeTmp, THREE.SRGBColorSpace);
    if (Math.abs(_hazeTmp.r - hazeSRGB.r) < HAZE_EPS
      && Math.abs(_hazeTmp.g - hazeSRGB.g) < HAZE_EPS
      && Math.abs(_hazeTmp.b - hazeSRGB.b) < HAZE_EPS) return;
    hazeSRGB.r = _hazeTmp.r; hazeSRGB.g = _hazeTmp.g; hazeSRGB.b = _hazeTmp.b;
    buildDomeFromStops(cur.stops);
  }

  // 처마 네 모서리 등불: 따뜻한 PointLight + 작은 발광 구
  const lx = (layout.xEave ?? 9) * 0.98;
  const lz = (layout.zEave ?? 6) * 0.98;
  const ly = (layout.eaveEdgeY ?? 6.5) - 0.4;
  const lanterns = [];
  // 트윈 중 등불이 서서히 켜지/꺼지도록 발광 구를 반투명으로(정착 시 opacity=1 == 기존 룩).
  // #73 blowout 톤다운: 구 색 0xffca6e 는 R 채널이 255 로 클리핑된 거의 흰빛 웜이라, 야간 bloom
  //   (threshold 0.32)이 이를 흰 blowout 오브로 증폭했다. 채도 있는 웜 앰버(선형 휘도 ≈0.36, 야간
  //   임계 바로 위)로 낮춰 "코어는 호롱불 앰버, 헤일로도 앰버"로 은은히 피게 한다. 채도가 살아 있어
  //   bloom 가산분이 흰색으로 씻기지 않는다. 석양(임계 0.80)에선 이 밝기가 임계 아래라 bloom 없이
  //   작은 앰버 점으로만 남아 골든아워 룩 무회귀.
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xdd8836, fog: true, transparent: true, opacity: 1 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const light = new THREE.PointLight(0xffb257, 0, 18, 2);
    light.position.set(sx * lx, ly, sz * lz);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), glowMat);
    bulb.position.copy(light.position);
    bulb.visible = false;
    group.add(light); group.add(bulb);
    lanterns.push({ light, bulb });
  }

  let flickT = 0;              // 등롱 촛불 플리커 누적 시계(결정론)
  let lanternNight = false;   // 등롱 일렁임(등불이 켜져 있을 때)

  // 달 + 달무리 (야간). scene-level sky 자식이며 environment lifecycle이 함께 켜고 정리한다.
  const moonGroup = new THREE.Group();
  moonGroup.name = 'moon';
  moonGroup.userData.optics = DEFAULT_MOON_OPTICS;
  const moonDisk = new THREE.Mesh(
    new THREE.SphereGeometry(DEFAULT_MOON_OPTICS.diskRadius, 24, 16),
    // 트윈 페이드용 반투명(정착 야간 opacity=1 == 기존 불투명 룩).
    new THREE.MeshBasicMaterial({
      color: 0xf4efda, fog: false, depthTest: true, depthWrite: false,
      transparent: true, opacity: 1,
    })
  );
  moonDisk.name = 'moon-disk';
  // The moon is camera-relative. Its world-space bounds still describe the
  // previous frame until onBeforeRender repositions the group, so culling here
  // would prevent that lifecycle hook from ever repairing the placement.
  moonDisk.frustumCulled = false;
  moonDisk.renderOrder = MOON_RENDER_ORDER.disk;
  moonDisk.userData.angularDiameterDeg = DEFAULT_MOON_OPTICS.diskAngularDiameterDeg;
  moonGroup.add(moonDisk);
  const coronaTex = makeMoonCoronaTexture();
  const coronaGeometry = new THREE.PlaneGeometry(
    DEFAULT_MOON_OPTICS.coronaSpan,
    DEFAULT_MOON_OPTICS.coronaSpan,
  );
  const makeCorona = (name, opacity, renderOrder, layer) => {
    const mesh = new THREE.Mesh(
      coronaGeometry,
      new THREE.MeshBasicMaterial({
        map: coronaTex, color: 0xd5def2, transparent: true, opacity,
        depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
      }),
    );
    mesh.name = name;
    mesh.renderOrder = renderOrder;
    mesh.userData = {
      angularDiameterDeg: DEFAULT_MOON_OPTICS.coronaAngularDiameterDeg,
      layer,
      baseOpacity: opacity,
    };
    return mesh;
  };
  const transmittedCorona = makeCorona(
    'moon-corona-transmitted',
    MOON_CORONA_ENERGY.transmitted,
    MOON_RENDER_ORDER.coronaTransmitted,
    'transmitted',
  );
  const scatteredCorona = makeCorona(
    'moon-corona-scattered',
    MOON_CORONA_ENERGY.scattered,
    MOON_RENDER_ORDER.coronaScattered,
    'scattered',
  );
  transmittedCorona.frustumCulled = false;
  scatteredCorona.frustumCulled = false;
  moonGroup.add(transmittedCorona, scatteredCorona);
  const coronaLayers = [transmittedCorona, scatteredCorona];
  moonGroup.userData.coronaLayers = Object.freeze([
    Object.freeze({
      name: transmittedCorona.name,
      opacity: MOON_CORONA_ENERGY.transmitted,
      renderOrder: MOON_RENDER_ORDER.coronaTransmitted,
    }),
    Object.freeze({
      name: scatteredCorona.name,
      opacity: MOON_CORONA_ENERGY.scattered,
      renderOrder: MOON_RENDER_ORDER.coronaScattered,
    }),
  ]);
  moonGroup.visible = false;
  skyRoot.add(moonGroup);

  const moonOffset = new THREE.Vector3();
  const placeMoonForCamera = (camera) => {
    // The product directional light position is the shared celestial direction
    // source. Focused hero views may rotate it without rebuilding the sky state.
    moonOffset.copy(sun.position).normalize().multiplyScalar(DEFAULT_MOON_OPTICS.distance);
    moonGroup.position.copy(camera.position).add(moonOffset);
    moonGroup.updateMatrixWorld(true);
  };
  moonDisk.onBeforeRender = (rend, sc, camera) => placeMoonForCamera(camera);
  for (const corona of coronaLayers) {
    corona.onBeforeRender = (rend, sc, camera) => {
      placeMoonForCamera(camera);
      corona.lookAt(camera.position);
      corona.updateMatrixWorld();
    };
  }

  // ── 상태(State) 표현 ──────────────────────────────────────────────────────
  // 보간 가능한 모든 시간대 필드를 한 객체로. 색은 setHex(sRGB→선형) 디코드된 THREE.Color 로
  // 저장해 선형에서 lerp 후 copy 로 적용 → 정착값은 기존 setHex 경로와 동일하다.
  function makeState() {
    return {
      sunDir: new THREE.Vector3(), sunColor: new THREE.Color(), sunInt: 0,
      hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiInt: 0,
      fogColor: new THREE.Color(), fogNear: 0, fogFar: 0, exposure: 1,
      ridgeNear: new THREE.Color(), ridgeFar: new THREE.Color(), mist: new THREE.Color(),
      mistOp: 0, autumnAmt: 0, winterAmt: 0, lantern: 0, moon: 0,
      stops: [0, 1, 2, 3].map(() => ({ pos: 0, r: 0, g: 0, b: 0 })),
    };
  }
  let sunsetLook = DEFAULT_SUNSET_LOOK;
  function resolveInto(out, name) {
    const P = resolveAtmosphereProfile(name, sunsetLook);
    out.sunDir.set(P.sunDir[0], P.sunDir[1], P.sunDir[2]).normalize();
    out.sunColor.setHex(P.sunColor); out.sunInt = P.sunInt;
    out.hemiSky.setHex(P.hemiSky); out.hemiGround.setHex(P.hemiGround); out.hemiInt = P.hemiInt;
    out.fogColor.setHex(P.fog); out.fogNear = P.fogNear; out.fogFar = P.fogFar; out.exposure = P.exposure;
    out.ridgeNear.setHex(P.ridgeNear); out.ridgeFar.setHex(P.ridgeFar); out.mist.setHex(P.mist);
    out.mistOp = P.mistOp;
    out.autumnAmt = AUTUMN_RIDGE_AMT[name] ?? 0.3;
    out.winterAmt = WINTER_RIDGE_AMT[name] ?? 0.3;
    out.lantern = P.lantern || 0; out.moon = P.moon ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      const c = parseHexSRGB(P.sky[i][1]);
      out.stops[i].pos = P.sky[i][0]; out.stops[i].r = c.r; out.stops[i].g = c.g; out.stops[i].b = c.b;
    }
    return out;
  }
  function copyState(dst, src) {
    dst.sunDir.copy(src.sunDir); dst.sunColor.copy(src.sunColor); dst.sunInt = src.sunInt;
    dst.hemiSky.copy(src.hemiSky); dst.hemiGround.copy(src.hemiGround); dst.hemiInt = src.hemiInt;
    dst.fogColor.copy(src.fogColor); dst.fogNear = src.fogNear; dst.fogFar = src.fogFar; dst.exposure = src.exposure;
    dst.ridgeNear.copy(src.ridgeNear); dst.ridgeFar.copy(src.ridgeFar); dst.mist.copy(src.mist);
    dst.mistOp = src.mistOp; dst.autumnAmt = src.autumnAmt; dst.winterAmt = src.winterAmt;
    dst.lantern = src.lantern; dst.moon = src.moon;
    for (let i = 0; i < 4; i++) {
      dst.stops[i].pos = src.stops[i].pos; dst.stops[i].r = src.stops[i].r;
      dst.stops[i].g = src.stops[i].g; dst.stops[i].b = src.stops[i].b;
    }
  }
  const _l = (a, b, k) => a + (b - a) * k;
  function lerpStateInto(out, a, b, k) {
    out.sunDir.copy(a.sunDir).lerp(b.sunDir, k).normalize();
    out.sunColor.copy(a.sunColor).lerp(b.sunColor, k); out.sunInt = _l(a.sunInt, b.sunInt, k);
    out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, k); out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, k);
    out.hemiInt = _l(a.hemiInt, b.hemiInt, k);
    out.fogColor.copy(a.fogColor).lerp(b.fogColor, k);
    out.fogNear = _l(a.fogNear, b.fogNear, k); out.fogFar = _l(a.fogFar, b.fogFar, k);
    out.exposure = _l(a.exposure, b.exposure, k);
    out.ridgeNear.copy(a.ridgeNear).lerp(b.ridgeNear, k); out.ridgeFar.copy(a.ridgeFar).lerp(b.ridgeFar, k);
    out.mist.copy(a.mist).lerp(b.mist, k);
    out.mistOp = _l(a.mistOp, b.mistOp, k); out.autumnAmt = _l(a.autumnAmt, b.autumnAmt, k);
    out.winterAmt = _l(a.winterAmt, b.winterAmt, k);
    out.lantern = _l(a.lantern, b.lantern, k); out.moon = _l(a.moon, b.moon, k);
    for (let i = 0; i < 4; i++) {
      out.stops[i].pos = _l(a.stops[i].pos, b.stops[i].pos, k);
      out.stops[i].r = _l(a.stops[i].r, b.stops[i].r, k);
      out.stops[i].g = _l(a.stops[i].g, b.stops[i].g, k);
      out.stops[i].b = _l(a.stops[i].b, b.stops[i].b, k);
    }
  }

  // 현재 화면에 적용 중인 상태(트윈 from 스냅샷·정착값의 단일 소스).
  const cur = makeState();
  const from = makeState();
  const to = makeState();
  const tmp = makeState();      // 리타깃 시 현재 보간값 스냅샷 임시
  // 능선 합성용 재사용 색.
  const _rn = new THREE.Color(), _rf = new THREE.Color(), _rm = new THREE.Color();

  let curName = 'day';
  let curKey = atmosphereProfileKey('day', sunsetLook);
  let tw = null;                // { t, dur, name, key } (진행 중 시간대/노을빛 트윈)
  let curSeason = 'summer';
  let autumn01 = 0;             // 가을 능선 세기 0..1 (계절 트윈)
  let autumnGoal = 0;
  let winter01 = 0;
  let winterGoal = 0;

  // cur 상태를 씬에 적용한다(트윈 매 프레임·정착·스냅 공통).
  function applyCur() {
    sun.position.copy(cur.sunDir).multiplyScalar(64);
    sun.color.copy(cur.sunColor); sun.intensity = cur.sunInt;
    hemi.color.copy(cur.hemiSky); hemi.groundColor.copy(cur.hemiGround); hemi.intensity = cur.hemiInt;
    if (!scene.fog) scene.fog = new THREE.Fog(0, 1, 100);
    scene.fog.color.copy(cur.fogColor); scene.fog.near = cur.fogNear; scene.fog.far = cur.fogFar;
    if (scene.background && scene.background.isColor) scene.background.copy(cur.fogColor);
    else scene.background = cur.fogColor.clone();
    renderer.toneMappingExposure = cur.exposure;
    applyRidge();
    // 등불(트윈 중 서서히). base=플리커 기준값, bulb 페이드.
    // #73: 야간 강도 대폭 하향(구 lantern*26 → *9.5). 26 은 저고도 처마 등롱이 기복 지형을
    //   레이킹해 마당 전체에 강한 방사형 빛줄기·그림자를 냈다(호롱불이 아니라 서치라이트). 9.5
    //   면 처마 소핏에 은은한 웜 풀만 남고 마당 레이킹이 사라진다. 석양(lantern 0.15)은 1.4 로
    //   밝은 역광 씬에선 거의 감지 안 됨(무회귀).
    const lanScale = Math.min(1, Math.max(0, cur.lantern / 0.15));  // 등불 최대(석양 0.15)에서 포화
    lanterns.forEach((L) => {
      L.base = cur.lantern * 9.5;
      L.light.intensity = L.base;
      L.bulb.visible = cur.lantern > 0.02;
    });
    glowMat.opacity = Math.min(1, Math.max(0, lanScale));
    lanternNight = cur.lantern > 0.02;
    // 달: moon 세기로 페이드 + 방향은 태양(달) 방향과 정합.
    const m = cur.moon;
    moonGroup.visible = m > 0.02;
    if (m > 0.02) {
      moonDisk.material.opacity = m;
      for (const corona of coronaLayers) {
        corona.material.opacity = corona.userData.baseOpacity * m;
      }
      moonOffset.copy(cur.sunDir).multiplyScalar(DEFAULT_MOON_OPTICS.distance);
      moonGroup.position.copy(moonOffset); // deterministic fallback before first camera render
      moonGroup.updateMatrixWorld(true);
    }
    // 돔 헤이즈는 시간대 base fog 로 먼저 맞춘다(모디파이어가 있으면 같은 프레임에 syncHaze 가 덮는다).
    cur.fogColor.getRGB(hazeSRGB, THREE.SRGBColorSpace);
    buildDomeFromStops(cur.stops);
  }

  // 능선 대기원근: cur(시간대 보간)의 능선색 × 가을 세기(autumn01) 합성. 매 프레임 저렴.
  function applyRidge() {
    const amt = cur.autumnAmt * autumn01;
    const winterAmt = cur.winterAmt * winter01;
    if (amt > 0.001) {
      const farAmt = Math.min(1, amt * 1.3);
      _rn.copy(cur.ridgeNear).lerp(AUTUMN_RIDGE.near, amt);
      _rf.copy(cur.ridgeFar).lerp(AUTUMN_RIDGE.far, farAmt);
      _rm.copy(cur.mist).lerp(AUTUMN_RIDGE.mist, amt * 0.7);
      if (winterAmt > 0.001) {
        _rn.lerp(WINTER_RIDGE.near, winterAmt);
        _rf.lerp(WINTER_RIDGE.far, Math.min(1, winterAmt * 1.18));
        _rm.lerp(WINTER_RIDGE.mist, winterAmt * 0.8);
      }
      mountains.setPalette(_rn, _rf, _rm, cur.mistOp);
    } else if (winterAmt > 0.001) {
      _rn.copy(cur.ridgeNear).lerp(WINTER_RIDGE.near, winterAmt);
      _rf.copy(cur.ridgeFar).lerp(WINTER_RIDGE.far, Math.min(1, winterAmt * 1.18));
      _rm.copy(cur.mist).lerp(WINTER_RIDGE.mist, winterAmt * 0.8);
      mountains.setPalette(_rn, _rf, _rm, cur.mistOp);
    } else {
      mountains.setPalette(cur.ridgeNear, cur.ridgeFar, cur.mist, cur.mistOp);
    }
  }

  // 시간대 적용. opts.immediate=true(shot·초기 로드) 면 즉시 스냅, 아니면 크로스페이드.
  //   같은 상태로의 재적용(reapplyEnvBase 등)은 스냅(멱등 복구) — ink/날씨가 만진 fog 를 되돌린다.
  function apply(name, opts = {}) {
    if (!(name in TIME_PRESETS)) name = 'day';
    const key = atmosphereProfileKey(name, sunsetLook);
    if (opts.immediate) {
      resolveInto(cur, name); curName = name; curKey = key; tw = null;
      applyCur();
      return;
    }
    if (tw) {
      if (key === tw.key) return;                   // 진행 중인 동일 프로필 목표 → 계속
      copyState(from, cur);                          // 현재 보간값을 새 from 으로(리타깃)
      resolveInto(to, name);
      tw = { t: 0, dur: DUR_TIME, name, key };
      return;
    }
    resolveInto(to, name);
    if (key === curKey) {                            // 정착 상태에서 같은 프로필 재적용 → 스냅 복구
      copyState(cur, to); applyCur(); return;
    }
    copyState(from, cur);
    tw = { t: 0, dur: DUR_TIME, name, key };
  }

  function setSunsetLook(name, opts = {}) {
    const next = normalizeSunsetLook(name);
    if (next === sunsetLook && curName !== 'sunset' && tw?.name !== 'sunset') return next;
    sunsetLook = next;
    if (curName === 'sunset' || tw?.name === 'sunset') apply('sunset', opts);
    return sunsetLook;
  }

  // 매 프레임: 시간대 트윈 + 가을 능선 트윈 진행. env.update 에서 호출.
  function update(dt) {
    let moved = false;
    if (tw) {
      tw.t += dt;
      const k = easeInOut(tw.t / tw.dur);
      lerpStateInto(cur, from, to, k);
      applyCur();
      moved = true;
      if (tw.t >= tw.dur) { copyState(cur, to); curName = tw.name; curKey = tw.key; tw = null; }
    }
    // 가을 능선 세기(지수 접근). 시간대 트윈이 없을 때도 능선만 갱신.
    if (Math.abs(autumn01 - autumnGoal) > 1e-4) {
      autumn01 += (autumnGoal - autumn01) * Math.min(1, dt * SEASON_RATE);
      if (Math.abs(autumn01 - autumnGoal) <= 1e-4) autumn01 = autumnGoal;
      if (!moved) applyRidge();
    }
    if (Math.abs(winter01 - winterGoal) > 1e-4) {
      winter01 += (winterGoal - winter01) * Math.min(1, dt * SEASON_RATE);
      if (Math.abs(winter01 - winterGoal) <= 1e-4) winter01 = winterGoal;
      if (!moved) applyRidge();
    }
  }

  // 처마 등롱 촛불 일렁임 — env.update 경유(매 프레임). 등불이 켜져 있을 때만 변조.
  function updateFlicker(dt) {
    if (!lanternNight) return;
    flickT += dt;
    lanterns.forEach((L, i) => {
      if (L.base > 0) L.light.intensity = L.base * candleFlicker(flickT, 5.5 + i * 1.9);
    });
  }

  // 계절 설정: 가을 능선 훅. immediate 면 즉시, 아니면 SEASON_RATE 로 크로스페이드(update 진행).
  function setSeason(name, opts = {}) {
    curSeason = name;
    autumnGoal = name === 'autumn' ? 1 : 0;
    winterGoal = name === 'winter' ? 1 : 0;
    if (opts.immediate) { autumn01 = autumnGoal; winter01 = winterGoal; applyRidge(); }
  }

  // env fog 합성용: 현재 시간대 base fog(트윈 보간값). 모디파이어 적용 전 원본.
  function getBaseFog() { return { color: cur.fogColor, near: cur.fogNear, far: cur.fogFar }; }
  function isTweening() { return !!tw; }

  function setEnabled(value) { skyRoot.visible = !!value; }

  function dispose() {
    scene.remove(skyRoot);
    disposeObjectTree(skyRoot);
    skyRoot.clear();
  }

  return {
    apply, setSunsetLook, setSeason, update, updateFlicker, getBaseFog, isTweening, syncHaze,
    setEnabled, dispose, root: skyRoot, dome, lanterns,
    get sunsetLook() { return sunsetLook; },
  };
}

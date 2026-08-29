import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { PRESETS, computeLayout } from './params.js';
import { buildBuilding } from './builder/index.js';
import { setupEnvironment } from './env/index.js';
import { setupInk, INK_PALETTE } from './render/ink.js';
import { setupWeather } from './env/weather.js';
import { setupNightGlow } from './env/night-glow.js';
import { setupCinematic } from './camera/cinematic.js';
import { setupAudio } from './audio/index.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { playAssembly } from './anim/assembly.js';
import { capturePostcard } from './share/postcard.js';
import { setupPost } from './env/post.js';
import { createDofController, DEFAULT_DOF_APERTURE } from './env/dof.js';
import { StableBokehPass } from './env/stable-bokeh-pass.js';
import { setupTreeOccluder } from './env/tree-occluder.js';
import {
  SEASON_IDS,
  WEATHER_IDS,
  normalizeEnvironmentState,
  pickEnvironmentScene,
  resolveEnvironmentChange,
} from './env/environment-state.js';

const q = new URLSearchParams(location.search);
const SHOT = q.get('shot') === '1';
const presetKey = q.get('preset') || 'korea';
const angle = q.get('angle') || 'three-quarter';
if (SHOT) document.body.classList.add('shot');

// 환경: 일반 모드 기본 ON, shot 모드 기본 OFF(기존 비교 스크린샷 유지).
// ?env=1 로 shot에서도 켤 수 있고 ?time= 으로 시간대 지정.
const envParam = q.get('env');
const envEnabled = envParam === null ? !SHOT : envParam === '1';
// 기본 시간대: 앱을 그냥 열면(비-shot) 골든아워 역광('sunset')이 기본 뷰 — 태양이 기본
// 카메라(three-quarter) 뒤에 놓여 건물 실루엣+금빛 림이 걸린다(플래그십 룩). shot 모드는
// 기존 비교 캡처 파이프라인이 day 기준이므로 유지한다(다른 하네스 영향 없음). ?time= 우선.
const timeOfDay = q.get('time') || (SHOT ? 'day' : 'sunset');

// 날씨: clear(기본) | rain | snow. ?weather= 또는 GUI에서 전환.
const weatherParam = q.get('weather');
const requestedWeather = WEATHER_IDS.includes(weatherParam) ? weatherParam : 'clear';

// 계절과 날씨는 하나의 호환 상태다. snow는 겨울로, 모순 URL은 결정적으로 정규화한다.
const seasonParam = q.get('season');
const requestedSeason = SEASON_IDS.includes(seasonParam) ? seasonParam : 'summer';
const initialEnvironment = normalizeEnvironmentState({ season: requestedSeason, weather: requestedWeather });
const seasonName = initialEnvironment.season;
const weatherName = initialEnvironment.weather;

// 렌더 모드: pbr(기본) | ink(수묵 NPR). ?mode=ink 또는 GUI에서 전환.
const modeState = { mode: q.get('mode') === 'ink' ? 'ink' : 'pbr' };
const PAPER = new THREE.Color(INK_PALETTE.paper);

// 피사계 심도(DoF): 일반 뷰 기본 ON, shot 모드 기본 OFF(비교 스크린샷은 선명해야 함).
// ?dof=1 강제 ON, ?dof=0 강제 OFF. pbr 경로에만 적용(ink 모드는 미적용).
const dofParam = q.get('dof');
const dofState = {
  enabled: dofParam === null ? !SHOT : dofParam === '1',
  aperture: DEFAULT_DOF_APERTURE, // 실측 균형값: 건물 몸체는 선명, 원경 산·최전경은 읽히게 풀림
};

// 플래그십 룩(bloom 헤이즈 + 골든아워 림 + 태양 글로우): 기본 ON(shot 포함).
// ?post=0 으로만 끈다. pbr 경로 전용(ink 모드는 자체 무드 유지 → bloom 미적용).
const postEnabled = q.get('post') !== '0';

// ---------- 렌더러/씬 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e0);
scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

// 빛: 오후 햇살 + 하늘 보조광
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.position.set(30, 42, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.bias = -0.0001;
sun.shadow.normalBias = 0.05;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9);
scene.add(hemi);

// R3 정정1(바닥 바운스/HDR 충만): 역광에서 그늘진 전면(창호·기둥·단청)이 흑색 실루엣으로
// 뭉개지지 않게, 태양 수평 반대편(안티솔라) 저각에서 미약한 웜 필로 그늘 수직면만 들어올린다.
// 저각이라 위를 보는 지면(마당)은 그레이징으로 거의 안 밝혀 "지면<건물" 원칙을 지킨다.
// castShadow=false — 태양(DirectionalLight)만 유일한 그림자 캐스터로 남겨 평행 그림자를 보존.
// 강도·색·방위는 시간대별로 applyFill 이 sun.position(=현재 태양 방향) 기준으로 구동한다.
const fill = new THREE.DirectionalLight(0xff9a5c, 0);
fill.castShadow = false;
scene.add(fill);
scene.add(fill.target);

// 마당
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(160, 48),
  new THREE.MeshStandardMaterial({ color: 0xb5a893, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- 건물 ----------
const P = { ...PRESETS[presetKey] };
let building = null;
let weatherRef = null; // setupWeather 결과 (아래에서 할당). 재생성 시 적설 패치 재적용.
let nightGlowRef = null; // setupNightGlow 결과 (아래 할당). 재생성 시 창호 실내광 재적용.
let audio = null;      // setupAudio 결과 (아래에서 할당). 재생성 시 풍경(風磬) 위치 갱신.
let gui = null;        // GUI 인스턴스(shot 모드는 null) — surprise 시 컨트롤 표시 갱신에 사용.
let currentPreset = presetKey; // 현재 활성 프리셋 키(포스트카드 파일명·surprise 로그).
// 조립 애니메이션 상태. frozen 은 정지 프레임(?assemble=1&t=) 검증용으로 자동 진행을 멈춘다.
let assembly = null;
let assemblyFrozen = false;
function regenerate() {
  // 진행 중 조립 애니메이션은 건물 교체 전에 원상복구·중단 (경합 방지).
  if (assembly) { assembly.skip(); assembly = null; assemblyFrozen = false; }
  if (building) {
    scene.remove(building);
    building.traverse((o) => { o.geometry?.dispose?.(); });
  }
  building = buildBuilding(P);
  scene.add(building);
  weatherRef?.onBuildingChanged(); // 새 건물 재질에 적설 패치·낙숫물 선 재적용
  nightGlowRef?.onBuildingChanged(); // 새 건물 재질·실내 조명에 야간 창호광 재적용
  audio?.setLayout(computeLayout(P)); // 건물 크기 바뀌면 처마 끝 풍경 위치 갱신
}
regenerate();

// 조립 애니메이션 시작(현재 건물 대상). duration 초 후 자동 원상복구.
function startAssembly(duration = 5) {
  if (assembly) assembly.skip();
  building.visible = true;
  assembly = playAssembly(building, {
    duration,
    onDone: () => { assembly = null; assemblyFrozen = false; },
  });
  assemblyFrozen = false;
}

// ---------- 카메라 ----------
// FOV 28: 망원 압축감. 35→28 로 좁힌 만큼 아래 spots.r 을 tan(35/2)/tan(28/2)≈1.26배
// 보정해 기존 프레이밍을 유지한다.
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// 처마 밑 서까래를 올려다볼 수 있게 지평선 아래로 살짝 기울이는 것 허용(≈+20°).
// 이전 π/2−0.02(88°)는 closeup 언더뷰 각(el=−12→polar 102°)을 지평선으로 클램프해
// ①처마 언더뷰 불가 ②그 그레이징 각에서 ㄱ자 접합부 하늘 슬리버 노출 문제를 냈다.
controls.maxPolarAngle = Math.PI / 2 + 0.36;

function setAngle(name) {
  const L = computeLayout(P);
  const maxDim = Math.max(L.W + 4, L.D + 4, L.totalH);
  const target = new THREE.Vector3(0, L.totalH * 0.42, 0);
  const spots = {
    'front':          { az: 0,   el: 7,  r: 2.9 },
    'three-quarter':  { az: 38,  el: 13, r: 3.0 },
    'side':           { az: 90,  el: 8,  r: 2.9 },
    'roof':           { az: 42,  el: 36, r: 2.9 },
    'closeup':        { az: 42,  el: -17, r: 0.76, ty: L.plateY + 1.4 },
  };
  const base = spots[name] || spots['three-quarter'];
  // ?az=/?el= 로 방위·고도를 덮어써 임의 시점 검증(예: 태양이 카메라 뒤로 가는 앵글에서
  // 역광 림이 소거되는지). 미지정이면 기존 프리셋 그대로.
  const azP = q.get('az'), elP = q.get('el');
  const s = { ...base, ...(azP !== null ? { az: +azP } : {}), ...(elP !== null ? { el: +elP } : {}) };
  if (s.ty !== undefined) target.y = s.ty;
  const az = (s.az * Math.PI) / 180, el = (s.el * Math.PI) / 180;
  const r = s.r * maxDim;
  camera.position.set(
    target.x + r * Math.cos(el) * Math.sin(az),
    target.y + r * Math.sin(el),
    target.z + r * Math.cos(el) * Math.cos(az)
  );
  controls.target.copy(target);
  controls.update();
}
setAngle(angle);

// ---------- 시네마틱 카메라 드라이브 ----------
// getLayout 로 넘겨 건물 재생성 후에도 최신 치수로 경로를 다시 만든다.
const cinematic = setupCinematic(camera, controls, {
  getLayout: () => computeLayout(P),
  domElement: renderer.domElement,
});

// ---------- 기본 카메라 자동 궤도 회전 ----------
// 사용자 스펙: "정지하지 않는 이상 아주 천천히 회전". OrbitControls.autoRotate 로 건물 중심
// (controls.target)을 느리게 공전한다. 조작(pointerdown/휠/터치)이 시작되면 즉시 멈추고,
// 유휴 ORBIT_IDLE_MS 후 속도를 0→목표로 이즈-인해 부드럽게 재개(갑자기 홱 돌지 않게).
// 실제 회전은 loop 에서 매 프레임 autoRotateSpeed 를 이즈해 세팅하고, autoRotate 적용은
// controls.update() 안에서 일어나므로 시네마틱 드라이브 중(=update 미호출)엔 자동으로 양보된다.
//  - ?shot=1 : 완전 비활성(모든 에이전트 캡처 재현성 필수). ?orbit=0 : 옵트아웃.
//  - ?drive= / ?assemble=1 : 카메라 하네스이므로 함께 비활성(정지프레임 검증 재현성).
const ORBIT = !SHOT && q.get('orbit') !== '0' && !q.get('drive') && q.get('assemble') !== '1';
const ORBIT_SPEED = 0.3;       // autoRotateSpeed 목표 → 약 60/0.3 ≈ 200초/회전(≈3.3분)
const ORBIT_IDLE_MS = 10000;   // 조작 종료 후 재개까지 유휴(8~12초 사이)
const ORBIT_EASE_UP = 2.6;     // 재개 이즈-인 시간(초): 0→목표(부드럽게 속도가 붙음)
const ORBIT_EASE_DOWN = 0.45;  // 정지 감쇠 시간(초): 목표→0(빠르게 멈춤)
let orbitReady = false;        // 히어로/시퀀스 종료 후 true(hero 없으면 아래 분기에서 즉시)
let orbitEased = 0;            // 현재 이즈된 autoRotateSpeed
let orbitResumeAt = 0;         // performance.now() 재개 예약(>now=대기, Infinity=조작 중, 0=허용)
if (ORBIT) {
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0;   // 실제 속도는 loop 가 이즈해서 매 프레임 세팅
  // OrbitControls 는 조작 시작에 'start', 종료에 'end' 이벤트를 쏜다(드래그·휠·터치 공통).
  controls.addEventListener('start', () => { orbitResumeAt = Infinity; orbitEased = 0; controls.autoRotateSpeed = 0; });
  controls.addEventListener('end', () => { orbitResumeAt = performance.now() + ORBIT_IDLE_MS; });
}

// ---------- 환경 (산수화 레이어) ----------
const env = setupEnvironment(scene, { sun, hemi, renderer, layout: computeLayout(P) });
const envState = { enabled: envEnabled, time: timeOfDay };
const seasonState = { name: seasonName };
env.setTime(timeOfDay);
// shot 모드는 프레임 예산이 짧아(3프레임) 계절 색을 즉시 세팅(잎 색·지면·파티클 초기 배치).
env.setSeason(seasonName, { immediate: SHOT });
env.setEnabled(envEnabled);
ground.visible = !envEnabled;

// ---------- 날씨 (눈·비) ----------
// scene 에 직접 붙는 파티클 + 건물 재질 traverse 패치(적설/젖음) + 대기 오버레이.
const weatherState = { name: weatherName };
const weather = setupWeather(scene, {
  layout: computeLayout(P),
  getBuilding: () => building,
  getGround: () => ground,
  // env 를 넘기면 날씨 대기 틴트가 env fog 모디파이어로 자동 등록돼 시간대 크로스페이드 중에도
  // 비/눈 fog 가 파티클과 동조해 서서히 물든다(태스크 #50, 팝 제거).
  env,
  sun,
});
weatherRef = weather;
// shot 모드는 프레임 예산이 짧아 적설 페이드가 다 오르기 전에 캡처되므로 즉시 적용.
weather.setWeather(weatherState.name, { immediate: SHOT });

// ---------- 전경 나무 오클루더 페이드 ----------
// 궤도 회전(및 수동 회전) 중 카메라와 건물 사이를 가로막는 근경 나무를 dithered 반투명 페이드해
// 시야를 틔운다. shot 모드는 재현성(다른 에이전트 캡처 베이스라인 불변) 위해 비활성. 나무는 env
// 그룹의 InstancedMesh('trees') — env 셋업 뒤 1회 등록(건물 재생성과 무관하게 유지). 피사체는
// 건물 중심(카메라 프리셋 target 과 동일).
// ?occ=0 으로 옵트아웃(오클루더 없는 A/B 비교·검증용). shot 은 항상 비활성.
let treeOcc = null;
if (!SHOT && q.get('occ') !== '0') {
  treeOcc = setupTreeOccluder({
    getSubject: () => { const L = computeLayout(P); return new THREE.Vector3(0, L.totalH * 0.42, 0); },
  });
  const treesGroup = scene.getObjectByName('trees');
  if (treesGroup) treeOcc.register(treesGroup, { canopyY: 4.5 });
}

// ---------- 야간 창호 실내광 ----------
// 밤에 한지 창이 호롱불 온기로 밝아진다(건물 재질 emissive + 방 1~2곳 소형 PointLight).
// env 와 독립이지만 env 가 켜지고 night 일 때만 발광하도록 enabled·time 을 전파한다.
nightGlowRef = setupNightGlow({ getBuilding: () => building });
nightGlowRef.setEnabled(envState.enabled);
nightGlowRef.setTime(envState.time);

// ---------- 사운드 (풍경·환경음·BGM) ----------
// camera 에 THREE.AudioListener 를 붙인다. 브라우저 autoplay 정책상 첫 사용자 제스처에서
// start()로 AudioContext.resume() 해야 소리가 난다. SHOT 모드는 오디오 그래프를 만들지 않는다.
if (!SHOT) {
  audio = setupAudio(camera, {
    layout: computeLayout(P),
    // Live getters (dog pattern) — never capture env.streamAnchor as a one-shot value.
    getStreamAnchor: () => env.streamAnchor,
    getDogAnchor: () => env.dogAnchor, // 라이브 참조(개가 걸어다님)
    getDogState: () => env.dogState,   // 'walking' | 'sitting'
  });
  audio.setTime(envState.time);
  audio.setWeather(weatherState.name);
  audio.setEnvActive(envState.enabled); // env OFF면 개울 물소리 정지
  addEventListener('pointerdown', () => audio.start(), { once: true });
}

// ---------- 수묵(ink) 렌더 파이프라인 ----------
// 컴포저는 처음 ink 모드로 들어갈 때 지연 생성(pbr 전용 스크린샷 경로에 부담 없음).
let ink = null;
function ensureInk() {
  if (!ink) {
    ink = setupInk(renderer, scene, camera);
    ink.setSize(innerWidth, innerHeight);
  }
  return ink;
}

// ---------- 피사계 심도(DoF) 컴포저 (pbr 전용, 지연 생성) ----------
// RenderPass → BokehPass → OutputPass. BokehPass 내부의 반해상도 광원 prefilter와
// source scatter까지 오프스크린(선형)에서 처리되고 마지막 OutputPass 가 캔버스에
// 렌더될 때만 ACES 톤매핑+sRGB 를 한 번 적용한다
// (renderer.render 직접 경로와 색 일치). focus 는 매 프레임 controls.target의 카메라축 깊이로 갱신.
let dof = null;
function ensureDof() {
  if (!dof) {
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bokeh = new StableBokehPass(scene, camera, {
      focus: 40, aperture: dofState.aperture, maxblur: 0.01,
    });
    composer.addPass(bokeh);
    composer.addPass(new OutputPass());
    composer.setSize(innerWidth, innerHeight); // EffectComposer 가 DPR 내부 반영
    dof = {
      composer,
      bokeh,
      controller: createDofController({ camera, pass: bokeh, aperture: dofState.aperture }),
    };
  }
  return dof;
}

// ---------- 플래그십 룩 컴포저 (pbr 전용, 지연 생성) ----------
// RenderPass → RimPass(골든아워 림) → BokehPass(DoF 흡수, opt-in)
//            → UnrealBloomPass(광원 헤이즈) → OutputPass. DoF·bloom·rim 은 선형 HDR 에서
// 처리되고 OutputPass 가 ACES+sRGB 를 한 번만 적용(이중 과노출 방지).
// post 가 켜지면 DoF 는 이 컴포저의 bokeh 로 처리되어 별도 dof 컴포저는 쓰지 않는다.
let post = null;
function ensurePost() {
  if (!post) {
    post = setupPost({ renderer, scene, camera });
    post.setSize(innerWidth, innerHeight);
    post.setTime(envState.time);          // 초기 시간대 튜닝·태양 글로우 배치
    // 태양 글로우는 하늘(env)이 있을 때만 노출. bloom·rim 은 env 무관하게 항상 동작.
    post.setEnabled(modeState.mode === 'pbr' && envState.enabled);
  }
  return post;
}

// 안티솔라 웜 필(그늘면 바운스) 시간대 프로필. int=강도, color=반사 색조. sunset 이 최대,
// dawn 은 순광(정면광)이라 소폭, day/night 는 0(불필요·무드 보존). 저각은 applyFill 이 고정.
// R4 색분리: 필 색이 순주황(0xff9a5c)이면 들어올린 그늘 전면까지 노래져 스플릿이 깨진다.
// 강도(0.95)는 유지하되 색을 채도 낮춘 살구빛(0xf2b28c)으로 — 그늘 수직면을 '중성 웜'으로만
// 리프트하고, 쿨 hemiSky 앰비언트와 섞여 전면이 과주황이 아닌 자연스런 살빛으로 앉는다.
const FILL_BY_TIME = {
  dawn:   { int: 0.35, color: 0xffc49e },
  day:    { int: 0.0,  color: 0xffffff },
  sunset: { int: 0.95, color: 0xf2b28c },
  night:  { int: 0.0,  color: 0x000000 },
};
const _fillDir = new THREE.Vector3();
// 안티솔라 웜 필도 시간대 크로스페이드(태스크 #50): 강도·색을 목표로 매 프레임 이즈하고,
// 위치는 현재(트윈 중인) 태양 방향을 따라간다. 첫 적용은 스냅(로드 시 페이드-인 방지).
let _fillTargetInt = 0;
const _fillTargetCol = new THREE.Color(0xffffff);
let _fillStarted = false;
const FILL_LERP = 3.0;   // ≈1.6s 이즈(sky 크로스페이드와 결이 맞게)
// 목표 갱신(refreshAppearance 에서 호출). 첫 호출은 스냅.
function applyFill() {
  const cfg = FILL_BY_TIME[envState.time] || FILL_BY_TIME.day;
  const on = envState.enabled && modeState.mode === 'pbr' && cfg.int > 0;
  _fillTargetInt = on ? cfg.int : 0;
  _fillTargetCol.setHex(on ? cfg.color : 0xffffff);
  if (!_fillStarted) { fill.intensity = _fillTargetInt; fill.color.copy(_fillTargetCol); }
}
// 매 프레임: 목표 강도·색으로 이즈 + 태양(트윈) 수평 반대편 저각(≈15°, tan≈0.27) 배치.
function stepFill(dt) {
  _fillStarted = true;
  const k = Math.min(1, dt * FILL_LERP);
  fill.intensity += (_fillTargetInt - fill.intensity) * k;
  fill.color.lerp(_fillTargetCol, k);
  const s = sun.position;
  const hmag = Math.hypot(s.x, s.z) || 1;
  _fillDir.set(-s.x, hmag * 0.27, -s.z).normalize().multiplyScalar(80);
  fill.position.copy(_fillDir);
  fill.target.position.set(0, 0, 0);
  fill.target.updateMatrixWorld();
}

// env(또는 폴백)가 scene.fog/background/exposure/조명에 반영한 "베이스 외형"을
// 다시 적용한다. ink 모드가 in-place로 바꿔 놓은 fog 색·배경을 pbr로 복귀시킬 때 쓴다.
function reapplyEnvBase() {
  if (envState.enabled) env.setTime(envState.time); // sky.apply → fog/bg/exposure/조명
  else env.setEnabled(false);                        // restoreFallback → 기본값
}

// 현재 모드에 맞는 외형 오버레이. reapplyEnvBase 직후에 호출한다.
//  - ink: 톤매핑 off, 씬 fog는 종이색으로 물들이되 거리(near/far)는 유지하고
//         그 거리를 먹 셰이더 fog uniform에 동기화(좌표계 일치 → 지평선 헛 먹선 방지).
//         하늘/배경은 종이색으로 수렴.
//  - pbr: ACES 톤매핑 복원. fog/bg/exposure는 reapplyEnvBase가 이미 정상화.
function refreshAppearance() {
  if (modeState.mode === 'ink') {
    renderer.toneMapping = THREE.NoToneMapping;
    ensureInk();
    if (scene.fog) {
      ink.inkPass.uniforms.fogNear.value = scene.fog.near;
      ink.inkPass.uniforms.fogFar.value = scene.fog.far;
      scene.fog.color.copy(PAPER);
    }
    scene.background = PAPER;
    post?.setEnabled(false); // 태양 글로우 스프라이트를 ink 렌더에서 숨김
  } else {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // 플래그십 룩: 현재 시간대 튜닝·태양 글로우 재적용(멱등). 태양 글로우는 env 켜짐일
    // 때만. 아직 미생성이면 ensurePost 가 최초 pbr 프레임에서 동일 초기화를 수행한다.
    if (postEnabled && post) { post.setTime(envState.time); post.setEnabled(envState.enabled); }
  }
  // 안티솔라 웜 필: 현재 시간대·모드·env 상태로 그늘면 바운스 재적용(ink/day/night/off 는 0).
  applyFill();
  // 날씨 대기 오버레이: env/ink 가 방금 세팅한 신선한 base fog/bg 위에 한 번 물든다(멱등).
  weatherRef?.applyAtmosphere({ mode: modeState.mode });
}

function applyMode(mode) {
  modeState.mode = mode;
  // ink 모드: env 트윈·fog 합성을 끈다(즉시 스냅으로 종이색 fog 를 침해하지 않게). pbr 복귀 시 재개.
  env.setImmediate(mode === 'ink');
  reapplyEnvBase();     // 베이스 fog/bg/exposure/조명 정상화 (ink가 mutate한 것 복구)
  refreshAppearance();  // 모드별 오버레이
}

applyMode(modeState.mode);

// ---------- URL 로 드라이브 지정 ----------
// ?drive=orbit          → 로드 즉시 재생
// ?drive=orbit&t=0.5    → 해당 지점 정지 프레임(스크린샷 검증용)
const driveParam = q.get('drive');
if (driveParam && cinematic.names.includes(driveParam)) {
  const tParam = q.get('t');
  if (tParam !== null) cinematic.setProgress(parseFloat(tParam) || 0, driveParam);
  else cinematic.play(driveParam);
}

// ?assemble=1        → 로드 직후 조립 애니메이션 재생
// ?assemble=1&t=0.5  → 해당 진행도 정지 프레임(검증용, 자동 진행 없음)
const assembleParam = q.get('assemble');
if (assembleParam === '1') {
  assembly = playAssembly(building, {
    duration: 5,
    onDone: () => { assembly = null; assemblyFrozen = false; },
  });
  const tA = q.get('t');
  if (tA !== null) { assembly.seek(parseFloat(tA) || 0); assemblyFrozen = true; }
}

// ---------- GUI ----------
if (!SHOT) {
  gui = new GUI({ title: 'joseon' });
  gui.add({ 'surprise me': () => surpriseMe() }, 'surprise me');
  const fBuild = gui.addFolder('Building');
  fBuild.add({ assemble: () => startAssembly(5) }, 'assemble');
  const rebuild = () => regenerate();
  // 프리셋마다 키 구성이 다름(giwa 는 frontBays 등이 없음) — 있는 키만 노출
  const addP = (folder, key, label, ...range) => {
    if (key in P) folder.add(P, key, ...range).name(label).onChange(rebuild);
  };
  const fPlan = gui.addFolder('Plan');
  addP(fPlan, 'frontBays', 'front bays', 3, 9, 2);
  addP(fPlan, 'sideBays', 'side bays', 3, 5, 2);
  addP(fPlan, 'columnHeight', 'column height', 2.6, 5.5, 0.1);
  const fRoof = gui.addFolder('Roof');
  addP(fRoof, 'roofPitch', 'pitch', 0.4, 0.95, 0.01);
  addP(fRoof, 'profileCurve', 'sag curve', 0, 1, 0.01);
  addP(fRoof, 'cornerLift', 'corner lift (angok)', 0, 1.6, 0.01);
  addP(fRoof, 'planCurve', 'plan curve (anheori)', 0, 1.2, 0.01);
  addP(fRoof, 'eaveOverhang', 'eave overhang', 1.0, 3.0, 0.05);
  addP(fRoof, 'doubleEave', 'double eave');
  const fBr = gui.addFolder('Brackets');
  addP(fBr, 'bracketTiers', 'tiers', 1, 4, 1);
  addP(fBr, 'interBrackets', 'between columns', 0, 3, 1);
  const fCam = gui.addFolder('Camera');
  for (const a of ['front', 'three-quarter', 'side', 'roof', 'closeup']) {
    fCam.add({ [a]: () => { cinematic.stop(); setAngle(a); } }, a);
  }
  const fCin = fCam.addFolder('Cinematic');
  const cinState = { drive: cinematic.names[0] };
  for (const name of cinematic.names) {
    fCin.add({ [name]: () => { cinState.drive = name; cinematic.play(name); } }, name);
  }
  fCin.add({ Stop: () => cinematic.stop() }, 'Stop');
  const recCtrl = fCin.add({
    rec: () => {
      recCtrl.name('recording…');
      cinematic.record(cinState.drive, () => recCtrl.name('Record clip'));
    },
  }, 'rec').name('Record clip');
  const fRender = gui.addFolder('Render');
  fRender.add(modeState, 'mode', ['pbr', 'ink']).name('render mode')
    .onChange((v) => applyMode(v));
  fRender.add(dofState, 'enabled').name('depth of field');
  fRender.add(dofState, 'aperture', 0, 0.0004, 0.00001).name('aperture')
    .onChange((v) => {
      dof?.controller.setAperture(v);
      post?.setDofAperture(v);
    });
  fRender.add({ postcard: () => makePostcard({ download: true }) }, 'postcard');
  const fEnv = gui.addFolder('Environment');
  fEnv.add(envState, 'enabled').name('enabled').onChange((v) => {
    envState.enabled = v;
    env.setEnabled(v); ground.visible = !v;
    nightGlowRef?.setEnabled(v); // env OFF면 창호 실내광도 원복
    refreshAppearance();   // ink 모드면 새 fog 거리/종이색을 다시 물린다
    audio?.setEnvActive(v); // env OFF면 개울 물소리 정지
  });
  fEnv.add(envState, 'time', ['dawn', 'day', 'sunset', 'night']).name('time of day')
    .onChange((v) => { env.setTime(v); nightGlowRef?.setTime(v); refreshAppearance(); audio?.setTime(v); });
  fEnv.add(seasonState, 'name', SEASON_IDS).name('season')
    .onChange((v) => {
      const next = resolveEnvironmentChange({ season: seasonState.name, weather: weatherState.name }, { season: v });
      seasonState.name = next.season; weatherState.name = next.weather;
      env.setSeason(next.season); weather.setWeather(next.weather);
      reapplyEnvBase(); refreshAppearance(); audio?.setWeather(next.weather);
      gui?.controllersRecursive().forEach((c) => c.updateDisplay());
    });
  fEnv.add(weatherState, 'name', WEATHER_IDS).name('weather')
    .onChange((v) => {
      const next = resolveEnvironmentChange({ season: seasonState.name, weather: weatherState.name }, { weather: v });
      seasonState.name = next.season; weatherState.name = next.weather;
      env.setSeason(next.season); weather.setWeather(next.weather);
      reapplyEnvBase();     // fog/bg 를 base 로 되돌린 뒤
      refreshAppearance();  // 모드 오버레이 + 날씨 대기 오버레이를 신선하게 재적용
      audio?.setWeather(next.weather); // 바람 세기·비 환경음 전환
      gui?.controllersRecursive().forEach((c) => c.updateDisplay());
    });
  const fSound = gui.addFolder('Sound');
  const soundState = { enabled: true, bgm: 1, ambience: 1 };
  fSound.add(soundState, 'enabled').name('enabled').onChange((v) => audio?.setEnabled(v));
  fSound.add(soundState, 'bgm', 0, 1.5, 0.01).name('bgm volume').onChange((v) => audio?.setBgmVolume(v));
  fSound.add(soundState, 'ambience', 0, 2, 0.01).name('ambience volume').onChange((v) => audio?.setAmbienceVolume(v));
}

// ---------- 렌더 한 프레임 (현재 모드) ----------
function renderFrame() {
  if (modeState.mode === 'ink') {
    ensureInk();
    ink.composer.render();
    return;
  }
  // 플래그십 룩(기본): bloom·rim·태양 글로우. DoF 는 이 컴포저의 bokeh 로 흡수.
  if (postEnabled) {
    const p = ensurePost();
    p.setDofAmount(dofState.enabled ? 1 : 0);
    if (dofState.enabled) p.setFocusPoint(controls.target);
    p.update();  // 화면상 태양 방향·역광 계수 갱신(카메라 이동 반영)
    p.composer.render();
    return;
  }
  // ?post=0 폴백: 기존 경로(선명 렌더 또는 DoF 전용 컴포저).
  if (dofState.enabled) {
    const d = ensureDof();
    d.controller.focusAt(controls.target);
    d.composer.render();
    return;
  }
  renderer.render(scene, camera);
}

function resizeAll() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (ink) ink.setSize(innerWidth, innerHeight);
  if (dof) dof.composer.setSize(innerWidth, innerHeight);
  if (post) post.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resizeAll);

// ---------- 포스트카드 ----------
// pixelRatio 2 로 승격(컴포저 크기 동기화) → 현재 모드로 렌더·캡처 → 낙관 합성 → 복구.
function makePostcard({ download = true } = {}) {
  const prev = renderer.getPixelRatio();
  const bump = prev < 2;
  if (bump) { renderer.setPixelRatio(2); resizeAll(); }
  const filename = `joseon-${currentPreset}-${modeState.mode}.png`;
  const url = capturePostcard(renderer, renderFrame, { title: 'joseon', filename, download });
  if (bump) { renderer.setPixelRatio(prev); resizeAll(); }
  renderFrame(); // 정상 비율로 화면 복구
  return url;
}
window.__postcard = () => makePostcard({ download: false });

// ---------- Surprise me (큐레이션 랜덤 + 미세 지터) ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function weightedPick(rng, pairs) {
  const tot = pairs.reduce((s, p) => s + p[1], 0);
  let r = rng() * tot;
  for (const [val, w] of pairs) { if ((r -= w) <= 0) return val; }
  return pairs[pairs.length - 1][0];
}
function surpriseMe() {
  const seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  const rng = mulberry32(seed);

  // 프리셋: choga 는 PRESETS 에 있을 때만.
  const presetPairs = [['korea', 3], ['temple', 2]];
  if (PRESETS.choga) presetPairs.push(['choga', 1.6]);
  const preset = weightedPick(rng, presetPairs);

  // Preserve the legacy parameter stream: environment now comes from an independent
  // curated fork, but its former three draws are still consumed before geometry jitter.
  weightedPick(rng, [['day', 4], ['sunset', 3], ['dawn', 2], ['night', 1.5]]);
  weightedPick(rng, [['autumn', 3], ['spring', 2.2], ['summer', 2]]);
  weightedPick(rng, [['clear', 4], ['snow', 2.2], ['rain', 1.8]]);
  const environment = pickEnvironmentScene(mulberry32((seed ^ 0xe1710f) >>> 0));
  const time = environment.ti;
  const season = environment.se;
  const weatherPick = environment.we;

  // 프리셋 적용 (P 내용 교체, 참조 유지).
  for (const k of Object.keys(P)) delete P[k];
  Object.assign(P, PRESETS[preset]);
  currentPreset = preset;

  // 파라미터 미세 지터 ±6% (GUI 범위 클램프 → 프리셋 정체성 유지).
  const jit = (k, lo, hi) => {
    if (typeof P[k] !== 'number') return;
    P[k] = Math.min(hi, Math.max(lo, P[k] * (1 + (rng() * 2 - 1) * 0.06)));
  };
  jit('columnHeight', 2.6, 5.5); jit('roofPitch', 0.4, 0.95); jit('profileCurve', 0, 1);
  jit('cornerLift', 0, 1.6); jit('planCurve', 0, 1.2); jit('eaveOverhang', 1.0, 3.0);
  jit('entasis', 0, 1);
  // frontBays 는 홀수 스텝 준수(±2, [3,9]).
  if (rng() < 0.4) P.frontBays = Math.min(9, Math.max(3, P.frontBays + (rng() < 0.5 ? -2 : 2)));

  // 환경/날씨/사운드 반영 (GUI onChange 와 동일 경로).
  envState.time = time; seasonState.name = season; weatherState.name = weatherPick;
  env.setTime(time); env.setSeason(season); weather.setWeather(weatherPick);
  nightGlowRef?.setTime(time); // 야간이면 창호 실내광
  reapplyEnvBase(); refreshAppearance();
  audio?.setTime(time); audio?.setWeather(weatherPick);

  regenerate();
  startAssembly(2.5); // 셔플이 곧 데모 — 짧은 조립 연출

  if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
  const cfg = { seed, preset, time, season, weather: weatherPick, frontBays: P.frontBays,
    roofPitch: +P.roofPitch.toFixed(3), eaveOverhang: +P.eaveOverhang.toFixed(2) };
  console.log('[surprise]', JSON.stringify(cfg));
  return cfg;
}
window.__surprise = () => surpriseMe();

// ---------- 히어로 오프닝 시퀀스 ----------
// SHOT / ?drive= / ?assemble= 지정 시 비활성(기존 파이프라인 불침해). ?hero=0 으로도 끔.
const heroEnabled = !SHOT && q.get('hero') !== '0' && !driveParam && assembleParam !== '1';
const heroEl = document.getElementById('hero');
if (!heroEnabled) {
  heroEl?.remove();
  orbitReady = true;                 // 히어로 없으면 로드 직후부터 자동 회전 허용
} else {
  let heroPhase = 'idle';   // idle → revealing → done
  let heroTimer = null;
  const REVEAL_ASSEMBLY_DELAY = 6600; // reveal(12s) 진행 t≈0.55 지점에서 조립 시작

  building.visible = false;           // 오프닝: 빈 터에서 시작
  cinematic.setProgress(0, 'reveal'); // 오버레이 뒤 첫 프레임을 reveal 시작 구도로
  audio?.setBgmVolume(0);             // BGM 은 입장 시 페이드인

  function handOff() {
    heroPhase = 'done';
    renderer.domElement.removeEventListener('pointerdown', heroInterrupt);
    renderer.domElement.removeEventListener('wheel', heroInterrupt);
    orbitReady = true;                                       // 자동 회전 인계
    if (ORBIT) orbitResumeAt = performance.now() + ORBIT_IDLE_MS; // 입장 직후 잠깐 정지 후 시작
  }
  function heroInterrupt() {
    if (heroPhase !== 'revealing') return;
    if (heroTimer) { clearTimeout(heroTimer); heroTimer = null; }
    building.visible = true;
    if (assembly) { assembly.skip(); assembly = null; assemblyFrozen = false; }
    handOff(); // cinematic 은 같은 제스처로 이미 stop → OrbitControls 인계
  }
  function heroBgmFadeIn() {
    if (!audio) return;
    const t0 = performance.now(), dur = 2500;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      audio.setBgmVolume(k);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function enterFromHero() {
    if (heroPhase !== 'idle') return;
    heroPhase = 'revealing';
    heroEl.classList.add('leaving');
    setTimeout(() => heroEl.remove(), 900);
    audio?.start();
    heroBgmFadeIn();
    cinematic.play('reveal');
    renderer.domElement.addEventListener('pointerdown', heroInterrupt, { passive: true });
    renderer.domElement.addEventListener('wheel', heroInterrupt, { passive: true });
    // reveal 종반에 조립 시작
    heroTimer = setTimeout(() => {
      heroTimer = null;
      building.visible = true;
      startAssembly(5);
    }, REVEAL_ASSEMBLY_DELAY);
    // reveal 자연 종료 감시 → 컨트롤 인계
    const iv = setInterval(() => {
      if (heroPhase !== 'revealing') { clearInterval(iv); return; }
      if (!cinematic.isActive()) { clearInterval(iv); building.visible = true; handOff(); }
    }, 200);
  }
  heroEl.addEventListener('click', enterFromHero);
}

// ---------- 루프 ----------
let frames = 0;
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  cinematic.update(dt);                          // 드라이브 재생 중 카메라를 직접 몰기
  if (assembly && !assemblyFrozen && assembly.update(dt)) assembly = null; // 조립 진행
  if (ORBIT) {
    // 자동 회전 속도 이즈: 시퀀스(조립·시네마틱) 중이거나 조작 유휴 대기 중이면 목표 0, 아니면
    // ORBIT_SPEED 로 서서히 붙는다. autoRotate 적용은 controls.update() 안에서.
    const active = orbitReady && !assembly && !cinematic.isActive();
    const goal = (active && performance.now() >= orbitResumeAt) ? ORBIT_SPEED : 0;
    const rate = (goal > orbitEased ? ORBIT_SPEED / ORBIT_EASE_UP : ORBIT_SPEED / ORBIT_EASE_DOWN) * dt;
    orbitEased = goal > orbitEased ? Math.min(goal, orbitEased + rate) : Math.max(goal, orbitEased - rate);
    controls.autoRotateSpeed = orbitEased;
  }
  if (!cinematic.isActive()) controls.update();  // 드라이브/정지프레임 중엔 OrbitControls 양보
  treeOcc?.update(camera, dt);                   // 전경 나무 오클루더 페이드(shot 모드는 null)
  weather.update(dt);
  if (envState.enabled) env.update(dt);          // 계절 색 보간·낙엽 파티클(시네마틱 중에도 흩날림)
  if (modeState.mode === 'pbr') stepFill(dt);    // 안티솔라 웜 필 시간대 크로스페이드(태양 트윈 추종)
  nightGlowRef?.update(dt);                       // 야간 창호·실내 등불 촛불 일렁임(내부에서 night 게이트)
  audio?.update(dt);                             // 시네마틱 드라이브 중에도 무조건(환경음·BGM·풍경)
  renderFrame();
  frames++;
  if (frames === 3) window.__SHOT_READY = true;  // 스크린샷 대기 신호
});

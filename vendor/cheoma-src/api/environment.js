// 환경·후처리 공개 API. browser/WebGL runtime용이다.
export { setupEnvironment, createFocusRing, setupGrass } from '../env/index.js';
export { setupPost } from '../env/post.js';
// 기하 에지 MSAA 샘플 프로파일. 소비자(앱)가 디바이스 등급으로 골라 setupPost 에 넘긴다.
export {
  MSAA_SAMPLES_COMPACT,
  MSAA_SAMPLES_DESKTOP,
  resolveMsaaSamples,
} from '../env/msaa-render-pass.js';
export { createDofController, DEFAULT_DOF_APERTURE, focusDepthForPoint } from '../env/dof.js';
export { setupWeather } from '../env/weather.js';
export {
  patchSnowMaterial,
  snowProfileForObject,
  SNOW_ACCUMULATE_SECONDS,
  SNOW_AMOUNT_MAX,
  SNOW_MELT_SECONDS,
} from '../env/snow-material.js';
export { setupNightGlow } from '../env/night-glow.js';
export { setupInk, INK_PALETTE } from '../render/ink.js';
export {
  DEFAULT_SUNSET_LOOK,
  SUNSET_LOOK_IDS,
  SUNSET_LOOKS,
  TIME_PRESETS,
  atmosphereProfileKey,
  normalizeSunsetLook,
  resolveAtmosphereProfile,
  resolvePostProfile,
} from '../env/atmosphere-profiles.js';
export {
  DEFAULT_MOON_OPTICS,
  MOON_ANGULAR_DIAMETER_DEG,
  MOON_BLOOM_KNEE,
  MOON_CORONA_DIAMETER_DEG,
  MOON_CORONA_ENERGY,
  MOON_CORONA_PROFILE,
  MOON_DISTANCE,
  MOON_RENDER_ORDER,
  planeSpanForAngularDiameter,
  projectedAngularDiameterPixels,
  resolveMoonBloomGate,
  resolveMoonCloudComposite,
  resolveMoonOptics,
  sampleMoonCoronaProfile,
  sphereRadiusForAngularDiameter,
} from './moon-optics.js';
export { makeWorldEdge } from '../core/math/world-edge.js';
export {
  ENVIRONMENT_SCENES,
  SEASON_IDS,
  WEATHER_IDS,
  environmentSceneKey,
  normalizeEnvironmentState,
  pickEnvironmentScene,
  resolveEnvironmentChange,
  weatherOkForSeason,
} from '../env/environment-state.js';

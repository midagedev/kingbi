// THREE/DOM-free precipitation state for workers, deterministic tests, and
// external simulations that do not need a renderer.
export {
  RAIN_PARTICLE_COUNT,
  SNOW_PARTICLE_COUNT,
  WEATHER_PARTICLE_SEED,
  advanceRainPrecipitation,
  advanceSnowPrecipitation,
  createRainPrecipitationState,
  createSnowPrecipitationState,
  setPrecipitationBounds,
} from '../env/weather-particle-state.js';

// #215 near-focus eave drip plan (renderer-free anchors + intermittent cycle).
export {
  EAVE_DRIP_ACTIVE_FRAC,
  EAVE_DRIP_SPACING,
  EAVE_RAIN_SEED,
  eaveDripActive,
  eaveDripCycle,
  planEaveAnchors,
} from '../env/eave-rain-plan.js';

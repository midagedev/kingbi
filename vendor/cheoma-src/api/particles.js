// Reusable world-space particle façade. Simulation state stays renderer-agnostic;
// representation builders consume the state arrays without copying them.
export {
  RAIN_PARTICLE_COUNT,
  SNOW_PARTICLE_COUNT,
  WEATHER_PARTICLE_SEED,
  advanceRainPrecipitation,
  advanceSnowPrecipitation,
  createRainPrecipitationState,
  createSnowPrecipitationState,
  setPrecipitationBounds,
  EAVE_DRIP_ACTIVE_FRAC,
  EAVE_DRIP_SPACING,
  EAVE_RAIN_SEED,
  eaveDripActive,
  eaveDripCycle,
  planEaveAnchors,
} from './particle-state.js';
export {
  createPhysicalRainRepresentation,
  createPhysicalSnowRepresentation,
} from '../env/weather-physical-geometry.js';
export { createEaveRain } from '../env/eave-rain.js';
export {
  createLeafSaddleGeometry,
  createMoteWorldRepresentation,
  createPetalWorldRepresentation,
} from '../env/detail-particle-geometry.js';
export { createPetalField, petalDetailWeight } from '../env/petals.js';
export { setupMotes } from '../env/motes.js';

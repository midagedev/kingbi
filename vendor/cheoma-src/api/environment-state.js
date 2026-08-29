// Narrow renderer-free environment state contract for URL codecs, workers, and
// fast Node checks.
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

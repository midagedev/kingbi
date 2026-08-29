export const SEASON_IDS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const WEATHER_IDS = Object.freeze(['clear', 'rain', 'snow']);

const WEATHER_BY_SEASON = Object.freeze({
  spring: Object.freeze(['clear', 'rain']),
  summer: Object.freeze(['clear', 'rain']),
  autumn: Object.freeze(['clear', 'rain']),
  winter: Object.freeze(['clear', 'snow']),
});
const WEATHER_HOME = Object.freeze({ rain: 'spring', snow: 'winter' });

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const seasonId = (value) => SEASON_IDS.includes(value) ? value : 'summer';
const weatherId = (value) => WEATHER_IDS.includes(value) ? value : 'clear';

export function weatherOkForSeason(weather, season) {
  if (!SEASON_IDS.includes(season) || !WEATHER_IDS.includes(weather)) return false;
  return WEATHER_BY_SEASON[season].includes(weather);
}

// Coherence is directional. Changing a season preserves compatible weather and
// otherwise clears it; changing weather preserves the season when possible, while
// snow moves to winter and winter rain moves to the photogenic spring-rain state.
export function resolveEnvironmentChange(current = {}, change = {}) {
  let season = seasonId(hasOwn(change, 'season') ? change.season : current.season);
  let weather = weatherId(hasOwn(change, 'weather') ? change.weather : current.weather);
  if (weatherOkForSeason(weather, season)) return { season, weather };

  if (hasOwn(change, 'weather')) season = WEATHER_HOME[weather] || season;
  else weather = 'clear';
  return weatherOkForSeason(weather, season) ? { season, weather } : { season, weather: 'clear' };
}

export function normalizeEnvironmentState(value = {}) {
  return resolveEnvironmentChange({ season: value.season, weather: value.weather }, {
    season: value.season,
    weather: value.weather,
  });
}

// Curated complete scenes are shared by deterministic seeds, the UI reroll and
// verification. Every row obeys the compatibility matrix above.
export const ENVIRONMENT_SCENES = Object.freeze([
  { ti: 'sunset', su: 'gold',    se: 'autumn', we: 'clear', k: 10 },
  { ti: 'sunset', su: 'crimson', se: 'autumn', we: 'clear', k: 7 },
  { ti: 'sunset', su: 'violet',  se: 'autumn', we: 'clear', k: 5 },
  { ti: 'sunset', su: 'gold',    se: 'summer', we: 'clear', k: 5 },
  { ti: 'sunset', su: 'crimson', se: 'summer', we: 'clear', k: 5 },
  { ti: 'sunset', su: 'violet',  se: 'spring', we: 'clear', k: 5 },
  { ti: 'sunset', su: 'crimson', se: 'autumn', we: 'rain',  k: 4 },
  { ti: 'sunset', su: 'gold',    se: 'winter', we: 'clear', k: 5 },
  { ti: 'sunset', su: 'violet',  se: 'winter', we: 'snow',  k: 5 },
  { ti: 'night',  se: 'autumn', we: 'clear', k: 6 },
  { ti: 'night',  se: 'spring', we: 'clear', k: 5 },
  { ti: 'night',  se: 'summer', we: 'clear', k: 4 },
  { ti: 'night',  se: 'winter', we: 'snow',  k: 6 },
  { ti: 'night',  se: 'winter', we: 'clear', k: 3 },
  { ti: 'dawn',   se: 'autumn', we: 'clear', k: 5 },
  { ti: 'dawn',   se: 'spring', we: 'clear', k: 5 },
  { ti: 'dawn',   se: 'autumn', we: 'rain',  k: 3 },
  { ti: 'dawn',   se: 'winter', we: 'snow',  k: 5 },
  { ti: 'day',    se: 'autumn', we: 'clear', k: 5 },
  { ti: 'day',    se: 'spring', we: 'rain',  k: 6 },
  { ti: 'day',    se: 'spring', we: 'clear', k: 4 },
  { ti: 'day',    se: 'summer', we: 'rain',  k: 4 },
  { ti: 'day',    se: 'summer', we: 'clear', k: 2 },
  { ti: 'day',    se: 'winter', we: 'clear', k: 4 },
  { ti: 'day',    se: 'winter', we: 'snow',  k: 7 },
].map(Object.freeze));

export const environmentSceneKey = (scene) =>
  `${scene.ti}|${scene.ti === 'sunset' ? (scene.su || 'gold') : ''}|${scene.se}|${scene.we}`;

export function pickEnvironmentScene(rng = Math.random, current = null) {
  const currentKey = current ? environmentSceneKey(current) : '';
  const pool = ENVIRONMENT_SCENES.filter((scene) => environmentSceneKey(scene) !== currentKey);
  const total = pool.reduce((sum, scene) => sum + scene.k, 0);
  let roll = rng() * total;
  for (const scene of pool) {
    roll -= scene.k;
    if (roll <= 0) return scene;
  }
  return pool[pool.length - 1];
}

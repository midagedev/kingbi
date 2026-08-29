import { makeRng } from '../rng.js';

const TAU = Math.PI * 2;
const DEFAULT_HALF = 46;
const DEFAULT_BOTTOM = -1;

export const WEATHER_PARTICLE_SEED = 0x5e450;
export const SNOW_PARTICLE_COUNT = 3600;
export const RAIN_PARTICLE_COUNT = 2600;

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function wrap(value, half) {
  const span = half * 2;
  if (value > half) return value - span;
  if (value < -half) return value + span;
  return value;
}

// A deterministic respawn hash keeps the simulation reproducible without allocating
// a second RNG stream or reaching for global Math.random() after setup.
function respawnUnit(index, generation, salt) {
  let value = Math.imul((index + 1) ^ salt, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16) ^ generation, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function ownsState(kind, count, half, bottom, top, positions) {
  return {
    kind,
    count,
    half,
    bottom,
    top,
    height: top - bottom,
    positions,
    generations: new Uint32Array(count),
  };
}

export function setPrecipitationBounds(state, { bottom = state.bottom, top = state.top } = {}) {
  if (!Number.isFinite(bottom) || !Number.isFinite(top) || top <= bottom) return false;
  const previousBottom = state.bottom;
  const previousHeight = Math.max(1e-6, state.height);
  const nextHeight = top - bottom;
  for (let index = 0; index < state.count; index++) {
    const offset = index * 3 + 1;
    const ratio = Math.min(1, Math.max(0, (state.positions[offset] - previousBottom) / previousHeight));
    state.positions[offset] = bottom + ratio * nextHeight;
  }
  state.bottom = bottom;
  state.top = top;
  state.height = nextHeight;
  return true;
}

export function createSnowPrecipitationState({
  seed = WEATHER_PARTICLE_SEED ^ 0x1111,
  count = SNOW_PARTICLE_COUNT,
  half = DEFAULT_HALF,
  bottom = DEFAULT_BOTTOM,
  top = 54,
} = {}) {
  const rng = makeRng(seed);
  const positions = new Float32Array(count * 3);
  const state = ownsState('snow', count, half, bottom, top, positions);
  state.seed = seed >>> 0;
  state.baseX = new Float32Array(count);
  state.baseZ = new Float32Array(count);
  state.speeds = new Float32Array(count);
  state.phases = new Float32Array(count);
  state.sways = new Float32Array(count);
  state.sizes = new Float32Array(count);
  state.opacities = new Float32Array(count);

  for (let index = 0; index < count; index++) {
    const offset = index * 3;
    state.baseX[index] = (rng() * 2 - 1) * half;
    state.baseZ[index] = (rng() * 2 - 1) * half;
    positions[offset + 1] = bottom + rng() * state.height;
    state.speeds[index] = rng.range(2.4, 6);
    state.phases[index] = rng() * TAU;
    state.sways[index] = rng.range(0.3, 1.1);
    state.sizes[index] = rng.range(1.1, 2.7);
    state.opacities[index] = rng.range(0.45, 1);
    positions[offset] = state.baseX[index];
    positions[offset + 2] = state.baseZ[index];
  }
  return state;
}

export function createRainPrecipitationState({
  seed = WEATHER_PARTICLE_SEED ^ 0x2222,
  count = RAIN_PARTICLE_COUNT,
  half = DEFAULT_HALF,
  bottom = DEFAULT_BOTTOM,
  top = 54,
} = {}) {
  const rng = makeRng(seed);
  const positions = new Float32Array(count * 3);
  const state = ownsState('rain', count, half, bottom, top, positions);
  state.seed = seed >>> 0;
  state.speeds = new Float32Array(count);
  state.lengths = new Float32Array(count);
  state.opacities = new Float32Array(count);
  state.leanX = 0.14;
  state.leanZ = 0.05;

  for (let index = 0; index < count; index++) {
    const offset = index * 3;
    positions[offset] = (rng() * 2 - 1) * half;
    // Preserve the historical x,z,y,speed,length RNG consumption exactly.
    // Opacity derives from a hash, so visual metadata never moves the trajectory stream.
    positions[offset + 2] = (rng() * 2 - 1) * half;
    positions[offset + 1] = bottom + rng() * state.height;
    state.speeds[index] = rng.range(30, 46);
    state.lengths[index] = rng.range(1.4, 2.6);
    state.opacities[index] = 0.72 + respawnUnit(index, 0, 0xa53d) * 0.28;
  }
  return state;
}

function hitsRoof(x, y, z, colliders) {
  for (let index = 0; index < colliders.length; index++) {
    const box = colliders[index];
    if (
      x >= box.min.x && x <= box.max.x
      && z >= box.min.z && z <= box.max.z
      && y >= box.min.y && y <= box.max.y
    ) return true;
  }
  return false;
}

export function advanceSnowPrecipitation(state, {
  dt,
  time,
  wind,
  centerX = 0,
  centerZ = 0,
  roofColliders = [],
  collide = true,
  top = state.top,
} = {}) {
  const step = Math.max(0, finite(dt, 0));
  const now = finite(time, 0);
  const wx = finite(wind?.dirX, 0) * finite(wind?.speed, 0);
  const wz = finite(wind?.dirZ, 0) * finite(wind?.speed, 0);
  const windSpeed = Math.max(0, finite(wind?.speed, 0));
  const gust = Math.max(0, finite(wind?.gust, 0));
  const swirl = 1 + gust * 2.6;
  const fall = 0.85 + 0.15 * (1 - Math.min(1, windSpeed));
  const positions = state.positions;
  const half = state.half;

  for (let index = 0; index < state.count; index++) {
    const offset = index * 3;
    let y = positions[offset + 1] - state.speeds[index] * fall * step;
    const hit = collide && hitsRoof(
      positions[offset] + centerX,
      y,
      positions[offset + 2] + centerZ,
      roofColliders,
    );

    if (hit) {
      const generation = ++state.generations[index];
      y = top - respawnUnit(index, generation, 0x31f7) * 4;
      state.baseX[index] = (respawnUnit(index, generation, 0x8843) * 2 - 1) * half;
      state.baseZ[index] = (respawnUnit(index, generation, 0x19db) * 2 - 1) * half;
    } else if (y < state.bottom) {
      y += state.height;
    }

    state.baseX[index] = wrap(state.baseX[index] + wx * 7 * step, half);
    state.baseZ[index] = wrap(state.baseZ[index] + wz * 7 * step, half);
    positions[offset] = state.baseX[index]
      + Math.sin(now * 0.6 + state.phases[index]) * state.sways[index] * swirl
      + Math.sin(now * 1.9 + state.phases[index] * 2.1) * 0.6 * gust;
    positions[offset + 1] = y;
    positions[offset + 2] = state.baseZ[index]
      + Math.cos(now * 0.45 + state.phases[index]) * state.sways[index] * 0.6 * swirl;
  }
}

export function advanceRainPrecipitation(state, {
  dt,
  wind,
  centerX = 0,
  centerZ = 0,
  roofColliders = [],
  collide = true,
  top = state.top,
} = {}) {
  const step = Math.max(0, finite(dt, 0));
  const wx = finite(wind?.dirX, 0) * finite(wind?.speed, 0);
  const wz = finite(wind?.dirZ, 0) * finite(wind?.speed, 0);
  state.leanX = wx * 3.4 / 38;
  state.leanZ = wz * 3.4 / 38;
  const driftX = wx * 6.5;
  const driftZ = wz * 6.5;
  const positions = state.positions;
  const half = state.half;

  for (let index = 0; index < state.count; index++) {
    const offset = index * 3;
    let x = positions[offset] + driftX * step;
    let y = positions[offset + 1] - state.speeds[index] * step;
    let z = positions[offset + 2] + driftZ * step;
    const hit = collide && hitsRoof(x + centerX, y, z + centerZ, roofColliders);

    if (hit) {
      const generation = ++state.generations[index];
      y = top - respawnUnit(index, generation, 0x7723) * 4;
      x = (respawnUnit(index, generation, 0x91b5) * 2 - 1) * half;
      z = (respawnUnit(index, generation, 0x2eb7) * 2 - 1) * half;
    } else if (y < state.bottom) {
      y += state.height;
    }

    positions[offset] = wrap(x, half);
    positions[offset + 1] = y;
    positions[offset + 2] = wrap(z, half);
  }
}

export function precipitationStateBytes(state) {
  let bytes = 0;
  for (const value of Object.values(state)) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  return bytes;
}

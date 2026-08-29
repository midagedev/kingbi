const DEFAULTS = Object.freeze({
  enterSpeed: 18,
  exitSpeed: 7,
  settleHold: 0.12,
  settleDuration: 0.22,
  // Binary composer fill scale while the camera is not fully settled.
  // Continuous intermediate scales would reallocate every RT on every frame;
  // a two-level switch (stable=1 / else=movingFillScale) reallocates only on
  // mode boundaries and restores full pixel density once motion settles.
  // 0.65² ≈ 0.42 of full-DPR pixels (~20% fewer than 0.72²≈0.52). Settled
  // frames restore 1.0 so the flagship look is unchanged at rest.
  movingFillScale: 0.65,
});

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

function syncMotionBudget(state, config) {
  // Bokeh quality may ramp continuously during settle; binary budgets must not —
  // EffectComposer.setPixelRatio / MSAA setSamples reallocate render targets.
  // Non-stable (moving + settling hold/ramp) stays on the cheap side; only a
  // fully settled frame restores full fill, desktop MSAA, and the hover outline.
  const reduced = state.mode !== 'stable';
  state.fillScale = reduced ? config.movingFillScale : 1;
  state.motionBudget = reduced;
  return state;
}

/**
 * Frame-rate-independent quality state for an adaptive post effect.
 *
 * `motionPx` is the screen-space displacement accumulated over `dt`. The state
 * converts it to px/s before applying hysteresis, so the same camera path has
 * the same result at 60 Hz, 120 Hz, and across a bounded long frame. The object
 * is mutated and returned in place; live frames allocate nothing here.
 *
 * `quality` (0..1) drives the Bokeh gather only. `fillScale` is a binary
 * composer pixel-ratio multiplier (1 when stable, `movingFillScale` otherwise)
 * so camera orbits cut fill-rate without thrashing render targets.
 * `motionBudget` is true for any non-stable mode and drives secondary
 * motion-only pass cuts (outline off, focus MSAA held at aerial samples).
 */
export function createPostQualityState(options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!(config.enterSpeed > config.exitSpeed && config.exitSpeed >= 0)) {
    throw new RangeError('post quality requires enterSpeed > exitSpeed >= 0');
  }
  if (!(config.settleHold >= 0 && config.settleDuration > 0)) {
    throw new RangeError('post quality requires settleHold >= 0 and settleDuration > 0');
  }
  if (!(config.movingFillScale > 0 && config.movingFillScale <= 1)) {
    throw new RangeError('post quality requires 0 < movingFillScale <= 1');
  }

  const state = {
    mode: 'stable',
    quality: 1,
    fillScale: 1,
    motionBudget: false,
    speed: 0,
    quietTime: 0,
    settleTime: config.settleDuration,
    update(dt, motionPx = 0) {
      if (!(dt > 0) || !Number.isFinite(dt)) return state;
      const displacement = Number.isFinite(motionPx) ? Math.max(0, motionPx) : 0;
      state.speed = displacement / dt;

      if (state.speed >= config.enterSpeed) {
        state.mode = 'moving';
        state.quality = 0;
        state.quietTime = 0;
        state.settleTime = 0;
        return syncMotionBudget(state, config);
      }

      if (state.mode === 'stable') return state;

      if (state.speed > config.exitSpeed) {
        state.mode = 'moving';
        state.quality = 0;
        state.quietTime = 0;
        state.settleTime = 0;
        return syncMotionBudget(state, config);
      }

      if (state.mode === 'moving') {
        const beforeHold = state.quietTime;
        state.quietTime = Math.min(config.settleHold, beforeHold + dt);
        if (state.quietTime + 1e-12 < config.settleHold) return syncMotionBudget(state, config);
        state.mode = 'settling';
        state.settleTime = Math.max(0, dt - (config.settleHold - beforeHold));
      } else {
        state.settleTime += dt;
      }

      if (state.settleTime + 1e-12 >= config.settleDuration) {
        state.mode = 'stable';
        state.quality = 1;
        state.settleTime = config.settleDuration;
        return syncMotionBudget(state, config);
      }

      state.quality = smoothstep(state.settleTime / config.settleDuration);
      return syncMotionBudget(state, config);
    },
    reset() {
      state.mode = 'stable';
      state.quality = 1;
      state.fillScale = 1;
      state.motionBudget = false;
      state.speed = 0;
      state.quietTime = 0;
      state.settleTime = config.settleDuration;
      return state;
    },
  };
  return state;
}

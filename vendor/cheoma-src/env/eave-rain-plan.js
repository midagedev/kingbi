// THREE/DOM-free eave-drip plan (#215).
// Layout → deterministic eave-line anchors for near-focus rain only.
// Renderer (eave-rain.js) consumes these records; pure gates can assert them without WebGL.

import { makeRng } from '../rng.js';

export const EAVE_RAIN_SEED = 0x5e450 ^ 0x3333;
export const EAVE_DRIP_SPACING = 1.25;
// Intermittent drip: active for this fraction of each cycle (rest = bead forming).
export const EAVE_DRIP_ACTIVE_FRAC = 0.55;

/**
 * Deterministic eave-perimeter anchors in subject-local space.
 * Front/back eaves scan x; left/right eaves scan z (corners not double-counted).
 */
export function planEaveAnchors(layout = {}, {
  seed = EAVE_RAIN_SEED,
  spacing = EAVE_DRIP_SPACING,
} = {}) {
  const rng = makeRng(seed >>> 0);
  const xE = Number.isFinite(layout.xEave) ? layout.xEave : 9;
  const zE = Number.isFinite(layout.zEave) ? layout.zEave : 6;
  const topY = Number.isFinite(layout.eaveEdgeY) ? layout.eaveEdgeY : 6.5;
  const botY = 0;
  const span = Math.max(0.6, spacing);

  const raw = [];
  for (let s = -1; s <= 1; s += 2) {
    for (let px = -xE; px <= xE + 1e-6; px += span) raw.push([px, s * zE]);
  }
  for (let s = -1; s <= 1; s += 2) {
    for (let pz = -zE + span; pz <= zE - span + 1e-6; pz += span) raw.push([s * xE, pz]);
  }

  const anchors = raw.map(([lx, lz]) => {
    const ax = lx + rng.range(-0.12, 0.12);
    const az = lz + rng.range(-0.12, 0.12);
    const phase = rng();
    const period = rng.range(1.6, 3.4);
    const speed = rng.range(9, 16);
    const length = rng.range(0.32, 0.62);
    const y0 = botY + rng() * Math.max(0.2, topY - botY);
    return {
      ax, az, topY, botY,
      phase, period, speed, length, y0,
      // Splash sits on the ground under the eave drip line (same xz, small jitter).
      splashX: ax + rng.range(-0.08, 0.08),
      splashZ: az + rng.range(-0.08, 0.08),
      splashPhase: rng(),
      splashPeriod: rng.range(0.45, 0.95),
      splashScale: rng.range(0.22, 0.42),
    };
  });

  return Object.freeze({
    count: anchors.length,
    xEave: xE,
    zEave: zE,
    topY,
    botY,
    spacing: span,
    anchors: Object.freeze(anchors.map((a) => Object.freeze({ ...a }))),
  });
}

/** Cycle position in [0,1) for intermittent drip visibility. */
export function eaveDripCycle(time, period, phase) {
  const p = Math.max(1e-4, period);
  const cyc = ((time / p + phase) % 1 + 1) % 1;
  return cyc;
}

export function eaveDripActive(time, period, phase, activeFrac = EAVE_DRIP_ACTIVE_FRAC) {
  return eaveDripCycle(time, period, phase) <= activeFrac;
}

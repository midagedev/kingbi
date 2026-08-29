// Deterministic, renderer-free camera choreography for an architectural reveal.
//
// The core owns only numbers and time. A framework adapter applies each sampled
// frame to its camera/controls, which keeps input handoff and lifecycle out of this
// reusable path. Both profiles are endpoint exact with zero endpoint velocity:
//   arrival — a two-beat establishing arc then telephoto push-in into the close view.
//   rebuild — a restrained breathing arc from the live frame to the new framing.

// No global RNG is consumed. `seed` only chooses the side of the orbit through a
// stable integer mix, so village generation remains byte-identical.

const DEG = Math.PI / 180;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smootherstep = (value) => {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// Arrival two-beat sampling (#254):
//   beat 1 — orbit + target (full-time smootherstep) hold the wide lens longer
//   beat 2 — FOV / dolly radius accelerate after ARRIVAL_ZOOM_START so the
//            telephoto climax lands with the roof assembly, not a long static hold.
// Zoom weight is monotone and end-flat (smootherstep of a clamped ramp).
export const ARRIVAL_ZOOM_START = 0.22;

function arrivalZoomWeight(t) {
  const u = clamp01(t);
  if (u <= ARRIVAL_ZOOM_START) return 0;
  return smootherstep((u - ARRIVAL_ZOOM_START) / (1 - ARRIVAL_ZOOM_START));
}

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const point = (value = {}) => ({
  x: finite(value.x),
  y: finite(value.y),
  z: finite(value.z),
});
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const lerp = (a, b, t) => a + (b - a) * t;
const lerpPoint = (a, b, t) => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

function mixedSeed(seed) {
  let value = finite(seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function shortestAngle(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function polarOffset(offset) {
  return {
    angle: Math.atan2(offset.x, offset.z),
    radius: Math.max(1e-6, Math.hypot(offset.x, offset.z)),
    y: offset.y,
  };
}

function frame(value = {}) {
  return Object.freeze({
    position: Object.freeze(point(value.position)),
    target: Object.freeze(point(value.target)),
    fov: finite(value.fov, 28),
    referenceFov: finite(value.referenceFov, finite(value.fov, 28)),
    composition: clamp01(finite(value.composition)),
  });
}

function profileFor(kind, motion, subjectSize) {
  const size = Math.max(4, finite(subjectSize, 12));
  if (motion === 'reduced') {
    return { duration: 0, sweep: 0, radialBreath: 0, verticalBreath: 0, startScale: 1, startRise: 0 };
  }
  const compact = motion === 'compact';
  if (kind === 'arrival') {
    return {
      // Default product path overrides duration from assembly timing; these are
      // fallbacks for pure gates and non-hero callers.
      duration: compact ? 4.6 : 6.4,
      // Slightly wider establishing sweep on desktop; compact stays restrained.
      sweep: (compact ? 32 : 90) * DEG,
      radialBreath: 0,
      verticalBreath: 0,
      // The establishing frame is authored as a *screen* width, not a world distance. Scaling the
      // destination radius up is wrong for a lens-compensated destination: the hero landing already
      // stands ~5.6 subject widths out (7° in a 21° reference frame), so a 1.62× radius put the
      // camera 262m from a 30m compound — past the entry veil's own far plane, which is keyed to the
      // site radius instead. The subject rendered 100% fog for the first five seconds and the whole
      // assembly played inside an opaque wash (docs/look-audit-2026-07.md R6). Establishing slightly
      // inside the landing radius and low keeps the camera in the clear band while the 4.6× zoom
      // still carries the reveal: the subject grows ~3× on screen across the arc, which is the claim
      // the gates assert.
      startScale: compact ? 0.80 : 0.68,
      // Low, so the establishing frame reads as layered architecture (near eaves, receding roof
      // ranks, haze) rather than a plan view of a diorama. Capped by the destination so a landing
      // that is already lower than this never gets raised.
      establishingElevation: (compact ? 12 : 9) * DEG,
      startRise: Math.min(compact ? 2.8 : 4.4, Math.max(compact ? 1.4 : 2.6, size * (compact ? 0.12 : 0.15))),
    };
  }
  return {
    duration: compact ? 2.35 : 3.15,
    sweep: (compact ? 6 : 13) * DEG,
    radialBreath: Math.min(compact ? 0.8 : 1.8, size * (compact ? 0.045 : 0.085)),
    verticalBreath: Math.min(compact ? 0.35 : 0.85, size * (compact ? 0.025 : 0.05)),
    startScale: 1,
    startRise: 0,
  };
}

/**
 * Create an immutable reveal descriptor.
 *
 * `from` is the exact currently presented camera frame. `to` is the authored
 * destination. Arrival replaces only its starting position/lens with an
 * establishing view; rebuild preserves both supplied endpoints exactly.
 */
export function createArchitecturalReveal({
  kind = 'rebuild',
  from,
  to,
  seed = 0,
  subjectSize = 12,
  motion = 'full',
  duration,
} = {}) {
  if (kind !== 'arrival' && kind !== 'rebuild') {
    throw new Error(`Unknown architectural reveal kind: ${kind}`);
  }
  if (!from || !to) throw new TypeError('Architectural reveal requires from and to frames');

  const destination = frame(to);
  const source = frame(from);
  const profile = profileFor(kind, motion, subjectSize);
  const side = (mixedSeed(seed) & 1) === 0 ? -1 : 1;
  const endOffset = polarOffset(sub(destination.position, destination.target));
  let start = source;

  if (kind === 'arrival' && motion !== 'reduced') {
    const startAngle = endOffset.angle + profile.sweep * side;
    const startRadius = endOffset.radius * profile.startScale;
    const endElevation = Math.atan2(endOffset.y, endOffset.radius);
    const startElevation = Math.min(profile.establishingElevation, endElevation);
    const startTarget = {
      ...destination.target,
      y: destination.target.y + Math.min(2.4, Math.max(0.7, finite(subjectSize, 12) * 0.08)),
    };
    start = frame({
      position: add(startTarget, {
        x: Math.sin(startAngle) * startRadius,
        y: startRadius * Math.tan(startElevation) + profile.startRise,
        z: Math.cos(startAngle) * startRadius,
      }),
      target: startTarget,
      // Wider establishing lens for beat-1 atmosphere; still inside the product
      // clear band (startScale < 1). Compact stays modest for small screens.
      fov: Math.max(destination.fov + (motion === 'compact' ? 10 : 18), motion === 'compact' ? 30 : 36),
      referenceFov: Math.max(
        destination.referenceFov + (motion === 'compact' ? 10 : 18),
        motion === 'compact' ? 30 : 36,
      ),
      composition: Math.min(destination.composition, motion === 'compact' ? 0.35 : 0.12),
    });
  }

  // Reduced motion is an exact destination cut. It intentionally ignores an
  // arbitrary current frame so assistive preferences never inherit a long dolly.
  if (motion === 'reduced') start = destination;

  return Object.freeze({
    kind,
    motion,
    seed: finite(seed) >>> 0,
    duration: motion === 'reduced'
      ? 0
      : Math.max(0, Number.isFinite(duration) ? duration : profile.duration),
    side,
    start,
    end: destination,
    sweep: profile.sweep * side,
    radialBreath: profile.radialBreath,
    verticalBreath: profile.verticalBreath,
  });
}

/** Sample a reveal without mutating the descriptor or any scene state. */
export function sampleArchitecturalReveal(shot, progress) {
  if (!shot?.start || !shot?.end) throw new TypeError('Invalid architectural reveal descriptor');
  const t = clamp01(progress);
  const arrival = shot.kind === 'arrival';
  // Orbit/target always use full-time smootherstep (turn-rate contract).
  // Arrival FOV/dolly use a delayed zoom beat for the push-in climax.
  const orbitK = smootherstep(t);
  const zoomK = arrival ? arrivalZoomWeight(t) : orbitK;
  const target = lerpPoint(shot.start.target, shot.end.target, orbitK);
  const start = polarOffset(sub(shot.start.position, shot.start.target));
  const end = polarOffset(sub(shot.end.position, shot.end.target));
  const baseAngle = start.angle + shortestAngle(start.angle, end.angle) * orbitK;
  const endpointBump = Math.sin(Math.PI * t) ** 2; // value and first derivative are 0 at both ends
  const angle = baseAngle + (shot.kind === 'rebuild' ? shot.sweep * endpointBump : 0);
  // Radius and height follow the zoom beat on arrival so beat-1 holds the wide
  // layered frame while beat-2 pushes into the authored telephoto dolly.
  const radius = lerp(start.radius, end.radius, zoomK) + shot.radialBreath * endpointBump;
  const relativeY = lerp(start.y, end.y, zoomK) + shot.verticalBreath * endpointBump;

  return {
    progress: t,
    position: add(target, {
      x: Math.sin(angle) * radius,
      y: relativeY,
      z: Math.cos(angle) * radius,
    }),
    target,
    fov: lerp(shot.start.fov, shot.end.fov, zoomK),
    referenceFov: lerp(shot.start.referenceFov, shot.end.referenceFov, zoomK),
    composition: lerp(shot.start.composition, shot.end.composition, zoomK),
  };
}

/** A tiny pure clock used by both the live adapter and deterministic seek gates. */
export function createArchitecturalRevealTimeline(shot) {
  let elapsed = 0;
  let done = shot.duration <= 0;
  const progress = () => done ? 1 : clamp01(elapsed / shot.duration);
  return {
    advance(seconds) {
      if (!done) {
        elapsed = Math.min(shot.duration, elapsed + Math.max(0, finite(seconds)));
        done = elapsed >= shot.duration;
      }
      return sampleArchitecturalReveal(shot, progress());
    },
    seek(value) {
      const p = clamp01(value);
      elapsed = shot.duration * p;
      done = p >= 1 || shot.duration <= 0;
      return sampleArchitecturalReveal(shot, p);
    },
    sample: () => sampleArchitecturalReveal(shot, progress()),
    progress,
    isDone: () => done,
  };
}

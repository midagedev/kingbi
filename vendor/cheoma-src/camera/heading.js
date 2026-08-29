const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;
const OPPOSITE_EPSILON = 1e-6;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const moveToward = (value, target, amount) => (
  value < target ? Math.min(value + amount, target) : Math.max(value - amount, target)
);
const positiveFinite = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
};

// Signed shortest turn from `from` to `to`. Exactly opposite headings have two
// equally short answers, so the caller may pin a stable side instead of letting
// floating-point noise alternate between +PI and -PI.
export function shortestAngleDelta(from, to, preferredSign = 0) {
  let delta = ((to - from + Math.PI) % TAU + TAU) % TAU - Math.PI;
  if (Math.abs(Math.abs(delta) - Math.PI) <= OPPOSITE_EPSILON && preferredSign) {
    delta = Math.sign(preferredSign) * Math.PI;
  }
  return delta;
}

// Reusable, allocation-free angular motion. The braking-speed bound makes the
// controller decelerate before the target while maxAcceleration removes the
// one-frame angular-velocity jump produced by ordinary exponential lerp.
export function createHeadingController({
  angle = 0,
  maxSpeed = Math.PI,
  maxAcceleration = Math.PI * 4,
  maxStep = 0.1,
} = {}) {
  const speedLimit = positiveFinite(maxSpeed, 'maxSpeed');
  const accelerationLimit = positiveFinite(maxAcceleration, 'maxAcceleration');
  const stepLimit = positiveFinite(maxStep, 'maxStep');
  let current = Number.isFinite(angle) ? angle : 0;
  let velocity = 0;
  let turnSign = 1;

  function reset(nextAngle = current, nextVelocity = 0) {
    current = Number.isFinite(nextAngle) ? nextAngle : 0;
    velocity = clamp(Number.isFinite(nextVelocity) ? nextVelocity : 0, -speedLimit, speedLimit);
    if (Math.abs(velocity) > 1e-8) turnSign = Math.sign(velocity);
    return current;
  }

  function step(target, dt, preferredSign = 0) {
    const frameDt = clamp(Number.isFinite(dt) ? dt : 0, 0, stepLimit);
    if (frameDt === 0 || !Number.isFinite(target)) return current;

    const preference = preferredSign || Math.sign(velocity) || turnSign;
    const delta = shortestAngleDelta(current, target, preference);
    if (Math.abs(delta) <= 1e-8 && Math.abs(velocity) <= 1e-8) {
      current += delta;
      velocity = 0;
      return current;
    }

    const sign = Math.sign(delta) || preference || 1;
    turnSign = sign;
    const brakingSpeed = Math.sqrt(2 * accelerationLimit * Math.abs(delta));
    const desiredVelocity = sign * Math.min(speedLimit, brakingSpeed);
    velocity = moveToward(velocity, desiredVelocity, accelerationLimit * frameDt);

    current += velocity * frameDt;
    const remaining = shortestAngleDelta(current, target, turnSign);
    if (Math.abs(remaining) <= 1e-7 && Math.abs(velocity) <= accelerationLimit * frameDt) {
      current += remaining;
      velocity = 0;
    }
    return current;
  }

  return {
    reset,
    step,
    get angle() { return current; },
    get velocity() { return velocity; },
  };
}

function anglesOf(direction) {
  const x = direction?.x ?? 0;
  const y = direction?.y ?? 0;
  const z = direction?.z ?? 0;
  if (![x, y, z].every(Number.isFinite)) return null;
  const length = Math.hypot(x, y, z);
  if (length <= 1e-8) return null;
  return {
    yaw: Math.atan2(x / length, z / length),
    pitch: Math.asin(clamp(y / length, -1, 1)),
  };
}

// Three-independent 3D look controller for camera rigs and exported engines.
// The returned direction object is stable and reused on every step.
export function createDirectionController({
  direction = { x: 0, y: 0, z: -1 },
  maxYawSpeed = Math.PI,
  maxYawAcceleration = Math.PI * 4,
  maxPitchSpeed = Math.PI * 0.75,
  maxPitchAcceleration = Math.PI * 3,
  maxStep = 0.1,
} = {}) {
  const initial = anglesOf(direction) || { yaw: Math.PI, pitch: 0 };
  const yaw = createHeadingController({
    angle: initial.yaw,
    maxSpeed: maxYawSpeed,
    maxAcceleration: maxYawAcceleration,
    maxStep,
  });
  const pitch = createHeadingController({
    angle: initial.pitch,
    maxSpeed: maxPitchSpeed,
    maxAcceleration: maxPitchAcceleration,
    maxStep,
  });
  const value = { x: 0, y: 0, z: -1 };

  function writeDirection() {
    const p = clamp(pitch.angle, -HALF_PI, HALF_PI);
    const cosPitch = Math.cos(p);
    value.x = Math.sin(yaw.angle) * cosPitch;
    value.y = Math.sin(p);
    value.z = Math.cos(yaw.angle) * cosPitch;
    return value;
  }

  function reset(nextDirection = direction) {
    const next = anglesOf(nextDirection);
    if (!next) return value;
    yaw.reset(next.yaw);
    pitch.reset(next.pitch);
    return writeDirection();
  }

  function step(targetDirection, dt) {
    const target = anglesOf(targetDirection);
    if (!target) return value;
    yaw.step(target.yaw, dt);
    pitch.step(target.pitch, dt);
    return writeDirection();
  }

  reset(direction);
  return {
    reset,
    step,
    value,
    get angularSpeed() { return Math.hypot(yaw.velocity, pitch.velocity); },
    get yawSpeed() { return yaw.velocity; },
    get pitchSpeed() { return pitch.velocity; },
  };
}

// Renderer-free, deterministic motion contract for one primary entrance leaf.
// The opening plan owns geometry semantics; this module owns only a signed hinge
// angle and an interruptible critically damped progress state.

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function planDoorMotion(openingPlan, options = {}) {
  const pivot = openingPlan?.anchors?.pivot;
  if (!openingPlan?.primary || openingPlan.kind !== 'door' || !pivot) {
    throw new Error('Door motion requires one primary door opening with a pivot anchor');
  }
  // #150 B: only a primary door with lawful hinge motion is product-interactive.
  // Windows and fixed/lift vocabulary never enter this contract.
  if (openingPlan.interactive === false
      || openingPlan.motion?.mode === 'fixed'
      || openingPlan.motion?.mode === 'lift') {
    throw new Error('Door motion requires an interactive primary door with hinge motion');
  }
  const hingeSide = pivot.hingeSide < 0 ? -1 : 1;
  const maxAngle = clamp(Math.abs(finite(pivot.maxAngle, Math.PI * 0.5)), 0.2, Math.PI * 0.6);
  const openRatio = clamp(finite(options.openRatio, 0.84), 0.45, 1);
  const frequency = clamp(finite(options.frequency, 5.8), 2, 12);
  return deepFreeze({
    version: 1,
    openingId: String(openingPlan.id || 'primary-door'),
    hingeSide,
    pivot: {
      u: finite(pivot.u, 0),
      y: finite(pivot.y, 0),
      outward: finite(pivot.outward, 0),
    },
    leafWidth: Math.max(0.01, finite(pivot.leafWidth, 0.6)),
    leafCenterU: finite(pivot.leafCenterU, 0),
    meetingU: finite(pivot.meetingU, 0),
    closedAngle: 0,
    // Swing inward (-outward) for either hinge side. In opening-local axes a
    // left hinge uses +Y rotation and a right hinge uses -Y rotation.
    openAngle: -hingeSide * maxAngle * openRatio,
    frequency,
  });
}

export function createDoorMotionState(plan, { open = false } = {}) {
  if (!plan || !Number.isFinite(plan.openAngle) || !Number.isFinite(plan.frequency)) {
    throw new Error('Door motion state requires a finite motion plan');
  }
  let progress = open ? 1 : 0;
  let target = progress;
  let velocity = 0;
  let disposed = false;

  const snapshot = () => Object.freeze({
    openingId: plan.openingId,
    progress,
    targetOpen: target === 1,
    angle: plan.closedAngle + (plan.openAngle - plan.closedAngle) * progress,
    velocity,
    moving: !disposed && (Math.abs(progress - target) > 1e-4 || Math.abs(velocity) > 1e-4),
    disposed,
  });

  function setOpen(nextOpen) {
    if (disposed) return snapshot();
    target = nextOpen ? 1 : 0;
    return snapshot();
  }

  function update(deltaSeconds) {
    if (disposed) return false;
    let remaining = clamp(finite(deltaSeconds, 0), 0, 0.5);
    const before = progress;
    // Bounded substeps keep a throttled tab and a 60 Hz frame on the same
    // stable critically damped branch without depending on wall-clock time.
    while (remaining > 0) {
      const dt = Math.min(remaining, 1 / 60);
      const omega = plan.frequency;
      const f = 1 + 2 * dt * omega;
      const hoo = dt * omega * omega;
      const hhoo = dt * hoo;
      const inv = 1 / (f + hhoo);
      const previous = progress;
      progress = (f * progress + dt * velocity + hhoo * target) * inv;
      velocity = (velocity + hoo * (target - previous)) * inv;
      remaining -= dt;
    }
    if (Math.abs(progress - target) < 1e-4 && Math.abs(velocity) < 1e-3) {
      progress = target;
      velocity = 0;
    }
    progress = clamp(progress, 0, 1);
    return Math.abs(progress - before) > 1e-8;
  }

  return {
    get plan() { return plan; },
    snapshot,
    setOpen,
    toggle: () => setOpen(target !== 1),
    seek(value) {
      if (!disposed) {
        progress = clamp(finite(value, progress), 0, 1);
        target = progress >= 0.5 ? 1 : 0;
        velocity = 0;
      }
      return snapshot();
    },
    update,
    dispose() {
      if (disposed) return;
      progress = 0;
      target = 0;
      velocity = 0;
      disposed = true;
    },
  };
}

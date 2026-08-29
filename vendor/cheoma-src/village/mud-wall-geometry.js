import * as THREE from 'three';
import { validateMudWallSurfacePlan } from './mud-wall-surface-plan.js';

// Three.js adapter for the renderer-free mud-wall surface plan. The structural
// wall faces remain the authoritative ±thickness / 2 envelope: packed joints,
// damp erosion, and embedded straw all move inward from it.

const EPSILON = 1e-7;
const SURFACE_SKIN = 0.004;
const DAMP_BLEND_HEIGHT = 0.14;

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const smoothstep = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function sortedUnique(values, lo, hi) {
  const sorted = values
    .map((value) => clamp(finite(value, lo), lo, hi))
    .sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    if (!result.length || Math.abs(value - result[result.length - 1]) > EPSILON) {
      result.push(value);
    }
  }
  if (!result.length || Math.abs(result[0] - lo) > EPSILON) result.unshift(lo);
  if (Math.abs(result[result.length - 1] - hi) > EPSILON) result.push(hi);
  return result;
}

function makeBuffers(vertexColors = true) {
  return { positions: [], colors: vertexColors ? [] : null };
}

function pushVertex(buffers, point, color) {
  buffers.positions.push(point.x, point.y, point.z);
  if (buffers.colors) buffers.colors.push(color[0], color[1], color[2]);
}

function pushTriangle(buffers, a, b, c, ca, cb = ca, cc = ca) {
  pushVertex(buffers, a, ca);
  pushVertex(buffers, b, cb);
  pushVertex(buffers, c, cc);
}

function pushQuad(buffers, a, b, c, d, ca, cb = ca, cc = ca, cd = ca) {
  pushTriangle(buffers, a, b, c, ca, cb, cc);
  pushTriangle(buffers, a, c, d, ca, cc, cd);
}

function finishGeometry(buffers) {
  if (!buffers.positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(buffers.positions, 3),
  );
  if (buffers.colors) {
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(buffers.colors, 3),
    );
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function liftAt(plan, y) {
  const lifts = plan.lifts || [];
  for (let index = 0; index < lifts.length; index++) {
    const lift = lifts[index];
    if (y <= lift.top + EPSILON || index === lifts.length - 1) return lift;
  }
  return null;
}

function jointDrift(joint) {
  return Math.abs(finite(joint.tilt)) * 0.5 + Math.abs(finite(joint.wave));
}

function jointWeight(joint, x, y, length) {
  const halfWidth = Math.max(EPSILON, finite(joint.width) * 0.5);
  const normalizedX = x / Math.max(EPSILON, length);
  const center = finite(joint.y)
    + finite(joint.tilt) * normalizedX
    + finite(joint.wave) * Math.sin(
      finite(joint.phase) + normalizedX * Math.PI * 2,
    );
  const shape = Math.max(0, 1 - Math.abs(y - center) / halfWidth);
  const irregularStrength = 0.72 + 0.28 * (
    0.5 + 0.5 * Math.sin(finite(joint.phase) * 1.73 + normalizedX * Math.PI * 6)
  );
  return shape * irregularStrength;
}

function dampAtX(damp, x) {
  const points = damp?.points || [];
  if (!points.length) return null;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  for (let index = 1; index < points.length; index++) {
    const right = points[index];
    if (x > right.x) continue;
    const left = points[index - 1];
    const span = Math.max(EPSILON, right.x - left.x);
    const t = (x - left.x) / span;
    return left.y + (right.y - left.y) * t;
  }
  return last.y;
}

function dampWeight(damp, x, y) {
  const upper = dampAtX(damp, x);
  if (upper == null || y >= upper) return 0;
  return smoothstep((upper - y) / DAMP_BLEND_HEIGHT);
}

function faceSample(plan, side, x, y, thickness, options) {
  const halfThickness = thickness * 0.5;
  const skin = Math.min(SURFACE_SKIN, thickness * 0.08);
  let inset = skin;
  let shade = 1;

  if (options.packed) {
    const lift = liftAt(plan, y);
    if (lift) shade *= clamp(finite(lift.colorK, 1), 0.45, 1.1);
    for (const joint of plan.joints || []) {
      const weight = jointWeight(joint, x, y, plan.bounds.length);
      if (weight <= 0) continue;
      inset += finite(joint.depth) * weight;
      shade *= 1 - (1 - clamp(finite(joint.colorK, 1), 0.45, 1.1)) * weight;
    }
  }

  let damp = 0;
  let dampColor = 1;
  if (options.damp) {
    const record = (plan.damp || []).find((candidate) => candidate.side === side);
    damp = dampWeight(record, x, y);
    if (damp > 0) {
      inset += finite(record.depth) * damp;
      dampColor = clamp(finite(record.colorK, 1), 0.45, 1.05);
    }
  }

  // Damp earth is slightly cooler as well as darker. This remains a material
  // multiplier, so the borrowed palette owns the authored base colour.
  const dampR = 1 - (1 - dampColor * 0.92) * damp;
  const dampG = 1 - (1 - dampColor * 0.98) * damp;
  const dampB = 1 - (1 - dampColor * 1.04) * damp;
  return {
    z: side * Math.max(0, halfThickness - inset),
    color: [
      clamp(shade * dampR, 0.35, 1.1),
      clamp(shade * dampG, 0.35, 1.1),
      clamp(shade * dampB, 0.35, 1.1),
    ],
  };
}

function addSideFace(buffers, plan, side, thickness, options) {
  const { length, bodyBottom, bodyTop } = plan.bounds;
  const halfLength = length * 0.5;
  const damp = options.damp
    ? (plan.damp || []).find((candidate) => candidate.side === side)
    : null;
  const xBreaks = sortedUnique([
    -halfLength,
    halfLength,
    ...(damp?.points || []).map((point) => point.x),
  ], -halfLength, halfLength);
  const yBreaks = sortedUnique([
    bodyBottom,
    bodyTop,
    ...(options.packed ? (plan.lifts || []).flatMap((lift) => [lift.bottom, lift.top]) : []),
    ...(options.packed ? (plan.joints || []).flatMap((joint) => [
      joint.y - joint.width * 0.5 - jointDrift(joint),
      joint.y,
      joint.y + joint.width * 0.5 + jointDrift(joint),
    ]) : []),
    ...(damp?.points || []).map((point) => point.y),
  ], bodyBottom, bodyTop);

  for (let yi = 0; yi < yBreaks.length - 1; yi++) {
    const y0 = yBreaks[yi];
    const y1 = yBreaks[yi + 1];
    for (let xi = 0; xi < xBreaks.length - 1; xi++) {
      const x0 = xBreaks[xi];
      const x1 = xBreaks[xi + 1];
      const s00 = faceSample(plan, side, x0, y0, thickness, options);
      const s10 = faceSample(plan, side, x1, y0, thickness, options);
      const s11 = faceSample(plan, side, x1, y1, thickness, options);
      const s01 = faceSample(plan, side, x0, y1, thickness, options);
      const p00 = { x: x0, y: y0, z: s00.z };
      const p10 = { x: x1, y: y0, z: s10.z };
      const p11 = { x: x1, y: y1, z: s11.z };
      const p01 = { x: x0, y: y1, z: s01.z };
      if (side > 0) {
        pushQuad(
          buffers,
          p00, p10, p11, p01,
          s00.color, s10.color, s11.color, s01.color,
        );
      } else {
        pushQuad(
          buffers,
          p00, p01, p11, p10,
          s00.color, s01.color, s11.color, s10.color,
        );
      }
    }
  }
}

function addBodyCaps(buffers, plan, thickness, options) {
  const { length, bodyBottom, bodyTop } = plan.bounds;
  const hx = length * 0.5;
  const hz = thickness * 0.5;
  const white = [1, 1, 1];
  const topLift = options.packed ? liftAt(plan, bodyTop) : null;
  const bottomLift = options.packed ? liftAt(plan, bodyBottom) : null;
  const topK = clamp(finite(topLift?.colorK, 1), 0.45, 1.1);
  const bottomK = clamp(finite(bottomLift?.colorK, 1), 0.45, 1.1);
  const topColor = [topK, topK, topK];
  const bottomColor = [bottomK, bottomK, bottomK];

  // Run ends retain the exact structural plane, hiding any inward surface
  // offsets where stepped spans and corner posts meet.
  pushQuad(
    buffers,
    { x: hx, y: bodyBottom, z: hz },
    { x: hx, y: bodyBottom, z: -hz },
    { x: hx, y: bodyTop, z: -hz },
    { x: hx, y: bodyTop, z: hz },
    white,
  );
  pushQuad(
    buffers,
    { x: -hx, y: bodyBottom, z: -hz },
    { x: -hx, y: bodyBottom, z: hz },
    { x: -hx, y: bodyTop, z: hz },
    { x: -hx, y: bodyTop, z: -hz },
    white,
  );
  pushQuad(
    buffers,
    { x: -hx, y: bodyTop, z: -hz },
    { x: -hx, y: bodyTop, z: hz },
    { x: hx, y: bodyTop, z: hz },
    { x: hx, y: bodyTop, z: -hz },
    topColor,
  );
  pushQuad(
    buffers,
    { x: -hx, y: bodyBottom, z: hz },
    { x: -hx, y: bodyBottom, z: -hz },
    { x: hx, y: bodyBottom, z: -hz },
    { x: hx, y: bodyBottom, z: hz },
    bottomColor,
  );
}

function fibreCorners(fibre) {
  const halfLength = fibre.length * 0.5;
  const halfWidth = fibre.width * 0.5;
  const ux = Math.cos(fibre.angle) * halfLength;
  const uy = Math.sin(fibre.angle) * halfLength;
  const vx = -Math.sin(fibre.angle) * halfWidth;
  const vy = Math.cos(fibre.angle) * halfWidth;
  return [
    { x: fibre.x - ux - vx, y: fibre.y - uy - vy },
    { x: fibre.x + ux - vx, y: fibre.y + uy - vy },
    { x: fibre.x + ux + vx, y: fibre.y + uy + vy },
    { x: fibre.x - ux + vx, y: fibre.y - uy + vy },
  ];
}

function addFibre(buffers, fibre, thickness) {
  const side = fibre.side < 0 ? -1 : 1;
  const halfThickness = thickness * 0.5;
  const skin = Math.min(SURFACE_SKIN, thickness * 0.08);
  const outerInset = Math.min(0.0005, skin * 0.12);
  const depth = clamp(finite(fibre.depth), 0.0008, Math.max(0.0008, thickness * 0.2));
  const frontZ = side * (halfThickness - outerInset);
  const backZ = side * Math.max(0, halfThickness - skin - depth);
  const corners = fibreCorners(fibre);
  const front = corners.map((point) => ({ ...point, z: frontZ }));
  const back = corners.map((point) => ({ ...point, z: backZ }));
  const k = clamp(finite(fibre.colorK, 1), 0.45, 1.1);
  const color = [k, k, k];

  const order = side > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
  pushQuad(
    buffers,
    front[order[0]], front[order[1]], front[order[2]], front[order[3]],
    color,
  );
  pushQuad(
    buffers,
    back[order[3]], back[order[2]], back[order[1]], back[order[0]],
    color,
  );
  for (let index = 0; index < order.length; index++) {
    const current = order[index];
    const next = order[(index + 1) % order.length];
    pushQuad(
      buffers,
      back[current], back[next], front[next], front[current],
      color,
    );
  }
}

/**
 * Builds two owned geometries from a validated mud-wall surface plan.
 *
 * Construction toggles are intended for deterministic same-camera contribution
 * captures. Product walls use the all-on default and retain no runtime branch.
 */
export function buildMudWallSurfaceGeometry(plan, thickness, {
  packed = true,
  fibres = true,
  damp = true,
} = {}) {
  validateMudWallSurfacePlan(plan);
  if (!Number.isFinite(thickness) || thickness <= 0) {
    throw new RangeError('mud-wall geometry thickness must be positive');
  }
  const options = { packed: packed !== false, fibres: fibres !== false, damp: damp !== false };
  const body = makeBuffers();
  addSideFace(body, plan, -1, thickness, options);
  addSideFace(body, plan, 1, thickness, options);
  addBodyCaps(body, plan, thickness, options);

  const fibreBuffers = makeBuffers(false);
  if (options.fibres) {
    for (const fibre of plan.fibres || []) addFibre(fibreBuffers, fibre, thickness);
  }
  return {
    body: finishGeometry(body),
    // The borrowed jipjul material owns the straw colour. Keeping this geometry
    // colour-free avoids changing that shared material's program contract.
    fibres: finishGeometry(fibreBuffers),
  };
}

// Direct helper consumers own both returned geometries. Product walls attach
// them to meshes immediately and use the normal village Object3D disposal path.
export function disposeMudWallSurfaceGeometry(result) {
  result?.body?.dispose?.();
  result?.fibres?.dispose?.();
}

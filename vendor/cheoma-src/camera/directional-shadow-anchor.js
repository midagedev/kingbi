// Renderer-free directional-shadow framing.
//
// A directional light may translate together with its target without changing
// the light direction.  Snapping that shared anchor in the shadow camera's
// right/up plane prevents sub-texel camera motion from making a cached shadow
// map swim, while preserving the requested position along the light ray.

const EPSILON = 1e-10;
const MAX_MAP_SIZE = 65536;
const MAX_ANCHOR_COMPONENT = 1e12;

export const DEFAULT_DIRECTIONAL_SHADOW_SPAN = 44;
export const DEFAULT_DIRECTIONAL_SHADOW_MAP_SIZE = 4096;

const cleanZero = (value) => (Object.is(value, -0) || Math.abs(value) < 1e-15 ? 0 : value);
const finite = (value, fallback = 0) => {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  } catch {
    return fallback;
  }
};
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

function vector(value, fallback = 0) {
  return {
    x: finite(value?.x, fallback),
    y: finite(value?.y, fallback),
    z: finite(value?.z, fallback),
  };
}

function anchorVector(value) {
  const result = vector(value);
  result.x = Math.max(-MAX_ANCHOR_COMPONENT, Math.min(MAX_ANCHOR_COMPONENT, result.x));
  result.y = Math.max(-MAX_ANCHOR_COMPONENT, Math.min(MAX_ANCHOR_COMPONENT, result.y));
  result.z = Math.max(-MAX_ANCHOR_COMPONENT, Math.min(MAX_ANCHOR_COMPONENT, result.z));
  return result;
}

function normalizeDirection(value) {
  const input = vector(value);
  const scale = Math.max(Math.abs(input.x), Math.abs(input.y), Math.abs(input.z));
  if (!(scale > EPSILON) || !Number.isFinite(scale)) return { x: 0, y: 1, z: 0 };
  // Scaling first keeps normalization finite for otherwise valid, very large inputs.
  const x = input.x / scale;
  const y = input.y / scale;
  const z = input.z / scale;
  const length = Math.hypot(x, y, z);
  if (!(length > EPSILON) || !Number.isFinite(length)) return { x: 0, y: 1, z: 0 };
  return {
    x: cleanZero(x / length),
    y: cleanZero(y / length),
    z: cleanZero(z / length),
  };
}

function shadowBasis(direction) {
  // world-up x direction gives a stable horizontal right axis.  A vertical sun
  // has no preferred azimuth, so pin +X instead of letting tiny XZ noise flip it.
  const horizontal = Math.hypot(direction.x, direction.z);
  const right = horizontal > EPSILON
    ? { x: direction.z / horizontal, y: 0, z: -direction.x / horizontal }
    : { x: 1, y: 0, z: 0 };
  // direction x right completes a right-handed shadow-map basis:
  // right x up = direction.
  const up = {
    x: direction.y * right.z - direction.z * right.y,
    y: direction.z * right.x - direction.x * right.z,
    z: direction.x * right.y - direction.y * right.x,
  };
  return {
    right: {
      x: cleanZero(right.x), y: cleanZero(right.y), z: cleanZero(right.z),
    },
    up: { x: cleanZero(up.x), y: cleanZero(up.y), z: cleanZero(up.z) },
  };
}

function validSpan(value) {
  const span = finite(value, NaN);
  return Number.isFinite(span) && span > EPSILON
    ? span : DEFAULT_DIRECTIONAL_SHADOW_SPAN;
}

function validMapSize(value) {
  const size = Math.floor(finite(value, NaN));
  if (!Number.isFinite(size) || size < 1) return DEFAULT_DIRECTIONAL_SHADOW_MAP_SIZE;
  return Math.min(MAX_MAP_SIZE, size);
}

function snappedCoordinate(value, texelSize) {
  const snapped = Math.round(value / texelSize) * texelSize;
  return cleanZero(Number.isFinite(snapped) ? snapped : 0);
}

/**
 * Snap an anchor to the directional light's shadow-map texel grid.
 *
 * `direction` points from the light target toward the light. `span` is the full
 * orthographic width/height in world units and `mapSize` is the square shadow
 * map dimension in pixels. Only light-space right/up are quantized; the anchor's
 * component along `direction` is retained.
 */
export function snapDirectionalShadowAnchor(
  requestedAnchor,
  requestedDirection,
  orthographicSpan = DEFAULT_DIRECTIONAL_SHADOW_SPAN,
  shadowMapSize = DEFAULT_DIRECTIONAL_SHADOW_MAP_SIZE,
) {
  const requested = anchorVector(requestedAnchor);
  const direction = normalizeDirection(requestedDirection);
  const { right, up } = shadowBasis(direction);
  const span = validSpan(orthographicSpan);
  const mapSize = validMapSize(shadowMapSize);
  const texelSize = span / mapSize;

  const along = dot(requested, direction);
  const rightCoordinate = dot(requested, right);
  const upCoordinate = dot(requested, up);
  const snappedRight = snappedCoordinate(rightCoordinate, texelSize);
  const snappedUp = snappedCoordinate(upCoordinate, texelSize);
  const anchor = {
    x: direction.x * along + right.x * snappedRight + up.x * snappedUp,
    y: direction.y * along + right.y * snappedRight + up.y * snappedUp,
    z: direction.z * along + right.z * snappedRight + up.z * snappedUp,
  };

  // Recomposition is theoretically exact, but one correction along the normalized
  // ray removes its final floating-point projection error without perturbing the
  // snapped right/up coordinates.
  const correction = along - dot(anchor, direction);
  anchor.x = cleanZero(anchor.x + direction.x * correction);
  anchor.y = cleanZero(anchor.y + direction.y * correction);
  anchor.z = cleanZero(anchor.z + direction.z * correction);

  return {
    anchor,
    direction: { ...direction },
    basis: {
      right: { ...right },
      up: { ...up },
    },
    texel: { span, mapSize, size: texelSize },
    lightSpace: {
      requested: { right: rightCoordinate, up: upCoordinate, along },
      snapped: { right: snappedRight, up: snappedUp, along },
    },
  };
}

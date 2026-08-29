// Renderer- and DOM-free semantic focus fitting.
//
// A subject is described by physical fit points rather than one inflated AABB:
// representative architecture contributes its lower/upper footprint, while a
// courtyard contributes only its ground plane. This keeps empty air above a
// court from becoming an imaginary solid and lets product adapters fit the same
// subject into whatever viewport remains after their own UI chrome is measured.

const EPS = 1e-9;
const DEFAULT_GUTTER = 16;
const DEFAULT_MIN_SAFE_FRACTION = 0.28;
const DEFAULT_MAX_DOLLY_SCALE = 4;

const finitePoint = (point) => (
  point && [point.x, point.y, point.z].every(Number.isFinite)
);
const copyPoint = (point) => ({ x: point.x, y: point.y, z: point.z });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function polygonPoints(footprint, y) {
  if (!Array.isArray(footprint) || !Number.isFinite(y)) return [];
  return footprint.flatMap((point) => (
    Number.isFinite(point?.x) && Number.isFinite(point?.z)
      ? [{ x: point.x, y, z: point.z }]
      : []
  ));
}

export function focusSubjectFitPoints(subject) {
  if (!subject) return [];
  const representative = subject.representative;
  const points = [];
  if (representative?.footprint) {
    points.push(...polygonPoints(representative.footprint, representative.minY));
    if (Math.abs((representative.maxY ?? representative.minY) - representative.minY) > EPS) {
      points.push(...polygonPoints(representative.footprint, representative.maxY));
    }
  }
  if (subject.courtyard?.footprint) {
    points.push(...polygonPoints(subject.courtyard.footprint, subject.courtyard.y));
  }
  for (const anchor of subject.anchors || []) {
    const point = anchor?.point || anchor;
    if (finitePoint(point)) points.push(copyPoint(point));
  }
  return points;
}

export function focusSubjectBounds(subject) {
  const points = focusSubjectFitPoints(subject);
  if (!points.length) return null;
  const bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (const point of points) for (const axis of ['x', 'y', 'z']) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
  return bounds;
}

export function transformFocusSubject(subject, {
  x = 0, y = 0, z = 0, rotationY = 0,
} = {}) {
  if (!subject) return null;
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  const transformPoint = (point) => ({
    x: x + point.x * cos + point.z * sin,
    y: y + point.y,
    z: z - point.x * sin + point.z * cos,
  });
  const transformFootprint = (footprint) => footprint.map((point) => {
    const world = transformPoint({ x: point.x, y: 0, z: point.z });
    return { x: world.x, z: world.z };
  });
  const representative = subject.representative ? {
    ...subject.representative,
    footprint: transformFootprint(subject.representative.footprint),
    minY: y + subject.representative.minY,
    maxY: y + subject.representative.maxY,
  } : null;
  const courtyard = subject.courtyard ? {
    ...subject.courtyard,
    footprint: transformFootprint(subject.courtyard.footprint),
    y: y + subject.courtyard.y,
  } : null;
  return {
    ...subject,
    target: finitePoint(subject.target) ? transformPoint(subject.target) : null,
    representative,
    courtyard,
    anchors: (subject.anchors || []).flatMap((anchor, index) => {
      const point = anchor?.point || anchor;
      if (!finitePoint(point)) return [];
      return [{
        id: String(anchor?.id ?? `anchor:${index}`),
        point: transformPoint(point),
      }];
    }),
  };
}

/**
 * Reduce physical viewport insets to one central safe rectangle.
 *
 * `shiftX` / `shiftY` are the *ideal* recentring: the projection offset that would
 * put the camera axis exactly at this rectangle's centre. A product runtime may
 * apply something else — it can clamp the shift, and it can compose an artistic
 * offset on top of it — so a consumer that judges containment must tell
 * `fitFocusFraming()` which shift it will really apply (`appliedShift`), or the
 * verdict is computed in a different space than the frame that ships.
 */
export function safeViewportRect({
  width,
  height,
  insets = {},
  gutter = DEFAULT_GUTTER,
  minSafeFraction = DEFAULT_MIN_SAFE_FRACTION,
} = {}) {
  const viewportWidth = Math.max(1, Number(width) || 1);
  const viewportHeight = Math.max(1, Number(height) || 1);
  const margin = Math.max(0, Number(gutter) || 0);
  const left = clamp((Number(insets.left) || 0) + margin, 0, viewportWidth);
  const right = clamp(
    viewportWidth - (Number(insets.right) || 0) - margin,
    0,
    viewportWidth,
  );
  const top = clamp((Number(insets.top) || 0) + margin, 0, viewportHeight);
  const bottom = clamp(
    viewportHeight - (Number(insets.bottom) || 0) - margin,
    0,
    viewportHeight,
  );
  const safeWidth = Math.max(0, right - left);
  const safeHeight = Math.max(0, bottom - top);
  const usable = safeWidth >= viewportWidth * minSafeFraction
    && safeHeight >= viewportHeight * minSafeFraction;
  return {
    left,
    right,
    top,
    bottom,
    width: safeWidth,
    height: safeHeight,
    usable,
    shiftX: (left + right - viewportWidth) * 0.5,
    shiftY: (viewportHeight - top - bottom) * 0.5,
    viewportWidth,
    viewportHeight,
  };
}

function cameraBasis(position, target) {
  let fx = target.x - position.x;
  let fy = target.y - position.y;
  let fz = target.z - position.z;
  const forwardLength = Math.hypot(fx, fy, fz);
  if (forwardLength <= EPS) return null;
  fx /= forwardLength; fy /= forwardLength; fz /= forwardLength;
  let rx = -fz;
  let rz = fx;
  const rightLength = Math.hypot(rx, rz);
  if (rightLength <= EPS) return null;
  rx /= rightLength; rz /= rightLength;
  return {
    forward: { x: fx, y: fy, z: fz },
    right: { x: rx, y: 0, z: rz },
    up: {
      x: -rz * fy,
      y: rz * fx - rx * fz,
      z: rx * fy,
    },
  };
}

// Screen position under the projection offset the runtime will actually apply.
// `rect.appliedShiftX/Y` follow the product convention: a positive X shift moves the
// subject right, a positive Y shift moves it up (see fitFocusFraming).
function projectPoint(point, position, basis, fov, aspect, rect) {
  const dx = point.x - position.x;
  const dy = point.y - position.y;
  const dz = point.z - position.z;
  const depth = dx * basis.forward.x + dy * basis.forward.y + dz * basis.forward.z;
  if (depth <= EPS) return null;
  const tanHalf = Math.tan(fov * Math.PI / 360);
  const ndcX = (dx * basis.right.x + dz * basis.right.z) / (depth * tanHalf * aspect);
  const ndcY = (dx * basis.up.x + dy * basis.up.y + dz * basis.up.z) / (depth * tanHalf);
  return {
    x: (ndcX + 1) * rect.viewportWidth * 0.5 + rect.appliedShiftX,
    y: (1 - ndcY) * rect.viewportHeight * 0.5 - rect.appliedShiftY,
  };
}

function projectedBounds(points, framing, rect, scale) {
  const target = framing.target;
  const position = {
    x: target.x + (framing.position.x - target.x) * scale,
    y: target.y + (framing.position.y - target.y) * scale,
    z: target.z + (framing.position.z - target.z) * scale,
  };
  const basis = cameraBasis(position, target);
  if (!basis) return null;
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const point of points) {
    const projected = projectPoint(
      point,
      position,
      basis,
      framing.fov,
      rect.viewportWidth / rect.viewportHeight,
      rect,
    );
    if (!projected) return null;
    bounds.left = Math.min(bounds.left, projected.x);
    bounds.right = Math.max(bounds.right, projected.x);
    bounds.top = Math.min(bounds.top, projected.y);
    bounds.bottom = Math.max(bounds.bottom, projected.y);
  }
  return { bounds, position };
}

function contains(rect, projected) {
  return projected
    && projected.bounds.left >= rect.left - EPS
    && projected.bounds.right <= rect.right + EPS
    && projected.bounds.top >= rect.top - EPS
    && projected.bounds.bottom <= rect.bottom + EPS;
}

/**
 * Dolly the authored framing back along its own ray until the subject's fit points
 * sit inside the viewport left by product chrome. Lens, target, axis and elevation
 * are preserved; only distance changes.
 *
 * `appliedShift` is the projection offset the caller will really apply, in screen
 * pixels, positive X moving the subject right and positive Y moving it up. Omit it
 * and both the search and the verdict use the ideal recentring shift of the safe
 * rectangle — the historical behaviour, byte-identical. Pass it when the runtime
 * offset differs from that ideal (a clamp, or an artistic composition offset
 * composed on top), because `fitted`/`overflow` are only meaningful in the space
 * the frame is actually rendered in.
 */
export function fitFocusFraming({
  framing,
  subject,
  viewport,
  appliedShift = null,
  maxDollyScale = DEFAULT_MAX_DOLLY_SCALE,
} = {}) {
  const ideal = safeViewportRect(viewport);
  const rect = {
    ...ideal,
    appliedShiftX: Number.isFinite(appliedShift?.x) ? appliedShift.x : ideal.shiftX,
    appliedShiftY: Number.isFinite(appliedShift?.y) ? appliedShift.y : ideal.shiftY,
  };
  const points = focusSubjectFitPoints(subject);
  const validFraming = finitePoint(framing?.position)
    && finitePoint(framing?.target)
    && Number.isFinite(framing?.fov)
    && framing.fov > 0;
  if (!validFraming || !points.length || !rect.usable) {
    return {
      framing: framing ? {
        ...framing,
        position: framing.position ? copyPoint(framing.position) : null,
        target: framing.target ? copyPoint(framing.target) : null,
      } : null,
      safeRect: rect,
      scale: 1,
      fitted: false,
      overflow: !rect.usable || !points.length,
      projectedBounds: null,
    };
  }
  const base = projectedBounds(points, framing, rect, 1);
  let scale = 1;
  let fitted = contains(rect, base);
  const maximum = Math.max(1, Number(maxDollyScale) || DEFAULT_MAX_DOLLY_SCALE);
  let result = base;
  if (!fitted) {
    const far = projectedBounds(points, framing, rect, maximum);
    if (contains(rect, far)) {
      let low = 1;
      let high = maximum;
      for (let index = 0; index < 36; index++) {
        const middle = (low + high) * 0.5;
        const candidate = projectedBounds(points, framing, rect, middle);
        if (contains(rect, candidate)) high = middle;
        else low = middle;
      }
      scale = high;
      result = projectedBounds(points, framing, rect, scale);
      fitted = true;
    } else {
      scale = maximum;
      result = far;
    }
  }
  return {
    framing: {
      ...framing,
      position: result?.position || copyPoint(framing.position),
      target: copyPoint(framing.target),
    },
    safeRect: rect,
    scale,
    fitted,
    overflow: !contains(rect, result),
    projectedBounds: result?.bounds || null,
  };
}

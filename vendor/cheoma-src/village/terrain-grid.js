// village terrain renderer가 쓰는 정규 격자와 삼각 분할의 순수 높이 계약. 도로·성곽·검증이
// 해석 site.heightAt만 다시 부르면 실제 화면의 선형 terrain 면과 어긋날 수 있다.

const GRID_CACHE = new WeakMap();
export const STREAM_SURFACE_CLEARANCE = 0.035;

export function terrainGridSize(site) {
  const terrainR = site.terrainR || site.R;
  return Math.max(150, Math.min(260, Math.round(terrainR / 1.4)));
}

export function terrainGridStep(site) {
  const terrainR = site.terrainR || site.R;
  return 2 * terrainR / terrainGridSize(site);
}

export function terrainMeshHeightAt(site, x, z) {
  const terrainR = site.terrainR || site.R;
  const size = terrainGridSize(site);
  const u = Math.max(0, Math.min(size, (x + terrainR) / (2 * terrainR) * size));
  const v = Math.max(0, Math.min(size, (z + terrainR) / (2 * terrainR) * size));
  const i = Math.min(size - 1, Math.floor(u));
  const j = Math.min(size - 1, Math.floor(v));
  const fu = u - i, fv = v - j;
  const step = 2 * terrainR / size;
  let grid = GRID_CACHE.get(site);
  if (!grid || grid.size !== size || grid.terrainR !== terrainR) {
    const heights = new Float64Array((size + 1) * (size + 1));
    heights.fill(Number.NaN);
    grid = { size, terrainR, heights };
    GRID_CACHE.set(site, grid);
  }
  const height = (di, dj) => {
    const gi = i + di, gj = j + dj;
    const index = gi * (size + 1) + gj;
    let value = grid.heights[index];
    if (Number.isNaN(value)) {
      value = site.heightAt(-terrainR + gi * step, -terrainR + gj * step);
      grid.heights[index] = value;
    }
    return value;
  };
  const a = height(0, 0), b = height(0, 1), c = height(1, 0), d = height(1, 1);
  // terrain.js index: (a,b,c) / (b,d,c), 분할선 fu+fv=1.
  return fu + fv <= 1
    ? a * (1 - fu - fv) + b * fv + c * fu
    : b * (1 - fu) + c * (1 - fv) + d * (fu + fv - 1);
}

function terrainMeshSegmentParameters(site, a, b, maxT = 1) {
  const terrainR = site.terrainR || site.R;
  const size = terrainGridSize(site);
  const grid = (point) => ({
    u: (point.x + terrainR) / (2 * terrainR) * size,
    v: (point.z + terrainR) / (2 * terrainR) * size,
  });
  const start = grid(a), end = grid(b);
  const parameters = [0, Math.max(0, Math.min(1, maxT))];
  const addCrossings = (from, to) => {
    if (Math.abs(to - from) <= 1e-12) return;
    const first = Math.ceil(Math.min(from, to));
    const last = Math.floor(Math.max(from, to));
    for (let boundary = first; boundary <= last; boundary++) {
      const t = (boundary - from) / (to - from);
      if (t > 1e-10 && t < maxT - 1e-10) parameters.push(t);
    }
  };
  addCrossings(start.u, end.u);
  addCrossings(start.v, end.v);
  addCrossings(start.u + start.v, end.u + end.v);
  parameters.sort((left, right) => left - right);
  const unique = [];
  for (const t of parameters) {
    if (unique.length && Math.abs(t - unique.at(-1)) <= 1e-10) continue;
    unique.push(t);
  }
  return unique;
}

// Exact extrema along a straight world-space segment on the rendered grid.
// Each triangle is planar, so extrema occur only at the endpoints, grid axes,
// or the renderer's `fu + fv = 1` diagonal. Consumers that must meet actual
// terrain geometry (walls, water, bridges) should not approximate this range
// with site.heightAt or arbitrary uniform samples.
export function terrainMeshSegmentRange(site, a, b) {
  const parameters = terrainMeshSegmentParameters(site, a, b);

  let min = Infinity, max = -Infinity;
  for (const t of parameters) {
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const height = terrainMeshHeightAt(site, x, z);
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return { min, max, range: max - min };
}

function pointOnSegment(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function clearanceAt(site, a, b, t) {
  const point = pointOnSegment(a, b, t);
  return point.y - terrainMeshHeightAt(site, point.x, point.z);
}

/**
 * Exact minimum vertical clearance from the rendered, triangulated terrain.
 *
 * Both the sightline and every terrain triangle are planar between the returned
 * breakpoints, so this checks all extrema without a sampling interval.
 */
export function terrainMeshSegmentClearance(site, a, b, maxT = 1) {
  const parameters = terrainMeshSegmentParameters(site, a, b, maxT);
  let min = Infinity;
  let minT = 0;
  for (const t of parameters) {
    const clearance = clearanceAt(site, a, b, t);
    if (clearance < min) {
      min = clearance;
      minT = t;
    }
  }
  return {
    min,
    minT,
    end: clearanceAt(site, a, b, parameters.at(-1)),
    maxT: parameters.at(-1),
  };
}

function radialExitScale(start, end, maxRadius) {
  if (!(Number.isFinite(maxRadius) && maxRadius > 0)) return 1;
  const sx = start.x, sz = start.z;
  const dx = end.x - sx, dz = end.z - sz;
  const c = sx * sx + sz * sz - maxRadius * maxRadius;
  if (c > 1e-8) return 0;
  const a = dx * dx + dz * dz;
  if (a <= 1e-12) return 1;
  const b = 2 * (sx * dx + sz * dz);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return 1;
  const exit = (-b + Math.sqrt(discriminant)) / (2 * a);
  return Math.max(0, Math.min(1, exit));
}

function terrainMeshSegmentObstruction(site, start, end, threshold, maxT) {
  const parameters = terrainMeshSegmentParameters(site, start, end, maxT);
  let leftT = parameters[0];
  let left = clearanceAt(site, start, end, leftT);
  let min = left;
  const contact = left < threshold;
  let clear = !contact;
  let unsafeT = null;
  for (const rightT of parameters.slice(1)) {
    const right = clearanceAt(site, start, end, rightT);
    min = Math.min(min, right);
    if (!clear && right >= threshold) {
      // The low face sample may begin inside the building's ordinary terrain
      // contact. Arm foreground detection only after that ray has left the
      // subject-owned ground interval.
      clear = true;
    } else if (clear && unsafeT == null && right < threshold) {
      const span = left - right;
      unsafeT = span <= 1e-12
        ? leftT
        : leftT + (rightT - leftT) * ((left - threshold) / span);
    }
    leftT = rightT;
    left = right;
  }
  return { min, unsafeT, contact };
}

/**
 * Resolve one camera near plane that removes terrain in front of a focus subject.
 *
 * A perspective near plane clips color, packed DoF depth, ink normal/depth and
 * vegetation with the same projection, so it is a much smaller ownership
 * boundary than teaching every material and override pass a camera tunnel.
 * `samples` are the nine camera-facing points owned by focus visibility. The
 * plane is accepted only when every blocking terrain interval ends at least
 * `subjectClearance` before the nearest sampled house surface.
 */
export function terrainMeshFocusCutaway(site, camera, target, samples, {
  clearance = 0.08,
  planeMargin = 0.35,
  subjectClearance = 1.2,
  maxRadius = Infinity,
} = {}) {
  const points = Array.isArray(samples) ? samples : [];
  if (!site || !camera || !target || !points.length) {
    return {
      active: false,
      available: false,
      near: 0,
      requiredNear: Infinity,
      subjectNear: 0,
      minClearance: -Infinity,
      cameraClearance: -Infinity,
      blockedRays: 0,
      contactRays: 0,
      boundaryRays: 0,
      reason: 'invalid-input',
    };
  }
  const fx = target.x - camera.x;
  const fy = target.y - camera.y;
  const fz = target.z - camera.z;
  const length = Math.hypot(fx, fy, fz);
  if (!(length > 1e-6)) {
    return {
      active: false,
      available: false,
      near: 0,
      requiredNear: Infinity,
      subjectNear: 0,
      minClearance: -Infinity,
      cameraClearance: -Infinity,
      blockedRays: 0,
      contactRays: 0,
      boundaryRays: 0,
      reason: 'degenerate-view',
    };
  }
  const forward = { x: fx / length, y: fy / length, z: fz / length };
  let requiredNear = 0;
  let subjectNear = Infinity;
  let minClearance = Infinity;
  let blockedRays = 0;
  let contactRays = 0;
  let boundaryRays = 0;

  for (const sample of points) {
    const sampleDepth = (sample.x - camera.x) * forward.x
      + (sample.y - camera.y) * forward.y
      + (sample.z - camera.z) * forward.z;
    if (!(sampleDepth > 0)) continue;
    subjectNear = Math.min(subjectNear, sampleDepth);

    // Work from subject→camera so the first unsafe parameter is also the
    // farthest obstruction from the eye and therefore the required near depth.
    const radialScale = radialExitScale(sample, camera, maxRadius);
    if (radialScale < 1 - 1e-9) {
      boundaryRays++;
    }
    // `maxRadius` bounds the regular, analytically exact grid before the rendered
    // outer warp. Crossing that boundary is diagnostic, not an obstruction:
    // treating all unknown outer depth as solid would erase the village context
    // during the high focus zoom-out even when its crane-up ray clears every
    // proven ridge. Only an actual triangle crossing inside the exact region may
    // raise the projection plane.
    const obstruction = terrainMeshSegmentObstruction(
      site,
      sample,
      camera,
      clearance,
      radialScale,
    );
    minClearance = Math.min(minClearance, obstruction.min);
    if (obstruction.contact) contactRays++;
    if (obstruction.unsafeT != null) {
      blockedRays++;
      requiredNear = Math.max(
        requiredNear,
        sampleDepth * (1 - obstruction.unsafeT),
      );
    }
  }

  if (!Number.isFinite(subjectNear)) {
    return {
      active: false,
      available: false,
      near: 0,
      requiredNear: Infinity,
      subjectNear: 0,
      minClearance,
      cameraClearance: clearanceAt(site, camera, camera, 0),
      blockedRays,
      contactRays,
      boundaryRays,
      reason: 'subject-behind-camera',
    };
  }
  const active = requiredNear > 1e-6;
  const near = active ? requiredNear + Math.max(0, planeMargin) : 0;
  const available = !active || near <= subjectNear - Math.max(0, subjectClearance);
  return {
    active,
    available,
    near,
    requiredNear,
    subjectNear,
    minClearance,
    cameraClearance: clearanceAt(site, camera, camera, 0),
    blockedRays,
    contactRays,
    boundaryRays,
    reason: !active ? 'clear' : available ? 'cutaway' : 'subject-overlap',
  };
}

function firstClearanceCrossing(site, start, end, threshold, maxT) {
  const parameters = terrainMeshSegmentParameters(site, start, end, maxT);
  let previousT = parameters[0];
  let previous = clearanceAt(site, start, end, previousT);
  if (previous < threshold) return 0;
  for (const t of parameters.slice(1)) {
    const current = clearanceAt(site, start, end, t);
    if (current < threshold) {
      const span = previous - current;
      if (span <= 1e-12) return previousT;
      return previousT + (t - previousT) * ((previous - threshold) / span);
    }
    previousT = t;
    previous = current;
  }
  return maxT;
}

function lastEndpointScale(site, start, end, threshold, maxT) {
  if (clearanceAt(site, start, end, maxT) >= threshold) return maxT;
  const parameters = terrainMeshSegmentParameters(site, start, end, maxT);
  for (let index = parameters.length - 1; index > 0; index--) {
    const rightT = parameters[index];
    const leftT = parameters[index - 1];
    const right = clearanceAt(site, start, end, rightT);
    const left = clearanceAt(site, start, end, leftT);
    if (left >= threshold && right < threshold) {
      return leftT + (rightT - leftT) * ((left - threshold) / (left - right));
    }
  }
  return 0;
}

/**
 * Shorten a target→camera ray to its first terrain-safe interval.
 *
 * A distant camera may clear a nearer hill again after passing through it; that
 * second interval is physically unusable and is deliberately ignored. The
 * returned scale also keeps the eye itself above the surface and, when supplied,
 * inside the renderer's unwarped terrain radius.
 */
export function terrainMeshCameraSafeScale(site, target, camera, {
  clearance = 1,
  endpointClearance = 1.2,
  maxRadius = Infinity,
} = {}) {
  if (!site || !target || !camera) {
    return { scale: 0, limited: true, minClearance: -Infinity, endpointClearance: -Infinity };
  }
  const radialScale = radialExitScale(target, camera, maxRadius);
  const pathScale = firstClearanceCrossing(site, target, camera, clearance, radialScale);
  const scale = lastEndpointScale(
    site,
    target,
    camera,
    Math.max(clearance, endpointClearance),
    pathScale,
  );
  const range = terrainMeshSegmentClearance(site, target, camera, scale);
  return {
    scale,
    limited: scale < 1 - 1e-9,
    minClearance: range.min,
    endpointClearance: range.end,
    radialScale,
  };
}

// The analytic channel can dip below the renderer's triangulated heightfield
// between grid samples. Water and bridges share this rendered-surface contract so
// a valid pure stream never disappears underneath a coarse terrain triangle.
export function streamSurfaceHeightAt(site, x, z = site.streamZat(x)) {
  return Math.max(
    site.streamY(x),
    terrainMeshHeightAt(site, x, z) + STREAM_SURFACE_CLEARANCE,
  );
}

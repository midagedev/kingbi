// Allocation-free finite-ray queries over a sparse XZ grid of semantic solids.
// This module knows nothing about villages, renderers, or DOM state. Callers
// build records once, reuse one query context, and may traverse several indices
// into the same nearest-hit result.

export const SEMANTIC_RAY_EPS = 1e-8;
const DEFAULT_CELL_SIZE = 24;
const PRISM = 1;
const CYLINDER = 2;
const SPHERE = 3;
const WINTER = 'winter';

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function createSemanticRayIndex(cellSize = DEFAULT_CELL_SIZE) {
  return { cellSize, columns: new Map(), records: [], serial: 0 };
}

function cellAt(index, ix, iz, create) {
  let column = index.columns.get(ix);
  if (!column && create) {
    column = new Map();
    index.columns.set(ix, column);
  }
  let cell = column?.get(iz);
  if (!cell && create) {
    cell = [];
    column.set(iz, cell);
  }
  return cell || null;
}

function recordBounds(record) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const solid of record.solids) {
    minX = Math.min(minX, solid.minX); minY = Math.min(minY, solid.minY); minZ = Math.min(minZ, solid.minZ);
    maxX = Math.max(maxX, solid.maxX); maxY = Math.max(maxY, solid.maxY); maxZ = Math.max(maxZ, solid.maxZ);
  }
  record.minX = minX; record.minY = minY; record.minZ = minZ;
  record.maxX = maxX; record.maxY = maxY; record.maxZ = maxZ;
  return record;
}

export function addSemanticRayRecord(index, record, slot = index.records.length) {
  recordBounds(record);
  record.slot = slot;
  record.cells = [];
  record.visit = 0;
  record.active = true;
  index.records[slot] = record;
  const cs = index.cellSize;
  const minIX = Math.floor(record.minX / cs), maxIX = Math.floor(record.maxX / cs);
  const minIZ = Math.floor(record.minZ / cs), maxIZ = Math.floor(record.maxZ / cs);
  for (let ix = minIX; ix <= maxIX; ix++) for (let iz = minIZ; iz <= maxIZ; iz++) {
    cellAt(index, ix, iz, true).push(slot);
    record.cells.push(ix, iz);
  }
  return record;
}

export function removeSemanticRayRecord(index, record) {
  if (!record) return;
  for (let i = 0; i < record.cells.length; i += 2) {
    const cell = cellAt(index, record.cells[i], record.cells[i + 1], false);
    if (!cell) continue;
    const at = cell.indexOf(record.slot);
    if (at >= 0) cell.splice(at, 1);
  }
  record.active = false;
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function pointInTriangle(point, a, b, c, orientation) {
  return cross(a, b, point) * orientation >= -SEMANTIC_RAY_EPS
    && cross(b, c, point) * orientation >= -SEMANTIC_RAY_EPS
    && cross(c, a, point) * orientation >= -SEMANTIC_RAY_EPS;
}

// Ear clipping happens only at record construction. The hot ray path receives
// convex triangles and never allocates a candidate polygon.
export function triangulateSemanticPolygon(points) {
  if (points.length < 3) return [];
  const orientation = polygonArea(points) >= 0 ? 1 : -1;
  const remaining = Array.from({ length: points.length }, (_, index) => index);
  const triangles = [];
  let guard = points.length * points.length;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i + remaining.length - 1) % remaining.length];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % remaining.length];
      const a = points[ia], b = points[ib], c = points[ic];
      if (cross(a, b, c) * orientation <= SEMANTIC_RAY_EPS) continue;
      let contains = false;
      for (const candidate of remaining) {
        if (candidate === ia || candidate === ib || candidate === ic) continue;
        if (pointInTriangle(points[candidate], a, b, c, orientation)) { contains = true; break; }
      }
      if (contains) continue;
      triangles.push([a, b, c]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) triangles.push(remaining.map((index) => points[index]));
  return triangles;
}

export function semanticPrism(points, y0, y1, seasonal = false) {
  const edges = new Float64Array(points.length * 3);
  const orientation = polygonArea(points) >= 0 ? 1 : -1;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const point = points[i], next = points[(i + 1) % points.length];
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
    const dx = next.x - point.x, dz = next.z - point.z;
    const nx = orientation * dz, nz = orientation * -dx;
    edges[i * 3] = nx; edges[i * 3 + 1] = nz;
    edges[i * 3 + 2] = nx * point.x + nz * point.z;
  }
  return {
    type: PRISM, edges, seasonal,
    minX, minY: Math.min(y0, y1), minZ,
    maxX, maxY: Math.max(y0, y1), maxZ,
  };
}

export function semanticCylinder(x, z, radius, y0, y1, seasonal = false) {
  return {
    type: CYLINDER, x, z, radius, seasonal,
    minX: x - radius, minY: Math.min(y0, y1), minZ: z - radius,
    maxX: x + radius, maxY: Math.max(y0, y1), maxZ: z + radius,
  };
}

export function semanticSphere(x, y, z, radius, seasonal = false) {
  return {
    type: SPHERE, x, y, z, radius, seasonal,
    minX: x - radius, minY: y - radius, minZ: z - radius,
    maxX: x + radius, maxY: y + radius, maxZ: z + radius,
  };
}

export function semanticSegmentPrism(a, b, thickness, y0, y1) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length <= SEMANTIC_RAY_EPS) return null;
  const nx = -dz / length * thickness * 0.5;
  const nz = dx / length * thickness * 0.5;
  return semanticPrism([
    { x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz },
    { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz },
  ], y0, y1);
}

function axisInterval(origin, direction, minimum, maximum, interval) {
  if (Math.abs(direction) <= SEMANTIC_RAY_EPS) {
    return origin >= minimum - SEMANTIC_RAY_EPS && origin <= maximum + SEMANTIC_RAY_EPS;
  }
  let a = (minimum - origin) / direction, b = (maximum - origin) / direction;
  if (a > b) { const swap = a; a = b; b = swap; }
  if (a > interval.min) interval.min = a;
  if (b < interval.max) interval.max = b;
  return interval.max >= interval.min - SEMANTIC_RAY_EPS;
}

function boxDistance(context, record, limit) {
  const interval = context.interval;
  interval.min = 0; interval.max = limit;
  if (!axisInterval(context.ox, context.dx, record.minX, record.maxX, interval)) return Infinity;
  if (!axisInterval(context.oy, context.dy, record.minY, record.maxY, interval)) return Infinity;
  if (!axisInterval(context.oz, context.dz, record.minZ, record.maxZ, interval)) return Infinity;
  return interval.min;
}

function prismDistance(context, solid, limit) {
  const interval = context.interval;
  interval.min = 0; interval.max = limit;
  if (!axisInterval(context.oy, context.dy, solid.minY, solid.maxY, interval)) return Infinity;
  const edges = solid.edges;
  for (let i = 0; i < edges.length; i += 3) {
    const nx = edges[i], nz = edges[i + 1], cap = edges[i + 2];
    const q = cap - nx * context.ox - nz * context.oz;
    const velocity = nx * context.dx + nz * context.dz;
    if (Math.abs(velocity) <= SEMANTIC_RAY_EPS) {
      if (q < -SEMANTIC_RAY_EPS) return Infinity;
      continue;
    }
    const t = q / velocity;
    if (velocity > 0) interval.max = Math.min(interval.max, t);
    else interval.min = Math.max(interval.min, t);
    if (interval.max < interval.min - SEMANTIC_RAY_EPS) return Infinity;
  }
  return interval.min >= -SEMANTIC_RAY_EPS && interval.min <= limit + SEMANTIC_RAY_EPS
    ? Math.max(0, interval.min) : Infinity;
}

function cylinderDistance(context, solid, limit) {
  const interval = context.interval;
  interval.min = 0; interval.max = limit;
  if (!axisInterval(context.oy, context.dy, solid.minY, solid.maxY, interval)) return Infinity;
  const rx = context.ox - solid.x, rz = context.oz - solid.z;
  const a = context.dx * context.dx + context.dz * context.dz;
  const c = rx * rx + rz * rz - solid.radius * solid.radius;
  if (a <= SEMANTIC_RAY_EPS) {
    if (c > SEMANTIC_RAY_EPS) return Infinity;
  } else {
    const b = 2 * (rx * context.dx + rz * context.dz);
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const root = Math.sqrt(Math.max(0, disc));
    let t0 = (-b - root) / (2 * a), t1 = (-b + root) / (2 * a);
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    interval.min = Math.max(interval.min, t0);
    interval.max = Math.min(interval.max, t1);
    if (interval.max < interval.min - SEMANTIC_RAY_EPS) return Infinity;
  }
  return interval.min >= -SEMANTIC_RAY_EPS && interval.min <= limit + SEMANTIC_RAY_EPS
    ? Math.max(0, interval.min) : Infinity;
}

function sphereDistance(context, solid, limit) {
  const rx = context.ox - solid.x, ry = context.oy - solid.y, rz = context.oz - solid.z;
  const b = rx * context.dx + ry * context.dy + rz * context.dz;
  const c = rx * rx + ry * ry + rz * rz - solid.radius * solid.radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const root = Math.sqrt(Math.max(0, disc));
  const t = c <= 0 ? 0 : -b - root;
  return t >= -SEMANTIC_RAY_EPS && t <= limit + SEMANTIC_RAY_EPS ? Math.max(0, t) : Infinity;
}

function solidDistance(context, solid, limit) {
  if (solid.type === PRISM) return prismDistance(context, solid, limit);
  if (solid.type === CYLINDER) return cylinderDistance(context, solid, limit);
  return sphereDistance(context, solid, limit);
}

function visitCell(index, cell, context) {
  if (!cell) return;
  for (let i = 0; i < cell.length; i++) {
    const record = index.records[cell[i]];
    if (!record?.active || record.visit === context.serial) continue;
    record.visit = context.serial;
    context.stats.candidates++;
    if (record.excludeWithOwner && record.ownerId === context.excludeOwnerId) continue;
    if (boxDistance(context, record, context.best) === Infinity) continue;
    for (let j = 0; j < record.solids.length; j++) {
      const solid = record.solids[j];
      if (solid.seasonal && context.season === WINTER) continue;
      context.stats.solids++;
      const distance = solidDistance(context, solid, context.best);
      if (distance < context.best) {
        context.best = distance;
        context.record = record;
      }
    }
  }
}

export function traverseSemanticRayIndex(index, context) {
  if (!index || index.records.length === 0) return;
  context.serial = ++index.serial;
  if (index.serial >= Number.MAX_SAFE_INTEGER) index.serial = 1;
  const cs = index.cellSize;
  let ix = Math.floor(context.ox / cs), iz = Math.floor(context.oz / cs);
  const stepX = context.dx > SEMANTIC_RAY_EPS ? 1 : context.dx < -SEMANTIC_RAY_EPS ? -1 : 0;
  const stepZ = context.dz > SEMANTIC_RAY_EPS ? 1 : context.dz < -SEMANTIC_RAY_EPS ? -1 : 0;
  const nextX = stepX > 0 ? (ix + 1) * cs : ix * cs;
  const nextZ = stepZ > 0 ? (iz + 1) * cs : iz * cs;
  let tMaxX = stepX ? (nextX - context.ox) / context.dx : Infinity;
  let tMaxZ = stepZ ? (nextZ - context.oz) / context.dz : Infinity;
  const tDeltaX = stepX ? cs / Math.abs(context.dx) : Infinity;
  const tDeltaZ = stepZ ? cs / Math.abs(context.dz) : Infinity;
  let t = 0;
  for (;;) {
    context.stats.cells++;
    visitCell(index, cellAt(index, ix, iz, false), context);
    const stop = Math.min(context.limit, context.best);
    if (stepX === 0 && stepZ === 0) break;
    if (tMaxX < tMaxZ) {
      t = tMaxX; tMaxX += tDeltaX; ix += stepX;
    } else if (tMaxZ < tMaxX) {
      t = tMaxZ; tMaxZ += tDeltaZ; iz += stepZ;
    } else {
      t = tMaxX; tMaxX += tDeltaX; tMaxZ += tDeltaZ; ix += stepX; iz += stepZ;
    }
    if (t > stop + SEMANTIC_RAY_EPS) break;
  }
}

export function createSemanticRayQueryContext() {
  return {
    ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0,
    limit: 0, best: 0, record: null, excludeOwnerId: null,
    season: 'summer', serial: 0, stats: null,
    interval: { min: 0, max: 0 },
  };
}

export function prepareSemanticRayQuery(
  context,
  ray,
  maxDistance,
  excludeOwnerId,
  season,
  stats,
) {
  const origin = ray?.origin || ray;
  const direction = ray?.direction || ray?.dir;
  if (!origin || !direction) return false;
  const length = Math.hypot(direction.x || 0, direction.y || 0, direction.z || 0);
  if (length <= SEMANTIC_RAY_EPS) return false;
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) return false;
  stats.cells = 0; stats.candidates = 0; stats.solids = 0;
  context.ox = finite(origin.x, 0); context.oy = finite(origin.y, 0); context.oz = finite(origin.z, 0);
  context.dx = finite(direction.x, 0) / length;
  context.dy = finite(direction.y, 0) / length;
  context.dz = finite(direction.z, 0) / length;
  context.limit = maxDistance; context.best = maxDistance; context.record = null;
  context.excludeOwnerId = excludeOwnerId; context.season = season; context.stats = stats;
  return true;
}

export function semanticRayQueryHit(context) {
  return context.record && context.best < context.limit - SEMANTIC_RAY_EPS;
}

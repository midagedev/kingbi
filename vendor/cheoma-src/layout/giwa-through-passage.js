import { giwaFootprintMetrics } from './giwa-footprint.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Renderer-free opt-in contract for a real passage through the main bar of a
 * ㄷ-plan giwa building. Ordinary residential giwa remains unchanged.
 */
export function giwaThroughPassage(building = {}) {
  if (building?.throughPassage?.enabled !== true) return null;
  const footprint = giwaFootprintMetrics(building);
  if (footprint.planShape !== 'u') {
    throw new RangeError('giwa through-passage requires a u plan');
  }
  const requestedWidth = Number(building.throughPassage.width);
  const requestedHeight = Number(building.throughPassage.height);
  const requestedLeafAngle = Number(building.throughPassage.leafAngle);
  return Object.freeze({
    kind: 'middle-gate',
    centerX: 0,
    innerZ: footprint.b,
    outerZ: -footprint.b,
    width: clamp(Number.isFinite(requestedWidth) ? requestedWidth : 2.4, 1.8, 3.2),
    height: clamp(Number.isFinite(requestedHeight) ? requestedHeight : 2.35, 2.0, 2.7),
    leafAngle: clamp(Number.isFinite(requestedLeafAngle) ? requestedLeafAngle : 0.92, 0, 1.25),
  });
}

export function isGiwaThroughPassageBay(a, b, bayIndex, bayCount, passage) {
  if (!passage || bayCount < 1 || Math.abs(a.z - b.z) > 1e-7) return false;
  if (Math.abs(Math.abs(a.z) - Math.abs(passage.innerZ)) > 1e-7) return false;
  const t0 = bayIndex / bayCount;
  const t1 = (bayIndex + 1) / bayCount;
  const x0 = a.x + (b.x - a.x) * t0;
  const x1 = a.x + (b.x - a.x) * t1;
  return Math.min(x0, x1) <= passage.centerX + 1e-7
    && Math.max(x0, x1) >= passage.centerX - 1e-7;
}

export function isGiwaThroughPassageOuterEdge(a, b, passage) {
  return !!passage
    && Math.abs(a.z - b.z) <= 1e-7
    && Math.abs(a.z - passage.outerZ) <= 1e-7;
}

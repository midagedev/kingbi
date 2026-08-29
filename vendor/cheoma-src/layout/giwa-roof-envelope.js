import { computeSkeleton } from './skeleton.js';

const add = (a, b) => ({ x: a.x + b.x, z: a.z + b.z });
const scale = (point, value) => ({ x: point.x * value, z: point.z * value });
const negate = (point) => ({ x: -point.x, z: -point.z });
const normalize = (point) => {
  const length = Math.hypot(point.x, point.z) || 1;
  return { x: point.x / length, z: point.z / length };
};

const finite = (value, fallback) => (
  Number.isFinite(value) ? value : fallback
);

/**
 * Renderer-free source of truth for a straight-skeleton giwa roof's physical
 * tile-edge envelope. `buildSkeletonRoof()` consumes the returned skeleton and
 * vertices directly; planners use the same footprint/top instead of recreating
 * an axis-aligned overhang that omits convex-corner 안허리곡.
 */
export function giwaRoofEnvelope(footprint, options = {}) {
  const eaveOverhang = finite(options.eaveOverhang, 1.4);
  const planCurve = finite(options.planCurve, 0.35);
  const cornerLift = finite(options.cornerLift, 0.5);
  const eaveY = finite(options.eaveY, 0);
  const riseScale = finite(options.riseScale, 0.8);
  const ridgeH = finite(options.ridgeH, 0.4);
  if (!Array.isArray(footprint) || footprint.length < 4
    || eaveOverhang < 0 || planCurve < 0 || riseScale < 0 || ridgeH < 0) {
    throw new RangeError('giwa roof envelope requires a valid footprint and non-negative dimensions');
  }

  const skeleton = computeSkeleton(footprint);
  const { poly, edges } = skeleton;
  const eaveVertices = [];
  const eaveLifts = [];
  for (let index = 0; index < poly.length; index++) {
    const previousOutward = negate(edges[(index - 1 + poly.length) % poly.length].normal);
    const currentOutward = negate(edges[index].normal);
    const outwardSum = add(previousOutward, currentOutward);
    const bisector = normalize(outwardSum);
    const extra = edges[index].startConvex ? planCurve : 0;
    const offset = add(
      scale(outwardSum, eaveOverhang),
      scale(bisector, extra),
    );
    eaveVertices.push({
      x: poly[index].x + offset.x,
      z: poly[index].z + offset.z,
    });
    eaveLifts.push(edges[index].startConvex ? cornerLift : 0);
  }

  let maxSkeletonHeight = 0;
  for (const face of skeleton.faces) {
    for (const point of face.polygon) {
      if (Number.isFinite(point.h)) maxSkeletonHeight = Math.max(maxSkeletonHeight, point.h);
    }
  }
  const surfaceTopY = eaveY + maxSkeletonHeight * riseScale;
  return {
    skeleton,
    footprint: eaveVertices,
    eaveLifts,
    maxSkeletonHeight,
    surfaceTopY,
    topY: surfaceTopY + ridgeH,
  };
}

import * as G from '../core/math/geom2.js';

const TAU = Math.PI * 2;

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Stable expanding-ring search for the nearest usable clearing. The caller owns
// semantics through its predicate; this helper owns only deterministic ordering.
export function radialPlacementCandidates(
  preferred,
  { phase = 0, step, maxRadius, arcStep = step },
) {
  const candidates = [{ x: preferred.x, z: preferred.z }];
  const rings = Math.ceil(maxRadius / step);
  for (let ring = 1; ring <= rings; ring++) {
    const radius = ring * step;
    const count = Math.max(8, Math.ceil(TAU * radius / arcStep));
    const ringPhase = phase + ring * GOLDEN_ANGLE;
    for (let index = 0; index < count; index++) {
      const angle = ringPhase + index / count * TAU;
      candidates.push({
        x: preferred.x + Math.cos(angle) * radius,
        z: preferred.z + Math.sin(angle) * radius,
      });
    }
  }
  return candidates;
}

export function terrainRelief(site, point, sampleRadius, perimeterSamples) {
  let min = Infinity;
  let max = -Infinity;
  const sample = (x, z) => {
    const height = site.heightAt(x, z);
    min = Math.min(min, height);
    max = Math.max(max, height);
  };
  sample(point.x, point.z);
  for (let index = 0; index < perimeterSamples; index++) {
    const angle = index / perimeterSamples * TAU;
    sample(
      point.x + Math.cos(angle) * sampleRadius,
      point.z + Math.sin(angle) * sampleRadius,
    );
  }
  return max - min;
}

// Pads, parcel planning, and lightweight visual gates must agree on the whole
// footprint rather than sampling only corners. Irregular terrain can peak along
// an edge or inside a concave-looking bounding box even when every corner is
// acceptable; this shared dense sampler prevents renderer-only floating fixes.
export function terrainRangeOnPolygon(site, polygon, divisions = 5) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let min = Infinity, max = -Infinity;
  const sample = (point) => {
    const height = site.heightAt(point.x, point.z);
    min = Math.min(min, height);
    max = Math.max(max, height);
  };
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
    minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
    sample(a);
    sample({ x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 });
  }
  for (let xIndex = 0; xIndex <= divisions; xIndex++) {
    for (let zIndex = 0; zIndex <= divisions; zIndex++) {
      const point = {
        x: minX + (maxX - minX) * xIndex / divisions,
        z: minZ + (maxZ - minZ) * zIndex / divisions,
      };
      if (G.pointInPoly(point, polygon)) sample(point);
    }
  }
  return { min, max, range: max - min };
}

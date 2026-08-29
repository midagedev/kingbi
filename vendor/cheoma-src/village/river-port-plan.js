import { makeRng } from '../rng.js';
import { worldEdgeClearance } from './citywall-contour.js';
import { ROAD_WIDTH } from './roads.js';

function horizontalReach(site, z, side, clearance) {
  const limit = site.terrainR || site.R;
  let inside = 0, outside = limit;
  for (let distance = 2; distance <= limit; distance += 2) {
    if (worldEdgeClearance(site.edge, { x: side * distance, z }) >= clearance) inside = distance;
    else { outside = distance; break; }
  }
  for (let step = 0; step < 24; step++) {
    const middle = (inside + outside) * 0.5;
    if (worldEdgeClearance(site.edge, { x: side * middle, z }) >= clearance) inside = middle;
    else outside = middle;
  }
  return inside;
}

// A Han-scale channel divides settlement districts. The walled core may remain
// on the historically dominant north bank, while a modest ferry-port ward lives
// outside the wall on the south bank. This module owns only pure port geometry;
// the shared parcel planner still owns house fit, solar access, and collisions.
export function planRiverPort(site, seed) {
  if (site.stream?.kind !== 'river') return null;
  const rng = makeRng((seed ^ 0x71ae0f7) >>> 0);
  const landing = site.stream.southLanding;
  const bankRoadZ = landing.z + (site.R >= 400 ? 20 : 18);
  const edgeClearance = site.R >= 400 ? 28 : 22;
  const westReach = horizontalReach(site, bankRoadZ, -1, edgeClearance);
  const eastReach = horizontalReach(site, bankRoadZ, 1, edgeClearance);
  const desiredHalf = site.R >= 400 ? 104 : 68;
  const halfSpan = Math.min(desiredHalf, westReach - 10, eastReach - 10);
  if (halfSpan < 34) return null;

  const bankPoints = [];
  const segments = 8;
  const phase = rng.range(0, Math.PI * 2);
  for (let index = 0; index <= segments; index++) {
    const t = index / segments;
    bankPoints.push({
      x: -halfSpan + halfSpan * 2 * t,
      z: bankRoadZ + Math.sin(t * Math.PI * 2 + phase) * 1.8 * Math.sin(Math.PI * t),
    });
  }
  const bankJoin = bankPoints[Math.floor(bankPoints.length / 2)];
  const approach = [
    { ...landing },
    { x: landing.x, z: landing.z + (bankJoin.z - landing.z) * 0.48 },
    { ...bankJoin },
  ];
  const roads = [
    {
      id: 'port-000', level: 'soro', width: ROAD_WIDTH.soro,
      pts: bankPoints, junctionIds: [], riverPort: 'bank',
    },
    {
      id: 'port-001', level: 'golmok', width: ROAD_WIDTH.golmok,
      pts: approach, junctionIds: [], riverPort: 'landing',
    },
  ];
  const target = site.R >= 400 ? 10 : 4;
  const wardZ = bankRoadZ + ROAD_WIDTH.soro * 0.5 + 8.5;
  const wardFactors = site.R >= 400 ? [0.55] : [-0.48, 0.48];
  return {
    roads,
    bankRoadZ,
    halfSpan,
    // Hanyang's south floodplain is intentionally asymmetric: the east-side
    // alluvial shelf stays low while the west side rises into the front hill.
    // Keep the port on the real shelf instead of mirroring houses onto a slope.
    wards: wardFactors.map((factor, index) => ({
      x: halfSpan * factor,
      z: wardZ,
      target,
      seed: (seed ^ (0x71ad31 * (index + 1))) >>> 0,
    })),
  };
}

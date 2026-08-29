// Renderer-free seasonal ground carpet / litter plan (#219 / look-audit U4).
//
// Near-focus spring petal patches and autumn leaf piles are authored here as
// JSON-safe spots. Rendering lives in season-ground-carpet.js (one InstancedMesh).
// Aerial season reading is intentionally NOT this layer — paddies, canopy colour,
// and terrain ground mul own the far axes; falling particles keep physical widths
// and sleep beyond the detail band. FAR Points replicas are forbidden.
//
// Budget (document + gate):
//   draws: 1 InstancedMesh per active carpet (env litter and/or focus carpet)
//   points: 0
//   instances: ≤ MAX_INSTANCES per carpet
//   clump size: MIN_CLUMP_M … MAX_CLUMP_M (leaf/petal piles, not giant particles)

export const SEASON_GROUND_BUDGET = Object.freeze({
  draws: 1,
  points: 0,
  maxInstances: 420,
  minClumpM: 0.45,
  maxClumpM: 1.35,
  nearTreeCap: 64,
  // Per-tree near-trunk pile count (inclusive range before hard cap).
  treeSpotsMin: 6,
  treeSpotsMax: 10,
  // Yard / eave-corner wind piles (per corner site).
  cornerSpots: 12,
  // Focus-parcel perimeter + yard piles (no tree list required).
  focusPerimeterSpots: 56,
  focusCornerSpots: 8,
  focusMaxInstances: 180,
});

/** Spring pink petal carpet + autumn leaf litter only. Summer/winter stay empty. */
export function seasonGroundCarpetActive(season) {
  return season === 'spring' || season === 'autumn';
}

export function seasonGroundCarpetGoal(season) {
  return seasonGroundCarpetActive(season) ? 1 : 0;
}

/** Seeded LCG matching seasons.js litter stream (deterministic across harnesses). */
export function makeSeasonGroundRng(seed = 0x1234abcd) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Env-group litter under deciduous trees + house-yard corners.
 * bases: [{x,y,z,r}] tree foot discs sorted by plan caller (near-first preferred).
 * layout: { xEave?, zEave? } house eave half-extents.
 */
export function planEnvLitterSpots({ bases = [], layout = {}, seed = 0x1234abcd } = {}) {
  const B = SEASON_GROUND_BUDGET;
  const rnd = makeSeasonGroundRng(seed);
  const near = bases.slice(0, B.nearTreeCap);
  const treeSpots = [];
  const yardSpots = [];

  for (const b of near) {
    const r = Math.max(0.4, Number(b.r) || 1);
    const k = B.treeSpotsMin + Math.floor(rnd() * (B.treeSpotsMax - B.treeSpotsMin + 1));
    for (let i = 0; i < k; i++) {
      const rr = Math.sqrt(rnd()) * r * 1.55;
      const th = rnd() * Math.PI * 2;
      treeSpots.push({
        x: b.x + Math.cos(th) * rr,
        y: (Number.isFinite(b.y) ? b.y : 0) + 0.04,
        z: b.z + Math.sin(th) * rr,
        kind: 'tree',
      });
    }
  }

  const xE = (layout.xEave ?? 9) + 3;
  const zE = (layout.zEave ?? 6) + 3;
  // Yard corners + approach piles (wind-swept, not a full-yard carpet).
  const corners = [
    [-xE, -zE], [xE, -zE], [-xE, zE], [xE, zE],
    [0, zE + 2], [-xE * 0.6, zE + 1], [xE * 0.55, zE + 1.2],
  ];
  for (const [cx, cz] of corners) {
    for (let i = 0; i < B.cornerSpots; i++) {
      yardSpots.push({
        x: cx + (rnd() * 2 - 1) * 3.4,
        y: 0.05,
        z: cz + (rnd() * 2 - 1) * 3.4,
        kind: 'yard',
      });
    }
  }

  // Reserve yard piles under the instance cap so dense tree sites cannot erase
  // the courtyard season read (U4 near-focus).
  const yardKeep = Math.min(yardSpots.length, Math.max(48, Math.floor(B.maxInstances * 0.22)));
  const treeKeep = Math.min(treeSpots.length, B.maxInstances - yardKeep);
  const spots = treeSpots.slice(0, treeKeep).concat(yardSpots.slice(0, yardKeep));
  return finalizeSpots(spots, rnd, B.maxInstances);
}

/**
 * Focus-parcel carpet: wall skirt + yard corners only (no full-parcel high-density
 * instance carpet — issue #219 non-scope). Local parcel frame; caller applies matrix.
 */
export function planFocusLitterSpots({
  W = 12, D = 8, gateW = 2.4, seed = 0x7c11cafe,
} = {}) {
  const B = SEASON_GROUND_BUDGET;
  const rnd = makeSeasonGroundRng(seed);
  const spots = [];
  const halfW = Math.max(2, W * 0.5);
  const halfD = Math.max(2, D * 0.5);
  // Inset from wall line so piles sit in the grass skirt, not on the mud wall.
  const inset = 0.55;
  const x0 = -halfW + inset;
  const x1 = halfW - inset;
  const z0 = -halfD + inset;
  const z1 = halfD - inset;
  const gateHalf = Math.max(0.6, gateW * 0.55);

  // Perimeter samples (skip centre of south gate opening).
  const perim = B.focusPerimeterSpots;
  for (let i = 0; i < perim; i++) {
    const t = i / perim;
    let x, z;
    if (t < 0.25) {
      // south (+z) wall
      const u = (t / 0.25) * 2 - 1;
      x = u * halfW * 0.92;
      z = z1;
      if (Math.abs(x) < gateHalf) continue;
    } else if (t < 0.5) {
      const u = ((t - 0.25) / 0.25);
      x = x1;
      z = z1 + (z0 - z1) * u;
    } else if (t < 0.75) {
      const u = ((t - 0.5) / 0.25);
      x = x1 + (x0 - x1) * u;
      z = z0;
    } else {
      const u = ((t - 0.75) / 0.25);
      x = x0;
      z = z0 + (z1 - z0) * u;
    }
    spots.push({
      x: x + (rnd() * 2 - 1) * 0.35,
      y: 0.04,
      z: z + (rnd() * 2 - 1) * 0.35,
      kind: 'skirt',
    });
  }

  // Courtyard corners (wind piles) — sparse, not a filled carpet.
  const corners = [
    [x0 + 0.8, z0 + 0.8], [x1 - 0.8, z0 + 0.8],
    [x0 + 0.8, z1 - 1.1], [x1 - 0.8, z1 - 1.1],
  ];
  for (const [cx, cz] of corners) {
    for (let i = 0; i < B.focusCornerSpots; i++) {
      spots.push({
        x: cx + (rnd() * 2 - 1) * 1.1,
        y: 0.045,
        z: cz + (rnd() * 2 - 1) * 1.1,
        kind: 'yard',
      });
    }
  }

  return finalizeSpots(spots, rnd, B.focusMaxInstances);
}

function finalizeSpots(spots, rnd, maxInstances) {
  const B = SEASON_GROUND_BUDGET;
  const out = [];
  const n = Math.min(spots.length, maxInstances);
  for (let i = 0; i < n; i++) {
    const s = spots[i];
    const size = B.minClumpM + rnd() * (B.maxClumpM - B.minClumpM);
    out.push({
      x: s.x,
      y: s.y,
      z: s.z,
      kind: s.kind,
      // reveal threshold for progressive accumulation (0..1)
      rev: rnd(),
      rot: rnd() * Math.PI * 2,
      size,
      tiltX: (rnd() * 2 - 1) * 0.12,
      tiltZ: (rnd() * 2 - 1) * 0.12,
    });
  }
  return out;
}

/** Palette + atlas frame policy for a season (renderer-free description). */
export function seasonGroundPalette(season) {
  if (season === 'spring') {
    return Object.freeze({
      season: 'spring',
      // Mostly cherry petal silhouette (atlas frame 0).
      frames: Object.freeze([0, 0, 0, 0, 0, 1]),
      colors: Object.freeze([0xf3c4d6, 0xf0b0c8, 0xe79bbf, 0xfad9e6, 0xffd0dd, 0xffe3ec]),
    });
  }
  // Autumn leaf litter (ginkgo / maple / warm brown frames).
  return Object.freeze({
    season: 'autumn',
    frames: Object.freeze([1, 2, 0, 1, 2, 1]),
    colors: Object.freeze([
      0xf2c53d, 0xf0b429, 0xe8b21f, // ginkgo gold
      0xc0392b, 0xd35400, 0xb83a1e, 0xd9622b, // maple
      0xc98a3a, 0x9a6b2e, 0xc0632f, 0xb5502a, // warm brown
    ]),
  });
}

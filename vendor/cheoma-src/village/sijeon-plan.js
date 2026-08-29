import * as G from '../core/math/geom2.js';
import { hashString } from '../rng.js';

// Renderer-free sijeon (licensed-market row) contract.
//
// Placement keeps the legacy pitch/depth/setback/runCap number path and inserts
// product-owned row breaks so long arterial façades do not read as one infinite
// copy-paste roof (GitHub #218, scope (a) 줄 분절). The facade plan uses local
// coordinates centred on the planned shop:
//   +x = along the row, +z = road/front, +y = up.
// Renderers may merge shop records, but must not build solid mass for `kind:
// 'break'` footprints, infer a second footprint, or move solid storage/wall mass
// into the road-side corridor. Break polygons stay in the plan so residential
// parcels cannot fill the reserved market corridor.

export const SIJEON_PLACEMENT = Object.freeze({
  pitch: 6.2,
  depth: 8.5,
  setback: 1.4,
  runCap: 26,
  // Product segmentation (#218a). Interval is not a measured historical bay
  // count: sources confirm long arterial rows and kan-unit use, not a universal
  // roof-break period. One pitch of empty reserved footprint separates blocks so
  // eaves (body + 1.4 m) no longer bridge across the gap.
  segmentShops: 5,
  segmentGapPitches: 1,
});

export const SIJEON_FACADE_SCHEMA_VERSION = 2;
export const SIJEON_FACADE_BAYS = 2;

// Product sparseness for decorative marker boards — not a historical frequency.
export const SIJEON_SIGN_POLICY = Object.freeze({
  maxShare: 0.28,
  maxPerShop: 1,
  emissive: false,
  materialRole: 'frame',
  silhouettes: Object.freeze(['tablet', 'plank']),
});
export const SIJEON_KIND_SHOP = 'shop';
export const SIJEON_KIND_BREAK = 'break';

const BODY_HEIGHT = 3;
const MIN_WIDTH = 4.4;
const MIN_DEPTH = 5.6;
const SIGN_HANG_GAP = 0.05;
const SIGN_THICKNESS = 0.05;

function finiteDimension(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`sijeon ${name} must be finite`);
  if (value <= 0) throw new RangeError(`sijeon ${name} must be positive`);
  return value;
}

function box(role, x, y, z, width, height, depth, extra = {}) {
  return {
    role,
    center: { x, y, z },
    size: { width, height, depth },
    ...extra,
  };
}

/** True when the record owns a rendered two-bay shop mass. */
export function isSijeonShop(record) {
  return !!record && record.kind !== SIJEON_KIND_BREAK;
}

function footprintRecord(base, tan, inward, pitch, depth, id, kind) {
  const poly = G.frontageParcel(base, tan, inward, pitch * 0.5, depth, 0);
  return {
    id,
    kind,
    poly,
    center: G.polyCentroid(poly),
    frontDir: G.norm(G.mul(inward, -1)),
    x: base.x,
    z: base.z,
    w: pitch,
    d: depth,
  };
}

function annotateSegment(members, segmentId) {
  const length = members.length;
  if (!length) return;
  for (let index = 0; index < length; index++) {
    const role = length === 1 ? 'solo'
      : index === 0 ? 'start'
        : index === length - 1 ? 'end'
          : 'mid';
    members[index].segment = Object.freeze({
      id: segmentId,
      index,
      length,
      role,
    });
  }
}

/**
 * Place market-row footprints along arterial (daero) façades.
 *
 * Continuous shop runs are capped into product blocks of `segmentShops` units,
 * separated by `segmentGapPitches` reserved empty footprints (`kind: 'break'`).
 * Breaks stay in the returned array so village planning can keep them as parcel
 * blockers without drawing shop mass.
 *
 * `char01` remains in the signature because the village planner already passes
 * it, although placement never consumes it. Keeping that no-op input avoids
 * changing callers or the downstream random stream.
 */
export function planSijeon(roadsResult, site, _char01 = 0.5) {
  const shops = [];
  const arterials = (roadsResult?.roads || []).filter((road) => road.level === 'daero');
  const {
    pitch,
    depth,
    setback,
    runCap,
    segmentShops,
    segmentGapPitches,
  } = SIJEON_PLACEMENT;
  const bowlR = site.bowlR;
  const others = (road) => arterials.filter((candidate) => candidate !== road);
  let sid = 0;
  let segmentSerial = 0;

  for (const road of arterials) {
    const fine = G.resample(road.pts, pitch);
    if (fine.length < 8) continue;
    const halfRoadWidth = road.width / 2;
    const crossingArterials = others(road);
    for (let side = 1; side >= -1; side -= 2) {
      let run = 0;
      let consecutiveShops = 0;
      let openSegment = [];
      let pendingBreakPitches = 0;

      const flushSegment = () => {
        if (!openSegment.length) return;
        annotateSegment(openSegment, `seg${segmentSerial++}`);
        openSegment = [];
      };

      for (let i = 3; i < fine.length - 3 && run < runCap; i++) {
        const sample = fine[i];
        if (G.dist(sample.pt, site.center) > bowlR * 0.9) {
          // Natural hole in the bowl — close the current block without inventing a break.
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = 0;
          continue;
        }
        const inward = G.mul(G.perpL(sample.tan), side);
        const base = G.add(sample.pt, G.mul(inward, halfRoadWidth + setback));
        let clashes = false;
        for (const other of crossingArterials) {
          if (G.distToPolyline(base, other.pts).d < other.width / 2 + depth) {
            clashes = true;
            break;
          }
        }
        if (clashes) {
          // Crossing-arterial clearance already opens a large gap; start a new block after it.
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = 0;
          continue;
        }

        if (pendingBreakPitches > 0) {
          shops.push(footprintRecord(
            base,
            sample.tan,
            inward,
            pitch,
            depth,
            `s${sid++}`,
            SIJEON_KIND_BREAK,
          ));
          run++;
          pendingBreakPitches--;
          continue;
        }

        const shop = footprintRecord(
          base,
          sample.tan,
          inward,
          pitch,
          depth,
          `s${sid++}`,
          SIJEON_KIND_SHOP,
        );
        shops.push(shop);
        openSegment.push(shop);
        consecutiveShops++;
        run++;

        if (consecutiveShops >= segmentShops) {
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = segmentGapPitches;
        }
      }
      flushSegment();
    }
  }
  return shops;
}

/**
 * Derive a restrained two-bay shop facade from one placement record.
 *
 * The output is plain serializable data. It describes only physical members;
 * materials, textures, Three.js objects, merge strategy, and LOD remain renderer
 * concerns. Eaves are the sole planned solid allowed beyond `streetEdgeZ`.
 * Break footprints have no facade — callers must filter with `isSijeonShop`.
 */

function planSparseSigns(shop, { bayWidth, lintels, frontZ }) {
  const id = shop?.id;
  if (id == null || id === '') return [];
  const h = hashString(`sijeon-sign|${String(id)}`);
  const unit = ((h >>> 8) & 0xffffff) / 0x1000000;
  if (unit >= SIJEON_SIGN_POLICY.maxShare) return [];
  const bay = h & 1;
  const silhouette = SIJEON_SIGN_POLICY.silhouettes[(h >>> 1) & 1];
  const lintel = lintels[bay];
  if (!lintel) return [];
  const lintelBottom = lintel.center.y - lintel.size.height / 2;
  const centerZ = frontZ - SIGN_THICKNESS / 2;
  const centerX = lintel.center.x;
  if (silhouette === 'plank') {
    const width = Math.min(bayWidth * 0.42, lintel.size.width * 0.55);
    const height = 0.16;
    const centerY = lintelBottom - SIGN_HANG_GAP - height / 2;
    return [box('marker-board', centerX, centerY, centerZ, width, height, SIGN_THICKNESS, {
      bay, silhouette: 'plank', mount: 'lintel-hang', decorative: true, emissive: false,
    })];
  }
  const width = 0.3;
  const height = 0.58;
  const centerY = lintelBottom - SIGN_HANG_GAP - height / 2;
  return [box('marker-board', centerX, centerY, centerZ, width, height, SIGN_THICKNESS, {
    bay, silhouette: 'tablet', mount: 'lintel-hang', decorative: true, emissive: false,
  })];
}

export function planSijeonFacade(shop) {
  if (shop?.kind === SIJEON_KIND_BREAK) {
    throw new RangeError('sijeon break footprints have no facade mass');
  }
  const lotWidth = finiteDimension(shop?.w, 'width');
  const lotDepth = finiteDimension(shop?.d, 'depth');
  if (lotWidth < MIN_WIDTH) {
    throw new RangeError(`sijeon width must be at least ${MIN_WIDTH}m for two bays`);
  }
  if (lotDepth < MIN_DEPTH) {
    throw new RangeError(`sijeon depth must be at least ${MIN_DEPTH}m`);
  }

  // Preserve the former visible mass while replacing its blank front wall.
  const width = lotWidth * 0.96;
  const depth = lotDepth * 0.86;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const streetEdgeZ = lotDepth / 2;
  const frontZ = halfDepth;
  const backZ = -halfDepth;
  const bayWidth = width / SIJEON_FACADE_BAYS;

  const columnWidth = Math.min(0.26, bayWidth * 0.1);
  const columnDepth = 0.26;
  const columnHeight = BODY_HEIGHT - 0.22;
  const columnZ = frontZ - columnDepth / 2;
  const columnInset = columnWidth / 2;
  const columns = [-halfWidth + columnInset, 0, halfWidth - columnInset]
    .map((x, index) => box(
      'front-column',
      x,
      columnHeight / 2,
      columnZ,
      columnWidth,
      columnHeight,
      columnDepth,
      { index },
    ));

  const lintelHeight = 0.28;
  const lintelDepth = 0.3;
  const lintelWidth = bayWidth - columnWidth;
  const lintelY = columnHeight - lintelHeight / 2;
  const lintels = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'front-lintel',
    x,
    lintelY,
    frontZ - lintelDepth / 2,
    lintelWidth,
    lintelHeight,
    lintelDepth,
    { bay },
  ));

  const openingRecess = 0.46;
  const openingDepth = 0.12;
  const openingWidth = bayWidth - columnWidth * 1.55;
  const openingSill = 0.22;
  const openingTop = lintelY - lintelHeight / 2 - 0.08;
  const openingHeight = openingTop - openingSill;
  // 판문(plank shutter): 개구 한 짝을 밖으로 접어 세운 널문. 발굴이 확인한 것은 기둥·마룻장과 함께
  //   "문짝"을 갖춘 목조건축이므로(서울역사박물관 청진동 유구), 개구를 빈 공동으로 남기면 사료가
  //   확인한 부재를 지우고 현대 쇼윈도·동굴로 읽힌다(docs/sijeon.md §3.2-4, architectural-
  //   authenticity.md §7.5 W2-3). 기둥 뒷면과 후퇴 배면 사이에 한 장 서므로 가로 진입로(streetEdgeZ)
  //   밖으로 나가지 않고, 남은 개구 폭으로는 배면 목재 면이 그대로 보인다.
  //   좌우 칸은 각각 바깥쪽으로 접혀 결정론적이다 — 칸별 난수 없음.
  const panelThickness = 0.07;
  const panelZ = frontZ - columnDepth - 0.04;
  const panelWidth = openingWidth * 0.44;
  const openings = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'recessed-opening',
    x,
    openingSill + openingHeight / 2,
    frontZ - openingRecess - openingDepth / 2,
    openingWidth,
    openingHeight,
    openingDepth,
    {
      bay,
      recessed: true,
      panel: box(
        'plank-shutter',
        x + (bay === 0 ? -1 : 1) * (openingWidth - panelWidth) / 2,
        openingSill + openingHeight / 2,
        panelZ,
        panelWidth,
        openingHeight,
        panelThickness,
        { bay, side: bay === 0 ? -1 : 1 },
      ),
    },
  ));

  const benchHeight = 0.58;
  const benchDepth = Math.min(0.62, lotDepth * 0.075);
  const benchWidth = openingWidth * 0.88;
  const benchFrontZ = Math.min(streetEdgeZ, frontZ + benchDepth * 0.48);
  const benches = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'display-bench',
    x,
    benchHeight / 2,
    benchFrontZ - benchDepth / 2,
    benchWidth,
    benchHeight,
    benchDepth,
    { bay },
  ));

  const storageDepth = Math.min(2.5, depth * 0.34);
  const storageClearance = 0.16;
  const storage = box(
    'rear-storage',
    0,
    (BODY_HEIGHT - 0.22) / 2,
    backZ + storageDepth / 2,
    width - storageClearance * 2,
    BODY_HEIGHT - 0.22,
    storageDepth,
  );

  const roofWidth = width + 1.4;
  const roofDepth = depth + 1.6;
  const roof = {
    role: 'gable-roof',
    center: { x: 0, y: BODY_HEIGHT, z: 0 },
    width: roofWidth,
    depth: roofDepth,
    rise: 1.7,
    eaveProjection: {
      side: (roofWidth - width) / 2,
      front: Math.max(0, roofDepth / 2 - streetEdgeZ),
      rear: Math.max(0, roofDepth / 2 - lotDepth / 2),
    },
  };

  const signs = planSparseSigns(shop, { bayWidth, lintels, frontZ });

  return {
    schemaVersion: SIJEON_FACADE_SCHEMA_VERSION,
    bayCount: SIJEON_FACADE_BAYS,
    axis: { front: { x: 0, z: 1 } },
    lot: {
      width: lotWidth,
      depth: lotDepth,
      bounds: {
        minX: -lotWidth / 2,
        maxX: lotWidth / 2,
        minZ: -lotDepth / 2,
        maxZ: streetEdgeZ,
      },
    },
    building: {
      width,
      depth,
      height: BODY_HEIGHT,
      bounds: {
        minX: -halfWidth,
        maxX: halfWidth,
        minZ: backZ,
        maxZ: frontZ,
      },
    },
    corridor: {
      streetEdgeZ,
      maxNonEaveZ: streetEdgeZ,
      maxEaveZ: roofDepth / 2,
    },
    columns,
    lintels,
    openings,
    benches,
    storage,
    roof,
    signs,
    // Optional placement context — present when the shop came from planSijeon.
    segment: shop?.segment ?? null,
  };
}

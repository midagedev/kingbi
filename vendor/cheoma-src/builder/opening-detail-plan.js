import { OPENING_FACE_CLEARANCE } from '../core/surface-clearance.js';
import { deepFreeze, normalizeStableSeed } from '../core/stable-seed.js';
import { hashString } from '../rng.js';

// Renderer-free changho detail grammar. Coordinates are local to one opening:
// +u runs along the facade, +y is up from the opening sill, and +outward points
// out of the building. Builders provide only that basis; interaction and props
// can later consume the same pivot/entrance anchors without importing Three.

export const OPENING_DETAIL_KINDS = Object.freeze(['door', 'window']);
export const OPENING_DETAIL_STYLES = Object.freeze(['palace', 'temple', 'giwa', 'choga']);

// Residential taxonomy (#150 B / AURI 판문·살문·고정창·들창). `kind` remains the
// coarse door/window function; `type` names the leaf construction.
export const OPENING_DETAIL_TYPES = Object.freeze([
  'panel',         // 판문 — solid plank door leaf
  'salmun',        // 살문 — lattice + hanji door leaf
  'fixed-window',  // 고정창
  'lift-window',   // 들창 (product default motion is still fixed)
]);

// Lawful motion modes. Product interaction is narrower than the vocabulary:
// only a primary door with hinge motion is interactive; windows stay fixed.
export const OPENING_MOTION_MODES = Object.freeze(['fixed', 'hinge', 'lift']);

// Thin leaf surface hint for shared materials — no Three, no new program family.
// panel → solid wood board; sal → lattice/hanji door or salchang texture.
export const OPENING_LEAF_SURFACES = Object.freeze(['panel', 'sal']);

const DOOR_TYPES = new Set(['panel', 'salmun']);
const WINDOW_TYPES = new Set(['fixed-window', 'lift-window']);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function defaultLeafCount(kind, width) {
  if (kind === 'window') return width >= 0.95 ? 2 : 1;
  if (width > 3.2) return 4;
  if (width > 1.9) return 3;
  return width > 1.05 ? 2 : 1;
}

function box(kind, u, y, width, height, depth, outward) {
  return { kind, shape: 'box', u, y, width, height, depth, outward };
}

function defaultOpeningType(kind) {
  return kind === 'door' ? 'salmun' : 'fixed-window';
}

/**
 * Resolve and validate the residential opening type against `kind`.
 * Explicit input wins; defaults keep today's sal door / fixed window look.
 */
export function resolveOpeningDetailType(kind, input = {}) {
  const raw = input.type ?? input.openingType;
  const type = raw == null ? defaultOpeningType(kind) : raw;
  if (!OPENING_DETAIL_TYPES.includes(type)) {
    throw new Error(`Unknown opening type: ${type}`);
  }
  if (kind === 'door' && !DOOR_TYPES.has(type)) {
    throw new Error(`opening type ${type} is not lawful for a door`);
  }
  if (kind === 'window' && !WINDOW_TYPES.has(type)) {
    throw new Error(`opening type ${type} is not lawful for a window`);
  }
  return type;
}

/**
 * Resolve lawful motion for one opening. Product rules:
 * - only a primary door may claim hinge
 * - windows never claim hinge; lift-window defaults to fixed (lift is explicit only)
 * - interactive is true only for primary door + hinge
 */
export function resolveOpeningDetailMotion(kind, type, primary, input = {}) {
  const requested = input.motion == null
    ? null
    : (typeof input.motion === 'string' ? input.motion : input.motion.mode);
  if (requested != null && !OPENING_MOTION_MODES.includes(requested)) {
    throw new Error(`Unknown opening motion: ${requested}`);
  }

  if (kind === 'window') {
    if (requested === 'hinge') {
      throw new Error('window may not claim hinge motion');
    }
    if (type === 'fixed-window') {
      if (requested != null && requested !== 'fixed') {
        throw new Error(`fixed-window may only use fixed motion, got ${requested}`);
      }
      return { mode: 'fixed', interactive: false };
    }
    // lift-window: lift is lawful vocabulary but product default is fixed and
    // never interactive (no product window runtime).
    if (requested != null && requested !== 'fixed' && requested !== 'lift') {
      throw new Error(`lift-window may only use fixed or lift motion, got ${requested}`);
    }
    return {
      mode: requested === 'lift' ? 'lift' : 'fixed',
      interactive: false,
    };
  }

  // door: panel | salmun
  if (requested === 'lift') {
    throw new Error('door may not claim lift motion');
  }
  if (primary) {
    const mode = requested === 'fixed' ? 'fixed' : 'hinge';
    return { mode, interactive: mode === 'hinge' };
  }
  if (requested === 'hinge') {
    throw new Error('only a primary door may claim hinge motion');
  }
  return { mode: 'fixed', interactive: false };
}

export function leafSurfaceForOpeningType(type) {
  return type === 'panel' ? 'panel' : 'sal';
}

/**
 * Fail closed over a building's planned openings: at most one primary door,
 * and no window may carry hinge motion (also enforced at plan time).
 */
export function assertLawfulOpeningDetailSet(plans = []) {
  if (!Array.isArray(plans)) {
    throw new Error('opening detail set must be an array');
  }
  let primaryDoors = 0;
  for (const plan of plans) {
    if (!plan || typeof plan !== 'object') {
      throw new Error('opening detail set contains a non-plan entry');
    }
    if (plan.kind === 'window') {
      const mode = plan.motion?.mode;
      if (mode === 'hinge' || plan.interactive === true) {
        throw new Error('window may not claim hinge motion or interactive product control');
      }
      if (plan.primary === true) {
        throw new Error('window may not be a primary entrance');
      }
    }
    if (plan.kind === 'door' && plan.primary === true) {
      primaryDoors += 1;
    }
  }
  if (primaryDoors > 1) {
    throw new Error(`building may not have multiple primary doors (found ${primaryDoors})`);
  }
  return true;
}

/**
 * Return an immutable, JSON-safe opening specification. `footwear` is an
 * authored landing point relative to the opening sill; this pass records it
 * but deliberately does not render footwear or own interaction state.
 */
export function planOpeningDetail(input = {}) {
  const kind = input.kind || 'window';
  const style = input.style || 'giwa';
  if (!OPENING_DETAIL_KINDS.includes(kind)) throw new Error(`Unknown opening kind: ${kind}`);
  if (!OPENING_DETAIL_STYLES.includes(style)) throw new Error(`Unknown opening style: ${style}`);

  // Residential bay multipliers can deliberately make a very small 봉창.
  // Keep the detail grammar transparent to that upstream width contract rather
  // than silently widening the frame beyond its rendered leaf.
  const width = clamp(finite(input.width, kind === 'door' ? 1.0 : 0.6), 0.08, 6.4);
  const height = clamp(finite(input.height, kind === 'door' ? 1.8 : 0.6), 0.32, 4.8);
  const wallThickness = clamp(finite(input.wallThickness, 0.12), 0.04, 0.4);
  const leafCount = clamp(
    Math.round(finite(input.leafCount, defaultLeafCount(kind, width))),
    1,
    kind === 'door' ? 4 : 2,
  );
  if (kind === 'window' && input.primary === true) {
    throw new Error('window may not be a primary entrance');
  }
  const primary = kind === 'door' && input.primary === true;
  const type = resolveOpeningDetailType(kind, input);
  const motion = resolveOpeningDetailMotion(kind, type, primary, input);
  const leafSurface = leafSurfaceForOpeningType(type);
  const seed = normalizeStableSeed(input.seed);
  if (kind === 'door' && input.meoreumHeight != null) {
    throw new Error('meoreumHeight belongs to a window; use lowerPanelHeight for a door leaf');
  }
  if (kind === 'window' && input.lowerPanelHeight != null) {
    throw new Error('lowerPanelHeight belongs to a door leaf; use meoreumHeight for a window');
  }
  const defaultMeoreum = { palace: 0.28, temple: 0.24, giwa: 0.22, choga: 0.12 }[style];
  const meoreumHeight = kind === 'window'
    ? clamp(finite(input.meoreumHeight, defaultMeoreum), 0, Math.min(1.2, height * 1.2))
    : 0;
  const lowerPanelHeight = kind === 'door'
    ? clamp(
      finite(input.lowerPanelHeight, style === 'choga' ? height * 0.12 : height * 0.2),
      0,
      height * 0.38,
    )
    : 0;

  const frameWidth = clamp(Math.min(width, height) * 0.055, 0.045, 0.085);
  const frameDepth = style === 'choga' ? 0.035 : 0.045;
  const face = wallThickness * 0.5 + OPENING_FACE_CLEARANCE;
  const frameOutward = face + frameDepth * 0.5;
  const leafBottom = frameWidth;
  const leafTop = height - frameWidth;
  const leafHeight = Math.max(frameWidth, leafTop - leafBottom);
  const assemblyBottom = kind === 'window' ? -meoreumHeight : 0;
  const assemblyHeight = height - assemblyBottom;

  const frameParts = [
    box('jamb-left', -width * 0.5 + frameWidth * 0.5, assemblyBottom + assemblyHeight * 0.5,
      frameWidth, assemblyHeight, frameDepth, frameOutward),
    box('jamb-right', width * 0.5 - frameWidth * 0.5, assemblyBottom + assemblyHeight * 0.5,
      frameWidth, assemblyHeight, frameDepth, frameOutward),
    box('head', 0, height - frameWidth * 0.5,
      width, frameWidth, frameDepth, frameOutward),
  ];
  if (kind === 'window') {
    if (meoreumHeight > frameWidth * 0.5) {
      const apronHeight = meoreumHeight - frameWidth * 0.5;
      frameParts.push(box(
        'meoreum-apron', 0, -(meoreumHeight + frameWidth * 0.5) * 0.5,
        Math.max(frameWidth, width - frameWidth * 2), apronHeight,
        frameDepth * 0.72, frameOutward - frameDepth * 0.08,
      ));
      frameParts.push(box('meoreum-rail', 0, 0,
        width, frameWidth, frameDepth, frameOutward));
    } else {
      frameParts.push(box('sill', 0, frameWidth * 0.5,
        width, frameWidth, frameDepth, frameOutward));
    }
  } else if (lowerPanelHeight > frameWidth * 0.5) {
    frameParts.push(box('lower-panel-rail', 0, lowerPanelHeight,
      width, frameWidth, frameDepth, frameOutward));
  }
  for (let leaf = 1; leaf < leafCount; leaf++) {
    frameParts.push(box(
      'leaf-seam',
      -width * 0.5 + width * leaf / leafCount,
      leafBottom + leafHeight * 0.5,
      frameWidth * 0.58,
      leafHeight,
      frameDepth * 0.72,
      frameOutward + frameDepth * 0.14,
    ));
  }

  const thresholdDepth = kind === 'door' ? (style === 'choga' ? 0.16 : 0.2) : 0;
  const threshold = kind === 'door' ? box(
    'threshold', 0, frameWidth * 0.42,
    width + frameWidth * 0.8, frameWidth * 0.84, thresholdDepth,
    face + thresholdDepth * 0.5,
  ) : null;

  const hardware = [];
  // Hardware identity belongs to the opening, not its current editor width.
  // Keeping the hinge side stable prevents the moving leaf, ring, and straps
  // from jumping to the opposite jamb during a continuous width preview.
  const hash = hashString(`${seed}|${style}|${kind}|hinge`);
  const hingeSide = (hash & 1) === 0 ? -1 : 1;
  let pivot = null;
  let footwearAnchor = null;
  let focusAnchor = null;
  // Night-light consumers need the renderer-authored changho surface for every
  // opening, including secondary doors and windows. Keep this fixed on the
  // exterior panel plane; it must never inherit the active leaf's offset.
  const glowAnchor = {
    u: 0,
    y: height * 0.5,
    outward: face,
  };
  // Primary entrance owns focus/footwear regardless of motion. Hinge pivot and
  // ironwork attach only when the lawful motion is interactive hinge.
  if (primary) {
    const leafWidth = width / leafCount;
    const pivotU = hingeSide * width * 0.5;
    const leafCenterU = hingeSide * (width * 0.5 - leafWidth * 0.5);
    const leafOutward = clamp(finite(input.leafOutward, 0), -0.2, 0.2);
    const meetingU = hingeSide < 0
      ? -width * 0.5 + leafWidth
      : width * 0.5 - leafWidth;

    if (motion.mode === 'hinge') {
      // The moving leaf ends exactly on its hinge axis. Keeping the pivot on the
      // outer leaf edge prevents an inset sliver from sweeping through the jamb.
      const strapLength = clamp(leafWidth * 0.27, 0.11, style === 'palace' ? 0.25 : 0.18);
      const strapU = hingeSide * (width * 0.5 - frameWidth - strapLength * 0.5);
      const hardwareDepth = 0.018;
      const hardwareOutward = face + frameDepth + hardwareDepth * 0.5 + 0.004;
      for (const ratio of [0.25, 0.76]) {
        hardware.push(box(
          'hinge-strap', strapU, leafBottom + leafHeight * ratio,
          strapLength, 0.035, hardwareDepth, hardwareOutward,
        ));
      }
      // The measured source is a palace door. Civilian and temple styles keep a
      // quieter product-level subset (two small straps + one ring) rather than
      // inheriting the visible palace pivot-cap vocabulary as if it were evidence.
      if (style === 'palace') {
        for (const ratio of [0.08, 0.92]) {
          hardware.push({
            kind: 'pivot-cap',
            shape: 'cylinder',
            u: pivotU,
            y: leafBottom + leafHeight * ratio,
            radius: 0.025,
            depth: 0.036,
            outward: hardwareOutward,
          });
        }
      }
      hardware.push({
        kind: 'ring-handle',
        shape: 'torus',
        u: meetingU + hingeSide * 0.08,
        y: leafBottom + leafHeight * 0.54,
        radius: clamp(leafWidth * 0.09, 0.045, 0.075),
        tube: 0.009,
        outward: hardwareOutward + 0.016,
      });
      pivot = {
        u: pivotU,
        y: leafBottom,
        axis: { u: 0, y: 1, outward: 0 },
        hingeSide,
        outward: leafOutward,
        leafWidth,
        leafCenterU,
        meetingU,
        leafHeight,
        maxAngle: Math.PI * 0.52,
      };
    }
    const footwear = input.footwear || {};
    footwearAnchor = {
      u: clamp(finite(footwear.u, 0), -width * 0.4, width * 0.4),
      y: finite(footwear.y, 0),
      outward: Math.max(
        thresholdDepth + 0.12,
        finite(footwear.outward, thresholdDepth + 0.28),
      ),
      surface: typeof footwear.surface === 'string' && footwear.surface
        ? footwear.surface
        : 'threshold',
      // Optional renderer-free landing guidance. It stays in the opening's
      // local +u basis, so rotations and mirrored house transforms preserve
      // the intended physical side without a world-axis special case.
      clearSide: footwear.clearSide === -1 || footwear.clearSide === 1
        ? footwear.clearSide
        : null,
    };
    // Optical focus belongs to the fixed portal plane, never the moving leaf.
    focusAnchor = {
      u: 0,
      y: height * 0.5,
      outward: face,
    };
  }

  return deepFreeze({
    version: 6,
    id: `opening-${hashString(`${seed}|${kind}|${style}`).toString(16)}`,
    seed,
    kind,
    style,
    type,
    leafSurface,
    motion: {
      mode: motion.mode,
      interactive: motion.interactive,
    },
    interactive: motion.interactive,
    primary,
    width,
    height,
    wallThickness,
    leafCount,
    meoreum: {
      height: meoreumHeight,
      apertureSillY: 0,
      apronBottomY: -meoreumHeight,
    },
    lowerPanel: { height: lowerPanelHeight, railY: lowerPanelHeight },
    reveal: {
      depth: wallThickness * 0.5,
      faceClearance: OPENING_FACE_CLEARANCE,
      face,
    },
    frame: { width: frameWidth, depth: frameDepth, parts: frameParts },
    threshold,
    hardware,
    anchors: { pivot, footwear: footwearAnchor, focus: focusAnchor, glow: glowAnchor },
  });
}

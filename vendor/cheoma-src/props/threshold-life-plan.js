import { deepFreeze, normalizeStableSeed } from '../core/stable-seed.js';
import { makeRng, hashString } from '../rng.js';

export const THRESHOLD_FOOTWEAR_KINDS = Object.freeze(['jipsin', 'namaksin']);
export const THRESHOLD_SURFACE_CONDITIONS = Object.freeze(['dry', 'wet']);

const stableMetric = (value) => Number(value).toFixed(9);

function footprintBounds(item) {
  const c = Math.abs(Math.cos(item.yaw));
  const s = Math.abs(Math.sin(item.yaw));
  const halfU = (item.width * c + item.length * s) * 0.5;
  const halfOutward = (item.width * s + item.length * c) * 0.5;
  return {
    uMin: item.u - halfU,
    uMax: item.u + halfU,
    outwardMin: item.outward - halfOutward,
    outwardMax: item.outward + halfOutward,
  };
}

/**
 * Plan one restrained pair beside a residential primary entrance.
 *
 * Coordinates share opening-detail-plan's +u/+y/+outward basis. The pair sits
 * beyond one jamb, so neither the threshold nor the clear opening owns the same
 * floor patch. The plan is renderer-free, JSON-safe and
 * immutable; the focused-house overlay owns its visibility and lifecycle.
 */
export function planThresholdLife(input = {}) {
  const opening = input.opening;
  if (!opening?.primary || opening.kind !== 'door' || !opening.anchors?.footwear) return null;
  if (!['giwa', 'choga'].includes(opening.style)) return null;

  const condition = THRESHOLD_SURFACE_CONDITIONS.includes(input.condition)
    ? input.condition
    : 'dry';
  const seed = normalizeStableSeed(input.seed ?? `${opening.seed}:threshold-life`);
  const rng = makeRng(hashString(`${seed}|${opening.id}|${condition}`));
  // A wet landing has the wooden rain shoe evidenced by museum material. Dry
  // residential defaults stay with the widespread straw shoe; this avoids
  // turning a weather-specific object into a generic status ornament.
  const kind = condition === 'wet' ? 'namaksin' : 'jipsin';
  const length = kind === 'namaksin'
    ? (0.242 + rng.range(-0.012, 0.012))
    : (0.255 + rng.range(-0.013, 0.013));
  const width = kind === 'namaksin'
    ? (0.084 + rng.range(-0.004, 0.004))
    : (0.095 + rng.range(-0.005, 0.005));
  const height = kind === 'namaksin' ? 0.072 : 0.035;
  const gap = kind === 'namaksin' ? 0.026 : 0.022;
  const pairWidth = width * 2 + gap;
  const hingeSide = opening.anchors.pivot?.hingeSide === 1 ? 1 : -1;
  // Residential planning may name a railing-free landing side (the daecheong
  // side for giwa). Keep the hardware hinge independent; openings without
  // authored landing guidance retain their stable hinge-side variation.
  const clearSide = opening.anchors.footwear.clearSide;
  const placementSide = clearSide === -1 || clearSide === 1 ? clearSide : hingeSide;
  const jambU = placementSide * opening.width * 0.5;
  const pairCenterU = jambU + placementSide * (pairWidth * 0.5 + 0.065);
  const thresholdEnd = opening.threshold
    ? opening.reveal.face + opening.threshold.depth
    : opening.reveal.face;
  const authoredOutward = opening.anchors.footwear.outward;
  const minimumOutward = thresholdEnd + length * 0.5 + 0.025;
  const outward = Math.max(authoredOutward, minimumOutward);
  // The adapter scales the authored landing reference with its host house, but
  // keeps every offset from that reference (and the footwear itself) in world
  // metres. When an underspecified anchor would clip the threshold, use the
  // threshold edge as that scaled reference instead.
  const outwardReference = authoredOutward >= minimumOutward
    ? authoredOutward
    : thresholdEnd;
  const y = opening.anchors.footwear.y;
  const baseYaw = rng.range(-0.045, 0.045);
  const items = [-1, 1].map((pairSide, index) => ({
    id: `${kind}-${index + 1}`,
    kind,
    u: pairCenterU + pairSide * (width + gap) * 0.5,
    y,
    outward: outward + (index === 0 ? -0.012 : 0.012),
    yaw: baseYaw + pairSide * rng.range(0.012, 0.035),
    length,
    width,
    height,
  }));
  const bounds = items.map(footprintBounds);
  const jambClearance = Math.min(...bounds.map((bound) => (
    placementSide < 0 ? jambU - bound.uMax : bound.uMin - jambU
  )));
  const thresholdClearance = Math.min(...bounds.map((bound) => bound.outwardMin - thresholdEnd));
  const approachClearance = Math.min(...bounds.map((bound) => (
    bound.uMax < -opening.width * 0.5
      ? -opening.width * 0.5 - bound.uMax
      : bound.uMin - opening.width * 0.5
  )));
  // Preview rebuilds may retain an existing mesh only when this complete
  // placement vocabulary remains identical. In particular, an opening seed can
  // survive a bay-topology change while its width and selected jamb do not.
  const placementSignature = [
    'threshold-life-placement-v3',
    opening.id,
    opening.style,
    condition,
    stableMetric(opening.width),
    stableMetric(opening.reveal.face),
    stableMetric(opening.threshold?.depth || 0),
    stableMetric(opening.anchors.footwear.u),
    stableMetric(y),
    stableMetric(authoredOutward),
    opening.anchors.footwear.surface,
    clearSide,
    placementSide,
    stableMetric(jambU),
    stableMetric(thresholdEnd),
    stableMetric(outwardReference),
  ].join('|');

  return deepFreeze({
    version: 2,
    id: `threshold-life-${hashString(`${seed}|${opening.id}|${condition}`).toString(16)}`,
    seed,
    style: opening.style,
    condition,
    kind,
    surface: opening.anchors.footwear.surface,
    visibility: { tier: 'focus', owner: 'focus-overlay' },
    placement: {
      signature: placementSignature,
      jambU,
      surfaceY: y,
      thresholdEnd,
      outwardReference,
    },
    clearance: {
      threshold: thresholdClearance,
      approach: approachClearance,
      placementSide,
      jamb: jambClearance,
      jambU,
      thresholdEnd,
    },
    items: items.map((item, index) => ({ ...item, bounds: bounds[index] })),
  });
}

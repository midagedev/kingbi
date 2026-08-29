// Three-free pad / skirt / gate-landing coherence contract (#150 F).
//
// A residential parcel sits on one flat 성토 shelf (padY). The house, yard, and
// wall ring share that datum. Downhill of the apron the same stone family draws
// one continuous retaining face (축대/skirt); solid walls may extend their foot
// down the face by at most VILLAGE_WALL_STEP.maxDrop and pin a level gate
// landing at padY. Residential pads never stack temple-style multi-tier aprons —
// at most one downhill 축대 course, sharing the pad-stone material role.
//
// Geometry lives in generators/village/pads.js; wall stepping lives in
// wall-contract.js. This module owns only the pure numbers and plan records
// those two consumers must agree on.

import { deepFreeze } from '../core/stable-seed.js';
import * as G from '../core/math/geom2.js';
import { COURTYARD_SURFACE_LIFT, FOUNDATION_SINK } from '../core/surface-clearance.js';
import { terrainRangeOnPolygon } from './placement-search.js';
import { VILLAGE_WALL_STEP } from './wall-contract.js';

export const PAD_LANDING_SCHEMA_VERSION = 1;

// Product dimensions in world metres. lift/sink match the shared surface-clearance
// and wall terrainSink contracts so pad, foundation, and wall foot cannot drift.
export const VILLAGE_PAD = deepFreeze({
  lift: COURTYARD_SURFACE_LIFT,
  margin: 0.6,
  stepMin: 0.1,
  sink: FOUNDATION_SINK,
  skirtSegmentsPerEdge: 4,
  // Shared stone material role for pad skirt and the optional downhill 축대 course.
  // Renderer maps this to the single pad-stone MeshStandardMaterial family — no
  // second material, texture, or draw group.
  materialRole: 'pad-stone',
  // Fill above this on the apron is read as a retaining 축대 rather than a
  // micro-lip. Residential plans keep at most one such course.
  chukdaeTrigger: 0.4,
  maxChukdaeCourses: 1,
});

const EPSILON = 1e-8;

// footprint 전체가 지형에 파묻히지 않도록 코너·변중점·내부 grid의 최고점을 사용한다.
export function computePadY(parcel, site) {
  if (!parcel?.poly || typeof site?.heightAt !== 'function') {
    throw new TypeError('computePadY requires parcel.poly and site.heightAt');
  }
  return terrainRangeOnPolygon(site, parcel.poly, 5).max + VILLAGE_PAD.lift;
}

export function padApronPolygon(polygon) {
  if (!polygon?.length) return [];
  return G.offsetPoly(G.ensureCCW(polygon), VILLAGE_PAD.margin);
}

// Pure skirt segment records for one pad shelf. Tops sit at padY; bottoms sink
// PAD.sink below the lower of terrain and padY. Segments shorter than stepMin
// in rise are omitted so flat edges do not allocate dead geometry.
export function planPadSkirtSegments(polygon, padY, site, {
  segmentsPerEdge = VILLAGE_PAD.skirtSegmentsPerEdge,
} = {}) {
  if (!Number.isFinite(padY)) throw new TypeError('planPadSkirtSegments requires finite padY');
  if (typeof site?.heightAt !== 'function') {
    throw new TypeError('planPadSkirtSegments requires site.heightAt');
  }
  const apron = padApronPolygon(polygon);
  const segments = [];
  const count = Math.max(1, segmentsPerEdge | 0);
  for (let index = 0; index < apron.length; index++) {
    const a = apron[index];
    const b = apron[(index + 1) % apron.length];
    for (let segment = 0; segment < count; segment++) {
      const t0 = segment / count;
      const t1 = (segment + 1) / count;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const ground0 = site.heightAt(p0.x, p0.z);
      const ground1 = site.heightAt(p1.x, p1.z);
      if (padY - ground0 < VILLAGE_PAD.stepMin && padY - ground1 < VILLAGE_PAD.stepMin) continue;
      const bottom0 = Math.min(ground0, padY) - VILLAGE_PAD.sink;
      const bottom1 = Math.min(ground1, padY) - VILLAGE_PAD.sink;
      segments.push(deepFreeze({
        a: p0,
        b: p1,
        topY: padY,
        bottom0,
        bottom1,
        height: Math.max(padY - bottom0, padY - bottom1),
      }));
    }
  }
  return segments;
}

function terrainOnParcel(parcel, site) {
  const range = terrainRangeOnPolygon(site, parcel.poly, 5);
  return {
    min: range.min,
    max: range.max,
    drop: range.max - range.min,
  };
}

// Optional one downhill 축대 course. Residential pads never split into temple
// multi-tier aprons: when the continuous skirt already retains the face, the
// plan records a single course over the full skirt span with the shared stone
// material role. Absent when the pad is essentially flush with terrain.
function planChukdaeCourse(padY, skirt, terrain) {
  const maxSkirtHeight = skirt.reduce((max, segment) => Math.max(max, segment.height), 0);
  const fill = padY - terrain.min;
  const retaining = Math.max(maxSkirtHeight, fill);
  if (retaining < VILLAGE_PAD.chukdaeTrigger - EPSILON) return null;
  const bottomY = padY - maxSkirtHeight;
  return deepFreeze({
    materialRole: VILLAGE_PAD.materialRole,
    courseCount: 1,
    topY: padY,
    bottomY,
    maxHeight: maxSkirtHeight,
  });
}

// Full pad landing plan for one parcel. Frozen and JSON-safe.
export function planParcelPadLanding(parcel, site) {
  if (!parcel?.poly) throw new TypeError('planParcelPadLanding requires parcel.poly');
  const padY = Number.isFinite(parcel.baseY) ? parcel.baseY
    : Number.isFinite(parcel.padY) ? parcel.padY
      : computePadY(parcel, site);
  const terrain = terrainOnParcel(parcel, site);
  const apron = padApronPolygon(parcel.poly).map((point) => ({ x: point.x, z: point.z }));
  const skirt = planPadSkirtSegments(parcel.poly, padY, site);
  const chukdae = planChukdaeCourse(padY, skirt, terrain);
  return deepFreeze({
    schema: PAD_LANDING_SCHEMA_VERSION,
    padY,
    terrain,
    apron,
    skirt,
    chukdae,
    materialRole: VILLAGE_PAD.materialRole,
  });
}

// Coherence of a wall layout against a pad landing plan. Pure measure — no
// geometry. Returns a list of human-readable violation strings (empty = ok).
export function padWallLandingViolations(padPlan, wallLayout, {
  wallStep = VILLAGE_WALL_STEP,
} = {}) {
  const violations = [];
  if (!padPlan || !Number.isFinite(padPlan.padY)) {
    violations.push('pad plan missing padY');
    return violations;
  }
  if (!wallLayout) return violations;

  const padY = padPlan.padY;
  const maxDrop = wallStep.maxDrop;
  const gateLanding = wallStep.gateLanding;
  let maxFootDrop = 0;

  for (const edge of wallLayout.edgeLayouts || []) {
    for (const run of edge.runs || []) {
      const bottom = run.bottomOffset || 0;
      const top = run.topOffset || 0;
      if (bottom > EPSILON) {
        violations.push(`wall foot rose above padY by ${bottom.toFixed(3)}m`);
      }
      if (bottom < -maxDrop - EPSILON) {
        violations.push(`wall foot drop ${(-bottom).toFixed(3)}m exceeds maxDrop ${maxDrop}m`);
      }
      maxFootDrop = Math.max(maxFootDrop, -Math.min(0, bottom));
      // Top may step with terrain, but a non-landing run still anchors from padY.
      if (top > maxDrop + EPSILON || top < -maxDrop - EPSILON) {
        violations.push(`wall top offset ${top.toFixed(3)}m outside ±maxDrop`);
      }
    }
  }

  // Gate landing spans stay at pad height so posts and the approach surface share
  // the shelf. Length and flatness are owned here when a split exists.
  if (wallLayout.gate && wallLayout.pts?.length) {
    const pts = wallLayout.pts;
    const edgeIndex = wallLayout.gate.edge;
    const a = pts[edgeIndex];
    const b = pts[(edgeIndex + 1) % pts.length];
    if (a && b) {
      const length = G.dist(a, b);
      const gap = wallLayout.gate.gap;
      const halfT = gap * 0.5 / Math.max(length, EPSILON);
      const centerT = wallLayout.gate.centerT;
      const left = G.lerp(a, b, centerT - halfT);
      const right = G.lerp(a, b, centerT + halfT);
      const gateEdge = (wallLayout.edgeLayouts || []).find((edge) => edge.index === edgeIndex);
      const runs = gateEdge?.runs || [];
      const leftLanding = runs.find((run) =>
        Math.hypot(run.b.x - left.x, run.b.z - left.z) <= EPSILON);
      const rightLanding = runs.find((run) =>
        Math.hypot(run.a.x - right.x, run.a.z - right.z) <= EPSILON);
      for (const [label, landing] of [['left', leftLanding], ['right', rightLanding]]) {
        if (!landing) continue;
        if ((landing.bottomOffset || 0) !== 0 || (landing.topOffset || 0) !== 0) {
          violations.push(`${label} gate landing left padY (offsets not zero)`);
        }
        const span = Math.hypot(landing.b.x - landing.a.x, landing.b.z - landing.a.z);
        // Only demand the full landing when the free wing is long enough to host it
        // (same gateLanding + minRun budget the wall planner uses).
        const wing = label === 'left'
          ? Math.hypot(left.x - a.x, left.z - a.z)
          : Math.hypot(b.x - right.x, b.z - right.z);
        if (wing + EPSILON >= gateLanding + wallStep.minRun
          && span + EPSILON < gateLanding) {
          violations.push(`${label} gate landing span ${span.toFixed(3)}m < ${gateLanding}m`);
        }
      }
    }
  }

  // When the pad retains a real downhill face, the single 축대 course must be
  // present so the wall body can overlap a stone face rather than float above
  // bare terrain. Wall foot and apron skirt sample different XZ (wall on the
  // parcel ring, skirt on the 0.6m apron), so heights may differ by about one
  // wall rise step; require the course to cover the foot within that band.
  if (padPlan.chukdae) {
    if (padPlan.chukdae.courseCount !== 1) {
      violations.push(`residential pad has ${padPlan.chukdae.courseCount} 축대 courses (max 1)`);
    }
    if (padPlan.chukdae.materialRole !== VILLAGE_PAD.materialRole) {
      violations.push('축대 course does not share the pad-stone material role');
    }
    if (padPlan.chukdae.topY !== padY) {
      violations.push('축대 course top is not padY');
    }
    if (padPlan.chukdae.maxHeight + wallStep.rise + EPSILON < maxFootDrop) {
      violations.push(
        `축대 height ${padPlan.chukdae.maxHeight.toFixed(3)}m does not cover wall foot drop ${maxFootDrop.toFixed(3)}m`,
      );
    }
  } else if (maxFootDrop > VILLAGE_PAD.chukdaeTrigger) {
    violations.push(
      `wall foot drops ${maxFootDrop.toFixed(3)}m without a planned 축대 course`,
    );
  }

  // Skirt tops are the shelf; bottoms sink below terrain.
  for (const segment of padPlan.skirt || []) {
    if (Math.abs(segment.topY - padY) > EPSILON) {
      violations.push('skirt top drifted from padY');
      break;
    }
    if (segment.bottom0 > padY + EPSILON || segment.bottom1 > padY + EPSILON) {
      violations.push('skirt bottom rose above padY');
      break;
    }
  }

  return violations;
}

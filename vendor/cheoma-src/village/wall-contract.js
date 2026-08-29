import * as G from '../core/math/geom2.js';
import {
  parcelWorldPoint,
  rectangularParcelShape,
} from './parcel-contract.js';
import {
  terrainMeshSegmentRange,
} from './terrain-grid.js';

// Korean masonry walls descend a slope as level courses rather than pitched
// spans. These bounds keep that rhythm readable without turning one parcel edge
// into an unbounded geometry multiplier.
//
// Vertical coherence with the parcel 성토 shelf is owned by pad-landing-plan.js
// (#150 F): baseY/padY is the shared datum, gateLanding spans stay at that
// height (bottomOffset = topOffset = 0), and the wall foot may drop at most
// maxDrop so it overlaps the single downhill pad-stone 축대/skirt rather than
// chasing residual fill the continuous skirt already retains.
export const VILLAGE_WALL_STEP = Object.freeze({
  rise: 0.36,
  triggerRelief: 0.24,
  minRun: 1.2,
  gateLanding: 0.8,
  maxRunsPerEdge: 6,
  maxDrop: 1.44,
  maxRise: 1.44,
  terrainSink: 0.06,
  // 0.82 → 0.80: 농촌 기와 깊이 부스트 뒤 짧은 진흙·밀착 변이 비계단 한 스팬으로 남을 때
  // baseY−terrain 여유(~terrainSink) + edge height 가 0.82 를 1mm 급으로 밑돈다. 계단 리듬과
  // 가시 담 하한은 유지하고 바닥만 실측 최소에 맞춘다.
  minVisible: 0.80,
});

// Renderer-free geometry decisions shared by the village wall builder and
// pointer occlusion. Keeping the gate split and height RNG consumption here
// prevents an invisible interaction wall from drifting away from what is drawn.
export const VILLAGE_WALL_STYLE_HEIGHT = Object.freeze({
  tile: 2.2,
  stone: 1.8,
  mud: 1.7,
  brush: 1.25,
  hedge: 1.1,
});

// Exact renderer body widths for wall styles that form a continuous solid run.
// Planning clients use these widths instead of maintaining a second estimate of
// how far the centered wall body extends inside a parcel.
export const VILLAGE_SOLID_WALL_THICKNESS = Object.freeze({
  tile: 0.42,
  stone: 0.5,
  mud: 0.5,
});

export function villageWallProfile(shape, {
  style = 'stone',
  plotW,
  plotD,
  gateEdge: requestedGateEdge,
  gateT: requestedGateT,
} = {}) {
  const fallbackW = Number.isFinite(plotW) ? plotW : 12;
  const fallbackD = Number.isFinite(plotD) ? plotD : 10;
  const resolved = shape?.pts?.length >= 3
    ? shape
    : rectangularParcelShape(fallbackW, fallbackD);
  const pts = resolved.pts;
  const roles = resolved.roles || new Array(pts.length).fill(null);
  const defaultGateEdge = Math.max(0, roles.indexOf('front'));
  const gateEdge = Number.isInteger(requestedGateEdge)
    && requestedGateEdge >= 0 && requestedGateEdge < pts.length
    ? requestedGateEdge
    : defaultGateEdge;
  const gateT = Number.isFinite(requestedGateT)
    ? Math.max(0, Math.min(1, requestedGateT))
    : 0.5;
  const width = Number.isFinite(plotW) ? plotW : fallbackW;
  const gap = Math.min(width * 0.34, style === 'tile' ? 3.0 : 2.6);
  return {
    style,
    pts,
    roles,
    edges: resolved.edges || null,
    gateEdge,
    gateT,
    gap,
  };
}

// `rng` is passed by the renderer so its later cosmetic draws keep their exact
// historical sequence. A semantic consumer may pass a fresh seed-local RNG and
// obtains the same first height decision without touching global Math.random.
export function villageWallBaseHeight(style, {
  char01 = 0.5,
  wallHeightK = null,
} = {}, rng = Math.random) {
  const base = VILLAGE_WALL_STYLE_HEIGHT[style];
  if (!Number.isFinite(base)) return 0;
  const variation = wallHeightK != null ? wallHeightK : 0.96 + rng() * 0.1;
  return base * (0.88 + char01 * 0.2) * variation;
}

export function splitVillageWallGate(a, b, requestedT, requestedGap) {
  const length = G.dist(a, b);
  if (length < 0.8) return null;
  const gap = Math.min(requestedGap, Math.max(0.6, length - 0.8));
  const halfT = gap * 0.5 / length;
  const centerT = Math.max(
    halfT + 0.2 / length,
    Math.min(1 - halfT - 0.2 / length, requestedT),
  );
  return {
    length,
    gap,
    centerT,
    center: G.lerp(a, b, centerT),
    left: G.lerp(a, b, centerT - halfT),
    right: G.lerp(a, b, centerT + halfT),
  };
}

const samePoint = (a, b) => Math.abs(a.x - b.x) <= 1e-8 && Math.abs(a.z - b.z) <= 1e-8;
const quantize = (value, step) => Math.round(value / step) * step;
const quantizeDown = (value, step) => Math.floor(value / step) * step;
const quantizeUp = (value, step) => Math.ceil(value / step) * step;

function steppedWallContext(opts) {
  const parcel = opts.parcel;
  const site = opts.site;
  const terrainR = site?.terrainR || site?.R;
  const baseY = Number.isFinite(opts.baseY) ? opts.baseY
    : Number.isFinite(parcel?.baseY) ? parcel.baseY
      : Number.isFinite(parcel?.padY) ? parcel.padY : null;
  if (!parcel?.center || !parcel?.frontDir || !Number.isFinite(terrainR)
    || typeof site?.heightAt !== 'function' || !Number.isFinite(baseY)) return null;
  return { parcel, site, baseY };
}

// A terrain segment is piecewise linear. Its extrema occur at the grid axes or
// the `fu + fv = 1` triangle diagonal, so sampling those exact crossings avoids
// returning to the analytic height approximation that #112 replaced.
function sampleTerrainRange(context, a, b) {
  return terrainMeshSegmentRange(
    context.site,
    parcelWorldPoint(context.parcel, a),
    parcelWorldPoint(context.parcel, b),
  );
}

function stepOffsets(context, a, b, height) {
  const range = sampleTerrainRange(context, a, b);
  const { rise, maxDrop, maxRise, terrainSink, minVisible } = VILLAGE_WALL_STEP;
  const mean = (range.min + range.max) * 0.5;
  let topOffset = quantize(mean - context.baseY, rise);
  const requiredVisible = range.max - context.baseY - height + minVisible;
  topOffset = Math.max(topOffset, quantizeUp(requiredVisible, rise));
  topOffset = Math.max(-maxDrop, Math.min(maxRise, topOffset));
  let bottomOffset = Math.min(0, quantizeDown(range.min - context.baseY - terrainSink, rise));
  bottomOffset = Math.max(-maxDrop, bottomOffset);
  return { bottomOffset, topOffset };
}

function appendCoalescedRun(runs, run) {
  const previous = runs[runs.length - 1];
  if (previous
    && samePoint(previous.b, run.a)
    && previous.bottomOffset === run.bottomOffset
    && previous.topOffset === run.topOffset) {
    previous.b = run.b;
    return;
  }
  runs.push(run);
}

function planSteppedSpan(context, a, b, height, grow, budget, pinnedSide = null) {
  const length = G.dist(a, b);
  if (length < 0.05) return [{ a, b, grow }];
  const { minRun, gateLanding } = VILLAGE_WALL_STEP;
  if (budget <= 1 || (pinnedSide && length < gateLanding + minRun)) {
    return pinnedSide
      ? [{ a, b, grow, bottomOffset: 0, topOffset: 0 }]
      : [{ a, b, grow }];
  }
  const landing = pinnedSide && length >= gateLanding + minRun
    ? Math.min(gateLanding, length * 0.35)
    : 0;
  const freeLength = length - landing;
  const freeBudget = Math.max(1, budget - (landing > 0 ? 1 : 0));
  const cells = Math.max(1, Math.min(freeBudget, Math.floor(freeLength / minRun)));
  const runs = [];
  const pointAt = (distance) => G.lerp(a, b, distance / length);
  if (pinnedSide === 'start' && landing > 0) {
    appendCoalescedRun(runs, {
      a, b: pointAt(landing), grow,
      bottomOffset: 0, topOffset: 0,
    });
  }
  const startDistance = pinnedSide === 'start' ? landing : 0;
  const endDistance = pinnedSide === 'end' ? length - landing : length;
  for (let index = 0; index < cells; index++) {
    const start = startDistance + (endDistance - startDistance) * index / cells;
    const end = startDistance + (endDistance - startDistance) * (index + 1) / cells;
    const runA = pointAt(start), runB = pointAt(end);
    appendCoalescedRun(runs, {
      a: runA,
      b: runB,
      grow,
      ...stepOffsets(context, runA, runB, height),
    });
  }
  if (pinnedSide === 'end' && landing > 0) {
    appendCoalescedRun(runs, {
      a: pointAt(length - landing), b, grow,
      bottomOffset: 0, topOffset: 0,
    });
  }
  const clampFrom = (start, end, direction) => {
    let previousTop = runs[start].topOffset || 0;
    let previousBottom = runs[start].bottomOffset || 0;
    for (let index = start + direction; index !== end; index += direction) {
      const run = runs[index];
      run.topOffset = Math.max(
        previousTop - VILLAGE_WALL_STEP.rise,
        Math.min(previousTop + VILLAGE_WALL_STEP.rise, run.topOffset || 0),
      );
      run.bottomOffset = Math.max(
        previousBottom - VILLAGE_WALL_STEP.rise,
        Math.min(previousBottom + VILLAGE_WALL_STEP.rise, run.bottomOffset || 0),
      );
      previousTop = run.topOffset;
      previousBottom = run.bottomOffset;
    }
  };
  if (runs.length > 1) {
    if (pinnedSide === 'end' && landing > 0) clampFrom(runs.length - 1, -1, -1);
    else if (pinnedSide === 'start' && landing > 0) clampFrom(0, runs.length, 1);
    else {
      const rise = VILLAGE_WALL_STEP.rise;
      for (let pass = 0; pass < runs.length; pass++) {
        for (let index = 1; index < runs.length; index++) {
          const left = runs[index - 1], right = runs[index];
          if (left.topOffset < right.topOffset - rise) left.topOffset = right.topOffset - rise;
          if (right.topOffset < left.topOffset - rise) right.topOffset = left.topOffset - rise;
          if (left.bottomOffset > right.bottomOffset + rise) left.bottomOffset = right.bottomOffset + rise;
          if (right.bottomOffset > left.bottomOffset + rise) right.bottomOffset = left.bottomOffset + rise;
        }
      }
    }
  }
  const coalesced = [];
  for (const run of runs) appendCoalescedRun(coalesced, run);
  if (coalesced.every((run) => (run.bottomOffset || 0) === 0 && (run.topOffset || 0) === 0)) {
    return [{ a, b, grow }];
  }
  return coalesced;
}

function edgeStepBudgets(spans) {
  if (spans.length <= 1) return [VILLAGE_WALL_STEP.maxRunsPerEdge];
  const budgets = new Array(spans.length).fill(1);
  let remaining = VILLAGE_WALL_STEP.maxRunsPerEdge - spans.length;
  const lengths = spans.map((span) => G.dist(span.a, span.b));
  while (remaining-- > 0) {
    let best = 0;
    for (let index = 1; index < spans.length; index++) {
      if (lengths[index] / budgets[index] > lengths[best] / budgets[best]) best = index;
    }
    budgets[best]++;
  }
  return budgets;
}

function steppedEdgeRuns(context, spans, height, grow) {
  if (!context || !spans.length) return spans.map(({ a, b }) => ({ a, b, grow }));
  const fullRange = sampleTerrainRange(context, spans[0].edgeA, spans[0].edgeB);
  if (fullRange.max - fullRange.min < VILLAGE_WALL_STEP.triggerRelief) {
    return spans.map(({ a, b }) => ({ a, b, grow }));
  }
  const budgets = edgeStepBudgets(spans);
  return spans.flatMap((span, index) => planSteppedSpan(
    context, span.a, span.b, height, grow, budgets[index], span.pinnedSide,
  ));
}

function endpointStepOffsets(edgeLayouts, point) {
  let found = false;
  let bottomOffset = 0, topOffset = 0;
  for (const edge of edgeLayouts) {
    for (const run of edge.runs) {
      if (!samePoint(run.a, point) && !samePoint(run.b, point)) continue;
      const bottom = run.bottomOffset || 0;
      const top = run.topOffset || 0;
      if (!found) {
        bottomOffset = bottom;
        topOffset = top;
        found = true;
      } else {
        bottomOffset = Math.min(bottomOffset, bottom);
        topOffset = Math.max(topOffset, top);
      }
    }
  }
  return { bottomOffset, topOffset };
}

// Complete structural wall layout. Cosmetic stone/thatch jitter remains in the
// renderer, while every solid run, skipped shared edge, height multiplier, and
// gate opening is resolved here for renderer/interaction parity.
export function villageWallLayout(shape, opts = {}, rng = Math.random) {
  const style = opts.style || 'stone';
  const profile = villageWallProfile(shape, { ...opts, style });
  const { pts, roles, edges, gateEdge, gateT, gap } = profile;
  const count = pts.length;
  let centerX = 0, centerZ = 0;
  for (const point of pts) { centerX += point.x; centerZ += point.z; }
  centerX /= count; centerZ /= count;

  if (style === 'open') {
    return {
      ...profile,
      baseHeight: 0,
      thickness: 0,
      centerX,
      centerZ,
      edgeLayouts: [],
      cornerPosts: [],
      gate: { edge: gateEdge, centerT: gateT, gap, height: 1.25 },
    };
  }

  const baseHeight = villageWallBaseHeight(style, {
    char01: typeof opts.char01 === 'number' ? opts.char01 : 0.5,
    wallHeightK: opts.wallHeightK,
  }, rng);
  const thickness = VILLAGE_SOLID_WALL_THICKNESS[style] ?? 0.5;
  const solid = style !== 'brush' && style !== 'hedge';
  const stepContext = style === 'tile' || style === 'stone' || style === 'mud'
    ? steppedWallContext(opts)
    : null;
  const grow = solid ? 0.4 : 0;
  const edgeLayouts = [];
  let gate = null;
  for (let index = 0; index < count; index++) {
    const edge = edges ? edges[index] : null;
    if (index !== gateEdge && edge?.share) continue;
    const heightK = index === gateEdge ? 1
      : edge ? edge.heightK
        : roles[index] === 'front' ? 1 : roles[index] === 'back' ? 0.72 : 0.7;
    const height = baseHeight * heightK;
    const a = pts[index], b = pts[(index + 1) % count];
    if (index !== gateEdge) {
      const runs = steppedEdgeRuns(stepContext, [{
        a, b, edgeA: a, edgeB: b, pinnedSide: null,
      }], height, grow);
      edgeLayouts.push({ index, height, runs, gate: null });
      continue;
    }
    const split = splitVillageWallGate(a, b, gateT, gap);
    const spans = [];
    if (split) {
      if (G.dist(a, split.left) > 0.05) spans.push({
        a, b: split.left, edgeA: a, edgeB: b, pinnedSide: 'end',
      });
      if (G.dist(split.right, b) > 0.05) spans.push({
        a: split.right, b, edgeA: a, edgeB: b, pinnedSide: 'start',
      });
      gate = {
        edge: index,
        centerT: split.centerT,
        gap: split.gap,
        height,
      };
    }
    const runs = steppedEdgeRuns(stepContext, spans, height, grow);
    edgeLayouts.push({ index, height, runs, gate });
  }

  const cornerPosts = [];
  if (style === 'stone' || style === 'mud' || style === 'tile') {
    for (let index = 0; index < count; index++) {
      if (roles[(index - 1 + count) % count] === roles[index]) continue;
      const offsets = endpointStepOffsets(edgeLayouts, pts[index]);
      const post = {
        point: pts[index],
        height: baseHeight + offsets.topOffset - offsets.bottomOffset,
        thickness,
      };
      if (offsets.bottomOffset !== 0) post.bottomOffset = offsets.bottomOffset;
      if (offsets.topOffset !== 0) post.topOffset = offsets.topOffset;
      cornerPosts.push(post);
    }
  }
  return {
    ...profile,
    baseHeight,
    thickness,
    centerX,
    centerZ,
    edgeLayouts,
    cornerPosts,
    gate,
  };
}

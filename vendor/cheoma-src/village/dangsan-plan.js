import { deepFreeze } from '../core/stable-seed.js';
import * as G from '../core/math/geom2.js';
import { makeRng } from '../rng.js';
import { GUARDIAN_BASE_CLEARANCE } from './guardian-plan.js';
import { pavilionFootprint } from './pavilion-plan.js';
import { publicPropObstruction } from './public-props-plan.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import { circleBlocksSolarAccess } from './solar-access.js';
import { streamClearanceAt } from './stream-spatial.js';
import { terrainMeshHeightAt } from './terrain-grid.js';
import { circleIntersectsPolygon } from './parcel-contract.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallVegetationBlocked,
  worldEdgeClearance,
} from './citywall-contour.js';

// Renderer-free dangsan cultural-landscape plan.
//
// A village guardian tree is already a required landmark. This module optionally
// attaches a low-frequency ritual clearing (and sometimes a tiny dangjip shed)
// under one existing guardian canopy. Placement consumes that canopy reservation
// and fails closed rather than inventing a second sacred tree or a national
// shrine frequency table.

export const DANGSAN_PLAN_SCHEMA_VERSION = 1;

export const DANGSAN_PLAN_LIMITS = deepFreeze({
  eligibleScales: Object.freeze(['hamlet', 'village']),
  // Product auto-rate for rural tiers only. Not a historical national frequency.
  autoRate: 0.14,
  dangjipRate: 0.42,
  maxSites: 1,
  trunkClearance: 3.15,
  clearingRadius: 2.05,
  clearingGap: 0.35,
  altar: Object.freeze({
    width: 1.12,
    depth: 0.58,
    height: 0.42,
  }),
  dangjip: Object.freeze({
    width: 1.55,
    depth: 1.28,
    height: 1.48,
    overhang: 0.16,
    rise: 0.42,
  }),
  roadClearance: 0.55,
  streamClearance: 0.9,
  parcelClearance: 0.45,
  propClearance: 0.55,
  maxSearchAngles: 16,
  maxSearchRadii: 5,
  searchStep: 0.55,
});

const ELIGIBLE = new Set(DANGSAN_PLAN_LIMITS.eligibleScales);

function emptyPlan(reason = 'none') {
  return deepFreeze({
    schema: DANGSAN_PLAN_SCHEMA_VERSION,
    sites: [],
    reason,
  });
}

function finitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.z);
}

function surfaceY(site, x, z) {
  if (typeof site?.heightAt === 'function') {
    const y = site.heightAt(x, z);
    if (Number.isFinite(y)) return y;
  }
  return terrainMeshHeightAt(site, x, z);
}

function normalizeOptIn(value) {
  if (value === true) return 'force';
  if (value === false) return 'off';
  return 'auto';
}

function preferGuardians(guardians) {
  const list = (guardians || []).filter((tree) => (
    finitePoint(tree)
    && Number.isFinite(tree.radius)
    && tree.radius > DANGSAN_PLAN_LIMITS.trunkClearance
      + DANGSAN_PLAN_LIMITS.clearingRadius
  ));
  const rank = (tree) => {
    if (tree.role === 'entrance' && tree.props) return 0;
    if (tree.role === 'entrance') return 1;
    if (tree.role === 'central' && tree.props) return 2;
    if (tree.role === 'central') return 3;
    return 4;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b) || a.x - b.x || a.z - b.z);
}

function dangjipFootprint(center, yaw, body = DANGSAN_PLAN_LIMITS.dangjip) {
  const halfW = body.width * 0.5 + body.overhang;
  const halfD = body.depth * 0.5 + body.overhang;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [
    { x: -halfW, z: -halfD },
    { x: halfW, z: -halfD },
    { x: halfW, z: halfD },
    { x: -halfW, z: halfD },
  ].map((point) => ({
    x: center.x + point.x * c + point.z * s,
    z: center.z - point.x * s + point.z * c,
  }));
}

function dangjipObstruction(center, yaw, surface) {
  const body = DANGSAN_PLAN_LIMITS.dangjip;
  const halfDiagonal = Math.hypot(
    body.width * 0.5 + body.overhang,
    body.depth * 0.5 + body.overhang,
  );
  return {
    x: center.x,
    z: center.z,
    radius: halfDiagonal,
    height: body.height + body.rise,
    baseY: surface,
  };
}

function createClearance(ctx) {
  const {
    site,
    parcels,
    roads,
    paddies,
    pavilion,
    props,
    guardians,
    cityWall,
  } = ctx;
  const roadSpatial = createRoadSpatialIndex(roads || []);
  const pavilionPoly = pavilion ? pavilionFootprint(pavilion, 0.45) : [];
  const occupied = [
    ...(parcels || []).map((parcel) => parcel.poly).filter((poly) => poly?.length >= 3),
    ...(paddies || []).map((field) => field.poly).filter((poly) => poly?.length >= 3),
  ];
  const propObstacles = (props || [])
    .map((prop) => publicPropObstruction(prop))
    .filter(Boolean);

  return {
    clearingOk(point, radius) {
      if (!finitePoint(point) || !(radius > 0)) return false;
      if (site.edge && worldEdgeClearance(site.edge, point) < radius + 1.2) return false;
      if (streamClearanceAt(site, point) < radius + DANGSAN_PLAN_LIMITS.streamClearance) {
        return false;
      }
      if (roadSpatial.withinRoadClearance(
        point,
        null,
        radius + DANGSAN_PLAN_LIMITS.roadClearance,
      )) return false;
      if (cityWallVegetationBlocked(cityWall, point, {
        corridor: radius + CITY_WALL_DIMENSIONS.vegetationClearance * 0.35,
        gateMargin: radius + CITY_WALL_DIMENSIONS.gateVegetationMargin * 0.5,
        gateApproachMargin: radius,
      })) return false;
      for (const poly of occupied) {
        if (circleIntersectsPolygon(
          point,
          radius + DANGSAN_PLAN_LIMITS.parcelClearance,
          poly,
        )) return false;
      }
      if (pavilionPoly.length
        && circleIntersectsPolygon(point, radius + 0.4, pavilionPoly)) return false;
      for (const prop of propObstacles) {
        if (G.dist(point, prop) < radius + prop.radius + DANGSAN_PLAN_LIMITS.propClearance) {
          return false;
        }
      }
      for (const tree of guardians || []) {
        if (!finitePoint(tree)) continue;
        // Stay outside the structural trunk/base props of every guardian, including
        // the host tree; the clearing itself must remain under the host canopy.
        const base = tree === ctx.host
          ? DANGSAN_PLAN_LIMITS.trunkClearance
          : Math.max(GUARDIAN_BASE_CLEARANCE, (tree.radius || 0) * 0.22);
        if (G.dist(point, tree) < base + radius) return false;
      }
      return true;
    },
    dangjipOk(point, yaw) {
      const surface = surfaceY(site, point.x, point.z);
      const obstacle = dangjipObstruction(point, yaw, surface);
      if (!this.clearingOk(point, obstacle.radius)) return false;
      // Host canopy must still cover the shed footprint (consume guardian clearance).
      if (G.dist(point, ctx.host) + obstacle.radius > ctx.host.radius - 0.2) return false;
      for (const parcel of parcels || []) {
        if (circleBlocksSolarAccess(parcel, obstacle, site)) return false;
      }
      return true;
    },
  };
}

function radialOffsets(host, site) {
  const toward = G.norm(G.sub(site.center || { x: 0, z: 0 }, host));
  const baseAngle = Math.atan2(toward.x, toward.z);
  const distances = [];
  const baseDistance = DANGSAN_PLAN_LIMITS.trunkClearance
    + DANGSAN_PLAN_LIMITS.clearingRadius
    + DANGSAN_PLAN_LIMITS.clearingGap;
  for (let ring = 0; ring < DANGSAN_PLAN_LIMITS.maxSearchRadii; ring++) {
    distances.push(baseDistance + ring * DANGSAN_PLAN_LIMITS.searchStep);
  }
  const angles = [];
  for (let i = 0; i < DANGSAN_PLAN_LIMITS.maxSearchAngles; i++) {
    // Prefer village-inward, then alternate left/right so low-rate sites stay
    // near the ceremonial approach without inventing a second sacred axis.
    const half = Math.ceil(i / 2);
    const sign = i % 2 === 0 ? 1 : -1;
    angles.push(baseAngle + sign * half * (Math.PI / 10));
  }
  const out = [];
  for (const distance of distances) {
    if (distance + DANGSAN_PLAN_LIMITS.clearingRadius > host.radius - 0.15) continue;
    for (const angle of angles) {
      out.push({
        x: host.x + Math.sin(angle) * distance,
        z: host.z + Math.cos(angle) * distance,
        yaw: angle,
        distance,
      });
    }
  }
  return out;
}

function placeSite(host, ctx, wantDangjip) {
  const clearance = createClearance({ ...ctx, host });
  const radius = DANGSAN_PLAN_LIMITS.clearingRadius;
  for (const candidate of radialOffsets(host, ctx.site)) {
    if (!clearance.clearingOk(candidate, radius)) continue;
    // Clearing must remain under the host canopy.
    if (G.dist(candidate, host) + radius > host.radius - 0.1) continue;

    const clearingY = surfaceY(ctx.site, candidate.x, candidate.z);
    const towardTree = G.norm(G.sub(host, candidate));
    const altarOffset = radius * 0.42;
    const altar = {
      x: candidate.x + towardTree.x * altarOffset,
      z: candidate.z + towardTree.z * altarOffset,
      yaw: Math.atan2(towardTree.x, towardTree.z),
      width: DANGSAN_PLAN_LIMITS.altar.width,
      depth: DANGSAN_PLAN_LIMITS.altar.depth,
      height: DANGSAN_PLAN_LIMITS.altar.height,
      surfaceY: surfaceY(
        ctx.site,
        candidate.x + towardTree.x * altarOffset,
        candidate.z + towardTree.z * altarOffset,
      ),
    };
    if (!clearance.clearingOk(
      { x: altar.x, z: altar.z },
      Math.hypot(altar.width, altar.depth) * 0.5,
    )) continue;

    let dangjip = null;
    if (wantDangjip) {
      const side = G.perpL(towardTree);
      const shedDistance = radius
        + DANGSAN_PLAN_LIMITS.dangjip.depth * 0.5
        + DANGSAN_PLAN_LIMITS.dangjip.overhang
        + 0.35;
      for (const sign of [1, -1]) {
        const px = candidate.x + side.x * shedDistance * sign + towardTree.x * 0.2;
        const pz = candidate.z + side.z * shedDistance * sign + towardTree.z * 0.2;
        const yaw = Math.atan2(-towardTree.x, -towardTree.z);
        if (!clearance.dangjipOk({ x: px, z: pz }, yaw)) continue;
        const body = DANGSAN_PLAN_LIMITS.dangjip;
        dangjip = {
          x: px,
          z: pz,
          yaw,
          surfaceY: surfaceY(ctx.site, px, pz),
          body: {
            width: body.width,
            depth: body.depth,
            height: body.height,
          },
          roof: {
            form: 'gable',
            covering: 'thatch',
            overhang: body.overhang,
            rise: body.rise,
          },
          footprint: dangjipFootprint({ x: px, z: pz }, yaw, body),
        };
        break;
      }
      // Force-mode still accepts a clearing when the tiny shed cannot fit.
    }

    return {
      id: `dangsan-${host.role || 'tree'}`,
      guardianRole: host.role || null,
      tree: {
        x: host.x,
        z: host.z,
        radius: host.radius,
        kind: host.kind || 'zelkova',
        scale: Number.isFinite(host.scale) ? host.scale : 1,
        spin: Number.isFinite(host.spin) ? host.spin : 0,
      },
      clearing: {
        x: candidate.x,
        z: candidate.z,
        radius,
        yaw: candidate.yaw,
        surfaceY: clearingY,
      },
      altar,
      dangjip,
    };
  }
  return null;
}

/**
 * Plan at most one optional dangsan cultural landscape under an existing
 * guardian canopy. Never invents a guardian tree or mutates inputs.
 *
 * @param {object} input
 * @param {'hamlet'|'village'|'town'|'capital'|'hanyang'} input.scale
 * @param {number} input.seed
 * @param {object} input.site
 * @param {Array} input.guardians
 * @param {Array} [input.parcels]
 * @param {Array} [input.roads]
 * @param {Array} [input.paddies]
 * @param {object|null} [input.pavilion]
 * @param {Array} [input.props]
 * @param {object|null} [input.cityWall]
 * @param {boolean|undefined} [input.dangsan] force / off / auto
 */
export function planDangsan(input = {}) {
  const scale = input.scale;
  const mode = normalizeOptIn(input.dangsan);
  if (mode === 'off') return emptyPlan('disabled');
  if (!ELIGIBLE.has(scale)) return emptyPlan('ineligible-scale');

  const seed = (Number.isFinite(input.seed) ? input.seed : 0) >>> 0;
  // Dedicated stream so this optional layer cannot pollute village plan RNG.
  const rng = makeRng((seed ^ 0xd4a50150) >>> 0);
  if (mode === 'auto' && rng() >= DANGSAN_PLAN_LIMITS.autoRate) {
    return emptyPlan('low-rate-skip');
  }
  const wantDangjip = rng() < DANGSAN_PLAN_LIMITS.dangjipRate;

  const site = input.site;
  if (!site) return emptyPlan('missing-site');

  const guardians = preferGuardians(input.guardians || input.features?.guardianTrees);
  if (!guardians.length) return emptyPlan('no-guardian');

  const ctx = {
    site,
    parcels: input.parcels || [],
    roads: input.roads || [],
    paddies: input.paddies || [],
    pavilion: input.pavilion ?? input.features?.pavilion ?? null,
    props: input.props || input.features?.props || [],
    guardians,
    cityWall: input.cityWall ?? input.features?.cityWall ?? null,
  };

  for (const host of guardians) {
    const siteRecord = placeSite(host, ctx, wantDangjip);
    if (!siteRecord) continue;
    return deepFreeze({
      schema: DANGSAN_PLAN_SCHEMA_VERSION,
      sites: [siteRecord],
      reason: mode === 'force' ? 'forced' : 'auto',
    });
  }
  return emptyPlan('no-clear-slot');
}

export function validateDangsanPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('dangsan plan must be an object');
  }
  if (plan.schema !== DANGSAN_PLAN_SCHEMA_VERSION) {
    throw new RangeError(`dangsan plan schema must be ${DANGSAN_PLAN_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(plan.sites)) {
    throw new TypeError('dangsan plan.sites must be an array');
  }
  if (plan.sites.length > DANGSAN_PLAN_LIMITS.maxSites) {
    throw new RangeError('dangsan plan exceeds maxSites');
  }
  for (let index = 0; index < plan.sites.length; index++) {
    const site = plan.sites[index];
    const label = `dangsan sites[${index}]`;
    if (!site || typeof site !== 'object') throw new TypeError(`${label} must be an object`);
    if (typeof site.id !== 'string' || !site.id) {
      throw new TypeError(`${label}.id must be a non-empty string`);
    }
    if (!finitePoint(site.tree) || !(site.tree.radius > 0)) {
      throw new RangeError(`${label}.tree must be a finite canopy reservation`);
    }
    if (!finitePoint(site.clearing) || !(site.clearing.radius > 0)
      || !Number.isFinite(site.clearing.surfaceY)) {
      throw new RangeError(`${label}.clearing is incomplete`);
    }
    if (G.dist(site.clearing, site.tree) + site.clearing.radius
      > site.tree.radius + 1e-6) {
      throw new RangeError(`${label}.clearing escapes its host canopy`);
    }
    if (!finitePoint(site.altar)
      || !Number.isFinite(site.altar.width)
      || !Number.isFinite(site.altar.depth)
      || !Number.isFinite(site.altar.height)
      || !Number.isFinite(site.altar.surfaceY)) {
      throw new RangeError(`${label}.altar is incomplete`);
    }
    if (site.dangjip != null) {
      const shed = site.dangjip;
      if (!finitePoint(shed)
        || !Number.isFinite(shed.yaw)
        || !Number.isFinite(shed.surfaceY)
        || !Number.isFinite(shed.body?.width)
        || !Number.isFinite(shed.body?.depth)
        || !Number.isFinite(shed.body?.height)
        || shed.roof?.form !== 'gable'
        || shed.roof?.covering !== 'thatch'
        || !Number.isFinite(shed.roof?.overhang)
        || !Number.isFinite(shed.roof?.rise)
        || !Array.isArray(shed.footprint)
        || shed.footprint.length !== 4) {
        throw new RangeError(`${label}.dangjip is incomplete`);
      }
      const halfDiagonal = Math.hypot(
        shed.body.width * 0.5 + shed.roof.overhang,
        shed.body.depth * 0.5 + shed.roof.overhang,
      );
      if (G.dist(shed, site.tree) + halfDiagonal > site.tree.radius + 1e-6) {
        throw new RangeError(`${label}.dangjip escapes its host canopy`);
      }
    }
  }
  return plan;
}

export function dangsanHardObstacles(plan) {
  const obstacles = [];
  for (const site of plan?.sites || []) {
    if (site.clearing) {
      obstacles.push({
        kind: 'dangsan-clearing',
        x: site.clearing.x,
        z: site.clearing.z,
        radius: site.clearing.radius,
        height: 0.08,
      });
    }
    if (site.altar) {
      obstacles.push({
        kind: 'dangsan-altar',
        x: site.altar.x,
        z: site.altar.z,
        radius: Math.hypot(site.altar.width, site.altar.depth) * 0.5,
        height: site.altar.height,
      });
    }
    if (site.dangjip) {
      const shed = site.dangjip;
      obstacles.push({
        kind: 'dangsan-dangjip',
        x: shed.x,
        z: shed.z,
        radius: Math.hypot(
          shed.body.width * 0.5 + shed.roof.overhang,
          shed.body.depth * 0.5 + shed.roof.overhang,
        ),
        height: shed.body.height + shed.roof.rise,
        yaw: shed.yaw,
      });
    }
  }
  return obstacles;
}

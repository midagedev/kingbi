// Renderer-free positional SFX anchor math.
// Village mode cannot pin stream/chimes to the solo-house origin — the camera is
// often hundreds of metres away. These pure helpers compute live world anchors
// from plan data so setupAudio can follow getters the same way the dog bark does.
//
// No THREE, no AudioContext, no Math.random seed consumption.

import { distToPolyline } from '../core/math/geom2.js';
import { parcelRotY } from '../generators/shared/parcel-spatial.js';
import { parcelHouseTranslation } from '../village/parcel-contract.js';
import { variantMirrorX } from '../village/variants.js';

const CHIME_DROP = 0.25; // hang slightly below the eave edge (matches chime.js)

/** Four local eave-corner positions for 풍경 (same contract as createChimes). */
export function chimeLocalCorners(layout) {
  const xE = (layout && layout.xEave) ?? 9;
  const zE = (layout && layout.zEave) ?? 6;
  const y = ((layout && layout.eaveEdgeY) ?? 6.5) - CHIME_DROP;
  return [
    [xE, y, zE],
    [-xE, y, zE],
    [xE, y, -zE],
    [-xE, y, -zE],
  ];
}

/**
 * Transform local eave corners into village world space for one parcel.
 * Matches houseMatrix order: scale → houseLocal → rotY → (center, baseY).
 * mirrorX folds into sx (variantMirrorX = ±1).
 */
export function chimeWorldCorners(layout, parcel, {
  sx = 1, sy = 1, sz = 1, baseY, mirrorX,
} = {}) {
  if (!parcel?.center) return null;
  const local = chimeLocalCorners(layout);
  const houseLocal = parcelHouseTranslation(parcel);
  const rotY = parcelRotY(parcel);
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  // Instanced path bakes ㄱ flips into geometry; FULL overlay uses scale.x *= mirrorX.
  // Default to the parcel's variant contract so both paths land near the same eaves.
  const mx = Number.isFinite(mirrorX) ? mirrorX : variantMirrorX(parcel);
  const scaleX = (Number.isFinite(sx) ? sx : 1) * mx;
  const scaleY = Number.isFinite(sy) ? sy : 1;
  const scaleZ = Number.isFinite(sz) ? sz : 1;
  const originY = Number.isFinite(baseY)
    ? baseY
    : (Number.isFinite(parcel.baseY) ? parcel.baseY
      : (Number.isFinite(parcel.padY) ? parcel.padY : 0));

  return local.map(([lx, ly, lz]) => {
    const x = houseLocal.x + lx * scaleX;
    const y = ly * scaleY;
    const z = houseLocal.z + lz * scaleZ;
    return [
      parcel.center.x + x * cos + z * sin,
      originY + y,
      parcel.center.z - x * sin + z * cos,
    ];
  });
}

/**
 * Build a computeLayout-compatible param bag for a residential parcel.
 * Prefer proxy.buildingSpec.params (edit-aware); fall back to kind presets.
 * Pure: does not call computeLayout itself so consumers can inject their own.
 */
export function chimeLayoutParams(parcel, buildingSpec = null) {
  if (!parcel && !buildingSpec) return null;
  const kind = buildingSpec?.kind || parcel?.kind;
  if (kind !== 'giwa' && kind !== 'choga') return null;
  const params = buildingSpec?.params || {};
  return { style: kind, ...params };
}

/**
 * Nearest audible stream point to a reference xz (camera or focus target).
 * Prefer the actual centerline sample; fall back to site.stream.cross.
 * Returns plain {x,y,z} or null when the site has no water.
 */
export function nearestStreamAnchor(site, ref = { x: 0, z: 0 }) {
  if (!site?.stream) return null;
  const pts = site.stream.pts;
  const rx = Number.isFinite(ref.x) ? ref.x : 0;
  const rz = Number.isFinite(ref.z) ? ref.z : 0;

  let pt = null;
  if (pts?.length >= 2) {
    const hit = distToPolyline({ x: rx, z: rz }, pts);
    if (hit?.pt && Number.isFinite(hit.pt.x) && Number.isFinite(hit.pt.z)) pt = hit.pt;
  }
  if (!pt) {
    const cross = site.stream.cross;
    if (cross && Number.isFinite(cross.x) && Number.isFinite(cross.z)) pt = cross;
  }
  if (!pt && pts?.length) {
    // Single-point or degenerate polyline: use the first sample.
    const p0 = pts[0];
    if (p0 && Number.isFinite(p0.x) && Number.isFinite(p0.z)) pt = p0;
  }
  if (!pt) return null;

  // Surface height: analytic bed first, then terrain heightAt. +0.25 matches solo water.anchor.
  let y = 0.25;
  if (typeof site.streamY === 'function') {
    const bed = site.streamY(pt.x);
    if (Number.isFinite(bed)) y = bed + 0.25;
  } else if (typeof site.heightAt === 'function') {
    const h = site.heightAt(pt.x, pt.z);
    if (Number.isFinite(h)) y = h + 0.25;
  }
  return { x: pt.x, y, z: pt.z };
}

/**
 * Pick the parcel that should host 풍경: focused residential first, else nearest
 * giwa/choga to the reference xz. Hero/palace/temple compounds are skipped —
 * their eaves are multi-building and not the product chime layout.
 */
export function pickChimeParcel(parcels, {
  focusedId = null,
  ref = { x: 0, z: 0 },
} = {}) {
  if (!Array.isArray(parcels) || !parcels.length) return null;
  const residential = (p) => p && (p.kind === 'giwa' || p.kind === 'choga') && !p.hero;

  if (focusedId != null) {
    const focused = parcels.find((p) => p.id === focusedId && residential(p));
    if (focused) return focused;
  }

  const rx = Number.isFinite(ref.x) ? ref.x : 0;
  const rz = Number.isFinite(ref.z) ? ref.z : 0;
  let best = null;
  let bestD = Infinity;
  for (const p of parcels) {
    if (!residential(p) || !p.center) continue;
    const dx = p.center.x - rx;
    const dz = p.center.z - rz;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

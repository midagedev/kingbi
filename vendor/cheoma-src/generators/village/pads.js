import * as THREE from 'three';
import * as G from '../../core/math/geom2.js';
import { markSharedResource } from '../../core/three-resources.js';
import { parcelWorldPoint } from '../../village/parcel-contract.js';
import {
  VILLAGE_PAD,
  computePadY,
  planPadSkirtSegments,
} from '../../village/pad-landing-plan.js';
import {
  TEMPLE_PAD_LIFT,
  templeCompoundDepth,
  templeCompoundWidth,
  templeFootprint,
} from '../../village/temple-plan.js';

// Re-export the pure padY helper so existing consumers of this module keep
// working without importing the Three-free plan directly.
export { computePadY };

const PAD_LIFT = VILLAGE_PAD.lift;

// 필지·랜드마크 패드는 같은 두 재질을 공유해 draw call과 material 수를 고정한다.
// skirt 와 선택 축대 course 는 동일 stone family (VILLAGE_PAD.materialRole).
const padTopMaterial = markSharedResource(
  new THREE.MeshStandardMaterial({ color: 0x8a7f66, roughness: 1, metalness: 0 }),
);
const padStoneMaterial = markSharedResource(
  new THREE.MeshStandardMaterial({ color: 0x8d857a, roughness: 1, metalness: 0 }),
);
padStoneMaterial.userData.materialRole = VILLAGE_PAD.materialRole;

export function featurePadMaterials() {
  return { top: padTopMaterial, stone: padStoneMaterial };
}

function makeBufferMesh(positions, indices, material, name) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function emitPad(polygon, padY, site, topPositions, topIndices, skirtPositions, skirtIndices) {
  const pad = G.offsetPoly(G.ensureCCW(polygon), VILLAGE_PAD.margin);
  const topBase = topPositions.length / 3;
  for (const corner of pad) topPositions.push(corner.x, padY, corner.z);
  for (let i = 1; i < pad.length - 1; i++) topIndices.push(topBase, topBase + i + 1, topBase + i);

  // Pure skirt plan owns segment split / sink / stepMin so wall-foot coherence
  // can be asserted without rebuilding geometry. Renderer only tessellates.
  const segments = planPadSkirtSegments(polygon, padY, site);
  for (const segment of segments) {
    const base = skirtPositions.length / 3;
    skirtPositions.push(
      segment.a.x, segment.topY, segment.a.z,
      segment.a.x, segment.bottom0, segment.a.z,
      segment.b.x, segment.topY, segment.b.z,
      segment.b.x, segment.bottom1, segment.b.z,
    );
    skirtIndices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
}

export function buildParcelPads(parcels, site) {
  const group = new THREE.Group();
  group.name = 'village-pads';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  for (const parcel of parcels) {
    if (!parcel.poly) continue;
    emitPad(
      parcel.poly,
      parcel.baseY ?? computePadY(parcel, site),
      site,
      topPositions,
      topIndices,
      skirtPositions,
      skirtIndices,
    );
  }
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopMaterial, 'pad-top'));
  // pad-skirt is the single downhill 축대 course face; same stone material role.
  if (skirtIndices.length) group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'pad-skirt'));
  return group;
}

// poly가 없는 절·궁 feature를 회전 사각 footprint의 석축 terrace에 앉힌다.
export function buildFeaturePad(site, centerX, centerZ, width, depth, rotationY = 0, heightCap = 3.2) {
  const halfWidth = width / 2, halfDepth = depth / 2;
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const polygon = [
    [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
    [halfWidth, halfDepth], [-halfWidth, halfDepth],
  ].map(([x, z]) => ({
    x: centerX + x * cos + z * sin,
    z: centerZ - x * sin + z * cos,
  }));
  let padY = site.heightAt(centerX, centerZ);
  let minimum = padY;
  for (const corner of polygon) {
    const height = site.heightAt(corner.x, corner.z);
    padY = Math.max(padY, height);
    minimum = Math.min(minimum, height);
  }
  padY = Math.min(padY, minimum + heightCap) + PAD_LIFT;

  const group = new THREE.Group();
  group.name = 'feature-pad';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  emitPad(polygon, padY, site, topPositions, topIndices, skirtPositions, skirtIndices);
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopMaterial, 'feat-pad-top'));
  if (skirtIndices.length) group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'feat-pad-skirt'));
  return { group, padY };
}

function localRectPolygon(frame, minX, maxX, minZ, maxZ) {
  return [
    { x: maxX, z: maxZ }, { x: minX, z: maxZ },
    { x: minX, z: minZ }, { x: maxX, z: minZ },
  ].map((point) => parcelWorldPoint(frame, point));
}

function samplePolygonRange(site, frame, width, depth, divisions = 4) {
  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  let min = Infinity, max = -Infinity;
  for (let row = 0; row <= divisions; row++) for (let column = 0; column <= divisions; column++) {
    const point = parcelWorldPoint(frame, {
      x: -halfWidth + width * column / divisions,
      z: -halfDepth + depth * row / divisions,
    });
    const height = site.heightAt(point.x, point.z);
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return { min, max, drop: max - min };
}

function polygonMaxHeight(site, polygon) {
  let maximum = -Infinity;
  for (const point of polygon) maximum = Math.max(maximum, site.heightAt(point.x, point.z));
  const center = G.polyCentroid(polygon);
  return Math.max(maximum, site.heightAt(center.x, center.z));
}

// A sloped temple site cannot use the generic capped single shelf: lowering it
// buries the rear hall, while raising it produces one enormous front wall. Keep
// the precinct at the real rotated-footprint maximum and, only when needed, cover
// the downhill face with narrow apron terraces. All tiers share two aggregate
// buffers, so terrain adaptation does not add draw calls.
export function buildTempleFeaturePad(site, temple) {
  const frame = {
    center: { x: temple.x, z: temple.z },
    frontDir: temple.frontDir || { x: 0, z: 1 },
  };
  const width = templeCompoundWidth(temple);
  const depth = templeCompoundDepth(temple);
  const upper = templeFootprint(temple);
  const relief = samplePolygonRange(site, frame, width, depth);
  const reliefCap = temple.placement?.reliefCap
    || Math.min(8, Math.max(4, (site.Hmax || 68) * 0.08));
  // Above roughly one human storey, split the downhill face so even a compact
  // precinct reads as low retaining terraces rather than a single plinth.
  const terraceRiseCap = Math.min(2.4, reliefCap);
  const tierCount = Math.max(1, Math.min(3, Math.ceil(relief.drop / Math.max(1, terraceRiseCap))));
  const padY = Number.isFinite(temple.baseY) ? temple.baseY : relief.max + TEMPLE_PAD_LIFT;
  const surfaces = [{ polygon: upper, y: padY, role: 'court' }];

  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  const apronDepth = 5.2;
  const overlap = 0.9;
  for (let tier = 1; tier < tierCount; tier++) {
    const back = halfDepth - overlap + (tier - 1) * (apronDepth - overlap);
    const front = back + apronDepth;
    const apronHalfWidth = halfWidth + 0.7 - tier * 0.35;
    const polygon = localRectPolygon(frame, -apronHalfWidth, apronHalfWidth, back, front);
    const desired = padY - relief.drop * tier / tierCount;
    const y = Math.max(desired, polygonMaxHeight(site, polygon) + PAD_LIFT);
    surfaces.push({ polygon, y, role: 'apron' });
  }

  const group = new THREE.Group();
  group.name = 'feature-pad';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  for (const surface of surfaces) {
    emitPad(
      surface.polygon,
      surface.y,
      site,
      topPositions,
      topIndices,
      skirtPositions,
      skirtIndices,
    );
  }
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopMaterial, 'feat-pad-top'));
  if (skirtIndices.length) group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'feat-pad-skirt'));
  group.userData.terraceCount = tierCount;
  return { group, padY, surfaces, relief, reliefCap, tierCount };
}

import * as THREE from 'three';
import { ROOF_SHELL_THICKNESS } from '../core/surface-clearance.js';
import { ROOF_STRUCTURE_LAYER } from '../builder/ceiling-plan.js';

// Physical tile shell: zero-thickness DoubleSide put the outer tile and the
// structural gaepan underside on one plane → z-fighting (esp. during assembly).
// Authored thickness is the 개판/산자 layer of the roof stack, NOT room 반자.
// See docs/ceiling.md.

const N_EPS = 1e-8;

/**
 * Unit exterior normal at vertex i. Degenerate (zero-length) normals — which
 * appear at some roof-mesh poles/corners after computeVertexNormals — must not
 * leave the underside un-offset: that parks a gaepan vertex on the outer tile
 * and z-fights under any camera / assembly motion.
 */
function exteriorUnitNormal(nrm, i) {
  let nx = nrm.getX(i);
  let ny = nrm.getY(i);
  let nz = nrm.getZ(i);
  let len = Math.hypot(nx, ny, nz);
  if (len < N_EPS) {
    // Fall back to world-up so we still sink below the outer skin.
    return { nx: 0, ny: 1, nz: 0 };
  }
  nx /= len;
  ny /= len;
  nz /= len;
  // Face winding can leave some slopes with ny < 0 (paljak side/rear); flip so
  // we always step toward the interior void (below the outer tile).
  if (ny < 0) return { nx: -nx, ny: -ny, nz: -nz };
  return { nx, ny, nz };
}

/**
 * Offset a surface along its vertex normals to form the structural underside
 * (개판). Returns a new geometry (caller owns it). Winding is flipped so
 * FrontSide faces the interior / eave void.
 *
 * Every vertex is displaced by exactly `thickness` along a unit exterior normal
 * (with a safe fallback for degenerates). Callers may assert same-index distance
 * ≈ thickness to guard against coplanar outer/gaepan.
 */
export function makeRoofUndersideGeometry(sourceGeo, thickness = ROOF_SHELL_THICKNESS) {
  const geo = sourceGeo.clone();
  // Always rebuild normals from the clone so we do not inherit a half-updated
  // attribute from a previous shell pass on a shared source.
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const { nx, ny, nz } = exteriorUnitNormal(nrm, i);
    pos.setXYZ(
      i,
      pos.getX(i) - nx * thickness,
      pos.getY(i) - ny * thickness,
      pos.getZ(i) - nz * thickness,
    );
  }
  const idx = geo.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      const c = idx.getX(i + 2);
      idx.setX(i + 1, c);
      idx.setX(i + 2, b);
    }
  } else {
    const swapAttr = (attr) => {
      if (!attr) return;
      const item = attr.itemSize;
      const arr = attr.array;
      for (let t = 0; t + 2 < attr.count; t += 3) {
        for (let k = 0; k < item; k++) {
          const i1 = (t + 1) * item + k;
          const i2 = (t + 2) * item + k;
          const tmp = arr[i1];
          arr[i1] = arr[i2];
          arr[i2] = tmp;
        }
      }
      attr.needsUpdate = true;
    };
    swapAttr(pos);
    swapAttr(geo.attributes.uv);
    // Drop inherited normals; recompute after winding flip.
  }
  // Normals after offset + flip must be rebuilt; do not keep the pre-offset attr.
  geo.deleteAttribute('normal');
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Minimum same-index world distance between an outer tile mesh and its gaepan.
 * Used by pure contracts — must stay near ROOF_SHELL_THICKNESS.
 */
export function roofShellPairMinSeparation(outer, under) {
  if (!outer?.geometry || !under?.geometry) return 0;
  outer.updateWorldMatrix(true, false);
  under.updateWorldMatrix(true, false);
  const pa = outer.geometry.attributes.position;
  const pb = under.geometry.attributes.position;
  if (!pa || !pb || pa.count !== pb.count) return 0;
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  let min = Infinity;
  for (let i = 0; i < pa.count; i++) {
    va.fromBufferAttribute(pa, i).applyMatrix4(outer.matrixWorld);
    vb.fromBufferAttribute(pb, i).applyMatrix4(under.matrixWorld);
    const d = va.distanceTo(vb);
    if (d < min) min = d;
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * Add outer tile (FrontSide) + structural gaepan underside (FrontSide).
 * Room 반자 is a separate planned finish (docs/ceiling.md) — never this mesh.
 *
 * Assembly: both halves share the same asmGroup so visibility stagger cannot
 * reveal one face alone against a coplanar partner (depth stack must stay locked).
 */
export function addRoofTileShell(group, geometry, outerMat, underMat, thickness = ROOF_SHELL_THICKNESS) {
  outerMat.side = THREE.FrontSide;
  const outer = new THREE.Mesh(geometry, outerMat);
  outer.castShadow = outer.receiveShadow = true;
  outer.name = 'roof-tile-outer';
  outer.userData.roofLayer = ROOF_STRUCTURE_LAYER.TILE;
  // Default body chunk; builders may retag finials, never leave outer/under unmatched.
  if (!outer.userData.asmGroup) outer.userData.asmGroup = 'body';
  group.add(outer);

  const underGeo = makeRoofUndersideGeometry(geometry, thickness);
  // Gaepan is the under-eave "ceiling" read. It must not inherit eaveBand's roof-rim
  // kick: Fresnel on the broad underside reads as gold static/z-fight sparkle under
  // reverse light and during assembly (docs/ceiling.md, surface-materials).
  underMat.userData.paletteKey = 'gaepan';
  underMat.userData.isRoofGaepan = true;
  underMat.userData.role = underMat.userData.role || 'roof';
  const under = new THREE.Mesh(underGeo, underMat);
  under.castShadow = false;
  under.receiveShadow = true;
  under.name = 'roof-gaepan';
  under.userData.roofLayer = ROOF_STRUCTURE_LAYER.GAEPAN;
  under.userData.isRoomBanja = false;
  under.userData.asmGroup = outer.userData.asmGroup;
  group.add(under);
  return { outer, under };
}

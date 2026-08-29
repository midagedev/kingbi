import * as THREE from 'three';
import { TILE_LOOK } from '../builder/material-colors.js';
import { tileSurfaceMaterial } from '../builder/palette.js';

// 작은 맞배(gable) 기와 지붕 조각. 담장 지붕담·일각문·솟을대문 칸이 공유.
// 좌표계: 용마루는 X축 방향, z=0 중심. 처마는 z=±zEave, 용마루는 z=0.
// M = builder/palette.makeMaterials(...) 결과.
//
// opts:
//   length     용마루 길이(X). 지붕면은 overhangX 만큼 더 뻗음.
//   halfSpan   처마 반폭(z). eave = halfSpan+overhangZ.
//   eaveY,ridgeY  처마·용마루 높이(y).
//   overhangX,overhangZ  내밀기.
//   curve      지붕면 오목 곡률(0=직선) — 처마 쪽이 완만해짐.
//   dots       처마 흰 막새 열 + 처마 단 띠.
//   gableEnds  ±X 끝 박공 삼각(회벽) + 박공널.
//   ridgeR     용마루 반경.
//   gableMat   박공 삼각 재질(기본 M.plaster).
export function buildTileGableRoof(M, o) {
  const {
    length, halfSpan, eaveY, ridgeY,
    overhangX = 0.25, overhangZ = 0.14, curve = 0.35,
    dots = true, gableEnds = true, ridgeR = 0.10, gableMat = null, name = 'roof',
  } = o;
  const g = new THREE.Group();
  g.name = name;
  const xr = length / 2 + overhangX;
  const zEave = halfSpan + overhangZ;
  const rise = ridgeY - eaveY;
  const slope = Math.hypot(zEave, rise);

  // 오목 프로파일: v(0=용마루..1=처마)에서 y 낙차를 곡선화
  const yAt = (v) => ridgeY - rise * (curve ? (1 - Math.pow(1 - v, 1 + curve * 2)) : v);

  const mat = tileSurfaceMaterial(M, 2 * xr, slope, TILE_LOOK.bumpSurface);
  mat.side = THREE.DoubleSide;

  const NX = 10, NZ = 5;
  for (const sign of [1, -1]) {
    const pos = [], uv = [], idx = [];
    for (let iz = 0; iz <= NZ; iz++) {
      const v = iz / NZ;
      const z = sign * zEave * v;
      const y = yAt(v);
      for (let ix = 0; ix <= NX; ix++) {
        const x = -xr + 2 * xr * (ix / NX);
        pos.push(x, y, z);
        uv.push((ix / NX) * (2 * xr / 0.34), v * (slope / 0.9));
      }
    }
    for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
      const a = iz * (NX + 1) + ix, b = a + 1, c = a + NX + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }

  // 용마루
  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(ridgeR, ridgeR, 2 * xr, 10), M.tileRidge);
  ridge.rotation.z = Math.PI / 2;
  ridge.position.set(0, ridgeY + ridgeR * 0.35, 0);
  ridge.castShadow = true;
  g.add(ridge);
  for (const sx of [1, -1]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(ridgeR * 1.35, 10, 8), M.tileRidge);
    cap.scale.set(0.8, 1.05, 1.25);
    cap.position.set(sx * xr, ridgeY + ridgeR * 0.35, 0);
    cap.castShadow = true;
    g.add(cap);
  }

  // 처마 막새 흰 열 + 처마 단 띠
  if (dots) {
    const dotGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.06, 10);
    dotGeo.rotateX(Math.PI / 2);
    const dotMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d6, roughness: 0.85 });
    const nd = Math.max(3, Math.round((2 * xr) / 0.3));
    for (const sign of [1, -1]) {
      const im = new THREE.InstancedMesh(dotGeo, dotMat, nd + 1);
      const mm = new THREE.Matrix4();
      for (let i = 0; i <= nd; i++) {
        mm.makeTranslation(-xr + (2 * xr) * (i / nd), eaveY + 0.02, sign * (zEave + 0.015));
        im.setMatrixAt(i, mm);
      }
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true;
      g.add(im);
      const band = new THREE.Mesh(new THREE.BoxGeometry(2 * xr, 0.09, 0.05), M.tileRidge);
      band.position.set(0, eaveY - 0.03, sign * zEave);
      band.castShadow = true;
      g.add(band);
    }
  }

  // 박공 삼각 + 박공널 (±X 끝)
  if (gableEnds) {
    const gm = (gableMat || M.plaster).clone ? (gableMat || M.plaster).clone() : (gableMat || M.plaster);
    gm.side = THREE.DoubleSide;
    for (const sx of [1, -1]) {
      const x = sx * (length / 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([
        x, eaveY, -halfSpan, x, eaveY, halfSpan, x, ridgeY, 0,
      ], 3));
      geo.setIndex([0, 1, 2]);
      geo.computeVertexNormals();
      const tri = new THREE.Mesh(geo, gm);
      tri.castShadow = true;
      g.add(tri);
      // 박공널 (경사변 어두운 테)
      for (const sz of [1, -1]) {
        const from = new THREE.Vector3(sx * xr, ridgeY + 0.02, 0);
        const to = new THREE.Vector3(sx * xr, eaveY, sz * zEave);
        const len = from.distanceTo(to);
        const board = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, len), M.woodDark);
        board.position.copy(from).lerp(to, 0.5);
        board.lookAt(to);
        board.castShadow = true;
        g.add(board);
      }
    }
  }
  return g;
}

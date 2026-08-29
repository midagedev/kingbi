import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { buildTileGableRoof } from './tileroof.js';

// 행각(行閣)/회랑(回廊): 좁은 1칸 깊이의 긴 맞배지붕 건물. 마당을 둘러 구성한다.
// 바깥면=회벽, 안마당면=개방 기둥열. 폴리라인을 따라 세그먼트별로 세운다.
//
// buildCorridor({ points, closed, mats, seed, depth, bayLen, colH, openEvery, innerSide })
//   points   [{x,z}...] 폴리라인 (월드 좌표)
//   closed   폐곡선(ㅁ자 회랑)
//   depth    깊이(칸), bayLen 기둥 간격, colH 기둥 높이
//   openEvery n칸마다 출입간(회벽 끊고 문지방돌). 0=없음
//   innerSide +1 이면 좌측 법선(내측)이 마당쪽(개방). 폐곡선(CCW)은 +1이 안쪽.
// 반환: { group }
export function buildCorridor({
  points, closed = false, mats, seed = 1, depth = 2.6, bayLen = 2.5,
  colH = 2.6, openEvery = 0, innerSide = 1,
} = {}) {
  const rng = makeRng((seed | 0) ^ 0x51ed);
  const M = mats;
  const group = new THREE.Group();
  group.name = 'corridor';
  const baseH = 0.28;
  const eaveY = colH, ridgeY = colH + 0.85;

  const verts = points.map((p) => ({ x: p.x, z: p.z }));
  const nSeg = closed ? verts.length : verts.length - 1;

  // 한 세그먼트(로컬: X=길이 중앙정렬, +Z=내측(마당), Y=위)
  function segment(len, segIndex) {
    const g = new THREE.Group();
    const zc = depth / 2;               // 마당쪽 기둥열(+Z), 바깥벽(-Z)
    // 기단
    const base = new THREE.Mesh(new THREE.BoxGeometry(len, baseH, depth + 0.3), M.stone);
    base.position.y = baseH / 2; base.receiveShadow = true; base.castShadow = true;
    g.add(base);
    // 바깥 회벽
    const wall = new THREE.Mesh(new THREE.BoxGeometry(len, colH - baseH, 0.18), M.plaster);
    wall.position.set(0, (baseH + colH) / 2, -zc);
    wall.castShadow = wall.receiveShadow = true;
    g.add(wall);
    // 기둥열 (앞뒤)
    const colGeo = new THREE.CylinderGeometry(0.13, 0.14, colH - baseH, 10);
    colGeo.translate(0, (colH - baseH) / 2, 0);
    const nCol = Math.max(2, Math.round(len / bayLen));
    for (let i = 0; i <= nCol; i++) {
      const x = -len / 2 + len * (i / nCol);
      for (const z of [zc, -zc]) {
        const c = new THREE.Mesh(colGeo, M.wood);
        c.position.set(x, baseH, z); c.castShadow = true; g.add(c);
      }
    }
    // 창방 (앞뒤 기둥머리 도리)
    for (const z of [zc, -zc]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.15, 0.15), M.woodDark);
      beam.position.set(0, colH - 0.1, z); beam.castShadow = true; g.add(beam);
    }
    // 안마당면 하부 머름(낮은 난간벽) — 개방감 유지하며 행랑 느낌
    const mureum = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, 0.1), M.woodDark);
    mureum.position.set(0, baseH + 0.25, zc);
    g.add(mureum);
    // 지붕 (맞배, 용마루=로컬 X)
    const roof = buildTileGableRoof(M, {
      length: len, halfSpan: depth / 2 + 0.15, eaveY, ridgeY,
      overhangX: 0, overhangZ: 0.28, curve: 0.4, dots: true,
      gableEnds: !closed && (segIndex === 0 || segIndex === nSeg - 1), ridgeR: 0.09,
    });
    g.add(roof);
    return g;
  }

  for (let si = 0; si < nSeg; si++) {
    const a = verts[si], b = verts[(si + 1) % verts.length];
    const d = { x: b.x - a.x, z: b.z - a.z };
    const L = Math.hypot(d.x, d.z);
    if (L < 0.1) continue;
    const child = segment(L, si);
    child.position.set((a.x + b.x) / 2, 0, (a.y + b.y || 0) * 0 + (a.z + b.z) / 2);
    child.rotation.y = Math.atan2(-d.z, d.x);
    if (innerSide < 0) child.rotation.y += Math.PI; // 내측 방향 반전
    group.add(child);

    // 모서리 기둥(폐곡선 꺾임 마감)
    if (closed || si < nSeg - 1) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.17, colH, 10), M.wood);
      post.position.set(b.x, colH / 2, b.z); post.castShadow = true;
      group.add(post);
    }
  }
  return { group };
}

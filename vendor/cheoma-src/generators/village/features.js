import * as THREE from 'three';
import { buildPavilion } from '../../builder/pavilion.js';
import { buildBridge } from '../../builder/bridge.js';
import { buildFerryCrossing } from '../../builder/ferry.js';
import { buildParcel } from '../../layout/parcel.js';
import { buildProp } from '../../props/index.js';
import { buildTempleCompound } from '../../temple/compound.js';
import { planTempleCompound } from '../../temple/plan.js';
import { buildPalaceCompound } from '../../village/palace.js';
import { mergeStatic } from '../../village/instancing.js';
import * as G from '../../core/math/geom2.js';
import {
  streamSurfaceHeightAt,
  terrainMeshHeightAt,
} from '../../village/terrain-grid.js';
import {
  TEMPLE_PATH_WIDTH,
  templeCompoundDepth,
  templeCompoundWidth,
} from '../../village/temple-plan.js';
import {
  buildFeaturePad,
  buildTempleFeaturePad,
  computePadY,
  featurePadMaterials,
} from './pads.js';
import { buildSijeon as renderSijeon } from './sijeon.js';
import { planSijeonFacade } from '../../village/sijeon-plan.js';
import { TILE_LOOK } from '../../builder/material-colors.js';
import { tileSurfaceMaterial } from '../../builder/palette.js';
import {
  buildMjaHouse,
  disposeMjaHouse,
} from '../../village/mja-house-geometry.js';

function sijeonMaterial(color, roughness, role) {
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
  material.userData.role = role;
  return material;
}

// Village palette adapter for the reusable sijeon renderer. These plain PBR
// materials are the only caller-owned resources it needs: no hidden canvas
// textures, emissive edge light, or full hanok palette allocation.
//
// 고증 수정(docs/architectural-authenticity.md §7.5 W2):
//   - `frame`: 종전 0x6f3626 은 궁 석간주 계열 산화적색이었다. 시전은 민간 상업건축이므로 주칠
//     위계에 들지 않는다 → 반가 문틀과 같은 백골 계열 갈색(§7.5 W1 과 동일 값).
//   - `opening`: 종전 0x241a14 는 day 노출에서도 완전한 검정 공동으로 읽혀 `sijeon.md` §3.2-4 가
//     명시 금지한 "빈 동굴"이 됐다. 후퇴 배면을 판독 가능한 널 목재 톤으로 올리고, plan 이 얹은
//     판문 한 짝(openings[].panel)이 그 앞에 서서 면과 깊이를 함께 만든다.
//   - `roof`: 종전은 텍스처 없는 균일 진회색 평판이라 기와가 아닌 판형 지붕으로 읽혔고,
//     `snowSurface` 계약이 전제하는 기와와도 어긋났다. `palette` 가 오면 마을이 **이미 가진** 공유
//     기와 캔버스(mats.tileTex)를 tileSurfaceMaterial 로 재사용한다 — 새 캔버스를 만들지 않으므로
//     `sijeon.md` §4.1 의 "새 텍스처 0" 예산 안이다(§7.7-4: 공유 자원 재사용은 예산 소비가 아니다).
//     시전 배치는 전 점포가 같은 6.2×8.5 라 지붕면 재질 한 벌로 열 전체를 덮는다 → 재질 수 불변.
export function buildVillageSijeon(shops, site, palette = null) {
  // Roof UV sample must come from a real shop façade, never a reserved break slot.
  const roofSample = (Array.isArray(shops) ? shops : []).find((shop) => shop && shop.kind !== 'break')
    || null;
  const materials = {
    frame: sijeonMaterial(0x6a5a44, 0.85, 'wood'),
    opening: sijeonMaterial(0x453527, 0.94, 'opening'),
    bench: sijeonMaterial(0x765031, 0.9, 'wood'),
    storage: sijeonMaterial(0xd4cbb5, 0.97, 'wall'),
    roof: sijeonRoofMaterial(roofSample ? [roofSample] : shops, palette),
  };
  materials.roof.userData.snowSurface = true;
  // 깊은 처마 밑 후퇴 배면은 그림자 안이라 색만 올려선 검게 죽는다. 팔레트가 이미 같은 문제에 쓰는
  //   미량 emissive 관례(백골 목재·이엉의 emissive)를 따라, 배면이 널 목재로 판독되게 바닥을 올린다.
  materials.opening.emissive.setHex(0x17120b);
  try {
    return renderSijeon(shops, { materials, heightAt: site?.heightAt });
  } catch (error) {
    for (const material of Object.values(materials)) material.dispose();
    throw error;
  }
}

// 지붕면 기와 재질 한 벌. 반복수는 실제 지붕 폭·경사 길이에서 나와야 기와 골이 원경에서도 방향성을
//   갖는다(개별 수키와 모델링은 불필요). palette 가 없는 경로(코어 하네스 등)는 종전 단색으로 폴백.
function sijeonRoofMaterial(shops, palette) {
  const sample = Array.isArray(shops) && shops.length ? shops[0] : null;
  if (!palette?.tileTex || !sample) return sijeonMaterial(0x45494e, 0.9, 'roof');
  const { roof } = planSijeonFacade(sample);
  return tileSurfaceMaterial(palette, roof.width, Math.hypot(roof.depth / 2, roof.rise), TILE_LOOK.bumpSurface);
}

// 컴파운드 내부의 실제 door/hanji material set을 야간 패치 대상으로 모은다.
export function collectMaterialSets(root, target) {
  root.traverse((object) => {
    const materials = object.userData?.materials || object.userData?.mats;
    if (materials?.door && !target.includes(materials)) target.push(materials);
  });
}

export function buildPaddyFields(site, paddies) {
  const group = new THREE.Group();
  group.name = 'village-paddies';
  const fieldMaterials = new Map();
  const fieldMaterial = (tone) => {
    if (!fieldMaterials.has(tone)) {
      fieldMaterials.set(tone, new THREE.MeshStandardMaterial({
        color: tone, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
      }));
    }
    return fieldMaterials.get(tone);
  };
  const isLargeSite = site.R > 300;
  const bundMaterial = isLargeSite
    ? new THREE.MeshStandardMaterial({ color: 0x94875a, roughness: 1, metalness: 0, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: 0x7a7048, roughness: 1, metalness: 0 });
  const bundHeight = isLargeSite ? 0.34 : 0.22;

  for (const field of paddies) {
    const shape = new THREE.Shape();
    field.poly.forEach((point, index) => {
      if (index) shape.lineTo(point.x, -point.z);
      else shape.moveTo(point.x, -point.z);
    });
    shape.closePath();
    const fieldGeometry = new THREE.ShapeGeometry(shape);
    fieldGeometry.rotateX(-Math.PI / 2);
    const fieldMesh = new THREE.Mesh(fieldGeometry, fieldMaterial(field.tone || 0x6a7b3f));
    fieldMesh.position.y = field.y;
    fieldMesh.receiveShadow = true;
    group.add(fieldMesh);

    const ring = [...field.poly, field.poly[0]];
    const topY = field.y + bundHeight;
    const positions = [], indices = [];
    if (isLargeSite) {
      const center = { x: 0, z: 0 };
      for (const point of field.poly) { center.x += point.x; center.z += point.z; }
      center.x /= field.poly.length; center.z /= field.poly.length;
      for (const point of ring) {
        let dx = center.x - point.x, dz = center.z - point.z;
        const distance = Math.hypot(dx, dz) || 1;
        const inset = Math.min(1.1, distance * 0.45);
        dx = dx / distance * inset; dz = dz / distance * inset;
        positions.push(
          point.x, field.y, point.z,
          point.x, topY, point.z,
          point.x + dx, topY, point.z + dz,
        );
      }
      for (let i = 0; i < ring.length - 1; i++) {
        const a = i * 3, b = a + 3;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
        indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
      }
    } else {
      for (const point of ring) positions.push(point.x, field.y, point.z, point.x, topY, point.z);
      for (let i = 0; i < ring.length - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, c, b, b, c, d);
      }
    }
    const bundGeometry = new THREE.BufferGeometry();
    bundGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    bundGeometry.setIndex(indices);
    bundGeometry.computeVertexNormals();
    group.add(new THREE.Mesh(bundGeometry, bundMaterial));
  }
  return group;
}

export function buildHeroParcel(parcel, site) {
  const group = new THREE.Group();
  if (parcel.mjaHouse) {
    const compound = buildMjaHouse(parcel.mjaHouse);
    group.add(compound);
    group.userData.disposeCompound = () => {
      const disposed = disposeMjaHouse(compound);
      compound.removeFromParent();
      return disposed;
    };
  } else {
    const heroStyle = parcel.heroStyle || 'hanok';
    group.add(buildParcel({
      seed: parcel.seed || 7,
      style: heroStyle,
      plotW: parcel.plotW,
      plotD: parcel.plotD,
      lanterns: false,
      // Plan-authored roofRank wins; heroStyle palace is always magistracy/gaeksa.
      roofRank: parcel.roofRank
        ?? (heroStyle === 'palace' ? 'magistracy' : null),
    }));
  }
  group.rotation.y = G.facingY(parcel.frontDir);
  group.position.set(
    parcel.center.x,
    parcel.baseY ?? computePadY(parcel, site),
    parcel.center.z,
  );
  group.userData.parcel = parcel;
  return group;
}

function buildTempleApproach(temple, site, surfaces) {
  const group = new THREE.Group();
  group.name = 'temple-approach';
  const path = temple.path || [];
  if (path.length < 2) return group;
  const width = temple.pathWidth || TEMPLE_PATH_WIDTH;
  const materials = featurePadMaterials();
  const heightAt = (point) => {
    let height = terrainMeshHeightAt(site, point.x, point.z) + 0.075;
    for (const surface of surfaces) {
      if (G.pointInPoly(point, surface.polygon)) height = Math.max(height, surface.y + 0.015);
    }
    return height;
  };
  const tangentAt = (index) => G.norm(G.sub(
    path[Math.min(path.length - 1, index + 1)],
    path[Math.max(0, index - 1)],
  ));

  const positions = [], indices = [], heights = [];
  for (let index = 0; index < path.length; index++) {
    const point = path[index], tangent = tangentAt(index), normal = G.perpR(tangent);
    const left = G.add(point, G.mul(normal, width * 0.5));
    const right = G.add(point, G.mul(normal, -width * 0.5));
    const leftY = heightAt(left), rightY = heightAt(right);
    positions.push(left.x, leftY, left.z, right.x, rightY, right.z);
    heights.push((leftY + rightY) * 0.5);
    if (!index) continue;
    const previous = (index - 1) * 2, current = index * 2;
    indices.push(previous, current, previous + 1, previous + 1, current, current + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const ribbon = new THREE.Mesh(geometry, materials.top);
  ribbon.name = 'temple-approach-ribbon';
  ribbon.receiveShadow = true;
  group.add(ribbon);

  const stepPositions = [], stepIndices = [];
  const emitStep = (point, tangent, y) => {
    const right = G.perpR(tangent);
    const halfWidth = width * 0.56, halfDepth = 0.24, halfHeight = 0.08;
    const base = stepPositions.length / 3;
    for (const [sx, sy, sz] of [
      [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
      [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
    ]) {
      stepPositions.push(
        point.x + right.x * sx * halfWidth + tangent.x * sz * halfDepth,
        y + sy * halfHeight,
        point.z + right.z * sx * halfWidth + tangent.z * sz * halfDepth,
      );
    }
    for (const triangle of [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ]) stepIndices.push(...triangle.map((index) => base + index));
  };
  for (let index = 0; index < path.length - 1; index++) {
    const distance = G.dist(path[index], path[index + 1]);
    if (distance < 1e-6) continue;
    const rise = Math.abs(heights[index + 1] - heights[index]);
    if (rise / distance < 0.16 && rise < 0.55) continue;
    emitStep(
      G.lerp(path[index], path[index + 1], 0.5),
      G.norm(G.sub(path[index + 1], path[index])),
      (heights[index] + heights[index + 1]) * 0.5 + 0.08,
    );
  }
  if (stepIndices.length) {
    const stepGeometry = new THREE.BufferGeometry();
    stepGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stepPositions, 3));
    stepGeometry.setIndex(stepIndices);
    stepGeometry.computeVertexNormals();
    const steps = new THREE.Mesh(stepGeometry, materials.stone);
    steps.name = 'temple-approach-steps';
    steps.castShadow = true;
    steps.receiveShadow = true;
    group.add(steps);
    group.userData.stepCount = stepIndices.length / 36;
  } else group.userData.stepCount = 0;
  group.userData.drawCalls = group.children.length;
  return group;
}

export function buildTempleCluster(temple, site) {
  const group = new THREE.Group();
  group.name = 'temple-cluster';
  const width = templeCompoundWidth(temple);
  const depth = templeCompoundDepth(temple);
  const rotationY = G.facingY(temple.frontDir || { x: 0, z: 1 });
  const { group: pad, padY, surfaces } = buildTempleFeaturePad(site, temple);
  const approach = buildTempleApproach(temple, site, surfaces);
  group.add(pad);
  group.add(approach);
  const inner = new THREE.Group();
  inner.name = 'temple-inner';
  const fallbackVariant = Math.max(width, depth) >= 52 ? 'extended'
    : Math.max(width, depth) >= 36 ? 'courtyard' : 'compact';
  const compound = buildTempleCompound(temple.compound || planTempleCompound({
    seed: temple.seed || 11,
    variant: fallbackVariant,
    width,
    depth,
  }));
  inner.add(compound);
  inner.rotation.y = rotationY;
  inner.position.set(temple.x, padY, temple.z);
  group.add(inner);
  group.userData.templeCompound = compound;
  group.userData.templeInner = inner;
  group.userData.templeSiteObjects = [pad, approach];
  return group;
}

function buildPalaceCore(palace, site) {
  const group = new THREE.Group();
  group.name = 'palace-core';
  const width = palace.plotW || 40, depth = palace.plotD || 34;
  const rotationY = G.facingY(palace.frontDir || { x: 0, z: 1 });
  const { group: pad, padY } = buildFeaturePad(
    site, palace.x, palace.z, width + 4, depth + 4, rotationY,
  );
  group.add(pad);
  const inner = new THREE.Group();
  const compound = palace.tier
    ? buildPalaceCompound({
        w: width, d: depth, tier: palace.tier,
        variant: palace.variant || 'axial', seed: palace.seed || 5,
      })
    : buildParcel({
        seed: palace.seed || 5, style: 'palace',
        plotW: width, plotD: depth, lanterns: false,
      });
  inner.add(compound);
  inner.rotation.y = rotationY;
  inner.position.set(palace.x, padY, palace.z);
  group.add(inner);
  group.userData.palaceCompound = compound;
  return group;
}

export function buildFeatureObjects(plan, site) {
  const features = plan.features;
  const objects = [];
  if (features.pavilion) {
    const pavilion = buildPavilion({ sides: features.pavilion.sides || 6 });
    pavilion.position.set(
      features.pavilion.x,
      site.heightAt(features.pavilion.x, features.pavilion.z),
      features.pavilion.z,
    );
    pavilion.rotation.y = features.pavilion.rot || 0;
    objects.push(pavilion);
  }
  for (const bridgeSpec of features.bridges || []) {
    const bridge = buildBridge({
      type: bridgeSpec.type || 'slab',
      span: bridgeSpec.span || 5,
      width: bridgeSpec.width || 1.8,
    });
    const streamZ = site.streamZat(bridgeSpec.x);
    const bankHeight = Math.max(
      site.heightAt(bridgeSpec.x, streamZ - (site.streamHalf + 3)),
      site.heightAt(bridgeSpec.x, streamZ + (site.streamHalf + 3)),
    );
    const waterY = streamSurfaceHeightAt(site, bridgeSpec.x, streamZ);
    const y = bridgeSpec.type === 'arch'
      ? waterY
      : Math.max(waterY, bankHeight - 0.35);
    bridge.position.set(bridgeSpec.x, y, bridgeSpec.z);
    bridge.rotation.y = bridgeSpec.rot || 0;
    objects.push(bridge);
  }
  if (features.ferry) {
    const spec = features.ferry;
    const waterY = streamSurfaceHeightAt(site, spec.x, spec.z);
    const northRise = site.heightAt(spec.north.x, spec.north.z) - waterY;
    const southRise = site.heightAt(spec.south.x, spec.south.z) - waterY;
    const ferry = buildFerryCrossing({
      span: spec.span,
      waterWidth: spec.waterWidth,
      width: site.scale === 'hanyang' ? 5.2 : 4.2,
      northRise,
      southRise,
      boatCount: spec.boatCount,
    });
    ferry.position.set(spec.x, waterY, spec.z);
    ferry.rotation.y = spec.rot || 0;
    objects.push(ferry);
  }
  for (const propSpec of features.props || []) {
    const prop = buildProp(propSpec.name, { seed: propSpec.seed || 3, scale: propSpec.scale });
    prop.position.set(propSpec.x, site.heightAt(propSpec.x, propSpec.z), propSpec.z);
    prop.rotation.y = propSpec.rot || 0;
    objects.push(prop);
  }
  if (features.temple) objects.push(buildTempleCluster(features.temple, site));
  if (features.palace) objects.push(buildPalaceCore(features.palace, site));
  return objects;
}

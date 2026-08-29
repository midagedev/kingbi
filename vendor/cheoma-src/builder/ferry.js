import * as THREE from 'three';
import { getPropMaterials } from '../props/materials.js';

function rampBetween(x0, y0, x1, y1, width, material) {
  const length = Math.hypot(x1 - x0, y1 - y0);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(length, 0.18, width), material);
  ramp.position.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, 0);
  ramp.rotation.z = Math.atan2(y1 - y0, x1 - x0);
  ramp.castShadow = ramp.receiveShadow = true;
  return ramp;
}

function ferryHullGeometry(length, width, height) {
  const z0 = -length * 0.5, z1 = length * 0.5;
  const zm = 0;
  const x = width * 0.5;
  const top = height * 0.25, bottom = -height * 0.75;
  const positions = [
    0, top, z0, -x, top, zm, 0, top, z1, x, top, zm,
    0, bottom, z0 * 0.72, -x * 0.62, bottom, zm,
    0, bottom, z1 * 0.72, x * 0.62, bottom, zm,
  ];
  const indices = [
    0, 1, 4, 1, 5, 4,
    1, 2, 5, 2, 6, 5,
    2, 3, 6, 3, 7, 6,
    3, 0, 7, 0, 4, 7,
    4, 5, 6, 4, 6, 7,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addBoat(group, materials, { x, z, yaw, cargo = false }) {
  const boat = new THREE.Group();
  const hull = new THREE.Mesh(ferryHullGeometry(8.4, 2.8, 1.1), materials.woodDark);
  hull.castShadow = hull.receiveShadow = true;
  boat.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.14, 5.2), materials.wood);
  deck.position.y = 0.23;
  deck.castShadow = true;
  boat.add(deck);
  // 납작배도 현측과 뱃전은 멀리서 타원형 선체로 읽혀야 한다. 낮은 현실 배를
  // 유지하되 수면 위에 두 줄의 뱃전과 올라간 이물/고물 횡대를 남긴다.
  for (const side of [-1, 1]) {
    const gunwale = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.32, 6.6),
      materials.woodDark,
    );
    gunwale.position.set(side * 1.18, 0.52, 0);
    gunwale.castShadow = true;
    boat.add(gunwale);
  }
  for (const end of [-1, 1]) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(2.25, 0.28, 0.18),
      materials.woodDark,
    );
    beam.position.set(0, 0.58, end * 3.1);
    beam.rotation.x = end * -0.16;
    beam.castShadow = true;
    boat.add(beam);
  }
  if (cargo) {
    for (const [cx, cz, scale] of [[-0.65, -0.5, 1], [0.55, 0.25, 0.8], [-0.15, 0.7, 0.72]]) {
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.85 * scale, 0.65 * scale, 0.85 * scale),
        materials.wood,
      );
      crate.position.set(cx, 0.62 * scale, cz);
      crate.castShadow = true;
      boat.add(crate);
    }
  }
  const oar = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.09, 0.14), materials.woodDark);
  oar.position.set(0.45, 0.72, -0.55);
  oar.rotation.y = -0.18;
  oar.rotation.z = -0.08;
  boat.add(oar);
  const boatman = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.24, 0.72, 7),
    materials.woodDark,
  );
  body.position.y = 0.95;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 8, 6),
    materials.woodWarm,
  );
  head.position.y = 1.43;
  const hat = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.08, 0.12, 10),
    materials.woodDark,
  );
  hat.position.y = 1.62;
  boatman.add(body, head, hat);
  boatman.position.set(-0.45, 0, -0.8);
  boat.add(boatman);
  boat.position.set(x, 0.55, z);
  boat.rotation.y = yaw;
  group.add(boat);
}

// Han-scale water is crossed by managed ferry landings, not a monumental stone
// bridge. Local +X points to the north bank; local Z follows the river.
export function buildFerryCrossing({
  span = 100,
  waterWidth = 80,
  width = 4.2,
  northRise = 1,
  southRise = 1,
  boatCount = 2,
} = {}) {
  const materials = getPropMaterials();
  const group = new THREE.Group();
  group.name = 'river-ferry-crossing';
  const inner = Math.max(5, waterWidth * 0.5 - 9);
  const outer = span * 0.5;
  const deckY = 0.45;

  for (const side of [-1, 1]) {
    const bankRise = side > 0 ? northRise : southRise;
    const outerX = side * outer;
    const innerX = side * inner;
    group.add(rampBetween(
      innerX, deckY,
      outerX, Math.max(deckY, bankRise + 0.08),
      width,
      materials.wood,
    ));
    const piles = Math.max(3, Math.ceil((outer - inner) / 3));
    for (let index = 0; index <= piles; index++) {
      const x = innerX + (outerX - innerX) * index / piles;
      for (const z of [-width * 0.42, width * 0.42]) {
        const pile = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.16, 1.35, 7),
          materials.woodDark,
        );
        pile.position.set(x, -0.12, z);
        pile.castShadow = true;
        group.add(pile);
      }
    }
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 2.5, 0.18),
      materials.woodDark,
    );
    marker.position.set(outerX, Math.max(deckY, bankRise) + 1.25, width * 0.55);
    marker.castShadow = true;
    group.add(marker);
  }

  const boats = Math.max(1, Math.min(3, Math.round(boatCount)));
  for (let index = 0; index < boats; index++) {
    const t = (index + 1) / (boats + 1);
    addBoat(group, materials, {
      x: -waterWidth * 0.34 + waterWidth * 0.68 * t,
      z: (index - (boats - 1) * 0.5) * 5.4,
      yaw: index % 2 ? 0.08 : -0.12,
      cargo: index === 0,
    });
  }
  group.userData = { kind: 'ferry', span, waterWidth, boatCount: boats };
  return group;
}

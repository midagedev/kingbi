import * as THREE from 'three';
import type { Box3dWorld } from '../physics/Box3dWorld';

/**
 * 마당 원본 한옥 — the yard houses render as the REAL cheoma models and
 * come apart PIECE BY PIECE (조각조각): a bullet chips the nearest 부재
 * (기둥·벽판·창호·지붕) off the building, each chip a box3d rigid body
 * riding the shot, tumbling and settling where it lands. No HP ledger —
 * the chipped-part fraction IS the damage: past a threshold the wreck
 * catches fire, past another the whole frame gives at once.
 *
 * Reset restores every fractured mesh to its original parent/transform —
 * no rebuild, no dispose, the night restarts with the village standing.
 */

/** 창호지 pane budget across all mesh houses. */
const GLOW_CAPACITY = 256;
/** Chip thresholds (fraction of the house's fracture parts gone):
 *  past IGNITE the wreck smolders, past COLLAPSE the frame gives. */
const IGNITE_FRACTION = 0.15;
const COLLAPSE_FRACTION = 0.45;
/** Whole-house fracture cap — stride-skip beyond this many remaining. */
const COLLAPSE_PIECE_CAP = 34;

interface MeshHouse {
  index: number;
  root: THREE.Group;
  x: number;
  z: number;
  box: THREE.Box3;
  center: THREE.Vector3;
  /** Fracture units still standing (meshes, in traversal order). */
  parts: THREE.Mesh[];
  totalParts: number;
  chipped: number;
  ignited: boolean;
  collapsed: boolean;
}

interface FractureRecord {
  mesh: THREE.Mesh;
  parent: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export class MeshHouses {
  private readonly houses: MeshHouse[] = [];
  private readonly fractures: FractureRecord[] = [];
  private readonly scene: THREE.Scene;
  private physics: Box3dWorld | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpM = new THREE.Matrix4();
  /** 창호지 — one additive instanced pane mesh, candle-flickered. */
  readonly glowMesh: THREE.InstancedMesh;
  private readonly glowPhase = new Float32Array(GLOW_CAPACITY);
  private readonly glowHouse = new Int32Array(GLOW_CAPACITY).fill(-1);
  private readonly glowOwner = new Array<THREE.Object3D | null>(GLOW_CAPACITY).fill(null);
  /** Pane dead flag (owner stays for reset revive). */
  private readonly glowDead = new Uint8Array(GLOW_CAPACITY);
  private glowTotal = 0;
  private glowTime = 0;
  private glowTick = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const pane = new THREE.PlaneGeometry(1, 1);
    const paneMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.glowMesh = new THREE.InstancedMesh(pane, paneMat, GLOW_CAPACITY);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.name = 'mesh-house-windows';
    this.glowMesh.count = 0;
    this.scene.add(this.glowMesh);
  }

  /** Physics arrives after the wasm bridge boots — chipping before that
   *  just skips the rigid bodies (visuals still fracture). */
  bindPhysics(physics: Box3dWorld | null): void {
    this.physics = physics;
  }

  get houseCount(): number {
    return this.houses.length;
  }

  addHouse(root: THREE.Group, x: number, z: number): number {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const parts: THREE.Mesh[] = [];
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.visible) parts.push(mesh);
    });
    const house: MeshHouse = {
      index: this.houses.length,
      root,
      x,
      z,
      box,
      center: box.getCenter(new THREE.Vector3()),
      parts,
      totalParts: Math.max(1, parts.length),
      chipped: 0,
      ignited: false,
      collapsed: false,
    };
    this.houses.push(house);
    this.stampWindowGlow(house);
    return house.index;
  }

  /** 창호지 — read the builder-authored opening glow anchors straight off
   *  the meshes (cheoma writes userData.openingGlowAnchors; the facade
   *  collector isn't exported, the data is). Windows only — doors stay
   *  dark like the corridors behind them. */
  private stampWindowGlow(house: MeshHouse): void {
    const pos = new THREE.Vector3();
    const outward = new THREE.Vector3();
    const scale = new THREE.Vector3();
    house.root.traverse((object) => {
      const anchors = (object.userData as { openingGlowAnchors?: Array<{ kind?: string; width?: number; height?: number; position?: { x: number; y: number; z: number }; outward?: { x: number; y: number; z: number } }> }).openingGlowAnchors;
      if (!Array.isArray(anchors)) return;
      for (const anchor of anchors) {
        if (this.glowTotal >= GLOW_CAPACITY) return;
        if (anchor.kind && anchor.kind !== 'window') continue;
        if (!anchor.position || !anchor.outward) continue;
        pos.set(anchor.position.x, anchor.position.y, anchor.position.z).applyMatrix4(object.matrixWorld);
        outward.set(anchor.outward.x, anchor.outward.y, anchor.outward.z).transformDirection(object.matrixWorld).normalize();
        if (outward.y > 0.7) continue; // skip roof-facing anchors
        const w = Math.min(1.6, anchor.width ?? 0.8) * 0.92;
        const h = Math.min(2.0, anchor.height ?? 1.1) * 0.92;
        const hash = Math.abs(Math.sin(this.glowTotal * 12.9898 + house.index * 78.233)) % 1;
        const slot = this.glowTotal;
        this.glowTotal += 1;
        this.glowPhase[slot] = hash * Math.PI * 2;
        this.glowHouse[slot] = house.index;
        this.glowOwner[slot] = object;
        this.tmpQ.setFromUnitVectors(this.tmpV.set(0, 0, 1), outward);
        pos.addScaledVector(outward, 0.07);
        this.tmpM.compose(pos, this.tmpQ, scale.set(w, h, 1));
        this.glowMesh.setMatrixAt(slot, this.tmpM);
        const warm = 0.8 + hash * 0.35;
        this.glowMesh.setColorAt(slot, this.tmpColor.setRGB(1.0 * warm, 0.62 * warm, 0.28 * warm));
      }
    });
    this.glowMesh.count = this.glowTotal;
    this.glowMesh.instanceMatrix.needsUpdate = true;
    if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
  }

  private readonly tmpColor = new THREE.Color();

  isCollapsed(index: number): boolean {
    return this.houses[index]?.collapsed ?? true;
  }

  /** Chipped fraction 0..1 — the house's damage truth. */
  fraction(index: number): number {
    const house = this.houses[index];
    return house ? house.chipped / house.totalParts : 0;
  }

  houseCenter(index: number): THREE.Vector3 {
    const house = this.houses[index];
    return house ? house.center : this.tmpV2.set(0, 0, 0);
  }

  /** 상태 감사 (QA): per-house parts/chipped/fraction + window panes. */
  info(): Array<{ index: number; parts: number; chipped: number; fraction: number; ignited: boolean; collapsed: boolean }> {
    return this.houses.map((house) => ({
      index: house.index,
      parts: house.parts.length,
      chipped: house.chipped,
      fraction: +this.fraction(house.index).toFixed(3),
      ignited: house.ignited,
      collapsed: house.collapsed,
    }));
  }

  get windowPanes(): number {
    let n = 0;
    for (let s = 0; s < this.glowTotal; s += 1) if (this.glowOwner[s] && !this.glowDead[s]) n += 1;
    return n;
  }

  /** The building root (cheoma disposal walks it). */
  houseRoot(index: number): THREE.Group | null {
    return this.houses[index]?.root ?? null;
  }

  /** Exact bullet hit on the REAL geometry (doors, walls, eaves — the
   *  ray sees what the player sees). */
  raycast(index: number, origin: THREE.Vector3, dir: THREE.Vector3, far: number): { x: number; y: number; z: number; dist: number } | null {
    const house = this.houses[index];
    if (!house || house.collapsed) return null;
    this.raycaster.set(origin, dir);
    this.raycaster.far = far;
    const hits = this.raycaster.intersectObject(house.root, true);
    const hit = hits[0];
    if (!hit) return null;
    return { x: hit.point.x, y: hit.point.y, z: hit.point.z, dist: hit.distance };
  }

  /** 조각조각 관통 — the bullet SLAMS THROUGH: the entry face spits a
   *  chip back toward the gun (spall), then the far wall blows OUT along
   *  the shot faster than it entered (the exit jet). Returns the new
   *  chipped fraction. */
  chipAt(index: number, hx: number, hy: number, hz: number, dirX: number, dirZ: number, count: number, rng: () => number): number {
    const house = this.houses[index];
    if (!house || house.collapsed) return this.fraction(index);
    const len = Math.hypot(dirX, dirZ) || 1;
    const nx = dirX / len;
    const nz = dirZ / len;
    const rank = (px: number, py: number, pz: number, k: number) => house.parts
      .map((mesh) => {
        this.tmpBox.setFromObject(mesh);
        this.tmpBox.getCenter(this.tmpV);
        return { mesh, d: this.tmpV.distanceToSquared(this.tmpV2.set(px, py, pz)) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, Math.max(1, k))
      .map((entry) => entry.mesh);
    // Entry spall — one chip bounces back at the shooter.
    const entry = rank(hx, hy, hz, 1);
    for (const mesh of entry) {
      this.fracturePart(house, mesh, -nx, -nz, 2.5 + rng() * 2.5, rng);
      house.chipped += 1;
    }
    // Exit jet — the back wall (≈2.6m along the ray, a hanok wall's depth)
    // blows out along the shot, faster than it entered.
    const exit = rank(hx + nx * 2.6, hy, hz + nz * 2.6, Math.max(1, count - 1));
    for (const mesh of exit) {
      if (entry.includes(mesh)) continue;
      this.fracturePart(house, mesh, nx, nz, 8.5 + rng() * 6.5, rng);
      house.chipped += 1;
    }
    this.killGlowFor(mesh => entry.includes(mesh) || exit.includes(mesh));
    return house.chipped / house.totalParts;
  }

  /** True exactly once when the wreck has lost enough to smolder. */
  consumeIgnite(index: number): boolean {
    const house = this.houses[index];
    if (!house || house.ignited || house.collapsed) return false;
    if (house.chipped / house.totalParts < IGNITE_FRACTION) return false;
    house.ignited = true;
    return true;
  }

  /** True when the frame has lost too much to stand. */
  shouldCollapse(index: number): boolean {
    const house = this.houses[index];
    if (!house || house.collapsed) return false;
    return house.chipped / house.totalParts >= COLLAPSE_FRACTION;
  }

  /** The whole frame gives — every remaining part fractures at once with
   *  an outward, roof-first crash. */
  collapse(index: number, rng: () => number): void {
    const house = this.houses[index];
    if (!house || house.collapsed) return;
    house.collapsed = true;
    house.ignited = true;
    const stride = Math.max(1, Math.ceil(house.parts.length / COLLAPSE_PIECE_CAP));
    for (let i = 0; i < house.parts.length; i += stride) {
      const mesh = house.parts[i];
      this.tmpBox.setFromObject(mesh);
      this.tmpBox.getCenter(this.tmpV);
      this.fracturePart(house, mesh, this.tmpV.x - house.x + 0.01, this.tmpV.z - house.z + 0.01, 3.5 + rng() * 5, rng);
      house.chipped += 1;
    }
    house.parts.length = 0;
    house.root.visible = false;
    this.killGlowForHouse(house.index);
  }

  /** Detach one mesh into a scene pivot at its bbox center and hand it to
   *  box3d. The pivot's local children keep their offsets; eviction (or
   *  sleep) freezes the wreck where it settles — the pile persists. */
  private fracturePart(house: MeshHouse, mesh: THREE.Mesh, dirX: number, dirZ: number, speed: number, rng: () => number): void {
    const at = house.parts.indexOf(mesh);
    if (at >= 0) house.parts.splice(at, 1);
    mesh.updateWorldMatrix(true, false);
    this.tmpBox.setFromObject(mesh);
    const center = this.tmpBox.getCenter(new THREE.Vector3());
    const size = this.tmpBox.getSize(new THREE.Vector3());
    this.fractures.push({
      mesh,
      parent: mesh.parent ?? house.root,
      position: mesh.position.clone(),
      quaternion: mesh.quaternion.clone(),
      scale: mesh.scale.clone(),
    });
    const pivot = new THREE.Object3D();
    pivot.position.copy(center);
    pivot.rotation.y = rng() * 0.2; // break the axis-aligned read
    this.scene.add(pivot);
    pivot.updateMatrixWorld(true);
    pivot.attach(mesh);
    const len = Math.hypot(dirX, dirZ) || 1;
    this.physics?.spawnPiece(
      pivot,
      Math.min(2.8, Math.max(0.1, size.x * 0.5)),
      Math.min(2.8, Math.max(0.08, size.y * 0.5)),
      Math.min(2.8, Math.max(0.1, size.z * 0.5)),
      (dirX / len) * speed * (0.7 + rng() * 0.6) + (rng() - 0.5) * 3,
      1.5 + rng() * 4.5,
      (dirZ / len) * speed * (0.7 + rng() * 0.6) + (rng() - 0.5) * 3,
      (rng() - 0.5) * 12, (rng() - 0.5) * 9, (rng() - 0.5) * 12,
    );
    this.killGlowFor(match => match === mesh);
  }

  /** A fractured mesh takes its 창호지 panes with it (멀쩡한 창만 남지
   *  않게) — anchors ride the owning mesh or its direct panel group. */
  private killGlowFor(owns: (mesh: THREE.Mesh) => boolean): void {
    let dirty = false;
    for (let s = 0; s < this.glowTotal; s += 1) {
      const owner = this.glowOwner[s];
      if (!owner || this.glowDead[s] || !owns(owner as THREE.Mesh)) continue;
      this.hidePane(s);
      this.glowDead[s] = 1;
      dirty = true;
    }
    if (dirty) this.glowMesh.instanceMatrix.needsUpdate = true;
  }

  private killGlowForHouse(houseIndex: number): void {
    let dirty = false;
    for (let s = 0; s < this.glowTotal; s += 1) {
      if (this.glowHouse[s] !== houseIndex || !this.glowOwner[s] || this.glowDead[s]) continue;
      this.hidePane(s);
      this.glowDead[s] = 1;
      dirty = true;
    }
    if (dirty) this.glowMesh.instanceMatrix.needsUpdate = true;
  }

  private hidePane(slot: number): void {
    this.tmpM.compose(
      this.tmpV.set(0, -1000, 0),
      this.tmpQ.identity(),
      this.tmpV2.set(0, 0, 0),
    );
    this.glowMesh.setMatrixAt(slot, this.tmpM);
  }

  /** Candle flicker — slow dual-sine per pane, deterministic in game time. */
  update(delta: number): void {
    this.glowTime += delta;
    this.glowTick -= delta;
    if (this.glowTick > 0 || this.glowTotal === 0) return;
    this.glowTick = 0.12;
    const t = this.glowTime;
    for (let s = 0; s < this.glowTotal; s += 1) {
      if (!this.glowOwner[s] || this.glowDead[s]) continue;
      const flicker = 0.72
        + 0.28 * Math.sin(t * 3.1 + this.glowPhase[s]) * Math.sin(t * 1.7 + this.glowPhase[s] * 1.3);
      const warm = 0.9;
      this.glowMesh.setColorAt(s, this.tmpColor.setRGB(
        1.0 * warm * flicker,
        0.62 * warm * flicker,
        0.28 * warm * flicker,
      ));
    }
    if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
  }

  /** Run restart: every fractured mesh returns to its parent, pose restored
   *  from the fracture record — the village stands again, no rebuild. */
  reset(): void {
    for (const record of this.fractures) {
      const pivot = record.mesh.parent;
      record.parent.add(record.mesh);
      record.mesh.position.copy(record.position);
      record.mesh.quaternion.copy(record.quaternion);
      record.mesh.scale.copy(record.scale);
      if (pivot && pivot !== record.parent) pivot.removeFromParent();
    }
    this.fractures.length = 0;
    for (const house of this.houses) {
      house.chipped = 0;
      house.ignited = false;
      house.collapsed = false;
      house.root.visible = true;
      house.parts.length = 0;
      house.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.visible) house.parts.push(mesh);
      });
    }
    // Panes revive with their houses (owners kept; matrices still match —
    // every fractured mesh restored the exact transform they were stamped at).
    this.glowDead.fill(0);
    for (let s = 0; s < this.glowTotal; s += 1) {
      if (!this.glowOwner[s]) this.hidePane(s);
    }
    this.glowMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.reset();
    this.glowMesh.geometry.dispose();
    (this.glowMesh.material as THREE.Material).dispose();
    this.glowMesh.removeFromParent();
    this.houses.length = 0;
  }
}

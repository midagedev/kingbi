import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * box3d 러블 + 시체 — Erin Catto's Box3D (alpha) compiled to single-threaded
 * WASM (wasm/bridge.c): chewed house cubes, collapse debris AND fallen 원귀
 * become REAL rigid bodies that tumble, collide and PILE — corpses come to
 * rest on the rubble heaps. No fallback physics — this is the chunk sim.
 * In-app-browser rules: no SharedArrayBuffer (no threads), streaming
 * instantiate with arrayBuffer fallback.
 *
 * Slots are shared 1:1 with the C bridge. Two render layers share the one
 * physics world: 'box3d-rubble' (cube chunks, row = slot) and
 * 'box3d-corpses' (slumped-body geometry, rows repacked each frame).
 */

interface Box3dModule {
  ccall: (name: string, ret: string, argTypes: string[], args: unknown[]) => number;
  cwrap: (name: string, ret: string, argTypes: string[]) => (...args: unknown[]) => number;
  _bx_init?: (gravityY: number, groundY: number, halfExtent: number) => void;
  _bx_add_box?: (x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number,
    vx: number, vy: number, vz: number, avx: number, avy: number, avz: number) => number;
  _bx_remove?: (slot: number) => void;
  _bx_step?: (dt: number, subSteps: number) => void;
  _bx_get_states?: () => number;
  _bx_clear?: () => void;
  _bx_alive_count?: () => number;
  _bx_awake_count?: () => number;
  _bx_add_static?: (x: number, y: number, z: number, hx: number, hy: number, hz: number) => void;
  HEAPF32: Float32Array;
}

interface BodySlot {
  active: boolean;
  /** 0 = rubble chunk, 1 = corpse. */
  layer: 0 | 1;
  sx: number;
  sy: number;
  sz: number;
  r: number;
  g: number;
  b: number;
  /** True until the first post-spawn transform write. */
  needsWrite: boolean;
  /** Corpse instance row last colored (row shifts after recycling). */
  colorRow: number;
}

/** Corpse hull half-extents, measured against the live 원귀 (Horde render
 *  scale): normals stand ~1.4m tall with a 0.64m hem — a slumped body
 *  occupies ~78% of standing height. Body lies along +X, 1.11m long. */
const CORPSE_HX = 0.56;
const CORPSE_HY = 0.17;
const CORPSE_HZ = 0.3;
const CORPSE_MAX = 768;
/** Rubble renders inset from its physics hull: resting cubes touch with
 *  EXACTLY coplanar faces and z-fight into one flickering blob — a 14%
 *  visual gap keeps every chunk individually readable (and reads ≤ the
 *  wall cell it came from). Physics stays full-size for stable piles. */
const RUBBLE_VISUAL = 0.86;

/** Lying 원귀 measured to match the standing one: thin legs, coat-spread
 *  torso, horned head, arms slack at the sides — merged non-indexed (the
 *  mergeGeometries constraint) into one draw per corpse instance. */
function buildCorpseGeometry(): THREE.BufferGeometry {
  const parts = [
    [0.5, 0.17, 0.24, -0.32, -0.02, 0], // legs (folded shins)
    [0.42, 0.34, 0.5, 0.13, 0, 0], // torso + coat
    [0.3, 0.12, 0.58, 0.02, -0.1, 0], // coat hem flare
    [0.2, 0.2, 0.2, 0.44, 0.04, 0.05], // horned head
    [0.36, 0.11, 0.12, 0.18, 0.08, 0.3], // arm
    [0.36, 0.11, 0.12, 0.18, 0.08, -0.3], // arm
  ].map(([w, h, d, x, y, z]) => {
    const box = new THREE.BoxGeometry(w, h, d);
    box.translate(x, y, z);
    return box.toNonIndexed();
  });
  const merged = mergeGeometries(parts, false) ?? parts[0];
  for (const part of parts) part.dispose();
  return merged;
}

export class Box3dWorld {
  readonly mesh: THREE.InstancedMesh;
  readonly corpseMesh: THREE.InstancedMesh;
  private module: Box3dModule | null = null;
  private readonly slots: BodySlot[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly capColor = new THREE.Color();
  private readonly rubbleOrder: number[] = [];
  private readonly corpseOrder: number[] = [];
  /** slot → corpse instance row (rebuilt when recycling shifts the order). */
  private corpseRowOf: Int16Array = new Int16Array(0);
  private corpseDirty = true;

  constructor(scene: THREE.Scene, capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.name = 'box3d-rubble';
    for (let i = 0; i < capacity; i += 1) {
      this.slots.push({ active: false, layer: 0, sx: 0.2, sy: 0.2, sz: 0.2, r: 1, g: 1, b: 1, needsWrite: true, colorRow: -1 });
      this.hide(this.mesh, i);
    }
    this.corpseRowOf = new Int16Array(capacity).fill(-1);

    const corpseGeometry = buildCorpseGeometry();
    const corpseMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.18 });
    this.corpseMesh = new THREE.InstancedMesh(corpseGeometry, corpseMaterial, CORPSE_MAX);
    this.corpseMesh.frustumCulled = false;
    this.corpseMesh.receiveShadow = true;
    this.corpseMesh.count = 0;
    this.corpseMesh.name = 'box3d-corpses';

    scene.add(this.mesh, this.corpseMesh);
  }

  /** Load + instantiate the wasm bridge. Resolves false only if the
   *  artifact is missing (dev without build) — never throws. */
  async init(gravityY: number, groundY: number, halfExtent: number): Promise<boolean> {
    const base = import.meta.env.BASE_URL ?? '/';
    try {
      await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector('script[data-box3d]');
        if (existing) {
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('box3d script error')));
          if ((window as unknown as { Box3DModule?: unknown }).Box3DModule) resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = `${base}wasm/box3d_bridge.js`;
        script.dataset.box3d = '1';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('box3d script failed to load'));
        document.head.appendChild(script);
      });
      const factory = (window as unknown as { Box3DModule?: (opts: unknown) => Promise<Box3dModule> }).Box3DModule;
      if (!factory) return false;
      this.module = await factory({});
      this.module._bx_init?.(gravityY, groundY, halfExtent);
      return this.module._bx_add_box !== undefined;
    } catch {
      return false;
    }
  }

  get ready(): boolean {
    return this.module !== null;
  }

  /** Live rigid-body count from the bridge (QA + the silent-fail probe). */
  get bodyCount(): number {
    return this.module?._bx_alive_count?.() ?? -1;
  }

  /** Terrain-following physics floor: the yard slopes 0.4→4.1m north of
   *  the gun, so a single flat slab buries every corpse and rubble chunk
   *  in the kill field (the "시체가 안 쌓인다" bug). 12m tiles sampled from
   *  heightAt; the old flat slab stays deep below as the outer fallback. */
  addTerrainTiles(
    heightAt: (x: number, z: number) => number,
    minX: number, maxX: number, minZ: number, maxZ: number,
    tile = 12,
  ): number {
    const module = this.module;
    if (!module?._bx_add_static) return 0;
    let placed = 0;
    for (let z = minZ; z < maxZ; z += tile) {
      for (let x = minX; x < maxX; x += tile) {
        const cx = x + tile / 2;
        const cz = z + tile / 2;
        const corners = [
          heightAt(x, z), heightAt(x + tile, z),
          heightAt(x, z + tile), heightAt(x + tile, z + tile),
        ];
        if (!corners.every((h) => Number.isFinite(h))) continue;
        const h = (corners[0] + corners[1] + corners[2] + corners[3]) / 4;
        module._bx_add_static(cx, h - 1, cz, tile / 2 + 0.15, 1, tile / 2 + 0.15);
        placed += 1;
      }
    }
    return placed;
  }

  get capacity(): number {
    return this.slots.length;
  }

  get corpseCount(): number {
    let count = 0;
    for (const slot of this.corpseOrder) if (this.slots[slot]?.active) count += 1;
    return count;
  }

  /** Bodies currently simulating (QA/perf probe). */
  get awakeCount(): number {
    return this.module?._bx_awake_count?.() ?? -1;
  }

  /** Spawn a rubble cube; recycles the oldest chunk when the pool is full. */
  spawnRubble(
    x: number, y: number, z: number, half: number,
    r: number, g: number, b: number,
    vx: number, vy: number, vz: number,
    avx = 0, avy = 0, avz = 0,
  ): void {
    const slot = this.addBody(x, y, z, half, half, half, 0, vx, vy, vz, avx, avy, avz, this.rubbleOrder);
    if (slot < 0) return;
    const edge = half * 2;
    this.register(slot, 0, edge * RUBBLE_VISUAL, edge * RUBBLE_VISUAL, edge * RUBBLE_VISUAL, r, g, b, this.mesh, slot);
    if (this.rubbleOrder.length < this.slots.length) this.rubbleOrder.push(slot);
  }

  /** Spawn a fallen 원귀 — elongated hull, yaw spread, own recycle pool so
   *  a corpse never evicts rubble mid-pile. `scale` widens brutes (1.5). */
  spawnCorpse(
    x: number, y: number, z: number, yaw: number, scale: number,
    r: number, g: number, b: number,
    vx: number, vy: number, vz: number,
    avx: number, avy: number, avz: number,
  ): void {
    while (this.corpseCount >= CORPSE_MAX) this.evictOldest(this.corpseOrder);
    const slot = this.addBody(
      x, y, z, CORPSE_HX * scale, CORPSE_HY * scale, CORPSE_HZ * scale, yaw,
      vx, vy, vz, avx, avy, avz, this.corpseOrder,
    );
    if (slot < 0) return;
    this.register(slot, 1, scale, scale, scale, r, g, b, this.corpseMesh, this.corpseOrder.length);
    this.corpseRowOf[slot] = this.corpseOrder.length;
    this.corpseOrder.push(slot);
    this.corpseMesh.count = this.corpseOrder.length;
  }

  private addBody(
    x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number,
    vx: number, vy: number, vz: number,
    avx: number, avy: number, avz: number,
    order: number[],
  ): number {
    const module = this.module;
    if (!module?._bx_add_box) return -1;
    let slot = module._bx_add_box(x, y, z, hx, hy, hz, yaw, vx, vy, vz, avx, avy, avz);
    if (slot < 0) {
      this.evictOldest(order);
      slot = module._bx_add_box(x, y, z, hx, hy, hz, yaw, vx, vy, vz, avx, avy, avz);
    }
    return slot;
  }

  private evictOldest(order: number[]): void {
    const module = this.module;
    while (order.length > 0) {
      const oldest = order.shift()!;
      if (!this.slots[oldest]?.active) continue;
      module?._bx_remove?.(oldest);
      this.slots[oldest].active = false;
      if (this.slots[oldest].layer === 0) {
        this.hide(this.mesh, oldest);
      } else {
        // Rows shift down from the head — rebuild the map next update.
        this.corpseDirty = true;
      }
      return;
    }
  }

  private register(
    slot: number, layer: 0 | 1,
    sx: number, sy: number, sz: number,
    r: number, g: number, b: number,
    mesh: THREE.InstancedMesh, row: number,
  ): void {
    const record = this.slots[slot];
    record.active = true;
    record.layer = layer;
    record.sx = sx;
    record.sy = sy;
    record.sz = sz;
    record.r = r;
    record.g = g;
    record.b = b;
    record.needsWrite = true;
    record.colorRow = row;
    this.pos.set(0, -1000, 0);
    this.quat.identity();
    this.matrix.compose(this.pos, this.quat, this.scale.set(0.001, 0.001, 0.001));
    mesh.setMatrixAt(row, this.matrix);
    mesh.setColorAt(row, this.capColor.setRGB(r, g, b));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private hide(mesh: THREE.InstancedMesh, slot: number): void {
    this.pos.set(0, -1000, 0);
    this.scale.setScalar(0.001);
    this.matrix.compose(this.pos, this.quat, this.scale);
    mesh.setMatrixAt(slot, this.matrix);
  }

  /** Step the world and sync active bodies into their layer's mesh.
   *  Sleeping bodies keep their last matrix — piles cost nothing once they
   *  settle. The slot float in the state row carries the awake flag. */
  update(delta: number): void {
    const module = this.module;
    if (!module?._bx_get_states) return;
    // Adaptive budget: a full-blown demolition (hundreds of awake chunks)
    // steps once with a tighter dt cap — per-substep travel stays under the
    // 2m ground slab so nothing tunnels while the rain settles. Light load
    // keeps the crisp 2-substep tumble.
    const awake = module._bx_awake_count?.() ?? 0;
    const heavy = awake > 350;
    module._bx_step?.(Math.min(delta, heavy ? 1 / 30 : 1 / 20), heavy ? 1 : 2);
    const pointer = module._bx_get_states();
    if (!pointer) return;
    // Recycling shifts corpse rows: rebuild the slot→row map and force a
    // full rewrite once; afterwards only awake (or fresh) bodies write.
    if (this.corpseDirty) {
      this.corpseRowOf.fill(-1);
      for (let i = 0; i < this.corpseOrder.length; i += 1) this.corpseRowOf[this.corpseOrder[i]] = i;
      this.corpseDirty = false;
      for (const slot of this.corpseOrder) this.slots[slot].needsWrite = true;
      this.corpseMesh.count = this.corpseOrder.length;
    }
    const states = module.HEAPF32;
    const base = pointer >> 2;
    const count = states[base] | 0;
    let highestRubble = 0;
    let highestCorpse = 0;
    for (let i = 0; i < count; i += 1) {
      const o = base + 1 + i * 8;
      const tagged = states[o + 7];
      const slot = tagged | 0;
      const record = this.slots[slot];
      if (!record?.active) continue;
      const awake = tagged - slot > 0.25 || record.needsWrite;
      if (!awake) continue;
      this.pos.set(states[o], states[o + 1], states[o + 2]);
      this.quat.set(states[o + 3], states[o + 4], states[o + 5], states[o + 6]);
      this.scale.set(record.sx, record.sy, record.sz);
      this.matrix.compose(this.pos, this.quat, this.scale);
      if (record.layer === 0) {
        this.mesh.setMatrixAt(slot, this.matrix);
        highestRubble = Math.max(highestRubble, slot + 1);
      } else {
        const row = this.corpseRowOf[slot];
        if (row < 0) continue;
        this.corpseMesh.setMatrixAt(row, this.matrix);
        if (record.colorRow !== row) {
          this.corpseMesh.setColorAt(row, this.capColor.setRGB(record.r, record.g, record.b));
          record.colorRow = row;
          if (this.corpseMesh.instanceColor) this.corpseMesh.instanceColor.needsUpdate = true;
        }
        highestCorpse = Math.max(highestCorpse, row + 1);
      }
      record.needsWrite = false;
    }
    if (highestRubble > 0) this.mesh.count = highestRubble;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (highestCorpse > 0) this.corpseMesh.count = Math.max(this.corpseMesh.count, highestCorpse);
    this.corpseMesh.instanceMatrix.needsUpdate = true;
  }

  /** Run restart: bodies gone, instances hidden. */
  reset(): void {
    this.module?._bx_clear?.();
    for (let i = 0; i < this.slots.length; i += 1) {
      this.slots[i].active = false;
      this.slots[i].needsWrite = true;
      this.slots[i].colorRow = -1;
      this.hide(this.mesh, i);
    }
    this.rubbleOrder.length = 0;
    this.corpseOrder.length = 0;
    this.corpseRowOf.fill(-1);
    this.corpseDirty = false;
    this.mesh.count = 0;
    this.corpseMesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.corpseMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.corpseMesh.geometry.dispose();
    (this.corpseMesh.material as THREE.Material).dispose();
    this.corpseMesh.removeFromParent();
  }
}

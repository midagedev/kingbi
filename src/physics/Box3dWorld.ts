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
 * PHYSICS is a bounded pool (perf stays flat); VISUALS accumulate: when a
 * body is evicted from physics its rendered row FREEZES in place — the
 * pile keeps growing all night (the "잔해가 사라진다" fix). Rows recycle
 * only when the visual budget itself fills.
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
}

/** slot↔row bookkeeping with FROZEN persistence: a row owns its slot while
 *  the body lives; when the body leaves physics the row keeps its last
 *  matrix forever (visual accumulation) until the visual budget forces a
 *  recycle of the oldest frozen row. */
class RowLedger {
  private readonly slotRow: Int32Array;
  private readonly rowSlot: Int32Array;
  private cursor = 0;
  rowCount = 0;

  constructor(physicsCapacity: number, readonly rows: number) {
    this.slotRow = new Int32Array(physicsCapacity).fill(-1);
    this.rowSlot = new Int32Array(rows).fill(-1);
  }

  /** Row for a newly spawned slot; recycles the oldest frozen row when
   *  the budget is full (live rows are never stolen). */
  claim(slot: number): number {
    let row = this.rowCount < this.rows ? this.rowCount++ : -1;
    if (row < 0) {
      for (let guard = 0; guard < this.rows; guard += 1) {
        const candidate = this.cursor;
        this.cursor = (this.cursor + 1) % this.rows;
        const owner = this.rowSlot[candidate];
        if (owner >= 0 && this.slotRow[owner] !== candidate) {
          row = candidate;
          break;
        }
      }
      if (row < 0) row = this.cursor;
    }
    this.slotRow[slot] = row;
    this.rowSlot[row] = slot;
    return row;
  }

  /** The body left the physics world — its row freezes in place. */
  freeze(slot: number): void {
    this.slotRow[slot] = -1;
  }

  rowOf(slot: number): number {
    return this.slotRow[slot];
  }

  reset(): void {
    this.slotRow.fill(-1);
    this.rowSlot.fill(-1);
    this.rowCount = 0;
    this.cursor = 0;
  }
}

/** Corpse hull half-extents, measured against the live 원귀 (Horde render
 *  scale): normals stand ~1.4m tall with a 0.64m hem — a slumped body
 *  occupies ~78% of standing height. Body lies along +X, 1.11m long. */
const CORPSE_HX = 0.56;
const CORPSE_HY = 0.17;
const CORPSE_HZ = 0.3;
/** Physics cap for corpses (rubble shares the rest of the C pool); the
 *  visual ledger lets frozen bodies exceed it. */
const CORPSE_PHYSICS_MAX = 900;
/** Visual budgets — the night's whole massacre and demolition stays on
 *  screen; beyond this the OLDEST frozen visuals recycle. */
const RUBBLE_ROWS = 8192;
const CORPSE_ROWS = 2048;
/** Rubble renders inset from its physics hull: resting cubes touch with
 *  EXACTLY coplanar faces and z-fight into one flickering blob — a 14%
 *  visual gap keeps every chunk individually readable (and reads ≤ the
 *  wall cell it came from). Physics stays full-size for stable piles. */
const RUBBLE_VISUAL = 0.86;

/** Lying 원귀 measured to match the standing one: thin legs, coat-spread
 *  torso, horned head, arms slack at the sides — merged non-indexed (the
 *  mergeGeometries constraint) into one draw per corpse instance. Each
 *  part carries a vertex-color tint (head pale, hem dark) so the single
 *  instanceColor per body still reads as a dressed figure, not a gray
 *  box. */
function buildCorpseGeometry(): THREE.BufferGeometry {
  const parts = [
    [0.5, 0.17, 0.24, -0.32, -0.02, 0, 0.88], // legs (folded shins)
    [0.42, 0.34, 0.5, 0.13, 0, 0, 1.0], // torso + coat
    [0.3, 0.12, 0.58, 0.02, -0.1, 0, 0.82], // coat hem flare
    [0.2, 0.2, 0.2, 0.44, 0.04, 0.05, 1.14], // horned head
    [0.36, 0.11, 0.12, 0.18, 0.08, 0.3, 0.95], // arm
    [0.36, 0.11, 0.12, 0.18, 0.08, -0.3, 0.95], // arm
  ].map(([w, h, d, x, y, z, tint]) => {
    const box = new THREE.BoxGeometry(w, h, d);
    box.translate(x, y, z);
    const nonIndexed = box.toNonIndexed();
    box.dispose();
    const vertexCount = nonIndexed.attributes.position.count;
    const tints = new Float32Array(vertexCount * 3);
    for (let i = 0; i < tints.length; i += 3) {
      tints[i] = tint;
      tints[i + 1] = tint;
      tints[i + 2] = tint;
    }
    nonIndexed.setAttribute('color', new THREE.BufferAttribute(tints, 3));
    return nonIndexed;
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
  /** Physics FIFO per layer — drives eviction order (oldest body leaves
   *  physics first, its visual freezing in place). */
  private readonly rubbleOrder: number[] = [];
  private readonly corpseOrder: number[] = [];
  private readonly rubbleRows: RowLedger;
  private readonly corpseRows: RowLedger;

  constructor(scene: THREE.Scene, capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });
    this.mesh = new THREE.InstancedMesh(geometry, material, RUBBLE_ROWS);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.name = 'box3d-rubble';
    for (let i = 0; i < capacity; i += 1) {
      this.slots.push({ active: false, layer: 0, sx: 0.2, sy: 0.2, sz: 0.2, r: 1, g: 1, b: 1, needsWrite: true });
      this.hide(this.mesh, i);
    }

    const corpseGeometry = buildCorpseGeometry();
    const corpseMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.18, vertexColors: true });
    this.corpseMesh = new THREE.InstancedMesh(corpseGeometry, corpseMaterial, CORPSE_ROWS);
    this.corpseMesh.frustumCulled = false;
    this.corpseMesh.receiveShadow = true;
    this.corpseMesh.count = 0;
    this.corpseMesh.name = 'box3d-corpses';

    this.rubbleRows = new RowLedger(capacity, RUBBLE_ROWS);
    this.corpseRows = new RowLedger(capacity, CORPSE_ROWS);

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

  get capacity(): number {
    return this.slots.length;
  }

  get corpseCount(): number {
    let count = 0;
    for (const slot of this.corpseOrder) if (this.slots[slot]?.active) count += 1;
    return count;
  }

  /** Visual rows ever claimed (live + frozen) — the pile-growth probe. */
  get rubbleVisual(): number {
    return this.rubbleRows.rowCount;
  }

  get corpseVisual(): number {
    return this.corpseRows.rowCount;
  }

  /** Bodies currently simulating (QA/perf probe). */
  get awakeCount(): number {
    return this.module?._bx_awake_count?.() ?? -1;
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

  /** Spawn a rubble cube; when the physics pool is full the OLDEST chunk
   *  leaves physics and freezes into the pile (its visual never vanishes). */
  spawnRubble(
    x: number, y: number, z: number, half: number,
    r: number, g: number, b: number,
    vx: number, vy: number, vz: number,
    avx = 0, avy = 0, avz = 0,
  ): void {
    const slot = this.addBody(x, y, z, half, half, half, 0, vx, vy, vz, avx, avy, avz, this.rubbleOrder);
    if (slot < 0) return;
    const edge = half * 2;
    const row = this.rubbleRows.claim(slot);
    this.register(slot, 0, edge * RUBBLE_VISUAL, edge * RUBBLE_VISUAL, edge * RUBBLE_VISUAL, r, g, b, this.mesh, row);
    this.mesh.count = Math.max(this.mesh.count, this.rubbleRows.rowCount);
  }

  /** Spawn a fallen 원귀 — elongated hull, yaw spread; evicted bodies
   *  freeze into the corpse field instead of blinking away. */
  spawnCorpse(
    x: number, y: number, z: number, yaw: number, scale: number,
    r: number, g: number, b: number,
    vx: number, vy: number, vz: number,
    avx: number, avy: number, avz: number,
  ): void {
    while (this.corpseCount >= CORPSE_PHYSICS_MAX) this.evictOldest(this.corpseOrder);
    const slot = this.addBody(
      x, y, z, CORPSE_HX * scale, CORPSE_HY * scale, CORPSE_HZ * scale, yaw,
      vx, vy, vz, avx, avy, avz, this.corpseOrder,
    );
    if (slot < 0) return;
    const row = this.corpseRows.claim(slot);
    this.register(slot, 1, scale, scale, scale, r, g, b, this.corpseMesh, row);
    this.corpseMesh.count = Math.max(this.corpseMesh.count, this.corpseRows.rowCount);
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
    if (slot >= 0) order.push(slot);
    return slot;
  }

  private evictOldest(order: number[]): void {
    const module = this.module;
    while (order.length > 0) {
      const oldest = order.shift()!;
      if (!this.slots[oldest]?.active) continue;
      module?._bx_remove?.(oldest);
      this.slots[oldest].active = false;
      // The visual FREEZES in place — piles accumulate all night.
      if (this.slots[oldest].layer === 0) {
        this.rubbleRows.freeze(oldest);
      } else {
        this.corpseRows.freeze(oldest);
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
    this.pos.set(0, -1000, 0);
    this.quat.identity();
    this.matrix.compose(this.pos, this.quat, this.scale.set(0.001, 0.001, 0.001));
    mesh.setMatrixAt(row, this.matrix);
    mesh.setColorAt(row, this.capColor.setRGB(r, g, b));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private hide(mesh: THREE.InstancedMesh, row: number): void {
    this.pos.set(0, -1000, 0);
    this.scale.setScalar(0.001);
    this.matrix.compose(this.pos, this.quat, this.scale);
    mesh.setMatrixAt(row, this.matrix);
  }

  /** Step the world and sync live bodies into their rows. Sleeping bodies
   *  keep their last matrix; frozen rows (evicted from physics) keep
   *  theirs forever — neither costs a write. */
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
    const states = module.HEAPF32;
    const base = pointer >> 2;
    const count = states[base] | 0;
    for (let i = 0; i < count; i += 1) {
      const o = base + 1 + i * 8;
      const tagged = states[o + 7];
      const slot = tagged | 0;
      const record = this.slots[slot];
      if (!record?.active) continue;
      const awakeBody = tagged - slot > 0.25 || record.needsWrite;
      if (!awakeBody) continue;
      const row = record.layer === 0 ? this.rubbleRows.rowOf(slot) : this.corpseRows.rowOf(slot);
      if (row < 0) continue;
      this.pos.set(states[o], states[o + 1], states[o + 2]);
      this.quat.set(states[o + 3], states[o + 4], states[o + 5], states[o + 6]);
      this.scale.set(record.sx, record.sy, record.sz);
      this.matrix.compose(this.pos, this.quat, this.scale);
      if (record.layer === 0) {
        this.mesh.setMatrixAt(row, this.matrix);
        this.mesh.instanceMatrix.needsUpdate = true;
      } else {
        this.corpseMesh.setMatrixAt(row, this.matrix);
        this.corpseMesh.instanceMatrix.needsUpdate = true;
      }
      record.needsWrite = false;
    }
  }

  /** Wave sweep: corpses clear between waves (they'd bury the yard by
   *  dawn), rubble STAYS — the demolition record persists all night. */
  clearCorpses(): void {
    const module = this.module;
    for (const slot of this.corpseOrder) {
      if (!this.slots[slot]?.active) continue;
      module?._bx_remove?.(slot);
      this.slots[slot].active = false;
    }
    this.corpseOrder.length = 0;
    this.corpseRows.reset();
    this.corpseMesh.count = 0;
    for (let row = 0; row < CORPSE_ROWS; row += 1) this.hide(this.corpseMesh, row);
    this.corpseMesh.instanceMatrix.needsUpdate = true;
  }

  /** Run restart: bodies gone, instances hidden — the yard is swept. */
  reset(): void {
    this.module?._bx_clear?.();
    for (let i = 0; i < this.slots.length; i += 1) {
      this.slots[i].active = false;
      this.slots[i].needsWrite = true;
      this.hide(this.mesh, i);
    }
    this.rubbleOrder.length = 0;
    this.corpseOrder.length = 0;
    this.rubbleRows.reset();
    this.corpseRows.reset();
    this.mesh.count = 0;
    this.corpseMesh.count = 0;
    for (let row = 0; row < RUBBLE_ROWS; row += 1) this.hide(this.mesh, row);
    for (let row = 0; row < CORPSE_ROWS; row += 1) this.hide(this.corpseMesh, row);
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

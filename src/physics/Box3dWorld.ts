import * as THREE from 'three';

/**
 * box3d 러블 — Erin Catto's Box3D (alpha) compiled to single-threaded
 * WASM (wasm/bridge.c): chewed house cubes and collapse debris become
 * REAL rigid bodies that tumble, collide and PILE. Fallen 원귀 ride the
 * horde's own dying animation instead (the corpse voxelization was
 * retired — 더 많은 좀비와 물리효과로 예산 이동). No fallback physics.
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
  _bx_kick?: (slot: number, jx: number, jy: number, jz: number, wax: number, way: number, waz: number) => void;
  HEAPF32: Float32Array;
}

interface BodySlot {
  active: boolean;
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

/** Visual budget — the night's whole demolition stays on screen; beyond
 *  this the OLDEST frozen visuals recycle. */
const RUBBLE_ROWS = 12288;
/** Rubble renders inset from its physics hull: resting cubes touch with
 *  EXACTLY coplanar faces and z-fight into one flickering blob — a 14%
 *  visual gap keeps every chunk individually readable (and reads ≤ the
 *  wall cell it came from). Physics stays full-size for stable piles. */
const RUBBLE_VISUAL = 0.86;

export class Box3dWorld {
  readonly mesh: THREE.InstancedMesh;
  private module: Box3dModule | null = null;
  private readonly slots: BodySlot[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly capColor = new THREE.Color();
  /** Physics FIFO — drives eviction order (oldest body leaves physics
   *  first, its visual freezing in place). */
  private readonly rubbleOrder: number[] = [];
  private readonly rubbleRows: RowLedger;
  /** Last frame's states run (base index + count in HEAPF32) — the kick
   *  ray-test reads body positions straight from it, no extra wasm call. */
  private statesBase = -1;
  private statesCount = 0;

  constructor(scene: THREE.Scene, capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });
    this.mesh = new THREE.InstancedMesh(geometry, material, RUBBLE_ROWS);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.name = 'box3d-rubble';
    for (let i = 0; i < capacity; i += 1) {
      this.slots.push({ active: false, sx: 0.2, sy: 0.2, sz: 0.2, r: 1, g: 1, b: 1, needsWrite: true });
      this.hide(this.mesh, i);
    }

    this.rubbleRows = new RowLedger(capacity, RUBBLE_ROWS);

    scene.add(this.mesh);
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

  /** Visual rows ever claimed (live + frozen) — the pile-growth probe. */
  get rubbleVisual(): number {
    return this.rubbleRows.rowCount;
  }

  /** Bodies currently simulating (QA/perf probe). */
  get awakeCount(): number {
    return this.module?._bx_awake_count?.() ?? -1;
  }

  /** Terrain-following physics floor: the yard slopes 0.4→4.1m north of
   *  the gun, so a single flat slab buries every rubble chunk in the
   *  kill field. 12m tiles sampled from
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
    const slot = this.addBody(x, y, z, half, half, half, 0, vx, vy, vz, avx, avy, avz);
    if (slot < 0) return;
    const edge = half * 2;
    const row = this.rubbleRows.claim(slot);
    this.register(slot, edge * RUBBLE_VISUAL, edge * RUBBLE_VISUAL, edge * RUBBLE_VISUAL, r, g, b, this.mesh, row);
    this.mesh.count = Math.max(this.mesh.count, this.rubbleRows.rowCount);
  }

  private addBody(
    x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number,
    vx: number, vy: number, vz: number,
    avx: number, avy: number, avz: number,
  ): number {
    const module = this.module;
    if (!module?._bx_add_box) return -1;
    let slot = module._bx_add_box(x, y, z, hx, hy, hz, yaw, vx, vy, vz, avx, avy, avz);
    if (slot < 0) {
      this.evictOldest();
      slot = module._bx_add_box(x, y, z, hx, hy, hz, yaw, vx, vy, vz, avx, avy, avz);
    }
    if (slot >= 0) this.rubbleOrder.push(slot);
    return slot;
  }

  private evictOldest(): void {
    const module = this.module;
    while (this.rubbleOrder.length > 0) {
      const oldest = this.rubbleOrder.shift()!;
      if (!this.slots[oldest]?.active) continue;
      module?._bx_remove?.(oldest);
      this.slots[oldest].active = false;
      // The visual FREEZES in place — piles accumulate all night.
      this.rubbleRows.freeze(oldest);
      return;
    }
  }

  private register(
    slot: number,
    sx: number, sy: number, sz: number,
    r: number, g: number, b: number,
    mesh: THREE.InstancedMesh, row: number,
  ): void {
    const record = this.slots[slot];
    record.active = true;
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
    this.statesBase = base;
    this.statesCount = count;
    for (let i = 0; i < count; i += 1) {
      const o = base + 1 + i * 8;
      const tagged = states[o + 7];
      const slot = tagged | 0;
      const record = this.slots[slot];
      if (!record?.active) continue;
      const awakeBody = tagged - slot > 0.25 || record.needsWrite;
      if (!awakeBody) continue;
      const row = this.rubbleRows.rowOf(slot);
      if (row < 0) continue;
      this.pos.set(states[o], states[o + 1], states[o + 2]);
      this.quat.set(states[o + 3], states[o + 4], states[o + 5], states[o + 6]);
      this.scale.set(record.sx, record.sy, record.sz);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(row, this.matrix);
      this.mesh.instanceMatrix.needsUpdate = true;
      record.needsWrite = false;
    }
  }

  /** 관통 탄도 — the gatling shreds THROUGH the piles: every rubble chunk
   *  rubble chunk the line crosses gets kicked back along the shot (and wakes
   *  up). Gameplay never blocks on debris — the bullet keeps its zombie /
   *  house target; the piles just react. Reads positions from the cached
   *  states run; jolt variance is a slot-hash (deterministic, no rng). */
  kickAlongRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
    const module = this.module;
    if (!module?._bx_kick || this.statesBase < 0 || this.statesCount === 0) return 0;
    // Churn guard: when the field is already boiling (stress purges,
    // demolition rains) more wakes only feed the physics bill.
    if ((module._bx_awake_count?.() ?? 0) > 120) return 0;
    const states = module.HEAPF32;
    const hits: Array<{ slot: number; t: number }> = [];
    for (let i = 0; i < this.statesCount; i += 1) {
      const o = this.statesBase + 1 + i * 8;
      const slot = states[o + 7] | 0;
      const record = this.slots[slot];
      if (!record?.active) continue;
      const px = states[o] - ox;
      const py = states[o + 1] - oy;
      const pz = states[o + 2] - oz;
      const t = px * dx + py * dy + pz * dz;
      if (t < 0.5 || t > maxDist) continue;
      const rx = px - dx * t;
      const ry = py - dy * t;
      const rz = pz - dz * t;
      const radius = record.sx * 0.62;
      if (rx * rx + ry * ry + rz * rz > radius * radius) continue;
      hits.push({ slot, t });
    }
    if (hits.length === 0) return 0;
    hits.sort((a, b) => a.t - b.t);
    const kicked = Math.min(hits.length, 2);
    for (let i = 0; i < kicked; i += 1) {
      const { slot } = hits[i];
      const record = this.slots[slot];
      const variance = 0.72 + 0.56 * ((slot * 0.618) % 1);
      const power = 8.5 * variance;
      module._bx_kick?.(
        slot,
        dx * power, 1.6 + power * 0.22, dz * power,
        (variance - 1) * 9, variance * 5, (1 - variance) * 9,
      );
      // Woke by the kick — the next state run must rewrite its matrix.
      record.needsWrite = true;
    }
    return kicked;
  }

  /** Radial pop for burning rubble: kick up to `count` bodies within
   *  `radius` of a point (fire bites keep the heap sparking and settling). */
  kickNear(x: number, y: number, z: number, radius: number, count: number): number {
    const module = this.module;
    if (!module?._bx_kick || this.statesBase < 0 || this.statesCount === 0) return 0;
    if ((module._bx_awake_count?.() ?? 0) > 120) return 0;
    const states = module.HEAPF32;
    const hits: Array<{ slot: number; d: number }> = [];
    const rSq = radius * radius;
    for (let i = 0; i < this.statesCount; i += 1) {
      const o = this.statesBase + 1 + i * 8;
      const slot = states[o + 7] | 0;
      const record = this.slots[slot];
      if (!record?.active) continue;
      const dx = states[o] - x;
      const dy = states[o + 1] - y;
      const dz = states[o + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > rSq) continue;
      hits.push({ slot, d });
    }
    if (hits.length === 0) return 0;
    hits.sort((a, b) => a.d - b.d);
    const kicked = Math.min(hits.length, count);
    for (let i = 0; i < kicked; i += 1) {
      const { slot } = hits[i];
      const variance = 0.7 + 0.6 * ((slot * 0.618) % 1);
      module._bx_kick?.(
        slot,
        (variance - 1) * 2, 2.2 * variance, (1 - variance) * 2,
        (variance - 1) * 7, variance * 4, (1 - variance) * 7,
      );
      this.slots[slot].needsWrite = true;
    }
    return kicked;
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
    this.rubbleRows.reset();
    this.mesh.count = 0;
    for (let row = 0; row < RUBBLE_ROWS; row += 1) this.hide(this.mesh, row);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

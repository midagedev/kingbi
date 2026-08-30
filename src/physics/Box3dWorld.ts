import * as THREE from 'three';

/**
 * box3d 러블 — Erin Catto's Box3D (alpha) compiled to single-threaded WASM
 * (wasm/bridge.c): chewed house cubes and collapse debris become REAL
 * rigid bodies that tumble, collide and PILE. No fallback physics — this
 * is the chunk sim. In-app-browser rules: no SharedArrayBuffer (no
 * threads), streaming instantiate with arrayBuffer fallback.
 *
 * Slots are shared 1:1 with the C bridge; rendering is one InstancedMesh.
 */

interface Box3dModule {
  ccall: (name: string, ret: string, argTypes: string[], args: unknown[]) => number;
  cwrap: (name: string, ret: string, argTypes: string[]) => (...args: unknown[]) => number;
  _bx_init?: (gravityY: number, groundY: number, halfExtent: number) => void;
  _bx_add_cube?: (x: number, y: number, z: number, hx: number,
    vx: number, vy: number, vz: number, avx: number, avy: number, avz: number) => number;
  _bx_remove?: (slot: number) => void;
  _bx_step?: (dt: number, subSteps: number) => void;
  _bx_get_states?: () => number;
  _bx_clear?: () => void;
  _bx_alive_count?: () => number;
  HEAPF32: Float32Array;
}

interface RubbleSlot {
  active: boolean;
  half: number;
  r: number;
  g: number;
  b: number;
}

export class Box3dWorld {
  readonly mesh: THREE.InstancedMesh;
  private module: Box3dModule | null = null;
  private readonly slots: RubbleSlot[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly capColor = new THREE.Color();
  private readonly order: number[] = [];
  private orderHead = 0;

  constructor(scene: THREE.Scene, capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.name = 'box3d-rubble';
    for (let i = 0; i < capacity; i += 1) {
      this.slots.push({ active: false, half: 0.2, r: 1, g: 1, b: 1 });
      this.hide(i);
    }
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
      return this.module._bx_add_cube !== undefined;
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

  /** Spawn a rubble cube; recycles the oldest body when the pool is full. */
  spawn(
    x: number, y: number, z: number, half: number,
    r: number, g: number, b: number,
    vx: number, vy: number, vz: number,
  ): void {
    const module = this.module;
    if (!module?._bx_add_cube) return;
    let slot = module._bx_add_cube(
      x, y, z, half,
      vx, vy, vz,
      (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14,
    );
    if (slot < 0) {
      const oldest = this.order[this.orderHead % this.order.length];
      this.orderHead += 1;
      if (oldest === undefined) return;
      module._bx_remove?.(oldest);
      this.hide(oldest);
      slot = module._bx_add_cube(
        x, y, z, half,
        vx, vy, vz,
        (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14,
      );
      if (slot < 0) return;
    }
    const record = this.slots[slot];
    record.active = true;
    record.half = half;
    record.r = r;
    record.g = g;
    record.b = b;
    this.pos.set(x, y, z);
    this.quat.identity();
    this.scale.setScalar(half * 2);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(slot, this.matrix);
    this.mesh.setColorAt(slot, this.capColor.setRGB(r, g, b));
    this.mesh.count = Math.max(this.mesh.count, slot + 1);
    this.flush();
    if (this.order.length < this.slots.length) {
      this.order.push(slot);
      this.orderHead = this.order.length - 1;
    }
  }

  private hide(slot: number): void {
    this.pos.set(0, -1000, 0);
    this.scale.setScalar(0.001);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(slot, this.matrix);
  }

  private flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Step the world and sync every active body into its instance. */
  update(delta: number): void {
    const module = this.module;
    if (!module?._bx_get_states) return;
    module._bx_step?.(Math.min(delta, 1 / 20), 2);
    const pointer = module._bx_get_states();
    if (!pointer) return;
    const states = module.HEAPF32;
    const base = pointer >> 2;
    const count = states[base] | 0;
    let highest = 0;
    for (let i = 0; i < count; i += 1) {
      const o = base + 1 + i * 8;
      const slot = states[o + 7] | 0;
      this.pos.set(states[o], states[o + 1], states[o + 2]);
      this.quat.set(states[o + 3], states[o + 4], states[o + 5], states[o + 6]);
      this.scale.setScalar(this.slots[slot].half * 2);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(slot, this.matrix);
      highest = Math.max(highest, slot + 1);
    }
    this.mesh.count = highest;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Run restart: bodies gone, instances hidden. */
  reset(): void {
    this.module?._bx_clear?.();
    for (let i = 0; i < this.slots.length; i += 1) {
      this.slots[i].active = false;
      this.hide(i);
    }
    this.order.length = 0;
    this.orderHead = 0;
    this.mesh.count = 0;
    this.flush();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

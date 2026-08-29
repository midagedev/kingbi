import * as THREE from 'three';
import type { WorldQueries } from '../world/World';

interface Chunk {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  size: number;
  life: number;
  maxLife: number;
  rest: boolean;
}

const GRAVITY = 24;
const CHUNK_COLORS = {
  roof: new THREE.Color(0x39465a),   // 기와 — cold slate, ink-friendly
  wood: new THREE.Color(0x7c5a3a),   // 목조 보
  paper: new THREE.Color(0xcfc4a8),  // 한지 벽
  stone: new THREE.Color(0x6d675f),  // 주춧돌·담
  seal: new THREE.Color(0x6a0d10),   // 서열 붉은 액센트 (survives the grade)
};

/**
 * Building demolition as mosaic "pixels" — a cheap rigid-body impression:
 * ballistic cubes with spin, one ground bounce, settle, fade. No chunk-vs-
 * chunk solve: at quarter-view distance nobody can tell, and it keeps 500+
 * chunks inside the frame budget. The spawn API is shaped so a real engine
 * (Rapier/box3d-WASM) could drive the same fields later.
 */
export class DebrisPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly chunks: Chunk[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scaleV = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private cursor = 0;

  constructor(scene: THREE.Scene, capacity = 512) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.name = 'debris-chunks';
    scene.add(this.mesh);
    for (let i = 0; i < capacity; i += 1) {
      this.chunks.push({
        active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0,
        size: 1, life: 0, maxLife: 6, rest: false,
      });
    }
  }

  /** Voxel-fill a building's bounds with masonry and blow it outward
   *  from the impact point. Colors follow the hanok section (roof/beam/
   *  wall/plinth) so the pile reads as a demolished house, not gravel. */
  burstBuilding(
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number; baseY: number; topY: number },
    impactX: number,
    impactZ: number,
    rng: () => number,
    budget = 220,
  ): void {
    const w = bounds.maxX - bounds.minX;
    const d = bounds.maxZ - bounds.minZ;
    const h = Math.max(2, bounds.topY - bounds.baseY);
    const stride = Math.max(1.5, Math.cbrt((w * d * h) / Math.max(24, budget)));
    for (let x = bounds.minX + stride * 0.5; x < bounds.maxX; x += stride) {
      for (let z = bounds.minZ + stride * 0.5; z < bounds.maxZ; z += stride) {
        for (let y = bounds.baseY + stride * 0.5; y < bounds.topY; y += stride) {
          const k = (y - bounds.baseY) / h;
          const roll = rng();
          let tint = CHUNK_COLORS.paper;
          if (k > 0.78) tint = CHUNK_COLORS.roof;
          else if (k > 0.6) tint = CHUNK_COLORS.wood;
          else if (k < 0.22) tint = CHUNK_COLORS.stone;
          if (roll < 0.06) tint = CHUNK_COLORS.seal;
          this.spawn(x + (rng() - 0.5) * stride * 0.4, y, z + (rng() - 0.5) * stride * 0.4,
            impactX, impactZ, 1, rng, tint, 7 + rng() * 4, stride * (0.62 + rng() * 0.5));
        }
      }
    }
  }

  /** Masonry chips — brute slams on the gate, boom edges. */
  chipBurst(
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirZ: number,
    count: number,
    rng: () => number,
  ): void {
    for (let i = 0; i < count; i += 1) {
      this.spawn(x, y + rng() * 1.2, z, x - dirX, z - dirZ, 0.45, rng,
        rng() < 0.3 ? CHUNK_COLORS.roof : CHUNK_COLORS.stone, 3.5 + rng() * 2.5, 0.4 + rng() * 0.5);
    }
  }

  private spawn(
    x: number, y: number, z: number,
    impactX: number, impactZ: number,
    power: number,
    rng: () => number,
    tint: THREE.Color,
    life: number,
    size: number,
  ): void {
    const chunk = this.chunks[this.cursor];
    this.cursor = (this.cursor + 1) % this.chunks.length;
    chunk.active = true;
    chunk.rest = false;
    chunk.x = x;
    chunk.y = y;
    chunk.z = z;
    const dx = x - impactX;
    const dz = z - impactZ;
    const dist = Math.hypot(dx, dz) || 1;
    const away = power * (2.6 + rng() * 5.2);
    chunk.vx = (dx / dist) * away + (rng() - 0.5) * 2.4;
    chunk.vz = (dz / dist) * away + (rng() - 0.5) * 2.4;
    chunk.vy = 2.2 + rng() * 7.5 * power;
    chunk.rx = rng() * Math.PI * 2;
    chunk.ry = rng() * Math.PI * 2;
    chunk.rz = rng() * Math.PI * 2;
    chunk.wx = (rng() - 0.5) * 7;
    chunk.wy = (rng() - 0.5) * 7;
    chunk.wz = (rng() - 0.5) * 7;
    chunk.size = size;
    chunk.life = chunk.maxLife = life;
    this.mesh.setColorAt(this.chunks.indexOf(chunk), this.color.copy(tint));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Restart hygiene: no last run's rubble tumbling into the fresh defense. */
  clear(): void {
    for (const chunk of this.chunks) chunk.active = false;
    this.mesh.count = 0;
  }

  update(delta: number, queries: WorldQueries): void {
    let count = 0;
    for (const chunk of this.chunks) {
      if (!chunk.active) continue;
      chunk.life -= delta;
      if (chunk.life <= 0) {
        chunk.active = false;
        continue;
      }
      if (!chunk.rest) {
        chunk.vy -= GRAVITY * delta;
        chunk.x += chunk.vx * delta;
        chunk.y += chunk.vy * delta;
        chunk.z += chunk.vz * delta;
        chunk.rx += chunk.wx * delta;
        chunk.ry += chunk.wy * delta;
        chunk.rz += chunk.wz * delta;
        const ground = queries.heightAt(chunk.x, chunk.z) + chunk.size * 0.5;
        if (chunk.y <= ground) {
          chunk.y = ground;
          if (chunk.vy < -1.4) {
            chunk.vy = -chunk.vy * 0.36;
            chunk.vx *= 0.55;
            chunk.vz *= 0.55;
            chunk.wx *= 0.5;
            chunk.wz *= 0.5;
          } else {
            chunk.rest = true;
            chunk.vy = 0;
            chunk.vx = 0;
            chunk.vz = 0;
            chunk.wx = 0;
            chunk.wy = 0;
            chunk.wz = 0;
          }
        }
      }
      const fade = Math.min(1, chunk.life / 0.9);
      const s = chunk.size * (0.4 + 0.6 * fade);
      this.pos.set(chunk.x, chunk.y, chunk.z);
      this.euler.set(chunk.rx, chunk.ry, chunk.rz);
      this.quat.setFromEuler(this.euler);
      this.scaleV.set(s, s, s);
      this.matrix.compose(this.pos, this.quat, this.scaleV);
      this.mesh.setMatrixAt(count, this.matrix);
      count += 1;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

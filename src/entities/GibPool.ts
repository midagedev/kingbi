import * as THREE from 'three';

interface Gib {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  sx: number; sy: number; sz: number;
  life: number;
  maxLife: number;
  colorHex: number;
}

const PALETTE = [0xd01626, 0xc41420, 0xa81018, 0xe02030, 0xd6d8c4, 0x6b6355];

/**
 * 기브 풀 — the exaggerated gore pass: blood chunks, pale flesh and rag
 * scraps blown off kills, riding full ballistic arcs with spin, one ground
 * bounce, then a skid and shrink out. Unlit instance colors so the crimson
 * always punches through the noir grade.
 */
export class GibPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly gibs: Gib[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly posV = new THREE.Vector3();
  private readonly scaleV = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene, capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    for (let i = 0; i < capacity; i += 1) {
      this.gibs.push({
        active: false,
        x: 0, y: -100, z: 0,
        vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0,
        wx: 0, wy: 0, wz: 0,
        sx: 0.1, sy: 0.1, sz: 0.1,
        life: 0, maxLife: 1,
        colorHex: 0xd01626,
      });
    }
  }

  /** Detonation burst along the shot direction. Zero direction = isotropic. */
  burst(
    x: number, y: number, z: number,
    dirX: number, dirZ: number,
    count: number,
    rng: () => number,
    power = 1,
    colorHex?: number,
  ): void {
    const isotropic = Math.abs(dirX) + Math.abs(dirZ) < 0.2;
    const lateralX = -dirZ;
    const lateralZ = dirX;
    for (let i = 0; i < count; i += 1) {
      const gib = this.gibs.find((candidate) => !candidate.active);
      if (!gib) return;
      let forward: number;
      let lateral: number;
      if (isotropic) {
        const a = rng() * Math.PI * 2;
        const speed = (3.2 + rng() * 5.2) * power;
        forward = Math.cos(a) * speed;
        lateral = Math.sin(a) * speed;
      } else {
        forward = (3.2 + rng() * 5.2) * power;
        lateral = (rng() - 0.5) * 7 * power;
      }
      const up = (2.6 + rng() * 5.2) * power;
      gib.active = true;
      gib.x = x + (rng() - 0.5) * 0.3;
      gib.y = y + rng() * 0.35;
      gib.z = z + (rng() - 0.5) * 0.3;
      if (isotropic) {
        gib.vx = forward;
        gib.vz = lateral;
      } else {
        gib.vx = dirX * forward + lateralX * lateral;
        gib.vz = dirZ * forward + lateralZ * lateral;
      }
      gib.vy = up;
      gib.rx = rng() * Math.PI * 2;
      gib.ry = rng() * Math.PI * 2;
      gib.rz = rng() * Math.PI * 2;
      const spin = 5 + rng() * 13;
      gib.wx = (rng() - 0.5) * 2 * spin;
      gib.wy = (rng() - 0.5) * 2 * spin;
      gib.wz = (rng() - 0.5) * 2 * spin;
      const long = 0.1 + rng() * 0.22;
      gib.sx = long * (0.6 + rng() * 0.8);
      gib.sy = long * (0.5 + rng() * 0.5);
      gib.sz = long * (0.6 + rng() * 0.8);
      gib.maxLife = 0.9 + rng() * 0.7;
      gib.life = gib.maxLife;
      gib.colorHex = colorHex ?? PALETTE[Math.floor(rng() * PALETTE.length)];
    }
  }

  /** Small chip spray for non-lethal hits. */
  hitSpray(x: number, y: number, z: number, dirX: number, dirZ: number, rng: () => number): void {
    this.burst(x, y, z, dirX, dirZ, 3, rng, 0.45);
  }

  update(delta: number, groundAt: (x: number, z: number) => number): void {
    let count = 0;
    for (const gib of this.gibs) {
      if (!gib.active) continue;
      gib.life -= delta;
      if (gib.life <= 0) {
        gib.active = false;
        continue;
      }
      gib.vy -= 26 * delta;
      gib.x += gib.vx * delta;
      gib.y += gib.vy * delta;
      gib.z += gib.vz * delta;
      gib.rx += gib.wx * delta;
      gib.ry += gib.wy * delta;
      gib.rz += gib.wz * delta;

      const ground = groundAt(gib.x, gib.z) + gib.sy * 0.5;
      if (gib.y < ground) {
        gib.y = ground;
        if (gib.vy < -3.4) {
          // One wet bounce, then the chunk skids.
          gib.vy = -gib.vy * 0.32;
          gib.vx *= 0.55;
          gib.vz *= 0.55;
          gib.wx *= 0.5;
          gib.wy *= 0.5;
          gib.wz *= 0.5;
        } else {
          gib.vy = 0;
          const friction = Math.pow(0.06, delta);
          gib.vx *= friction;
          gib.vz *= friction;
          gib.wx *= friction;
          gib.wy *= friction;
          gib.wz *= friction;
        }
      }

      const fade = Math.min(1, gib.life / (gib.maxLife * 0.3));
      this.euler.set(gib.rx, gib.ry, gib.rz);
      this.quat.setFromEuler(this.euler);
      this.posV.set(gib.x, gib.y, gib.z);
      this.scaleV.set(gib.sx * fade, gib.sy * fade, gib.sz * fade);
      this.matrix.compose(this.posV, this.quat, this.scaleV);
      this.mesh.setMatrixAt(count, this.matrix);
      // Colors are written in the same compacted order as the matrices so a
      // gib always keeps its own palette entry.
      this.mesh.setColorAt(count, this.color.setHex(gib.colorHex));
      count += 1;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (const gib of this.gibs) gib.active = false;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

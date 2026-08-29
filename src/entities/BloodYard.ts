import * as THREE from 'three';
import type { WorldQueries } from '../world/World';

/**
 * 피의 마당 — the yard remembers. Every kill and detonation paints a
 * permanent blood pool onto a terrain-conforming canvas plane; by deep waves
 * the whole kill yard has turned black-red. One draw call, throttled
 * texture uploads.
 */
export class BloodYard {
  private readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private dirty = false;
  private flushTimer = 0;

  /** World rect the sheet covers — defaults to the old court, or the gate
   *  approach when the city-wall layout provides bounds. */
  private readonly minX: number;
  private readonly maxX: number;
  private readonly minZ: number;
  private readonly maxZ: number;

  constructor(scene: THREE.Scene, queries: WorldQueries, bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    this.minX = bounds?.minX ?? -46;
    this.maxX = bounds?.maxX ?? 46;
    this.minZ = bounds?.minZ ?? -72;
    this.maxZ = bounds?.maxZ ?? 18;
    const size = 1024;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    // Terrain-conforming sheet: displace each vertex to the ground once.
    const width = this.maxX - this.minX;
    const depth = this.maxZ - this.minZ;
    const geometry = new THREE.PlaneGeometry(width, depth, 40, 30);
    geometry.rotateX(-Math.PI / 2);
    const cx = (this.minX + this.maxX) / 2;
    const cz = (this.minZ + this.maxZ) / 2;
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i += 1) {
      const wx = positions.getX(i) + cx;
      const wz = positions.getZ(i) + cz;
      positions.setY(i, queries.heightAt(wx, wz) + 0.06);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      opacity: 0.92,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.set(cx, 0, cz);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'blood-yard';
    scene.add(this.mesh);
  }

  /** Paint a splat at world (x, z). radius in world meters. */
  paint(x: number, z: number, radius: number, rng: () => number): void {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return;
    const size = this.canvas.width;
    const px = ((x - this.minX) / (this.maxX - this.minX)) * size;
    // Canvas y runs downward; plane +z maps to canvas +y.
    const py = ((z - this.minZ) / (this.maxZ - this.minZ)) * size;
    const r = Math.max(3, (radius / (this.maxX - this.minX)) * size);

    // Saturated crimson so the noir grade keeps it; layered soft passes.
    for (const [alpha, scale, color] of [
      [0.32, 1.0, '96, 8, 14'],
      [0.4, 0.62, '120, 10, 16'],
      [0.5, 0.3, '60, 3, 6'],
    ] as const) {
      const gradient = this.ctx.createRadialGradient(px, py, r * 0.1, px, py, r * scale);
      gradient.addColorStop(0, `rgba(${color}, ${alpha})`);
      gradient.addColorStop(1, `rgba(${color}, 0)`);
      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.arc(px, py, r * scale, 0, Math.PI * 2);
      this.ctx.fill();
    }
    // Scattered droplets around the pool.
    const droplets = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < droplets; i += 1) {
      const a = rng() * Math.PI * 2;
      const d = r * (1.1 + rng() * 1.4);
      const dr = Math.max(1.5, r * (0.1 + rng() * 0.16));
      this.ctx.fillStyle = `rgba(88, 6, 10, ${0.25 + rng() * 0.3})`;
      this.ctx.beginPath();
      this.ctx.arc(px + Math.cos(a) * d, py + Math.sin(a) * d, dr, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.dirty = true;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = true;
  }

  update(delta: number): void {
    if (!this.dirty) return;
    this.flushTimer -= delta;
    if (this.flushTimer <= 0) {
      this.flushTimer = 0.16;
      this.dirty = false;
      this.texture.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
    this.mesh.removeFromParent();
  }
}

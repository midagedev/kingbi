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
      // The yard canvas IS the night's painting — keep its ink red raw so
      // the noir grade preserves it like the neon tracers, not crushed black.
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.set(cx, 0, cz);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'blood-yard';
    scene.add(this.mesh);
  }

  /** The raw sheet — the night's painting, exported with the score card. */
  get paintingCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** 부적 낙관 — a burning red talisman glyph stamped into the yard,
   *  permanent like the blood: every seal blast leaves a mark that survives
   *  to the dawn card. Drawn by hand (two imperfect brush rings, spell
   *  ticks, a star) so it reads as calligraphy, not clip-art. */
  paintSigil(x: number, z: number, radius: number, rng: () => number): void {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return;
    const size = this.canvas.width;
    const px = ((x - this.minX) / (this.maxX - this.minX)) * size;
    const py = ((z - this.minZ) / (this.maxZ - this.minZ)) * size;
    const r = Math.max(10, (radius / (this.maxX - this.minX)) * size);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate((rng() - 0.5) * 0.3);
    // Brush ring: two overlapping passes with a wobble, ink-block style.
    ctx.strokeStyle = 'rgba(232, 44, 60, 0.95)';
    for (const [width, wobble] of [[r * 0.1, 0.05], [r * 0.055, -0.03]] as const) {
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i <= 40; i += 1) {
        const a = (i / 40) * Math.PI * 2;
        const rr = r * (0.86 + wobble * Math.sin(a * 5 + rng() * 0.6));
        const ox = Math.cos(a) * rr;
        const oy = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(ox, oy);
        else ctx.lineTo(ox, oy);
      }
      ctx.closePath();
      ctx.stroke();
    }
    // Inner ring — the seal's field.
    ctx.lineWidth = r * 0.035;
    ctx.strokeStyle = 'rgba(226, 36, 52, 0.85)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    // 신장 주문 — vertical spell strokes down the middle.
    ctx.fillStyle = 'rgba(206, 22, 42, 0.9)';
    for (let i = 0; i < 4; i += 1) {
      const ly = -r * 0.45 + (i * r) / 4.4;
      const lw = r * (0.05 + (i % 2) * 0.03);
      ctx.fillRect(-lw / 2, ly, lw, r * 0.14 + (i % 2) * r * 0.05);
    }
    // 북두성 — the seven-star ward at the heart of the seal.
    ctx.fillStyle = 'rgba(255, 64, 78, 0.95)';
    ctx.beginPath();
    for (let i = 0; i < 7; i += 1) {
      const a = -Math.PI / 2 + (i / 7) * Math.PI * 2;
      const sr = i === 3 ? r * 0.2 : r * 0.07;
      ctx.arc(Math.cos(a) * r * 0.28, Math.sin(a) * r * 0.28, sr, 0, Math.PI * 2);
    }
    ctx.fill();
    // Corner ticks — the talisman's anchor points.
    ctx.lineWidth = r * 0.04;
    ctx.strokeStyle = 'rgba(226, 36, 52, 0.9)';
    for (const [cx, cy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      ctx.beginPath();
      ctx.moveTo(cx * r * 0.95, cy * r * 0.72);
      ctx.lineTo(cx * r * 0.72, cy * r * 0.95);
      ctx.stroke();
    }
    ctx.restore();
    this.dirty = true;
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

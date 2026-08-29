import * as THREE from 'three';
import type { WorldQueries } from './World';

/**
 * 궁가의 밤 대기 — the filmic density layer: rising embers and falling ash
 * drifting through the kill yard, low ground mist sheets, and a hard white
 * moon pinned behind the north murk. One Points draw + a few planes.
 */
export class Atmosphere {
  private readonly group = new THREE.Group();
  private readonly embers: THREE.Points;
  private readonly mist: THREE.Mesh[] = [];
  private readonly moon: THREE.Sprite;
  private readonly particles: Array<{
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    phase: number;
  }> = [];
  private readonly positions: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private elapsed = 0;
  private readonly bounds = { x: 62, zMin: -85, zMax: 20, yMin: 0.4, yMax: 26 };

  constructor(scene: THREE.Scene, queries: WorldQueries, compact: boolean) {
    const count = compact ? 90 : 170;
    this.positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const ember = new THREE.Color(0xff5a26);
    const emberHot = new THREE.Color(0xffb37a);
    const ash = new THREE.Color(0x9aa2ae);

    for (let i = 0; i < count; i += 1) {
      const isEmber = Math.random() < 0.55;
      this.particles.push({
        x: (Math.random() - 0.5) * this.bounds.x * 2,
        y: this.bounds.yMin + Math.random() * (this.bounds.yMax - this.bounds.yMin),
        z: this.bounds.zMin + Math.random() * (this.bounds.zMax - this.bounds.zMin),
        vx: (Math.random() - 0.5) * 0.5,
        vy: isEmber ? 0.5 + Math.random() * 0.9 : -(0.25 + Math.random() * 0.5),
        vz: (Math.random() - 0.5) * 0.5,
        phase: Math.random() * Math.PI * 2,
      });
      // Ash reads gray (the grade keeps it monochrome); embers are the
      // saturated reds that survive the noir pass.
      const c = isEmber ? (Math.random() < 0.4 ? emberHot : ember) : ash;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      sizes[i] = isEmber ? 0.09 + Math.random() * 0.09 : 0.06 + Math.random() * 0.06;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const pointsMaterial = new THREE.PointsMaterial({
      size: 0.12,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.embers = new THREE.Points(this.geometry, pointsMaterial);
    this.embers.frustumCulled = false;
    this.group.add(this.embers);
    this.materials.push(pointsMaterial);

    // ── Ground mist: soft alpha sheets stretched across the yard. ──
    const mistTexture = makeMistTexture();
    this.textures.push(mistTexture);
    const mistSpots: Array<[number, number, number, number]> = compact
      ? [[0, -18, 34, 0.055], [-14, -44, 26, 0.045]]
      : [[0, -14, 40, 0.06], [-22, -40, 30, 0.05], [20, -48, 30, 0.05], [0, -62, 46, 0.04]];
    for (const [x, z, size, opacity] of mistSpots) {
      const material = new THREE.MeshBasicMaterial({
        map: mistTexture,
        transparent: true,
        opacity,
        depthWrite: false,
        color: 0x8b95a6,
      });
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.62), material);
      sheet.rotation.x = -Math.PI / 2;
      sheet.position.set(x, queries.heightAt(x, z) + 0.5 + Math.random() * 0.4, z);
      sheet.rotation.z = Math.random() * Math.PI;
      this.mist.push(sheet);
      this.group.add(sheet);
      this.materials.push(material);
      this.geometries.push(sheet.geometry);
    }

    // ── Moon: hard disc + halo, north sky, unaffected by fog. ──
    const moonTexture = makeMoonTexture();
    this.textures.push(moonTexture);
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: moonTexture,
      transparent: true,
      depthWrite: false,
      fog: false,
    }));
    this.moon.scale.setScalar(64);
    this.moon.position.set(-42, 96, -320);
    this.group.add(this.moon);
    this.materials.push(this.moon.material);

    this.group.name = 'atmosphere';
    scene.add(this.group);
  }

  private readonly geometries: THREE.BufferGeometry[] = [];

  update(delta: number): void {
    this.elapsed += delta;
    const b = this.bounds;
    for (let i = 0; i < this.particles.length; i += 1) {
      const p = this.particles[i];
      // Wind sway on top of the base drift.
      const sway = Math.sin(this.elapsed * 0.7 + p.phase) * 0.35;
      p.x += (p.vx + sway) * delta;
      p.z += p.vz * delta;
      p.y += p.vy * delta;
      if (p.y > b.yMax) p.y = b.yMin;
      if (p.y < b.yMin) p.y = b.yMax;
      if (p.x > b.x) p.x = -b.x;
      if (p.x < -b.x) p.x = b.x;
      if (p.z > b.zMax) p.z = b.zMin;
      if (p.z < b.zMin) p.z = b.zMax;
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
    }
    this.geometry.attributes.position.needsUpdate = true;

    // Mist sheets slide and breathe.
    for (let i = 0; i < this.mist.length; i += 1) {
      const sheet = this.mist[i];
      sheet.rotation.z += delta * (0.02 + i * 0.008);
      sheet.position.x += Math.sin(this.elapsed * 0.1 + i) * delta * 0.4;
    }
    // Moon halo breathes very slightly — a living sky, not a decal.
    this.moon.scale.setScalar(64 + Math.sin(this.elapsed * 0.23) * 1.2);
  }

  dispose(): void {
    this.geometry.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.group.removeFromParent();
  }
}

function makeMistTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.38)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function makeMoonTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;
  // Halo.
  const halo = ctx.createRadialGradient(cx, cx, 10, cx, cx, cx);
  halo.addColorStop(0, 'rgba(235, 240, 250, 0.55)');
  halo.addColorStop(0.25, 'rgba(215, 224, 240, 0.2)');
  halo.addColorStop(1, 'rgba(200, 210, 230, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);
  // Disc with crater mottle — noir keeps it hard white.
  const disc = ctx.createRadialGradient(cx - 14, cx - 16, 6, cx, cx, 44);
  disc.addColorStop(0, 'rgba(255, 255, 252, 1)');
  disc.addColorStop(0.8, 'rgba(242, 244, 248, 1)');
  disc.addColorStop(1, 'rgba(210, 216, 228, 0.9)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cx, 44, 0, Math.PI * 2);
  ctx.fill();
  for (const [ox, oy, r] of [[-12, 8, 7], [10, -6, 9], [4, 18, 5], [16, 14, 4], [-16, -12, 5]]) {
    ctx.fillStyle = 'rgba(190, 198, 214, 0.35)';
    ctx.beginPath();
    ctx.arc(cx + ox, cx + oy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

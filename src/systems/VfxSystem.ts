import * as THREE from 'three';

interface Spark {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
}

/**
 * Event VFX: slash arcs, ink-dark blood bursts, dust puffs, dawn frost sparkles.
 * One additive Points system + pooled arc meshes. No per-event allocations.
 */
export class VfxSystem {
  private readonly points: THREE.Points;
  private readonly sparkPool: Spark[] = [];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly maxSparks: number;
  private readonly arcGeometry: THREE.BufferGeometry;
  private readonly arcMaterial: THREE.MeshBasicMaterial;
  private readonly arcs: Array<{ mesh: THREE.Mesh; life: number; maxLife: number }> = [];
  private readonly tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene, maxSparks = 260, maxArcs = 6) {
    this.maxSparks = maxSparks;
    this.positions = new Float32Array(maxSparks * 3);
    this.colors = new Float32Array(maxSparks * 3);
    this.sizes = new Float32Array(maxSparks);

    const pointsGeometry = new THREE.BufferGeometry();
    pointsGeometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    pointsGeometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    pointsGeometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

    const pointsMaterial = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(pointsGeometry, pointsMaterial);
    this.points.frustumCulled = false;
    scene.add(this.points);

    for (let i = 0; i < maxSparks; i += 1) {
      this.sparkPool.push({
        x: 0, y: -100, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1,
        size: 0.1,
        color: new THREE.Color(),
      });
    }

    // Slash arc: ring segment in the XZ plane, additive white-gold.
    this.arcGeometry = new THREE.RingGeometry(0.7, 2.1, 24, 1, -0.55, 1.9);
    this.arcGeometry.rotateX(-Math.PI / 2);
    this.arcMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff2c8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < maxArcs; i += 1) {
      const mesh = new THREE.Mesh(this.arcGeometry, this.arcMaterial);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.arcs.push({ mesh, life: 0, maxLife: 0.22 });
    }
  }

  slashArc(x: number, y: number, z: number, facing: number): void {
    const slot = this.arcs.find((arc) => arc.life <= 0);
    if (!slot) return;
    slot.mesh.position.set(x, y, z);
    slot.mesh.rotation.y = facing;
    slot.mesh.scale.setScalar(1);
    slot.mesh.visible = true;
    slot.life = slot.maxLife;
  }

  /** Kingdom-style blood: hot crimson spray the noir grade keeps and pumps. */
  bloodBurst(x: number, y: number, z: number, dirX: number, dirZ: number, count: number, rng: () => number): void {
    for (let i = 0; i < count; i += 1) {
      const spark = this.sparkPool.find((candidate) => candidate.life <= 0);
      if (!spark) return;
      const spread = (rng() - 0.5) * 3.2;
      spark.x = x;
      spark.y = y + rng() * 0.5;
      spark.z = z;
      spark.vx = dirX * 3.2 + spread;
      spark.vz = dirZ * 3.2 - spread;
      spark.vy = 2.0 + rng() * 3.2;
      spark.maxLife = 0.5 + rng() * 0.35;
      spark.life = spark.maxLife;
      spark.size = 0.12 + rng() * 0.14;
      spark.color.setHex(0xd01626);
    }
  }

  /** Demolition dust: slow pale puffs that hang over the rubble (the
   *  ink grade renders them as paper-toned smoke). */
  demolitionDust(x: number, y: number, z: number, count: number, rng: () => number): void {
    for (let i = 0; i < count; i += 1) {
      const spark = this.sparkPool.find((candidate) => candidate.life <= 0);
      if (!spark) return;
      spark.x = x + (rng() - 0.5) * 5;
      spark.y = y + rng() * 2.4;
      spark.z = z + (rng() - 0.5) * 5;
      spark.vx = (rng() - 0.5) * 1.6;
      spark.vz = (rng() - 0.5) * 1.6;
      spark.vy = 0.7 + rng() * 1.1;
      spark.maxLife = 1.3 + rng() * 0.9;
      spark.life = spark.maxLife;
      spark.size = 0.55 + rng() * 0.75;
      spark.color.setHex(0x9a9186);
    }
  }

  /** Bright fast flash on every bullet impact — the hit marker. */
  hitSpark(x: number, y: number, z: number, dirX: number, dirZ: number, rng: () => number): void {
    for (let i = 0; i < 4; i += 1) {
      const spark = this.sparkPool.find((candidate) => candidate.life <= 0);
      if (!spark) return;
      spark.x = x;
      spark.y = y + rng() * 0.3;
      spark.z = z;
      spark.vx = -dirX * 2.4 + (rng() - 0.5) * 5;
      spark.vz = -dirZ * 2.4 + (rng() - 0.5) * 5;
      spark.vy = 1.2 + rng() * 2.6;
      spark.maxLife = 0.16 + rng() * 0.12;
      spark.life = spark.maxLife;
      spark.size = 0.13 + rng() * 0.09;
      spark.color.setHex(0xff6a4a);
    }
  }

  /** White-hot ricochet spray — bullets bouncing off door plating. */
  armorSpark(x: number, y: number, z: number, dirX: number, dirZ: number, rng: () => number): void {
    for (let i = 0; i < 5; i += 1) {
      const spark = this.sparkPool.find((candidate) => candidate.life <= 0);
      if (!spark) return;
      spark.x = x;
      spark.y = y + rng() * 0.4;
      spark.z = z;
      spark.vx = -dirX * 3.6 + (rng() - 0.5) * 6;
      spark.vz = -dirZ * 3.6 + (rng() - 0.5) * 6;
      spark.vy = 1.4 + rng() * 3.4;
      spark.maxLife = 0.14 + rng() * 0.1;
      spark.life = spark.maxLife;
      spark.size = 0.1 + rng() * 0.08;
      spark.color.setHex(0xfff2c8);
    }
  }

  dustPuff(x: number, y: number, z: number, count: number, rng: () => number): void {
    for (let i = 0; i < count; i += 1) {
      const spark = this.sparkPool.find((candidate) => candidate.life <= 0);
      if (!spark) return;
      const a = rng() * Math.PI * 2;
      spark.x = x + Math.cos(a) * 0.3;
      spark.y = y + 0.1;
      spark.z = z + Math.sin(a) * 0.3;
      spark.vx = Math.cos(a) * 1.2;
      spark.vz = Math.sin(a) * 1.2;
      spark.vy = 0.8 + rng();
      spark.maxLife = 0.8 + rng() * 0.5;
      spark.life = spark.maxLife;
      spark.size = 0.16 + rng() * 0.12;
      spark.color.setHex(0xa8a49c);
    }
  }

  frostShimmer(x: number, y: number, z: number, count: number, rng: () => number): void {
    for (let i = 0; i < count; i += 1) {
      const spark = this.sparkPool.find((candidate) => candidate.life <= 0);
      if (!spark) return;
      spark.x = x + (rng() - 0.5);
      spark.y = y + rng() * 1.6;
      spark.z = z + (rng() - 0.5);
      spark.vx = 0;
      spark.vz = 0;
      spark.vy = 0.4;
      spark.maxLife = 1.1;
      spark.life = spark.maxLife;
      spark.size = 0.08;
      spark.color.setHex(0xcfe8ff);
    }
  }

  update(delta: number, groundAt: (x: number, z: number) => number): void {
    for (const arc of this.arcs) {
      if (arc.life <= 0) continue;
      arc.life -= delta;
      const t = Math.max(0, arc.life / arc.maxLife);
      arc.mesh.material as THREE.MeshBasicMaterial;
      (arc.mesh.material as THREE.MeshBasicMaterial).opacity = t * 0.55;
      arc.mesh.scale.setScalar(1.15 - t * 0.35);
      if (arc.life <= 0) arc.mesh.visible = false;
    }

    let count = 0;
    for (const spark of this.sparkPool) {
      if (spark.life <= 0) continue;
      spark.life -= delta;
      spark.vy -= 7.5 * delta;
      spark.x += spark.vx * delta;
      spark.y += spark.vy * delta;
      spark.z += spark.vz * delta;
      const ground = groundAt(spark.x, spark.z) + 0.04;
      if (spark.y < ground) {
        spark.y = ground;
        spark.vy = 0;
        spark.vx *= 0.7;
        spark.vz *= 0.7;
      }
      if (spark.life <= 0) continue;
      const fade = spark.life / spark.maxLife;
      this.positions[count * 3] = spark.x;
      this.positions[count * 3 + 1] = spark.y;
      this.positions[count * 3 + 2] = spark.z;
      this.tmpColor.copy(spark.color).multiplyScalar(fade);
      this.colors[count * 3] = this.tmpColor.r;
      this.colors[count * 3 + 1] = this.tmpColor.g;
      this.colors[count * 3 + 2] = this.tmpColor.b;
      this.sizes[count] = spark.size * (0.6 + fade * 0.4);
      count += 1;
    }

    // Hide inactive sparks far below the world.
    for (let i = count; i < this.maxSparks; i += 1) {
      this.positions[i * 3 + 1] = -100;
    }
    const geometry = this.points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.attributes.size.needsUpdate = true;
    this.points.visible = count > 0;
  }

  reset(): void {
    for (const spark of this.sparkPool) spark.life = 0;
    for (const arc of this.arcs) {
      arc.life = 0;
      arc.mesh.visible = false;
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points.removeFromParent();
    this.arcGeometry.dispose();
    this.arcMaterial.dispose();
    for (const arc of this.arcs) arc.mesh.removeFromParent();
  }
}

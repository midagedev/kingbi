import * as THREE from 'three';

/**
 * 무너진 집에 붙는 화재 — the night escalates: every collapsed building
 * burns until dawn. Each fire is a cluster of toneMapped-off flame boxes
 * over a big warm additive GLOW disc (the light spilling across the yard)
 * and — the hero shot — every 원귀 near a fire drags a LONG FAKED shadow
 * streak across the ground, pointing away from the flames.
 *
 * Cost discipline: NO per-fire PointLights (a pair cost ~8fps in stress
 * per-pixel math — the lantern lesson). One shared desktop-only light
 * follows the nearest fire so bodies and rubble actually warm up; the
 * shadows themselves are tapered alpha quads, free.
 */
interface Fire {
  x: number;
  y: number;
  z: number;
  scale: number;
  age: number;
  /** Accumulator for the slow devour cadence (불은 집을 먹는다). */
  burnTimer: number;
  /** <0 while burning forever; >=0 counts the fade-out (cap overflow). */
  fade: number;
  glow: THREE.Mesh;
  glowPhase: number;
}

interface FlameRow {
  fire: Fire;
  dx: number;
  dz: number;
  y0: number;
  w: number;
  h: number;
  yaw: number;
  phase: number;
  speed: number;
}

const MAX_FIRES = 8;
const MAX_FLAME_ROWS = 110;
const MAX_SHADOWS = 320;

/** Vertical alpha ramp for the streak: opaque at the feet (v0), gone at
 *  the tip — a stretched soft shadow, not a black plank. */
function buildStreakTexture(): THREE.Texture {
  const w = 64;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // alphaMap samples the GREEN channel — the ramp must be WHITE, not
    // black-transparent (black reads g=0: perfectly invisible streaks).
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0.0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(1.0, 'rgba(255,255,255,1)');
    ctx.fillStyle = gradient;
    // Tapered trapezoid: full width at the feet, near-point at the tip.
    ctx.beginPath();
    ctx.moveTo(w * 0.14, 0);
    ctx.lineTo(w * 0.86, 0);
    ctx.lineTo(w * 0.56, h);
    ctx.lineTo(w * 0.44, h);
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

/** Soft round warm spill — same family as the lantern pools, bigger. */
function buildGlowTexture(): THREE.Texture {
  const side = 128;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(side / 2, side / 2, 3, side / 2, side / 2, side / 2);
    gradient.addColorStop(0.0, 'rgba(255,176,96,0.85)');
    gradient.addColorStop(0.4, 'rgba(255,138,60,0.34)');
    gradient.addColorStop(0.75, 'rgba(255,110,44,0.10)');
    gradient.addColorStop(1.0, 'rgba(255,100,40,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, side, side);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class FireField {
  private readonly fires: Fire[] = [];
  private readonly rows: FlameRow[] = [];
  private readonly flameMesh: THREE.InstancedMesh;
  private readonly glowTexture: THREE.Texture;
  private readonly streakTexture: THREE.Texture;
  private readonly shadowMesh: THREE.InstancedMesh;
  /** Desktop-only warm spot over the nearest fire — the ONE light with a
   *  real shadow map: the burning house, marching 원귀 and the corpse
   *  heaps all cast true shadows radiating away from the flames. Other
   *  lights (secondary fires, lanterns) cast via the streak system. */
  private readonly light: THREE.SpotLight | null;
  private readonly lightTarget: THREE.Object3D | null;
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private time = 0;
  private shadowFrame = 0;

  constructor(scene: THREE.Scene, compact: boolean, focusX: number, focusZ: number) {
    const flameGeometry = new THREE.BoxGeometry(1, 1, 1);
    const flameMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.flameMesh = new THREE.InstancedMesh(flameGeometry, flameMaterial, MAX_FLAME_ROWS);
    this.flameMesh.frustumCulled = false;
    this.flameMesh.count = 0;
    this.flameMesh.name = 'fire-flames';
    for (let i = 0; i < MAX_FLAME_ROWS; i += 1) this.hideRow(i);
    scene.add(this.flameMesh);

    this.glowTexture = buildGlowTexture();
    this.streakTexture = buildStreakTexture();

    const shadowGeometry = new THREE.PlaneGeometry(1, 1);
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: this.streakTexture,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.shadowMesh = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, MAX_SHADOWS);
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.renderOrder = 2;
    this.shadowMesh.count = 0;
    this.shadowMesh.name = 'fire-shadows';
    scene.add(this.shadowMesh);

    this.light = compact ? null : new THREE.SpotLight(0xff8a3c, 0, 34, 1.15, 0.6, 2);
    if (this.light) {
      this.light.position.set(focusX, 9, focusZ);
      this.light.castShadow = true;
      this.light.shadow.autoUpdate = false; // toggled every other frame below
      this.light.shadow.mapSize.set(1024, 1024);
      this.light.shadow.camera.near = 2;
      this.light.shadow.camera.far = 34;
      this.light.shadow.bias = -0.0008;
      this.light.shadow.normalBias = 0.04;
      this.lightTarget = new THREE.Object3D();
      this.light.target = this.lightTarget;
      scene.add(this.light, this.lightTarget);
    } else {
      this.lightTarget = null;
    }
  }

  get fireCount(): number {
    return this.fires.length;
  }

  /** A building just pancaked — light it. `jitter` is the game's seeded rng. */
  ignite(x: number, groundY: number, z: number, scale: number, jitter: () => number): void {
    // Re-ignite guard: a house already alight refreshes its fire instead
    // of stacking a second one on the same rubble.
    for (const existing of this.fires) {
      if (Math.hypot(existing.x - x, existing.z - z) < 6) {
        existing.fade = -1;
        if (existing.scale < scale) existing.scale = scale;
        return;
      }
    }
    const fire: Fire = {
      x, y: groundY, z, scale,
      age: 0,
      burnTimer: 0,
      fade: -1,
      glow: new THREE.Mesh(
        new THREE.PlaneGeometry((9 + 5 * scale) * 2, (9 + 5 * scale) * 2),
        new THREE.MeshBasicMaterial({
          map: this.glowTexture,
          transparent: true,
          opacity: 0.3,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
      glowPhase: jitter() * Math.PI * 2,
    };
    fire.glow.rotation.x = -Math.PI / 2;
    fire.glow.position.set(x, groundY + 0.06, z);
    fire.glow.renderOrder = 1;
    fire.glow.name = 'fire-glow';
    this.sceneHost()?.add(fire.glow);
    this.fires.push(fire);

    const flames = Math.round((6 + 4 * scale) * (this.fires.length > 4 ? 0.7 : 1));
    for (let i = 0; i < flames && this.rows.length < MAX_FLAME_ROWS; i += 1) {
      const angle = jitter() * Math.PI * 2;
      const reach = (0.4 + jitter() * 0.6) * 2.2 * scale;
      this.rows.push({
        fire,
        dx: Math.cos(angle) * reach,
        dz: Math.sin(angle) * reach,
        y0: 0.08 + jitter() * 0.5,
        w: (0.28 + jitter() * 0.34) * (0.7 + scale * 0.35),
        h: (0.55 + jitter() * 1.05) * (0.7 + scale * 0.5),
        yaw: jitter() * Math.PI,
        phase: jitter() * Math.PI * 2,
        speed: 5.5 + jitter() * 4.5,
      });
    }
    this.rebuildRows();
    // Cap: the OLDEST fire burns out (quick fade, never a blink).
    if (this.fires.length > MAX_FIRES) this.fires[0].fade = 0;
  }

  private sceneHost(): THREE.Scene | null {
    return this.flameMesh.parent as THREE.Scene | null;
  }

  private hideRow(row: number): void {
    this.pos.set(0, -1000, 0);
    this.scale.setScalar(0.001);
    this.matrix.compose(this.pos, this.quat.identity(), this.scale);
    this.flameMesh.setMatrixAt(row, this.matrix);
  }

  /** Rows are dense over live fires; removals rebuild the buffer. */
  private rebuildRows(): void {
    this.flameMesh.count = this.rows.length;
    for (let i = 0; i < this.rows.length; i += 1) {
      const warmth = 0.5 + (i % 3) * 0.25;
      this.flameMesh.setColorAt(i, this.color.setRGB(1.0, 0.42 + warmth * 0.3, 0.12 + warmth * 0.14));
    }
    if (this.flameMesh.instanceColor) this.flameMesh.instanceColor.needsUpdate = true;
    this.flameMesh.instanceMatrix.needsUpdate = true;
  }

  private removeFire(fire: Fire): void {
    fire.glow.geometry.dispose();
    (fire.glow.material as THREE.Material).dispose();
    fire.glow.removeFromParent();
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i].fire === fire) this.rows.splice(i, 1);
    }
    const index = this.fires.indexOf(fire);
    if (index >= 0) this.fires.splice(index, 1);
    this.rebuildRows();
  }

  update(delta: number, focusX: number, focusZ: number): void {
    this.time += delta;
    // Fades first (cap overflow burnouts).
    for (let i = this.fires.length - 1; i >= 0; i -= 1) {
      const fire = this.fires[i];
      fire.age += delta;
      if (fire.fade >= 0) {
        fire.fade += delta;
        if (fire.fade > 2.6) {
          this.removeFire(fire);
          continue;
        }
      }
    }
    // Flames flicker: height pulse + slight base wobble, deterministic sines.
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i];
      const fire = row.fire;
      const dying = fire.fade >= 0 ? Math.max(0, 1 - fire.fade / 2.6) : 1;
      const flick = 0.78
        + 0.22 * Math.sin(this.time * row.speed + row.phase)
          * Math.sin(this.time * (row.speed * 0.37) + row.phase * 1.7);
      const w = row.w * (0.85 + 0.15 * flick) * dying;
      const h = row.h * flick * dying;
      this.euler.set(0, row.yaw + Math.sin(this.time * 0.9 + row.phase) * 0.12, 0);
      this.pos.set(
        fire.x + row.dx + Math.sin(this.time * 0.7 + row.phase) * 0.08,
        fire.y + row.y0 + h * 0.5,
        fire.z + row.dz,
      );
      this.matrix.compose(this.pos, this.quat.setFromEuler(this.euler), this.scale.set(w, h, w));
      this.flameMesh.setMatrixAt(i, this.matrix);
    }
    if (this.rows.length > 0) this.flameMesh.instanceMatrix.needsUpdate = true;
    // Glow pulse per fire.
    for (const fire of this.fires) {
      const dying = fire.fade >= 0 ? Math.max(0, 1 - fire.fade / 2.6) : 1;
      const pulse = 0.8
        + 0.2 * Math.sin(this.time * 6.1 + fire.glowPhase)
          * Math.sin(this.time * 2.3 + fire.glowPhase * 0.6);
      (fire.glow.material as THREE.MeshBasicMaterial).opacity = (0.36 + 0.14 * pulse) * dying;
      const s = 1 + 0.05 * pulse;
      fire.glow.scale.set(s, s, 1);
    }
    // The one real light follows the fire nearest the defense point.
    if (this.light) {
      let best: Fire | null = null;
      let bestDist = Infinity;
      for (const fire of this.fires) {
        if (fire.fade >= 0) continue;
        const d = (fire.x - focusX) ** 2 + (fire.z - focusZ) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = fire;
        }
      }
      if (best && this.lightTarget) {
        // Half-rate shadow refresh (30fps): the voxel-house vertex load in
        // the shadow pass is the price of real fire shadows — halved here,
        // imperceptible at night.
        this.shadowFrame += 1;
        this.light.shadow.needsUpdate = (this.shadowFrame & 1) === 0;
        const flicker = 0.85 + 0.15 * Math.sin(this.time * 7.7) * Math.sin(this.time * 3.1);
        // The spot rides high above the flames: wide cone, shadows radiate
        // outward from the fire across the whole glow pool.
        this.light.position.lerp(this.pos.set(best.x, best.y + 7.5 + best.scale * 1.5, best.z), Math.min(1, delta * 4));
        this.lightTarget.position.lerp(this.pos.set(best.x, best.y + 0.6, best.z), Math.min(1, delta * 4));
        this.lightTarget.updateMatrixWorld();
        this.light.intensity = (13 + 9 * best.scale) * flicker;
      } else {
        this.light.intensity = 0;
      }
    }
  }

  /** 불은 집을 먹는다 — every live fire pops slow DEVOUR bites that the
   *  game layer chews with its seeded rng. Cadence and bite positions are
   *  time-and-phase sines (deterministic, no rng here): the bite point
   *  slowly spirals through the footprint and climbs the walls, so the
   *  house sheds flakes from everywhere before it gives. */
  collectBurnBites(delta: number, out: Array<{ x: number; y: number; z: number; scale: number }>): number {
    let popped = 0;
    for (const fire of this.fires) {
      if (fire.fade >= 0) continue;
      fire.burnTimer += delta;
      const interval = 0.34 + 0.3 * Math.abs(Math.sin(fire.glowPhase));
      if (fire.burnTimer < interval) continue;
      fire.burnTimer = 0;
      const wander = fire.scale * 2.4;
      const angle = fire.glowPhase + this.time * 0.8;
      out.push({
        x: fire.x + Math.cos(angle) * wander * Math.abs(Math.sin(this.time * 0.63 + fire.glowPhase)),
        z: fire.z + Math.sin(angle) * wander * Math.abs(Math.cos(this.time * 0.47 + fire.glowPhase * 2.1)),
        y: fire.y + 0.7 + Math.abs(Math.sin(this.time * 0.4 + fire.glowPhase * 3.3)) * 2.1,
        scale: fire.scale,
      });
      popped += 1;
    }
    return popped;
  }

  /** 광원마다 그림자 — every active 원귀 casts a tapered streak PER nearby
   *  light, pointing away from it: up to the two strongest sources (the
   *  secondary streak reads weaker — shorter and thinner), fires joined by
   *  the yard lanterns as steady weak sources. The nearest fire ALSO gets
   *  real shadow-mapped light (see the spot above); the streaks cover
   *  every other light at zero per-light cost. */
  updateShadows(
    eachZombie: (visit: (x: number, z: number, state: string, type: string) => void) => void,
    groundAt: (x: number, z: number) => number,
    staticSources: Array<{ x: number; z: number }> = [],
  ): void {
    if (this.fires.length === 0 && staticSources.length === 0) {
      if (this.shadowMesh.count !== 0) this.shadowMesh.count = 0;
      return;
    }
    let written = 0;
    const scratch: Array<{ x: number; z: number; type: string }> = [];
    eachZombie((x, z, state, type) => {
      if (state === 'dormant') return;
      scratch.push({ x, z, type });
    });
    interface Source { x: number; z: number; radius: number; power: number }
    const sources: Source[] = [];
    for (const fire of this.fires) {
      sources.push({
        x: fire.x, z: fire.z,
        radius: (9 + 5 * fire.scale) * 1.45,
        power: (fire.fade >= 0 ? Math.max(0, 1 - fire.fade / 2.6) : 1) * (0.7 + 0.3 * fire.scale),
      });
    }
    for (const lantern of staticSources) {
      sources.push({ x: lantern.x, z: lantern.z, radius: 6.5, power: 0.42 });
    }
    for (const zombie of scratch) {
      let best: Source | null = null;
      let bestScore = 0;
      let second: Source | null = null;
      let secondScore = 0;
      for (const source of sources) {
        const dx = zombie.x - source.x;
        const dz = zombie.z - source.z;
        const d = Math.hypot(dx, dz);
        if (d > source.radius || d < 0.001) continue;
        const score = (1 - d / source.radius) * source.power;
        if (score > bestScore) {
          second = best; secondScore = bestScore;
          best = source; bestScore = score;
        } else if (score > secondScore) {
          second = source; secondScore = score;
        }
      }
      for (const [source, weight] of [[best, 1], [second, 0.62]] as Array<[Source | null, number]>) {
        if (!source || written >= MAX_SHADOWS) continue;
        const dx = zombie.x - source.x;
        const dz = zombie.z - source.z;
        const d = Math.hypot(dx, dz) || 1;
        const dirX = dx / d;
        const dirZ = dz / d;
        const length = Math.min(9, (1.6 + (1 - d / source.radius) * (5.0 + 4.0 * source.power)) * weight);
        const baseWidth = zombie.type === 'brute' ? 1.1 : zombie.type === 'bloater' ? 0.9 : 0.62;
        const width = baseWidth * (0.72 + 0.28 * weight);
        this.euler.set(-Math.PI / 2, Math.atan2(-dirX, -dirZ), 0);
        this.pos.set(zombie.x + dirX * (length * 0.5 + 0.25), groundAt(zombie.x, zombie.z) + 0.03, zombie.z + dirZ * (length * 0.5 + 0.25));
        this.matrix.compose(this.pos, this.quat.setFromEuler(this.euler), this.scale.set(width, length, 1));
        this.shadowMesh.setMatrixAt(written, this.matrix);
        written += 1;
      }
    }
    this.shadowMesh.count = written;
    if (written > 0) this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  /** Run restart: the yard is swept cold. */
  reset(): void {
    for (let i = this.fires.length - 1; i >= 0; i -= 1) this.removeFire(this.fires[i]);
    this.shadowMesh.count = 0;
    if (this.light) this.light.intensity = 0;
  }

  dispose(): void {
    this.reset();
    this.flameMesh.geometry.dispose();
    (this.flameMesh.material as THREE.Material).dispose();
    this.flameMesh.removeFromParent();
    this.shadowMesh.geometry.dispose();
    (this.shadowMesh.material as THREE.Material).dispose();
    this.shadowMesh.removeFromParent();
    this.glowTexture.dispose();
    this.streakTexture.dispose();
    this.light?.removeFromParent();
  }
}

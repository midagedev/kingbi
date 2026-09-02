import * as THREE from 'three';

/**
 * 무너진 집에 붙는 화재 — the night escalates: every collapsed building
 * burns until dawn. Each fire is a cluster of toneMapped-off flame boxes
 * over a big warm additive GLOW disc (the light spilling across the yard),
 * plus the voxel 색광 bake that warms the walls it reaches.
 *
 * Cost discipline: NO per-fire PointLights (a pair cost ~8fps in stress
 * per-pixel math — the lantern lesson) and NO shadow maps — the zombie
 * streak shadows read fake and bought the frame rate down, so the fire
 * spot lights only. One shared desktop-only light follows the nearest
 * fire so bodies and rubble actually warm up.
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
  /** Desktop-only warm spot over the nearest fire — LIGHT ONLY, no shadow
   *  map: the streak shadows and the alternating-frame 1024² render both
   *  read as fake/frame-cost and were retired (more 좀비, more physics). */
  private readonly light: THREE.SpotLight | null;
  private readonly lightTarget: THREE.Object3D | null;
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private time = 0;

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

    this.light = compact ? null : new THREE.SpotLight(0xff8a3c, 0, 34, 1.15, 0.6, 2);
    if (this.light) {
      this.light.position.set(focusX, 9, focusZ);
      this.lightTarget = new THREE.Object3D();
      this.light.target = this.lightTarget;
      // Layer 1 = the voxel-house mass: the spot lights the burning walls
      // (warm-up on top of the 색광 bake).
      this.light.layers.enable(1);
      scene.add(this.light, this.lightTarget);
    } else {
      this.lightTarget = null;
    }
  }

  get fireCount(): number {
    return this.fires.length;
  }

  /** Enumerate live fires for the voxel 색광 bake (and QA) — `vigor` is
   *  the dying-fade weight (1 while burning, 0 at cold). */
  eachFire(visit: (x: number, y: number, z: number, scale: number, vigor: number) => void): void {
    for (const fire of this.fires) {
      visit(fire.x, fire.y, fire.z, fire.scale, fire.fade >= 0 ? Math.max(0, 1 - fire.fade / 2.6) : 1);
    }
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
        const flicker = 0.85 + 0.15 * Math.sin(this.time * 7.7) * Math.sin(this.time * 3.1);
        // The spot rides high above the flames: wide cone, warm light
        // radiating outward from the fire across the whole glow pool.
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

  /** Run restart: the yard is swept cold. */
  reset(): void {
    for (let i = this.fires.length - 1; i >= 0; i -= 1) this.removeFire(this.fires[i]);
    if (this.light) this.light.intensity = 0;
  }

  dispose(): void {
    this.reset();
    this.flameMesh.geometry.dispose();
    (this.flameMesh.material as THREE.Material).dispose();
    this.flameMesh.removeFromParent();
    this.glowTexture.dispose();
    this.light?.removeFromParent();
  }
}

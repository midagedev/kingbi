import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createVillageAsync } from '@cheoma/api/village.js';
import {
  setupEnvironment,
  setupPost,
  MSAA_SAMPLES_COMPACT,
  MSAA_SAMPLES_DESKTOP,
} from '@cheoma/api/environment.js';
import type {
  CheomaEnvHandle,
  CheomaPostHandle,
} from '@cheoma/api/environment.js';
import type { CheomaVillageHandle } from '@cheoma/api/village.js';
import { createNoirGradePass, setNoirGradeResolution, setAberration, updateNoirGradePass, type NoirGradePass } from './NoirGradePass';
import { Atmosphere } from './Atmosphere';
import { createSeededRandom } from '../utils/random';

export interface WorldBuildResult {
  village: CheomaVillageHandle;
  env: CheomaEnvHandle;
  post: CheomaPostHandle;
}

// Horror grade: night sinks well below the cheoma default so braziers and
// glowing eyes carry the frame; dawn recovers toward a cold relief.
// Compact night runs brighter: without the IBL envmap (a measured mobile
// cost) the ink look reads as a broken black screen on a phone.
const EXPOSURE_BY_PHASE: Record<'day' | 'sunset' | 'night' | 'dawn', number> = {
  day: 1.05,
  sunset: 1.0,
  night: 0.85,
  dawn: 0.97,
};
const EXPOSURE_BY_PHASE_COMPACT: Record<'day' | 'sunset' | 'night' | 'dawn', number> = {
  day: 1.05,
  sunset: 1.0,
  night: 1.38,
  dawn: 1.05,
};

export interface WorldQueries {
  heightAt(x: number, z: number): number;
  inStream(x: number, z: number): boolean;
  streamHalfWidth(): number;
  villageRadius(): number;
  obstacleRects(): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
  randomRoadPoint(rng: () => number): THREE.Vector3;
  /** Pure-data 한양 성곽 contour, when the village generated one. */
  cityWallSpec(): import('@cheoma/api/village.js').CheomaCityWallSpec | null;
  /** 궁궐 feature center, when the village generated a palace. */
  palaceCenter(): { x: number; z: number } | null;
}

/**
 * Wire the game onto the cheoma procedural Joseon village generator:
 * one shared three instance, village terrain as the playfield, cheoma
 * atmosphere/post pipeline for the day-dusk-night-dawn cycle.
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly renderer: THREE.WebGLRenderer;

  private village: CheomaVillageHandle | null = null;
  private env: CheomaEnvHandle | null = null;
  private post: CheomaPostHandle | null = null;
  private noirPass: NoirGradePass | null = null;
  private atmosphere: Atmosphere | null = null;
  private obstacleBoxes: THREE.Box3[] = [];
  private readonly rand = createSeededRandom(20260815);
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, private readonly compact: boolean) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // Kept alive so the death-card share can read the final frame.
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, compact ? 1.5 : 2));

    // Match cheoma's app scene recipe so env.setTime drives identical lighting.
    this.scene.background = new THREE.Color(0xcfd8e0);
    this.scene.fog = new THREE.Fog(0xcfd8e0, 60, 220);

    this.sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
    this.sun.position.set(30, 42, 26);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(compact ? 2048 : 4096, compact ? 2048 : 4096);
    this.sun.shadow.camera.left = -60;
    this.sun.shadow.camera.right = 60;
    this.sun.shadow.camera.top = 60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0001;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun);

    this.hemi = new THREE.HemisphereLight(0xbdd0e4, 0x8a7a63, 0.9);
    this.scene.add(this.hemi);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);
    // The camera is in the scene graph so camera children render.
    this.scene.add(this.camera);

    // Neutral IBL: without an environment map the gatling steel, brass and
    // stone read flat gray no matter the lights. Kept dim so the noir night
    // stays inky — envmap is a rim/sheen source, not ambient lift.
    if (!compact) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.42;
      pmrem.dispose();
    }

    this.env = setupEnvironment(this.scene, {
      sun: this.sun,
      hemi: this.hemi,
      renderer: this.renderer,
      layout: { xEave: 9, zEave: 6 },
    });

    this.post = setupPost({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      msaaSamples: compact ? MSAA_SAMPLES_COMPACT : MSAA_SAMPLES_DESKTOP,
    });
    this.post.setDofAmount?.(0);

    // Sin City grade rides last, after the sRGB OutputPass: high-contrast
    // monochrome with saturated red kept, noir vignette, film grain. The
    // composer re-points renderToScreen at the final enabled pass for us.
    const composer = (this.post as { composer?: unknown }).composer as
      | { addPass?: (pass: unknown) => void }
      | undefined;
    if (composer && typeof composer.addPass === 'function') {
      this.noirPass = createNoirGradePass();
      composer.addPass(this.noirPass);
      setNoirGradeResolution(this.noirPass, canvas.clientWidth || 1280, canvas.clientHeight || 720);
    }
  }

  async build(onProgress: (label: string) => void, seed: number, signal?: AbortSignal): Promise<void> {
    const village = await createVillageAsync(
      {
        seed,
        siteR: 213,
        stream: true,
        river: false,
        cityWall: true,
        sijeon: false,
        char01: 0.5,
      },
      { onStep: onProgress, signal },
    );
    if (this.disposed) {
      village.dispose();
      return;
    }
    this.village = village;
    village.enterVillageMode({ scene: this.scene, env: this.env });
    village.setTime('day', { immediate: true });

    this.obstacleBoxes = [];
    for (const proxy of village.getPickProxies()) {
      if (proxy.bbox) this.obstacleBoxes.push(proxy.bbox.clone());
    }

    // Filmic density: embers, ash, mist and the moon (rebuilt per village
    // so mist sheets sit on the new terrain).
    this.atmosphere?.dispose();
    this.atmosphere = new Atmosphere(this.scene, this.queries(), this.compact);
  }

  reroll(seed: number, onProgress: (label: string) => void): Promise<void> {
    const previous = this.village;
    this.village = null;
    this.obstacleBoxes = [];
    return this.build(onProgress, seed).then(() => {
      previous?.dispose();
    });
  }

  get ready(): boolean {
    return this.village !== null;
  }

  get villageSeed(): number {
    return typeof this.village?.plan?.opts?.seed === 'number' ? (this.village.plan.opts.seed as number) : 0;
  }

  queries(): WorldQueries {
    const site = this.village?.plan?.site;
    const heightAt = (x: number, z: number): number =>
      Number.isFinite(site?.heightAt?.(x, z)) ? (site!.heightAt!(x, z) as number) : 0;
    const streamZat = site?.streamZat;
    const radius = typeof site?.R === 'number' ? site.R : 105;
    const rects = this.obstacleBoxes.map((box) => ({
      minX: box.min.x,
      maxX: box.max.x,
      minZ: box.min.z,
      maxZ: box.max.z,
    }));
    const world = this;
    return {
      heightAt,
      inStream: (x: number, z: number) => {
        if (typeof streamZat !== 'function') return false;
        return Math.abs(z - (streamZat as (v: number) => number)(x)) < 4;
      },
      streamHalfWidth: () => 4,
      villageRadius: () => radius,
      cityWallSpec: () => {
        const spec = this.village?.plan?.features?.cityWall;
        return spec ?? null;
      },
      palaceCenter: () => {
        const palace = this.village?.plan?.features?.palace;
        return palace && Number.isFinite(palace.x) && Number.isFinite(palace.z)
          ? { x: palace.x, z: palace.z }
          : null;
      },
      obstacleRects: () => rects,
      randomRoadPoint: (rng: () => number): THREE.Vector3 => {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const angle = rng() * Math.PI * 2;
          const dist = 8 + rng() * Math.min(46, radius * 0.55);
          const x = Math.cos(angle) * dist;
          const z = Math.sin(angle) * dist;
          if (world.pointBlocked(x, z, 1.4)) continue;
          return new THREE.Vector3(x, heightAt(x, z), z);
        }
        return new THREE.Vector3(0, heightAt(0, 0), 0);
      },
    };
  }

  pointBlocked(x: number, z: number, pad: number): boolean {
    for (const box of this.obstacleBoxes) {
      if (
        x > box.min.x - pad && x < box.max.x + pad &&
        z > box.min.z - pad && z < box.max.z + pad &&
        box.max.y - box.min.y > 1.2
      ) {
        return true;
      }
    }
    return false;
  }

  /** Remove building footprints near a point — the palace heart firing lane. */
  clearObstaclesNear(x: number, z: number, radius: number): void {
    const rSq = radius * radius;
    this.obstacleBoxes = this.obstacleBoxes.filter((box) => {
      const cx = Math.max(box.min.x, Math.min(x, box.max.x));
      const cz = Math.max(box.min.z, Math.min(z, box.max.z));
      const dx = cx - x;
      const dz = cz - z;
      return dx * dx + dz * dz > rSq;
    });
  }

  /** Building boxes whose footprint reaches within `radius` of a point. */
  obstaclesNear(x: number, z: number, radius: number): THREE.Box3[] {
    const rSq = radius * radius;
    return this.obstacleBoxes.filter((box) => {
      const cx = Math.max(box.min.x, Math.min(x, box.max.x));
      const cz = Math.max(box.min.z, Math.min(z, box.max.z));
      const dx = cx - x;
      const dz = cz - z;
      return dx * dx + dz * dz <= rSq;
    });
  }

  /** Demolition: hide pick proxies near a blast. Merged statics are shared
   *  by many proxies — only meshes this blast owns exclusively go dark. */
  hideProxiesNear(x: number, z: number, radius: number): void {
    const village = this.village;
    if (!village?.getPickProxies) return;
    const proxies = village.getPickProxies();
    const shared = new Map<THREE.Object3D, number>();
    for (const proxy of proxies) {
      if (proxy.mesh) shared.set(proxy.mesh, (shared.get(proxy.mesh) ?? 0) + 1);
    }
    const rSq = radius * radius;
    for (const proxy of proxies) {
      if (!proxy.mesh || (shared.get(proxy.mesh) ?? 0) > 1) continue;
      const c = proxy.worldCenter ?? proxy.bbox.getCenter(new THREE.Vector3());
      const dx = c.x - x;
      const dz = c.z - z;
      if (dx * dx + dz * dz <= rSq) proxy.mesh.visible = false;
    }
  }

  /** Push a circular body out of building footprints; returns true when moved. */
  resolveCollisions(position: THREE.Vector3, radius: number): boolean {
    let moved = false;
    for (const box of this.obstacleBoxes) {
      if (box.max.y - box.min.y < 1.2) continue;
      const minX = box.min.x - radius;
      const maxX = box.max.x + radius;
      const minZ = box.min.z - radius;
      const maxZ = box.max.z + radius;
      if (position.x <= minX || position.x >= maxX || position.z <= minZ || position.z >= maxZ) continue;
      const pushLeft = position.x - minX;
      const pushRight = maxX - position.x;
      const pushBack = position.z - minZ;
      const pushForward = maxZ - position.z;
      const smallest = Math.min(pushLeft, pushRight, pushBack, pushForward);
      if (smallest === pushLeft) position.x = minX;
      else if (smallest === pushRight) position.x = maxX;
      else if (smallest === pushBack) position.z = minZ;
      else position.z = maxZ;
      moved = true;
    }
    return moved;
  }

  setTimeOfDay(name: 'day' | 'sunset' | 'night' | 'dawn', opts?: { immediate?: boolean }): void {
    this.env?.setTime(name, opts);
    this.post?.setTime(name, opts);
    this.village?.setTime(name, opts);
    this.targetExposure = (this.compact ? EXPOSURE_BY_PHASE_COMPACT : EXPOSURE_BY_PHASE)[name];
    // Permanent-night siege: capture the env's own night atmosphere once and
    // pin it against later crossfade drift (title flyovers, wave banners).
    if (name === 'night') this.nightAtmosphere ??= this.captureAtmosphere();
    else this.nightAtmosphere = null;
    if (opts?.immediate) {
      this.renderer.toneMappingExposure = this.targetExposure;
    }
  }

  private nightAtmosphere: {
    fogColor: THREE.Color;
    fogNear: number;
    fogFar: number;
    background: THREE.Color;
  } | null = null;

  // Siege night lighting: noir grade wants a deeper murk with harder
  // falloff so torches, tracers and eyes carve silhouettes out of black —
  // but the kill yard stays a step above pitch so bodies and gibs read.
  private applyNightLighting(): void {
    this.sun.color.setHex(0x9aa2b4);
    this.hemi.color.setHex(0x27303f);
    this.hemi.groundColor.setHex(0x11151d);
    if (this.compact) {
      // Compact ships without the IBL envmap (a measured 15fps mobile cost),
      // which left the stone gate and road ~10× darker than desktop at night.
      // Re-cover that fill with direct light instead — same light count.
      this.sun.intensity = 0.95;
      this.hemi.intensity = 0.62;
    } else {
      this.sun.intensity = 0.58;
      this.hemi.intensity = 0.33;
    }
  }

  private captureAtmosphere(): {
    fogColor: THREE.Color;
    fogNear: number;
    fogFar: number;
    background: THREE.Color;
  } | null {
    const fog = this.scene.fog;
    if (!(fog instanceof THREE.Fog)) return null;
    // Denser than cheoma's aerial-tourism night (near 70 / far 420): the
    // siege is a ground-level FPS where the river must emerge from murk.
    // Neutral-dark so the noir grade reads pure gray, not blue.
    return {
      fogColor: new THREE.Color(0x171a21),
      fogNear: 24,
      fogFar: 185,
      background: new THREE.Color(0x0d0f15),
    };
  }

  private targetExposure = 1.05;

  update(delta: number): void {
    this.env?.update?.(delta);
    this.post?.update?.(delta);
    if (this.noirPass) updateNoirGradePass(this.noirPass, delta);
    this.atmosphere?.update(delta);
    // Village LOD + water/critter animation follow the bunker as the view target.
    this.village?.update(delta);
    this.village?.updateLod?.(this.camera, this.cameraFocusTarget, delta);
    // cheoma's atmosphere crossfade writes its own exposure each fade tick
    // (night profile ships 1.24 for tourism readability); the horror grade
    // re-asserts itself every frame after the env has had its say.
    this.renderer.toneMappingExposure = this.targetExposure;
    // Same re-assertion for the sky/fog the env crossfade left mid-flight:
    // the siege runs a permanent night, so pin the atmospheric values every
    // frame after the env tick instead of only at phase transitions.
    if (this.nightAtmosphere && this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(this.nightAtmosphere.fogColor);
      this.scene.fog.near = this.nightAtmosphere.fogNear;
      this.scene.fog.far = this.nightAtmosphere.fogFar;
      this.scene.background = this.nightAtmosphere.background;
      this.applyNightLighting();
    }
  }

  private readonly cameraFocusTarget = new THREE.Vector3();

  setFocusTarget(target: THREE.Vector3): void {
    this.cameraFocusTarget.copy(target);
  }

  /** Spike the noir grade's chromatic kick (kills, booms, slow-mo). */
  impactAberration(amount: number): void {
    if (this.noirPass) setAberration(this.noirPass, amount);
  }

  /** Blood Night intensity (0-1): the gate is failing — drown the world. */
  setBloodNight(value: number): void {
    if (this.noirPass) this.noirPass.uniforms.uBloodNight.value = Math.max(0, Math.min(1.1, value));
  }

  resize(width: number, height: number): void {
    if (width < 1 || height < 1) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.post?.setSize(width, height);
    if (this.noirPass) {
      const dpr = this.renderer.getPixelRatio();
      setNoirGradeResolution(this.noirPass, Math.round(width * dpr), Math.round(height * dpr));
    }
  }

  /** Composer-chain state for QA probes: which passes run, in what order. */
  postDiagnostics(): Record<string, unknown> {
    const composer = (this.post as { composer?: { passes?: Array<{ enabled?: boolean; constructor?: { name?: string } }> } })
      ?.composer;
    if (!composer?.passes) return { composer: false };
    return {
      composer: true,
      passes: composer.passes.map((p) => ({
        name: p.constructor?.name ?? '?',
        enabled: p.enabled !== false,
        isNoir: p === this.noirPass,
      })),
      noir: this.noirPass
        ? {
            enabled: this.noirPass.enabled !== false,
            resolution: this.noirPass.uniforms.uResolution?.value
              ? Array.from(this.noirPass.uniforms.uResolution.value as ArrayLike<number>)
              : null,
          }
        : null,
    };
  }

  render(): void {
    // renderer.info only reflects the last internal pass of a composer chain;
    // manual reset+read across the whole frame gives honest call/triangle counts.
    if (this.post) {
      this.renderer.info.autoReset = false;
      this.renderer.info.reset();
      this.post.composer.render();
      this.renderer.info.autoReset = true;
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  nextRandom(): number {
    return this.rand();
  }

  dispose(): void {
    this.disposed = true;
    this.village?.dispose();
    this.post?.dispose?.();
    this.noirPass?.dispose();
    this.atmosphere?.dispose();
    this.env?.dispose?.();
    this.renderer.dispose();
  }
}

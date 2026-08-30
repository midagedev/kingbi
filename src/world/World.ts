import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createVillageAsync } from '@cheoma/api/village.js';
import { buildBuilding, disposeBuilding, PRESETS } from '@cheoma/api/building.js';
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
import { VoxelHouses, voxelizeGroup } from '../entities/VoxelHouses';
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
  night: 1.62,
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
  /** The four destructible yard houses — rendered as chewable voxel cubes
   *  (see VoxelHouses); the record here is the collision footprint. */
  private houses: Array<{ x: number; z: number; box: THREE.Box3 }> = [];
  private voxelHouses: VoxelHouses | null = null;
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
    // stone read flat gray no matter the lights. BUT the envmap also lays a
    // diffuse ambient FLOOR over every standard material — at the original
    // 0.42 that floor washed the whole night scene to paper-white (lum 198
    // vs true-night 12; mobile ships without the envmap and sits at 79).
    // 0.16 keeps a sheen hint and lands the desktop on the compact night
    // reference. envmap = rim/sheen source, never ambient lift.
    if (!compact) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.16;
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
        // Capital tier (R>=260) is what actually spawns the palace. No
        // city wall, no temple, no village houses — the palace, the mountain
        // and four destructible yard houses carry the whole stage.
        siteR: 270,
        stream: true,
        river: false,
        cityWall: false,
        sijeon: false,
        houses: 0,
        includeTemple: false,
        includePalace: true,
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
    // The palace is MERGED GEOMETRY without pick proxies — obstacle boxes
    // never see it, which is how staging probes kept passing while palace
    // halls stood in the sightline. Measure the real mesh bounds once per
    // build; the defense staging reads the true courtyard edges from it.
    this.villageBounds = null;
    for (const child of this.scene.children) {
      if (!(child.name ?? '').startsWith('village')) continue;
      const box = new THREE.Box3().setFromObject(child);
      if (Number.isFinite(box.min.z) && box.min.z !== Infinity) this.villageBounds = box;
    }

    this.obstacleBoxes = [];
    for (const proxy of village.getPickProxies()) {
      if (proxy.bbox) this.obstacleBoxes.push(proxy.bbox.clone());
    }

    // The four yard houses are placed by Game.establishBunker AFTER it has
    // measured where the flat courtyard actually ends (seed-dependent
    // terrain) — see placeYardHouses().
    this.disposeYardHouses();
    this.atmosphere?.dispose();
    this.atmosphere = new Atmosphere(this.scene, this.queries(), this.compact);
  }

  private disposeYardHouses(): void {
    this.voxelHouses?.dispose();
    this.voxelHouses = null;
    this.obstacleBoxes = this.obstacleBoxes.filter((box) =>
      !this.houses.some((house) => house.box === box));
    this.houses = [];
  }

  /** Run restart: all cubes back in place, footprints whole. */
  resetYardHouses(): void {
    this.voxelHouses?.reset();
    this.obstacleBoxes = this.houses.map((house) => house.box.clone());
  }

  /** The destructible yard houses flanking the firing lane — placed
   *  relative to the DEFENSE point (measured flat ground), never a fixed
   *  palace offset: the old fixed -78 put the gun on the 배산 slope and hid
   *  the houses behind the ridge on half the seeds. Each finished builder
   *  group is OFFLINE-voxelized into chewable cubes (one InstancedMesh for
   *  the whole street — the gatling erodes them hole by hole; see
   *  VoxelHouses). */
  placeYardHouses(cx: number, cz: number, seed: number): void {
    this.disposeYardHouses();
    const site = this.village?.plan.site;
    if (!site) return;
    // A WIDE street for the single portrait composition: a 3-bay giwa is
    // 14-17m across (podium + eaves), so near pairs stand at ±19 (inner
    // wall ≥11m out — inside the portrait lens edge, OUT of the lane),
    // far pairs at ±21. Near pairs face the lane dead-on (rot 0 — no
    // corner swing into the sightline); the far pair's half-diagonal
    // (~12m) still clears the lane by 2m+.
    const specs = [
      { style: 'giwa' as const, dx: -19, dz: -10, rot: 0 },
      { style: 'choga' as const, dx: 19, dz: -12, rot: 0 },
      { style: 'choga' as const, dx: -21, dz: -16, rot: 2.6 },
      { style: 'giwa' as const, dx: 21, dz: -18, rot: -2.6 },
    ];
    // Compact runs a coarser grid — fewer cubes on a phone.
    const size = this.compact ? 0.52 : 0.42;
    const jitterRng = createSeededRandom((seed ^ 0x7ee1) >>> 0);
    // Shared palettes per style (cheoma's own material sharing).
    const palettes = new Map<string, unknown>();
    const results: Array<{ x: number; z: number; data: ReturnType<typeof voxelizeGroup> }> = [];
    for (const spec of specs) {
      const source = buildBuilding({
        ...PRESETS[spec.style],
        seed: (seed ^ (0x9e37 + spec.dx)) >>> 0,
        ...(palettes.get(spec.style) ? { mats: palettes.get(spec.style) } : {}),
      });
      palettes.set(spec.style, (source as unknown as { userData: { materials?: unknown } }).userData.materials);
      const x = cx + spec.dx;
      const z = cz + spec.dz;
      source.position.set(x, Number(site.heightAt?.(x, z) ?? 0), z);
      source.rotation.y = spec.rot;
      const data = voxelizeGroup(source, size, jitterRng);
      results.push({ x, z, data });
      disposeBuilding(source);
    }
    const total = results.reduce((sum, r) => sum + (r.data ? r.data.sx.length : 0), 0);
    if (total === 0) return;
    this.voxelHouses = new VoxelHouses(this.scene, total);
    for (const result of results) {
      if (!result.data) continue;
      const index = this.voxelHouses.addHouse(result.data, size);
      if (index < 0) break;
      this.houses.push({ x: result.x, z: result.z, box: result.data.box });
      this.obstacleBoxes.push(result.data.box.clone());
    }
  }

  voxelHouseManager(): VoxelHouses | null {
    return this.voxelHouses;
  }

  /** Collapse tick — drives the pancake animation, dusts landings. */
  updateVoxelHouses(delta: number, onLand: (x: number, y: number, z: number) => void): void {
    this.voxelHouses?.update(delta, onLand);
  }

  /** House footprints within `radius` of a point (blast queries). */
  houseIndicesNear(x: number, z: number, radius: number): number[] {
    const rSq = radius * radius;
    const out: number[] = [];
    this.houses.forEach((house, index) => {
      if (this.voxelHouses?.isCollapsed(index)) return;
      const cx = Math.max(house.box.min.x, Math.min(x, house.box.max.x));
      const cz = Math.max(house.box.min.z, Math.min(z, house.box.max.z));
      const dx = cx - x;
      const dz = cz - z;
      if (dx * dx + dz * dz <= rSq) out.push(index);
    });
    return out;
  }

  /** 2D ray vs house footprints — the gatling's chew target. */
  houseHitTest(ox: number, oz: number, dx: number, dz: number, maxDist: number): { index: number; dist: number; x: number; z: number } | null {
    let best: { index: number; dist: number; x: number; z: number } | null = null;
    this.houses.forEach((house, index) => {
      if (this.voxelHouses?.isCollapsed(index)) return;
      const box = house.box;
      const tx1 = (box.min.x - ox) / dx;
      const tx2 = (box.max.x - ox) / dx;
      const tz1 = (box.min.z - oz) / dz;
      const tz2 = (box.max.z - oz) / dz;
      const tmin = Math.max(Math.min(tx1, tx2), Math.min(tz1, tz2));
      const tmax = Math.min(Math.max(tx1, tx2), Math.max(tz1, tz2));
      if (tmax < Math.max(tmin, 0.5) || tmin > maxDist) return;
      const t = Math.max(tmin, 0.5);
      if (!best || t < best.dist) {
        best = { index, dist: t, x: ox + dx * t, z: oz + dz * t };
      }
    });
    return best;
  }

  /** Stage probe: where the yard houses actually landed (QA/vision rigs). */
  yardHouses(): Array<{ x: number; z: number; visible: boolean; alive: number }> {
    return this.houses.map((house, index) => ({
      x: +house.x.toFixed(1),
      z: +house.z.toFixed(1),
      visible: !this.voxelHouses?.isCollapsed(index),
      alive: this.voxelHouses ? +this.voxelHouses.aliveRatio(index).toFixed(2) : 1,
    }));
  }

  /** Draw census by top-level scene ancestor — the "what is eating the
   *  frame" probe (QA only; walks the graph once on demand). */
  sceneCensus(): Array<{ root: string; meshes: number; visible: number; tris: number }> {
    const buckets = new Map<string, { meshes: number; visible: number; tris: number }>();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!(mesh as THREE.Mesh).isMesh) return;
      let root = object;
      while (root.parent && root.parent !== this.scene) root = root.parent;
      const key = root.name || '(anonymous)';
      const geo = mesh.geometry as THREE.BufferGeometry | undefined;
      const tris = geo?.attributes?.position
        ? ((geo.attributes.position.count * (geo.index ? 1 : 1 / 3)) / (geo.index ? 3 : 1)) | 0
        : 0;
      const bucket = buckets.get(key) ?? { meshes: 0, visible: 0, tris: 0 };
      bucket.meshes += 1;
      if (mesh.visible) bucket.visible += 1;
      bucket.tris += tris;
      buckets.set(key, bucket);
    });
    return [...buckets.entries()]
      .map(([root, b]) => ({ root, ...b }))
      .sort((a, b) => b.tris - a.tris);
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
    // 새벽 장 — the dawn ceremony pins its own golden air (and warms the
    // kingbi lights); the noir pass eases its wash via dawnMixTarget.
    if (name === 'dawn') {
      this.dawnAtmosphere ??= this.captureDawnAtmosphere();
      this.applyDawnLighting();
    } else {
      this.dawnAtmosphere = null;
    }
    this.dawnMixTarget = name === 'dawn' ? 1 : 0;
    if (opts?.immediate) {
      this.renderer.toneMappingExposure = this.targetExposure;
      if (this.noirPass) this.noirPass.uniforms.uDawn.value = this.dawnMixTarget;
    }
  }

  private dawnAtmosphere: {
    fogColor: THREE.Color;
    fogNear: number;
    fogFar: number;
    background: THREE.Color;
  } | null = null;
  /** Noir pass dawn wash target — eases in/out with the ceremony. */
  private dawnMixTarget = 0;

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
      this.sun.intensity = 1.3;
      this.hemi.intensity = 0.9;
    } else {
      this.sun.intensity = 0.58;
      this.hemi.intensity = 0.33;
    }
  }

  /** 새벽 장 lighting — low gold sun, warm bounce: the yard the painting
   *  was worth. Called from setTimeOfDay('dawn'); night re-pins its own. */
  private applyDawnLighting(): void {
    this.sun.color.setHex(0xffd9a4);
    this.sun.intensity = 1.35;
    this.hemi.color.setHex(0xd8c39a);
    this.hemi.groundColor.setHex(0x5a4a38);
    this.hemi.intensity = 0.5;
  }

  private captureDawnAtmosphere(): {
    fogColor: THREE.Color;
    fogNear: number;
    fogFar: number;
    background: THREE.Color;
  } | null {
    if (!(this.scene.fog instanceof THREE.Fog)) return null;
    // First light: warm haze the horde river dissolves into — the ceremoney
    // air. Gold enough to read instantly against the permanent-night ink.
    return {
      fogColor: new THREE.Color(0x9a8562),
      fogNear: 40,
      fogFar: 260,
      background: new THREE.Color(0xc9b389),
    };
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
    if (this.noirPass) {
      updateNoirGradePass(this.noirPass, delta);
      // 새벽 장 wash eases toward the phase target (~0.9s ramp either way).
      const dawn = this.noirPass.uniforms.uDawn;
      dawn.value += (this.dawnMixTarget - dawn.value) * Math.min(1, delta * 1.1);
    }
    this.atmosphere?.update(delta);
    // Village LOD + water/critter animation follow the bunker as the view target.
    this.village?.update(delta);
    // 청크 LOD의 뷰어는 '전장'이다: the quarter-view camera hovers over the
    // palace south of the gun, and a distance-based LOD keyed on the real
    // camera loads the whole palace at FULL detail (+533 draws, 46fps).
    // Feed updateLod a proxy anchored on the defense point — detail lands
    // around the action; the render frustum still uses the real camera.
    if (this.village?.updateLod) {
      this.lodCamera ??= new THREE.PerspectiveCamera();
      const proxy = this.lodCamera;
      proxy.fov = this.camera.fov;
      proxy.aspect = this.camera.aspect;
      proxy.near = this.camera.near;
      proxy.far = this.camera.far;
      proxy.updateProjectionMatrix();
      proxy.position.copy(this.cameraFocusTarget);
      proxy.quaternion.copy(this.camera.quaternion);
      proxy.updateMatrixWorld();
      this.village.updateLod(proxy, this.cameraFocusTarget, delta);
    }
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
    } else if (this.dawnAtmosphere && this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(this.dawnAtmosphere.fogColor);
      this.scene.fog.near = this.dawnAtmosphere.fogNear;
      this.scene.fog.far = this.dawnAtmosphere.fogFar;
      this.scene.background = this.dawnAtmosphere.background;
      this.applyDawnLighting();
    }
  }

  private readonly cameraFocusTarget = new THREE.Vector3();
  /** LOD viewer proxy anchored on the defense point (see update()). */
  private lodCamera: THREE.PerspectiveCamera | null = null;
  /** True mesh bounds of the village/palace group (proxy-blind geometry). */
  private villageBounds: THREE.Box3 | null = null;

  /** The palace's real north edge + roof line — the staging ground truth. */
  palaceBounds(): { northZ: number; southZ: number; roofY: number } | null {
    return this.villageBounds
      ? {
          northZ: this.villageBounds.min.z,
          southZ: this.villageBounds.max.z,
          roofY: this.villageBounds.max.y,
        }
      : null;
  }

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
      exposure: this.renderer.toneMappingExposure,
      envIntensity: this.scene.environmentIntensity,
      hasEnv: this.scene.environment !== null,
      fog: this.scene.fog instanceof THREE.Fog
        ? {
            color: '#' + this.scene.fog.color.getHexString(),
            near: +this.scene.fog.near.toFixed(1),
            far: +this.scene.fog.far.toFixed(1),
          }
        : null,
      noir: this.noirPass
        ? {
            enabled: this.noirPass.enabled !== false,
            dawn: this.noirPass.uniforms.uDawn?.value ?? null,
            bloodNight: this.noirPass.uniforms.uBloodNight?.value ?? null,
            resolution: this.noirPass.uniforms.uResolution?.value
              ? Array.from(this.noirPass.uniforms.uResolution.value as ArrayLike<number>)
              : null,
          }
        : null,
    };
  }

  /** QA: scale the desktop IBL envmap contribution (0 = off) — wash probes. */
  setEnvIntensity(value: number): void {
    this.scene.environmentIntensity = value;
  }

  /** QA: toggle a composer pass by constructor name (WebKit debugging). */
  setPostPassEnabled(name: string, enabled: boolean): boolean {
    const composer = (this.post as { composer?: { passes?: Array<{ enabled?: boolean; constructor?: { name?: string } }> } })
      ?.composer;
    if (!composer?.passes) return false;
    let hit = false;
    for (const pass of composer.passes) {
      if ((pass.constructor?.name ?? '') === name) {
        pass.enabled = enabled;
        hit = true;
      }
    }
    return hit;
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

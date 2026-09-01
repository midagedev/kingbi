import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WorldQueries } from '../world/World';

export type ZombiePhase = 'day' | 'sunset' | 'night' | 'dawn';

/** Horde variants — each is a clip moment. */
export type ZombieType = 'normal' | 'runner' | 'brute' | 'bloater' | 'shield';

/** Per-wave special quotas consumed by trickle spawns (front-loaded). */
export interface WaveMix {
  brute: number;
  bloater: number;
  shield: number;
  runner: number;
}

export interface ZombieEvent {
  onKill: (position: THREE.Vector3, elite: boolean, dirX: number, dirZ: number, type: ZombieType) => void;
  onGroan: (position: THREE.Vector3) => void;
  onRise: (position: THREE.Vector3) => void;
  /** Bloater detonation (player-killed or suicide at the wall). */
  onBoom: (x: number, z: number) => void;
  /** Spawn announcement (brute entrance). */
  onSpawnType: (type: ZombieType, x: number, z: number) => void;
}

/** Wall collision surface the horde respects (the palace fortress). */
export interface FortressCollider {
  resolveBody(body: { x: number; z: number }, radius: number): boolean;
}

interface Zombie {
  active: boolean;
  state: 'dormant' | 'rising' | 'chase' | 'drown' | 'frozen' | 'dying';
  type: ZombieType;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  /** Shieldbearer door-plating: soaks hits before flesh. */
  armor: number;
  elite: boolean;
  speed: number;
  phase: number;
  stateTime: number;
  attackCooldown: number;
  vx: number;
  vz: number;
  /** Ballistic send-off state for exaggeration physics. */
  vy: number;
  airY: number;
  tumble: number;
  tumbleRate: number;
  sink: number;
  twitch: number;
  stagger: number;
  clawing: boolean;
}

const CAP_COLOR = new THREE.Color();

/**
 * The 원귀 horde: one InstancedMesh for bodies, one for glowing eyes.
 * Flocking = seek + separation (spatial hash) + building slide.
 */
export class Horde {
  /** Jointed puppet: torso root + articulated limbs, one instanced draw each. */
  readonly torsoMesh: THREE.InstancedMesh;
  readonly armLMesh: THREE.InstancedMesh;
  readonly armRMesh: THREE.InstancedMesh;
  readonly legLMesh: THREE.InstancedMesh;
  readonly legRMesh: THREE.InstancedMesh;
  private readonly bodyParts: THREE.InstancedMesh[];
  readonly eyeMesh: THREE.InstancedMesh;
  readonly shieldMesh: THREE.InstancedMesh;
  /** Neon demon collar — the idol-demon glow signature. */
  readonly collarMesh: THREE.InstancedMesh;
  /** Brute fists — wrecking-ball hands at the claw tips. */
  readonly fistMesh: THREE.InstancedMesh;
  /** Bloater pustules — magenta glow cluster on the belly. */
  readonly tumorMesh: THREE.InstancedMesh;

  private readonly zombies: Zombie[] = [];
  /** Optional spawn announcer (Game wires the roar + banner). */
  onSpawn: ((type: ZombieType, x: number, z: number) => void) | null = null;
  private mix: WaveMix = { brute: 0, bloater: 0, shield: 0, runner: 0 };
  private readonly booms: Array<{ x: number; z: number }> = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scaleV = new THREE.Vector3();
  private readonly posV = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly hash = new Map<number, number[]>();
  /** Per-body soiling tints: light desaturated so vertex identity survives
   *  the multiply (dark tints here would erase the pale heads again). */
  private readonly palette = [0xd8cfbd, 0xcfc4ae, 0xd4c8b4, 0xc6bda9, 0xc9c3b6, 0xd0c0a8];
  private readonly elitePalette = 0xeadfda;

  /** Multiply a fabric/weave texture into every body part (grime pass). */
  setBodyTexture(texture: THREE.Texture): void {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);
    texture.colorSpace = THREE.SRGBColorSpace;
    for (const part of this.bodyParts) {
      const material = part.material as THREE.MeshStandardMaterial;
      material.map = texture;
      material.needsUpdate = true;
    }
  }
  private eyeGlow = 0;
  private phaseFrozen = false;

  constructor(
    scene: THREE.Scene,
    private queries: WorldQueries,
    capacity: number,
    private readonly rng: () => number,
  ) {
    // Shared authored material: vertexColors carries the bone-pale skin /
    // violet stage-wear / seal-red blood identity; instanceColor multiplies
    // per-body soiling. One material → one compiled program across parts.
    const bodyMat = new THREE.MeshStandardMaterial({
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
    });
    // Faint cold rim on every body (cookbook fresnel): at night the horde
    // silhouettes against its own shadow — the rim is what makes the front
    // rank read as bodies instead of a dark mass, at zero light cost.
    bodyMat.onBeforeCompile = (shader) => {
      shader.uniforms.uRimColor = { value: new THREE.Color(0x9fb2c8) };
      shader.uniforms.uRimStrength = { value: 0.42 };
      shader.fragmentShader =
        'uniform vec3 uRimColor;\nuniform float uRimStrength;\n' +
        shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float fres = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
           totalEmissiveRadiance += uRimColor * fres * uRimStrength;`,
        );
    };
    bodyMat.customProgramCacheKey = () => 'horde-fresnel-rim';

    const makePart = (geometry: THREE.BufferGeometry, name: string) => {
      const mesh = new THREE.InstancedMesh(geometry, bodyMat, capacity);
      // No moon-map casting: dynamic casters would force per-frame map
      // re-renders, and real per-light lantern spots cost ~3fps each in
      // stress overdraw (measured). Zombie shadows ride the streak system.
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = name;
      scene.add(mesh);
      return mesh;
    };
    this.torsoMesh = makePart(this.buildTorsoGeometry(), 'horde-torso');
    this.armLMesh = makePart(this.buildArmGeometry(1), 'horde-arm-l');
    this.armRMesh = makePart(this.buildArmGeometry(-1), 'horde-arm-r');
    this.legLMesh = makePart(this.buildLegGeometry(), 'horde-leg-l');
    this.legRMesh = makePart(this.buildLegGeometry(), 'horde-leg-r');
    this.bodyParts = [this.torsoMesh, this.armLMesh, this.armRMesh, this.legLMesh, this.legRMesh];

    const eyeGeo = new THREE.SphereGeometry(0.04, 6, 5);
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(0xff1e4e),
      emissiveIntensity: 0,
      roughness: 0.3,
      toneMapped: false,
    });
    this.eyeMesh = new THREE.InstancedMesh(eyeGeo, eyeMat, capacity * 2);
    this.eyeMesh.frustumCulled = false;
    this.eyeMesh.count = 0;
    this.eyeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.eyeMesh.name = 'horde-eyes';
    scene.add(this.eyeMesh);

    // Demon collar: hot-magenta unlit octahedron at the chest — pulses like
    // a stage necklace and survives the ink grade as neon.
    const collarGeo = new THREE.OctahedronGeometry(0.085, 0);
    const collarMat = new THREE.MeshBasicMaterial({
      color: 0xff2fb0,
      toneMapped: false,
    });
    this.collarMesh = new THREE.InstancedMesh(collarGeo, collarMat, capacity);
    this.collarMesh.frustumCulled = false;
    this.collarMesh.count = 0;
    this.collarMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.collarMesh.name = 'horde-collars';
    scene.add(this.collarMesh);

    // Shieldbearers carry a torn-off door plank — one instanced draw.
    const shieldGeo = new THREE.BoxGeometry(0.72, 1.05, 0.09);
    const shieldMat = new THREE.MeshStandardMaterial({ color: 0x6a523c, roughness: 0.85 });
    this.shieldMesh = new THREE.InstancedMesh(shieldGeo, shieldMat, Math.min(96, capacity));
    this.shieldMesh.castShadow = false;
    this.shieldMesh.frustumCulled = false;
    this.shieldMesh.count = 0;
    this.shieldMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shieldMesh.name = 'horde-shields';
    scene.add(this.shieldMesh);

    // Brute fists: pale wrecking balls riding the arm tips (per-type, so a
    // separate instanced draw like the shield plank).
    const fistGeo = new THREE.IcosahedronGeometry(0.12, 0);
    const fistMat = new THREE.MeshStandardMaterial({
      color: 0xd8d2c2,
      emissive: new THREE.Color(0x2b2620),
      roughness: 0.9,
    });
    this.fistMesh = new THREE.InstancedMesh(fistGeo, fistMat, Math.min(64, capacity * 2));
    this.fistMesh.castShadow = false;
    this.fistMesh.frustumCulled = false;
    this.fistMesh.count = 0;
    this.fistMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fistMesh.name = 'horde-fists';
    scene.add(this.fistMesh);

    // Bloater pustules: hot-magenta unlit glow (survives the ink grade as
    // neon) — the walking bomb telegraph.
    const tumorMat = new THREE.MeshBasicMaterial({ color: 0xff2fb0, toneMapped: false });
    this.tumorMesh = new THREE.InstancedMesh(this.buildTumorGeometry(), tumorMat, Math.min(96, capacity));
    this.tumorMesh.frustumCulled = false;
    this.tumorMesh.count = 0;
    this.tumorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tumorMesh.name = 'horde-tumors';
    scene.add(this.tumorMesh);

    for (let i = 0; i < capacity; i += 1) {
      this.zombies.push({
        active: false,
        state: 'dormant',
        type: 'normal',
        x: 0,
        z: 0,
        yaw: 0,
        hp: 1,
        armor: 0,
        elite: false,
        speed: 1,
        phase: 0,
        stateTime: 0,
        attackCooldown: 0,
        vx: 0,
        vz: 0,
        vy: 0,
        airY: 0,
        tumble: 0,
        tumbleRate: 0,
        sink: 0,
        twitch: 0,
        stagger: 0,
        clawing: false,
      });
      this.bodyParts.forEach((part) => part.setColorAt(i, CAP_COLOR.setHex(0xffffff)));
    }
    for (const part of this.bodyParts) {
      if (part.instanceColor) part.instanceColor.needsUpdate = true;
    }
  }

  private partPush(
    parts: THREE.BufferGeometry[],
    geo: THREE.BufferGeometry,
    color: THREE.Color,
    cx: number, cy: number, cz: number,
  ): void {
    // mergeGeometries requires all-or-none indexed; normalize to non-indexed.
    const target = geo.index ? geo.toNonIndexed() : geo;
    if (target !== geo) geo.dispose();
    const count = target.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    target.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    target.translate(cx, cy, cz);
    parts.push(target);
  }

  private mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) throw new Error('horde part merge failed');
    return merged;
  }

  /** Torso root (torso + coat + horned head) — authored feet-origin like the
   *  old single body, so root placement math is unchanged. */
  private buildTorsoGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const skin = new THREE.Color(0xe4e6da);   // bone-pale — reads white in ink
    const cloth = new THREE.Color(0x7a7488);  // stylish violet-black stage wear
    const stain = new THREE.Color(0x6a0d10);  // seal-red blood patches
    const mawDark = new THREE.Color(0x1c070c); // unhinged mouth cavity
    const fang = new THREE.Color(0xffffff);   // always-bared bone teeth

    // Tall upright torso — idol posture, not a shambler's hunch.
    const torso = new THREE.CylinderGeometry(0.15, 0.22, 0.62, 7);
    torso.rotateX(0.14);
    this.partPush(parts, torso, cloth, 0, 0.78, 0.02);
    const torsoStain = new THREE.SphereGeometry(0.12, 7, 5);
    torsoStain.scale(1.1, 0.7, 0.55);
    this.partPush(parts, torsoStain, stain, 0, 0.74, 0.13);

    // Long fitted coat with a TORN hem — the bottom ring is shredded into
    // zigzag teeth. 9 segments × |sin(2a)| dodges the 7-seg aliasing that
    // flattened the first attempt into a straight cut.
    const skirt = new THREE.CylinderGeometry(0.2, 0.32, 0.42, 9, 1, true);
    const skirtPos = skirt.attributes.position;
    for (let i = 0; i < skirtPos.count; i += 1) {
      if (skirtPos.getY(i) < -0.1) {
        const a = Math.atan2(skirtPos.getX(i), skirtPos.getZ(i));
        skirtPos.setY(i, -0.08 - Math.abs(Math.sin(a * 2)) * 0.13);
      }
    }
    this.partPush(parts, skirt, cloth.clone().multiplyScalar(0.6), 0, 0.36, 0);
    // Loose coat strips flapping past the hem — tatters, not tailoring.
    // Lifted brighter than the coat so the rim pass catches them.
    for (const side of [-1, 1]) {
      const strip = new THREE.BoxGeometry(0.07, 0.17, 0.014);
      strip.rotateX(0.16);
      strip.rotateZ(side * 0.22);
      this.partPush(parts, strip, cloth.clone().multiplyScalar(0.85), side * 0.15, 0.16, side * 0.06);
    }

    // Horned head — the Joseon demon crown; silhouette signature.
    const head = new THREE.IcosahedronGeometry(0.105, 1);
    head.scale(0.95, 1.15, 1.0);
    this.partPush(parts, head, skin, 0, 1.2, 0.09);
    const jaw = new THREE.BoxGeometry(0.075, 0.04, 0.06);
    this.partPush(parts, jaw, skin, 0, 1.095, 0.15);
    // Unhinged maw — THE KDH focal point. Proud of the skull surface by a
    // clear margin or it z-fights into the head and vanishes.
    const mouth = new THREE.BoxGeometry(0.11, 0.07, 0.06);
    this.partPush(parts, mouth, mawDark, 0, 1.125, 0.185);
    for (const side of [-1, 1]) {
      const upFang = new THREE.ConeGeometry(0.014, 0.055, 4);
      upFang.rotateX(Math.PI);
      this.partPush(parts, upFang, fang, side * 0.036, 1.152, 0.205);
    }
    const midFang = new THREE.ConeGeometry(0.013, 0.05, 4);
    midFang.rotateX(Math.PI);
    this.partPush(parts, midFang, fang, 0, 1.156, 0.207);
    for (const side of [-1, 1]) {
      const lowFang = new THREE.ConeGeometry(0.012, 0.045, 4);
      this.partPush(parts, lowFang, fang, side * 0.016, 1.106, 0.207);
    }
    for (const side of [-1, 1]) {
      const horn = new THREE.ConeGeometry(0.034, 0.19, 5);
      horn.rotateZ(side * -0.5);
      horn.rotateX(-0.15);
      this.partPush(parts, horn, cloth, side * 0.085, 1.34, 0.02);
    }
    return this.mergeParts(parts);
  }

  /** Arm hanging from the shoulder pivot — local rotation swings the joint.
   *  KDH grammar: stick-thin but LONG, bone-pale spiky shoulder + elbow,
   *  spider claws. `side` (+1 left/-1 right) mirrors the outward barbs. */
  private buildArmGeometry(side: number): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const skin = new THREE.Color(0xe4e6da);
    const upper = new THREE.CapsuleGeometry(0.036, 0.56, 2, 5);
    // Hang below the pivot so rotation.x swings the whole limb.
    this.partPush(parts, upper, skin, 0, -0.32, 0);
    // Bone shoulder jag + elbow barb, leaning OUTWARD past the coat edge —
    // pale so they silhouette at night instead of melting into the cloth.
    const spike = new THREE.ConeGeometry(0.03, 0.15, 4);
    spike.rotateZ(-side * 0.55);
    this.partPush(parts, spike, skin.clone().multiplyScalar(0.95), side * 0.015, -0.03, 0);
    const barb = new THREE.ConeGeometry(0.018, 0.07, 4);
    barb.rotateX(Math.PI / 2 + 0.4);
    barb.rotateZ(-side * 0.25);
    this.partPush(parts, barb, skin.clone().multiplyScalar(0.9), 0, -0.44, -0.015);
    // Splayed claw pair, near-forearm length — spider hands. Full-pale so
    // they silhouette against the dark coat and night ground.
    for (const clawSide of [-1, 1]) {
      const claw = new THREE.ConeGeometry(0.032, 0.24, 4);
      claw.rotateZ(clawSide * 0.3);
      claw.rotateX(Math.PI - 0.12);
      claw.translate(clawSide * 0.034, -0.66, 0.02);
      this.partPush(parts, claw, skin, 0, 0, 0);
    }
    return this.mergeParts(parts);
  }

  /** Leg hanging from the hip pivot. Short on purpose — the ragged coat hem
   *  IS the bottom silhouette; feet kick out past it mid-stride. */
  private buildLegGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const cloth = new THREE.Color(0x7a7488).multiplyScalar(0.65);
    const bone = new THREE.Color(0xe4e6da).multiplyScalar(0.9);
    const leg = new THREE.CapsuleGeometry(0.05, 0.22, 2, 5);
    this.partPush(parts, leg, cloth, 0, -0.13, 0);
    // Bone knee spike — pale barb on the stride silhouette.
    const knee = new THREE.ConeGeometry(0.022, 0.07, 4);
    knee.rotateX(Math.PI / 2 - 0.5);
    this.partPush(parts, knee, bone, 0, -0.09, 0.045);
    // Foot wedge.
    const foot = new THREE.BoxGeometry(0.08, 0.05, 0.15);
    this.partPush(parts, foot, cloth.clone().multiplyScalar(1.2), 0, -0.26, 0.035);
    return this.mergeParts(parts);
  }

  /** Bloater pustule cluster — magenta glow under the belly skin: the
   *  "about to pop" telegraph, carried in local torso space by the root. */
  private buildTumorGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const pus = new THREE.Color(0xff44cf);
    const tumorA = new THREE.IcosahedronGeometry(0.16, 0);
    this.partPush(parts, tumorA, pus, 0.15, 0.66, 0.24);
    const tumorB = new THREE.IcosahedronGeometry(0.12, 0);
    this.partPush(parts, tumorB, pus.clone().multiplyScalar(0.8), -0.13, 0.58, 0.26);
    const tumorC = new THREE.IcosahedronGeometry(0.09, 0);
    this.partPush(parts, tumorC, pus.clone().multiplyScalar(0.6), 0.02, 0.48, 0.3);
    return this.mergeParts(parts);
  }

  get activeCount(): number {
    let count = 0;
    for (const zombie of this.zombies) if (zombie.active && zombie.state !== 'dying') count += 1;
    return count;
  }

  get dormantCount(): number {
    let count = 0;
    for (const zombie of this.zombies) if (zombie.active && zombie.state === 'dormant') count += 1;
    return count;
  }

  private acquire(): Zombie | null {
    for (const zombie of this.zombies) {
      if (!zombie.active) return zombie;
    }
    return null;
  }

  /** Scatter sleeping bodies near roads before dusk — the day-phase dread.
   *  A share huddles close to the heart so the follow cam reads the threat. */
  seedDormant(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const zombie = this.acquire();
      if (!zombie) return;
      const point = this.rng() < 0.45
        ? this.randomInnerPoint(3, 9)
        : this.queries.randomRoadPoint(this.rng);
      zombie.active = true;
      zombie.state = 'dormant';
      zombie.type = 'normal';
      zombie.armor = 0;
      zombie.x = point.x;
      zombie.z = point.z;
      zombie.yaw = this.rng() * Math.PI * 2;
      zombie.hp = 1;
      zombie.elite = false;
      zombie.speed = 0.85 + this.rng() * 0.3;
      zombie.phase = this.rng() * Math.PI * 2;
      zombie.attackCooldown = 0;
      zombie.sink = 0;
      zombie.vy = 0;
      zombie.airY = 0;
      zombie.tumbleRate = 0;
      zombie.twitch = this.rng() * 10;
      this.paint(zombie, this.zombies.indexOf(zombie));
    }
  }

  private randomInnerPoint(minR: number, maxR: number): THREE.Vector3 {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const angle = this.rng() * Math.PI * 2;
      const dist = minR + this.rng() * (maxR - minR);
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (this.queries.obstacleRects().some((rect) =>
        x > rect.minX - 1.2 && x < rect.maxX + 1.2 && z > rect.minZ - 1.2 && z < rect.maxZ + 1.2)) continue;
      return new THREE.Vector3(x, this.queries.heightAt(x, z), z);
    }
    return new THREE.Vector3(0, this.queries.heightAt(0, 0), 0);
  }

  /** Install the per-wave variant quotas (consumed by trickle spawns). */
  setWaveMix(mix: Partial<WaveMix>): void {
    this.mix = {
      brute: mix.brute ?? 0,
      bloater: mix.bloater ?? 0,
      shield: mix.shield ?? 0,
      runner: mix.runner ?? 0,
    };
  }

  /** Sequential variant pick: brutes lead the wave, runners trail. */
  private pickType(): ZombieType {
    if (this.mix.brute > 0) { this.mix.brute -= 1; return 'brute'; }
    if (this.mix.bloater > 0) { this.mix.bloater -= 1; return 'bloater'; }
    if (this.mix.shield > 0) { this.mix.shield -= 1; return 'shield'; }
    if (this.mix.runner > 0) { this.mix.runner -= 1; return 'runner'; }
    return 'normal';
  }

  /** A wave pours in from the forest ring at `angle`.
   *  `approach01` 1 = forest edge (gameplay), 0 = ~3m close press (capture hooks).
   *  `distRange` overrides both with absolute radii — the city-wall layout
   *  spawns just beyond the ring instead of scaling with villageRadius.
   *  `origin` recentres the spawn ring on the defense point (the yard is
   *  far from the village origin in the palace-mountain layout). */
  spawnWave(
    count: number,
    angle: number,
    night: number,
    eliteChance: number,
    approach01 = 1,
    mix?: Partial<WaveMix>,
    distRange?: readonly [number, number],
    origin?: { x: number; z: number },
  ): void {
    if (mix) this.setWaveMix(mix);
    const fallback = 3 + (this.queries.villageRadius() * 0.94 - 3) * Math.max(0, Math.min(1, approach01));
    const radiusMin = distRange ? distRange[0] : fallback;
    const radiusSpan = distRange ? Math.max(0.01, distRange[1] - distRange[0]) : 0.14 * fallback;
    const rects = this.queries.obstacleRects();
    for (let i = 0; i < count; i += 1) {
      const zombie = this.acquire();
      if (!zombie) return;
      // Wide rings (open field) tighten the arc so the river stays inside
      // the visible lane instead of spawning off-screen flanks.
      const spreadAmp = distRange && distRange[1] > 40 ? 0.7 : approach01 >= 0.9 ? 1.5 : approach01 >= 0.5 ? 2.6 : 0.35;
      const spread = (this.rng() - 0.5) * spreadAmp;
      const dist = radiusMin + this.rng() * radiusSpan;
      const a = angle + spread;
      const type = this.pickType();
      let zx = (origin?.x ?? 0) + Math.cos(a) * dist;
      let zz = (origin?.z ?? 0) + Math.sin(a) * dist;
      // Never materialize inside a flanking house — slide to the nearest
      // edge so the street read stays clean (bodies walk AROUND buildings).
      for (const rect of rects) {
        const pad = 1.5;
        if (zx > rect.minX - pad && zx < rect.maxX + pad && zz > rect.minZ - pad && zz < rect.maxZ + pad) {
          const pushL = zx - (rect.minX - pad);
          const pushR = rect.maxX + pad - zx;
          const pushB = zz - (rect.minZ - pad);
          const pushF = rect.maxZ + pad - zz;
          const m = Math.min(pushL, pushR, pushB, pushF);
          if (m === pushL) zx = rect.minX - pad;
          else if (m === pushR) zx = rect.maxX + pad;
          else if (m === pushB) zz = rect.minZ - pad;
          else zz = rect.maxZ + pad;
          break;
        }
      }
      zombie.x = zx;
      zombie.z = zz;
      zombie.yaw = a + Math.PI;
      zombie.active = true;
      zombie.state = 'chase';
      zombie.type = type;
      this.applyTypeStats(zombie, night, eliteChance);
      zombie.phase = this.rng() * Math.PI * 2;
      zombie.attackCooldown = this.rng();
      zombie.sink = 0;
      zombie.vy = 0;
      zombie.airY = 0;
      zombie.tumbleRate = 0;
      this.paint(zombie, this.zombies.indexOf(zombie));
      this.onSpawn?.(type, zombie.x, zombie.z);
    }
  }

  private applyTypeStats(zombie: Zombie, night: number, eliteChance = 0): void {
    zombie.armor = zombie.type === 'shield' ? 4 : 0;
    zombie.elite = false;
    switch (zombie.type) {
      case 'brute':
        // The wall-breaker: a walking siege engine that soaks a belt.
        zombie.hp = 24 + night * 3;
        zombie.speed = 0.78 + this.rng() * 0.22;
        break;
      case 'bloater':
        zombie.hp = 2;
        zombie.speed = 1.45 + this.rng() * 0.4;
        break;
      case 'shield':
        zombie.hp = 1;
        zombie.speed = 1.8 + this.rng() * 0.6;
        break;
      case 'runner':
        zombie.hp = 1;
        zombie.speed = (6.4 + this.rng() * 1.6) * (1 + night * 0.02);
        break;
      default:
        zombie.hp = night >= 3 && this.rng() < eliteChance ? 3 : 1;
        zombie.elite = zombie.hp > 1;
        zombie.speed = (zombie.elite ? 5.0 : 2.3 + this.rng() * 1.5) * (1 + night * 0.05);
        break;
    }
  }

  /** Deterministic one-per-type line, posed mid-stride in the court —
   *  the model-inspection rig for capture-model.mjs / vision review. */
  spawnLineup(types: ZombieType[], cx: number, cz: number, spacing: number, faceAngle: number, night = 4): void {
    this.clearAll();
    types.forEach((type, i) => {
      const zombie = this.acquire();
      if (!zombie) return;
      const lane = i - (types.length - 1) / 2;
      // Side-by-side across the facing direction, so every body stays in frame.
      zombie.x = cx + Math.cos(faceAngle) * lane * spacing;
      zombie.z = cz - Math.sin(faceAngle) * lane * spacing;
      zombie.yaw = faceAngle;
      zombie.active = true;
      zombie.state = 'chase';
      zombie.type = type;
      this.applyTypeStats(zombie, night);
      zombie.phase = 1.1 + i * 1.9;
      zombie.attackCooldown = 1;
      zombie.sink = 0;
      zombie.vy = 0;
      zombie.airY = 0;
      zombie.tumbleRate = 0;
      this.paint(zombie, this.zombies.indexOf(zombie));
      this.onSpawn?.(type, zombie.x, zombie.z);
    });
  }

  private setPartColor(index: number, hex: number): void {
    for (const part of this.bodyParts) {
      part.setColorAt(index, CAP_COLOR.setHex(hex));
    }
  }

  /** Torso/limb split tint: keeps the pale horned head readable on dark
   *  bodies (the brute was collapsing into one black monolith). */
  private setSplitTint(index: number, torsoHex: number, limbHex: number): void {
    this.torsoMesh.setColorAt(index, CAP_COLOR.setHex(torsoHex));
    this.armLMesh.setColorAt(index, CAP_COLOR.setHex(limbHex));
    this.armRMesh.setColorAt(index, CAP_COLOR.setHex(limbHex));
    this.legLMesh.setColorAt(index, CAP_COLOR.setHex(limbHex));
    this.legRMesh.setColorAt(index, CAP_COLOR.setHex(limbHex));
  }

  private paint(zombie: Zombie, index: number): void {
    if (zombie.type === 'brute') {
      this.setSplitTint(index, 0xf2ece0, 0x6e6656);
    } else if (zombie.type === 'bloater') {
      this.setPartColor(index, 0xe8e0c2);
    } else if (zombie.type === 'shield') {
      this.setPartColor(index, 0x9a9184);
    } else if (zombie.type === 'runner') {
      this.setPartColor(index, 0xa89e8a);
    } else if (zombie.elite) {
      this.setPartColor(index, this.elitePalette);
    } else {
      const pick = this.palette[Math.floor(this.rng() * this.palette.length)];
      this.setPartColor(index, pick);
    }
    for (const part of this.bodyParts) {
      if (part.instanceColor) part.instanceColor.needsUpdate = true;
    }
  }

  /** All dormant bodies rise (dusk). */
  riseAll(onRise: (position: THREE.Vector3) => void): void {
    for (const zombie of this.zombies) {
      if (zombie.active && zombie.state === 'dormant') {
        zombie.state = 'rising';
        zombie.stateTime = 0;
        onRise(this.tmpV.set(zombie.x, 0, zombie.z));
      }
    }
  }

  freezeAll(): void {
    for (const zombie of this.zombies) {
      if (zombie.active && (zombie.state === 'chase' || zombie.state === 'rising' || zombie.state === 'drown')) {
        zombie.state = 'frozen';
        zombie.stateTime = 0;
      }
    }
  }

  /** Swap the world queries after (re)building or rerolling the village. */
  setQueries(queries: WorldQueries): void {
    this.queries = queries;
  }

  /** Install the palace fortress walls the horde collides against. */
  setFortress(fortress: FortressCollider | null): void {
    this.fortress = fortress;
  }

  private fortress: FortressCollider | null = null;

  clearAll(): void {
    for (const zombie of this.zombies) zombie.active = false;
    this.booms.length = 0;
    this.mix = { brute: 0, bloater: 0, shield: 0, runner: 0 };
    for (const part of this.bodyParts) part.count = 0;
    this.eyeMesh.count = 0;
    this.shieldMesh.count = 0;
    this.collarMesh.count = 0;
    this.fistMesh.count = 0;
    this.tumorMesh.count = 0;
  }

  /** Cone test for the prince's slash. Fills `out` with hit records. */
  querySlash(
    originX: number,
    originZ: number,
    facing: number,
    range: number,
    arc: number,
    out: Array<{ index: number; x: number; z: number }>,
  ): Array<{ index: number; x: number; z: number }> {
    out.length = 0;
    const fx = Math.sin(facing);
    const fz = Math.cos(facing);
    for (let i = 0; i < this.zombies.length; i += 1) {
      const zombie = this.zombies[i];
      if (!zombie.active || zombie.state === 'dying' || zombie.state === 'dormant') continue;
      const dx = zombie.x - originX;
      const dz = zombie.z - originZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > range * range) continue;
      const dist = Math.sqrt(distSq) || 0.001;
      const dot = (dx / dist) * fx + (dz / dist) * fz;
      if (dot < Math.cos(arc / 2)) continue;
      out.push({ index: i, x: zombie.x, z: zombie.z });
    }
    return out;
  }

  /** Nearest vulnerable zombie within radius of a point (bullet impact). */
  queryPoint(x: number, z: number, radius: number): number {
    let best = -1;
    let bestDistSq = radius * radius;
    for (let i = 0; i < this.zombies.length; i += 1) {
      const zombie = this.zombies[i];
      if (!zombie.active || zombie.state === 'dying' || zombie.state === 'dormant') continue;
      const dx = zombie.x - x;
      const dz = zombie.z - z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= bestDistSq) {
        bestDistSq = distSq;
        best = i;
      }
    }
    return best;
  }

  /** Ray hit test in the ground plane: nearest zombie along a bullet ray.
   *  The assist radius widens with distance so a horde-scale stream still
   *  connects at 90m without being a full auto-aim up close.
   *  Returns the zombie index and writes the hit distance into out[0]. */
  queryRay(
    originX: number,
    originZ: number,
    dirX: number,
    dirZ: number,
    maxDist: number,
    radius: number,
    out: Array<{ index: number; dist: number; x: number; z: number }>,
  ): boolean {
    out.length = 0;
    let bestIndex = -1;
    let bestT = maxDist;
    let bestDistSq = Infinity;
    for (let i = 0; i < this.zombies.length; i += 1) {
      const zombie = this.zombies[i];
      if (!zombie.active || zombie.state === 'dying' || zombie.state === 'dormant') continue;
      const px = zombie.x - originX;
      const pz = zombie.z - originZ;
      const t = px * dirX + pz * dirZ;
      if (t < 0 || t > bestT) continue;
      const cx = px - t * dirX;
      const cz = pz - t * dirZ;
      const distSq = cx * cx + cz * cz;
      const assist = radius + t * 0.012;
      if (distSq <= assist * assist && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestT = t;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return false;
    out.push({
      index: bestIndex,
      dist: bestT,
      x: originX + dirX * bestT,
      z: originZ + dirZ * bestT,
    });
    return true;
  }

  /** 부적 봉인 — the seal detonation purges every body inside the ring.
   *  Door-plating is unmade with the flesh (armor-piercing), normal-tier
   *  원귀 scatter, brutes take the burn and usually keep standing.
   *  Bloater victims still queue their detonations — the chain reaction is
   *  the point. Returns how many bodies the seal unmade. */
  purgeRadius(
    x: number,
    z: number,
    radius: number,
    onKill: (position: THREE.Vector3, elite: boolean, dirX: number, dirZ: number, type: ZombieType) => void,
  ): number {
    let purged = 0;
    for (let i = 0; i < this.zombies.length; i += 1) {
      const zombie = this.zombies[i];
      if (!zombie.active || zombie.state === 'dying' || zombie.state === 'dormant') continue;
      const dx = zombie.x - x;
      const dz = zombie.z - z;
      const distSq = dx * dx + dz * dz;
      if (distSq > radius * radius) continue;
      const dist = Math.sqrt(distSq) || 1;
      zombie.armor = 0;
      const amount = zombie.type === 'brute' ? 40 : 999;
      if (this.damage(i, dx / dist, dz / dist, 10, onKill, amount) === 'kill') purged += 1;
    }
    return purged;
  }

  /** Outcome of one bullet landing. */
  damage(
    index: number,
    dirX: number,
    dirZ: number,
    force: number,
    onKill: (position: THREE.Vector3, elite: boolean, dirX: number, dirZ: number, type: ZombieType) => void,
    amount = 1,
    onArmorBreak?: (x: number, z: number) => void,
  ): 'kill' | 'hit' | 'armor' | 'none' {
    const zombie = this.zombies[index];
    if (!zombie.active || zombie.state === 'dying') return 'none';
    // Door-plating soaks the hit: sparks fly, flesh does not.
    if (zombie.type === 'shield' && zombie.armor > 0) {
      zombie.armor -= amount;
      if (zombie.armor <= 0) onArmorBreak?.(zombie.x, zombie.z);
      return 'armor';
    }
    zombie.hp -= amount;
    const kbMult = zombie.type === 'brute' ? 0.12 : zombie.type === 'runner' ? 1.6 : 1;
    zombie.vx += dirX * force * kbMult;
    zombie.vz += dirZ * force * kbMult;
    // Stagger: the hit visibly stops the body — weight, not bookkeeping.
    // Brutes have super armor; they do not flinch.
    zombie.stagger = zombie.type === 'brute' ? 0 : zombie.elite ? 0.14 : 0.3;
    if (zombie.hp <= 0) {
      // Bloaters detonate on death — the chain-reaction engine.
      if (zombie.type === 'bloater') this.booms.push({ x: zombie.x, z: zombie.z });
      onKill(this.tmpV.set(zombie.x, 0, zombie.z), zombie.elite, dirX, dirZ, zombie.type);
      // The body leaves the horde NOW — Game turns it into a box3d corpse
      // rigid body that rides the shot, tumbles and PILES on the rubble.
      zombie.active = false;
      return 'kill';
    }
    return 'hit';
  }

  update(
    delta: number,
    playerX: number,
    playerZ: number,
    playerInWater: boolean,
    phase: ZombiePhase,
    fearSources: Array<{ x: number; z: number; r: number }>,
    events: ZombieEvent,
  ): number {
    if (phase === 'day') this.eyeGlow = Math.max(0, this.eyeGlow - delta * 2);
    else if (phase === 'night') this.eyeGlow = Math.min(3.2, this.eyeGlow + delta * 1.4);
    else if (phase === 'dawn') this.eyeGlow = Math.max(0, this.eyeGlow - delta * 2.4);
    else this.eyeGlow = Math.min(2.4, this.eyeGlow + delta * 0.8);
    const eyeMaterial = this.eyeMesh.material as THREE.MeshStandardMaterial;
    // Frozen dawn keeps a dim icy read so the statue wall stays visible
    // after the night glow decays; night eyes burn Sin City red.
    if (phase === 'dawn') {
      this.eyeGlow = Math.max(this.eyeGlow, 0.85);
      eyeMaterial.emissive.setHex(0xbfe0ff);
    } else {
      eyeMaterial.emissive.setHex(0xff2014);
    }
    eyeMaterial.emissiveIntensity = this.eyeGlow;

    this.rebuildHash();
    let groanBudget = 2;

    // Detonations: each boom blasts nearby bodies into radial flight and
    // can chain further bloaters — drain the queue until it settles.
    let boomGuard = 0;
    while (this.booms.length > 0 && boomGuard < 16) {
      boomGuard += 1;
      const boom = this.booms.shift()!;
      events.onBoom(boom.x, boom.z);
      for (let i = 0; i < this.zombies.length; i += 1) {
        const victim = this.zombies[i];
        if (!victim.active || victim.state === 'dying' || victim.state === 'dormant') continue;
        const dx = victim.x - boom.x;
        const dz = victim.z - boom.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > 4.6 * 4.6 || distSq < 0.0001) continue;
        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const nz = dz / dist;
        if (victim.type === 'brute') {
          // Brutes shrug the blast — a chunk of flesh, no launch.
          this.damage(i, nx, nz, 1.5, events.onKill, 4);
        } else {
          // Everyone else rides the shockwave outward.
          this.damage(i, nx, nz, 20, events.onKill, 99);
        }
      }
    }

    for (let i = 0; i < this.zombies.length; i += 1) {
      const zombie = this.zombies[i];
      if (!zombie.active) continue;
      zombie.stateTime += delta;
      zombie.attackCooldown = Math.max(0, zombie.attackCooldown - delta);
      zombie.twitch += delta;

      switch (zombie.state) {
        case 'dormant': {
          // Sleeping plague victims wake if the prince steps too close.
          const dx = playerX - zombie.x;
          const dz = playerZ - zombie.z;
          if (dx * dx + dz * dz < 2.4 * 2.4 && phase !== 'day') {
            zombie.state = 'rising';
            zombie.stateTime = 0;
            events.onRise(this.tmpV2.set(zombie.x, 0, zombie.z));
          }
          break;
        }
        case 'rising': {
          if (zombie.stateTime > 0.85) {
            zombie.state = 'chase';
            zombie.stateTime = 0;
          }
          break;
        }
        case 'chase': {
          const inWater = this.queries.inStream(zombie.x, zombie.z);
          let speed = zombie.speed;
          // Stagger halts pursuit while knockback decays; elite shrugs faster.
          if (zombie.stagger > 0) {
            zombie.stagger -= delta;
            speed = 0;
          }
          // Kingdom rule: the horde loses the scent of anyone submerged.
          let targetX = playerX;
          let targetZ = playerZ;
          if (playerInWater) {
            targetX = zombie.x + Math.sin(zombie.phase + zombie.twitch * 0.13) * 6;
            targetZ = zombie.z + Math.cos(zombie.phase + zombie.twitch * 0.11) * 6;
          }
          if (inWater) {
            speed *= 0.45;
            // Deep-water pursuit drowns them; stream center is deepest.
            zombie.sink += delta * 0.5;
            if (zombie.sink > 2.2) {
              zombie.state = 'drown';
              zombie.stateTime = 0;
              break;
            }
          } else {
            zombie.sink = Math.max(0, zombie.sink - delta);
          }
          for (const fear of fearSources) {
            const dx = zombie.x - fear.x;
            const dz = zombie.z - fear.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < fear.r * fear.r && distSq > 0.01) {
              const dist = Math.sqrt(distSq);
              const push = (1 - dist / fear.r) * 2.6;
              zombie.vx += (dx / dist) * push * delta * 12;
              zombie.vz += (dz / dist) * push * delta * 12;
              speed *= 0.62;
            }
          }

          const dx = targetX - zombie.x;
          const dz = targetZ - zombie.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
          // At the rampart: stop and claw instead of pushing inside.
          const atWall = dist < 2.9;
          let mx = atWall ? 0 : (dx / dist) * speed;
          let mz = atWall ? 0 : (dz / dist) * speed;

          // Runners weave — a screaming zigzag the hose has to chase.
          if (zombie.type === 'runner' && !atWall) {
            const weave = Math.sin(zombie.twitch * 3.1 + zombie.phase) * speed * 0.55;
            mx += (-dz / dist) * weave;
            mz += (dx / dist) * weave;
          }
          // Bloaters that reach the rampart go up with the gate wall.
          if (zombie.type === 'bloater' && atWall) {
            this.booms.push({ x: zombie.x, z: zombie.z });
            zombie.active = false;
            break;
          }

          // Separation from neighbours.
          const neighbors = this.hash.get(this.cellKey(zombie.x, zombie.z));
          if (neighbors) {
            for (const other of neighbors) {
              if (other === i) continue;
              const oz = this.zombies[other];
              if (!oz.active || oz.state === 'dying' || oz.state === 'dormant') continue;
              const ox = zombie.x - oz.x;
              const ozd = zombie.z - oz.z;
              const dSq = ox * ox + ozd * ozd;
              if (dSq > 0.0004 && dSq < 0.64) {
                const d = Math.sqrt(dSq);
                mx += (ox / d) * speed * 0.85;
                mz += (ozd / d) * speed * 0.85;
              }
            }
          }

          zombie.vx += mx * delta * 6;
          zombie.vz += mz * delta * 6;
          const damp = Math.pow(atWall ? 0.0000001 : 0.001, delta);
          zombie.vx *= damp;
          zombie.vz *= damp;
          zombie.x += zombie.vx * delta;
          zombie.z += zombie.vz * delta;
          if (this.fortress) this.fortress.resolveBody(zombie, 0.38);
          if (atWall) {
            zombie.yaw = Math.atan2(dx, dz);
            zombie.clawing = true;
          } else {
            zombie.clawing = false;
            zombie.yaw = Math.atan2(zombie.vx, zombie.vz);
          }
          if (groanBudget > 0 && this.rng() < delta * 0.03) {
            groanBudget -= 1;
            events.onGroan(this.tmpV2.set(zombie.x, 0, zombie.z));
          }
          break;
        }
        case 'drown': {
          if (zombie.stateTime > 1.4) zombie.active = false;
          break;
        }
        case 'dying': {
          // Ballistic send-off: airborne bodies integrate position, tumble,
          // bounce once, then rest until the corpse fades.
          if (zombie.airY > 0 || zombie.vy !== 0) {
            zombie.airY += zombie.vy * delta;
            zombie.vy -= 22 * delta;
            zombie.x += zombie.vx * delta;
            zombie.z += zombie.vz * delta;
            const airDrag = Math.pow(0.5, delta);
            zombie.vx *= airDrag;
            zombie.vz *= airDrag;
            zombie.tumble += zombie.tumbleRate * delta;
            if (this.fortress && this.fortress.resolveBody(zombie, 0.4)) {
              // Splat against the rampart: forward motion dies, body drops.
              zombie.vx = 0;
              zombie.vz = 0;
              zombie.tumbleRate *= 0.4;
            }
            if (zombie.airY <= 0) {
              if (zombie.vy < -5.5) {
                zombie.airY = 0.02;
                zombie.vy = -zombie.vy * 0.3;
                zombie.vx *= 0.5;
                zombie.vz *= 0.5;
                zombie.tumbleRate *= 0.5;
              } else {
                zombie.airY = 0;
                zombie.vy = 0;
                zombie.vx = 0;
                zombie.vz = 0;
                zombie.tumbleRate = 0;
              }
            }
          }
          if ((zombie.stateTime > 1.4 && zombie.airY <= 0) || zombie.stateTime > 3) {
            zombie.active = false;
          }
          break;
        }
        case 'frozen': {
          // Frozen statues shatter at the end of dawn.
          if (zombie.stateTime > 6) zombie.active = false;
          break;
        }
        default:
          break;
      }
    }

    return this.writeMatrices();
  }

  private rebuildHash(): void {    this.hash.clear();
    for (let i = 0; i < this.zombies.length; i += 1) {
      const zombie = this.zombies[i];
      if (!zombie.active || zombie.state === 'dying' || zombie.state === 'dormant') continue;
      const key = this.cellKey(zombie.x, zombie.z);
      let bucket = this.hash.get(key);
      if (!bucket) {
        bucket = [];
        this.hash.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private cellKey(x: number, z: number): number {
    return (Math.floor(x / 2) + 4096) * 8192 + (Math.floor(z / 2) + 4096);
  }

  private readonly rootMatrix = new THREE.Matrix4();
  private readonly limbMatrix = new THREE.Matrix4();

  /** Compose a limb local matrix at its joint and push it under the root. */
  private writeLimb(
    mesh: THREE.InstancedMesh,
    index: number,
    jointX: number, jointY: number, jointZ: number,
    rotX: number, rotZ: number,
  ): void {
    this.posV.set(jointX, jointY, jointZ);
    this.euler.set(rotX, 0, rotZ, 'YXZ');
    this.quat.setFromEuler(this.euler);
    this.scaleV.set(1, 1, 1);
    this.limbMatrix.compose(this.posV, this.quat, this.scaleV);
    this.matrix.multiplyMatrices(this.rootMatrix, this.limbMatrix);
    mesh.setMatrixAt(index, this.matrix);
  }

  private writeMatrices(): number {
    let bodyCount = 0;
    let eyeCount = 0;
    let shieldCount = 0;
    let collarCount = 0;
    let fistCount = 0;
    let tumorCount = 0;
    const nightEyes = this.eyeGlow > 0.4 || this.phaseFrozen;
    this.phaseFrozen = false;
    for (let i = 0; i < this.zombies.length; i += 1) {
      const zombie = this.zombies[i];
      if (!zombie.active) continue;
      const ground = this.queries.heightAt(zombie.x, zombie.z);

      let pitch = 0;
      let roll = 0;
      let bob = 0;
      let scaleXZ: number;
      let scaleY: number;
      switch (zombie.type) {
        case 'brute':
          scaleXZ = 3.0 + (zombie.phase % 0.4) * 0.1;
          scaleY = 3.3;
          break;
        case 'bloater':
          scaleXZ = 1.52 + (zombie.phase % 0.5) * 0.1;
          scaleY = 0.88;
          break;
        case 'shield':
          scaleXZ = 1.04 + (zombie.phase % 0.5) * 0.12;
          scaleY = 1.06;
          break;
        case 'runner':
          scaleXZ = 0.7 + (zombie.phase % 0.5) * 0.12;
          scaleY = 0.72;
          break;
        default:
          scaleXZ = zombie.elite ? 1.12 : 0.92 + (zombie.phase % 0.5) * 0.2;
          scaleY = zombie.elite ? 1.15 : 0.94 + (zombie.phase % 0.4) * 0.18;
          break;
      }
      let sinkY = 0;
      // Joint pose: shoulder/hip rotations driven per state below.
      let armLX = 0;
      let armRX = 0;
      let armLZ = 0.1;
      let armRZ = -0.1;
      let legLX = 0;
      let legRX = 0;

      switch (zombie.state) {
        case 'dormant': {
          // Sleeping demons — curled kneel or twisted side-lying.
          const kneel = (zombie.phase % 2) < 1;
          if (kneel) {
            pitch = 0.58;
            sinkY = -0.08;
            roll = 0.12 + Math.sin(zombie.twitch * 0.7) * 0.03;
            armLX = -2.3;
            armRX = -2.5;
            legLX = 1.15;
            legRX = 0.95;
          } else {
            pitch = 1.35;
            sinkY = -0.16;
            roll = 0.55 + Math.sin(zombie.twitch * 0.5) * 0.04;
            armLX = -1.6;
            armRX = -2.4;
            legLX = 1.3;
            legRX = 0.4;
          }
          break;
        }
        case 'rising': {
          const t = Math.min(1, zombie.stateTime / 0.85);
          const eased = 1 - Math.pow(1 - t, 3);
          pitch = (Math.PI / 2) * (1 - eased);
          sinkY = -0.32 * (1 - eased);
          // Unfold: arms sweep up from the ground into the demon reach.
          armLX = -2.7 + eased * 1.5;
          armRX = -2.4 + eased * 1.3;
          legLX = 1.05 * (1 - eased);
          legRX = 0.75 * (1 - eased);
          break;
        }
        case 'chase': {
          const lurchT = zombie.twitch * (3.4 + zombie.speed) * (zombie.type === 'brute' ? 0.55 : zombie.type === 'runner' ? 1.5 : 1);
          const staggerK = zombie.stagger > 0 ? 1 : 0;
          const stride = Math.sin(lurchT + zombie.phase);
          if (zombie.clawing) {
            // Clawing the rampart: alternating overhead slam, both feet set.
            const slam = Math.sin(lurchT * 2.4 + zombie.phase);
            pitch = 0.28 + slam * 0.2;
            roll = slam * 0.16;
            bob = 0;
            armLX = -2.35 + slam * 0.75;
            armRX = -2.35 - slam * 0.75;
            armLZ = 0.25;
            armRZ = -0.25;
            legLX = 0.22;
            legRX = -0.18;
          } else if (zombie.type === 'brute') {
            // The slow, inevitable column step — heavy pendulum arms.
            pitch = 0.06 + stride * 0.05;
            roll = Math.sin(lurchT * 0.5 + zombie.phase) * 0.07;
            bob = Math.abs(stride) * 0.12;
            legLX = stride * 0.42;
            legRX = -stride * 0.42;
            armLX = -0.95 - stride * 0.2;
            armRX = -0.95 + stride * 0.2;
            armLZ = 0.3;
            armRZ = -0.3;
          } else if (zombie.type === 'bloater') {
            // Sick wide waddle, arms swinging against the belly roll.
            pitch = -0.04 + stride * 0.06;
            roll = Math.sin(lurchT * 0.8 + zombie.phase) * 0.22;
            bob = Math.abs(Math.sin(lurchT * 0.8 + zombie.phase)) * 0.04;
            legLX = stride * 0.3;
            legRX = -stride * 0.3;
            armLX = -0.7 + stride * 0.5;
            armRX = -0.7 - stride * 0.5;
            armLZ = 0.45;
            armRZ = -0.45;
          } else if (zombie.type === 'runner') {
            // Sprinter: pumping arms, driving knees.
            pitch = 0.24 + stride * 0.1;
            roll = stride * 0.16;
            bob = Math.abs(stride) * 0.08;
            legLX = stride * 0.85;
            legRX = -stride * 0.85;
            armLX = -0.6 - stride * 0.6;
            armRX = -0.6 + stride * 0.6;
          } else {
            // Demon stride: proud stage walk — legs carry, arms reach.
            pitch = 0.04 + stride * 0.06 + staggerK * 0.34;
            roll = Math.sin(lurchT * 0.5 + zombie.phase) * 0.14 + staggerK * 0.18;
            bob = Math.abs(stride) * 0.06 * (1 - staggerK);
            const strideAmt = 1 - staggerK;
            legLX = stride * 0.55 * strideAmt;
            legRX = -stride * 0.55 * strideAmt;
            armLX = -1.2 + stride * 0.28 + staggerK * -0.5;
            armRX = -1.2 - stride * 0.28 + staggerK * -0.5;
            armLZ = 0.35;
            armRZ = -0.35;
            // Periodic overhead lunge — the KDH pounce telegraph, one claw
            // raised mid-stride so the horde reads as attackers, not walkers.
            const reach = Math.sin(lurchT * 0.5 + zombie.phase * 2);
            if (reach > 0.45) {
              armLX = -2.6 - reach * 0.3;
              armLZ = 0.3;
            } else if (reach < -0.55) {
              armRX = -2.5 + reach * 0.25;
              armRZ = -0.3;
            }
          }
          break;
        }
        case 'drown': {
          const t = Math.min(1, zombie.stateTime / 1.4);
          sinkY = -t * 1.4;
          pitch = 0.6 * t;
          // Panicked overhead beating as the stream takes them.
          armLX = -2.6 + Math.sin(zombie.twitch * 7) * 0.35;
          armRX = -2.5 + Math.sin(zombie.twitch * 6.2 + 1) * 0.35;
          legLX = 0.3 * t;
          legRX = -0.2 * t;
          break;
        }
        case 'frozen': {
          // Menacing brace: claws out to the sides so hands and spikes
          // silhouette against the night instead of hiding behind the torso.
          pitch = 0.1;
          armLX = -0.95;
          armRX = -0.85;
          armLZ = 0.5;
          armRZ = -0.55;
          legLX = 0.18;
          legRX = -0.12;
          break;
        }
        case 'dying': {
          if (zombie.airY > 0) {
            // Airborne corpse: full tumble with flailing limbs.
            pitch = zombie.tumble;
            roll = zombie.tumble * 0.62;
            sinkY = zombie.airY;
            armLX = -2.5 + Math.sin(zombie.tumble * 3.3) * 0.55;
            armRX = -2.2 + Math.sin(zombie.tumble * 2.7 + 1.2) * 0.55;
            armLZ = 0.5;
            armRZ = -0.5;
            legLX = 0.55 + Math.sin(zombie.tumble * 2.2) * 0.35;
            legRX = -0.45 + Math.sin(zombie.tumble * 2.9 + 0.7) * 0.35;
          } else {
            const t = Math.min(1, zombie.stateTime / 1.4);
            pitch = (Math.PI / 2) * Math.min(1, t * 1.6);
            sinkY = -t * 0.55;
            scaleXZ *= 1 - t * 0.15;
            // Sprawl: limbs splay out as the body settles.
            armLX = -1.9 + t * 0.3;
            armRX = -1.6 - t * 0.2;
            armLZ = 0.7;
            armRZ = -0.6;
            legLX = 0.35;
            legRX = -0.3;
          }
          break;
        }
        default:
          break;
      }

      this.euler.set(pitch, zombie.yaw, roll, 'YXZ');
      this.quat.setFromEuler(this.euler);
      this.posV.set(zombie.x, ground + bob + sinkY, zombie.z);
      this.scaleV.set(scaleXZ, scaleY, scaleXZ);
      this.rootMatrix.compose(this.posV, this.quat, this.scaleV);
      this.torsoMesh.setMatrixAt(bodyCount, this.rootMatrix);

      // Articulated limbs: local joint offset × joint rotation, under root.
      this.writeLimb(this.armLMesh, bodyCount, 0.17, 1.04, 0.05, armLX, armLZ);
      if (zombie.type === 'brute' && zombie.state !== 'dying' && fistCount < this.fistMesh.instanceMatrix.count) {
        // this.matrix still holds arm-L root×joint — ride the claw tip.
        this.limbMatrix.makeTranslation(0, -0.72, 0);
        this.matrix.multiply(this.limbMatrix);
        this.fistMesh.setMatrixAt(fistCount, this.matrix);
        fistCount += 1;
      }
      this.writeLimb(this.armRMesh, bodyCount, -0.17, 1.04, 0.05, armRX, armRZ);
      if (zombie.type === 'brute' && zombie.state !== 'dying' && fistCount < this.fistMesh.instanceMatrix.count) {
        this.limbMatrix.makeTranslation(0, -0.72, 0);
        this.matrix.multiply(this.limbMatrix);
        this.fistMesh.setMatrixAt(fistCount, this.matrix);
        fistCount += 1;
      }
      this.writeLimb(this.legLMesh, bodyCount, 0.09, 0.42, 0.02, legLX, 0);
      this.writeLimb(this.legRMesh, bodyCount, -0.09, 0.42, 0.02, legRX, 0);
      bodyCount += 1;

      if (nightEyes && zombie.state !== 'dormant' && zombie.state !== 'dying') {
        // Two distinct pupils on the horned head — neon against the ink.
        // Head-space offsets carried through the root transform, so every
        // variant (tiny runner to giant brute) keeps them ON the face
        // surface, wide apart, never buried in the skull or merged.
        let eyeMul: number;
        if (zombie.type === 'brute') eyeMul = 0.62;
        else if (zombie.type === 'bloater') eyeMul = 1.15 + Math.sin(zombie.twitch * 5 + zombie.phase) * 0.3;
        else if (zombie.type === 'runner') eyeMul = 0.85;
        else if (zombie.type === 'shield') eyeMul = 1.0;
        else eyeMul = zombie.elite ? 1.2 : 1.0;
        // 근접 표시 — claws ON the gun: the eyes flare so the player sees
        // exactly which bodies have closed in (they sit at the frame's
        // bottom edge and are easy to lose in the murk).
        if (zombie.clawing) eyeMul *= 1.9;
        this.scaleV.setScalar(eyeMul * scaleXZ);
        this.quat.identity();
        for (const side of [-1, 1]) {
          this.posV.set(side * 0.058, 1.21, 0.175).applyMatrix4(this.rootMatrix);
          this.matrix.compose(this.posV, this.quat, this.scaleV);
          this.eyeMesh.setMatrixAt(eyeCount, this.matrix);
          eyeCount += 1;
        }
      }

      // Neon demon collar at the chest — pulses with each demon's phase.
      if (zombie.state !== 'dormant' && zombie.state !== 'dying' && collarCount < this.collarMesh.instanceMatrix.count) {
        const pulse = 1 + Math.sin(zombie.twitch * 5.2 + zombie.phase) * 0.22;
        this.posV.set(0, 1.02, 0.21).applyMatrix4(this.rootMatrix);
        this.quat.setFromEuler(this.euler.set(0, zombie.twitch * 2.4 + zombie.phase, 0));
        this.scaleV.setScalar(
          pulse * scaleXZ * (zombie.type === 'brute' ? 0.9 : zombie.type === 'runner' ? 0.8 : 1),
        );
        this.matrix.compose(this.posV, this.quat, this.scaleV);
        this.collarMesh.setMatrixAt(collarCount, this.matrix);
        collarCount += 1;
      }

      // Bloater pustules ride the root — glowing through the waddle.
      if (
        zombie.type === 'bloater' &&
        zombie.state !== 'dying' &&
        tumorCount < this.tumorMesh.instanceMatrix.count
      ) {
        const swell = 1 + Math.sin(zombie.twitch * 6 + zombie.phase) * 0.12;
        this.scaleV.setScalar(swell);
        this.matrix.compose(this.posV.set(0, 0, 0), this.quat.identity(), this.scaleV);
        this.limbMatrix.multiplyMatrices(this.rootMatrix, this.matrix);
        this.tumorMesh.setMatrixAt(tumorCount, this.limbMatrix);
        tumorCount += 1;
      }

      // Door-shield carried in front while the plating holds.
      if (zombie.type === 'shield' && zombie.armor > 0 && zombie.state !== 'dying' && shieldCount < this.shieldMesh.instanceMatrix.count) {
        const yaw = zombie.yaw;
        const shieldF = 0.5 * scaleXZ;
        this.posV.set(
          zombie.x + Math.sin(yaw) * shieldF,
          ground + 0.72 * scaleY + sinkY + bob,
          zombie.z + Math.cos(yaw) * shieldF,
        );
        this.euler.set(0.08, yaw, 0.05, 'YXZ');
        this.quat.setFromEuler(this.euler);
        this.scaleV.setScalar(scaleXZ);
        this.matrix.compose(this.posV, this.quat, this.scaleV);
        this.shieldMesh.setMatrixAt(shieldCount, this.matrix);
        shieldCount += 1;
      }
    }
    for (const part of this.bodyParts) {
      part.count = bodyCount;
      part.instanceMatrix.needsUpdate = true;
    }
    this.eyeMesh.count = eyeCount;
    this.shieldMesh.count = shieldCount;
    this.collarMesh.count = collarCount;
    this.fistMesh.count = fistCount;
    this.tumorMesh.count = tumorCount;
    this.eyeMesh.instanceMatrix.needsUpdate = true;
    this.shieldMesh.instanceMatrix.needsUpdate = true;
    this.collarMesh.instanceMatrix.needsUpdate = true;
    this.fistMesh.instanceMatrix.needsUpdate = true;
    this.tumorMesh.instanceMatrix.needsUpdate = true;
    return bodyCount;
  }

  /** Live counts per variant for diagnostics. */
  typeCounts(): Record<ZombieType, number> {
    const counts: Record<ZombieType, number> = { normal: 0, runner: 0, brute: 0, bloater: 0, shield: 0 };
    for (const zombie of this.zombies) {
      if (zombie.active && zombie.state !== 'dying') counts[zombie.type] += 1;
    }
    return counts;
  }

  forEachActive(visit: (x: number, z: number, state: string, type: ZombieType) => void): void {
    for (const zombie of this.zombies) {
      if (zombie.active) visit(zombie.x, zombie.z, zombie.state, zombie.type);
    }
  }

  dispose(): void {
    for (const part of this.bodyParts) {
      part.geometry.dispose();
      part.removeFromParent();
    }
    (this.torsoMesh.material as THREE.Material).dispose();
    this.eyeMesh.geometry.dispose();
    (this.eyeMesh.material as THREE.Material).dispose();
    this.shieldMesh.geometry.dispose();
    (this.shieldMesh.material as THREE.Material).dispose();
    this.collarMesh.geometry.dispose();
    (this.collarMesh.material as THREE.Material).dispose();
    this.fistMesh.geometry.dispose();
    (this.fistMesh.material as THREE.Material).dispose();
    this.tumorMesh.geometry.dispose();
    (this.tumorMesh.material as THREE.Material).dispose();
    this.eyeMesh.removeFromParent();
    this.shieldMesh.removeFromParent();
    this.collarMesh.removeFromParent();
    this.fistMesh.removeFromParent();
    this.tumorMesh.removeFromParent();
  }
}

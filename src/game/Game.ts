import * as THREE from 'three';
import { Loop } from '../core/Loop';
import { InputController } from '../core/InputController';
import { World } from '../world/World';
import { Horde, type ZombiePhase, type ZombieType } from '../entities/Horde';
import { Gunner, makeFlameTexture } from '../entities/Gunner';
import { DebrisPool } from '../entities/DebrisPool';
import { Box3dWorld } from '../physics/Box3dWorld';
import { GibPool } from '../entities/GibPool';
import { BloodYard } from '../entities/BloodYard';
import { TracerPool } from '../entities/TracerPool';
import { AudioSystem } from '../systems/AudioSystem';
import { Hud } from '../systems/Hud';
import { VfxSystem } from '../systems/VfxSystem';
import { createSeededRandom } from '../utils/random';
import { DebugTools, type DebugTuning } from '../systems/DebugTools';
import { shareRun, shareScoreCard, sharePainting, buildPaintingCard, formatSurvival, type RunStats } from '../systems/ShareKit';

export type GameMode = 'title' | 'playing' | 'dead';

const BUNKER_HP_MAX = 1000;
const SPIN_UP_SECONDS = 1.05;
const FIRE_RATE_MIN = 4;
const FIRE_RATE_MAX = 21;
const HEAT_PER_SHOT = 0.0125;
const HEAT_DECAY = 0.16;
const VENT_SECONDS = 3.2;
const LULL_SECONDS = 11;
const WAVE_TRICKLE = 0.09;
const WAVE_BASE = 70;
const WAVE_STEP = 52;
const WAVE_REPAIR = 180;
const CLAW_RANGE = 3.6;
const CLAW_DPS = 5.5;
const MAX_CLAW_ATTACKERS = 6;
const AIM_ASSIST_RADIUS = 1.15;
const SHOT_FORCE = 4.0;

interface Tuning extends DebugTuning {
  hitstopSeconds: number;
}

/**
 * 새벽까지 — siege edition: first-person gatling in a palace bunker,
 * mowing down rivers of 원귀 converging on the rampart.
 */
export class Game {
  private readonly loop: Loop;
  private readonly world: World;
  private readonly horde: Horde;
  private gunnerInstance: Gunner | null = null;
  /** Gatling emplacement: on the wall walk beside the south gate. */
  private gunX = 0;
  private gunZ = 0;
  private gunGroundY = 0;
  private debris: DebrisPool | null = null;
  /** box3d(WASM) rigid-body rubble — chewed cubes and collapse debris. */
  private rubble: Box3dWorld | null = null;
  private approachTorches: THREE.Group | null = null;
  private readonly tracers: TracerPool;
  private readonly gibs: GibPool;
  private bloodYard: BloodYard | null = null;
  private readonly vfx: VfxSystem;
  private readonly audio = new AudioSystem();
  private readonly hud = new Hud();
  private readonly input: InputController;
  private readonly debugTools: DebugTools;

  private readonly tuning: Tuning = {
    speed: 0,
    acceleration: 0,
    cameraLag: 5.6,
    exposure: 1.05,
    maxDpr: 2,
    hitstopSeconds: 0.03,
  };

  private readonly compact: boolean;
  private rng = createSeededRandom(20260815);
  private villageSeed = 20260815;

  private mode: GameMode = 'title';
  private day = 1; // wave counter under the hood
  private kills = 0;
  private bunkerHp = BUNKER_HP_MAX;
  private bunkerMax = BUNKER_HP_MAX;

  // Gatling state.
  private spin = 0;
  private heat = 0;
  private ventTimer = 0;
  private fireCooldown = 0;

  // Wave state.
  private waveActive = false;
  private waveSpawnQueue = 0;
  private waveSpawnTimer = 0;
  private waveBearing = 0;
  private lullTimer = 0;
  private upgradeOpen = false;
  private announcedBrute = false;
  private slowmoTimer = 0;
  private warnedBloat = false;

  // Upgrades.
  private dmgPerShot = 1;
  private heatMult = 1;
  private spinMult = 1;
  private rateBonus = 0;
  private splash = false;
  private spreadMult = 1;
  private forceMult = 1;
  private assistMult = 1;

  // Run stats for the death card + share.
  private shotsFired = 0;
  private shotsHit = 0;
  private maxCombo = 0;
  private nextMilestone = 0;
  private extraMilestone = 4000;
  private hintTimer = -1;
  private hintedWall = false;
  private deathTimer = -1;
  private toastTimer = 0;

  // 부적 봉인 — every kill inks the talisman; full charge arms the next
  // trigger stroke as the seal round (see fireSeal()).
  private sealCharge = 0;
  private sealing = false;
  private sealAnnounced = false;
  // 새벽 장 — every fifth wave cleared floods the grade gold for a breath.
  private dawnTimer = 0;

  private frame = 0;
  private elapsed = 0;
  private pausedForScreenshot = false;
  private reducedMotion = false;
  private titleOrbit = 0;
  private comboCount = 0;
  private comboTimer = 0;
  private readonly rayHits: Array<{ index: number; dist: number; x: number; z: number }> = [];
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly aimNdc = new THREE.Vector2();
  private readonly aimPoint = new THREE.Vector3(0, 0, -14);
  private shakeTrauma = 0;
  private shakeTime = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private bunkerX = 0;
  private bunkerZ = 0;
  /** Spawn ring far edge — the visible field depth, in meters. */
  private spawnFar = 60;
  private bunkerGroundY = 0;
  private godmode = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    onReady: (ready: boolean, label: string) => void,
  ) {
    this.compact = window.matchMedia('(max-width: 820px), (pointer: coarse)').matches;
    this.godmode = new URLSearchParams(window.location.search).has('godmode');

    this.world = new World(canvas, this.compact);
    this.tuning.maxDpr = this.compact ? 1.5 : 2;

    this.horde = new Horde(
      this.world.scene,
      {
        heightAt: () => 0,
        inStream: () => false,
        streamHalfWidth: () => 4,
        villageRadius: () => 120,
        obstacleRects: () => [],
        randomRoadPoint: () => new THREE.Vector3(),
        cityWallSpec: () => null,
        palaceCenter: () => null,
      },
      this.compact ? 420 : 950,
      () => this.rng(),
    );
    this.tracers = new TracerPool(this.world.scene, 140);
    this.gibs = new GibPool(this.world.scene, this.compact ? 110 : 220);
    this.vfx = new VfxSystem(this.world.scene, this.compact ? 160 : 320);
    // Brute entrances get their own beat.
    this.horde.onSpawn = (type) => {
      if (type !== 'brute' || this.announcedBrute) return;
      this.announcedBrute = true;
      this.hud.showWave('거구 원귀가 온다 — 걸어서라도');
      this.audio.roar();
    };

    this.input = new InputController();

    this.debugTools = new DebugTools(this.tuning, () => {
      this.world.renderer.toneMappingExposure = this.tuning.exposure;
      this.resize();
    });

    window.addEventListener('keydown', this.onUpgradeKey);
    window.addEventListener('keydown', this.onMuteKey);
    document.querySelector('#mute-button')?.addEventListener('pointerdown', this.onMuteClick);

    // Grime fabric pass (grok image_gen output in public/textures).
    // BASE_URL keeps it anchored under the deploy base (GitHub Pages).
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(`${import.meta.env.BASE_URL}textures/zombie-rag.jpg`, (texture) => {
      this.horde.setBodyTexture(texture);
    });

    this.world.camera.rotation.order = 'YXZ';
    this.loop = new Loop(
      (delta) => {
        const t0 = performance.now();
        this.update(delta);
        this.updateMs = this.updateMs * 0.9 + (performance.now() - t0) * 0.1;
      },
      () => {
        const t0 = performance.now();
        this.world.render();
        this.renderMs = this.renderMs * 0.9 + (performance.now() - t0) * 0.1;
      },
    );

    void this.bootstrap(onReady);
    this.installTestHooks();
    this.resize();
  }

  private async bootstrap(onReady: (ready: boolean, label: string) => void): Promise<void> {
    onReady(false, '궁을 세우는 중…');
    try {
      await this.world.build((label) => onReady(false, label), this.villageSeed);
    } catch (error) {
      onReady(false, `궁 생성 실패: ${String(error)}`);
      return;
    }
    this.horde.setQueries(this.world.queries());
    this.establishBunker();
    this.titleCameraSnap();
    this.world.setTimeOfDay('night', { immediate: true });
    this.audio.setPhase('night');
    this.updateTitleBest();
    onReady(false, '원귀를 깨우는 중…');
    this.rubble ??= new Box3dWorld(this.world.scene, 3072);
    // The flat slab sinks 4m below the terrain — the REAL floor is the
    // terrain tile grid (the yard slopes; corpses must rest on visible
    // ground, not inside it).
    const physicsOk = await this.rubble.init(-26, this.bunkerGroundY - 4, 320);
    if (physicsOk) {
      this.rubble.addTerrainTiles(
        (x, z) => this.world.queries().heightAt(x, z),
        this.bunkerX - 75, this.bunkerX + 75,
        this.bunkerZ - 105, this.bunkerZ + 65,
      );
    }
    if (!physicsOk) console.warn('box3d wasm 미로딩 — 러블 비활성');
    console.info(`[box3d] ready=${physicsOk} bodies=${this.rubble.bodyCount} cap=${this.rubble.capacity}`);
    onReady(true, 'ready');
  }

  /** Anchor the defense in the 궁궐 앞마당 (palace front yard): a last-stand
   *  in the open — no gate funnel, no walls in play. The horde converges
   *  from every compass point toward the gatling in the yard; the camera
   *  hangs almost overhead and every press fires toward the touch point. */
  private establishBunker(): void {
    const queries = this.world.queries();
    this.horde.setFortress(null);
    const palace = queries.palaceCenter();

    // The BACK yard, north of the whole palace compound — the mountain
    // (배산) looms behind the wall and the horde pours DOWN its slope
    // toward the gun. Camera stands south over the palace roofs looking
    // north: roof foreground, gun mid-frame, mountain river.
    // 개활지 최후 진지 — the palace compound is DENSE (halls, walls,
    // colonnades at every scale) and no single measurement ever sees all
    // of it: pick-proxies miss the merged halls, mesh bounds miss pieces
    // that stream in late. Stop measuring the palace and OUT-RANGE it —
    // the gun stands a fixed 90m south of the palace CENTER (no capital
    // compound reaches past ~60m) on measured flat ground, so overlap is
    // impossible by construction. The palace becomes the BACKDROP (already
    // fallen: the horde pours OUT of it toward the last gun in the field)
    // with the 배산 rising behind it.
    const h = queries.heightAt;
    this.spawnFar = 60;
    if (palace) {
      this.bunkerX = palace.x;
      // Flattest candidate row in the open field south of the compound.
      let bestZ = palace.z + 90;
      let bestScore = Infinity;
      for (const off of [78, 86, 94, 102, 110]) {
        const z = palace.z + off;
        let score = 0;
        for (const [ox, oz] of [[0, 0], [24, 0], [-24, 0], [0, 26], [0, -26], [16, 14], [-16, -14]] as const) {
          score = Math.max(score, Math.abs(h(palace.x + ox, z + oz) - h(palace.x, z)));
        }
        if (score < bestScore) {
          bestScore = score;
          bestZ = z;
        }
      }
      this.bunkerZ = bestZ;
    } else {
      this.bunkerX = 0;
      this.bunkerZ = -60;
    }
    this.bunkerGroundY = queries.heightAt(this.bunkerX, this.bunkerZ);
    this.gunX = this.bunkerX;
    this.gunZ = this.bunkerZ;
    this.gunGroundY = this.bunkerGroundY;

    // Keep the kill yard core and the palace-side approach clear; the four
    // flanking houses (≥19m out) must survive the sweep.
    this.world.clearObstaclesNear(this.bunkerX, this.bunkerZ, 15);
    this.world.clearObstaclesNear(this.bunkerX, this.bunkerZ + 26, 12);
    // The village street: two pairs flanking a WIDE lane (inner wall ≥16m
    // out on desktop, ≥11m on compact), on the same measured courtyard.
    this.world.placeYardHouses(this.bunkerX, this.bunkerZ, this.villageSeed);

    this.gunnerInstance?.dispose();
    this.gunnerInstance = new Gunner(this.world.scene, this.gunX, this.gunZ, this.gunGroundY);

    this.debris ??= new DebrisPool(this.world.scene);

    // Brazier ring — the yard's brightness anchors at night (sprite-only,
    // no dynamic lights — light-budget doctrine).
    this.approachTorches?.removeFromParent();
    this.approachTorches = new THREE.Group();
    this.approachTorches.name = 'yard-braziers';
    const flameTex = makeFlameTexture();
    for (let i = 0; i < 11; i += 1) {
      // North half only — the south lane stays clear so the horde river
      // reads against open ground (vision round feedback).
      const a = ((i + 0.5) / 11) * Math.PI + 0.35;
      const radius = 13 + (i % 3) * 3.2;
      const tx = this.bunkerX + Math.cos(a) * radius;
      const tz = this.bunkerZ + Math.sin(a) * radius;
      const torch = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flameTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      torch.scale.set(1.15, 1.8, 1);
      torch.position.set(tx, queries.heightAt(tx, tz) + 1.8, tz);
      this.approachTorches.add(torch);
    }
    this.world.scene.add(this.approachTorches);

    // The kill yard is the palace front yard: splatter stays where they fall.
    this.bloodYard?.dispose();
    this.bloodYard = new BloodYard(this.world.scene, queries, {
      minX: this.bunkerX - 55,
      maxX: this.bunkerX + 55,
      minZ: this.bunkerZ - 72,
      maxZ: this.bunkerZ + 50,
    });

    if (!this.aimRing) {
      this.aimRing = new THREE.Mesh(
        new THREE.RingGeometry(2.3, 3.1, 32, 1),
        new THREE.MeshBasicMaterial({
          color: 0xff2a1c,
          transparent: true,
          opacity: 0.95,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      this.aimRing.rotation.x = -Math.PI / 2;
      this.aimRing.name = 'aim-ring';
      this.world.scene.add(this.aimRing);
    }

    if (!this.clawRing) {
      this.clawRing = new THREE.Mesh(
        new THREE.RingGeometry(3.6, 4.3, 40, 1),
        new THREE.MeshBasicMaterial({
          color: 0xef1935,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      this.clawRing.rotation.x = -Math.PI / 2;
      this.clawRing.name = 'claw-ring';
      this.world.scene.add(this.clawRing);
    }
    this.clawRing.position.set(this.gunX, this.gunGroundY + 0.25, this.gunZ);
  }

  /** 근접 경고 링 — pulses under the gun while bodies are ON it. */
  private clawRing: THREE.Mesh | null = null;
  private threatFlareTimer = 0;

  private aimRing: THREE.Mesh | null = null;

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    window.removeEventListener('keydown', this.onUpgradeKey);
    window.removeEventListener('keydown', this.onMuteKey);
    document.querySelector('#mute-button')?.removeEventListener('pointerdown', this.onMuteClick);
    this.audio.dispose();
    this.debugTools.dispose();
    this.horde.dispose();
    this.tracers.dispose();
    this.gibs.dispose();
    this.vfx.dispose();
    this.gunnerInstance?.dispose();
    this.debris?.dispose();
    this.rubble?.dispose();
    this.bloodYard?.dispose();
    this.world.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  // ── Waves ─────────────────────────────────────────────────────────────

  private startWave(index: number): void {
    this.day = index;
    this.waveActive = true;
    // Wave 1 stays survivable for a first-timer; the river swells fast after.
    this.waveSpawnQueue = Math.min(this.compact ? 420 : 900, WAVE_BASE + (index - 1) * WAVE_STEP);
    // Every 5th wave is 대격노 — the river overflows.
    const tide = index % 5 === 0;
    if (tide) this.waveSpawnQueue = Math.min(this.compact ? 420 : 900, Math.round(this.waveSpawnQueue * 2.2));
    // Variant quotas — wave 1 is pure fundamentals, then the zoo opens.
    // Bloaters arrive late and sparse: the 유폭 is a punctuation mark, not
    // punctuation.
    const scale = this.compact ? 0.6 : 1;
    this.horde.setWaveMix({
      brute: index >= 3 ? Math.max(1, Math.round(Math.min(4, 1 + (index - 3) / 2) * scale)) : 0,
      bloater: index >= 3 ? Math.max(1, Math.round(this.waveSpawnQueue * 0.028 * scale)) : 0,
      shield: index >= 3 ? Math.max(2, Math.round(this.waveSpawnQueue * 0.07 * scale)) : 0,
      runner: index >= 2 ? Math.round(this.waveSpawnQueue * 0.1 * scale) : 0,
    });
    this.announcedBrute = false;
    this.waveSpawnTimer = 0;
    // The horde pours up the SOUTH axis into the yard — the telephoto rig
    // faces it dead-on. A narrow entry arc (±20°) keeps the river readable
    // instead of a 360° drip.
    this.waveBearing = -Math.PI / 2 + (this.rng() - 0.5) * 0.7;
    this.hud.showWave(tide
      ? `제${index}파 대격노 — 원귀의 강이 넘친다`
      : `제${index}파 — [${this.directionName(this.waveBearing)}] 능선이 무너져 내려온다`);
    this.audio.drum(1);
    this.audio.drum(0.85);
    this.audio.setBgmState(tide ? 'tide' : 'wave');
    if (tide) {
      this.audio.roar();
      this.hud.stamp('潮', '대격노');
      this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.35);
    }
    // Cinematic wave entrance: dolly settles in, lens kicks, grade splits.
    this.dollyEase = 0;
    this.fovPunch = Math.min(1.4, this.fovPunch + 0.35);
    this.world.impactAberration(0.7);
  }

  private directionName(angle: number): string {
    const names = ['동', '남동', '남', '남서', '서', '북서', '북', '북동'];
    const index = Math.round(((angle % (Math.PI * 2)) + Math.PI * 2) / (Math.PI / 4)) % 8;
    return names[index];
  }

  private updateWaves(delta: number): void {
    if (this.upgradeOpen) return;
    // 새벽 장 — the dawn ceremony holds the wave clock while it plays.
    if (this.dawnTimer > 0) return;
    // The upgrade card waits for the kill cam to finish its beat.
    if (this.pendingUpgrade && this.killCamTimer <= 0) {
      this.pendingUpgrade = false;
      this.openUpgradeChoice();
      return;
    }
    if (this.waveActive) {
      // Trickle spawn from the bearing (mixed close/far for a flowing river).
      if (this.waveSpawnQueue > 0) {
        this.waveSpawnTimer -= delta;
        if (this.waveSpawnTimer <= 0) {
          this.waveSpawnTimer = WAVE_TRICKLE;
          const batchMax = this.day % 5 === 0 ? 8 : 5;
          const batch = Math.min(this.waveSpawnQueue, 2 + Math.floor(this.rng() * (batchMax - 2)));
          const spreadBearing = this.waveBearing + (this.rng() - 0.5) * 0.6;
          // Convergence ring around the palace yard — inside the reserved
          // palace grounds, so no hanok stand in the horde's way.
          this.horde.spawnWave(batch, spreadBearing, this.day, 0.1 + this.day * 0.015, 1.0, undefined, [18, this.spawnFar], { x: this.bunkerX, z: this.bunkerZ });
          this.waveSpawnQueue -= batch;
        }
      } else if (this.horde.activeCount === 0) {
        // Wave cleared. Every fifth (대격노 survived) breaks the NIGHT
        // itself: dawn floods the grade, the yard's painting stands
        // complete, then the next night closes in. Other waves take the
        // directed kill-cam beat.
        this.waveActive = false;
        this.comboCount = 0;
        this.hud.setCombo(0);
        this.audio.bell();
        this.audio.setBgmState('lull');
        if (this.day > 0 && this.day % 5 === 0) {
          this.beginDawn();
        } else {
          this.lullTimer = LULL_SECONDS;
          this.bunkerHp = Math.min(this.bunkerMax, this.bunkerHp + WAVE_REPAIR);
          this.hud.showWave(`제${this.day}파 격퇴 — 보루 수리 +${WAVE_REPAIR}`);
          this.startKillCam();
        }
        // First reward after the opening wave, then every other wave —
        // deferred until the kill cam releases the frame.
        if ((this.day === 1 || this.day % 2 === 0) && !this.godmode) this.pendingUpgrade = true;
      }
    } else {
      this.lullTimer -= delta;
      if (this.lullTimer <= 0) this.startWave(this.day + 1);
    }
  }

  /** 새벽 장 — the chapter break. Five waves is one night; surviving the
   *  대격노 that closes it earns a breath of gold: remaining 원귀 freeze
   *  into ash, the yard keeps its painting (blood pools + seal sigils),
   *  the talisman drinks a free charge, and then night two falls. */
  private beginDawn(): void {
    this.dawnTimer = 9.5;
    this.horde.freezeAll();
    this.world.setTimeOfDay('dawn');
    this.bunkerHp = Math.min(this.bunkerMax, this.bunkerHp + 400);
    this.sealCharge = Math.min(1, this.sealCharge + 0.4);
    this.hud.stamp('曉', `밤${this.nightNumber} 완성`);
    this.hud.showWave(`새벽 — 밤${this.nightNumber}의 그림이 완성되었다`);
    this.audio.roar();
    this.audio.drum(0.6);
    this.fovPunch = Math.min(1.4, this.fovPunch + 0.5);
  }

  /** Chapter count — five waves per night; the painting is titled by it. */
  private get nightNumber(): number {
    return Math.max(1, Math.ceil(this.day / 5));
  }

  // ── Dawn-era upgrades, gatling flavored ────────────────────────────────

  private static readonly UPGRADE_POOL = [
    {
      id: 'coolant',
      title: '냉각수 주입',
      desc: '발열 -30%',
      apply: (game: Game) => { game.heatMult *= 0.7; },
    },
    {
      id: 'barrel',
      title: '벼려낸 배럴',
      desc: '탄당 피해 +1',
      apply: (game: Game) => { game.dmgPerShot += 1; },
    },
    {
      id: 'belt',
      title: '과충전 탄띠',
      desc: '가속 +40% · 연사 +3',
      apply: (game: Game) => {
        game.spinMult *= 1.4;
        game.rateBonus += 3;
      },
    },
    {
      id: 'masonry',
      title: '보루 공사',
      desc: '최대 내구 +250 · 전량 수리',
      apply: (game: Game) => {
        game.bunkerMax += 250;
        game.bunkerHp = game.bunkerMax;
      },
    },
    {
      id: 'sulfur',
      title: '유황 탄두',
      desc: '적중 지점 주변 추가 피해',
      apply: (game: Game) => { game.splash = true; },
    },
    {
      id: 'gyro',
      title: '자이로 안정기',
      desc: '탄착군 35% 축소',
      apply: (game: Game) => { game.spreadMult *= 0.65; },
    },
    {
      id: 'pounder',
      title: '파쇄 탄심',
      desc: '넉백 80% 증가 — 무리가 갈라진다',
      apply: (game: Game) => { game.forceMult *= 1.8; },
    },
    {
      id: 'tracer',
      title: '야광 조준기',
      desc: '타격 반경 60% 확장',
      apply: (game: Game) => { game.assistMult *= 1.6; },
    },
  ];

  private openUpgradeChoice(): void {
    // Sulfur is boolean — never offer it twice.
    const pool = Game.UPGRADE_POOL.filter((upgrade) => !(upgrade.id === 'sulfur' && this.splash));
    const choices: typeof Game.UPGRADE_POOL = [];
    for (let i = 0; i < 3 && pool.length > 0; i += 1) {
      choices.push(pool.splice(Math.floor(this.rng() * pool.length), 1)[0]);
    }
    this.upgradeOpen = true;
    this.hud.showUpgradeChoice(choices, (index) => {
      choices[index].apply(this);
      this.upgradeOpen = false;
    });
  }

  private readonly onUpgradeKey = (event: KeyboardEvent) => {
    if (!this.upgradeOpen) return;
    const index = ['Digit1', 'Digit2', 'Digit3'].indexOf(event.code);
    if (index >= 0) {
      const card = document.querySelectorAll('.upgrade-card')[index] as HTMLElement | undefined;
      card?.dispatchEvent(new PointerEvent('pointerdown'));
    }
  };

  private readonly onMuteKey = (event: KeyboardEvent) => {
    if (event.code === 'KeyM') this.toggleMute();
  };

  private readonly onMuteClick = () => this.toggleMute();

  private toggleMute(): void {
    this.audio.unlock();
    const muted = !this.audio.isMuted;
    this.audio.setMuted(muted);
    const button = document.querySelector<HTMLElement>('#mute-button');
    if (button) {
      button.setAttribute('aria-pressed', String(muted));
      button.textContent = muted ? '음소거' : '소리';
      button.setAttribute('aria-label', muted ? '소리 켜기' : '소리 끄기');
    }
    this.toast(muted ? '소리를 끈다 (M)' : '소리를 켠다 (M)');
  }

  // ── Main update ───────────────────────────────────────────────────────

  private update(delta: number): void {
    this.frame += 1;
    if (this.pausedForScreenshot) {
      this.publishDiagnostics();
      return;
    }

    // Brute-kill slow motion — the clip moment ramps 0.3× back to full speed.
    // The final-blow kill cam freezes deeper still.
    if (this.slowmoTimer > 0) this.slowmoTimer -= delta;
    if (this.killCamTimer > 0) this.killCamTimer -= delta;
    const baseScale = this.slowmoTimer > 0 ? 0.3 + 0.7 * (1 - this.slowmoTimer / 0.6) : 1;
    const gameScale = this.killCamTimer > 0 ? Math.min(baseScale, 0.16) : baseScale;
    const cinema = this.slowmoTimer > 0 || this.killCamTimer > 0;
    if (cinema !== this.cinemaBarsOn) {
      this.cinemaBarsOn = cinema;
      this.getElement('#cinema-bars').classList.toggle('on', cinema);
    }
    const gameDelta = delta * gameScale;
    const animDelta = this.reducedMotion ? 0 : gameDelta;
    this.elapsed += gameDelta;
    this.resizeIfNeeded();

    if (this.mode === 'title') {
      this.updateTitle(animDelta);
      this.publishDiagnostics();
      return;
    }

    if (this.mode !== 'playing') {
      this.world.update(animDelta);
      this.hud.update(delta);
      // Slow reveal: the frame holds on the fallen rampart before the card.
      if (this.deathTimer > 0) {
        this.deathTimer -= delta;
        this.applyQuarterCamera(delta);
        if (this.deathTimer <= 0) this.showEndScreen();
      }
      this.publishDiagnostics();
      return;
    }

    if (this.upgradeOpen) {
      this.world.update(animDelta);
      this.hud.update(delta);
      this.publishDiagnostics();
      return;
    }

    this.updateAim(delta);
    this.updateGatling(gameDelta);
    // 새벽 장 clock: when the gold breath runs out, the next night falls.
    if (this.dawnTimer > 0) {
      this.dawnTimer -= gameDelta;
      if (this.dawnTimer <= 0) {
        this.world.setTimeOfDay('night');
        this.lullTimer = 5;
        this.hud.showWave('다시 밤이 내린다');
        this.audio.setPhase('night');
      }
    }
    this.updateWaves(gameDelta);
    this.updateHorde(gameDelta);
    this.updateFx(gameDelta, animDelta);
    this.updateHints(gameDelta);

    // Adaptive threat bed: the score swells with the horde; a failing gate
    // gets a heartbeat — and when it is truly failing, the night turns red.
    this.audio.setThreat(Math.min(1, this.horde.activeCount / 70));
    this.audio.updateThreat(delta);
    if (!this.godmode && this.bunkerHp < this.bunkerMax * 0.3) this.audio.heartbeat();
    const bloodTarget = !this.godmode && this.bunkerHp < this.bunkerMax * 0.28 ? 1 : 0;
    this.bloodNight += (bloodTarget - this.bloodNight) * Math.min(1, delta * 1.4);
    if (this.bloodNight > 0.5 && !this.bloodNightAnnounced) {
      this.bloodNightAnnounced = true;
      this.hud.showWave('보루가 무너진다 — 붉은 밤');
      this.hud.stamp('危', '붉은 밤');
      this.hud.impactFlash();
      this.audio.roar();
    } else if (this.bloodNight < 0.1) {
      this.bloodNightAnnounced = false;
    }
    const bloodPulse = this.bloodNight > 0.05 ? 0.82 + 0.18 * Math.sin(this.elapsed * 5.2) : 1;
    this.world.setBloodNight(this.bloodNight * bloodPulse);
    // Concentration lines during the kill cam and the blood night.
    this.hud.setSpeedlines(this.killCamTimer > 0 || this.bloodNight > 0.4);
    // The score follows the blood night in and out. Before the first wave
    // the theme carries the opening statement; after a clear, the relief.
    const bgmTarget = this.bloodNight > 0.5 ? 'bloodnight'
      : this.waveActive ? (this.day % 5 === 0 ? 'tide' : 'wave')
      : this.day >= 1 ? 'lull'
      : 'title';
    this.audio.setBgmState(bgmTarget);

    this.world.setFocusTarget(this.tmpV.set(this.bunkerX, this.bunkerGroundY, this.bunkerZ));
    this.world.update(animDelta);
    this.applyQuarterCamera(delta);

    this.hud.setHeat(this.heat, this.ventTimer > 0, this.spin);
    this.hud.setSeal(this.sealCharge);
    if (this.sealCharge >= 1 && !this.sealAnnounced) {
      this.sealAnnounced = true;
      this.hud.showWave('부적이 가득 찼다 — 다음 발사가 봉인이 된다');
      this.audio.bell();
    } else if (this.sealCharge < 1) {
      this.sealAnnounced = false;
    }
    this.hud.setWave(this.day, this.waveSpawnQueue + this.horde.activeCount);
    this.hud.update(delta);
    this.publishDiagnostics();
  }

  private updateTitle(delta: number): void {
    this.titleOrbit += delta * 0.05;
    const queries = this.world.queries();
    const radius = queries.villageRadius() * 0.55;
    const x = Math.cos(this.titleOrbit) * radius;
    const z = Math.sin(this.titleOrbit) * radius;
    this.world.camera.position.set(x, queries.heightAt(x, z) + 26, z);
    this.world.camera.lookAt(0, queries.heightAt(0, 0) + 4, 0);
    this.world.update(delta);
  }

  // ── Aim + camera ──────────────────────────────────────────────────────

  private updateAim(delta: number): void {
    const look = this.input.consumeLook();
    this.lastFireHeld = look.fireHeld;

    const pointer = this.input.readPointer();
    if (pointer.has) {
      // Letterbox-safe: pointer events are window-space, the portrait
      // column floats centered — convert through the canvas rect and clamp
      // to the frame so outside-column moves park the aim at an edge.
      const rect = this.canvas.getBoundingClientRect();
      this.aimNdc.set(
        Math.max(-1, Math.min(1, ((pointer.x - rect.left) / Math.max(1, rect.width)) * 2 - 1)),
        Math.max(-1, Math.min(1, -((pointer.y - rect.top) / Math.max(1, rect.height)) * 2 + 1)),
      );
      this.raycaster.setFromCamera(this.aimNdc, this.world.camera);
      this.groundPlane.set(new THREE.Vector3(0, 1, 0), -this.bunkerGroundY);
      if (this.raycaster.ray.intersectPlane(this.groundPlane, this.tmpV)) {
        this.aimPoint.copy(this.tmpV);
      }
    }

    // Keep the ring inside the kill yard: a radial clamp, all directions.
    const maxAim = 55;
    const adx = this.aimPoint.x - this.bunkerX;
    const adz = this.aimPoint.z - this.bunkerZ;
    const aimDist = Math.hypot(adx, adz);
    if (aimDist > maxAim) {
      this.aimPoint.x = this.bunkerX + (adx / aimDist) * maxAim;
      this.aimPoint.z = this.bunkerZ + (adz / aimDist) * maxAim;
    }

    const dx = this.aimPoint.x - this.bunkerX;
    const dz = this.aimPoint.z - this.bunkerZ;
    const aimYaw = Math.abs(dx) + Math.abs(dz) > 0.5 ? Math.atan2(dx, dz) : 0;
    // Feed the rig pan: the bearing from the gun to the aim ring.
    if (Math.hypot(dx, dz) > 6) this.camYawTarget = Math.atan2(dx, dz);
    this.gunnerInstance?.setAim(aimYaw);

    if (this.aimRing) {
      // Sample the terrain under the ring — the plaza undulates, a fixed
      // bunker-height offset buries the annulus under the ground mesh.
      const queries = this.world.queries();
      this.aimRing.position.set(
        this.aimPoint.x,
        queries.heightAt(this.aimPoint.x, this.aimPoint.z) + 0.2,
        this.aimPoint.z,
      );
      // 봉인 준비 — the ring goes paper-white and breathes: the armed
      // talisman reads at a glance against the red idle reticle.
      const armed = this.sealCharge >= 1;
      const pulse = armed
        ? 1.2 + Math.sin(this.elapsed * 9) * 0.08
        : look.fireHeld ? 1 + Math.sin(this.elapsed * 18) * 0.12 : 1;
      this.aimRing.scale.setScalar(pulse);
      const ringMat = this.aimRing.material as THREE.MeshBasicMaterial;
      ringMat.color.setHex(armed ? 0xfff1e2 : 0xff2a1c);
      ringMat.opacity = armed ? 1 : look.fireHeld ? 1 : 0.92;
    }
    void delta;
  }

  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /** Fixed quarter-view camera with trauma jitter, a soft aim bias,
   *  filmic idle drift, event FOV punches and a slow wave-start dolly. */
  private applyQuarterCamera(delta: number): void {
    this.shakeTime += delta;
    this.shakeTrauma = Math.max(0, this.shakeTrauma - delta * 1.7);
    const shake = this.shakeTrauma * this.shakeTrauma;
    const freq = this.shakeTime * 34;

    // FOV punch: booms/brute kills snap the lens in, then ease out.
    this.fovPunch = Math.max(0, this.fovPunch - delta * 2.2);
    // Wave-start dolly: settle from 5m back over ~2.4s.
    this.dollyEase = Math.min(1, this.dollyEase + delta * 0.42);
    const dollyBack = (1 - this.dollyEase) * (1 - this.dollyEase) * 5;

    const cam = this.world.camera;
    // Telephoto quarter view around the yard pivot: the camera orbits the
    // gatling at a distance (gun reads SMALL, an anchor — not the subject),
    // through a narrow lens (zombies at 15-40m read as full figures with
    // horns/claws/stride), from ~29° above grade. The view PANS toward the
    // aim with a deadzone — sweep the pointer to an edge to look around the
    // ring; recentre to settle. D = orbit radius, H = eye height.
    // 모바일 중심 세로형 단일 구성: the phone lens is THE lens — desktop
    // letterboxes the same column. Over the open field at a cinematic
    // pitch (~35°): hFov 36 keeps the zoom, lookAhead 10 holds the gun in
    // the lower third, and the lowered eye stands the fallen palace UP in
    // the background — the horde reads full-body mid-frame.
    const qv = { dist: 26, height: 27, lookAhead: 10, fov: 0, hFov: 36 };
    let baseFov = 40;
    {
      const aspect = Math.max(0.5, Math.min(2.2, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight)));
      baseFov = (2 * Math.atan(Math.tan((qv.hFov * Math.PI) / 360) / aspect) * 180) / Math.PI;
      baseFov = Math.min(72, Math.max(40, baseFov));
    }
    const targetFov = baseFov - this.fovPunch * 7;
    if (Math.abs(cam.fov - targetFov) > 0.01) {
      cam.fov = targetFov;
      cam.updateProjectionMatrix();
    }

    // Bounded pan: the rig FACES THE RIVER (fixed south-west axis) and the
    // pointer can nudge it ±20° — never free-spin. The old aim-follow loop
    // fed itself (camera turns → aim ray sweeps → camera turns…) and idled
    // in circles; the clamp breaks the loop by construction.
    const baseYaw = Math.PI;
    const panLimit = 0.35;
    let dyaw = this.camYawTarget - this.camYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const deadzone = 0.17; // ~10°: pointer near centre = no pan
    const beyond = Math.abs(dyaw) > deadzone ? dyaw - Math.sign(dyaw) * deadzone : 0;
    const pan = Math.max(-2.2 * delta, Math.min(2.2 * delta, beyond * Math.min(1, delta * 3.2)));
    this.camYaw = Math.max(baseYaw - panLimit, Math.min(baseYaw + panLimit, this.camYaw + pan));

    const dolly = qv.dist + dollyBack;
    const fwdX = Math.sin(this.camYaw);
    const fwdZ = Math.cos(this.camYaw);
    // No positional drift while defending: a locked-off telephoto lens —
    // shake still lands on impacts.
    cam.position.set(
      this.gunX - fwdX * dolly + shake * 0.5 * pseudoNoise(freq, 1),
      this.gunGroundY + qv.height + shake * 0.35 * pseudoNoise(freq, 2),
      this.gunZ - fwdZ * dolly,
    );
    this.lookTarget.lerp(
      this.tmpV.set(
        this.bunkerX + fwdX * qv.lookAhead,
        this.bunkerGroundY + 2.0,
        this.bunkerZ + fwdZ * qv.lookAhead,
      ),
      Math.min(1, delta * 4),
    );
    cam.lookAt(this.lookTarget);
    cam.rotation.z += shake * 0.015 * pseudoNoise(freq, 3);

    // ── Kill cam override: swing around the final launch in deep freeze. ──
    if (this.killCamBlend > 0 && this.killCamTimer > 0) {
      this.killCamOrbit += delta * 1.05;
      const queries = this.world.queries();
      const fx = this.lastKillX;
      const fz = this.lastKillZ;
      const fy = queries.heightAt(fx, fz) + 1.3;
      const dx0 = cam.position.x - fx;
      const dz0 = cam.position.z - fz;
      const radius = Math.min(Math.max(Math.hypot(dx0, dz0), 13), 20);
      const angle = Math.atan2(dx0, dz0) + this.killCamOrbit;
      const kx = fx + Math.sin(angle) * radius;
      const kz = fz + Math.cos(angle) * radius;
      const ky = queries.heightAt(kx, kz) + 11;
      const b = this.killCamBlend;
      cam.position.lerp(this.tmpV.set(kx, ky, kz), b);
      cam.lookAt(fx, fy, fz);
      cam.rotation.z += 0.025 * b;
      this.lookTarget.set(fx, fy, fz);
      // Blend out over the last moments so the cut back is a move, not a snap.
      this.killCamBlend = this.killCamTimer > 0.35 ? 1 : Math.max(0, this.killCamTimer / 0.35);
    } else {
      this.killCamBlend = 0;
    }
  }

  /** Directed beat for the wave's final blow. */
  private startKillCam(): void {
    this.killCamTimer = 1.25;
    this.killCamBlend = 1;
    this.killCamOrbit = 0;
    this.audio.drum(0.5);
    this.world.impactAberration(0.9);
    this.hud.stamp('終', `제${this.day}파 격파`);
    this.hud.setSpeedlines(true);
  }

  private fovPunch = 0;
  private dollyEase = 1;
  /** Orbit yaw of the telephoto rig (-π/2 = looking west across the yard);
   *  pans with aim. The east-side stand-off keeps the camera OUT of the
   *  palace volume — shooting through it cost ~20fps of overdraw. */
  private camYaw = Math.PI;
  private camYawTarget = Math.PI;
  private cinemaBarsOn = false;
  // Final-blow kill cam: freeze, orbit the last launch, letterbox.
  private killCamTimer = 0;
  private killCamBlend = 0;
  private killCamOrbit = 0;
  private lastKillX = 0;
  private lastKillZ = -10;
  private pendingUpgrade = false;
  // Blood Night: the grade inversion when the gate is failing.
  private bloodNight = 0;
  private bloodNightAnnounced = false;

  private readonly lookTarget = new THREE.Vector3(0, 0, -3);

  // ── Gatling ───────────────────────────────────────────────────────────

  private updateGatling(delta: number): void {
    if (this.ventTimer > 0) {
      this.ventTimer -= delta;
      this.spin = Math.max(0, this.spin - delta * 2.4);
      this.heat = Math.max(0, this.heat - delta * 0.5);
      if (this.ventTimer <= 0) {
        this.heat = 0;
      }
    } else {
      const firing = this.lastFireHeld;
      if (firing) {
        this.spin = Math.min(1, this.spin + (delta * this.spinMult) / SPIN_UP_SECONDS);
        this.shakeTrauma = Math.min(1, this.shakeTrauma + delta * (0.35 + this.spin * 0.5));
      } else {
        this.spin = Math.max(0, this.spin - delta * 1.6);
      }
      this.heat = Math.max(0, this.heat - HEAT_DECAY * delta * (firing ? 0.25 : 1));

      if (firing && this.spin > 0.12) {
        this.fireCooldown -= delta;
        const rate = FIRE_RATE_MIN + (FIRE_RATE_MAX - FIRE_RATE_MIN + this.rateBonus) * this.spin;
        while (this.fireCooldown <= 0) {
          this.fireCooldown += 1 / rate;
          this.fireShot();
          if (this.heat >= 1) {
            this.ventTimer = VENT_SECONDS;
            this.audio.vent();
            this.hud.showWave('과열 — 냉각 중!');
            this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.5);
            break;
          }
        }
        if (this.fireCooldown < 0) this.fireCooldown = 0;
      } else {
        this.fireCooldown = Math.min(this.fireCooldown, 0.02);
      }
    }

    this.gunnerInstance?.setSpinRate(this.spin);
    this.gunnerInstance?.setHeat(this.heat);
    this.audio.setGatling(this.spin);
  }

  private lastFireHeld = false;

  private fireShot(): void {
    const gun = this.gunnerInstance;
    if (!gun) return;

    // 봉인 준비됨 — the armed talisman claims the next trigger stroke.
    if (this.sealCharge >= 1) {
      this.fireSeal();
      return;
    }

    const muzzle = gun.muzzleWorld(new THREE.Vector3());
    // Fire toward the ground aim point (horizontal), from the turret muzzle.
    const aimX = this.aimPoint.x - muzzle.x;
    const aimZ = this.aimPoint.z - muzzle.z;
    const aimLen = Math.hypot(aimX, aimZ);
    if (aimLen < 0.5) return;
    const baseX = aimX / aimLen;
    const baseZ = aimZ / aimLen;

    // Spread grows with heat, shrinks with spin stabilization.
    const spreadRad = (0.011 + this.heat * 0.05) * this.spreadMult;
    const a = this.rng() * Math.PI * 2;
    const r = Math.sqrt(this.rng()) * spreadRad;
    const rightX = -baseZ;
    const rightZ = baseX;
    const shotX = baseX + rightX * Math.cos(a) * r;
    const shotZ = baseZ + rightZ * Math.cos(a) * r;
    const shotLen = Math.hypot(shotX, shotZ) || 1;
    const dirX = shotX / shotLen;
    const dirZ = shotZ / shotLen;

    gun.flash();
    this.audio.gatlingShot(this.spin, () => this.rng());
    this.heat += HEAT_PER_SHOT * this.heatMult;

    // Vertical fan: bullets walk up the target (0.25-3.6m above the aim
    // ground) so a hosed house erodes roof-to-base, not just a waist band.
    const fanLen = Math.hypot(this.aimPoint.x - muzzle.x, this.aimPoint.z - muzzle.z) || 30;
    const aimGroundY = this.world.queries().heightAt(this.aimPoint.x, this.aimPoint.z);
    const targetY = aimGroundY + 0.25 + this.rng() * 1.3 + this.rng() * this.rng() * 7;
    const shotSlope = (targetY - muzzle.y) / fanLen;

    const hit = this.horde.queryRay(
      muzzle.x, muzzle.z, dirX, dirZ, 160, AIM_ASSIST_RADIUS * this.assistMult, this.rayHits,
    );
    const houseHit = this.world.houseHitTest(muzzle.x, muzzle.z, dirX, dirZ, 160);
    this.shotsFired += 1;
    if (hit && (!houseHit || this.rayHits[0].dist <= houseHit.dist)) {
      this.shotsHit += 1;
    }
    const shotForce = SHOT_FORCE * this.forceMult;
    let endX: number;
    let endZ: number;
    let endY: number;
    if (hit && (!houseHit || this.rayHits[0].dist <= houseHit.dist)) {
      const record = this.rayHits[0];
      endX = record.x;
      endZ = record.z;
      endY = this.world.queries().heightAt(endX, endZ) + 1.0;
      const killed = this.horde.damage(
        record.index, dirX, dirZ, shotForce,
        (position, elite, kx, kz, type) => this.onZombieKilled(position, elite, kx, kz, type),
        this.dmgPerShot,
        (sx, sz) => this.onShieldBreak(sx, sz, dirX, dirZ),
      );
      if (killed === 'armor') {
        // Rounds skate off the door plating — sparks, no flesh.
        this.vfx.armorSpark(endX, endY, endZ, dirX, dirZ, () => this.rng());
        if (this.clankSfxTimer <= 0) {
          this.clankSfxTimer = 0.05;
          this.audio.armorClank();
        }
      } else {
        this.vfx.hitSpark(endX, endY, endZ, dirX, dirZ, () => this.rng());
        this.vfx.bloodBurst(endX, endY, endZ, dirX, dirZ, killed === 'kill' ? 8 : 4, () => this.rng());
        if (killed !== 'kill') this.gibs.hitSpray(endX, endY - 0.3, endZ, dirX, dirZ, () => this.rng());
        if (this.impactSfxTimer <= 0) {
          this.impactSfxTimer = 0.05;
          this.audio.impact();
        }
      }
      if (this.splash && killed !== 'armor') {
        const splashIndex = this.horde.queryPoint(endX + dirX * 0.8, endZ + dirZ * 0.8, 1.3);
        if (splashIndex >= 0 && splashIndex !== record.index) {
          this.horde.damage(splashIndex, dirX, dirZ, shotForce, (position, elite, kx, kz, type) => {
            this.onZombieKilled(position, elite, kx, kz, type);
          }, this.dmgPerShot);
        }
      }
    } else if (houseHit) {
      // 너덜너덜 — the bullet chews cubes out of the house where it lands.
      endX = houseHit.x;
      endZ = houseHit.z;
      endY = muzzle.y + shotSlope * houseHit.dist;
      this.shotsHit += 1;
      this.chewHouse(houseHit.index, endX, endY, endZ, dirX, dirZ, 2.0 + (this.splash ? 1.5 : 0));
    } else {
      // Misses terminate inside the visible murk, not at the 160m logic cap,
      // so tracers read as short streaks instead of dying in fog.
      const missDist = 90 + this.rng() * 40;
      endX = muzzle.x + dirX * missDist;
      endZ = muzzle.z + dirZ * missDist;
      endY = muzzle.y + shotSlope * missDist - 0.6;
    }

    this.tracers.spawnTracer(muzzle, this.tmpV2.set(endX, endY, endZ));
    // Casing ejects to the gun's right.
    this.tracers.spawnCasing(muzzle.x, muzzle.y, muzzle.z, rightX, rightZ, () => this.rng());
  }

  /** 부적 봉인포 — the seal round. A full talisman claims the next trigger
   *  stroke: a paper-white flash, every 원귀 inside the ring unmade (door
   *  plating burns with the flesh), and a red sigil stamped into the yard
   *  FOREVER — the mark survives to the dawn card as part of the painting.
   *  Purge victims don't re-ink the talisman, so the seal can't chain itself. */
  private fireSeal(): void {
    const x = this.aimPoint.x;
    const z = this.aimPoint.z;
    const y = this.world.queries().heightAt(x, z) + 1.2;
    this.sealCharge = 0;
    this.sealing = true;
    const purged = this.horde.purgeRadius(x, z, 9.5, (position, elite, dirX, dirZ, type) => {
      this.onZombieKilled(position, elite, dirX, dirZ, type);
    });
    this.sealing = false;
    this.bloodYard?.paintSigil(x, z, 9.5, () => this.rng());
    // 정화 — pale souls lift out of the ring while the paper burns white.
    this.vfx.frostShimmer(x, y, z, 26, () => this.rng());
    this.vfx.demolitionDust(x, y, z, 10, () => this.rng());
    this.audio.bell();
    this.audio.boom();
    this.hud.impactFlash();
    this.hud.stamp('封', purged >= 14 ? `대봉인 — ${purged}체 정화` : `부적 봉인 — ${purged}체 정화`);
    this.sealStampLock = 1.6;
    this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.6);
    this.fovPunch = Math.min(1.4, this.fovPunch + 1.0);
    this.world.impactAberration(2.2);
    this.slowmoTimer = 0.5;
    this.audio.drum(0.8);
  }

  /** 한 오판 잎chew — bullets carve cubes out of a house; the debris pool
   *  carries them away. Hits spark, crack and dust; the house erodes where
   *  you aim. Past the structure threshold the whole thing pancakes. */
  private chewHouse(index: number, x: number, y: number, z: number, dirX: number, dirZ: number, radius: number): void {
    const vox = this.world.voxelHouseManager();
    if (!vox || vox.isCollapsed(index)) return;
    this.chewScratch.length = 0;
    // Entry burst — the face splinters back toward the gun (a spray, not a jet).
    vox.chew(x, y, z, radius, this.chewScratch);
    let burst = Math.min(14, this.chewScratch.length);
    if (this.chewScratch.length > 0) {
      const half = vox.halfSize(index);
      const stride = Math.max(1, Math.floor(this.chewScratch.length / burst));
      for (let i = 0; i < this.chewScratch.length && burst > 0; i += stride) {
        const cube = this.chewScratch[i];
        burst -= 1;
        this.rubble?.spawnRubble(
          cube.x, cube.y, cube.z, half * (0.6 + this.rng() * 0.2), cube.r, cube.g, cube.b,
          dirX * (5.5 + this.rng() * 5) + (this.rng() - 0.5) * 8,
          2.5 + this.rng() * 3.5,
          dirZ * (5.5 + this.rng() * 5) + (this.rng() - 0.5) * 8,
          (this.rng() - 0.5) * 14, (this.rng() - 0.5) * 14, (this.rng() - 0.5) * 14,
        );
      }
    }
    // 관통 — the round exits the far side carrying the wall with it: debris
    // JETS out the BACK (faster than it entered), raining behind the house.
    // Old thatch is weak; the gatling is not.
    this.chewScratch.length = 0;
    vox.chew(x + dirX * 2.4, y, z + dirZ * 2.4, radius * 0.78, this.chewScratch);
    vox.chew(x + dirX * 4.8, y, z + dirZ * 4.8, radius * 0.78, this.chewScratch);
    if (this.chewScratch.length > 0) {
      // box3d 강체 — chunks at CELL size (never bigger: debris larger than
      // the wall it came from reads fake), strided across the whole tunnel.
      const half = vox.halfSize(index);
      const budget = Math.min(34, this.chewScratch.length);
      const stride = Math.max(1, Math.floor(this.chewScratch.length / budget));
      let spawned = 0;
      for (let i = 0; i < this.chewScratch.length && spawned < budget; i += stride) {
        const cube = this.chewScratch[i];
        spawned += 1;
        this.rubble?.spawnRubble(
          cube.x, cube.y, cube.z, half * (0.6 + this.rng() * 0.2), cube.r, cube.g, cube.b,
          dirX * (13 + this.rng() * 12) + (this.rng() - 0.5) * 6,
          1 + this.rng() * 3,
          dirZ * (13 + this.rng() * 12) + (this.rng() - 0.5) * 6,
          (this.rng() - 0.5) * 16, (this.rng() - 0.5) * 16, (this.rng() - 0.5) * 16,
        );
      }
      this.vfx.hitSpark(x, y, z, dirX, dirZ, () => this.rng());
      if (this.woodSfxTimer <= 0) {
        this.woodSfxTimer = 0.07;
        this.audio.armorClank();
      }
      this.vfx.demolitionDust(x, y + 0.6, z, 7, () => this.rng());
      this.debris?.chipBurst(x, y, z, dirX, dirZ, 10, () => this.rng());
      this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.03);
    }
    if (vox.aliveRatio(index) < 0.78) this.collapseHouse(index);
  }

  /** 구조 붕괴 — the remaining cubes pancake roof-first; the street loses
   *  a building, the talisman drinks its due. */
  private collapseHouse(index: number): void {
    const vox = this.world.voxelHouseManager();
    if (!vox || vox.isCollapsed(index)) return;
    const center = vox.houseCenter(index);
    const isPalace = this.world.palaceVoxelIndex === index;
    // A slice of the structure becomes REAL rigid bodies — the rest rides
    // the staged fall animation; the bodies pile where they land.
    this.chewScratch.length = 0;
    const taken = vox.takeVoxels(index, isPalace ? 380 : 300, this.chewScratch);
    if (taken > 0 && this.rubble) {
      const half = vox.halfSize(index);
      for (const cube of this.chewScratch) {
        const dx = cube.x - center.x;
        const dz = cube.z - center.z;
        const len = Math.hypot(dx, dz) || 1;
        this.rubble.spawnRubble(
          cube.x, cube.y, cube.z, half, cube.r, cube.g, cube.b,
          (dx / len) * (2.0 + this.rng() * 4.5),
          0.5 + this.rng() * 5.5,
          (dz / len) * (2.0 + this.rng() * 4.5),
          (this.rng() - 0.5) * 9, (this.rng() - 0.5) * 9, (this.rng() - 0.5) * 9,
        );
      }
    }
    vox.triggerCollapse(index, () => this.rng());
    this.hud.stamp('崩', isPalace ? '궁이 무너진다' : '집이 무너진다');
    this.hud.showWave(isPalace
      ? '궁이 무너진다 — 밤이 끝난다'
      : '한 채가 무너졌다 — 부적에 먹이 들었다');
    this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.5);
    this.fovPunch = Math.min(1.4, this.fovPunch + 0.6);
    this.world.impactAberration(1.4);
    this.slowmoTimer = Math.max(this.slowmoTimer, 0.4);
    this.audio.boom();
    this.audio.drum(0.7);
    this.audio.roar();
    this.vfx.demolitionDust(center.x, center.y + 2, center.z, 22, () => this.rng());
    this.debris?.chipBurst(center.x, center.y + 1, center.z, 0, 0, 22, () => this.rng());
    this.sealCharge = Math.min(1, this.sealCharge + (isPalace ? 0.5 : 0.2));
    this.world.clearObstaclesNear(center.x, center.z, 12);
  }

  private dx01(v: number): number { return v / (Math.abs(v) + 1); }
  private dz01(v: number): number { return v / (Math.abs(v) + 1); }

  /** QA: chew/collapse by world point (test hooks + capture rigs). */
  private debugChewAt(x: number, z: number, y: number, radius: number): number {
    const indices = this.world.houseIndicesNear(x, z, 6);
    if (indices.length === 0) return 0;
    const before = this.world.voxelHouseManager()?.aliveRatio(indices[0]) ?? 1;
    this.chewHouse(indices[0], x, y, z, 0.2, -1, radius);
    const after = this.world.voxelHouseManager()?.aliveRatio(indices[0]) ?? 1;
    return Math.round((before - after) * 1000);
  }

  private readonly chewScratch: Array<{ x: number; y: number; z: number; r: number; g: number; b: number }> = [];
  private woodSfxTimer = 0;
  /** Rolling box3d update cost (ms) — the physics budget probe. */
  private physMs = 0;
  /** Frame budget split: game update vs GPU submit (perf probes). */
  private updateMs = 0;
  private renderMs = 0;
  private collapseDustTimer = 0;

  /** Kill-count drum beats — the shareable "how deep did you get" moments. */
  private static readonly KILL_MILESTONES: ReadonlyArray<{ at: number; text: string }> = [
    { at: 100, text: '백 귀토벌 — 첫 백을 갈았다' },
    { at: 250, text: '이백오십 — 강이 얇아진다' },
    { at: 500, text: '오백 — 저승이 비어간다' },
    { at: 750, text: '칠백오십 — 사신도 지친다' },
    { at: 1000, text: '천 귀토벌 — 전설의 포수' },
    { at: 1500, text: '천오백 — 밤이 두려워한다' },
    { at: 2000, text: '이천 — 이제 개틀링이 무섭다' },
    { at: 3000, text: '삼천 — 살아 있는 흉기' },
  ];

  private checkKillMilestone(): void {
    const list = Game.KILL_MILESTONES;
    while (this.nextMilestone < list.length && this.kills >= list[this.nextMilestone].at) {
      const milestone = list[this.nextMilestone];
      this.hud.showWave(milestone.text);
      this.audio.bell();
      this.fovPunch = Math.min(1.4, this.fovPunch + 0.25);
      this.world.impactAberration(0.5);
      if (milestone.at >= 500) this.hud.stamp('鬼', '귀토벌');
      this.nextMilestone += 1;
    }
    if (this.nextMilestone >= list.length && this.kills >= this.extraMilestone) {
      this.hud.showWave(`${this.kills} 귀 — 멈추지 않는다`);
      this.audio.bell();
      this.extraMilestone += 1000;
    }
  }

  private onZombieKilled(position: THREE.Vector3, elite: boolean, dirX = 0, dirZ = 0, type: ZombieType = 'normal'): void {
    // Variant scoring: brutes are an achievement, bloaters pay for the risk.
    const worth = type === 'brute' ? 5 : type === 'bloater' ? 2 : 1;
    this.kills += worth;
    this.comboCount += 1;
    this.comboTimer = 2.2;
    if (this.comboCount > this.maxCombo) this.maxCombo = this.comboCount;
    if (this.comboCount >= 5) {
      this.hud.setCombo(this.comboCount);
      this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.055);
    }
    this.hud.setScore(this.kills);
    this.checkKillMilestone();
    // Kills ink the talisman (purge victims don't — no runaway seal loops).
    if (!this.sealing) {
      const gain = type === 'brute' ? 0.14 : type === 'bloater' ? 0.05 : type === 'shield' ? 0.03 : 0.022;
      this.sealCharge = Math.min(1, this.sealCharge + gain * (elite ? 1.6 : 1));
    }
    // The yard remembers every kill.
    this.lastKillX = position.x;
    this.lastKillZ = position.z;
    this.bloodYard?.paint(
      position.x, position.z,
      type === 'brute' ? 3.6 : elite ? 2.0 : type === 'runner' ? 1.2 : 1.5,
      () => this.rng(),
    );
    // The detonation: gibs ride the shot, blood sprays wide, meat thumps.
    // Terrain-aware Y — the kill yard undulates and a flat 0.55 buries the
    // burst inside the plaza mesh.
    const gibY = this.world.queries().heightAt(position.x, position.z) + 0.55;
    if (type === 'brute') {
      // The clip moment: the giant folds in slow motion.
      this.slowmoTimer = 0.6;
      this.gibs.burst(position.x, gibY + 0.8, position.z, dirX, dirZ, 26, () => this.rng(), 1.55);
      this.vfx.bloodBurst(position.x, gibY + 0.8, position.z, dirX, dirZ, 18, () => this.rng());
      this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.4);
      this.fovPunch = Math.min(1.4, this.fovPunch + 0.8);
      this.world.impactAberration(2.0);
      this.hud.stamp('巨', '거구 격파');
      this.hud.impactFlash();
      this.audio.drum(0.9);
    } else if (type === 'runner') {
      this.gibs.burst(position.x, gibY, position.z, dirX, dirZ, 8, () => this.rng(), 0.9);
    } else if (type !== 'bloater') {
      this.gibs.burst(position.x, gibY, position.z, dirX, dirZ, elite ? 16 : 10, () => this.rng(), elite ? 1.3 : 1);
      this.vfx.bloodBurst(position.x, gibY, position.z, dirX, dirZ, elite ? 14 : 7, () => this.rng());
    }
    // 시체 강체 — the body itself becomes a box3d corpse: it rides the shot,
    // tumbles, and comes to rest ON the rubble heaps. Brutes hit heavier;
    // bloaters detonate (no corpse — they ARE the blast).
    if (type !== 'bloater' && this.rubble?.ready) {
      const brute = type === 'brute';
      const tint = this.rng();
      const speed = (7.5 + this.rng() * 7) * (brute ? 0.55 : 1);
      // 달빛 로브 — moonlit pale (near-black vanished into the night ground:
      // corpses must READ from the 27m rig or the pile doesn't exist).
      this.rubble.spawnCorpse(
        position.x, gibY + 0.15, position.z,
        this.rng() * Math.PI * 2, brute ? 2.8 : type === 'runner' ? 0.72 : type === 'shield' ? 1.05 : 1,
        0.34 + tint * 0.14 + (elite ? 0.07 : 0), 0.33 + tint * 0.12, 0.4 + (1 - tint) * 0.1,
        dirX * speed, 4.5 + this.rng() * 4, dirZ * speed,
        (this.rng() - 0.5) * 10, (this.rng() - 0.5) * 8, (this.rng() - 0.5) * 10,
      );
    }
    if (this.splatSfxTimer <= 0) {
      this.splatSfxTimer = 0.07;
      this.audio.splat();
    }
  }

  /** Door plating finally gives way — the plank cartwheels away. */
  private onShieldBreak(x: number, z: number, dirX: number, dirZ: number): void {
    const y = this.world.queries().heightAt(x, z) + 0.9;
    this.audio.shieldBreak();
    this.gibs.burst(x, y, z, dirX, dirZ, 4, () => this.rng(), 1.1, 0x6a523c);
    this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.08);
  }

  /** Bloater detonation: red blast, and the gate eats 130 if it was close. */
  private onBloatBoom(x: number, z: number): void {
    const y = this.world.queries().heightAt(x, z) + 1.0;
    this.audio.boom();
    this.gibs.burst(x, y, z, 0, 0, 26, () => this.rng(), 1.5);
    this.vfx.bloodBurst(x, y, z, 0, 0, 16, () => this.rng());
    this.bloodYard?.paint(x, z, 4.6, () => this.rng());
    this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.5);
    this.fovPunch = Math.min(1.4, this.fovPunch + 0.7);
    this.world.impactAberration(1.6);
    if (this.boomStampCooldown <= 0 && this.sealStampLock <= 0) {
      this.boomStampCooldown = 1.2;
      this.hud.stamp('爆', '유폭');
    }
    // Demolition: a blast near a house chews a huge bite out of it —
    // usually enough to trip the structure threshold and pancake it.
    for (const index of this.world.houseIndicesNear(x, z, 10)) {
      this.chewHouse(index, x, y, z, this.dx01(x - this.bunkerX), this.dz01(z - this.bunkerZ), 4.2);
    }
    const dx = x - this.bunkerX;
    const dz = z - this.bunkerZ;
    if (dx * dx + dz * dz < 7 * 7 && !this.godmode) {
      this.bunkerHp -= 130;
      this.hud.damageFlash(1.0);
      this.audio.hurt();
      if (!this.warnedBloat) {
        this.warnedBloat = true;
        this.hud.showWave('종지귀 자폭 — 저 멀리서 터뜨려라');
      }
      if (this.bunkerHp <= 0) this.die();
    }
  }

  private updateHorde(delta: number): void {
    const fear: Array<{ x: number; z: number; r: number }> = [];
    this.horde.update(
      delta,
      this.bunkerX,
      this.bunkerZ,
      false,
      (this.dawnTimer > 0 ? 'dawn' : 'night') as ZombiePhase,
      fear,
      {
        onKill: (position, elite, dirX, dirZ, type) => this.onZombieKilled(position, elite, dirX, dirZ, type),
        onGroan: () => this.audio.groan(),
        onRise: () => undefined,
        onBoom: (x, z) => this.onBloatBoom(x, z),
        onSpawnType: () => undefined,
      },
    );

    // Rampart clawing: capped simultaneous attackers drain integrity.
    // A brute at the wall counts as three pairs of claws.
    if (this.godmode) {
      this.hud.setBunker(this.bunkerHp, this.bunkerMax);
      return;
    }
    let attackers = 0;
    let bruteAtGate = false;
    let threatDx = 0;
    let threatDz = 0;
    this.horde.forEachActive((x, z, state, type) => {
      if (state !== 'chase') return;
      const dx = x - this.bunkerX;
      const dz = z - this.bunkerZ;
      if (dx * dx + dz * dz < CLAW_RANGE * CLAW_RANGE) {
        attackers += type === 'brute' ? 3 : 1;
        threatDx += dx;
        threatDz += dz;
        if (type === 'brute') bruteAtGate = true;
      }
    });
    // 근접 시각화: the claw ring under the gun breathes, and edge flares
    // point at WHERE the bodies closed in (lateral flanks, or behind the
    // camera — the ones you can never see).
    if (this.clawRing) {
      const mat = this.clawRing.material as THREE.MeshBasicMaterial;
      const target = attackers > 0 ? 0.5 + Math.sin(this.elapsed * 9) * 0.28 : 0;
      mat.opacity += (target - mat.opacity) * Math.min(1, delta * 8);
      this.clawRing.scale.setScalar(attackers > 0 ? 1 + Math.sin(this.elapsed * 9) * 0.07 : 1);
    }
    this.threatFlareTimer -= delta;
    if (attackers > 0 && this.threatFlareTimer <= 0) {
      this.threatFlareTimer = 0.45;
      const deg = (Math.atan2(threatDx, -threatDz) * 180) / Math.PI;
      this.hud.threatFlare(deg, Math.min(1, attackers / 5));
    }
    if (attackers > 0) {
      if (!this.hintedWall && this.day <= 2) {
        this.hintedWall = true;
        this.hud.showWave('보루가 잡힌다 — 몸에 붙은 원귀부터 갈아라');
      }
      const effective = Math.min(MAX_CLAW_ATTACKERS, attackers);
      this.bunkerHp -= effective * CLAW_DPS * delta;
      this.hud.damageFlash(0.35 + effective * 0.06);
      this.shakeTrauma = Math.min(1, this.shakeTrauma + delta * 0.4);
      if (this.rng() < delta * 4) this.audio.hurt();
      // Brute slams shake masonry loose off the gate — the wall is taking
      // structural damage, and it shows.
      if (bruteAtGate && this.debris && this.rng() < delta * 1.6) {
        this.debris.chipBurst(
          this.bunkerX, this.bunkerGroundY + 3 + this.rng() * 3, this.bunkerZ + 1.5,
          0, -1, 7, () => this.rng(),
        );
        this.audio.armorClank();
      }
      if (this.bunkerHp <= 0) this.die();
    }
    this.hud.setBunker(this.bunkerHp, this.bunkerMax);
  }

  private updateFx(delta: number, animDelta: number): void {
    this.gunnerInstance?.update(delta, animDelta);
    this.tracers.update(delta, () => this.gunGroundY + 1.62);
    const groundAt = this.world.queries().heightAt;
    this.gibs.update(delta, groundAt);
    this.vfx.update(delta, groundAt);
    this.debris?.update(delta, this.world.queries());
    const physT0 = performance.now();
    this.rubble?.update(delta);
    this.physMs = this.physMs * 0.9 + (performance.now() - physT0) * 0.1;
    this.bloodYard?.update(delta);
    this.impactSfxTimer -= delta;
    this.splatSfxTimer -= delta;
    this.clankSfxTimer -= delta;
    this.boomStampCooldown -= delta;
    this.sealStampLock -= delta;
    this.woodSfxTimer -= delta;
    this.collapseDustTimer -= delta;
    this.world.updateVoxelHouses(delta, (x, y, z) => {
      if (this.collapseDustTimer > 0) return;
      this.collapseDustTimer = 0.18;
      this.vfx.demolitionDust(x, y + 0.4, z, 3, () => this.rng());
    });
    if (this.comboTimer > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this.hud.setCombo(0);
      }
    }
  }

  private impactSfxTimer = 0;
  private splatSfxTimer = 0;
  private clankSfxTimer = 0;
  private boomStampCooldown = 0;
  /** The seal's 封 stamp owns the frame — chained bloater 爆 stamps yield. */
  private sealStampLock = 0;

  /** One controls reminder early in a newcomer's first couple of runs. */
  private updateHints(delta: number): void {
    if (this.hintTimer <= 0) return;
    this.hintTimer -= delta;
    if (this.hintTimer <= 0) {
      this.hud.showWave('조준 — 마우스 이동 · 발사 — 클릭 홀드 · 과열 주의');
    }
  }

  private die(): void {
    this.bunkerHp = 0;
    this.mode = 'dead';
    this.deathTimer = 0.85;
    this.audio.drum(0.7);
    this.audio.playSting('death-sting');
    this.hud.damageFlash(1.3);
    this.shakeTrauma = 1;
    // The gate gives way — the masonry blast that opens the death card.
    this.debris?.chipBurst(
      this.bunkerX, this.bunkerGroundY + 2, this.bunkerZ + 1.5,
      0, -1, 46, () => this.rng(),
    );
    this.debris?.chipBurst(
      this.bunkerX + 3, this.bunkerGroundY + 5, this.bunkerZ,
      0, -1, 24, () => this.rng(),
    );
    this.fovPunch = 1.4;
    this.world.impactAberration(2.4);
  }

  // ── Screens / lifecycle ───────────────────────────────────────────────

  beginRun(): void {
    this.audio.unlock();
    this.mode = 'playing';
    this.hideTitleScreen();
    this.hideEndScreen();
    this.hud.hideUpgradeChoice();
    this.upgradeOpen = false;
    this.day = 0;
    this.kills = 0;
    this.bunkerMax = BUNKER_HP_MAX;
    this.bunkerHp = BUNKER_HP_MAX;
    this.spin = 0;
    this.heat = 0;
    this.ventTimer = 0;
    this.fireCooldown = 0;
    this.comboCount = 0;
    this.hud.setCombo(0);
    this.dmgPerShot = 1;
    this.heatMult = 1;
    this.spinMult = 1;
    this.rateBonus = 0;
    this.splash = false;
    this.spreadMult = 1;
    this.forceMult = 1;
    this.assistMult = 1;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.maxCombo = 0;
    this.nextMilestone = 0;
    this.extraMilestone = 4000;
    this.hintedWall = false;
    this.deathTimer = -1;
    this.announcedBrute = false;
    this.warnedBloat = false;
    this.slowmoTimer = 0;
    this.killCamTimer = 0;
    this.killCamBlend = 0;
    this.pendingUpgrade = false;
    this.bloodNight = 0;
    this.bloodNightAnnounced = false;
    this.sealCharge = 0;
    this.dawnTimer = 0;
    this.world.setBloodNight(0);
    this.hud.setSpeedlines(false);
    const runs = Number(localStorage.getItem('tilldawn-siege-runs') || '0') + 1;
    localStorage.setItem('tilldawn-siege-runs', String(runs));
    this.hintTimer = runs <= 2 ? 2.4 : -1;
    this.elapsed = 0;
    this.waveActive = false;
    this.waveSpawnQueue = 0;
    this.lullTimer = 4;
    this.horde.clearAll();
    this.tracers.clear();
    this.gibs.clear();
    this.vfx.reset();
    this.debris?.clear();
    this.bloodYard?.clear();
    this.world.resetYardHouses();
    this.rubble?.reset();
    this.gunnerInstance?.reset();
    this.hud.setScore(0);
    this.hud.setBunker(this.bunkerHp, this.bunkerMax);
    this.hud.showWave('밤이 시작된다 — 개틀링을 준비하라');
    this.lookTarget.set(0, this.bunkerGroundY + 1, -3);
    this.aimPoint.set(0, this.bunkerGroundY, -14);
    this.world.setTimeOfDay('night', { immediate: true });
    this.audio.setPhase('night');
  }

  showTitle(): void {
    this.mode = 'title';
    this.showTitleScreen();
    this.titleCameraSnap();
    this.updateTitleBest();
    this.audio.setBgmState('title');
  }

  private showTitleScreen(): void {
    this.getElement('#title-screen').classList.add('visible');
    this.hud.setHidden(true);
  }

  private hideTitleScreen(): void {
    this.getElement('#title-screen').classList.remove('visible');
    this.hud.setHidden(false);
  }

  private titleCameraSnap(): void {
    if (!this.world.ready) return;
    const queries = this.world.queries();
    const radius = queries.villageRadius() * 0.55;
    this.world.camera.position.set(radius, queries.heightAt(radius, 0) + 26, 0);
    this.world.camera.lookAt(0, queries.heightAt(0, 0) + 4, 0);
  }

  private showEndScreen(): void {
    const prevBest = Number(localStorage.getItem('tilldawn-siege-best') || '0');
    const prevWave = Number(localStorage.getItem('tilldawn-siege-bestwave') || '0');
    const stats: RunStats = {
      wave: Math.max(1, this.day),
      night: this.nightNumber,
      kills: this.kills,
      maxCombo: this.maxCombo,
      accuracy: this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0,
      survivedSeconds: this.elapsed,
      isRecord: this.kills > prevBest,
    };
    if (stats.isRecord) localStorage.setItem('tilldawn-siege-best', String(this.kills));
    if (this.day > prevWave) localStorage.setItem('tilldawn-siege-bestwave', String(this.day));

    this.getElement('#end-title').textContent = '보루가 함락되었다';
    this.getElement('#end-subtitle').textContent = `밤${stats.night} · 제${stats.wave}파 · 격살 ${this.kills}`;
    this.getElement('#stat-kills').textContent = String(this.kills);
    this.getElement('#stat-combo').textContent = String(this.maxCombo);
    this.getElement('#stat-acc').textContent = `${Math.round(stats.accuracy * 100)}%`;
    this.getElement('#stat-time').textContent = formatSurvival(stats.survivedSeconds);
    this.getElement('#end-best').textContent =
      `최고 — 격살 ${Math.max(prevBest, this.kills)} · 제${Math.max(1, prevWave, this.day)}파`;
    this.getElement('#record-badge').hidden = !stats.isRecord;
    if (stats.isRecord) {
      this.audio.bell();
      this.audio.drum(0.85);
    }
    this.bindShareActions(stats);
    this.updateTitleBest();
    this.getElement('#end-screen').classList.add('visible');
  }

  private bindShareActions(stats: RunStats): void {
    const share = this.getElement('#share-button') as HTMLButtonElement;
    const shot = this.getElement('#shot-button') as HTMLButtonElement;
    const paint = this.getElement('#paint-button') as HTMLButtonElement;
    const run = async (button: HTMLButtonElement, action: () => Promise<string>) => {
      button.disabled = true;
      try {
        const result = await action();
        if (result === 'shared') this.toast('전적을 공유했다');
        else if (result === 'copied') this.toast('전적 복사 완료 — 붙여넣으세요');
        else if (result === 'downloaded') this.toast('장면을 저장했다');
        else this.toast('공유에 실패했다');
      } finally {
        button.disabled = false;
      }
    };
    share.onclick = () => {
      void run(share, () => shareRun(stats));
    };
    shot.onclick = () => {
      void run(shot, () => shareScoreCard(this.canvas, stats));
    };
    paint.onclick = () => {
      void run(paint, () => sharePainting(this.bloodYard?.paintingCanvas ?? null, stats));
    };
  }

  private toast(text: string): void {
    const element = this.getElement('#toast');
    element.textContent = text;
    element.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => element.classList.remove('visible'), 2200);
  }

  private updateTitleBest(): void {
    const element = this.getElement('#title-best');
    const best = Number(localStorage.getItem('tilldawn-siege-best') || '0');
    const wave = Number(localStorage.getItem('tilldawn-siege-bestwave') || '0');
    if (best <= 0 && wave <= 0) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const wavePart = wave >= 1 ? ` · 제${wave}파` : '';
    element.textContent = `최고 기록 — 격살 ${best}${wavePart}`;
  }

  hideEndScreen(): void {
    this.getElement('#end-screen').classList.remove('visible');
  }

  rerollVillage(seed: number, onProgress: (label: string) => void): void {
    this.villageSeed = seed >>> 0;
    void this.world.reroll(this.villageSeed, onProgress).then(() => {
      this.horde.setQueries(this.world.queries());
      this.horde.clearAll();
      this.establishBunker();
      this.tracers.clear();
      if (this.mode === 'title') this.titleCameraSnap();
    });
  }

  get currentMode(): GameMode {
    return this.mode;
  }

  private resizeIfNeeded(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight));
    if (this.lastWidth !== width || this.lastHeight !== height) {
      this.lastWidth = width;
      this.lastHeight = height;
      this.world.resize(width, height);
    }
  }

  private resize(): void {
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.resizeIfNeeded();
  }

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        if (name === 'title') {
          this.hideEndScreen();
          this.showTitle();
        } else if (name === 'active-play' || name === 'night') {
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.startWave(1);
        } else if (name === 'stress') {
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.waveActive = true;
          this.day = 4;
          const dist = [18, this.spawnFar] as const;
          this.horde.spawnWave(150, -Math.PI / 2 + (this.rng() - 0.5) * 0.8, 4, 0.2, 0.55, { brute: 2, bloater: 6, shield: 8, runner: 10 }, dist, { x: this.bunkerX, z: this.bunkerZ });
          this.horde.spawnWave(160, -Math.PI / 2 + (this.rng() - 0.5) * 0.8, 4, 0.2, 0.75, undefined, dist, { x: this.bunkerX, z: this.bunkerZ });
          // Physics stress: an airborne demolition raining while corpses
          // pile under the seal — the box3d worst case in one frame budget.
          const houses = this.world.yardHouses();
          if (houses.length >= 2) {
            for (let i = 0; i < 10; i += 1) {
              const a = i * 0.9;
              this.debugChewAt(houses[0].x + Math.cos(a) * 4, houses[0].z + Math.sin(a) * 3, 1 + (i % 4) * 1.5, 2.0);
            }
            this.debugChewAt(houses[1].x, houses[1].z, 2, 2.4);
            const near = this.world.houseIndicesNear(houses[1].x, houses[1].z, 8);
            if (near.length > 0) this.collapseHouse(near[0]);
          }
          this.horde.purgeRadius(this.bunkerX, this.bunkerZ - 12, 12, (position, elite, kx, kz, type) => this.onZombieKilled(position, elite, kx, kz, type));
        } else if (name === 'bloodnight') {
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.bunkerHp = this.bunkerMax * 0.22;
          this.startWave(this.day >= 1 ? this.day : 2);
        } else if (name === 'tide') {
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.startWave(5);
        } else if (name === 'dawn') {
          // 새벽 장 — the chapter-break ceremony over a painted yard: purge
          // a cluster first so blood + sigil survive into the golden frame.
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.startWave(5);
          this.waveActive = false;
          this.waveSpawnQueue = 0;
          this.horde.clearAll();
          this.horde.spawnWave(
            46, -Math.PI / 2, 4, 0.15, 0.5,
            { brute: 1, bloater: 3, shield: 5, runner: 6 },
            [7, 15], { x: this.bunkerX, z: this.bunkerZ },
          );
          this.aimPoint.set(this.bunkerX, this.bunkerGroundY, this.bunkerZ - 9);
          this.fireSeal();
          this.hintTimer = -1;
          this.beginDawn();
        } else if (name === 'seal') {
          // 부적 봉인 — a packed ring purged by the seal round (QA hook).
          // Aim lands in the OPEN yard south of the hanok row so the sigil
          // is never occluded by a roof in captures.
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.startWave(4);
          this.waveActive = false;
          this.waveSpawnQueue = 0;
          this.horde.clearAll();
          this.horde.spawnWave(
            46, -Math.PI / 2, 4, 0.15, 0.5,
            { brute: 1, bloater: 3, shield: 5, runner: 6 },
            [7, 15], { x: this.bunkerX, z: this.bunkerZ },
          );
          this.aimPoint.set(this.bunkerX, this.bunkerGroundY, this.bunkerZ - 9);
          this.fireSeal();
        } else if (name === 'demolish') {
          // Voxel demolition rig: house[0] chewed ragged by simulated hose
          // bursts, house[1] just tripped its pancake — mid-air capture.
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.startWave(4);
          this.waveActive = false;
          this.waveSpawnQueue = 0;
          this.horde.clearAll();
          this.horde.spawnWave(26, -Math.PI / 2, 4, 0.12, 0.5, { bloater: 2, runner: 4 }, [16, 40], { x: this.bunkerX, z: this.bunkerZ });
          const houses = this.world.yardHouses();
          if (houses.length >= 2) {
            for (let i = 0; i < 9; i += 1) {
              const a = i * 0.7;
              this.debugChewAt(houses[0].x + Math.cos(a) * 5, houses[0].z + Math.sin(a) * 4, 1 + (i % 4) * 1.4, 1.35);
            }
            this.debugChewAt(houses[1].x, houses[1].z, 2, 2.2);
            const near = this.world.houseIndicesNear(houses[1].x, houses[1].z, 8);
            if (near.length > 0) this.collapseHouse(near[0]);
          }
        } else if (name === 'showcase') {
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.bunkerHp = this.bunkerMax * 0.22;
          this.startWave(4);
          this.hud.setCombo(45);
        } else if (name === 'models') {
          // Model-inspection rig: no real wave, just a posed lineup in the court.
          this.hideEndScreen();
          if (this.mode !== 'playing') this.beginRun();
          this.startWave(4);
          this.waveActive = false;
          this.waveSpawnQueue = 0;
          this.horde.spawnLineup(['normal', 'runner', 'shield', 'bloater', 'brute'], this.bunkerX, this.bunkerZ + 10, 2.4, 0);
          // Pose freeze: no marching, no bloater suicides — anatomy shots only.
          this.horde.freezeAll();
        } else if (name === 'dead') {
          this.die();
        } else {
          console.warn(`Unknown test state: ${name}`);
        }
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
      },
      hideDebugUi: (hidden: boolean) => {
        this.debugTools.setHidden(hidden);
      },
      listZombies: () => {
        const list: Array<{ type: string; state: string; x: number; z: number }> = [];
        this.horde.forEachActive((x, z, state, type) => list.push({ type, state, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 }));
        return list;
      },
      showcaseStamp: (char: string, sub: string) => {
        this.hud.stamp(char, sub);
      },
      poseCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 34) => {
        this.world.camera.position.set(px, py, pz);
        this.world.camera.lookAt(tx, ty, tz);
        this.world.camera.fov = fov;
        this.world.camera.updateProjectionMatrix();
      },
      boomAt: (x: number, z: number) => {
        this.onBloatBoom(x, z);
      },
      setSealCharge: (value: number) => {
        this.sealCharge = Math.max(0, Math.min(1, value));
      },
      fireSealAt: (x: number, z: number) => {
        this.aimPoint.set(x, this.bunkerGroundY, z);
        this.fireSeal();
      },
      /** Chew cubes out of the nearest house (voxel demolition QA). */
      chewHouseAt: (x: number, z: number, y = 2, radius = 1.2) =>
        this.debugChewAt(x, z, y, radius),
      /** Force the structure collapse of the house nearest a point. */
      collapseHouseAt: (x: number, z: number) => {
        const indices = this.world.houseIndicesNear(x, z, 8);
        if (indices.length > 0) this.collapseHouse(indices[0]);
      },
      /** Compose the 밤의 그림 card (painting QA) as a data URL. */
      paintingDataUrl: () => buildPaintingCard(this.bloodYard?.paintingCanvas ?? null, {
        wave: Math.max(1, this.day),
        night: this.nightNumber,
        kills: this.kills,
        maxCombo: this.maxCombo,
        accuracy: this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0,
        survivedSeconds: this.elapsed,
        isRecord: false,
      }).toDataURL('image/png'),
      defenseRig: () => ({
        gunX: this.gunX,
        gunY: this.gunGroundY,
        gunZ: this.gunZ,
        gateX: this.bunkerX,
        gateY: this.bunkerGroundY,
        gateZ: this.bunkerZ,
      }),
      /** Village mesh material autopsy (palace voxelize debugging). */
      villageMaterialInfo: () => this.world.villageMaterialInfo(),
      /** Draw census by scene root — the "what eats the frame" probe. */
      sceneCensus: () => this.world.sceneCensus(),
      /** Toggle a composer pass by name (WebKit/Safari pipeline debugging). */
      setPostPassEnabled: (name: string, enabled: boolean) =>
        this.world.setPostPassEnabled(name, enabled),
      /** Scale the desktop IBL envmap (0 = off) — wash probes. */
      setEnvIntensity: (value: number) => this.world.setEnvIntensity(value),
      /** Terrain + staging probe: the north-height profile the defense
       *  placement was measured against, plus house/obstacle layout. */
      stageDebug: () => {
        const q = this.world.queries();
        const heights: Array<{ dz: number; y: number }> = [];
        for (let dz = 24; dz >= -84; dz -= 6) {
          heights.push({ dz, y: +q.heightAt(this.bunkerX, this.bunkerZ + dz).toFixed(2) });
        }
        return {
          villageSeed: this.villageSeed,
          palaceVoxelIndex: this.world.palaceVoxelIndex,
          palace: q.palaceCenter(),
          bunker: {
            x: +this.bunkerX.toFixed(1),
            z: +this.bunkerZ.toFixed(1),
            y: +this.bunkerGroundY.toFixed(2),
          },
          heights,
          houses: this.world.yardHouses(),
          obstaclesNearDefense: q.obstacleRects().filter((r) => {
            const cx = (r.minX + r.maxX) / 2;
            const cz = (r.minZ + r.maxZ) / 2;
            return Math.abs(cx - this.bunkerX) < 50 && Math.abs(cz - this.bunkerZ) < 50;
          }),
        };
      },
      /** Rebuild the village with a specific seed (staging QA across seeds). */
      reroll: (seed: number) => {
        this.villageSeed = seed >>> 0;
        void this.world.reroll(this.villageSeed, () => undefined).then(() => {
          this.horde.setQueries(this.world.queries());
          this.horde.clearAll();
          this.establishBunker();
          this.tracers.clear();
          if (this.mode === 'title') this.titleCameraSnap();
        });
      },
    };
  }

  private publishDiagnostics(): void {
    const info = this.world.renderer.info;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      mode: this.mode,
      phase: this.waveActive ? 'wave' : 'lull',
      day: this.day,
      hp: this.bunkerHp,
      heat: this.heat,
      spin: this.spin,
      kills: this.kills,
      rubble: this.rubble ? this.rubble.bodyCount : -2,
      corpses: this.rubble ? this.rubble.corpseCount : -2,
      windows: this.world.voxelHouseManager()?.glowMesh.count ?? -1,
      physMs: +this.physMs.toFixed(2),
      physAwake: this.rubble?.awakeCount ?? -1,
      updateMs: +this.updateMs.toFixed(2),
      renderMs: +this.renderMs.toFixed(2),
      seal: this.sealCharge,
      dawn: this.dawnTimer > 0,
      night: this.nightNumber,
      zombies: this.horde.activeCount,
      zombiesByType: this.horde.typeCounts(),
      bgm: this.audio.bgmStateName,
      waveQueue: this.waveSpawnQueue,
      player: {
        position: {
          x: this.world.camera.position.x,
          y: this.world.camera.position.y,
          z: this.world.camera.position.z,
        },
        speed: this.spin,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      post: this.world.postDiagnostics(),
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
      },
    } as unknown as ThreeGameDiagnostics;
  }

  private getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  }
}

function pseudoNoise(t: number, seed: number): number {
  const x = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

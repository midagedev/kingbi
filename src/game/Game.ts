import * as THREE from 'three';
import { Loop } from '../core/Loop';
import { InputController } from '../core/InputController';
import { World } from '../world/World';
import { Horde, type ZombiePhase, type ZombieType } from '../entities/Horde';
import { Gunner, makeFlameTexture } from '../entities/Gunner';
import { DebrisPool } from '../entities/DebrisPool';
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
      (delta) => this.update(delta),
      () => this.world.render(),
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
    this.bunkerX = palace ? palace.x : 0;
    this.bunkerZ = palace ? palace.z - 78 : -60;
    this.bunkerGroundY = queries.heightAt(this.bunkerX, this.bunkerZ);
    this.gunX = this.bunkerX;
    this.gunZ = this.bunkerZ;
    this.gunGroundY = this.bunkerGroundY;

    // Keep the kill yard and its convergence ring clear of houses/props.
    this.world.clearObstaclesNear(this.bunkerX, this.bunkerZ, 21);
    this.world.clearObstaclesNear(this.bunkerX, this.bunkerZ + 26, 15);

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
      minX: this.bunkerX - 38,
      maxX: this.bunkerX + 38,
      minZ: this.bunkerZ - 32,
      maxZ: this.bunkerZ + 42,
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
  }

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
          this.horde.spawnWave(batch, spreadBearing, this.day, 0.1 + this.day * 0.015, 1.0, undefined, [16, 34], { x: this.bunkerX, z: this.bunkerZ });
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
      this.aimNdc.set(
        (pointer.x / Math.max(1, this.canvas.clientWidth)) * 2 - 1,
        -(pointer.y / Math.max(1, this.canvas.clientHeight)) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.aimNdc, this.world.camera);
      this.groundPlane.set(new THREE.Vector3(0, 1, 0), -this.bunkerGroundY);
      if (this.raycaster.ray.intersectPlane(this.groundPlane, this.tmpV)) {
        this.aimPoint.copy(this.tmpV);
      }
    }

    // Keep the ring inside the kill yard: a radial clamp, all directions.
    const maxAim = this.compact ? 28 : 38;
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
    const qv = this.compact
      ? { dist: 28, height: 21, lookAhead: 10, fov: 0, hFov: 42 }
      : { dist: 34, height: 30, lookAhead: 6, fov: 32, hFov: 0 };
    let baseFov = qv.fov ?? 40;
    if (this.compact) {
      const aspect = Math.max(0.55, Math.min(2.2, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight)));
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

    const hit = this.horde.queryRay(
      muzzle.x, muzzle.z, dirX, dirZ, 160, AIM_ASSIST_RADIUS * this.assistMult, this.rayHits,
    );
    this.shotsFired += 1;
    if (hit) this.shotsHit += 1;
    const shotForce = SHOT_FORCE * this.forceMult;
    let endX: number;
    let endZ: number;
    let endY: number;
    if (hit) {
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
    } else {
      // Misses terminate inside the visible murk, not at the 160m logic cap,
      // so tracers read as short streaks instead of dying in fog.
      const missDist = 90 + this.rng() * 40;
      endX = muzzle.x + dirX * missDist;
      endZ = muzzle.z + dirZ * missDist;
      endY = muzzle.y - 0.6;
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
    // Demolition: hanok caught in the blast burst into mosaic chunks and
    // their wreckage stops blocking the ground.
    if (this.debris) {
      const hits = this.world.obstaclesNear(x, z, 9);
      for (const box of hits) {
        this.debris.burstBuilding(
          {
            minX: box.min.x, maxX: box.max.x,
            minZ: box.min.z, maxZ: box.max.z,
            baseY: box.min.y, topY: box.max.y,
          },
          x, z, () => this.rng(),
        );
        this.world.hideProxiesNear((box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2, 6);
      }
      if (hits.length > 0) {
        this.world.clearObstaclesNear(x, z, 9);
        this.debris.chipBurst(x, y, z, 0, 0, 10, () => this.rng());
        this.vfx.demolitionDust(x, y + 1, z, 14, () => this.rng());
      }
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
    this.horde.forEachActive((x, z, state, type) => {
      if (state !== 'chase') return;
      const dx = x - this.bunkerX;
      const dz = z - this.bunkerZ;
      if (dx * dx + dz * dz < CLAW_RANGE * CLAW_RANGE) {
        attackers += type === 'brute' ? 3 : 1;
        if (type === 'brute') bruteAtGate = true;
      }
    });
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
    this.bloodYard?.update(delta);
    this.impactSfxTimer -= delta;
    this.splatSfxTimer -= delta;
    this.clankSfxTimer -= delta;
    this.boomStampCooldown -= delta;
    this.sealStampLock -= delta;
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
          const dist = [16, 34] as const;
          this.horde.spawnWave(150, -Math.PI / 2 + (this.rng() - 0.5) * 0.8, 4, 0.2, 0.55, { brute: 2, bloater: 6, shield: 8, runner: 10 }, dist, { x: this.bunkerX, z: this.bunkerZ });
          this.horde.spawnWave(160, -Math.PI / 2 + (this.rng() - 0.5) * 0.8, 4, 0.2, 0.75, undefined, dist, { x: this.bunkerX, z: this.bunkerZ });
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

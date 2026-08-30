/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  mode: string;
  phase: string;
  phaseTime: number;
  day: number;
  hp: number;
  arrows: number;
  kills: number;
  saved: number;
  zombies: number;
  dormant: number;
  player: {
    position: { x: number; y: number; z: number };
    speed: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
  };
  [key: string]: unknown;
}

interface ThreeGameTestHooks {
  /** Re-seed the game RNG; all gameplay randomness must flow through it. */
  seed(value: number): void;
  /** Jump to a named state: title | active-play | night | dawn | stress | dead. */
  setState(name: string): void;
  /** Freeze the simulation while continuing to render the current frame. */
  setPausedForScreenshot(paused: boolean): void;
  /** Freeze ambient/idle animation time so screenshots are stable. */
  setReducedMotion(enabled: boolean): void;
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void;
  /** Live zombie positions for bot diagnostics: type, state, x/z. */
  listZombies(): Array<{ type: string; state: string; x: number; z: number }>;
  /** Trigger a bloater-style blast at a world point (destruction QA). */
  boomAt(x: number, z: number): void;
  /** Arm the talisman gauge (seal-shot QA): 0..1. */
  setSealCharge(value: number): void;
  /** Chew cubes out of the nearest house (voxel demolition QA). */
  chewHouseAt(x: number, z: number, y?: number, radius?: number): number;
  /** Force the structure collapse of the house nearest a point. */
  collapseHouseAt(x: number, z: number): void;
  /** Detonate the 부적 봉인 at a world point (sigil + purge QA). */
  fireSealAt(x: number, z: number): void;
  /** Compose the 밤의 그림 card as a PNG data URL (painting QA). */
  paintingDataUrl(): string;
  /** Fire a style-layer stamp (capture timing). */
  showcaseStamp(char: string, sub: string): void;
  /** Park the camera manually (model-inspection captures; pair with pause). */
  poseCamera(
    px: number,
    py: number,
    pz: number,
    tx: number,
    ty: number,
    tz: number,
    fov?: number,
  ): void;
  /** Defense anchors for capture rigs: gun emplacement + gate mouth. */
  defenseRig(): { gunX: number; gunY: number; gunZ: number; gateX: number; gateY: number; gateZ: number };
  /** Terrain + staging probe (heights profile, houses, obstacles). */
  stageDebug(): Record<string, unknown>;
  /** Draw census by scene root — the "what eats the frame" probe. */
  sceneCensus(): Array<{ root: string; meshes: number; visible: number; tris: number }>;
  /** Toggle a composer pass by constructor name (WebKit/Safari debugging). */
  setPostPassEnabled(name: string, enabled: boolean): boolean;
  /** Scale the desktop IBL envmap (0 = off) — wash probes. */
  setEnvIntensity(value: number): void;
  /** Rebuild the village with a specific seed (staging QA across seeds). */
  reroll(seed: number): void;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}

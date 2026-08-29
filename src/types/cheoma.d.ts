// Ambient types for the cheoma (asiahouse) procedural Joseon generator core.
// Only the surfaces this game consumes are declared; runtime modules are plain
// ESM JavaScript under ../asiahouse/src, aliased as @cheoma/* in vite.config.ts.

declare module '@cheoma/api/village.js' {
  import type * as THREE from 'three';

  export interface CheomaParcel {
    id: string;
    shape?: unknown;
    worldCenter?: THREE.Vector3 | { x: number; z: number };
    [key: string]: unknown;
  }

  export interface CheomaSite {
    R?: number;
    radius?: number;
    heightAt?: (x: number, z: number) => number;
    streamZat?: (x: number) => number;
    stream?: boolean;
    [key: string]: unknown;
  }

  export interface CheomaCityWallGate {
    name: string;
    angle: number;
    width: number;
    scale: number;
    openingHalf: number;
    halfAngle: number;
    x: number;
    z: number;
    dirX: number;
    dirZ: number;
  }

  /** Pure-data 한양 성곽 contour (plan.features.cityWall). */
  export interface CheomaCityWallSpec {
    cx: number;
    cz: number;
    radii: number[];
    meanRadius: number;
    gates: CheomaCityWallGate[];
    [key: string]: unknown;
  }

  export interface CheomaVillagePlan {
    opts: Record<string, unknown>;
    site: CheomaSite;
    parcels: CheomaParcel[];
    roads?: unknown[];
    stats?: Record<string, unknown>;
    bounds?: { min?: { x: number; z: number }; max?: { x: number; z: number } };
    features?: {
      cityWall?: CheomaCityWallSpec;
      palace?: { x: number; z: number; tier?: string } & Record<string, unknown>;
      [key: string]: unknown;
    };
  }

  export interface CheomaPickProxy {
    parcelId: string;
    mesh?: THREE.Object3D | null;
    bbox: THREE.Box3;
    worldCenter?: THREE.Vector3;
    [key: string]: unknown;
  }

  export interface CheomaVillageHandle {
    group: THREE.Group;
    plan: CheomaVillagePlan;
    getPickProxies(): CheomaPickProxy[];
    getPickProxy(id: string): CheomaPickProxy | null;
    setTime(name: string, opts?: { immediate?: boolean }): void;
    setSeason(name: string, opts?: { immediate?: boolean }): void;
    setWeather(name: string, opts?: { immediate?: boolean }): void;
    update(dt: number): unknown;
    updateLod(camera: THREE.Camera, target: THREE.Vector3, dt: number): unknown;
    enterVillageMode(app: { scene: THREE.Scene; env?: unknown; building?: unknown; ground?: unknown }): void;
    exitVillageMode(app: { scene: THREE.Scene; env?: unknown; building?: unknown; ground?: unknown }): void;
    dispose(): void;
    [key: string]: unknown;
  }

  export interface CheomaVillageOptions {
    seed?: number;
    siteR?: number | null;
    stream?: boolean;
    river?: boolean;
    paddyDensityK?: number;
    treeDensityK?: number;
    cityWall?: string | boolean;
    sijeon?: string | boolean;
    char01?: number | null;
    diversityK?: number;
    houses?: number | null;
    undAmpK?: number;
    ridgeHK?: number;
    streamMeanderK?: number;
    wallWeights?: Record<string, number> | null;
    [key: string]: unknown;
  }

  export function createVillage(opts?: CheomaVillageOptions): CheomaVillageHandle;
  export function createVillageAsync(
    opts?: CheomaVillageOptions,
    asyncOpts?: {
      onStep?: (label: string) => void;
      budgetMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<CheomaVillageHandle>;

  export const SCALE_ANCHORS: Record<string, number>;
  export const VILLAGE_SITE_R_MIN: number;
  export const VILLAGE_SITE_R_MAX: number;
}

declare module '@cheoma/api/environment.js' {
  import type * as THREE from 'three';

  export interface CheomaEnvHandle {
    setTime(name: string, opts?: { immediate?: boolean }): void;
    setSeason?(name: string, opts?: { immediate?: boolean }): void;
    setWeather?(name: string, opts?: { immediate?: boolean }): void;
    update?(dt: number): void;
    dispose?(): void;
    [key: string]: unknown;
  }
  export function setupEnvironment(
    scene: THREE.Scene,
    init: { sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight; renderer: THREE.WebGLRenderer; layout?: unknown },
  ): CheomaEnvHandle;

  export interface CheomaPostHandle {
    composer: { render(): void; setSize(w: number, h: number): void };
    setTime(name: string, opts?: { immediate?: boolean }): void;
    setSunsetLook(id: string, opts?: { immediate?: boolean }): void;
    setSize(w: number, h: number): void;
    setDofAmount?(amount: number): void;
    update?(dt: number): void;
    setQuality?(q: string): void;
    dispose?(): void;
    [key: string]: unknown;
  }

  export function setupPost(init: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
    msaaSamples?: number;
  }): CheomaPostHandle;

  export const MSAA_SAMPLES_DESKTOP: number;
  export const MSAA_SAMPLES_COMPACT: number;
  export function resolveMsaaSamples(compact: boolean, dpr?: number): number;

  export const TIME_PRESETS: Record<string, unknown>;
  export const SUNSET_LOOK_IDS: readonly string[];
  export const DEFAULT_SUNSET_LOOK: string;

  export const SEASON_IDS: readonly string[];
  export const WEATHER_IDS: readonly string[];
}

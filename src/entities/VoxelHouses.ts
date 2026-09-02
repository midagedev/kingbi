import * as THREE from 'three';

/**
 * 복셀 한옥 — the box3d fantasy on our own physics: each finished house is
 * OFFLINE-voxelized (triangle splatting over the merged builder geometry)
 * into small cubes rendered as ONE InstancedMesh. Bullets CHEW the cubes
 * out at the impact point (the debris pool carries them away with the
 * ballistic sim), and when a house loses too much structure the remaining
 * cubes pancake — per-cube fall animation inside the instance buffer.
 *
 * Removal is zero-scale (no buffer compaction): every house owns a stable
 * slot region, so cell→slot maps and reset() stay trivial.
 */

/** 창호지 window-pane budget across all houses + the palace. */
const GLOW_CAPACITY = 896;
/** Rigid-chunk cap for one detachment event (the whole island still goes;
 *  the cap only bounds the rigid-body rain — stress bought 3fps at 480). */
const DETACHED_QUEUE_MAX = 240;

/** 색광 전파 (voxel color-light bake) — lanterns and fires pushed as world
 *  sources; the bake runs on a coarse padded grid per house, so adding a
 *  light costs no real THREE light and no shadow map. */
export interface VoxelLightSource {
  x: number;
  y: number;
  z: number;
  power: number;
  range: number;
}

/** Bake cadence — sources are quasi-static (lanterns steady, fires drift
 *  slowly); 0.3s reads as breathing firelight while keeping the stress
 *  rig (burning house + continuous chew) inside a fraction of a frame. */
const LIGHT_TICK = 0.3;
/** BFS cutoff + repaint gate — below these the light is invisible. */
const LIGHT_MIN = 0.035;
const LIGHT_EPS = 0.01;
/** Per-coarse-step costs: air passes cheap, solid fraction eats the light
 *  (occlusion — a chewed hole lets the glow in, walls keep rooms dark). */
const LIGHT_AIR_COST = 0.05;
const LIGHT_WALL_COST = 0.22;
/** Firelight tint (linear) added per unit of propagated light — measured
 *  A/B on the demolish rig: +75% warm pixels over the flame-only frame. */
const LIGHT_TINT_R = 0.44;
const LIGHT_TINT_G = 0.20;
const LIGHT_TINT_B = 0.072;

interface HouseVoxels {
  index: number;
  baseY: number;
  size: number;
  count: number;
  alive: number;
  collapsed: boolean;
  /** Immutable source (world-space) — reset() refills from these. */
  sx: Float32Array;
  sy: Float32Array;
  sz: Float32Array;
  sr: Float32Array;
  sg: Float32Array;
  sb: Float32Array;
  slots: Int32Array;
  cellSlot: Int32Array;
  nx: number;
  ny: number;
  nz: number;
  originX: number;
  originY: number;
  originZ: number;
  /** Cell i → window-pane glow slot, or -1 (창호지 발광). */
  glowCells: Int32Array | null;
  /** Collapse animation state (allocated on trigger). */
  fallDelay: Float32Array | null;
  fallVx: Float32Array | null;
  fallVy: Float32Array | null;
  fallVz: Float32Array | null;
  fallY: Float32Array | null;
  /** Support-scan scratch (grounded-connectivity) — cached per house. */
  supportSeen: Uint8Array | null;
  lastSupportScan: number;
  lastScanAlive: number;
  /** 색광 전파 — coarse PADDED grid (one ring of always-empty cells so
   *  outside sources can wrap the light around the facade). */
  cFactor: number;
  cnx: number;
  cny: number;
  cnz: number;
  cOcc: Uint8Array | null;
  cLight: Float32Array | null;
  /** Last PAINTED light per voxel — the epsilon gate for uploads. */
  voxLight: Float32Array | null;
  cOccAlive: number;
  /** Source-roster + census signature — an unchanged house under
   *  unchanged lights skips the bake entirely (steady state is free). */
  lightSig: number;
}

export interface ChewedVoxel {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  /** The cell's own house scale — debris must match ITS voxel, not the
   *  entry house's (mixed-size blasts used to spit oversized chunks). */
  s: number;
}

/** Splat a placed group's triangles into surface voxels (build-time only). */
export function voxelizeGroup(
  group: THREE.Group,
  size: number,
  jitter: () => number,
  region?: {
    cx: number; cz: number; rx: number; rz: number; yMax?: number;
    /** Skip triangles inside this box (street band carves around the palace). */
    exclude?: { cx: number; cz: number; rx: number; rz: number };
    /** Extra per-mesh gate (house-sized meshes only — mountain slabs stay). */
    meshFilter?: (footprintX: number, footprintZ: number, bbMaxWorldY: number) => boolean;
  },
): {
  sx: Float32Array; sy: Float32Array; sz: Float32Array;
  sr: Float32Array; sg: Float32Array; sb: Float32Array;
  box: THREE.Box3;
} | null {
  group.updateMatrixWorld(true);
  // NaN-proof bounds: streamed village meshes can carry poisoned buffers
  // (a single NaN vertex turns setFromObject into NaN) — accumulate per
  // mesh and skip anything non-finite.
  // Region pre-pass: collect only triangles whose centroid lies inside
  // the palace grounds — merged meshes span the whole mountain, so mesh
  // centers are useless; centroids are honest.
  const kept: number[] = [];
  const keptMat: THREE.Material[] = [];
  const keptUv: number[] = [];
  const box = new THREE.Box3();
  let boxValid = false;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  {
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) return;
      const pos = mesh.geometry.attributes.position;
      const uvAttr = mesh.geometry.attributes.uv;
      if (!pos) return;
      if (region?.meshFilter) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        if (!bb) return;
        const mxw = mesh.matrixWorld.elements;
        const footprintX = bb.max.x - bb.min.x;
        const footprintZ = bb.max.z - bb.min.z;
        const maxY = bb.max.y + mxw[13];
        if (!region.meshFilter(footprintX, footprintZ, maxY)) return;
      }
      const index = mesh.geometry.index;
      const faces = (index ? index.count : pos.count) / 3;
      for (let f = 0; f < faces; f += 1) {
        for (let v = 0; v < 3; v += 1) {
          const i = index ? index.getX(f * 3 + v) : f * 3 + v;
          const vert = v === 0 ? a : v === 1 ? b : c;
          vert.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
        }
        const mx = (a.x + b.x + c.x) / 3;
        const mz = (a.z + b.z + c.z) / 3;
        const my = (a.y + b.y + c.y) / 3;
        if (region && (Math.abs(mx - region.cx) > region.rx || Math.abs(mz - region.cz) > region.rz)) continue;
        if (region?.yMax !== undefined && my > region.yMax) continue;
        if (region?.exclude
          && Math.abs(mx - region.exclude.cx) <= region.exclude.rx
          && Math.abs(mz - region.exclude.cz) <= region.exclude.rz) continue;
        if (!Number.isFinite(a.x + a.y + a.z + b.x + b.y + b.z + c.x + c.y + c.z)) continue;
        kept.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        keptMat.push(material);
        if (uvAttr) {
          let fu = 0;
          let fv = 0;
          for (let v = 0; v < 3; v += 1) {
            const i = index ? index.getX(f * 3 + v) : f * 3 + v;
            fu += uvAttr.getX(i) / 3;
            fv += uvAttr.getY(i) / 3;
          }
          keptUv.push(fu, fv);
        } else {
          keptUv.push(0.5, 0.5);
        }
        box.expandByPoint(a);
        box.expandByPoint(b);
        box.expandByPoint(c);
        boxValid = true;
      }
    });
  }
  if (!boxValid || kept.length === 0) {
    console.info('[voxelize] null: region empty');
    return null;
  }
  if (region) {
    box.min.x = Math.max(box.min.x, region.cx - region.rx);
    box.max.x = Math.min(box.max.x, region.cx + region.rx);
    box.min.z = Math.max(box.min.z, region.cz - region.rz);
    box.max.z = Math.min(box.max.z, region.cz + region.rz);
    if (region.yMax !== undefined) box.max.y = Math.min(box.max.y, region.yMax);
  }
  box.expandByScalar(size * 0.55);
  const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / size));
  const ny = Math.max(1, Math.ceil((box.max.y - box.min.y) / size));
  const nz = Math.max(1, Math.ceil((box.max.z - box.min.z) / size));
  if (nx * ny * nz > 6291456) {
    console.info(`[voxelize] null: grid ${nx}x${ny}x${nz}=${((nx * ny * nz) / 1e6).toFixed(0)}M @${size}`);
    return null;
  }
  const colors = new Uint8Array(nx * ny * nz * 3);
  const occupied = new Uint8Array(nx * ny * nz);
  const tri = new THREE.Triangle();
  const cp = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const texel = new THREE.Color();
  const faceColor = new THREE.Color();
  const reachSq = (size * 0.62) * (size * 0.62);
  // Moon from the north-west ridge: roofs catch it, walls fall away — the
  // shade turns a cube cloud back into a readable BUILDING.
  const moon = new THREE.Vector3(-0.38, 0.85, -0.36).normalize();
  const mapCache = new Map<THREE.Texture, { data: Uint8ClampedArray; w: number; h: number }>();
  const sampleMaterial = (material: THREE.Material, u: number, v: number): THREE.Color => {
    faceColor.copy((material as THREE.MeshStandardMaterial).color ?? texel.setRGB(1, 1, 1));
    const map = (material as THREE.MeshStandardMaterial).map;
    if (!map?.image) return faceColor;
    let cached = mapCache.get(map);
    if (!cached) {
      const side = 64;
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) return faceColor;
      try {
        ctx.drawImage(map.image as CanvasImageSource, 0, 0, side, side);
        cached = { data: ctx.getImageData(0, 0, side, side).data, w: side, h: side };
      } catch {
        return faceColor;
      }
      mapCache.set(map, cached);
    }
    const px = Math.max(0, Math.min(cached.w - 1, Math.floor(u * cached.w)));
    const py = Math.max(0, Math.min(cached.h - 1, Math.floor((1 - v) * cached.h)));
    const at = (py * cached.w + px) * 4;
    texel.setRGB(cached.data[at] / 255, cached.data[at + 1] / 255, cached.data[at + 2] / 255, THREE.SRGBColorSpace);
    return faceColor.multiply(texel);
  };

  const faceCount = keptMat.length;
  for (let f = 0; f < faceCount; f += 1) {
    a.set(kept[f * 9], kept[f * 9 + 1], kept[f * 9 + 2]);
    b.set(kept[f * 9 + 3], kept[f * 9 + 4], kept[f * 9 + 5]);
    c.set(kept[f * 9 + 6], kept[f * 9 + 7], kept[f * 9 + 8]);
    tri.set(a, b, c);
    // Face color: material base × actual map texel (centroid uv), then
    // moon-lambert shade — flat base colors alone made the cubes glow
    // and erased all sense of the house's form.
    const fu = keptUv[f * 2];
    const fv = keptUv[f * 2 + 1];
    normal.copy(ab.subVectors(c, a)).cross(ac.subVectors(b, a)).normalize();
    if (normal.lengthSq() < 0.5) continue;
    const shade = 0.70 + 0.36 * Math.max(0, normal.dot(moon));
    const color = sampleMaterial(keptMat[f] as THREE.Material, fu, fv).multiplyScalar(shade * 0.88);
    const tx0 = Math.floor((Math.min(a.x, b.x, c.x) - box.min.x) / size) - 1;
    const tx1 = Math.floor((Math.max(a.x, b.x, c.x) - box.min.x) / size) + 1;
    const ty0 = Math.floor((Math.min(a.y, b.y, c.y) - box.min.y) / size) - 1;
    const ty1 = Math.floor((Math.max(a.y, b.y, c.y) - box.min.y) / size) + 1;
    const tz0 = Math.floor((Math.min(a.z, b.z, c.z) - box.min.z) / size) - 1;
    const tz1 = Math.floor((Math.max(a.z, b.z, c.z) - box.min.z) / size) + 1;
    for (let iz = Math.max(0, tz0); iz <= Math.min(nz - 1, tz1); iz += 1) {
      for (let iy = Math.max(0, ty0); iy <= Math.min(ny - 1, ty1); iy += 1) {
        for (let ix = Math.max(0, tx0); ix <= Math.min(nx - 1, tx1); ix += 1) {
          probe.set(
            box.min.x + (ix + 0.5) * size,
            box.min.y + (iy + 0.5) * size,
            box.min.z + (iz + 0.5) * size,
          );
          tri.closestPointToPoint(probe, cp);
          if (probe.distanceToSquared(cp) > reachSq) continue;
          const cell = ix + iy * nx + iz * nx * ny;
          occupied[cell] = 1;
          colors[cell * 3] = Math.min(255, Math.round(color.r * 255));
          colors[cell * 3 + 1] = Math.min(255, Math.round(color.g * 255));
          colors[cell * 3 + 2] = Math.min(255, Math.round(color.b * 255));
        }
      }
    }
  }

  let total = 0;
  for (let i = 0; i < occupied.length; i += 1) total += occupied[i];
  if (total === 0) {
    console.info('[voxelize] null: zero voxels splatted');
    return null;
  }
  const sx = new Float32Array(total);
  const sy = new Float32Array(total);
  const sz = new Float32Array(total);
  const sr = new Float32Array(total);
  const sg = new Float32Array(total);
  const sb = new Float32Array(total);
  let w = 0;
  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const cell = ix + iy * nx + iz * nx * ny;
        if (!occupied[cell]) continue;
        sx[w] = box.min.x + (ix + 0.5) * size + (jitter() - 0.5) * size * 0.14;
        sy[w] = box.min.y + (iy + 0.5) * size;
        sz[w] = box.min.z + (iz + 0.5) * size + (jitter() - 0.5) * size * 0.14;
        sr[w] = colors[cell * 3] / 255;
        sg[w] = colors[cell * 3 + 1] / 255;
        sb[w] = colors[cell * 3 + 2] / 255;
        w += 1;
      }
    }
  }
  return { sx, sy, sz, sr, sg, sb, box };
}

/** Split a street-band voxelize into per-building houses: XZ buckets of
 *  `gap` meters, flood-filled across neighbors — each cluster becomes its
 *  own chewable/collapsible house instead of one collective pancake. */
export function splitStreetData(
  data: { sx: Float32Array; sy: Float32Array; sz: Float32Array; sr: Float32Array; sg: Float32Array; sb: Float32Array },
  gap: number,
  minCells: number,
): Array<{ sx: Float32Array; sy: Float32Array; sz: Float32Array; sr: Float32Array; sg: Float32Array; sb: Float32Array; box: THREE.Box3 }> {
  const n = data.sx.length;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    const key = `${Math.floor(data.sx[i] / gap)},${Math.floor(data.sz[i] / gap)}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(i);
  }
  const seen = new Set<string>();
  const out: Array<{ sx: Float32Array; sy: Float32Array; sz: Float32Array; sr: Float32Array; sg: Float32Array; sb: Float32Array; box: THREE.Box3 }> = [];
  for (const key of buckets.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const queue = [key];
    const cells: number[] = [];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      cells.push(...buckets.get(cur)!);
      const [bxs, bzs] = cur.split(',');
      const bx = Number(bxs);
      const bz = Number(bzs);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const next = `${bx + dx},${bz + dz}`;
          if (seen.has(next) || !buckets.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    if (cells.length < minCells) continue;
    const sx = new Float32Array(cells.length);
    const sy = new Float32Array(cells.length);
    const sz = new Float32Array(cells.length);
    const sr = new Float32Array(cells.length);
    const sg = new Float32Array(cells.length);
    const sb = new Float32Array(cells.length);
    const box = new THREE.Box3();
    for (let w = 0; w < cells.length; w += 1) {
      const i = cells[w];
      sx[w] = data.sx[i];
      sy[w] = data.sy[i];
      sz[w] = data.sz[i];
      sr[w] = data.sr[i];
      sg[w] = data.sg[i];
      sb[w] = data.sb[i];
      box.min.x = Math.min(box.min.x, data.sx[i]);
      box.min.y = Math.min(box.min.y, data.sy[i]);
      box.min.z = Math.min(box.min.z, data.sz[i]);
      box.max.x = Math.max(box.max.x, data.sx[i]);
      box.max.y = Math.max(box.max.y, data.sy[i]);
      box.max.z = Math.max(box.max.z, data.sz[i]);
    }
    out.push({ sx, sy, sz, sr, sg, sb, box });
  }
  return out;
}

export class VoxelHouses {
  readonly mesh: THREE.InstancedMesh;
  /** 밤의 창호지 — unlit warm panes riding the facades; bloom does the rest. */
  readonly glowMesh: THREE.InstancedMesh;
  private readonly houses: HouseVoxels[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly scale1 = new THREE.Vector3(1, 1, 1);
  private readonly scale0 = new THREE.Vector3(0, 0, 0);
  private readonly pos = new THREE.Vector3();
  private readonly capColor = new THREE.Color();
  private total = 0;
  private glowTotal = 0;
  private readonly glowBase = new Float32Array(GLOW_CAPACITY * 3);
  private readonly glowPhase = new Float32Array(GLOW_CAPACITY);
  /** glow slot → owning house/cell (reset repaint + destruction sync). */
  private readonly glowHouse = new Int32Array(GLOW_CAPACITY).fill(-1);
  private readonly glowCell = new Int32Array(GLOW_CAPACITY).fill(-1);
  /** Baked outward offset (the pane rides proud of the facade). */
  private readonly glowOffX = new Float32Array(GLOW_CAPACITY);
  private readonly glowOffZ = new Float32Array(GLOW_CAPACITY);
  private glowTime = 0;
  private glowTick = 0;
  /** Shared clock for the per-house support-scan throttle. */
  private voxTime = 0;
  /** Terrain height query — grounds the support scan's seeds. The palace
   *  compound climbs 3.7m of slope; seeding the grid's bottom layers alone
   *  read every terrace structure as a floating island and one stray round
   *  pancaked the whole backdrop (the "시작하자마자 궁이 터진다" bug). */
  private groundAt: ((x: number, z: number) => number) | null = null;
  /** Visual chunks waiting for the physics layer (support detachments). */
  private readonly detachedQueue: ChewedVoxel[] = [];
  /** 색광 전파 state — sources copied in by the Game layer each frame;
   *  the bake itself ticks throttled (see LIGHT_TICK). */
  private readonly lightSources: VoxelLightSource[] = [];
  private readonly lightNear: number[] = [];
  private lightAccum = 0;
  private lightBfs: Int32Array = new Int32Array(4096);
  private lightTickMs = 0;

  constructor(scene: THREE.Scene, capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.7 });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    // Layer 1: the voxel mass casts ONLY into the fire spot's shadow map —
    // the cached moon map (re-rendered whenever a census shift happens
    // mid-fight) never pays this mesh's huge vertex load again.
    this.mesh.layers.set(1);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'voxel-houses';
    this.mesh.count = 0;
    scene.add(this.mesh);

    const glowGeometry = new THREE.BoxGeometry(1, 1, 1);
    const glowMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.glowMesh = new THREE.InstancedMesh(glowGeometry, glowMaterial, GLOW_CAPACITY);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.name = 'voxel-windows';
    this.glowMesh.count = 0;
    for (let i = 0; i < GLOW_CAPACITY; i += 1) this.hideGlow(i);
    scene.add(this.glowMesh);
  }

  /** Register a voxelize result; returns the house index. */
  addHouse(data: {
    sx: Float32Array; sy: Float32Array; sz: Float32Array;
    sr: Float32Array; sg: Float32Array; sb: Float32Array;
    box: THREE.Box3;
  }, size: number): number {
    const count = data.sx.length;
    const start = this.total;
    this.total += count;
    if (this.total > this.mesh.instanceMatrix.count) return -1;
    const nx = Math.max(1, Math.ceil((data.box.max.x - data.box.min.x) / size));
    const ny = Math.max(1, Math.ceil((data.box.max.y - data.box.min.y) / size));
    const nz = Math.max(1, Math.ceil((data.box.max.z - data.box.min.z) / size));
    // 색광 격자 — ~0.26m coarse cells: fine enough that a 1-2-voxel wall
    // reads as a solid occluder (0.44m cells diluted walls under the
    // solid-fraction threshold and lantern light leaked into rooms).
    const cFactor = Math.max(1, Math.min(4, Math.round(0.26 / size)));
    const house: HouseVoxels = {
      index: this.houses.length,
      baseY: data.box.min.y,
      size,
      count,
      alive: count,
      collapsed: false,
      sx: data.sx, sy: data.sy, sz: data.sz, sr: data.sr, sg: data.sg, sb: data.sb,
      slots: new Int32Array(count),
      cellSlot: new Int32Array(nx * ny * nz),
      nx, ny, nz,
      originX: data.box.min.x,
      originY: data.box.min.y,
      originZ: data.box.min.z,
      glowCells: new Int32Array(count).fill(-1),
      fallDelay: null, fallVx: null, fallVy: null, fallVz: null, fallY: null,
      supportSeen: null, lastSupportScan: -1, lastScanAlive: -1,
      cFactor,
      cnx: Math.ceil(nx / cFactor) + 2,
      cny: Math.ceil(ny / cFactor) + 2,
      cnz: Math.ceil(nz / cFactor) + 2,
      cOcc: null, cLight: null, voxLight: null, cOccAlive: -1, lightSig: -1,
    };
    this.houses.push(house);
    for (let i = 0; i < count; i += 1) {
      const slot = start + i;
      house.slots[i] = slot;
      house.cellSlot[this.cellOf(house, data.sx[i], data.sy[i], data.sz[i])] = i + 1;
      this.writeSlot(slot, data.sx[i], data.sy[i], data.sz[i], data.sr[i], data.sg[i], data.sb[i]);
    }
    this.placeWindows(house);
    this.mesh.count = this.total;
    this.flush();
    return house.index;
  }

  private occupiedCell(house: HouseVoxels, ix: number, iy: number, iz: number): boolean {
    if (ix < 0 || ix >= house.nx || iy < 0 || iy >= house.ny || iz < 0 || iz >= house.nz) return false;
    return house.cellSlot[ix + iy * house.nx + iz * house.nx * house.ny] !== 0;
  }

  /** Interior audit (QA): flood each Y layer's empty cells from the layer
   *  border — unreached empties are enclosed ROOM voids. A solid-filled
   *  house reports ~0 voids; a proper shell reports room-sized counts. */
  hollowDebug(): Array<{ index: number; cells: number; voids: number; layers: number; layersWithVoids: number }> {
    const out: Array<{ index: number; cells: number; voids: number; layers: number; layersWithVoids: number }> = [];
    for (const house of this.houses) {
      const { nx, ny, nz } = house;
      let voids = 0;
      let layersWithVoids = 0;
      for (let iy = 0; iy < ny; iy += 1) {
        const seen = new Uint8Array(nx * nz);
        const stack: number[] = [];
        for (let ix = 0; ix < nx; ix += 1) stack.push(ix, 0, ix, nz - 1);
        for (let iz = 0; iz < nz; iz += 1) stack.push(0, iz, nx - 1, iz);
        while (stack.length > 0) {
          const iz = stack.pop()!;
          const ix = stack.pop()!;
          if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
          const cell = ix + iz * nx;
          if (seen[cell] || this.occupiedCell(house, ix, iy, iz)) continue;
          seen[cell] = 1;
          stack.push(ix + 1, iz, ix - 1, iz, ix, iz + 1, ix, iz - 1);
        }
        let layerVoid = 0;
        for (let iz = 0; iz < nz; iz += 1) {
          for (let ix = 0; ix < nx; ix += 1) {
            if (!seen[ix + iz * nx] && !this.occupiedCell(house, ix, iy, iz)) layerVoid += 1;
          }
        }
        if (layerVoid > 4) layersWithVoids += 1;
        voids += layerVoid;
      }
      out.push({ index: house.index, cells: house.count, voids, layers: ny, layersWithVoids });
    }
    return out;
  }

  /** 3D bullet march through one house's cell grid (Amanatides–Woo DDA).
   *  Direction is (dx, dy, dz) with dx²+dz² = 1 and dy the vertical slope
   *  per ground meter, so t stays in ground meters (queryRay-compatible).
   *  Returns the FIRST occupied cell: rounds fly through chewed-open
   *  rooms, door gaps and over low walls instead of stopping on the
   *  footprint box — the rooms really are empty (see hollowDebug). */
  raycastCell(
    index: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): { dist: number; x: number; y: number; z: number } | null {
    const house = this.houses[index];
    if (!house) return null;
    const size = house.size;
    const minX = house.originX;
    const minY = house.originY;
    const minZ = house.originZ;
    const maxX = minX + house.nx * size;
    const maxY = minY + house.ny * size;
    const maxZ = minZ + house.nz * size;
    // Clip the ray to the grid AABB (any axis miss → no hit at all).
    let tEnter = 0;
    let tExit = maxDist;
    for (const [o, d, lo, hi] of [
      [ox, dx, minX, maxX], [oy, dy, minY, maxY], [oz, dz, minZ, maxZ],
    ] as const) {
      if (Math.abs(d) < 1e-8) {
        if (o < lo || o > hi) return null;
        continue;
      }
      let t0 = (lo - o) / d;
      let t1 = (hi - o) / d;
      if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
      tEnter = Math.max(tEnter, t0);
      tExit = Math.min(tExit, t1);
      if (tEnter > tExit) return null;
    }
    let t = Math.max(tEnter, 0);
    let ix = Math.min(house.nx - 1, Math.max(0, Math.floor((ox + dx * t - minX) / size)));
    let iy = Math.min(house.ny - 1, Math.max(0, Math.floor((oy + dy * t - minY) / size)));
    let iz = Math.min(house.nz - 1, Math.max(0, Math.floor((oz + dz * t - minZ) / size)));
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dx) > 1e-8 ? Math.abs(size / dx) : Infinity;
    const tDeltaY = Math.abs(dy) > 1e-8 ? Math.abs(size / dy) : Infinity;
    const tDeltaZ = Math.abs(dz) > 1e-8 ? Math.abs(size / dz) : Infinity;
    const planeAt = (origin: number, dir: number, cell: number, gridMin: number) =>
      dir > 0 ? (gridMin + (cell + 1) * size - origin) / dir : (gridMin + cell * size - origin) / dir;
    let tMaxX = Math.abs(dx) > 1e-8 ? planeAt(ox, dx, ix, minX) : Infinity;
    let tMaxY = Math.abs(dy) > 1e-8 ? planeAt(oy, dy, iy, minY) : Infinity;
    let tMaxZ = Math.abs(dz) > 1e-8 ? planeAt(oz, dz, iz, minZ) : Infinity;
    const guardMax = house.nx + house.ny + house.nz + 3;
    for (let guard = 0; guard <= guardMax; guard += 1) {
      if (this.occupiedCell(house, ix, iy, iz)) {
        return {
          dist: t,
          x: minX + (ix + 0.5) * size,
          y: minY + (iy + 0.5) * size,
          z: minZ + (iz + 0.5) * size,
        };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        if (tMaxX > tExit) return null;
        t = tMaxX;
        tMaxX += tDeltaX;
        ix += stepX;
        if (ix < 0 || ix >= house.nx) return null;
      } else if (tMaxY < tMaxZ) {
        if (tMaxY > tExit) return null;
        t = tMaxY;
        tMaxY += tDeltaY;
        iy += stepY;
        if (iy < 0 || iy >= house.ny) return null;
      } else {
        if (tMaxZ > tExit) return null;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        iz += stepZ;
        if (iz < 0 || iz >= house.nz) return null;
      }
    }
    return null;
  }

  /** 창호지 — stamp warm unlit panes on the outer shell. A cell qualifies
   *  when it sits in the wall band, has open space on an axis, and the open
   *  side faces AWAY from the house center (thin 1-cell walls included).
   *  Panes ride the facade slightly proud so they read through bloom. */
  private placeWindows(house: HouseVoxels): void {
    const size = house.size;
    const bigCell = size > 0.4;
    const bandMin = bigCell ? 1.0 : 0.75;
    const bandMax = bigCell ? 4.4 : 2.5;
    const maxWindows = bigCell ? 30 : 12;
    const spacingSq = (bigCell ? 4.6 : 1.55) ** 2;
    const centerX = house.originX + (house.nx * size) / 2;
    const centerZ = house.originZ + (house.nz * size) / 2;
    const picked: number[] = [];
    for (let iz = 0; iz < house.nz && picked.length < maxWindows; iz += 1) {
      for (let iy = 0; iy < house.ny && picked.length < maxWindows; iy += 1) {
        const y = house.originY + (iy + 0.5) * size;
        if (y - house.baseY < bandMin || y - house.baseY > bandMax) continue;
        for (let ix = 0; ix < house.nx && picked.length < maxWindows; ix += 1) {
          const cell = ix + iy * house.nx + iz * house.nx * house.ny;
          const i = house.cellSlot[cell] - 1;
          if (i < 0) continue;
          let ox = 0;
          let oz = 0;
          if (!this.occupiedCell(house, ix + 1, iy, iz) || !this.occupiedCell(house, ix - 1, iy, iz)) {
            ox = house.sx[i] > centerX ? 1 : -1;
            if (this.occupiedCell(house, ix + ox, iy, iz)) continue;
          } else if (!this.occupiedCell(house, ix, iy, iz + 1) || !this.occupiedCell(house, ix, iy, iz - 1)) {
            oz = house.sz[i] > centerZ ? 1 : -1;
            if (this.occupiedCell(house, ix, iy, iz + oz)) continue;
          } else {
            continue;
          }
          const x = house.sx[i];
          const z = house.sz[i];
          let tooClose = false;
          for (const p of picked) {
            const dx = house.sx[p] - x;
            const dz = house.sz[p] - z;
            if (dx * dx + dz * dz < spacingSq) {
              tooClose = true;
              break;
            }
          }
          if (tooClose) continue;
          picked.push(i);
          this.stampWindow(house, i, ix, iy, iz, ox, oz, bigCell);
        }
      }
    }
  }

  /** One pane: the seed cell plus its in-wall tangent/up neighbors (a
   *  2×2 of 창호지 at house scale, a single broad pane at palace scale). */
  private stampWindow(
    house: HouseVoxels, seed: number, ix: number, iy: number, iz: number,
    ox: number, oz: number, bigCell: boolean,
  ): void {
    if (this.glowTotal >= GLOW_CAPACITY) return;
    const cells: Array<[number, number, number]> = [[ix, iy, iz]];
    if (!bigCell) {
      const tx = oz !== 0 ? 1 : 0;
      const tz = ox !== 0 ? 1 : 0;
      // Pane spans a fixed WORLD size (~0.26m) regardless of the voxel
      // grid: finer voxels stamp more cells so the 창호지 window keeps
      // its night presence as the grid detail rises.
      const span = Math.max(2, Math.round(0.26 / house.size));
      for (let v = 0; v < span; v += 1) {
        for (let u = 0; u < span; u += 1) {
          if (u === 0 && v === 0) continue;
          if (this.occupiedCell(house, ix + tx * u, iy + v, iz + tz * u)) {
            cells.push([ix + tx * u, iy + v, iz + tz * u]);
          }
        }
      }
    }
    // Deterministic per-window tint/phase (hash — voxelization, not gameplay rng).
    const hash = Math.abs(Math.sin(seed * 12.9898 + house.index * 78.233)) % 1;
    const warm = 0.8 + hash * 0.35;
    for (const [cx, cy, cz] of cells) {
      const cell = cx + cy * house.nx + cz * house.nx * house.ny;
      const i = house.cellSlot[cell] - 1;
      if (i < 0 || house.glowCells![i] >= 0) continue;
      if (this.glowTotal >= GLOW_CAPACITY) return;
      const slot = this.glowTotal;
      this.glowTotal += 1;
      house.glowCells![i] = slot;
      this.glowHouse[slot] = house.index;
      this.glowCell[slot] = i;
      const offX = ox * house.size * 0.52;
      const offZ = oz * house.size * 0.52;
      this.glowOffX[slot] = offX;
      this.glowOffZ[slot] = offZ;
      this.pos.set(house.sx[i] + offX, house.sy[i], house.sz[i] + offZ);
      this.scale1.set(house.size * 1.04, house.size * 1.04, house.size * 0.42);
      this.matrix.compose(this.pos, this.quat, this.scale1);
      this.glowMesh.setMatrixAt(slot, this.matrix);
      this.glowMesh.setColorAt(slot, this.capColor.setRGB(1.0 * warm, 0.66 * warm, 0.3 * warm));
      this.glowBase[slot * 3] = 1.0 * warm;
      this.glowBase[slot * 3 + 1] = 0.66 * warm;
      this.glowBase[slot * 3 + 2] = 0.3 * warm;
      this.glowPhase[slot] = hash * Math.PI * 2;
    }
    this.glowMesh.count = this.glowTotal;
    this.glowMesh.instanceMatrix.needsUpdate = true;
    if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
  }

  private hideGlow(slot: number): void {
    this.pos.set(0, -1000, 0);
    this.matrix.compose(this.pos, this.quat, this.scale0);
    this.glowMesh.setMatrixAt(slot, this.matrix);
  }

  /** A chewed-out cell takes its window pane with it (멀쩡한 창만 남지 않게). */
  private killGlowCell(house: HouseVoxels, i: number): void {
    const g = house.glowCells?.[i] ?? -1;
    if (g < 0) return;
    this.hideGlow(g);
    house.glowCells![i] = -1;
    this.glowMesh.instanceMatrix.needsUpdate = true;
  }

  private cellOf(house: HouseVoxels, x: number, y: number, z: number): number {
    const ix = Math.max(0, Math.min(house.nx - 1, Math.floor((x - house.originX) / house.size)));
    const iy = Math.max(0, Math.min(house.ny - 1, Math.floor((y - house.originY) / house.size)));
    const iz = Math.max(0, Math.min(house.nz - 1, Math.floor((z - house.originZ) / house.size)));
    return ix + iy * house.nx + iz * house.nx * house.ny;
  }

  private writeSlot(slot: number, x: number, y: number, z: number, r: number, g: number, b: number): void {
    this.pos.set(x, y, z);
    this.matrix.compose(this.pos, this.quat, this.scale1);
    this.mesh.setMatrixAt(slot, this.matrix);
    this.mesh.setColorAt(slot, this.capColor.setRGB(r, g, b));
  }

  private killSlot(slot: number): void {
    this.pos.set(0, -1000, 0);
    this.matrix.compose(this.pos, this.quat, this.scale0);
    this.mesh.setMatrixAt(slot, this.matrix);
  }

  private flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Remove every cube within `radius` of a world point; the caller turns
   *  the returned voxels into debris chunks. */
  chew(x: number, y: number, z: number, radius: number, out: ChewedVoxel[]): number {
    const rSq = radius * radius;
    let removed = 0;
    for (const house of this.houses) {
      if (house.collapsed) continue;
      const size = house.size;
      if (x < house.originX - radius || x > house.originX + house.nx * size + radius) continue;
      if (z < house.originZ - radius || z > house.originZ + house.nz * size + radius) continue;
      if (y < house.originY - radius || y > house.originY + house.ny * size + radius) continue;
      // GRID WINDOW: walk only the cells the sphere covers, never the
      // whole house — the fine 0.11m chogas carry ~40k cells and the
      // gatling drops dozens of spheres a second.
      const ix0 = Math.max(0, Math.floor((x - radius - house.originX) / size));
      const ix1 = Math.min(house.nx - 1, Math.floor((x + radius - house.originX) / size));
      const iy0 = Math.max(0, Math.floor((y - radius - house.originY) / size));
      const iy1 = Math.min(house.ny - 1, Math.floor((y + radius - house.originY) / size));
      const iz0 = Math.max(0, Math.floor((z - radius - house.originZ) / size));
      const iz1 = Math.min(house.nz - 1, Math.floor((z + radius - house.originZ) / size));
      for (let iz = iz0; iz <= iz1; iz += 1) {
        for (let iy = iy0; iy <= iy1; iy += 1) {
          for (let ix = ix0; ix <= ix1; ix += 1) {
            const cell = ix + iy * house.nx + iz * house.nx * house.ny;
            const i = house.cellSlot[cell] - 1;
            if (i < 0) continue;
            const dx = house.sx[i] - x;
            const dy = house.sy[i] - y;
            const dz = house.sz[i] - z;
            if (dx * dx + dy * dy + dz * dz > rSq) continue;
            house.cellSlot[cell] = 0;
            house.alive -= 1;
            this.killSlot(house.slots[i]);
            this.killGlowCell(house, i);
            out.push({ x: house.sx[i], y: house.sy[i], z: house.sz[i], r: house.sr[i], g: house.sg[i], b: house.sb[i], s: house.size });
            removed += 1;
          }
        }
      }
    }
    if (removed > 0) this.flush();
    return removed;
  }

  /** Pull up to `max` alive voxels out of the structure (collapse → real
   *  box3d bodies). Stride spreads the take over the whole house so the
   *  body cloud reads as the building coming apart, not one corner. */
  takeVoxels(index: number, max: number, out: ChewedVoxel[]): number {
    const house = this.houses[index];
    if (!house || house.collapsed) return 0;
    const stride = Math.max(1, Math.floor(house.alive / Math.max(1, max)));
    let taken = 0;
    let seen = 0;
    for (let i = 0; i < house.count && taken < max; i += 1) {
      const cell = this.cellOf(house, house.sx[i], house.sy[i], house.sz[i]);
      if (house.cellSlot[cell] !== i + 1) continue;
      if (seen % stride !== 0) {
        seen += 1;
        continue;
      }
      seen += 1;
      house.cellSlot[cell] = 0;
      house.alive -= 1;
      this.killSlot(house.slots[i]);
      this.killGlowCell(house, i);
      out.push({ x: house.sx[i], y: house.sy[i], z: house.sz[i], r: house.sr[i], g: house.sg[i], b: house.sb[i], s: house.size });
      taken += 1;
    }
    if (taken > 0) this.flush();
    return taken;
  }

  /** Rubble body half-size for this house's cube scale (chunk = cell). */
  halfSize(index: number): number {
    const house = this.houses[index];
    return (house ? house.size : 0.4) * 0.5;
  }

  /** 지지 검사 — a roof whose walls were shot out must not hover: flood
   *  occupied cells up from the grounded bottom layers (6-connectivity)
   *  and DETACH every unsupported island, top-down so the roof rains
   *  first. Scheduled from update() (so the LAST bullet of a burst still
   *  gets its scan), throttled per house, skipped while nothing changed.
   *  Detached chunks queue for the caller — drainDetachedVoxels(). */
  private scanSupport(house: HouseVoxels): void {
    if (house.collapsed || house.fallDelay) return;
    if (house.alive === house.count) return;
    if (house.lastScanAlive === house.alive) return;
    if (this.voxTime - house.lastSupportScan < 0.3) return;
    house.lastSupportScan = this.voxTime;
    const { nx, ny, nz } = house;
    const cellSlot = house.cellSlot;
    const total = nx * ny * nz;
    if (!house.supportSeen || house.supportSeen.length !== total) {
      house.supportSeen = new Uint8Array(total);
    }
    const seen = house.supportSeen;
    seen.fill(0);
    // Seed: each column's LOWEST occupied cell, but only when it actually
    // RESTS ON TERRAIN — the old bottom-2-layers seeding was blind on
    // slopes (the palace terraces) and one stray round's scan ripped the
    // whole compound loose as "floating".
    const stack: number[] = [];
    const tolerance = Math.max(2.5 * house.size, 1.2);
    const baseY = house.originY;
    for (let iz = 0; iz < nz; iz += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        for (let iy = 0; iy < ny; iy += 1) {
          const cell = ix + iy * nx + iz * nx * ny;
          if (cellSlot[cell] === 0) continue;
          const wy = baseY + (iy + 0.5) * house.size;
          const ground = this.groundAt
            ? this.groundAt(house.originX + (ix + 0.5) * house.size, house.originZ + (iz + 0.5) * house.size)
            : baseY;
          if (wy - ground <= tolerance) {
            seen[cell] = 1;
            stack.push(cell);
          }
          break; // the column's lowest cell decides
        }
      }
    }
    const layerYZ = nx;
    const planeYZ = nx * ny;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const ix = cell % nx;
      const iy = ((cell / nx) | 0) % ny;
      const iz = (cell / planeYZ) | 0;
      const push = (candidate: number) => {
        if (seen[candidate] || cellSlot[candidate] === 0) return;
        seen[candidate] = 1;
        stack.push(candidate);
      };
      if (ix > 0) push(cell - 1);
      if (ix < nx - 1) push(cell + 1);
      if (iy > 0) push(cell - layerYZ);
      if (iy < ny - 1) push(cell + layerYZ);
      if (iz > 0) push(cell - planeYZ);
      if (iz < nz - 1) push(cell + planeYZ);
    }
    // Unsupported islands — occupied cells the ground never reaches.
    const floating: number[] = [];
    for (let cell = 0; cell < total; cell += 1) {
      if (seen[cell] === 0 && cellSlot[cell] !== 0) floating.push(cell);
    }
    house.lastScanAlive = house.alive;
    if (floating.length === 0) return;
    // Top-down: the highest cells let go first and the roof rains.
    const byHeight = floating
      .map((cell) => ({ cell, y: house.sy[cellSlot[cell] - 1] }))
      .sort((a, b) => b.y - a.y);
    let removed = 0;
    for (const { cell } of byHeight) {
      const i = cellSlot[cell] - 1;
      cellSlot[cell] = 0;
      house.alive -= 1;
      this.killSlot(house.slots[i]);
      this.killGlowCell(house, i);
      if (this.detachedQueue.length < DETACHED_QUEUE_MAX) {
        this.detachedQueue.push({ x: house.sx[i], y: house.sy[i], z: house.sz[i], r: house.sr[i], g: house.sg[i], b: house.sb[i], s: house.size });
      }
      removed += 1;
    }
    if (removed > 0) this.flush();
    house.lastScanAlive = house.alive;
  }

  setGroundAt(groundAt: (x: number, z: number) => number): void {
    this.groundAt = groundAt;
  }

  /** Game→bake: this frame's light roster (yard lanterns + live fires). */
  setLightSources(sources: readonly VoxelLightSource[]): void {
    this.lightSources.length = 0;
    for (const s of sources) this.lightSources.push(s);
  }

  /** One 색광 bake pass — house bbox vs source spheres first (most houses
   *  skip), then seed + BFS + epsilon-gated repaint. */
  private tickLight(): void {
    const sources = this.lightSources;
    let painted = false;
    for (const house of this.houses) {
      const { originX, originY, originZ, nx, ny, nz, size } = house;
      const maxX = originX + nx * size;
      const maxY = originY + ny * size;
      const maxZ = originZ + nz * size;
      this.lightNear.length = 0;
      for (let s = 0; s < sources.length; s += 1) {
        const src = sources[s];
        // sphere vs bbox: clamp the source into the box, compare radii.
        const dx = src.x < originX ? originX : src.x > maxX ? maxX : src.x;
        const dy = src.y < originY ? originY : src.y > maxY ? maxY : src.y;
        const dz = src.z < originZ ? originZ : src.z > maxZ ? maxZ : src.z;
        const d2 = (src.x - dx) ** 2 + (src.y - dy) ** 2 + (src.z - dz) ** 2;
        if (d2 <= src.range * src.range) this.lightNear.push(s);
      }
      if (this.lightNear.length === 0) {
        if (this.clearHouseLight(house)) painted = true;
        continue;
      }
      if (this.lightHouse(house, this.lightNear)) painted = true;
    }
    if (painted && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private buildCoarseOcc(house: HouseVoxels): void {
    const { nx, ny, cFactor: F, cnx, cny, cnz, cellSlot, count } = house;
    const total = cnx * cny * cnz;
    if (!house.cOcc || house.cOcc.length !== total) house.cOcc = new Uint8Array(total);
    else house.cOcc.fill(0);
    const cOcc = house.cOcc;
    const plane = nx * ny;
    for (let i = 0; i < count; i += 1) {
      const cell = this.cellOf(house, house.sx[i], house.sy[i], house.sz[i]);
      if (cellSlot[cell] !== i + 1) continue; // chewed / collapsed
      const ix = cell % nx;
      const iy = ((cell / nx) | 0) % ny;
      const iz = (cell / plane) | 0;
      const c = 1 + ((ix / F) | 0) + (1 + ((iy / F) | 0)) * cnx + (1 + ((iz / F) | 0)) * cnx * cny;
      if (cOcc[c] < 250) cOcc[c] += 1;
    }
    house.cOccAlive = house.alive;
  }

  private lightHouse(house: HouseVoxels, nearIdx: number[]): boolean {
    const { size, cFactor: F, cnx, cny, cnz, originX, originY, originZ, count, cellSlot } = house;
    // Signature gate — same sources (position/power rounded), same census:
    // the bake would land where it already is. Fires sit still and lanterns
    // never move, so a calm yard pays nothing until a wall opens.
    let sig = house.alive * 2654435761;
    for (const s of nearIdx) {
      const src = this.lightSources[s];
      sig = (sig * 31 + ((src.x * 8) | 0) + ((src.y * 8) | 0) * 7 + ((src.z * 8) | 0) * 13
        + ((src.power * 64) | 0) * 29 + ((src.range * 8) | 0) * 101) | 0;
    }
    if (sig === house.lightSig) return false;
    house.lightSig = sig;
    const cTotal = cnx * cny * cnz;
    if (!house.cOcc || house.cOccAlive !== house.alive) this.buildCoarseOcc(house);
    if (!house.cLight || house.cLight.length !== cTotal) house.cLight = new Float32Array(cTotal);
    if (!house.voxLight) house.voxLight = new Float32Array(count);
    const light = house.cLight;
    const cOcc = house.cOcc!;
    light.fill(0);
    const cSize = size * F;
    const planeC = cnx * cny;
    // Seed — direct falloff spheres clipped to the padded grid, AIR CELLS
    // ONLY: a wall must not pass direct light to the room behind it (the
    // facade samples its glow from the lit air in front, at paint time).
    // A source outside the bbox lands in the padding ring; the light wraps
    // in from whichever face can see it.
    for (const s of nearIdx) {
      const src = this.lightSources[s];
      const fx = (src.x - originX) / cSize + 1;
      const fy = (src.y - originY) / cSize + 1;
      const fz = (src.z - originZ) / cSize + 1;
      const rc = Math.max(1.5, src.range / cSize);
      const x0 = Math.max(0, Math.floor(fx - rc));
      const x1 = Math.min(cnx - 1, Math.ceil(fx + rc));
      const y0 = Math.max(0, Math.floor(fy - rc));
      const y1 = Math.min(cny - 1, Math.ceil(fy + rc));
      const z0 = Math.max(0, Math.floor(fz - rc));
      const z1 = Math.min(cnz - 1, Math.ceil(fz + rc));
      let seeded = 0;
      for (let iz = z0; iz <= z1; iz += 1) {
        for (let iy = y0; iy <= y1; iy += 1) {
          for (let ix = x0; ix <= x1; ix += 1) {
            const dx = ix + 0.5 - fx;
            const dy = iy + 0.5 - fy;
            const dz = iz + 0.5 - fz;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d >= rc) continue;
            const c = ix + iy * cnx + iz * planeC;
            if (cOcc[c] > 0) continue; // solid — no direct pass-through
            const v = src.power * (1 - d / rc);
            if (v > light[c]) light[c] = v;
            seeded += 1;
          }
        }
      }
      // Fallback: a fire buried in dense rubble seeds nothing through air —
      // let it warm its immediate solids or the heap reads pitch black.
      if (seeded === 0) {
        const r2 = 2.2;
        const bx0 = Math.max(0, Math.floor(fx - r2));
        const bx1 = Math.min(cnx - 1, Math.ceil(fx + r2));
        const by0 = Math.max(0, Math.floor(fy - r2));
        const by1 = Math.min(cny - 1, Math.ceil(fy + r2));
        const bz0 = Math.max(0, Math.floor(fz - r2));
        const bz1 = Math.min(cnz - 1, Math.ceil(fz + r2));
        for (let iz = bz0; iz <= bz1; iz += 1) {
          for (let iy = by0; iy <= by1; iy += 1) {
            for (let ix = bx0; ix <= bx1; ix += 1) {
              const dx = ix + 0.5 - fx;
              const dy = iy + 0.5 - fy;
              const dz = iz + 0.5 - fz;
              const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (d >= r2) continue;
              const c = ix + iy * cnx + iz * planeC;
              const v = src.power * (1 - d / r2);
              if (v > light[c]) light[c] = v;
            }
          }
        }
      }
    }
    // BFS relaxation — monotone improvement drains the queue; solid
    // fraction adds occlusion cost so interiors stay dark until a wall
    // opens (then the firelight spills through the wound into the room).
    let queue = this.lightBfs;
    if (queue.length < cTotal + 8) queue = this.lightBfs = new Int32Array(cTotal * 2);
    let tail = 0;
    for (let c = 0; c < cTotal; c += 1) if (light[c] > LIGHT_MIN) queue[tail++] = c;
    const maxOcc = F * F * F;
    let head = 0;
    while (head < tail) {
      const c = queue[head++];
      const l = light[c];
      if (l <= LIGHT_MIN) continue;
      const ix = c % cnx;
      const iy = ((c / cnx) | 0) % cny;
      const iz = (c / planeC) | 0;
      for (let k = 0; k < 6; k += 1) {
        let n = -1;
        if (k === 0) {
          if (ix > 0) n = c - 1;
        } else if (k === 1) {
          if (ix < cnx - 1) n = c + 1;
        } else if (k === 2) {
          if (iy > 0) n = c - cnx;
        } else if (k === 3) {
          if (iy < cny - 1) n = c + cnx;
        } else if (k === 4) {
          if (iz > 0) n = c - planeC;
        } else if (iz < cnz - 1) {
          n = c + planeC;
        }
        if (n < 0) continue;
        const nl = l - LIGHT_AIR_COST - LIGHT_WALL_COST * (cOcc[n] / maxOcc);
        if (nl > LIGHT_MIN && nl > light[n] + 0.004) {
          light[n] = nl;
          if (tail >= queue.length) {
            const grown = new Int32Array(queue.length * 2);
            grown.set(queue);
            queue = this.lightBfs = grown;
          }
          queue[tail++] = n;
        }
      }
    }
    // Repaint — additive warm tint on the baked base, only where the
    // baked light actually moved (keeps instanceColor uploads rare).
    // A SOLID cell never holds direct light: the wall samples the lit air
    // hugging its faces (either side), so the far side of a thick wall
    // stays dark and a chewed wound glows into the room.
    const voxLight = house.voxLight!;
    const solidCell = Math.max(1, (maxOcc * 0.35) | 0);
    let painted = 0;
    const plane = house.nx * house.ny;
    for (let i = 0; i < count; i += 1) {
      const cell = this.cellOf(house, house.sx[i], house.sy[i], house.sz[i]);
      const ix = cell % house.nx;
      const iy = ((cell / house.nx) | 0) % house.ny;
      const iz = (cell / plane) | 0;
      const cx = 1 + ((ix / F) | 0);
      const cy = 1 + ((iy / F) | 0);
      const cz = 1 + ((iz / F) | 0);
      const c = cx + cy * cnx + cz * planeC;
      let l = light[c];
      if (cOcc[c] >= solidCell) {
        // wall — best-lit adjacent air cell
        const peek = (nx2: number) => {
          if (cOcc[nx2] >= solidCell) return;
          if (light[nx2] > l) l = light[nx2];
        };
        if (cx > 0) peek(c - 1);
        if (cx < cnx - 1) peek(c + 1);
        if (cy > 0) peek(c - cnx);
        if (cy < cny - 1) peek(c + cnx);
        if (cz > 0) peek(c - planeC);
        if (cz < cnz - 1) peek(c + planeC);
      }
      if (Math.abs(l - voxLight[i]) <= LIGHT_EPS) continue;
      voxLight[i] = l;
      if (cellSlot[cell] !== i + 1) continue; // dead slot — record only
      this.mesh.setColorAt(house.slots[i], this.capColor.setRGB(
        house.sr[i] + LIGHT_TINT_R * l,
        house.sg[i] + LIGHT_TINT_G * l,
        house.sb[i] + LIGHT_TINT_B * l,
      ));
      painted += 1;
    }
    return painted > 0;
  }

  /** Sources left the neighborhood — bake the walls back to moonlight. */
  private clearHouseLight(house: HouseVoxels): boolean {
    const voxLight = house.voxLight;
    if (!voxLight) return false;
    let painted = false;
    for (let i = 0; i < house.count; i += 1) {
      if (voxLight[i] <= 0) continue;
      voxLight[i] = 0;
      this.mesh.setColorAt(house.slots[i], this.capColor.setRGB(house.sr[i], house.sg[i], house.sb[i]));
      painted = true;
    }
    return painted;
  }

  /** 색광 bake audit (QA): lit-voxel count + peak light per house. */
  lightDebug(): Array<{ index: number; lit: number; max: number; tickMs: number }> {
    const out: Array<{ index: number; lit: number; max: number; tickMs: number }> = [];
    for (const house of this.houses) {
      let lit = 0;
      let max = 0;
      const vl = house.voxLight;
      if (vl) {
        for (let i = 0; i < vl.length; i += 1) {
          if (vl[i] > 0.05) lit += 1;
          if (vl[i] > max) max = vl[i];
        }
      }
      out.push({ index: house.index, lit, max: +max.toFixed(3), tickMs: +this.lightTickMs.toFixed(2) });
    }
    return out;
  }

  /** 색광 paint audit (QA): raw instanceColor rows vs baked base + L. */
  lightPaintRows(houseIndex: number, n = 8): Array<{ base: number[]; painted: number[]; l: number }> {
    const house = this.houses[houseIndex];
    const buf = this.mesh.instanceColor?.array as Float32Array | undefined;
    if (!house || !buf) return [];
    const out: Array<{ base: number[]; painted: number[]; l: number }> = [];
    // brightest-L voxels first — the rows that SHOULD show the tint.
    const order = Array.from(house.voxLight ?? new Float32Array(0))
      .map((l, i) => [l, i] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, n);
    for (const [l, i] of order) {
      const slot = house.slots[i];
      out.push({
        base: [+house.sr[i].toFixed(3), +house.sg[i].toFixed(3), +house.sb[i].toFixed(3)],
        painted: [+buf[slot * 3].toFixed(3), +buf[slot * 3 + 1].toFixed(3), +buf[slot * 3 + 2].toFixed(3)],
        l: +l.toFixed(3),
      });
    }
    return out;
  }


  /** Rigid chunks waiting from support scans — the Game layer drains
   *  these into box3d rubble every frame. */
  drainDetachedVoxels(out: ChewedVoxel[]): number {
    if (this.detachedQueue.length === 0) return 0;
    for (const cube of this.detachedQueue) out.push(cube);
    const count = this.detachedQueue.length;
    this.detachedQueue.length = 0;
    return count;
  }

  aliveRatio(index: number): number {
    const house = this.houses[index];
    return house ? house.alive / house.count : 0;
  }

  houseCenter(index: number): { x: number; y: number; z: number } {
    const house = this.houses[index];
    if (!house) return { x: 0, y: 0, z: 0 };
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < house.count; i += 1) {
      x += house.sx[i];
      y += house.sy[i];
      z += house.sz[i];
    }
    return { x: x / house.count, y: y / house.count, z: z / house.count };
  }

  get houseCount(): number {
    return this.houses.length;
  }

  /** Alive cells across all houses — the moon-shadow cache's change signal. */
  get totalAlive(): number {
    let total = 0;
    for (const house of this.houses) total += house.alive;
    return total;
  }

  isCollapsed(index: number): boolean {
    return this.houses[index]?.collapsed ?? true;
  }

  /** Structure gone: the remaining cubes pancake — per-cube fall with
   *  height-staggered delays so the roof caves first. */
  triggerCollapse(index: number, rng: () => number): void {
    const house = this.houses[index];
    if (!house || house.collapsed) return;
    house.collapsed = true;
    // The house goes dark as it comes apart — the windows die with it.
    // (glowCells stays intact: reset() rebuilds panes from the glow tables.)
    if (house.glowCells) {
      for (let i = 0; i < house.count; i += 1) {
        const g = house.glowCells[i];
        if (g >= 0) this.hideGlow(g);
      }
    }
    house.fallDelay = new Float32Array(house.count);
    house.fallVx = new Float32Array(house.count);
    house.fallVy = new Float32Array(house.count);
    house.fallVz = new Float32Array(house.count);
    house.fallY = new Float32Array(house.count);
    let top = 0;
    for (let i = 0; i < house.count; i += 1) top = Math.max(top, house.sy[i]);
    for (let i = 0; i < house.count; i += 1) {
      const aliveCell = house.cellSlot[this.cellOf(house, house.sx[i], house.sy[i], house.sz[i])] === i + 1;
      house.fallDelay[i] = aliveCell ? ((top - house.sy[i]) / Math.max(2, top - house.baseY)) * 0.55 + rng() * 0.12 : -1;
      house.fallVx[i] = (rng() - 0.5) * 1.4;
      house.fallVy[i] = -(0.4 + rng() * 1.2);
      house.fallVz[i] = (rng() - 0.5) * 1.4;
      house.fallY[i] = house.sy[i];
    }
  }

  /** Collapse animation tick — returns landed-cube positions for dust. */
  update(delta: number, onLand: (x: number, y: number, z: number) => void): void {
    this.voxTime += delta;
    for (const house of this.houses) this.scanSupport(house);
    let dirty = false;
    for (const house of this.houses) {
      const fallDelay = house.fallDelay;
      const fallVx = house.fallVx;
      const fallVy = house.fallVy;
      const fallVz = house.fallVz;
      const fallY = house.fallY;
      if (!house.collapsed || !fallDelay || !fallVx || !fallVy || !fallVz || !fallY) continue;
      const houseTop = top(house);
      const fallSpan = Math.max(2, houseTop - house.baseY);
      for (let i = 0; i < house.count; i += 1) {
        if (fallDelay[i] < 0) continue;
        if (fallDelay[i] > 0) {
          fallDelay[i] -= delta;
          continue;
        }
        fallVy[i] -= 26 * delta;
        fallY[i] += fallVy[i] * delta;
        const drift = ((houseTop - fallY[i]) / fallSpan) * 0.05;
        if (fallY[i] <= house.baseY + house.size * 0.5) {
          fallDelay[i] = -1;
          house.alive -= 1;
          this.killSlot(house.slots[i]);
          if (i % 17 === 0) onLand(house.sx[i], house.baseY + 0.5, house.sz[i]);
          dirty = true;
          continue;
        }
        this.pos.set(
          house.sx[i] + fallVx[i] * drift,
          fallY[i],
          house.sz[i] + fallVz[i] * drift,
        );
        this.matrix.compose(this.pos, this.quat, this.scale1);
        this.mesh.setMatrixAt(house.slots[i], this.matrix);
        dirty = true;
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
    // 색광 bake — throttled; the epsilon gate inside keeps the color
    // buffer quiet unless a fire actually moved or a wall opened.
    this.lightAccum -= delta;
    if (this.lightAccum <= 0) {
      this.lightAccum = LIGHT_TICK;
      const t0 = performance.now();
      this.tickLight();
      this.lightTickMs = this.lightTickMs * 0.8 + (performance.now() - t0) * 0.2;
    }
    // 촛불 플리커 — slow dual-sine per pane, deterministic in game time.
    this.glowTime += delta;
    this.glowTick -= delta;
    if (this.glowTick <= 0 && this.glowTotal > 0) {
      this.glowTick = 0.12;
      const t = this.glowTime;
      for (let s = 0; s < this.glowTotal; s += 1) {
        const flicker = 0.72
          + 0.28 * Math.sin(t * 3.1 + this.glowPhase[s]) * Math.sin(t * 1.7 + this.glowPhase[s] * 1.3);
        this.glowMesh.setColorAt(s, this.capColor.setRGB(
          this.glowBase[s * 3] * flicker,
          this.glowBase[s * 3 + 1] * flicker,
          this.glowBase[s * 3 + 2] * flicker,
        ));
      }
      if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Run restart: every cube back in place. */
  reset(): void {
    let slot = 0;
    for (const house of this.houses) {
      house.alive = house.count;
      house.collapsed = false;
      house.fallDelay = null;
      house.fallVx = null;
      house.fallVy = null;
      house.fallVz = null;
      house.fallY = null;
      house.lastSupportScan = -1;
      house.lastScanAlive = -1;
      house.voxLight?.fill(0); // bake state restarts cold
      house.cOccAlive = -1;
      house.lightSig = -1;
      house.cellSlot.fill(0);
      for (let i = 0; i < house.count; i += 1) {
        house.slots[i] = slot + i;
        house.cellSlot[this.cellOf(house, house.sx[i], house.sy[i], house.sz[i])] = i + 1;
        this.writeSlot(slot + i, house.sx[i], house.sy[i], house.sz[i], house.sr[i], house.sg[i], house.sb[i]);
      }
      slot += house.count;
    }
    this.mesh.count = this.total;
    this.flush();
    // 창호지 back on the walls — panes rebuild from the glow tables.
    for (let s = 0; s < this.glowTotal; s += 1) {
      const house = this.houses[this.glowHouse[s]];
      const i = this.glowCell[s];
      if (!house || i < 0) continue;
      this.pos.set(house.sx[i] + this.glowOffX[s], house.sy[i], house.sz[i] + this.glowOffZ[s]);
      this.scale1.set(house.size * 1.04, house.size * 1.04, house.size * 0.42);
      this.matrix.compose(this.pos, this.quat, this.scale1);
      this.glowMesh.setMatrixAt(s, this.matrix);
      this.glowMesh.setColorAt(s, this.capColor.setRGB(
        this.glowBase[s * 3], this.glowBase[s * 3 + 1], this.glowBase[s * 3 + 2],
      ));
    }
    if (this.glowTotal > 0) {
      this.glowMesh.count = this.glowTotal;
      this.glowMesh.instanceMatrix.needsUpdate = true;
      if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.glowMesh.geometry.dispose();
    (this.glowMesh.material as THREE.Material).dispose();
    this.glowMesh.removeFromParent();
  }
}

function top(house: HouseVoxels): number {
  let t = 0;
  for (let i = 0; i < house.count; i += 1) t = Math.max(t, house.sy[i]);
  return t;
}

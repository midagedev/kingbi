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
  /** Collapse animation state (allocated on trigger). */
  fallDelay: Float32Array | null;
  fallVx: Float32Array | null;
  fallVy: Float32Array | null;
  fallVz: Float32Array | null;
  fallY: Float32Array | null;
}

export interface ChewedVoxel {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
}

/** Splat a placed group's triangles into surface voxels (build-time only). */
export function voxelizeGroup(
  group: THREE.Group,
  size: number,
  jitter: () => number,
  region?: { cx: number; cz: number; rx: number; rz: number; yMax?: number },
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
    const shade = 0.45 + 0.55 * Math.max(0, normal.dot(moon));
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

export class VoxelHouses {
  readonly mesh: THREE.InstancedMesh;
  private readonly houses: HouseVoxels[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly scale1 = new THREE.Vector3(1, 1, 1);
  private readonly scale0 = new THREE.Vector3(0, 0, 0);
  private readonly pos = new THREE.Vector3();
  private readonly capColor = new THREE.Color();
  private total = 0;

  constructor(scene: THREE.Scene, capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'voxel-houses';
    this.mesh.count = 0;
    scene.add(this.mesh);
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
      fallDelay: null, fallVx: null, fallVy: null, fallVz: null, fallY: null,
    };
    this.houses.push(house);
    for (let i = 0; i < count; i += 1) {
      const slot = start + i;
      house.slots[i] = slot;
      house.cellSlot[this.cellOf(house, data.sx[i], data.sy[i], data.sz[i])] = i + 1;
      this.writeSlot(slot, data.sx[i], data.sy[i], data.sz[i], data.sr[i], data.sg[i], data.sb[i]);
    }
    this.mesh.count = this.total;
    this.flush();
    return house.index;
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
      if (x < house.originX - radius || x > house.originX + house.nx * house.size + radius) continue;
      if (z < house.originZ - radius || z > house.originZ + house.nz * house.size + radius) continue;
      if (y < house.originY - radius || y > house.originY + house.ny * house.size + radius) continue;
      for (let i = 0; i < house.count; i += 1) {
        if (house.cellSlot[this.cellOf(house, house.sx[i], house.sy[i], house.sz[i])] !== i + 1) continue;
        const dx = house.sx[i] - x;
        const dy = house.sy[i] - y;
        const dz = house.sz[i] - z;
        if (dx * dx + dy * dy + dz * dz > rSq) continue;
        house.cellSlot[this.cellOf(house, house.sx[i], house.sy[i], house.sz[i])] = 0;
        house.alive -= 1;
        this.killSlot(house.slots[i]);
        out.push({ x: house.sx[i], y: house.sy[i], z: house.sz[i], r: house.sr[i], g: house.sg[i], b: house.sb[i] });
        removed += 1;
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
      out.push({ x: house.sx[i], y: house.sy[i], z: house.sz[i], r: house.sr[i], g: house.sg[i], b: house.sb[i] });
      taken += 1;
    }
    if (taken > 0) this.flush();
    return taken;
  }

  /** Rubble body half-size for this house's cube scale. */
  halfSize(index: number): number {
    const house = this.houses[index];
    return (house ? house.size : 0.4) * 0.58;
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

  isCollapsed(index: number): boolean {
    return this.houses[index]?.collapsed ?? true;
  }

  /** Structure gone: the remaining cubes pancake — per-cube fall with
   *  height-staggered delays so the roof caves first. */
  triggerCollapse(index: number, rng: () => number): void {
    const house = this.houses[index];
    if (!house || house.collapsed) return;
    house.collapsed = true;
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
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

function top(house: HouseVoxels): number {
  let t = 0;
  for (let i = 0; i < house.count; i += 1) t = Math.max(t, house.sy[i]);
  return t;
}

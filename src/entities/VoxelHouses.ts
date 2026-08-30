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
): {
  sx: Float32Array; sy: Float32Array; sz: Float32Array;
  sr: Float32Array; sg: Float32Array; sb: Float32Array;
  box: THREE.Box3;
} | null {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (!Number.isFinite(box.min.x) || box.isEmpty()) return null;
  box.expandByScalar(size * 0.55);
  const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / size));
  const ny = Math.max(1, Math.ceil((box.max.y - box.min.y) / size));
  const nz = Math.max(1, Math.ceil((box.max.z - box.min.z) / size));
  if (nx * ny * nz > 262144) return null;

  const colors = new Float32Array(nx * ny * nz * 3);
  const occupied = new Uint8Array(nx * ny * nz);
  const tri = new THREE.Triangle();
  const cp = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const reachSq = (size * 0.62) * (size * 0.62);

  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const material = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) return;
    const color = (material as THREE.MeshStandardMaterial).color ?? new THREE.Color(0xffffff);
    const pos = mesh.geometry.attributes.position;
    if (!pos) return;
    const index = mesh.geometry.index;
    const faces = (index ? index.count : pos.count) / 3;
    for (let f = 0; f < faces; f += 1) {
      for (let v = 0; v < 3; v += 1) {
        const i = index ? index.getX(f * 3 + v) : f * 3 + v;
        const vert = v === 0 ? a : v === 1 ? b : c;
        vert.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
      }
      tri.set(a, b, c);
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
            colors[cell * 3] = color.r;
            colors[cell * 3 + 1] = color.g;
            colors[cell * 3 + 2] = color.b;
          }
        }
      }
    }
  });

  let total = 0;
  for (let i = 0; i < occupied.length; i += 1) total += occupied[i];
  if (total === 0) return null;
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
        sr[w] = colors[cell * 3];
        sg[w] = colors[cell * 3 + 1];
        sb[w] = colors[cell * 3 + 2];
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
    const material = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
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

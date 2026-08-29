import * as THREE from 'three';

/**
 * Tracer + shell pool: stretched glowing boxes from muzzle to impact,
 * fading over ~70ms, plus tumbling brass casings.
 */
export class TracerPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly beams: THREE.InstancedMesh;
  private readonly shells: THREE.InstancedMesh;
  private readonly tracers: Array<{
    active: boolean;
    from: THREE.Vector3;
    to: THREE.Vector3;
    life: number;
  }> = [];
  private readonly casings: Array<{
    active: boolean;
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    spin: number; life: number;
  }> = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly dirV = new THREE.Vector3();
  private readonly midV = new THREE.Vector3();
  private readonly scaleV = new THREE.Vector3();
  private readonly posV = new THREE.Vector3();

  constructor(scene: THREE.Scene, capacity: number) {
    // Tracer: fat HDR-red streak box — must read as a hose of fire cutting
    // through the noir night, not a thin spark.
    const tracerGeo = new THREE.BoxGeometry(0.3, 1, 0.3);
    const tracerMat = new THREE.MeshBasicMaterial({
      // >1 components: additive HDR red that survives the ACES + noir grade.
      color: new THREE.Color(2.6, 0.5, 0.26),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(tracerGeo, tracerMat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    // Beam layer: a faint full-path red hose under the dashes — continuous
    // fire reads as one river of fire from muzzle to the yard, not lone sparks.
    const beamGeo = new THREE.BoxGeometry(0.15, 1, 0.15);
    const beamMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.5, 0.24, 0.12),
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.beams = new THREE.InstancedMesh(beamGeo, beamMat, capacity);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.beams);

    // Casings: oversized brass so the eject stream reads at quarter-view
    // distance — tiny faithful brass vanishes in the murk.
    const shellGeo = new THREE.CylinderGeometry(0.021, 0.021, 0.095, 5);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xd9b45e, roughness: 0.3, metalness: 0.95 });
    this.shells = new THREE.InstancedMesh(shellGeo, shellMat, capacity);
    this.shells.frustumCulled = false;
    this.shells.count = 0;
    this.shells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.shells);

    for (let i = 0; i < capacity; i += 1) {
      this.tracers.push({ active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), life: 0 });
      this.casings.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, life: 0 });
    }
  }

  spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const slot = this.tracers.find((t) => !t.active);
    if (!slot) return;
    slot.active = true;
    slot.from.copy(from);
    slot.to.copy(to);
    slot.life = 0.16;
  }

  spawnCasing(x: number, y: number, z: number, rightX: number, rightZ: number, rng: () => number): void {
    const slot = this.casings.find((c) => !c.active);
    if (!slot) return;
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.vx = rightX * (1.6 + rng() * 1.2);
    slot.vz = rightZ * (1.6 + rng() * 1.2);
    slot.vy = 1.6 + rng() * 1.1;
    slot.spin = rng() * 8;
    slot.life = 1.6;
  }

  update(delta: number, groundAt: (x: number, z: number) => number): void {
    this.elapsedTime += delta;
    let tracerCount = 0;
    let beamCount = 0;
    for (const tracer of this.tracers) {
      if (!tracer.active) continue;
      tracer.life -= delta;
      if (tracer.life <= 0) {
        tracer.active = false;
        continue;
      }
      this.dirV.subVectors(tracer.to, tracer.from);
      const length = this.dirV.length();
      if (length < 0.01) continue;
      this.dirV.divideScalar(length);

      // Faint full-path beam: the river of fire connecting muzzle to target.
      this.midV.addVectors(tracer.from, tracer.to).multiplyScalar(0.5);
      this.quat.setFromUnitVectors(this.up, this.dirV);
      const beamFade = Math.min(1, tracer.life / 0.16);
      this.scaleV.set(beamFade, length, beamFade);
      this.matrix.compose(this.midV, this.quat, this.scaleV);
      this.beams.setMatrixAt(beamCount, this.matrix);
      beamCount += 1;

      // Bright sliding dash: a long streak racing along the path.
      const visualLength = Math.min(length, 5.5);
      this.scaleV.set(1, visualLength, 1);
      const phase = ((this.elapsedTime * 90 + tracer.life * 140) % Math.max(0.001, length - visualLength)) / Math.max(0.001, length - visualLength);
      this.midV.copy(tracer.from).addScaledVector(this.dirV, visualLength / 2 + phase * Math.max(0, length - visualLength));
      this.matrix.compose(this.midV, this.quat, this.scaleV);
      this.mesh.setMatrixAt(tracerCount, this.matrix);
      tracerCount += 1;
    }
    this.mesh.count = tracerCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.beams.count = beamCount;
    this.beams.instanceMatrix.needsUpdate = true;

    let shellCount = 0;
    for (const casing of this.casings) {
      if (!casing.active) continue;
      casing.life -= delta;
      casing.vy -= 12 * delta;
      casing.x += casing.vx * delta;
      casing.y += casing.vy * delta;
      casing.z += casing.vz * delta;
      const ground = groundAt(casing.x, casing.z) + 1.62;
      if (casing.y < ground) {
        casing.y = ground;
        casing.vy = 0;
        casing.vx *= 0.6;
        casing.vz *= 0.6;
      }
      if (casing.life <= 0) {
        casing.active = false;
        continue;
      }
      this.euler.set(casing.spin * casing.life * 6, casing.spin, 0);
      this.quat.setFromEuler(this.euler);
      this.posV.set(casing.x, casing.y, casing.z);
      this.scaleV.setScalar(1);
      this.matrix.compose(this.posV, this.quat, this.scaleV);
      this.shells.setMatrixAt(shellCount, this.matrix);
      shellCount += 1;
    }
    this.shells.count = shellCount;
    this.shells.instanceMatrix.needsUpdate = true;
  }

  private elapsedTime = 0;

  clear(): void {
    for (const tracer of this.tracers) tracer.active = false;
    for (const casing of this.casings) casing.active = false;
    this.mesh.count = 0;
    this.beams.count = 0;
    this.shells.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.beams.geometry.dispose();
    (this.beams.material as THREE.Material).dispose();
    this.shells.geometry.dispose();
    (this.shells.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.beams.removeFromParent();
    this.shells.removeFromParent();
  }
}

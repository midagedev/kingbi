// Near-focus eave drip + minimal eave-line splash (#215 / look-audit U3).
//
// Draw / program budget (document for gates and reviewers):
//   Active near rain only (detail band + building presence + rainLevel):
//     +1 draw  InstancedMesh drips   (MeshBasicMaterial — stock program family)
//     +1 draw  InstancedMesh splash  (MeshBasicMaterial — stock program family)
//     +0 custom ShaderMaterial / FAR Points programs
//   Sleep (aerial, clear weather, empty site, detailWeight≈0):
//     both meshes visible=false, zero CPU advance, zero GPU submission
//   Out of scope (still banned after #131): roof rivulets, snow volume shells,
//   yard-wide splash carpet, Points impostors.
//
// Physical contract: drip streaks are thin world cylinders (≈5mm radius, 0.3–0.6m
// length) falling from the eave line; splash is a tiny horizontal disc at ground under
// each drip anchor. Intermittent bead cycles come from eave-rain-plan.js.

import * as THREE from 'three';
import { getWind } from './wind.js';
import {
  eaveDripActive,
  planEaveAnchors,
} from './eave-rain-plan.js';

const _mat4 = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _world = new THREE.Vector3();
const _lean = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();
const _quatLean = new THREE.Quaternion();
const _scl = new THREE.Vector3();

function disposeOwned(...resources) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const resource of resources) {
      if (resource && typeof resource.dispose === 'function') resource.dispose();
    }
  };
}

/**
 * createEaveRain(scene) → {
 *   rebuild(layout, subject?), update(dt, { time, level, nearWeight }),
 *   setEnabled(bool), dispose(), get count, get active
 * }
 *
 * subject: Object3D whose matrixWorld places the layout (building or focus
 * overlay house). Null = layout is world-aligned at the origin.
 */
export function createEaveRain(scene) {
  const group = new THREE.Group();
  group.name = 'weatherEaveRain';
  group.visible = false;
  scene.add(group);

  // Shared base geometries. InstancedMesh owns per-instance matrices; keep base as
  // ordinary BufferGeometry (not InstancedBufferGeometry + custom attrs).
  const dripGeo = new THREE.CylinderGeometry(1, 1, 1, 3, 1, true);
  const splashGeo = new THREE.CircleGeometry(1, 8);
  splashGeo.rotateX(-Math.PI / 2);

  const dripMat = new THREE.MeshBasicMaterial({
    color: 0xa8c4d8,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const splashMat = new THREE.MeshBasicMaterial({
    color: 0xc8d8e8,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  let dripMesh = null;
  let splashMesh = null;
  let capacity = 0;

  let plan = null;
  let subject = null;
  const subjectMatrix = new THREE.Matrix4();
  let y = new Float32Array(0);
  let N = 0;
  let enabled = true;
  let active = false;
  const disposeResources = disposeOwned(dripGeo, dripMat, splashGeo, splashMat);

  function allocMeshes(count) {
    const cap = Math.max(1, count);
    if (dripMesh) {
      group.remove(dripMesh);
      dripMesh = null;
    }
    if (splashMesh) {
      group.remove(splashMesh);
      splashMesh = null;
    }
    dripMesh = new THREE.InstancedMesh(dripGeo, dripMat, cap);
    dripMesh.name = 'weatherEaveDrips';
    dripMesh.frustumCulled = false;
    dripMesh.renderOrder = 22;
    dripMesh.count = 0;
    dripMesh.visible = false;
    group.add(dripMesh);

    splashMesh = new THREE.InstancedMesh(splashGeo, splashMat, cap);
    splashMesh.name = 'weatherEaveSplash';
    splashMesh.frustumCulled = false;
    splashMesh.renderOrder = 23;
    splashMesh.count = 0;
    splashMesh.visible = false;
    group.add(splashMesh);

    capacity = cap;
  }

  function rebuild(layout, nextSubject = null) {
    subject = nextSubject || null;
    plan = planEaveAnchors(layout || {});
    N = plan.count;
    y = new Float32Array(N);
    for (let i = 0; i < N; i++) y[i] = plan.anchors[i].y0;

    if (subject?.matrixWorld) {
      subject.updateWorldMatrix(true, false);
      subjectMatrix.copy(subject.matrixWorld);
    } else {
      subjectMatrix.identity();
    }

    if (!dripMesh || !splashMesh || capacity < N) allocMeshes(N);
    dripMesh.count = N;
    splashMesh.count = N;

    for (let i = 0; i < N; i++) {
      writeDrip(i, 0, 0, 0);
      writeSplash(i, 0, 0);
    }
    dripMesh.instanceMatrix.needsUpdate = true;
    splashMesh.instanceMatrix.needsUpdate = true;
  }

  function localToWorld(lx, ly, lz, out) {
    _local.set(lx, ly, lz);
    return out.copy(_local).applyMatrix4(subjectMatrix);
  }

  function writeDrip(i, time, leanX, leanZ) {
    const a = plan.anchors[i];
    if (!eaveDripActive(time, a.period, a.phase)) {
      _mat4.makeScale(0, 0, 0);
      dripMesh.setMatrixAt(i, _mat4);
      return;
    }
    localToWorld(a.ax, y[i], a.az, _world);
    const half = a.length * 0.5;
    _lean.set(-leanX, -1, -leanZ).normalize();
    _world.x += _lean.x * half;
    _world.y += _lean.y * half;
    _world.z += _lean.z * half;
    _quatLean.setFromUnitVectors(_up, _lean);
    // ~8mm matches the rain visual upper-bound radius — still physical, never a FAR point.
    const radius = 0.008;
    _scl.set(radius, a.length, radius);
    _mat4.compose(_world, _quatLean, _scl);
    dripMesh.setMatrixAt(i, _mat4);
  }

  function writeSplash(i, time, level) {
    const a = plan.anchors[i];
    // Sparse pulse — not a popcorn yard carpet (look-audit U3 minimal).
    const cyc = ((time / a.splashPeriod + a.splashPhase) % 1 + 1) % 1;
    const pulse = cyc < 0.35 ? (1 - cyc / 0.35) : 0;
    if (pulse < 0.02 || level < 0.02) {
      _mat4.makeScale(0, 0, 0);
      splashMesh.setMatrixAt(i, _mat4);
      return;
    }
    localToWorld(a.splashX, a.botY + 0.04, a.splashZ, _world);
    const r = a.splashScale * (0.55 + 0.9 * (1 - pulse));
    _quat.identity();
    _scl.set(r, 1, r);
    _mat4.compose(_world, _quat, _scl);
    splashMesh.setMatrixAt(i, _mat4);
  }

  function update(dt, {
    time = 0,
    level = 0,
    nearWeight = 0,
  } = {}) {
    if (!enabled || !plan || N === 0 || !dripMesh || !splashMesh) {
      setActive(false);
      return;
    }
    const weight = Math.max(0, Math.min(1, level)) * Math.max(0, Math.min(1, nearWeight));
    if (weight < 0.02) {
      setActive(false);
      return;
    }
    setActive(true);

    if (subject?.matrixWorld) {
      subject.updateWorldMatrix(true, false);
      subjectMatrix.copy(subject.matrixWorld);
    }

    const wind = getWind(time);
    const leanX = (wind?.dirX || 0) * (wind?.speed || 0) * 0.25;
    const leanZ = (wind?.dirZ || 0) * (wind?.speed || 0) * 0.25;

    dripMat.opacity = 0.5 * weight;
    splashMat.opacity = 0.32 * weight;

    for (let i = 0; i < N; i++) {
      const a = plan.anchors[i];
      y[i] -= a.speed * dt;
      if (y[i] < a.botY) y[i] = a.topY;
      writeDrip(i, time, leanX, leanZ);
      writeSplash(i, time, weight);
    }
    dripMesh.instanceMatrix.needsUpdate = true;
    splashMesh.instanceMatrix.needsUpdate = true;
  }

  function setActive(on) {
    active = !!on;
    group.visible = active;
    if (dripMesh) dripMesh.visible = active;
    if (splashMesh) splashMesh.visible = active;
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) setActive(false);
  }

  function dispose() {
    setActive(false);
    if (dripMesh) group.remove(dripMesh);
    if (splashMesh) group.remove(splashMesh);
    scene.remove(group);
    dripMesh = null;
    splashMesh = null;
    disposeResources();
    plan = null;
    N = 0;
  }

  rebuild({});

  return {
    group,
    rebuild,
    update,
    setEnabled,
    dispose,
    get count() { return N; },
    get active() { return active; },
    get plan() { return plan; },
  };
}

export {
  planEaveAnchors,
  eaveDripActive,
  eaveDripCycle,
  EAVE_DRIP_ACTIVE_FRAC,
  EAVE_DRIP_SPACING,
  EAVE_RAIN_SEED,
} from './eave-rain-plan.js';

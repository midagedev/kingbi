import { setupVillageCritters } from '../../env/critters.js';
import { parcelRotY } from '../../generators/shared/parcel-transform.js';
import { parcelCritterStation } from '../../village/critter-station-plan.js';
import { villageDetailWeightAt } from './detail-lod.js';

/** Coordinate aerial flock and view-cell LOD for every village-scale ground animal. */
export function createVillageFaunaController({ group, plan, site, seed, time = 'day', season = 'summer' }) {
  const char01 = typeof plan.opts?.char01 === 'number' ? plan.opts.char01 : 0.5;
  const parcels = [];
  for (const parcel of plan.parcels) {
    if (parcel.hero || !parcel.poly) continue;
    parcels.push({
      x: parcel.center.x,
      z: parcel.center.z,
      baseY: parcel.baseY != null ? parcel.baseY : site.heightAt(parcel.center.x, parcel.center.z),
      W: parcel.plotW || 20,
      D: parcel.plotD || 18,
      rotY: parcelRotY(parcel),
      kind: parcel.kind === 'giwa' ? 'giwa' : 'choga',
      station: parcelCritterStation(parcel, site, char01),
    });
  }

  const treePerchesFor = (guardianAnchors, yardTreeAnchors) => {
    const perches = [];
    for (const tree of (guardianAnchors || [])) {
      perches.push({ x: tree.x, y: tree.y + (tree.h || 12) * 0.82, z: tree.z });
    }
    for (const tree of (yardTreeAnchors || [])) {
      perches.push({ x: tree.x, y: tree.y + 0.5, z: tree.z });
    }
    return perches;
  };
  const treePerches = treePerchesFor(
    group.userData.guardianAnchors,
    group.userData.yardTreeAnchors,
  );

  const bounds = plan.bounds || {};
  const radius = Math.max(bounds.w || 0, bounds.d || 0) * 0.5 || 40;
  const center = site.center || { x: 0, z: 0 };
  const rig = setupVillageCritters(group, {
    heightAt: (x, z) => site?.heightAt?.(x, z) ?? 0,
    center: { x: center.x, z: center.z },
    radius,
    scale: plan.scale,
    parcels,
    treePerches,
    seed: (seed ^ 0x00c1c7) >>> 0,
  });
  rig.setTime(time);
  rig.setSeason(season);

  // populate owns chickens/cows as setupAnimals handles; this controller only assigns
  // their shared camera-cell detail weight. Their normal animation remains in group.userData.update.
  const animalHandles = group.userData.animals?.handles || [];
  const residentialFlocks = new Set(animalHandles
    .map((animal) => animal.ownerParcelId)
    .filter((parcelId) => typeof parcelId === 'string' && parcelId));
  let detailState = null;
  const debugLod = {
    tier: 'near', groundWeight: 1,
    baseAnimals: {
      total: animalHandles.length,
      active: animalHandles.length,
      weights: animalHandles.map(() => 1),
      ownerParcelIds: animalHandles.map((animal) => animal.ownerParcelId ?? null),
      effectiveActive: animalHandles.map((animal) => animal.lod?.active === true),
      visible: animalHandles.map((animal) => animal.group?.visible === true),
    },
    critters: rig.lod,
  };
  // Keep one mutable snapshot on the village root so browser harnesses can assert sleep/wake
  // behavior without traversing meshes or adding a frame-time-dependent probe.
  group.userData.faunaLod = debugLod;
  // Seasonal sky-flock species and skein state for harnesses. Numbers only, computed on call.
  group.userData.faunaDebug = {
    counts: rig.counts,
    flock: () => rig.debugFlock(),
  };
  const resolveWeight = (point) => (detailState ? villageDetailWeightAt(detailState, point) : 1);

  function syncBaseDebug() {
    let active = 0;
    for (let i = 0; i < animalHandles.length; i++) {
      const animal = animalHandles[i];
      const isActive = animal.lod?.active === true;
      debugLod.baseAnimals.effectiveActive[i] = isActive;
      debugLod.baseAnimals.visible[i] = animal.group?.visible === true;
      if (isActive) active++;
    }
    debugLod.baseAnimals.active = active;
  }

  function updateLod(camera, detail) {
    detailState = detail;
    let visibilityChanged = rig.updateLod(camera, detail, resolveWeight);

    for (let i = 0; i < animalHandles.length; i++) {
      const animal = animalHandles[i];
      let weight = 0;
      for (const anchor of (animal.detailAnchors || [])) {
        weight = Math.max(weight, resolveWeight(anchor));
      }
      if (animal.setDetail?.(weight)) visibilityChanged = true;
      debugLod.baseAnimals.weights[i] = weight;
    }
    debugLod.tier = detail?.tier || 'near';
    debugLod.groundWeight = detail?.groundWeight ?? 1;
    syncBaseDebug();
    return visibilityChanged;
  }

  return {
    setTime(name) { rig.setTime(name); },
    setSeason(name) { rig.setSeason(name); },
    setTreePerches(guardianAnchors, yardTreeAnchors) {
      rig.setTreePerches(treePerchesFor(guardianAnchors, yardTreeAnchors));
    },
    update(dt) { rig.update(dt); },
    updateLod,
    hasResidentialFlock(parcelId) { return residentialFlocks.has(parcelId); },
    debugFlock() { return rig.debugFlock(); },
    debugLod,
  };
}

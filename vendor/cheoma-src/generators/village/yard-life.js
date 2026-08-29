import * as THREE from 'three';
import { patchInstFadeMaterial } from '../../env/inst-fade-shader.js';
import {
  createYardLifeBatches,
  disposeYardLifeBatches,
} from './yard-life-geometry.js';
import {
  YARD_LIFE_MATERIAL_ROLES,
  YARD_LIFE_SEASONS,
  YARD_LIFE_WEATHER,
  validateYardLifeRecords as validateRecords,
} from '../../village/yard-life-record-contract.js';
export {
  YARD_LIFE_MATERIAL_ROLES,
  YARD_LIFE_SEASONS,
  YARD_LIFE_WEATHER,
} from '../../village/yard-life-record-contract.js';

// Reusable physical renderer for the renderer-free yard-life record contract.
//
// This module owns no placement, parcel selection, product palette, season clock,
// camera thresholds, or global RNG. It consumes JSON records plus semantic
// caller-owned MeshStandardMaterial inputs. Derived fade materials and all
// geometries belong to the returned handle; the borrowed inputs remain untouched.

const LOD_EPSILON = 0.002;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function materialTextures(material) {
  const textures = [];
  for (const value of Object.values(material || {})) if (value?.isTexture) textures.push(value);
  return textures;
}

function createDerivedMaterials(materials) {
  const borrowed = {};
  const derived = {};
  try {
    for (const role of YARD_LIFE_MATERIAL_ROLES) {
      const source = materials?.[role];
      if (!source?.isMeshStandardMaterial) {
        throw new TypeError(`yard-life materials.${role} must be a MeshStandardMaterial`);
      }
      if (materialTextures(source).length) {
        throw new RangeError(`yard-life materials.${role} must not contain textures`);
      }
      borrowed[role] = source;
      const material = source.clone();
      material.name = `yard-life-${role}`;
      material.transparent = false;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.alphaHash = false;
      material.vertexColors = true;
      material.flatShading = true;
      material.userData = {
        ...source.userData,
        yardLifeRole: role,
        borrowedFromCaller: true,
      };
      patchInstFadeMaterial(material);
      material.needsUpdate = true;
      derived[role] = material;
    }
    return { borrowed, derived };
  } catch (error) {
    for (const material of Object.values(derived)) material.dispose();
    throw error;
  }
}

function createShadowMaterial(kind) {
  const material = kind === 'distance'
    ? new THREE.MeshDistanceMaterial()
    : new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.name = `yard-life-${kind}`;
  material.allowOverride = false;
  patchInstFadeMaterial(material);
  return material;
}

/**
 * Build a stable, role-batched yard-life controller.
 *
 * The input materials are borrowed. The controller clones them once to install
 * vertex-color and opaque screen-door presentation without mutating a material
 * that the caller may also use on meshes lacking `instFade`.
 */
export function buildYardLife(records, {
  materials,
  heightAt,
  season = 'summer',
  weather = 'clear',
  transitionSeconds = 0.9,
} = {}) {
  if (!YARD_LIFE_SEASONS.includes(season)) throw new RangeError(`unsupported yard-life season ${season}`);
  if (!YARD_LIFE_WEATHER.includes(weather)) throw new RangeError(`unsupported yard-life weather ${weather}`);
  const defaultDuration = Math.max(0, finite(transitionSeconds, 'yard-life transitionSeconds'));
  const { borrowed, derived } = createDerivedMaterials(materials);
  const depthMaterial = createShadowMaterial('depth');
  const distanceMaterial = createShadowMaterial('distance');
  const group = new THREE.Group();
  group.name = 'village-yard-life';

  let normalizedRecords;
  let batches = [];
  let recordBounds = [];
  let disposed = false;
  let waveWeight = 1;
  let currentSeason = season;
  let currentWeather = weather;
  let rebuildCount = 0;
  let skippedRebuilds = 0;
  let updateCount = 0;
  let skippedUpdates = 0;
  let lodScanCount = 0;
  let lodSleepCount = 0;
  let lastDetail = null;
  let lastWeightAt = null;
  let recordFingerprint = null;
  let detailSleeping = false;

  let seasonState;
  let weatherState;
  let detailWeights;
  let detailScratch;
  let presentationWeights;

  function makeTransitionState(length, name) {
    return {
      name,
      from: new Float32Array(length),
      current: new Float32Array(length),
      target: new Float32Array(length),
      elapsed: 0,
      duration: defaultDuration,
      active: false,
    };
  }

  function seasonTarget(record) {
    return record.season === currentSeason ? 1 : 0;
  }

  function weatherTarget(record) {
    return record.weather.has(currentWeather) ? 1 : 0;
  }

  function recordSetFingerprint(nextRecords) {
    return JSON.stringify(nextRecords, (_key, value) => (
      value instanceof Set ? [...value].sort() : value
    ));
  }

  function preserveTransition(nextState, previousState, previousRecords, nextRecords) {
    if (!previousState?.active || !previousRecords?.length) return;
    const previousIndexById = new Map(
      previousRecords.map((record, index) => [record.id, index]),
    );
    let preserved = false;
    let targetChanged = false;
    const preservedIndices = [];
    for (let index = 0; index < nextRecords.length; index++) {
      const previousIndex = previousIndexById.get(nextRecords[index].id);
      if (previousIndex == null) continue;
      const value = previousState.current[previousIndex];
      const sameTarget = Math.abs(
        previousState.target[previousIndex] - nextState.target[index],
      ) <= 1e-6;
      nextState.from[index] = sameTarget
        ? previousState.from[previousIndex]
        : value;
      nextState.current[index] = value;
      preservedIndices.push(index);
      targetChanged ||= !sameTarget;
      preserved ||= Math.abs(value - nextState.target[index]) > 1e-6;
    }
    if (!preserved) return;
    if (targetChanged) {
      // A semantic target changed under a stable ID. Preserve the visible value,
      // then ease every carried record over the old transition's remaining time.
      for (const index of preservedIndices) {
        nextState.from[index] = nextState.current[index];
      }
      nextState.elapsed = 0;
      nextState.duration = Math.max(
        0,
        previousState.duration - previousState.elapsed,
      );
    } else {
      // A geometry-only rebuild must stay on the exact original time curve.
      nextState.elapsed = previousState.elapsed;
      nextState.duration = previousState.duration;
    }
    nextState.active = nextState.duration > nextState.elapsed;
    if (!nextState.active) nextState.current.set(nextState.target);
  }

  function createPresentationStates(nextRecords, nextDetailWeights) {
    const length = nextRecords.length;
    const nextSeasonState = makeTransitionState(length, currentSeason);
    const nextWeatherState = makeTransitionState(length, currentWeather);
    const nextPresentationWeights = new Float32Array(length);
    for (let index = 0; index < length; index++) {
      const seasonValue = seasonTarget(nextRecords[index]);
      const weatherValue = weatherTarget(nextRecords[index]);
      nextSeasonState.from[index]
        = nextSeasonState.current[index]
        = nextSeasonState.target[index]
        = seasonValue;
      nextWeatherState.from[index]
        = nextWeatherState.current[index]
        = nextWeatherState.target[index]
        = weatherValue;
    }
    preserveTransition(
      nextSeasonState,
      seasonState,
      normalizedRecords,
      nextRecords,
    );
    preserveTransition(
      nextWeatherState,
      weatherState,
      normalizedRecords,
      nextRecords,
    );
    return {
      seasonState: nextSeasonState,
      weatherState: nextWeatherState,
      detailWeights: nextDetailWeights,
      presentationWeights: nextPresentationWeights,
    };
  }

  function resolveDetailWeights(nextRecords, detail, weightAt, target = null) {
    const resolvedWeights = target?.length === nextRecords.length
      ? target
      : new Float32Array(nextRecords.length);
    const allowed = detail?.groundActive !== false;
    const fallback = allowed ? clamp01(detail?.groundWeight ?? 1) : 0;
    const resolveWeight = typeof weightAt === 'function' ? weightAt : null;
    for (let index = 0; index < nextRecords.length; index++) {
      const resolved = allowed && resolveWeight
        ? resolveWeight(nextRecords[index].world)
        : fallback;
      resolvedWeights[index] = clamp01(resolved);
    }
    return resolvedWeights;
  }

  function applyPresentation() {
    if (disposed) return false;
    let anyVisible = false;
    for (let index = 0; index < normalizedRecords.length; index++) {
      const value = clamp01(
        seasonState.current[index]
        * weatherState.current[index]
        * detailWeights[index]
        * waveWeight,
      );
      presentationWeights[index] = value;
      if (value > LOD_EPSILON) anyVisible = true;
    }

    let visibilityChanged = group.visible !== anyVisible;
    group.visible = anyVisible;
    for (const batch of batches) {
      const attribute = batch.geometry.attributes.instFade;
      const array = attribute.array;
      let dirty = false;
      for (const range of batch.ranges) {
        const value = presentationWeights[range.recordIndex];
        const end = range.start + range.count;
        if (array[range.start] === value) continue;
        array.fill(value, range.start, end);
        dirty = true;
      }
      if (dirty) attribute.needsUpdate = true;
      // Keep every stable role batch eligible whenever the layer is awake. The
      // zero-coverage records still discard before depth/color, while the product
      // subtree prewarm sees every future seasonal material before a transition.
      // Aerial sleep happens at the parent, so distant scenes submit zero draws.
      batch.mesh.visible = true;
    }
    return visibilityChanged;
  }

  function installRecords(nextRecords, nextHeightAt) {
    const validated = validateRecords(nextRecords, nextHeightAt);
    const nextFingerprint = recordSetFingerprint(validated);
    if (nextFingerprint === recordFingerprint) return false;
    // Resolve the stored product LOD policy before allocating or replacing any
    // geometry. A throwing callback therefore leaves the live records, batches,
    // visibility, and ownership graph untouched.
    const nextDetailWeights = resolveDetailWeights(
      validated,
      lastDetail,
      lastWeightAt,
      detailScratch,
    );
    const nextStates = createPresentationStates(validated, nextDetailWeights);
    const next = createYardLifeBatches(
      validated,
      derived,
      depthMaterial,
      distanceMaterial,
    );
    const previous = batches;
    const previousDetailWeights = detailWeights;
    for (const batch of previous) group.remove(batch.mesh);
    batches = next.batches;
    normalizedRecords = validated;
    recordFingerprint = nextFingerprint;
    recordBounds = next.bounds;
    seasonState = nextStates.seasonState;
    weatherState = nextStates.weatherState;
    detailWeights = nextStates.detailWeights;
    detailScratch = previousDetailWeights?.length === validated.length
      ? previousDetailWeights
      : new Float32Array(validated.length);
    presentationWeights = nextStates.presentationWeights;
    detailSleeping = lastDetail?.groundActive === false;
    for (const batch of batches) group.add(batch.mesh);
    disposeYardLifeBatches(previous);
    applyPresentation();
    return true;
  }

  function normalizeTransitionOptions(opts) {
    if (opts == null || typeof opts !== 'object') {
      throw new TypeError('yard-life transition options must be an object');
    }
    return {
      immediate: !!opts.immediate,
      duration: Math.max(
        0,
        finite(opts.duration ?? defaultDuration, 'yard-life transition duration'),
      ),
    };
  }

  function beginTransition(state, targetForRecord, {
    immediate,
    duration,
  }) {
    state.from.set(state.current);
    let changed = false;
    for (let index = 0; index < normalizedRecords.length; index++) {
      const target = targetForRecord(normalizedRecords[index]);
      state.target[index] = target;
      if (Math.abs(state.current[index] - target) > 1e-6) changed = true;
    }
    state.elapsed = 0;
    state.duration = duration;
    state.active = changed && !immediate && duration > 0;
    if (!state.active) state.current.set(state.target);
    return changed;
  }

  function advanceTransition(state, dt) {
    if (!state.active) return false;
    state.elapsed = Math.min(state.duration, state.elapsed + dt);
    const linear = state.duration > 0 ? state.elapsed / state.duration : 1;
    const eased = linear * linear * (3 - 2 * linear);
    for (let index = 0; index < state.current.length; index++) {
      state.current[index] = THREE.MathUtils.lerp(
        state.from[index],
        state.target[index],
        eased,
      );
    }
    if (linear >= 1) {
      state.current.set(state.target);
      state.active = false;
    }
    return true;
  }

  function settleTransition(state) {
    if (!state.active) return false;
    state.current.set(state.target);
    state.from.set(state.target);
    state.elapsed = state.duration;
    state.active = false;
    return true;
  }

  const api = {
    group,
    setSeason(name, opts = {}) {
      if (disposed) return false;
      if (!YARD_LIFE_SEASONS.includes(name)) throw new RangeError(`unsupported yard-life season ${name}`);
      const transition = normalizeTransitionOptions(opts);
      currentSeason = name;
      seasonState.name = name;
      const changed = beginTransition(seasonState, seasonTarget, {
        ...transition,
        immediate: transition.immediate || detailSleeping,
      });
      if (!detailSleeping) applyPresentation();
      return changed;
    },
    setWeather(name, opts = {}) {
      if (disposed) return false;
      if (!YARD_LIFE_WEATHER.includes(name)) throw new RangeError(`unsupported yard-life weather ${name}`);
      const transition = normalizeTransitionOptions(opts);
      currentWeather = name;
      weatherState.name = name;
      const changed = beginTransition(weatherState, weatherTarget, {
        ...transition,
        immediate: transition.immediate || detailSleeping,
      });
      if (!detailSleeping) applyPresentation();
      return changed;
    },
    update(dt) {
      if (disposed) return false;
      if (detailSleeping) {
        skippedUpdates++;
        return false;
      }
      const delta = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
      const seasonChanged = advanceTransition(seasonState, delta);
      const weatherChanged = advanceTransition(weatherState, delta);
      const changed = seasonChanged || weatherChanged;
      if (!changed) {
        skippedUpdates++;
        return false;
      }
      updateCount++;
      applyPresentation();
      return true;
    },
    updateLod(_camera, detail = null, weightAt = null) {
      if (disposed) return false;
      const nextWeightAt = typeof weightAt === 'function' ? weightAt : null;
      if (detail?.groundActive === false && detailSleeping) {
        lastDetail = detail;
        lastWeightAt = nextWeightAt;
        lodSleepCount++;
        return false;
      }
      const nextDetailWeights = resolveDetailWeights(
        normalizedRecords,
        detail,
        nextWeightAt,
        detailScratch,
      );
      lodScanCount++;
      let weightChanged = false;
      for (let index = 0; index < normalizedRecords.length; index++) {
        const nextWeight = nextDetailWeights[index];
        if (Math.abs(detailWeights[index] - nextWeight) > 1e-6) weightChanged = true;
      }
      lastDetail = detail;
      lastWeightAt = nextWeightAt;
      if (!weightChanged) {
        if (detail?.groundActive === false) {
          detailSleeping = true;
          settleTransition(seasonState);
          settleTransition(weatherState);
        }
        return false;
      }
      detailScratch = detailWeights;
      detailWeights = nextDetailWeights;
      detailSleeping = detail?.groundActive === false;
      if (detailSleeping) {
        // A fully covered layer has no visible intermediate state to preserve.
        // Settle once so future aerial frames can remain O(1).
        settleTransition(seasonState);
        settleTransition(weatherState);
      }
      const visibilityChanged = applyPresentation();
      return weightChanged || visibilityChanged;
    },
    setWaveFade(value) {
      if (disposed) return false;
      waveWeight = clamp01(value);
      if (detailSleeping) return false;
      return applyPresentation();
    },
    rebuild(nextRecords, { heightAt: nextHeightAt = heightAt } = {}) {
      if (disposed) return false;
      if (!installRecords(nextRecords, nextHeightAt)) {
        skippedRebuilds++;
        return false;
      }
      rebuildCount++;
      return true;
    },
    debug() {
      let triangles = 0;
      let activeRecords = 0;
      for (const batch of batches) {
        triangles += batch.geometry.attributes.position.count / 3;
      }
      for (const value of presentationWeights) if (value > LOD_EPSILON) activeRecords++;
      return {
        disposed,
        season: currentSeason,
        weather: currentWeather,
        transitioning: seasonState.active || weatherState.active,
        seasonTransitioning: seasonState.active,
        weatherTransitioning: weatherState.active,
        waveWeight,
        recordCount: normalizedRecords.length,
        activeRecords,
        allocatedDrawCalls: batches.length,
        submittedDrawCalls: batches.filter((batch) => batch.mesh.visible && group.visible).length,
        triangles,
        textures: 0,
        resources: {
          geometries: disposed ? 0 : batches.length,
          derivedMaterials: disposed ? 0 : Object.keys(derived).length + 2,
          borrowedMaterials: Object.keys(borrowed).length,
        },
        materialRoles: batches.map((batch) => batch.role),
        records: normalizedRecords.map((record) => ({
          id: record.id,
          owner: { parcelId: record.ownerId },
          motif: record.motif,
          season: record.season,
          variant: record.variant,
          slot: record.source.slot,
          local: record.source.local ? {
            x: record.source.local.x,
            y: record.source.local.y,
            z: record.source.local.z,
            yaw: record.source.local.yaw,
          } : null,
          world: { ...record.world },
          footprint: {
            shape: 'rect',
            halfX: record.footprint.halfX,
            halfZ: record.footprint.halfZ,
            yaw: Number.isFinite(record.source.footprint?.yaw)
              ? record.source.footprint.yaw
              : record.world.yaw,
          },
        })),
        recordBounds: recordBounds.map((bounds) => ({ ...bounds })),
        weights: [...presentationWeights],
        rebuildCount,
        skippedRebuilds,
        updateCount,
        skippedUpdates,
        lodScanCount,
        lodSleepCount,
        detailSleeping,
      };
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      disposeYardLifeBatches(batches);
      batches = [];
      group.clear();
      for (const material of Object.values(derived)) material.dispose();
      depthMaterial.dispose();
      distanceMaterial.dispose();
      group.userData.waveFade = null;
      group.userData.yardLife = null;
      group.visible = false;
      return true;
    },
  };

  group.userData.waveFade = { setWeight: (value) => api.setWaveFade(value) };
  group.userData.yardLife = api;
  try {
    installRecords(records, heightAt);
    api.setSeason(season, { immediate: true });
    api.setWeather(weather, { immediate: true });
  } catch (error) {
    api.dispose();
    throw error;
  }
  return api;
}

export function disposeYardLife(handle) {
  return handle?.dispose?.() === true;
}

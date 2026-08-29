import { candleFlicker } from '../../env/night-glow.js';
import { hashString } from '../../rng.js';

const WARM_LIGHT = 0xffb35c;
const TRANSITION_RATE = 2.4;
const TAU = Math.PI * 2;
const EMPTY_OWNER = Object.freeze({ length: 0 });

function levelForTime(name) {
  if (name === 'night') return 1;
  if (name === 'sunset') return 0.42;
  if (name === 'dawn') return 0.22;
  return 0;
}

function collectGlowMaterials(root) {
  const materials = [];
  const seen = new Set();
  root.traverse((object) => {
    const objectMaterials = Array.isArray(object.material)
      ? object.material
      : (object.material ? [object.material] : []);
    for (const material of objectMaterials) {
      const intensity = material?.userData?.hanjiGlow;
      if (intensity == null || seen.has(material)) continue;
      seen.add(material);
      materials.push(material);
    }
  });
  return materials;
}

export function createVillageNightGlow(root, onLevelChange = () => {}) {
  const records = new Map();
  const owners = new WeakMap();
  let elapsed = 0;
  let level = 0;
  let targetLevel = 0;
  let boost = 1;
  let transitionStarted = false;
  let disposed = false;

  function acquire(ownerRoot, ownerKey) {
    const materials = collectGlowMaterials(ownerRoot);
    for (let index = 0; index < materials.length; index++) {
      const material = materials[index];
      const existing = records.get(material);
      if (existing) {
        existing.ownerCount++;
        continue;
      }
      records.set(material, {
        material,
        intensity: material.userData.hanjiGlow,
        // Acquisition order changes with focus hops and verification probes.
        // Derive the candle phase from the semantic owner and stable material
        // traversal slot so identical scene state has identical light motion.
        phase: (hashString(`${ownerKey}|${index}`) / 0x100000000) * TAU,
        ownerCount: 1,
        patched: false,
        original: {
          emissive: material.emissive.getHex(),
          intensity: material.emissiveIntensity,
          map: material.emissiveMap,
        },
      });
    }
    return materials;
  }

  function restore(record) {
    if (!record.patched) return;
    const material = record.material;
    material.emissive.setHex(record.original.emissive);
    material.emissiveIntensity = record.original.intensity;
    material.emissiveMap = record.original.map;
    material.needsUpdate = true;
    record.patched = false;
  }

  function patch(active) {
    for (const record of records.values()) {
      const material = record.material;
      if (active && !record.patched) {
        material.emissive.setHex(WARM_LIGHT);
        material.emissiveMap = material.map || null;
        material.needsUpdate = true;
        record.patched = true;
      } else if (!active) restore(record);
    }
  }

  function apply(flicker) {
    for (const record of records.values()) {
      if (!record.patched) continue;
      const variation = flicker ? candleFlicker(elapsed, record.phase) : 1;
      record.material.emissiveIntensity = record.intensity * boost * level * variation;
    }
  }

  function setTime(name, { immediate = false } = {}) {
    if (disposed) return;
    targetLevel = levelForTime(name);
    if (!immediate && transitionStarted) return;
    level = targetLevel;
    patch(level > 0.001);
    apply(false);
    onLevelChange(0, level);
  }

  function update(dt) {
    if (disposed) return;
    transitionStarted = true;
    if (Math.abs(level - targetLevel) > 1e-4) {
      level += (targetLevel - level) * Math.min(1, dt * TRANSITION_RATE);
      if (Math.abs(level - targetLevel) <= 1e-4) level = targetLevel;
      patch(level > 0.001);
    }
    if (level > 0.001) {
      elapsed += dt;
      apply(true);
    }
    onLevelChange(dt, level);
  }

  acquire(root, 'village-base');

  return {
    setTime,
    update,
    setBoost(value) { if (!disposed) boost = value; },
    resetTransition() { if (!disposed) transitionStarted = false; },
    add(additionalRoot, ownerKey = additionalRoot?.userData?.parcelId
      || additionalRoot?.name || 'village-overlay') {
      if (disposed) return EMPTY_OWNER;
      const materials = acquire(additionalRoot, String(ownerKey));
      // Keep the existing length check cheap while ownership details remain private.
      const owner = Object.freeze({ length: materials.length });
      owners.set(owner, { materials, active: true });
      patch(level > 0.001);
      apply(false);
      return owner;
    },
    remove(owner) {
      if (disposed) return;
      const owned = owners.get(owner);
      if (!owned?.active) return;
      owned.active = false;
      for (const material of owned.materials) {
        const record = records.get(material);
        if (!record) continue;
        record.ownerCount--;
        if (record.ownerCount > 0) continue;
        restore(record);
        records.delete(material);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of records.values()) restore(record);
      records.clear();
    },
  };
}

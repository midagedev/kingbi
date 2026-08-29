import * as THREE from 'three';
import { markAttributeItems } from '../core/buffer-update-range.js';
import { normalizeVillageLensScale } from '../camera/optics.js';
import { hashString, makeRng } from '../rng.js';
import { collectOpeningGlowAnchors } from '../builder/opening-glow-anchors.js';
import { houseMatrix } from '../generators/shared/parcel-transform.js';
import { createPhysicalNightlightBatch } from './nightlight-physical-geometry.js';

// 원경 창불 발광 한지 면(태스크 #60, #81, #96) — 부감 야경의 마법.
//   실제 renderer가 확정한 고정 한지 면 anchor만 소비한다. 필지 크기나 처마 치수를 이 레이어에서
//   재추정하지 않으며, 깊이 테스트로 집·담·지형 뒤의 불빛을 정상적으로 가린다. 가까워지면 실제
//   창호 emissive가 바통을 이어받는다.
//
//   설계:
//   · 단일 InstancedBufferGeometry(1 드로우콜) — 집당 1~2면, 종가·궁·절은 밝게 여러 면. 호수 무관.
//   · 점등 곡선: uNight(0..1) = adapter vnight 를 매 프레임 그대로 받음(#50 크로스페이드 자동 정합).
//     각 점은 aThreshold(집집이 다른 점등 문턱)를 uNight 이 넘어설 때 smoothstep 으로 서서히 켜짐
//     → 석양(vnight≈0.42) 절반, 밤(1.0) 대부분. 팟 없이 차오름.
//   · 분포 서사: per-parcel wealth 상관 — 부유·격식 높은 집은 일찍(낮은 문턱)·밝게, 가난한 집은
//     늦게·어둡게, 일부는 아예 불 꺼짐(빈집·잠듦). 결정론(parcel.seed) — 같은 시드 같은 점등.
//   · 실제 opening anchor의 방향·폭·높이를 그대로 그린다. 근접 밴드(uFadeNear..uFadeNearEnd)에서
//     투명도 0으로 페이드 아웃해 실제 FULL 창호 emissive가 한 번만 이어받는다.
//
//   결정론: Math.random 미사용(전부 parcel/plan seed).

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

// 창불 팔레트(호롱·등잔) — night-glow WARM(0xffb35c) 계열. 촛불 주황 ↔ 등잔 노랑 사이 개체차.
const COLOR_CANDLE = new THREE.Color(0xff9a45);
const COLOR_LAMP = new THREE.Color(0xffcf88);

function regularProfile(parcel, kind = parcel.kind) {
  const rng = makeRng((parcel.seed ^ 0x9117e5) >>> 0);
  const wealth = clamp01(parcel.wealth != null ? parcel.wealth : 0.5);
  const dark = rng() < 0.06;
  const threshold = clamp(0.16 + (1 - wealth) * 0.4 + (rng() * 2 - 1) * 0.13, 0.06, 0.9);
  const lit = clamp01(0.5 + wealth * 0.5 + (rng() * 2 - 1) * 0.16);
  const warm = rng();
  const isGiwa = kind === 'giwa';
  const desired = dark ? 0 : ((isGiwa || wealth > 0.62) ? 2 : 1);
  const slots = [{
    lit, threshold, phase: rng() * TAU, warm,
  }, {
      lit: lit * (0.55 + rng() * 0.2), threshold: clamp(threshold + 0.06 + rng() * 0.08, 0.06, 0.95),
      phase: rng() * TAU, warm: clamp01(warm + (rng() * 2 - 1) * 0.2),
  }];
  return { capacity: 2, desired, kind: isGiwa ? 'giwa' : 'choga', slots };
}

function heroProfile(parcel) {
  const rng = makeRng((parcel.seed ^ 0x9117e5) >>> 0);
  return {
    capacity: 3,
    desired: 3,
    slots: Array.from({ length: 3 }, () => ({
      lit: 0.95 + rng() * 0.15,
      threshold: 0.10 + rng() * 0.06,
      phase: rng() * TAU,
      warm: 0.2 + rng() * 0.3,
    })),
  };
}

function featureProfile(feature, count, litBase, seedSalt) {
  const featureSeed = Number.isFinite(feature?.seed) ? feature.seed : 7;
  const rng = makeRng((featureSeed ^ seedSalt) >>> 0);
  return {
    capacity: count,
    desired: count,
    slots: Array.from({ length: count }, () => ({
      lit: litBase + rng() * 0.2,
      threshold: 0.08 + rng() * 0.05,
      phase: rng() * TAU,
      warm: 0.15 + rng() * 0.25,
    })),
  };
}

function transformAnchors(anchors, matrix) {
  const linear = new THREE.Matrix3().setFromMatrix4(matrix);
  return (anchors || []).map((anchor) => {
    const sourceOutward = new THREE.Vector3(
      anchor.outward.x, anchor.outward.y, anchor.outward.z,
    ).normalize();
    const position = new THREE.Vector3(
      anchor.position.x, anchor.position.y, anchor.position.z,
    ).applyMatrix4(matrix);
    const outward = sourceOutward.clone().transformDirection(matrix);
    const sourceRight = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), sourceOutward)
      .normalize();
    const widthScale = sourceRight.applyMatrix3(linear).length();
    const heightScale = new THREE.Vector3(0, 1, 0).applyMatrix3(linear).length();
    return {
      ...anchor,
      position,
      outward,
      width: anchor.width * widthScale,
      height: anchor.height * heightScale,
    };
  });
}

function regularBaseAnchors(parcel, sources) {
  const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
  const source = sources.regular?.[kind];
  const variants = source?.variants || [];
  const requested = source?.variantAware === false ? 0 : (parcel.variant | 0);
  const index = clamp(requested, 0, Math.max(0, variants.length - 1));
  return transformAnchors(variants[index] || variants[0] || [], houseMatrix(parcel));
}

function stableAnchorScore(ownerSeed, anchor, index) {
  return hashString(`${ownerSeed}|${anchor.openingId || 'opening'}|${index}`) >>> 0;
}

function selectAnchors(anchors, count, ownerSeed) {
  if (!anchors?.length || count <= 0) return [];
  const ranked = anchors.map((anchor, index) => ({
    anchor,
    index,
    score: stableAnchorScore(ownerSeed, anchor, index),
  })).sort((a, b) => a.score - b.score || a.index - b.index);
  // The first lit room should read from the normal south/front presentation
  // when one exists. Remaining rooms retain a deterministic facade spread.
  const front = ranked.find((entry) => (entry.anchor.outward?.z || 0) > 0.35);
  const selected = front ? [front.anchor] : [];
  for (const entry of ranked) {
    if (selected.length >= count) break;
    if (front && entry === front) continue;
    selected.push(entry.anchor);
  }
  return selected;
}

// `sources` contains renderer-authored variant catalogs and already-placed
// compound anchors. It is deliberately assembled by populate rather than
// reconstructed from plan dimensions here.
export function buildNightLights(plan, _site, sources = {}) {
  const group = new THREE.Group();
  group.name = 'village-nightlights';

  const ownerAnchors = sources.owners instanceof Map ? sources.owners : new Map();
  const records = [];
  const recordById = new Map();
  let lightCount = 0;
  const addOwner = (id, seed, profile, baseAnchors, parcel = null) => {
    if (!id || !profile?.capacity || recordById.has(id)) return;
    const record = {
      id,
      seed: seed >>> 0,
      start: lightCount,
      profile,
      parcel,
      baseAnchors: baseAnchors || [],
      selected: [],
      // Transient product suppress (hero assembly / landing). Ownership, seed
      // policy, and last refresh source stay intact; only emitted rows go dark.
      suppressed: false,
      refreshSource: null,
      refreshSeed: seed >>> 0,
      refreshKind: parcel ? (parcel.hero ? 'hero' : profile.kind) : 'feature',
    };
    lightCount += profile.capacity;
    records.push(record);
    recordById.set(id, record);
  };

  for (const parcel of plan.parcels || []) {
    const anchors = parcel.hero
      ? (ownerAnchors.get(parcel.id) || [])
      : regularBaseAnchors(parcel, sources);
    addOwner(
      parcel.id,
      Number.isFinite(parcel.seed) ? parcel.seed : hashString(parcel.id),
      parcel.hero ? heroProfile(parcel) : regularProfile(parcel),
      anchors,
      parcel,
    );
  }
  const features = plan.features || {};
  const featureSpecs = [
    ['palace', features.palace, 4, 1.05, 0x9a11],
    ['temple', features.temple, 3, 0.95, 0x7e12],
    // There is no authored pavilion window/lantern anchor today. It remains
    // dark rather than falling back to an inferred polar landmark light.
    ['pavilion', features.pavilion, 1, 0.7, 0x5a13],
  ];
  for (const [id, feature, count, lit, salt] of featureSpecs) {
    const anchors = ownerAnchors.get(id) || [];
    if (!feature || anchors.length === 0) continue;
    addOwner(
      id,
      Number.isFinite(feature.seed) ? feature.seed : hashString(id),
      featureProfile(feature, count, lit, salt),
      anchors,
    );
  }

  if (lightCount === 0) {
    const empty = {
      group,
      refreshOwner() { return false; },
      setOwnerSuppressed() { return false; },
      setLevel() {},
      setPixelRatio() {},
      update() {},
      setDepthTestForTest() {},
      debugOwner() { return null; },
      debugState() {
        return {
          lightCount: 0,
          ownerCount: 0,
          drawCalls: 0,
          dofDepthDrawCalls: 0,
          triangles: 0,
          materials: 0,
          programs: 0,
          textures: 0,
          lights: 0,
          depthTest: true,
        };
      },
      debugRepresentation() {
        return { representation: 'physical', attributeBytes: 0 };
      },
      dispose() {},
    };
    group.userData.nightLights = empty;
    return empty;
  }

  const pos = new Float32Array(lightCount * 3);
  const aPhase = new Float32Array(lightCount);
  const aLit = new Float32Array(lightCount);
  const aThreshold = new Float32Array(lightCount);
  const aWarm = new Float32Array(lightCount);
  const outward = new Float32Array(lightCount * 3);
  const openingSize = new Float32Array(lightCount * 2);

  function writeOwner(record, anchors) {
    const selected = selectAnchors(anchors, record.profile.desired, record.seed);
    record.selected = selected.map((anchor) => ({
      openingId: anchor.openingId,
      x: anchor.position.x,
      y: anchor.position.y,
      z: anchor.position.z,
      outwardX: anchor.outward?.x || 0,
      outwardY: anchor.outward?.y || 0,
      outwardZ: anchor.outward?.z || 0,
    }));
    // Suppressed owners keep permanent ownership / selected anchors but emit
    // zero physical rows (aLit=0 → vertex cull). refreshOwner(null) alone still
    // falls back to baseAnchors and would otherwise float during assembly.
    const emit = !record.suppressed;
    for (let slot = 0; slot < record.profile.capacity; slot++) {
      const index = record.start + slot;
      const anchor = selected[slot];
      const values = record.profile.slots[slot];
      pos[index * 3] = anchor ? anchor.position.x : 0;
      pos[index * 3 + 1] = anchor ? anchor.position.y : 0;
      pos[index * 3 + 2] = anchor ? anchor.position.z : 0;
      outward[index * 3] = anchor ? anchor.outward.x : 0;
      outward[index * 3 + 1] = anchor ? anchor.outward.y : 0;
      outward[index * 3 + 2] = anchor ? anchor.outward.z : 1;
      // Keep the luminous paper inside the authored frame. This remains a
      // shallow proxy and fades before the actual FULL hanji emissive takes
      // over; it never becomes a second close-up window surface.
      openingSize[index * 2] = anchor ? anchor.width * 0.88 : 0;
      openingSize[index * 2 + 1] = anchor ? anchor.height * 0.82 : 0;
      aPhase[index] = values.phase;
      aLit[index] = (emit && anchor) ? values.lit : 0;
      aThreshold[index] = values.threshold;
      aWarm[index] = values.warm;
    }
  }
  for (const record of records) writeOwner(record, record.baseAnchors);

  const uniforms = {
    uNight: { value: 0 },
    uTime: { value: 0 },
    uFadeNear: { value: 15 },
    uFadeNearEnd: { value: 62 },
    uLensScale: { value: 1 },
    uWave: { value: 1 },
    uColorCandle: { value: COLOR_CANDLE.clone() },
    uColorLamp: { value: COLOR_LAMP.clone() },
  };
  const sourceArrays = Object.freeze({
    position: pos,
    outward,
    openingSize,
    phase: aPhase,
    lit: aLit,
    threshold: aThreshold,
    warm: aWarm,
  });
  const batch = createPhysicalNightlightBatch({
    count: lightCount,
    arrays: sourceArrays,
    uniforms,
  });
  const { object: drawable, material: mat, depthMaterial: dofDepthMat, resource } = batch;
  // Transparent ordering stays stable while the normal depth buffer still
  // occludes lights behind walls, terrain, roofs, and courtyard objects.
  drawable.renderOrder = 4;
  drawable.visible = false;
  drawable.userData.dofDepthMaterial = dofDepthMat;
  group.add(drawable);

  let level = 0;
  let waveWeight = 1;
  let disposed = false;
  const syncVisibility = () => {
    drawable.visible = !disposed && level > 0.001 && waveWeight > 0.001;
  };
  group.userData.waveFade = {
    setWeight(value) {
      if (disposed) return;
      waveWeight = clamp01(Number.isFinite(value) ? value : 0);
      uniforms.uWave.value = waveWeight;
      syncVisibility();
    },
  };

  function overlayAnchorsInVillageSpace(overlayRoot) {
    const world = collectOpeningGlowAnchors(overlayRoot, { space: 'world' });
    const parent = group.parent;
    if (!parent?.isObject3D) return world;
    parent.updateWorldMatrix(true, false);
    return transformAnchors(world, new THREE.Matrix4().copy(parent.matrixWorld).invert());
  }
  function markOwnerAttributes(record) {
    for (const name of batch.dynamicAttributes) {
      markAttributeItems(
        batch.geometry.attributes[name],
        record.start,
        record.profile.capacity,
      );
    }
  }
  function currentOwnerAnchors(record) {
    return record.refreshSource
      ? overlayAnchorsInVillageSpace(record.refreshSource)
      : record.baseAnchors;
  }

  const api = {
    group,
    refreshOwner(ownerId, overlayRoot = null) {
      if (disposed) return false;
      const record = recordById.get(ownerId);
      if (!record) return false;
      let nextSeed = record.seed;
      let nextKind = record.refreshKind;
      if (record.parcel) {
        nextSeed = Number.isFinite(record.parcel.seed)
          ? record.parcel.seed >>> 0
          : hashString(record.id);
        const overlayKind = overlayRoot?.userData?.style;
        const regularKind = overlayKind === 'giwa' || overlayKind === 'choga'
          ? overlayKind : record.parcel.kind;
        nextKind = record.parcel.hero ? 'hero' : regularKind;
        if (record.refreshSource === overlayRoot
          && record.refreshSeed === nextSeed
          && record.refreshKind === nextKind) return false;
        record.seed = nextSeed;
        record.profile = record.parcel.hero
          ? heroProfile(record.parcel)
          : regularProfile(record.parcel, regularKind);
      } else if (record.refreshSource === overlayRoot) {
        return false;
      }
      writeOwner(record, overlayRoot
        ? overlayAnchorsInVillageSpace(overlayRoot)
        : record.baseAnchors);
      record.refreshSource = overlayRoot;
      record.refreshSeed = nextSeed;
      record.refreshKind = nextKind;
      markOwnerAttributes(record);
      return true;
    },
    // Suppress (or restore) physical rows for one owner without dropping its
    // permanent slot, seed policy, or last refresh source. Hero assembly uses
    // this while compound geometry is still rising / hidden so rest-pose
    // hanji quads do not float on an empty lot.
    setOwnerSuppressed(ownerId, suppressed = true) {
      if (disposed) return false;
      const record = recordById.get(ownerId);
      if (!record) return false;
      const next = suppressed !== false;
      if (!!record.suppressed === next) return false;
      record.suppressed = next;
      writeOwner(record, currentOwnerAnchors(record));
      markOwnerAttributes(record);
      return true;
    },
    setLevel(value) {
      if (disposed) return;
      level = clamp01(value || 0);
      uniforms.uNight.value = level;
      syncVisibility();
    },
    setPixelRatio() {},
    update(dt, value, lensScale = 1) {
      if (disposed) return;
      if (value != null) {
        level = clamp01(value);
        uniforms.uNight.value = level;
      }
      uniforms.uLensScale.value = normalizeVillageLensScale(lensScale);
      syncVisibility();
      if (drawable.visible) uniforms.uTime.value += dt || 0;
    },
    setDepthTestForTest(value) {
      if (!disposed) mat.depthTest = value !== false;
    },
    debugOwner(ownerId) {
      const record = recordById.get(ownerId);
      if (!record) return null;
      return {
        id: record.id,
        start: record.start,
        capacity: record.profile.capacity,
        desired: record.profile.desired,
        kind: record.profile.kind || null,
        suppressed: !!record.suppressed,
        selected: record.selected.map((anchor) => ({ ...anchor })),
      };
    },
    debugState() {
      return {
        lightCount,
        ownerCount: records.length,
        drawCalls: resource.drawCalls,
        dofDepthDrawCalls: resource.dofDepthDrawCalls,
        triangles: resource.triangles,
        materials: resource.materials,
        programs: resource.programs,
        textures: resource.textures,
        lights: resource.lights,
        depthTest: mat.depthTest,
      };
    },
    debugRepresentation() {
      return {
        representation: 'physical',
        attributeBytes: resource.attributeBytes,
        activeObject: drawable.name,
        allocatedRepresentations: ['physical'],
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      batch.dispose();
    },
  };
  group.userData.nightLights = api;
  return api;
}

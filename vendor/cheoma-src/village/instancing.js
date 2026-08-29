import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { houseMatrix, parcelMatrix, parcelRotY } from '../generators/shared/parcel-transform.js';
import {
  markAttributeItems,
  markAttributeRange,
} from '../core/buffer-update-range.js';
import { toneOf } from './variants.js';
import { impostorHouseSpec } from './impostor-spec.js';
import {
  attachLodScreenDoorRoot,
  LOD_SCREEN_DOOR_PROGRAM_VERSION,
  patchLodScreenDoorMaterial,
} from '../render/lod-screen-door.js';

export { houseMatrix, parcelMatrix, parcelRotY } from '../generators/shared/parcel-transform.js';

// Hot-path assembly reuses module scratches instead of `new Matrix4()` / `.clone()` per mesh
// or per instance. All consumers are synchronous and finish reading the matrix before the next
// overwrite (normalizeGeo.applyMatrix4 / InstancedMesh.setMatrixAt copy elements immediately).
const _baseInv = new THREE.Matrix4();
const _wm = new THREE.Matrix4();
const _im = new THREE.Matrix4();
const _full = new THREE.Matrix4();
const _zeroScale = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();
// Focus/edit presentation mutates the live render buffers (zero instance matrices and
// degenerate merged-geometry ranges). Export needs the authored village, not that transient
// presentation state. Symbol metadata stays outside userData, so Object3D cloning/extras JSON
// never serializes these potentially large snapshots.
const EXPORT_INSTANCE_MATRIX = Symbol.for('cheoma.export.pristineInstanceMatrix');
const EXPORT_POSITION_SNAPSHOT = Symbol.for('cheoma.export.pristinePositionSnapshot');
let screenDoorDepthMaterial = null;
let screenDoorDistanceMaterial = null;

function screenDoorShadowMaterials() {
  if (!screenDoorDepthMaterial) {
    screenDoorDepthMaterial = new THREE.MeshDepthMaterial();
    patchLodScreenDoorMaterial(screenDoorDepthMaterial);
    screenDoorDepthMaterial.customProgramCacheKey = () =>
      `cheoma-lod-shadow-depth|${LOD_SCREEN_DOOR_PROGRAM_VERSION}`;
    screenDoorDistanceMaterial = new THREE.MeshDistanceMaterial();
    patchLodScreenDoorMaterial(screenDoorDistanceMaterial);
    screenDoorDistanceMaterial.customProgramCacheKey = () =>
      `cheoma-lod-shadow-distance|${LOD_SCREEN_DOOR_PROGRAM_VERSION}`;
  }
  return { depth: screenDoorDepthMaterial, distance: screenDoorDistanceMaterial };
}

// 부위(role)별 톤 선택(#55): parcel 의 부위별 곱틴트(roofTone/wallTone/woodTone/stoneTone)에서 고른다.
//   미지정(레거시 parcel·부위 톤 없음)이면 단일 톤(toneOf(toneIdx))로 하위호환. role 없음(개구부 등)=중립.
const NEUTRAL = [1, 1, 1];
function roleTone(kind, parcel, role) {
  const rt = role === 'roof' ? parcel.roofTone
    : role === 'wall' ? parcel.wallTone
    : role === 'wood' ? parcel.woodTone
    : role === 'stone' ? parcel.stoneTone
    : null;
  if (rt) return rt;
  if (role) return NEUTRAL;                         // 태그는 있으나 parcel 톤 미설정 → 중립
  // 역할 태그 자체가 없는 재질: 레거시 단일 톤 유지(구 parcel) 또는 중립.
  return parcel.roofTone ? NEUTRAL : toneOf(kind, parcel.toneIdx || 0);
}

// 마을 성능 코어 — 드로우콜 붕괴 전략.
//   현 populate 는 집마다 프로토타입을 clone(true) 해 배치 → capital 68호 = 8,700+ 드로우콜.
//   집 본체는 프로토(giwa/choga) 1벌과 완전 동일(배치 변환만 다름)이므로:
//     ① 정규 주택 → 재질별 InstancedMesh (호수 무관 상수 드로우콜 + 지오메트리 메모리 1벌)
//     ② 담·도로·논·랜드마크(종가·궁·절·정자 등 유일 지오) → 재질별 정적 병합
//   두 경로 모두 드로우콜을 "재질 수" 규모로 눌러 CPU 병목을 제거한다(레스터 삼각형 수는 동일).
//
// 픽킹·편집은 인스턴스 매트릭스 은닉(hide)로 개별성 유지 — 프록시 레이캐스트는 adapter.js.

// 지오메트리를 병합 가능한 균일 레이아웃으로 정규화: non-indexed + position/normal/uv(+color).
// keepColor 는 vertexColors 재질일 때만(그 외 color 는 렌더에 안 쓰이므로 제거해 병합 충돌 방지).
function normalizeGeo(src, worldMatrix, keepColor) {
  const g = src.index ? src.toNonIndexed() : src.clone();
  g.applyMatrix4(worldMatrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (keepColor && !g.attributes.color) {
    const c = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  }
  // 병합 충돌 원인이 되는 여분 속성 제거(uv2·tangent·skinning 등, color 는 조건부)
  for (const key of Object.keys(g.attributes)) {
    if (key === 'position' || key === 'normal' || key === 'uv') continue;
    if (key === 'color' && keepColor) continue;
    g.deleteAttribute(key);
  }
  g.morphAttributes = {};
  return g;
}

const STRICT_MERGE_ATTRIBUTES = new Set(['position', 'normal', 'uv', 'color']);
const STRICT_MERGE_CALLBACKS = [
  'onBeforeRender',
  'onAfterRender',
  'onBeforeShadow',
  'onAfterShadow',
];
const SHADOW_DEPTH_TEXTURE_LIFECYCLE = Symbol.for('cheoma.shadowDepthTextureLifecycle');
const DEFAULT_OBJECT_LAYER_MASK = new THREE.Layers().mask;

function strictMergeLabel(object) {
  return object.name ? `"${object.name}"` : object.type || 'Object3D';
}

function assertStrictMergeNode(object, opts = {}) {
  const label = strictMergeLabel(object);
  if (!object.visible) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve hidden object ${label}`);
  }
  if (object.layers.mask !== DEFAULT_OBJECT_LAYER_MASK) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve layers on ${label}`);
  }
  if (object.renderOrder !== 0) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve renderOrder on ${label}`);
  }
  if (!object.isMesh && !object.isInstancedMesh) return;
  if (object.frustumCulled === false) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve frustumCulled=false on ${label}`);
  }
  if (object.isSkinnedMesh || object.skeleton) {
    throw new Error(`decomposeByMaterial strict merge cannot bake skinned mesh ${label}`);
  }
  if (object.isBatchedMesh) {
    throw new Error(`decomposeByMaterial strict merge cannot bake batched mesh ${label}`);
  }
  if (Array.isArray(object.material)) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve multi-material groups on ${label}`);
  }
  if (object.customDepthMaterial || object.customDistanceMaterial) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve custom shadow material on ${label}`);
  }
  for (const callback of STRICT_MERGE_CALLBACKS) {
    if (callback === 'onBeforeShadow'
      && opts.reattachShadowDepthTextureLifecycle === true
      && object[SHADOW_DEPTH_TEXTURE_LIFECYCLE]) continue;
    if (object[callback] !== THREE.Object3D.prototype[callback]) {
      throw new Error(`decomposeByMaterial strict merge cannot preserve ${callback} on ${label}`);
    }
  }

  const geometry = object.geometry;
  if (!geometry?.isBufferGeometry || !geometry.attributes?.position) {
    throw new Error(`decomposeByMaterial strict merge requires position BufferGeometry on ${label}`);
  }
  if (geometry.isInstancedBufferGeometry) {
    throw new Error(`decomposeByMaterial strict merge cannot bake InstancedBufferGeometry ${label}`);
  }
  if (Object.keys(geometry.morphAttributes || {}).length
    || object.morphTargetInfluences
    || object.morphTargetDictionary) {
    throw new Error(`decomposeByMaterial strict merge cannot bake morph targets on ${label}`);
  }
  if (geometry.drawRange.start !== 0) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve drawRange on ${label}`);
  }
  const availableCount = geometry.index?.count ?? geometry.attributes.position.count;
  if (geometry.drawRange.count !== Infinity && geometry.drawRange.count < availableCount) {
    throw new Error(`decomposeByMaterial strict merge cannot preserve drawRange on ${label}`);
  }
  for (const [attributeName, attribute] of Object.entries(geometry.attributes)) {
    if (!STRICT_MERGE_ATTRIBUTES.has(attributeName)) {
      throw new Error(
        `decomposeByMaterial strict merge cannot discard "${attributeName}" attribute on ${label}`,
      );
    }
    if (!attribute?.isBufferAttribute || attribute.isInterleavedBufferAttribute) {
      throw new Error(
        `decomposeByMaterial strict merge cannot normalize "${attributeName}" attribute on ${label}`,
      );
    }
  }
  if (object.isInstancedMesh) {
    if (object.instanceColor || object.morphTexture) {
      throw new Error(`decomposeByMaterial strict merge cannot bake per-instance color/morph data on ${label}`);
    }
  }
}

// 비인덱스 지오의 삼각 와인딩 반전(정점 1↔2 스왑) — 미러(음determinant)로 뒤집힌 앞면 복원.
function reverseWinding(g) {
  for (const key of Object.keys(g.attributes)) {
    const a = g.attributes[key], it = a.itemSize, arr = a.array;
    for (let t = 0; t + 2 < a.count; t += 3) {
      const i1 = (t + 1) * it, i2 = (t + 2) * it;
      for (let k = 0; k < it; k++) { const tmp = arr[i1 + k]; arr[i1 + k] = arr[i2 + k]; arr[i2 + k] = tmp; }
    }
    a.needsUpdate = true;
  }
}

// decomp(재질별 프로토로컬 지오)를 X-미러 사본으로. 재질 refs 재사용(텍스처 증분 0) — ㄱ자 방향 플립.
export function mirrorDecomp(decomp) {
  return decomp.map(({ material, geometry, castShadow, receiveShadow }) => {
    const g = geometry.clone();
    const pos = g.attributes.position.array; for (let i = 0; i < pos.length; i += 3) pos[i] = -pos[i];
    g.attributes.position.needsUpdate = true;
    if (g.attributes.normal) { const nr = g.attributes.normal.array; for (let i = 0; i < nr.length; i += 3) nr[i] = -nr[i]; g.attributes.normal.needsUpdate = true; }
    reverseWinding(g);   // 반사로 뒤집힌 와인딩 복원(앞면 유지)
    return { material, geometry: g, castShadow, receiveShadow };
  });
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fixed = (value, fallback = 0) => Number(value ?? fallback).toFixed(5);

function textureShareKey(texture) {
  if (!texture) return '-';
  return [
    fixed(texture.repeat?.x, 1), fixed(texture.repeat?.y, 1),
    fixed(texture.offset?.x), fixed(texture.offset?.y),
    fixed(texture.center?.x), fixed(texture.center?.y), fixed(texture.rotation),
    texture.wrapS, texture.wrapT, texture.mapping, texture.channel,
    texture.colorSpace, texture.flipY ? 1 : 0,
    texture.magFilter, texture.minFilter, texture.anisotropy,
  ].join(',');
}

// Different plan topology changes decompose order and material count. Sharing by index therefore
// either retains whole duplicate palettes or can pair the wrong surfaces. This conservative key
// describes the authored palette family plus render-affecting state; texture source identity is
// deliberately omitted because separately built variants redraw the same family canvas. Repeat,
// offset, wrapping, and filters remain in the key so roof tile density and fitted UVs stay exact.
export function materialShareKey(material) {
  if (!material?.isMaterial) return null;
  if (own(material, 'onBeforeCompile') || own(material, 'customProgramCacheKey')) return null;
  const data = material.userData || {};
  const textured = material.map || material.bumpMap || material.normalMap || material.emissiveMap
    || material.roughnessMap || material.metalnessMap || material.aoMap || material.alphaMap;
  // A generated texture without a declared family may be visually unrelated even when its
  // transform matches. Palette materials and derived roof skins declare paletteKey explicitly.
  if (textured && !data.paletteKey) return null;
  return [
    data.paletteKey || '-', data.role || '-', data.hanjiGlow ?? '-',
    material.type, material.name || '', material.side,
    material.transparent ? 1 : 0, fixed(material.opacity, 1), fixed(material.alphaTest),
    material.alphaHash ? 1 : 0, material.depthWrite ? 1 : 0, material.depthTest ? 1 : 0,
    material.blending, material.vertexColors ? 1 : 0, material.flatShading ? 1 : 0,
    material.color?.getHexString?.() || '-', material.emissive?.getHexString?.() || '-',
    fixed(material.emissiveIntensity, 1), fixed(material.roughness, 1), fixed(material.metalness),
    fixed(material.bumpScale, 1), fixed(material.aoMapIntensity, 1),
    fixed(material.displacementScale, 1),
    material.normalScale ? `${fixed(material.normalScale.x, 1)},${fixed(material.normalScale.y, 1)}` : '-',
    textureShareKey(material.map), textureShareKey(material.bumpMap),
    textureShareKey(material.normalMap), textureShareKey(material.emissiveMap),
    textureShareKey(material.roughnessMap), textureShareKey(material.metalnessMap),
    textureShareKey(material.aoMap), textureShareKey(material.alphaMap),
  ].join('~');
}

// 토폴로지와 decompose 순서가 달라도 같은 시각 의미의 재질 refs를 canon으로 통일한다.
// keepOwn(material): true 인 변주 재질은 제외 — 초가 이엉 상태와 기와 창호 패턴처럼 실제로
// 변주별 픽셀이 달라야 하는 표면이다. 일치하지 않는 파생 UV/기와 반복 재질도 그대로 보존한다.
export function shareMaterials(canon, variant, keepOwn = null) {
  if (!canon) return variant;
  const byKey = new Map();
  for (const entry of canon) {
    const key = materialShareKey(entry.material);
    if (key != null && !byKey.has(key)) byKey.set(key, entry.material);
  }
  return variant.map((entry) => {
    if (keepOwn?.(entry.material)) return entry;
    const key = materialShareKey(entry.material);
    const shared = key == null ? null : byKey.get(key);
    return shared && shared !== entry.material ? { ...entry, material: shared } : entry;
  });
}

// root(프로토 또는 이미 월드배치된 객체)를 재질별 병합 지오메트리로 분해.
//   preMatrix: root 로컬을 어떤 기준으로 구울지(프로토는 항등 → 프로토로컬 유지).
//   opts.trackSrc(#148): true 면 재질별 병합 지오 안에서 소스별(o/조상 userData.__mergeSrc) 정점
//     레인지를 함께 반환(srcRanges: Map<srcId,{start,count}> — 정점 단위). 병합 담의 필지별 은닉용.
//     traverse 는 깊이우선(root→o0 서브트리→o1…)이라 재질 리스트 내 같은 src 기여가 연속 → 단일 레인지.
//   opts.partitionShadowFlags: true 면 재질뿐 아니라 castShadow/receiveShadow 쌍까지 병합 키로 삼는다.
//     이 모드는 손실 없는 정적 병합만 허용하므로 bake 할 수 없는 렌더 의미를 발견하면 즉시 throw 한다.
// 반환: [{ material, geometry, castShadow, receiveShadow, srcRanges? }]
export function decomposeByMaterial(root, preMatrix = null, opts = {}) {
  const trackSrc = !!opts.trackSrc;
  const partitionShadowFlags = opts.partitionShadowFlags === true;
  root.updateMatrixWorld(true);
  // 기본 경로는 기존 material -> entry 구조와 순서를 그대로 유지한다. opt-in 경로만
  // material -> shadow-state -> entry 로 한 단계 더 나눠 그림자 상태의 OR 승격을 막는다.
  const groups = new Map();
  const push = (mat, geo, cast, recv, src) => {
    let e;
    if (partitionShadowFlags) {
      let shadowGroups = groups.get(mat);
      if (!shadowGroups) { shadowGroups = new Map(); groups.set(mat, shadowGroups); }
      const shadowKey = `${cast ? 1 : 0}${recv ? 1 : 0}`;
      e = shadowGroups.get(shadowKey);
      if (!e) {
        e = { list: [], cast: !!cast, recv: !!recv, runs: [] };
        shadowGroups.set(shadowKey, e);
      }
    } else {
      e = groups.get(mat);
      if (!e) { e = { list: [], cast: false, recv: false, runs: [] }; groups.set(mat, e); }
    }
    e.list.push(geo); e.cast = e.cast || cast; e.recv = e.recv || recv;
    if (trackSrc) e.runs.push({ src, count: geo.attributes.position.count });
  };
  const useBaseInv = !!preMatrix;
  if (useBaseInv) _baseInv.copy(preMatrix).invert();
  const srcOf = (o) => {   // o 또는 조상에서 최근접 __mergeSrc 태그
    let a = o;
    while (a && a !== root) { if (a.userData && a.userData.__mergeSrc !== undefined) return a.userData.__mergeSrc; a = a.parent; }
    return undefined;
  };

  root.traverse((o) => {
    if (partitionShadowFlags) assertStrictMergeNode(o, opts);
    if (!o.isMesh && !o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    // 멀티머티리얼(groups)까지 완벽 지원하려면 group 분해 필요하나, 이 코드베이스 메시는
    // 전부 단일 재질이라 첫 재질만 사용(측정으로 확인).
    const mat = mats[0];
    if (!mat) return;
    const keepColor = !!mat.vertexColors;
    const src = trackSrc ? srcOf(o) : undefined;
    // 월드행렬을 preMatrix 기준으로 환산(프로토면 baseInv 미사용 → 프로토로컬 그대로).
    // Scratch `_wm` holds the preMatrix-relative transform; identity-pre paths keep the live
    // matrixWorld reference (read-only via applyMatrix4).
    const wm = useBaseInv ? _wm.copy(_baseInv).multiply(o.matrixWorld) : o.matrixWorld;
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _im);
        const full = _full.copy(wm).multiply(_im);
        push(mat, normalizeGeo(o.geometry, full, keepColor), o.castShadow, o.receiveShadow, src);
      }
    } else {
      push(mat, normalizeGeo(o.geometry, wm, keepColor), o.castShadow, o.receiveShadow, src);
    }
  });

  const out = [];
  for (const [material, value] of groups) {
    const entries = partitionShadowFlags ? value.values() : [value];
    for (const e of entries) {
      const geometry = e.list.length === 1 ? e.list[0] : mergeGeometries(e.list, false);
      if (!geometry) continue;
      const rec = { material, geometry, castShadow: e.cast, receiveShadow: e.recv };
      if (trackSrc) {
        const ranges = new Map();   // srcId -> {start,count}(정점). 연속 run 이라 누적=단일 레인지.
        let cursor = 0;
        for (const r of e.runs) {
          if (r.src !== undefined) {
            let rr = ranges.get(r.src);
            if (!rr) { rr = { start: cursor, count: 0 }; ranges.set(r.src, rr); }
            rr.count += r.count;
          }
          cursor += r.count;
        }
        rec.srcRanges = ranges;
      }
      out.push(rec);
    }
  }
  return out;
}

// 정규 주택 인스턴싱(변주 풀): 한 종류(kind)를 평면 변주(parcel.variant)별로 묶어 각 변주 decomp 를
//   재질별 InstancedMesh 로 만든다. 인스턴스 행렬(위치·yaw·스케일) + instanceColor(톤 곱틴트)로
//   집집이 서로 다른 표정. 드로우콜 = Σ(변주별 재질 수) — 호수 무관 상수(capital 도 수십 규모).
//   반환 핸들의 setHidden 은 변주 그룹을 가로질러 id→(메시들, 인덱스) 로 은닉/복원(편집 반영).
//   decomps: 변주 인덱스별 decompose 결과 배열([{material,geometry,cast,recv}], 미러 포함).
export function buildHouseInstances(kind, parcels, decomps, opts = {}) {
  const group = new THREE.Group();
  const tier = opts.tier || 'full';
  const include = typeof opts.filterMaterial === 'function' ? opts.filterMaterial : null;
  // 기존 FULL 이름은 scene/hash/외부 탐색 계약이므로 그대로 둔다. 새 suffix는 MID에만 붙인다.
  group.name = tier === 'full' ? `houses-${kind}` : `houses-${kind}-${tier}`;
  const clampV = (v) => (decomps[v] ? v : 0);
  const byVariant = new Map();
  for (const p of parcels) {
    const v = clampV(Math.max(0, p.variant || 0));
    let e = byVariant.get(v); if (!e) { e = []; byVariant.set(v, e); } e.push(p);
  }
  const locate = new Map();   // id -> { meshes:[InstancedMesh], index, mat:Matrix4 }
  for (const [v, plist] of byVariant) {
    const source = decomps[v] || decomps[0];
    const decomp = include ? source.filter((entry) => include(entry.material, entry)) : source;
    const n = plist.length;
    // houseMatrix results are owned by locate (setHidden restores them) — not scratches.
    const mats = plist.map(houseMatrix);
    const meshes = [];
    let exportMatrices = null;   // 같은 변주·필지 순서를 쓰는 role mesh들이 공유하는 불변 원본
    for (let g = 0; g < decomp.length; g++) {
      const { material, geometry, castShadow, receiveShadow } = decomp[g];
      const inst = new THREE.InstancedMesh(geometry, material, n);
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.name = tier === 'full'
        ? `inst-${kind}-v${v}-m${g}`
        : `inst-${kind}-${tier}-v${v}-m${g}`;
      inst.castShadow = opts.castShadow === false ? false : castShadow;
      inst.receiveShadow = receiveShadow;
      // #55: 부위별 독립 곱틴트 — 이 메시 재질의 역할(roof/wall/wood/stone)에 맞는 parcel 톤을
      //   instanceColor 로. 재질 복제 없이(각 역할=이미 별도 InstancedMesh) 드로우콜 불변. 개구부·
      //   기타(role 없음)는 중립(1,1,1) — 야간 창호광(emissive)·아궁이 불빛과 충돌 방지.
      const role = material && material.userData ? material.userData.role : null;
      for (let i = 0; i < n; i++) {
        inst.setMatrixAt(i, mats[i]);
        const t = roleTone(kind, plist[i], role);
        _color.setRGB(t[0], t[1], t[2]); inst.setColorAt(i, _color);
      }
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      // setHidden mutates instanceMatrix in place. Keep one immutable authored snapshot for
      // GLB export; cloning here (before any focus can hide a parcel) also prevents the export
      // tree from sharing a buffer that a later focus transition may change.
      exportMatrices ||= inst.instanceMatrix.clone();
      inst[EXPORT_INSTANCE_MATRIX] = exportMatrices;
      meshes.push(inst); group.add(inst);
    }
    plist.forEach((p, i) => locate.set(p.id, { meshes, index: i, mat: mats[i] }));
  }
  const hidden = new Set();
  const exportHidden = new Set();
  function setHidden(id, on) {
    const rec = locate.get(id);
    if (!rec || (on ? hidden.has(id) : !hidden.has(id))) return false;
    if (on) hidden.add(id); else hidden.delete(id);
    const m = on ? _zeroScale : rec.mat;
    for (const inst of rec.meshes) {
      inst.setMatrixAt(rec.index, m);
      markAttributeItems(inst.instanceMatrix, rec.index);
    }
    return true;
  }
  // Focus hiding is presentation-only and export normally restores the pristine
  // authored matrix. A committed edit is different: its FULL override becomes
  // the exported architecture, so the superseded base instance must stay
  // collapsed in the immutable export snapshot as well. Keep this ownership
  // separate from live visibility so focusing an unedited house remains export-
  // invariant.
  function setExportHidden(id, on) {
    const rec = locate.get(id);
    if (!rec) return;
    if (on) exportHidden.add(id); else exportHidden.delete(id);
    const matrix = on ? _zeroScale : rec.mat;
    const seen = new Set();
    for (const inst of rec.meshes) {
      const snapshot = inst[EXPORT_INSTANCE_MATRIX];
      if (!snapshot || seen.has(snapshot)) continue;
      seen.add(snapshot);
      matrix.toArray(snapshot.array, rec.index * 16);
    }
  }
  group.userData = {
    kind, tier, setHidden, isHidden: (id) => hidden.has(id),
    setExportHidden, isExportHidden: (id) => exportHidden.has(id), locate,
  };
  if (opts.screenDoor) {
    group.userData.screenDoor = attachLodScreenDoorRoot(group, screenDoorShadowMaterials());
  }
  return group;
}

// 실제 house prototype에서 화면을 이루는 외피만 남긴 중거리 단계. 별도 근사 모델이 아니라
// 같은 지오메트리·텍스처·재질을 쓰므로 FAR→MID에서 집 종류와 색이 바뀌지 않고, 공포·기와 낱장·
// 소품처럼 작은 반복 부재만 제출하지 않는다.
export function buildHouseEnvelopeInstances(kind, parcels, decomps, opts = {}) {
  return buildHouseInstances(kind, parcels, decomps, {
    ...opts,
    tier: 'mid',
    castShadow: false,
    filterMaterial: (material) => material?.userData?.lodEnvelope === true,
  });
}

// ── 부감 FAR 주택 mass(LOD, #47) ──────────────────────────────────────────────
//   문제: 청크별 풀디테일 인스턴싱은 재질 수(giwa≈54·choga≈32)를 청크마다 곱해 드로우콜·삼각형이
//   폭증한다(hanyang 실측 3400콜·20M삼각). 부감·원경에서 개별 집의 공포·창호·기와골은 픽셀 이하라
//   무의미 — 지붕 덩어리와 벽 매스만 읽힌다. 그래서 부감 상태의 정규 주택을 한 채당 저폴리 프록시
//   로 대체하고 청크 전체를 역할별 소수 vertexColor 메시로 병합한다. 순수 impostorHouseSpec이 실제 variant의
//   초가 우진각·기와 ㅡ/ㄱ/ㄷ 평면·mirror·팔레트 선형색을 저폴리 명세로 줄인다. 따라서 청크당
//   작은 상수 드로우콜을 유지하면서 LOD 경계에서 종류와 실루엣이 바뀌지 않는다. 그림자 비캐스트(원경).
const IMPOSTOR_PARTS = ['roof-giwa', 'roof-choga', 'wall', 'wood', 'stone'];
const _v = new THREE.Vector3();
const newImpostorPart = () => ({ P: [], N: [], C: [] });

function pushImpostorHouse(parts, parcel) {
  const spec = impostorHouseSpec(parcel);
  const roofPart = `roof-${spec.kind}`;
  const m = houseMatrix(parcel);   // T(center,baseY)·Ry·T(0,0,back)·S — 풀디테일 집과 동일 배치
  // 로컬 정점을 houseMatrix 로 월드화해 누적. 노멀은 computeVertexNormals 로 최종 산출(여기선 0 채움).
  const emit = (role, lx, ly, lz, col) => {
    const { P, N, C } = parts[role];
    _v.set(lx, ly, lz).applyMatrix4(m);
    P.push(_v.x, _v.y, _v.z); N.push(0, 0, 0); C.push(col[0], col[1], col[2]);
  };
  const tri = (role, a, b, c, col) => {
    emit(role, a[0], a[1], a[2], col);
    emit(role, b[0], b[1], b[2], col);
    emit(role, c[0], c[1], c[2], col);
  };
  const quad = (role, a, b, c, d, col) => {
    tri(role, a, b, c, col); tri(role, a, c, d, col);
  };

  // 몸통은 실제 초가 사각/기와 ㅡ·ㄱ·ㄷ polygon을 그대로 세운다. 상단의 얇은 목재 띠가 멀리서도
  // 흙벽·회벽과 처마선을 분리하되, 같은 vertexColor mesh 안이므로 재질/드로우콜은 늘지 않는다.
  const { polygon, y0, y1 } = spec.body;
  const bandH = spec.kind === 'choga' ? 0.18 : 0.24;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const bandY = Math.max(y0, y1 - bandH);
    quad('wall', [a.x, y0, a.z], [b.x, y0, b.z], [b.x, bandY, b.z], [a.x, bandY, a.z], spec.colors.wall);
    quad('wood', [a.x, bandY, a.z], [b.x, bandY, b.z], [b.x, y1, b.z], [a.x, y1, a.z], spec.colors.wood);
    quad('stone',
      [a.x, spec.foundation.y0, a.z], [b.x, spec.foundation.y0, b.z],
      [b.x, spec.foundation.y1, b.z], [a.x, spec.foundation.y1, a.z],
      spec.colors.stone);
  }

  const roofPoint = (roof, along, y, across) => roof.axis === 'x'
    ? [along, y, across]
    : [across, y, along];
  const pushRoof = (roof) => {
    const long0 = roof.axis === 'x' ? roof.x0 : roof.z0;
    const long1 = roof.axis === 'x' ? roof.x1 : roof.z1;
    const short0 = roof.axis === 'x' ? roof.z0 : roof.x0;
    const short1 = roof.axis === 'x' ? roof.z1 : roof.x1;
    const longMid = (long0 + long1) * 0.5, shortMid = (short0 + short1) * 0.5;
    // 6삼각 평면 덩어리 대신 작은 곡면 격자를 쓴다. across의 완만한 사인 곡률과 양 끝 hip
    // 감쇠가 실제 roof builder의 처마선·추녀선에 가까운 실루엣을 만들되, 집당 수십 tri에 그친다.
    const ridge0 = longMid - roof.ridgeHalf;
    const ridge1 = longMid + roof.ridgeHalf;
    const along = [long0, (long0 + ridge0) * 0.5, ridge0, ridge1, (ridge1 + long1) * 0.5, long1];
    const across = [short0, short0 * 0.5 + shortMid * 0.5, shortMid,
      short1 * 0.5 + shortMid * 0.5, short1];
    const halfShort = Math.max(1e-4, (short1 - short0) * 0.5);
    const rise = roof.ridgeY - roof.eaveY;
    const point = (a, s) => {
      const side = Math.max(0, 1 - Math.abs(s - shortMid) / halfShort);
      const sideCurve = Math.sin(side * Math.PI * 0.5) ** 0.88;
      const end = a < ridge0
        ? (a - long0) / Math.max(1e-4, ridge0 - long0)
        : a > ridge1
          ? (long1 - a) / Math.max(1e-4, long1 - ridge1)
          : 1;
      return roofPoint(roof, a, roof.eaveY + rise * Math.max(0, end) * sideCurve, s);
    };
    for (let ai = 0; ai < along.length - 1; ai++) {
      for (let si = 0; si < across.length - 1; si++) {
        quad(roofPart,
          point(along[ai], across[si]), point(along[ai + 1], across[si]),
          point(along[ai + 1], across[si + 1]), point(along[ai], across[si + 1]),
          spec.colors.roof);
      }
    }

    // 얇은 처마 단면을 목재 역할로 분리해 원경에서도 지붕과 벽이 한 덩어리로 붙지 않는다.
    const eaveDrop = spec.kind === 'choga' ? 0.16 : 0.12;
    const c0 = roofPoint(roof, long0, roof.eaveY, short0);
    const c1 = roofPoint(roof, long1, roof.eaveY, short0);
    const c2 = roofPoint(roof, long1, roof.eaveY, short1);
    const c3 = roofPoint(roof, long0, roof.eaveY, short1);
    for (const [a, b] of [[c0, c1], [c1, c2], [c2, c3], [c3, c0]]) {
      quad('wood', a, b, [b[0], b[1] - eaveDrop, b[2]], [a[0], a[1] - eaveDrop, a[2]], spec.colors.wood);
    }

    // 용마루 저폴리 각재. 초가는 굵은 용마름, 기와는 얇은 기와마루 비례다.
    const ridgeW = spec.kind === 'choga' ? 0.36 : 0.2;
    const ridgeH = spec.kind === 'choga' ? 0.26 : 0.16;
    const rl0 = longMid - roof.ridgeHalf - ridgeW * 0.35;
    const rl1 = longMid + roof.ridgeHalf + ridgeW * 0.35;
    const rs0 = shortMid - ridgeW * 0.5, rs1 = shortMid + ridgeW * 0.5;
    const ry0 = roof.ridgeY - ridgeH * 0.15, ry1 = roof.ridgeY + ridgeH * 0.85;
    const p = (along, y, across) => roofPoint(roof, along, y, across);
    const q0 = p(rl0, ry0, rs0), q1 = p(rl1, ry0, rs0), q2 = p(rl1, ry0, rs1), q3 = p(rl0, ry0, rs1);
    const u0 = p(rl0, ry1, rs0), u1 = p(rl1, ry1, rs0), u2 = p(rl1, ry1, rs1), u3 = p(rl0, ry1, rs1);
    quad(roofPart, q0, q1, u1, u0, spec.colors.ridge); quad(roofPart, q1, q2, u2, u1, spec.colors.ridge);
    quad(roofPart, q2, q3, u3, u2, spec.colors.ridge); quad(roofPart, q3, q0, u0, u3, spec.colors.ridge);
    quad(roofPart, u0, u1, u2, u3, spec.colors.ridge);
  };
  for (const roof of spec.roofs) pushRoof(roof);
}

function createImpostorMaterial(part) {
  const role = part.startsWith('roof-') ? 'roof' : part;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: role === 'wood' ? 0.88 : 0.96,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  mat.name = `impostor-${part}`;
  mat.userData.role = role;
  if (role === 'roof') mat.userData.snowSurface = true;
  // R8 program diet (#220 residual): FAR impostors always live on LOD roots. Install the
  // screen-door path at birth so the first compile already matches later rim/cloud/snow
  // composition instead of briefly owning a plain impostor program family.
  patchLodScreenDoorMaterial(mat);
  return mat;
}

export function createImpostorMaterials(parts = IMPOSTOR_PARTS) {
  const materials = {};
  for (const part of parts) materials[part] = createImpostorMaterial(part);
  return materials;
}

// buildChunkImpostor(parcels) → 역할별 최대 5개 vertexColor mesh. roof/wall/wood/stone 역할을
// 보존하고 초가/기와 지붕은 분리해 서로 다른 적설 규칙을 타면서도 청크 드로우콜은 작은 상수다.
export function buildChunkImpostor(parcels, name = 'chunk-impostor', sharedMaterials = null, opts = {}) {
  const parts = Object.fromEntries(IMPOSTOR_PARTS.map((part) => [part, newImpostorPart()]));
  const ranges = Object.fromEntries(IMPOSTOR_PARTS.map((part) => [part, new Map()]));
  for (const p of parcels) {
    const starts = Object.fromEntries(IMPOSTOR_PARTS.map((part) => [part, parts[part].P.length / 3]));
    pushImpostorHouse(parts, p);
    for (const part of IMPOSTOR_PARTS) {
      ranges[part].set(p.id, { start: starts[part], count: parts[part].P.length / 3 - starts[part] });
    }
  }
  const group = new THREE.Group(); group.name = name;
  const materials = sharedMaterials || createImpostorMaterials();
  const meshRanges = [];
  for (const part of IMPOSTOR_PARTS) {
    const { P, N, C } = parts[part];
    if (!P.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, materials[part]);
    mesh.name = `${name}-${part}`;
    if (part.startsWith('roof-')) mesh.userData.snowRoofKind = part.slice(5);
    mesh.castShadow = false; mesh.receiveShadow = true;
    group.add(mesh);
    meshRanges.push({ mesh, ranges: ranges[part] });
  }
  group.userData.impostor = true;
  // 포커스 오버레이가 나타나는 동안 해당 필지의 원경 표현만 접는다. 청크 전체를 숨기지 않아
  // 이웃 집의 LOD는 그대로 유지되며, 복귀 시 원본 Float32 정점을 바이트 그대로 되살린다.
  if (meshRanges.length) attachSourceHideHandle(group, meshRanges);
  if (opts.screenDoor) {
    group.userData.screenDoor = attachLodScreenDoorRoot(group, screenDoorShadowMaterials());
  }
  return group;
}

// 유일 지오(랜드마크·담·도로·논)를 재질별로 정적 병합. objects 는 이미 월드에 배치된 상태.
//   opts.ids(#148): objects 와 평행한 소스 id 배열. 주면 병합 메시 안에 소스별 정점 레인지를 기록해
//     group.userData.setHidden(id, on)/isHidden(id)/srcIds 를 노출한다 → focus 필지의 병합 담을 접어
//     오버레이 담과의 동일평면 이중 렌더(플리커)를 없앤다. 드로우콜 불변(레인지 접기, 메시 분할 아님).
// 반환: 병합 메시들을 담은 Group(자기 변환은 항등, 지오가 월드좌표를 품음).
export function mergeStatic(objects, name = 'merged-static', opts = {}) {
  const ids = opts.ids || null;
  const combined = new THREE.Group(); combined.name = 'tmp';
  // decomposeByMaterial 는 단일 root 를 받으므로 임시 부모로 묶는다(원본 부모 보존).
  const parents = objects.map((o) => ({ o, parent: o.parent }));
  if (ids) objects.forEach((o, i) => { if (ids[i] !== undefined) o.userData.__mergeSrc = ids[i]; });
  for (const { o } of parents) combined.add(o);
  let decomp;
  try {
    decomp = decomposeByMaterial(combined, null, {
      trackSrc: !!ids,
      partitionShadowFlags: opts.partitionShadowFlags === true,
      reattachShadowDepthTextureLifecycle: opts.reattachShadowDepthTextureLifecycle === true,
    });
  } finally {
    // 원복(원본 트리 훼손 금지 — 병합은 사본 지오만 사용). strict 검증 실패도 원본을 떼어두지 않는다.
    for (const { o, parent } of parents) { if (parent) parent.add(o); else combined.remove(o); }
    if (ids) objects.forEach((o) => { delete o.userData.__mergeSrc; });
  }

  const group = new THREE.Group(); group.name = name;
  const meshRanges = [];   // [{ mesh, ranges:Map<id,{start,count}> }]
  decomp.forEach(({ material, geometry, castShadow, receiveShadow, srcRanges }, i) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${name}-m${i}`;
    mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    group.add(mesh);
    if (srcRanges && srcRanges.size) meshRanges.push({ mesh, ranges: srcRanges });
  });
  if (ids && meshRanges.length) attachSourceHideHandle(group, meshRanges);
  if (opts.screenDoor) {
    group.userData.screenDoor = attachLodScreenDoorRoot(group, screenDoorShadowMaterials());
  }
  return group;
}

// 병합 메시의 소스별 정점 레인지를 접었다/펴는(픽셀 일치 복원) 핸들을 group.userData 에 부착.
//   접기 = 레인지 정점 위치를 레인지 첫 정점으로 붕괴(퇴화 삼각 → 프래그먼트 0). 원본은 최초 접을 때
//   1회 slice 로 보관 → 펼 때 그대로 복사(byte 일치). 색·재질·드로우콜 불변(지오 position 부분 갱신만).
function attachSourceHideHandle(group, meshRanges) {
  const hidden = new Set();
  const exportHidden = new Set();
  const srcIds = new Set();
  for (const mr of meshRanges) {
    for (const id of mr.ranges.keys()) srcIds.add(id);
    mr.saved = new Map();
    mr.mesh.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    // Reconstruct an independent pristine position buffer lazily. Persisting a second complete
    // copy for every wall/FAR mesh would waste memory; only hidden source ranges need saved data.
    mr.mesh[EXPORT_POSITION_SNAPSHOT] = () => {
      let needsSnapshot = false;
      for (const id of hidden) {
        if (mr.ranges.has(id) && mr.saved.has(id)) { needsSnapshot = true; break; }
      }
      if (!needsSnapshot) {
        for (const id of exportHidden) {
          if (mr.ranges.has(id)) { needsSnapshot = true; break; }
        }
      }
      if (!needsSnapshot) return null;
      const current = mr.mesh.geometry.attributes.position.array;
      const snapshot = current.slice();
      for (const id of hidden) {
        if (exportHidden.has(id)) continue;
        const range = mr.ranges.get(id);
        const saved = mr.saved.get(id);
        if (range && saved) snapshot.set(saved, range.start * 3);
      }
      // Export-only hiding can be requested before or after live presentation
      // hiding. Collapse a still-visible range in the snapshot without touching
      // the renderer-owned position buffer.
      for (const id of exportHidden) {
        if (hidden.has(id)) continue;
        const range = mr.ranges.get(id);
        if (!range?.count) continue;
        const start = range.start * 3;
        const count = range.count * 3;
        const ax = snapshot[start], ay = snapshot[start + 1], az = snapshot[start + 2];
        for (let k = 0; k < count; k += 3) {
          snapshot[start + k] = ax;
          snapshot[start + k + 1] = ay;
          snapshot[start + k + 2] = az;
        }
      }
      return snapshot;
    };
  }
  function setHidden(id, on) {
    if (on ? hidden.has(id) : !hidden.has(id)) return;   // 이미 목표 상태
    for (const mr of meshRanges) {
      const r = mr.ranges.get(id);
      if (!r || !r.count) continue;
      const pos = mr.mesh.geometry.attributes.position, arr = pos.array;
      const s = r.start * 3, cnt = r.count * 3;
      if (on) {
        if (!mr.saved.has(id)) mr.saved.set(id, arr.slice(s, s + cnt));   // 원본 1회 보관
        const ax = arr[s], ay = arr[s + 1], az = arr[s + 2];
        for (let k = 0; k < cnt; k += 3) { arr[s + k] = ax; arr[s + k + 1] = ay; arr[s + k + 2] = az; }
      } else {
        const sv = mr.saved.get(id); if (sv) arr.set(sv, s);
      }
      markAttributeRange(pos, s, cnt);
    }
    if (on) hidden.add(id); else hidden.delete(id);
  }
  function setExportHidden(id, on) {
    if (!srcIds.has(id)) return;
    if (on) exportHidden.add(id); else exportHidden.delete(id);
  }
  group.userData.setHidden = setHidden;
  group.userData.isHidden = (id) => hidden.has(id);
  group.userData.setExportHidden = setExportHidden;
  group.userData.isExportHidden = (id) => exportHidden.has(id);
  group.userData.srcIds = srcIds;
}

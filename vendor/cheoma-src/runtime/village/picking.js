import * as THREE from 'three';
import { planParcelFocus } from '../../generators/shared/parcel-spatial.js';
import {
  createFocusVisibilityIndex,
  sampleFocusSubjectSurface,
  selectSafeFocusEndpoint,
  VILLAGE_FOCUS_CAMERA_CLEARANCE,
  VILLAGE_FOCUS_TERRAIN_CLEARANCE,
} from '../../camera/focus-visibility.js';
import {
  VILLAGE_HERO_FOCUS_ELEVATION,
  VILLAGE_LENS,
  dollyDistanceForFov,
} from '../../camera/optics.js';
import {
  focusSubjectBounds,
  transformFocusSubject,
} from '../../camera/focus-framing.js';
import * as G from '../../core/math/geom2.js';
import {
  focusPlanningBlockers,
  parcelFocusDetailAnchors,
  parcelFocusBlocker,
  parcelWallFocusBlockers,
} from '../../village/focus-blockers.js';
import { terrainWarpInner } from '../../village/terrain-surface.js';
import {
  terrainMeshFocusCutaway,
  terrainGridStep,
  terrainMeshCameraSafeScale,
} from '../../village/terrain-grid.js';
import { templeFocusSubject } from '../../temple/focus-subject.js';
import { buildParcelSpec } from './parcel-edit.js';

const DEG = Math.PI / 180;

function parcelCameraFraming(worldCenter, focus) {
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + focus.targetLift, worldCenter.z);
  const position = new THREE.Vector3(focus.cameraX, target.y + focus.cameraLift, focus.cameraZ);
  return { position, target, fov: focus.fov, referenceFov: focus.referenceFov };
}

function threeCameraFraming(framing) {
  return {
    position: new THREE.Vector3(framing.position.x, framing.position.y, framing.position.z),
    target: new THREE.Vector3(framing.target.x, framing.target.y, framing.target.z),
    fov: framing.fov,
    referenceFov: framing.referenceFov,
  };
}

function threeBounds(bounds) {
  return new THREE.Box3(
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
  );
}

function volumeFootprint(volume) {
  const cos = Math.cos(volume.rotationY || 0);
  const sin = Math.sin(volume.rotationY || 0);
  return [
    { x: -volume.half.x, z: volume.half.z },
    { x: volume.half.x, z: volume.half.z },
    { x: volume.half.x, z: -volume.half.z },
    { x: -volume.half.x, z: -volume.half.z },
  ].map((point) => ({
    x: volume.center.x + point.x * cos + point.z * sin,
    z: volume.center.z - point.x * sin + point.z * cos,
  }));
}

function parcelFocusSubject({
  parcel,
  focusVolume,
  detailAnchors,
  target,
  worldCenter,
  width,
  depth,
  height,
  rotationY,
}) {
  const representative = {
    id: `${parcel.id}:architecture`,
    role: parcel.hero ? (parcel.heroStyle || 'head-house') : 'house',
    footprint: volumeFootprint(focusVolume),
    minY: focusVolume.center.y - focusVolume.half.y,
    maxY: focusVolume.center.y + focusVolume.half.y,
  };
  const compoundVolume = {
    center: {
      x: worldCenter.x,
      y: worldCenter.y + height * 0.5,
      z: worldCenter.z,
    },
    half: { x: width * 0.5, y: height * 0.5, z: depth * 0.5 },
    rotationY,
  };
  return {
    id: parcel.id,
    representative,
    // Hero parcels own a compound/courtyard envelope wider than the one
    // representative roof used for first-surface visibility. Keep that envelope
    // flat so empty air above the yard does not force an aerial-scale frame.
    courtyard: parcel.hero && parcel.heroStyle === 'palace' ? {
      id: `${parcel.id}:compound-yard`,
      role: 'compound',
      footprint: volumeFootprint(compoundVolume),
      y: worldCenter.y + 0.02,
    } : null,
    anchors: (detailAnchors || []).map((anchor) => ({
      id: anchor.id,
      point: { ...anchor.point },
    })),
    target: { x: target.x, y: target.y, z: target.z },
  };
}

function heroCameraFraming(proxy) {
  const target = proxy.baseCameraFraming.target;
  const direction = proxy.baseCameraFraming.position.clone().sub(target).normalize();
  const maxDim = Math.max(proxy.dims.x, proxy.dims.y, proxy.dims.z);
  const distance = dollyDistanceForFov(
    1.85,
    VILLAGE_LENS.hero.referenceFov,
    VILLAGE_LENS.hero.fov,
  ) * maxDim;
  // Keep the authored hero approach even if a stale base framing arrives from an
  // older snapshot. The safe selector scales both axes together after this.
  const horizontal = Math.cos(VILLAGE_HERO_FOCUS_ELEVATION) * distance;
  const horizontalDirection = direction.setY(0).normalize();
  return {
    position: {
      x: target.x + horizontalDirection.x * horizontal,
      y: target.y + Math.sin(VILLAGE_HERO_FOCUS_ELEVATION) * distance,
      z: target.z + horizontalDirection.z * horizontal,
    },
    target: { x: target.x, y: target.y, z: target.z },
    fov: VILLAGE_LENS.hero.fov,
    referenceFov: VILLAGE_LENS.hero.referenceFov,
  };
}

function visibilityDescriptor(result) {
  return {
    azimuth: result.azimuth,
    baseAzimuth: result.baseAzimuth,
    scale: result.scale,
    requestedScale: result.requestedScale,
    terrainScale: result.terrainScale,
    terrainLimited: result.terrainLimited,
    telephotoPreserved: result.telephotoPreserved,
    terrainMinClearance: result.terrainMinClearance,
    terrainEndpointClearance: result.terrainEndpointClearance,
    terrainCutaway: result.terrainCutaway
      ? structuredClone(result.terrainCutaway)
      : null,
    visibleRatio: result.visibleRatio,
    occlusionRatio: result.occlusionRatio,
    baseVisibleRatio: result.baseVisibleRatio,
    baseOcclusionRatio: result.baseOcclusionRatio,
    detailCount: result.detailCount,
    detailVisibleCount: result.detailVisibleCount,
    detailVisibleRatio: result.detailVisibleRatio,
    baseDetailVisibleCount: result.baseDetailVisibleCount,
    baseDetailVisibleRatio: result.baseDetailVisibleRatio,
    detailBlockers: result.detailBlockers,
    baseDetailBlockers: result.baseDetailBlockers,
    blockers: result.blockers,
    baseBlockers: result.baseBlockers,
    candidates: result.candidates,
  };
}

const FOCUS_TERRAIN_CUTAWAY_CACHE = new WeakMap();

function focusTerrainCutaway(proxy, site, safeTerrainRadius, framing) {
  const samples = sampleFocusSubjectSurface(
    framing.position,
    proxy.focusBounds,
    proxy.focusVolume,
  );
  return terrainMeshFocusCutaway(
    site,
    framing.position,
    framing.target,
    samples,
    { maxRadius: safeTerrainRadius },
  );
}

function focusSafeTerrainRadius(plan, site) {
  return plan && site
    ? Math.max(1, terrainWarpInner(plan, site) - terrainGridStep(site))
    : Infinity;
}

function focusCameraSafeScale(site, maxRadius, framing) {
  return terrainMeshCameraSafeScale(
    site,
    framing.target,
    framing.position,
    {
      clearance: VILLAGE_FOCUS_TERRAIN_CLEARANCE,
      endpointClearance: VILLAGE_FOCUS_CAMERA_CLEARANCE,
      maxRadius,
    },
  );
}

export function focusTerrainCutawayForProxy(proxy, plan, site, framing) {
  if (!proxy?.focusBounds || !framing?.position || !framing?.target || !site) {
    return null;
  }
  const cached = FOCUS_TERRAIN_CUTAWAY_CACHE.get(proxy);
  if (cached
    && cached.site === site
    && cached.bounds === proxy.focusBounds
    && cached.volume === proxy.focusVolume
    && cached.px === framing.position.x
    && cached.py === framing.position.y
    && cached.pz === framing.position.z
    && cached.tx === framing.target.x
    && cached.ty === framing.target.y
    && cached.tz === framing.target.z) {
    return cached.result;
  }
  const safeTerrainRadius = focusSafeTerrainRadius(plan, site);
  const cutaway = focusTerrainCutaway(
    proxy,
    site,
    safeTerrainRadius,
    framing,
  );
  const safety = cutaway.active && !cutaway.available
    ? focusCameraSafeScale(site, safeTerrainRadius, framing)
    : null;
  const result = {
    ...cutaway,
    safeScale: safety?.scale ?? 1,
  };
  FOCUS_TERRAIN_CUTAWAY_CACHE.set(proxy, {
    site,
    bounds: proxy.focusBounds,
    volume: proxy.focusVolume,
    px: framing.position.x,
    py: framing.position.y,
    pz: framing.position.z,
    tx: framing.target.x,
    ty: framing.target.y,
    tz: framing.target.z,
    result,
  });
  return result;
}

function solveTerrainAwareFocus(proxy, options, framing, site, safeTerrainRadius) {
  // Object visibility chooses the authored south-opening angle first. Terrain is
  // then presented through one camera near plane, preserving the original
  // distance, FOV and telephoto perspective. Only a cutaway that would reach the
  // house itself falls back to the former safe dolly.
  const authored = selectSafeFocusEndpoint({ ...options, framing });
  const cutaway = focusTerrainCutaway(
    proxy,
    site,
    safeTerrainRadius,
    authored.framing,
  );
  if (!cutaway.active || cutaway.available) {
    return {
      ...authored,
      terrainScale: 1,
      terrainLimited: cutaway.active,
      telephotoPreserved: true,
      terrainMinClearance: cutaway.minClearance,
      terrainEndpointClearance: cutaway.cameraClearance,
      terrainCutaway: cutaway,
    };
  }
  const fallback = selectSafeFocusEndpoint({
    ...options,
    framing,
    constrainEndpoint: (candidate) => focusCameraSafeScale(
      site,
      safeTerrainRadius,
      candidate,
    ),
  });
  const finalCutaway = focusTerrainCutaway(
    proxy,
    site,
    safeTerrainRadius,
    fallback.framing,
  );
  return {
    ...fallback,
    terrainCutaway: finalCutaway,
  };
}

function applySafeParcelFramings(proxies, featureBlockers = [], plan = null, site = null) {
  const residential = proxies.filter((proxy) => (
    proxy.baseCameraFraming && proxy.focusSafety && proxy.focusBounds && proxy.focusVolume
  ));
  const architecturalItems = [
    ...residential.map((proxy) => ({
      id: proxy.parcelId,
      bounds: proxy.focusBounds,
      volume: proxy.focusVolume,
    })),
    ...featureBlockers,
  ];
  const index = createFocusVisibilityIndex(architecturalItems);
  const detailIndex = createFocusVisibilityIndex([
    ...architecturalItems,
    ...residential.flatMap((proxy) => proxy.focusWallBlockers || []),
  ]);
  const safeTerrainRadius = focusSafeTerrainRadius(plan, site);
  const heroParcels = plan?.parcels?.filter((parcel) => parcel.hero) || [];
  const primaryHero = heroParcels.find((parcel) => parcel.heroStyle === 'hanok')
    || heroParcels[0]
    || null;
  for (const proxy of residential) {
    const options = {
      subjectId: proxy.parcelId,
      subjectBounds: proxy.focusBounds,
      subjectVolume: proxy.focusVolume,
      detailAnchors: proxy.focusDetailAnchors,
      index,
      detailIndex,
      axisYaw: proxy.focusSafety.axisYaw,
      azimuthMin: proxy.focusSafety.azimuthMin,
      azimuthMax: proxy.focusSafety.azimuthMax,
    };
    const result = site
      ? solveTerrainAwareFocus(
        proxy,
        options,
        proxy.baseCameraFraming,
        site,
        safeTerrainRadius,
      )
      : selectSafeFocusEndpoint({ ...options, framing: proxy.baseCameraFraming });
    proxy.cameraFraming = threeCameraFraming(result.framing);
    proxy.cameraVisibility = visibilityDescriptor(result);

    if (proxy.parcelId === primaryHero?.id) {
      proxy.baseHeroCameraFraming = threeCameraFraming(heroCameraFraming(proxy));
      const heroResult = site
        ? solveTerrainAwareFocus(
          proxy,
          options,
          proxy.baseHeroCameraFraming,
          site,
          safeTerrainRadius,
        )
        : selectSafeFocusEndpoint({
          ...options,
          framing: proxy.baseHeroCameraFraming,
        });
      proxy.heroCameraFraming = threeCameraFraming(heroResult.framing);
      proxy.heroCameraVisibility = visibilityDescriptor(heroResult);
    } else {
      proxy.baseHeroCameraFraming = null;
      proxy.heroCameraFraming = null;
      proxy.heroCameraVisibility = null;
    }
  }
}

export function buildParcelPickProxies(plan, site) {
  const proxies = [];
  for (const parcel of plan.parcels) {
    const baseY = parcel.baseY ?? site.heightAt(parcel.center.x, parcel.center.z);
    const focus = planParcelFocus(parcel);
    const { width, depth, height, rotationY, worldX, worldZ } = focus;
    const worldCenter = new THREE.Vector3(worldX, baseY, worldZ);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    mesh.position.set(worldX, baseY + height / 2, worldZ);
    mesh.rotation.y = rotationY;
    mesh.userData.parcelId = parcel.id;
    mesh.updateMatrixWorld(true);
    const baseCameraFraming = parcelCameraFraming(worldCenter, focus);
    const focusBlocker = parcelFocusBlocker(parcel, site);
    const focusVolume = focusBlocker?.volume || {
      center: { x: worldX, y: baseY + height / 2, z: worldZ },
      half: { x: width / 2, y: height / 2, z: depth / 2 },
      rotationY,
    };
    const focusDetailAnchors = parcelFocusDetailAnchors(parcel, site);
    proxies.push({
      parcelId: parcel.id,
      mesh,
      bbox: new THREE.Box3().setFromObject(mesh),
      worldCenter,
      dims: new THREE.Vector3(width, height, depth),
      rotY: rotationY,
      buildingSpec: buildParcelSpec(parcel),
      baseCameraFraming,
      cameraFraming: cloneCameraFraming(baseCameraFraming),
      focusSafety: {
        axisYaw: rotationY,
        azimuthMin: focus.azimuthMin,
        azimuthMax: focus.azimuthMax,
      },
      focusBounds: focusBlocker ? threeBounds(focusBlocker.bounds) : new THREE.Box3().setFromObject(mesh),
      focusVolume,
      focusDetailAnchors,
      focusSubject: parcelFocusSubject({
        parcel,
        focusVolume,
        detailAnchors: focusDetailAnchors,
        target: baseCameraFraming.target,
        worldCenter,
        width,
        depth,
        height,
        rotationY,
      }),
      focusWallBlockers: parcelWallFocusBlockers(parcel, site, plan.opts?.char01),
    });
  }
  applySafeParcelFramings(proxies, focusPlanningBlockers(plan, site), plan, site);
  return proxies;
}

export function refreshParcelPickProxy(
  proxy,
  parcel,
  site,
  buildingSpec = null,
  peers = null,
  plan = null,
) {
  if (!proxy || !parcel) return null;
  const params = buildingSpec?.params || {};
  const focusParcel = buildingSpec ? {
    ...parcel,
    kind: buildingSpec.kind || parcel.kind,
    wallType: params.wallType ?? parcel.wallType,
    aux: params.aux ?? parcel.aux,
    auxRequested: params.aux ?? parcel.auxRequested,
    jangdok: params.jangdok ?? parcel.jangdok,
    yardStack: params.yardStack ?? parcel.yardStack,
    clothesline: params.clothesline ?? parcel.clothesline,
    vegBed: params.vegBed ?? parcel.vegBed,
  } : parcel;
  const baseY = parcel.baseY ?? site.heightAt(parcel.center.x, parcel.center.z);
  const focus = planParcelFocus(focusParcel);
  const { width, depth, height, rotationY, worldX, worldZ } = focus;
  proxy.mesh.geometry?.dispose?.();
  proxy.mesh.geometry = new THREE.BoxGeometry(width, height, depth);
  proxy.mesh.position.set(worldX, baseY + height / 2, worldZ);
  proxy.mesh.rotation.y = rotationY;
  proxy.mesh.updateMatrixWorld(true);
  proxy.bbox.setFromObject(proxy.mesh);
  proxy.worldCenter.set(worldX, baseY, worldZ);
  proxy.dims.set(width, height, depth);
  proxy.rotY = rotationY;
  proxy.baseCameraFraming = parcelCameraFraming(proxy.worldCenter, focus);
  proxy.cameraFraming = cloneCameraFraming(proxy.baseCameraFraming);
  proxy.baseHeroCameraFraming = null;
  proxy.heroCameraFraming = null;
  proxy.focusSafety = {
    axisYaw: rotationY,
    azimuthMin: focus.azimuthMin,
    azimuthMax: focus.azimuthMax,
  };
  const focusBlocker = parcelFocusBlocker(focusParcel, site);
  proxy.focusBounds = focusBlocker ? threeBounds(focusBlocker.bounds) : proxy.bbox.clone();
  proxy.focusVolume = focusBlocker?.volume || {
      center: { x: worldX, y: baseY + height / 2, z: worldZ },
      half: { x: width / 2, y: height / 2, z: depth / 2 },
      rotationY,
    };
  proxy.focusDetailAnchors = parcelFocusDetailAnchors(focusParcel, site);
  proxy.focusSubject = parcelFocusSubject({
    parcel: focusParcel,
    focusVolume: proxy.focusVolume,
    detailAnchors: proxy.focusDetailAnchors,
    target: proxy.baseCameraFraming.target,
    worldCenter: proxy.worldCenter,
    width,
    depth,
    height,
    rotationY,
  });
  proxy.focusWallBlockers = parcelWallFocusBlockers(focusParcel, site, plan?.opts?.char01);
  proxy.cameraVisibility = null;
  proxy.heroCameraVisibility = null;
  if (buildingSpec) proxy.buildingSpec = buildingSpec;
  applySafeParcelFramings(peers || [proxy], focusPlanningBlockers(plan, site), plan, site);
  return proxy;
}

export function cloneCameraFraming(framing) {
  return {
    position: framing.position.clone(),
    target: framing.target.clone(),
    fov: framing.fov,
    referenceFov: framing.referenceFov,
  };
}

function landmarkCameraFraming(
  worldCenter,
  rotationY,
  width,
  depth,
  { lens, azimuth, elevation, targetY, fit, padding, focusSubject = null },
) {
  const semanticBounds = focusSubjectBounds(focusSubject);
  const semanticWidth = semanticBounds ? semanticBounds.max.x - semanticBounds.min.x : width;
  const semanticDepth = semanticBounds ? semanticBounds.max.z - semanticBounds.min.z : depth;
  const extent = Math.max(semanticWidth, semanticDepth);
  // First reproduce the established composition at its reference lens, including
  // padding, then dolly the whole radius. Scaling only the fit term subtly enlarges
  // monumental compounds when switching to the telephoto profile.
  const referenceRadius = (extent * 0.5) / Math.tan(lens.referenceFov * 0.5 * DEG) * fit
    + extent * padding;
  const radius = dollyDistanceForFov(referenceRadius, lens.referenceFov, lens.fov);
  const offset = new THREE.Vector3(
    radius * Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
    radius * Math.sin(elevation * DEG),
    radius * Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
  );
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  const target = focusSubject?.target
    ? new THREE.Vector3(
      focusSubject.target.x,
      focusSubject.target.y,
      focusSubject.target.z,
    )
    : new THREE.Vector3(worldCenter.x, worldCenter.y + targetY, worldCenter.z);
  return {
    position: target.clone().add(offset),
    target,
    fov: lens.fov,
    referenceFov: lens.referenceFov,
  };
}

export function palaceCameraFraming(worldCenter, rotationY, width, depth, focusSubject = null) {
  return landmarkCameraFraming(worldCenter, rotationY, width, depth, {
    lens: VILLAGE_LENS.palace,
    azimuth: 40,
    elevation: 20,
    targetY: 3.2,
    fit: 1.12,
    padding: 0.12,
    focusSubject,
  });
}

export function templeCameraFraming(worldCenter, rotationY, width, depth, focusSubject = null) {
  return landmarkCameraFraming(worldCenter, rotationY, width, depth, {
    lens: VILLAGE_LENS.temple,
    azimuth: 24,
    elevation: 17,
    targetY: 3,
    fit: 1.16,
    padding: 0.14,
    focusSubject,
  });
}

function refreshLandmarkFocusProxy(proxy, localFocusSubject, cameraFramingForSubject) {
  if (!proxy) return null;
  const focusSubject = transformFocusSubject(localFocusSubject, {
    x: proxy.worldCenter.x,
    y: proxy.worldCenter.y,
    z: proxy.worldCenter.z,
    rotationY: proxy.rotY,
  });
  const cameraFraming = cameraFramingForSubject(
    proxy.worldCenter,
    proxy.rotY,
    proxy.dims.x,
    proxy.dims.z,
    focusSubject,
  );
  const semanticBounds = focusSubjectBounds(focusSubject);
  proxy.focusSubject = focusSubject;
  proxy.focusBounds = semanticBounds ? threeBounds(semanticBounds) : proxy.bbox.clone();
  proxy.baseCameraFraming = cloneCameraFraming(cameraFraming);
  proxy.cameraFraming = cameraFraming;
  return proxy;
}

// Compound edits replace their pure layout/assembler roots without rebuilding
// the whole village. Refresh only the renderer-free semantic camera descriptor;
// callers deliberately decide when a new camera lifecycle should consume it so
// a live edit never steals an orbit the visitor composed by hand.
export function refreshPalacePickProxy(proxy, palaceHandle) {
  return refreshLandmarkFocusProxy(
    proxy,
    palaceHandle?.focusSemantic,
    palaceCameraFraming,
  );
}

export function refreshTemplePickProxy(proxy, templePlan) {
  return refreshLandmarkFocusProxy(
    proxy,
    templeFocusSubject(templePlan),
    templeCameraFraming,
  );
}

/** Build non-residential focus proxies after palace metadata is available. */
export function buildLandmarkPickProxies(plan, site, {
  palaceHandle, palaceInner, palaceSpec,
  templeHandle, templeInner, templeSpec,
}) {
  const proxies = [];
  if (plan.features?.palace) {
    const feature = plan.features.palace;
    const width = (palaceHandle ? palaceHandle.regionW : feature.plotW) || 60;
    const depth = (palaceHandle ? palaceHandle.regionD : feature.plotD) || 90;
    const rotY = palaceInner ? palaceInner.rotation.y : G.facingY(feature.frontDir || { x: 0, z: 1 });
    const baseY = palaceInner ? palaceInner.position.y : site?.heightAt?.(feature.x, feature.z) ?? 0;
    const height = 20;
    const worldCenter = new THREE.Vector3(feature.x, baseY, feature.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    mesh.position.set(feature.x, baseY + height / 2, feature.z);
    mesh.rotation.y = rotY;
    mesh.userData.parcelId = 'palace';
    mesh.updateMatrixWorld(true);
    const focusSubject = transformFocusSubject(palaceHandle?.focusSemantic, {
      x: feature.x,
      y: baseY,
      z: feature.z,
      rotationY: rotY,
    });
    const semanticBounds = focusSubjectBounds(focusSubject);
    const cameraFraming = palaceCameraFraming(
      worldCenter,
      rotY,
      width,
      depth,
      focusSubject,
    );
    proxies.push({
      parcelId: 'palace',
      mesh,
      bbox: new THREE.Box3().setFromObject(mesh),
      worldCenter,
      dims: new THREE.Vector3(width, height, depth),
      rotY,
      buildingSpec: palaceSpec(),
      baseCameraFraming: cloneCameraFraming(cameraFraming),
      cameraFraming,
      focusSubject,
      focusBounds: semanticBounds ? threeBounds(semanticBounds) : new THREE.Box3().setFromObject(mesh),
    });
  }

  if (plan.features?.temple) {
    const feature = plan.features.temple;
    const rotY = templeInner?.rotation.y ?? G.facingY(feature.frontDir || { x: 0, z: 1 });
    const groundY = templeInner?.position.y ?? feature.baseY ?? site?.heightAt?.(feature.x, feature.z) ?? 0;
    const width = (templeHandle?.width || feature.compoundWidth || feature.compoundSize || 33) + 2;
    const depth = (templeHandle?.depth || feature.compoundDepth || feature.compoundSize || 33) + 2;
    const height = 18;
    const worldCenter = new THREE.Vector3(feature.x, groundY, feature.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    mesh.position.set(feature.x, groundY + height / 2, feature.z);
    mesh.rotation.y = rotY;
    mesh.userData.parcelId = 'temple';
    mesh.updateMatrixWorld(true);
    const localFocusSubject = templeFocusSubject(
      templeHandle?.plan || feature.compound,
    );
    const focusSubject = transformFocusSubject(localFocusSubject, {
      x: feature.x,
      y: groundY,
      z: feature.z,
      rotationY: rotY,
    });
    const semanticBounds = focusSubjectBounds(focusSubject);
    const cameraFraming = templeCameraFraming(
      worldCenter,
      rotY,
      width,
      depth,
      focusSubject,
    );
    proxies.push({
      parcelId: 'temple',
      mesh,
      bbox: new THREE.Box3().setFromObject(mesh),
      worldCenter,
      dims: new THREE.Vector3(width, height, depth),
      rotY,
      buildingSpec: templeSpec ? templeSpec() : {
        parcelId: 'temple', family: 'temple', style: 'temple', editable: false, landmark: true,
      },
      baseCameraFraming: cloneCameraFraming(cameraFraming),
      cameraFraming,
      focusSubject,
      focusBounds: semanticBounds ? threeBounds(semanticBounds) : new THREE.Box3().setFromObject(mesh),
    });
  }
  return proxies;
}

export function createParcelHighlight() {
  const group = new THREE.Group();
  group.name = 'village-highlight';
  group.userData.kind = 'parcel-corner-marker';
  const maxCorners = 16;
  const capacity = maxCorners * 4;
  const positions = new Float32Array(capacity * 3);
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setDrawRange(0, 0);
  const corners = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: 0xe5b86d,
    transparent: true,
    opacity: 0.84,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  }));
  corners.name = 'parcel-corner-marker';
  corners.frustumCulled = false;
  group.add(corners);

  const fallback = [
    { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 },
  ];
  const expanded = Array.from({ length: maxCorners }, () => ({ x: 0, z: 0 }));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function validPolygon(polygon) {
    return polygon?.length >= 3 && polygon.length <= maxCorners
      && polygon.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.z));
  }

  function fallbackFootprint({ center, half, rotationY = 0 }) {
    if (!center || !half) return null;
    const halfX = Math.max(0.5, half.x);
    const halfZ = Math.max(0.5, half.z);
    if (![center.x, center.z, halfX, halfZ, rotationY].every(Number.isFinite)) return null;
    const cos = Math.cos(rotationY);
    const sin = Math.sin(rotationY);
    const local = [
      [-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ],
    ];
    for (let index = 0; index < local.length; index++) {
      const [x, z] = local[index];
      fallback[index].x = center.x + x * cos + z * sin;
      fallback[index].z = center.z - x * sin + z * cos;
    }
    return fallback;
  }

  function writeVertex(offset, point, y) {
    positions[offset] = point.x;
    positions[offset + 1] = y;
    positions[offset + 2] = point.z;
  }

  return {
    group,
    show(parcelId, marker) {
      const requested = Array.isArray(marker.contours)
        ? marker.contours.filter((contour) => validPolygon(contour?.polygon)
          && Number.isFinite(contour?.y))
        : [];
      const fallbackPolygon = requested.length ? null : fallbackFootprint(marker);
      const contours = requested.length
        ? requested
        : (fallbackPolygon ? [{ polygon: fallbackPolygon, y: marker.y }] : []);
      let vertex = 0;
      let cornerCount = 0;
      let contourCount = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const contour of contours) {
        const source = contour.polygon;
        if (cornerCount + source.length > maxCorners) break;
        let centerX = 0;
        let centerZ = 0;
        for (const point of source) {
          centerX += point.x;
          centerZ += point.z;
        }
        centerX /= source.length;
        centerZ /= source.length;

        // A small outward bias keeps the marker legible beside the exact eave
        // silhouette. Real roofs still depth-occlude it; no fill or vertical
        // pick volume can cover the house.
        for (let index = 0; index < source.length; index++) {
          const dx = source[index].x - centerX;
          const dz = source[index].z - centerZ;
          const distance = Math.hypot(dx, dz) || 1;
          expanded[index].x = source[index].x + dx / distance * 0.18;
          expanded[index].z = source[index].z + dz / distance * 0.18;
        }

        const y = Number.isFinite(contour.y)
          ? contour.y
          : (Number.isFinite(marker.y) ? marker.y : marker.center.y + 0.14);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (let index = 0; index < source.length; index++) {
          const current = expanded[index];
          const previous = expanded[(index + source.length - 1) % source.length];
          const next = expanded[(index + 1) % source.length];
          for (const neighbour of [previous, next]) {
            const dx = neighbour.x - current.x;
            const dz = neighbour.z - current.z;
            const length = Math.hypot(dx, dz) || 1;
            const tick = clamp(length * 0.22, 0.8, 2.2);
            writeVertex(vertex * 3, current, y);
            vertex++;
            writeVertex(vertex * 3, {
              x: current.x + dx / length * tick,
              z: current.z + dz / length * tick,
            }, y);
            vertex++;
          }
        }
        cornerCount += source.length;
        contourCount++;
      }
      position.needsUpdate = true;
      geometry.setDrawRange(0, vertex);
      group.userData.parcelId = parcelId;
      group.userData.source = marker.source || 'focus-footprint';
      group.userData.cornerCount = cornerCount;
      group.userData.contourCount = contourCount;
      group.userData.minY = Number.isFinite(minY) ? minY : null;
      group.userData.maxY = Number.isFinite(maxY) ? maxY : null;
      group.visible = vertex > 0;
    },
    clear() {
      group.visible = false;
      group.userData.parcelId = null;
      group.userData.source = null;
      group.userData.cornerCount = 0;
      group.userData.contourCount = 0;
      group.userData.minY = null;
      group.userData.maxY = null;
    },
  };
}

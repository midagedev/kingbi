// 카메라 드라이브·드론 패스·1인칭 보행의 공개 API.
export { setupCinematic } from '../camera/cinematic.js';
export {
  VILLAGE_LENS,
  VILLAGE_FOCUS_DOF_APERTURE,
  VILLAGE_FOCUS_CONTEXT_ELEVATION,
  VILLAGE_NIGHT_AERIAL_ELEVATION,
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_EAVE_FOCUS_ELEVATION,
  VILLAGE_EAVE_FOCUS_BAND_MAX,
  VILLAGE_FOCUS_SKY_FRACTION,
  VILLAGE_FOCUS_SKY_REFERENCE_BAND,
  VILLAGE_HERO_FOCUS_ELEVATION,
  VILLAGE_ZOOM,
  dollyDistanceForFov,
  fovForDollyScale,
  dollyScaleForFov,
  equivalentDistanceAtFov,
  lensScaleForCamera,
  referenceFovForCamera,
  referenceVillageFov,
  villageAerialElevation,
  villageScreenDistance,
  villageScreenDistanceForCamera,
  villageFocusContextElevation,
  villageFocusEaveWeight,
  villageFocusEffectWeight,
  villageZoomReferenceBounds,
} from '../camera/optics.js';export {
  createDirectionController,
  createHeadingController,
  shortestAngleDelta,
} from '../camera/heading.js';
export {
  fitFocusFraming,
  safeViewportRect,
} from '../camera/focus-framing.js';
// 지면 위 카메라 종점 여유고 — 궤도 입력 쿠션이 focus 해결기와 같은 값을 써야 저작된 근경 프레임을
// 들어올리지 않는다.
export { VILLAGE_FOCUS_CAMERA_CLEARANCE } from '../camera/focus-visibility.js';
export {
  buildObstacles,
  createDronePaths,
  mainRoad,
  roofTopAt,
} from '../cinematic/dronepath.js';
export {
  buildWalkSolids,
  houseSolidProbePoint,
  makeWalkPolySolid,
  makeWalkSolid,
  parcelHouseWalkSolid,
  parcelHouseWalkSolids,
  parcelWallWalkSolids,
  pointHitsWalkSolid,
  pointHitsWalkSolids,
  sampleGateCourtyardPath,
  sampleWallMidBlocked,
  wallSegmentSolid,
} from '../cinematic/walk-solids.js';
export { createWalker } from '../cinematic/walker.js';
export {
  createArchitecturalReveal,
  createArchitecturalRevealTimeline,
  sampleArchitecturalReveal,
} from '../cinematic/architectural-reveal.js';
// #150-M: Three-free explore/focus/hop/focusOut/wave/exit transition table.
// Engine dispatches only; zoom distance stays in optics (selection ≠ zoom).
export {
  VIEW_PHASES,
  VIEW_EVENTS,
  VIEW_TRACE_DEFAULT_CAPACITY,
  viewInitialState,
  viewReduce,
  viewCan,
  viewIsBusy,
  viewSelectionRegime,
  viewZoomRegime,
  viewWaveExclusive,
  createViewTrace,
} from '../camera/view-lifecycle.js';

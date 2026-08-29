// Renderer-free lunar angular-size and cloud-compositing contract.
// Import this narrow façade when a consumer must not load Three or browser code.
export {
  DEFAULT_MOON_OPTICS,
  MOON_ANGULAR_DIAMETER_DEG,
  MOON_BLOOM_KNEE,
  MOON_CORONA_DIAMETER_DEG,
  MOON_CORONA_ENERGY,
  MOON_CORONA_PROFILE,
  MOON_DISTANCE,
  MOON_RENDER_ORDER,
  NIGHT_AERIAL_MOON_FRAME,
  planeSpanForAngularDiameter,
  projectCelestialDirectionNdc,
  projectedAngularDiameterPixels,
  resolveMoonBloomGate,
  resolveMoonCloudComposite,
  resolveMoonOptics,
  resolveNightAerialMoonFrame,
  sampleMoonCoronaProfile,
  sphereRadiusForAngularDiameter,
} from '../env/moon-optics.js';

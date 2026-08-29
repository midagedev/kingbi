const DEG = Math.PI / 180;

export const MOON_DISTANCE = 460;
export const MOON_ANGULAR_DIAMETER_DEG = 0.52;
export const MOON_CORONA_DIAMETER_DEG = 5;

// Opaque terrain/buildings still own depth. Within the transparent sky lane, the
// direct lunar disc and transmitted corona sit behind cloud alpha while a much
// fainter scattered corona is added after it. Thin cloud can therefore attenuate
// the source without cutting every trace of nearby atmospheric light.
export const MOON_RENDER_ORDER = Object.freeze({
  coronaTransmitted: -1,
  disk: 0,
  cloudsStart: 1,
  cloudsEnd: 3,
  coronaScattered: 4,
});

export const MOON_CORONA_ENERGY = Object.freeze({
  transmitted: 0.40,
  scattered: 0.02,
});
export const MOON_BLOOM_KNEE = Object.freeze({
  nightThreshold: 0.32,
  releaseThreshold: 0.60,
  radius: 0.10,
  stockWidth: 0.01,
});

export const MOON_CORONA_PROFILE = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([0.11, 0]),
  Object.freeze([0.125, 0.34]),
  Object.freeze([0.16, 0.20]),
  Object.freeze([0.32, 0.07]),
  Object.freeze([0.62, 0.018]),
  Object.freeze([1, 0]),
]);

const positive = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep01 = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export function sphereRadiusForAngularDiameter(distance, angularDiameterDeg) {
  const d = positive(distance, MOON_DISTANCE);
  const angle = positive(angularDiameterDeg, MOON_ANGULAR_DIAMETER_DEG) * DEG;
  return d * Math.sin(angle * 0.5);
}

export function planeSpanForAngularDiameter(distance, angularDiameterDeg) {
  const d = positive(distance, MOON_DISTANCE);
  const angle = positive(angularDiameterDeg, MOON_CORONA_DIAMETER_DEG) * DEG;
  return 2 * d * Math.tan(angle * 0.5);
}

export function projectedAngularDiameterPixels(
  angularDiameterDeg,
  verticalFovDeg,
  viewportHeight,
) {
  const angle = positive(angularDiameterDeg, MOON_ANGULAR_DIAMETER_DEG) * DEG;
  const fov = positive(verticalFovDeg, 46) * DEG;
  const height = positive(viewportHeight, 1);
  return height * Math.tan(angle * 0.5) / Math.tan(fov * 0.5);
}

export function sampleMoonCoronaProfile(normalizedRadius) {
  const radius = Number.isFinite(normalizedRadius)
    ? Math.max(0, Math.min(1, normalizedRadius))
    : 0;
  for (let index = 1; index < MOON_CORONA_PROFILE.length; index++) {
    const [rightRadius, rightAlpha] = MOON_CORONA_PROFILE[index];
    if (radius > rightRadius) continue;
    const [leftRadius, leftAlpha] = MOON_CORONA_PROFILE[index - 1];
    const span = Math.max(Number.EPSILON, rightRadius - leftRadius);
    const t = (radius - leftRadius) / span;
    return leftAlpha + (rightAlpha - leftAlpha) * t;
  }
  return MOON_CORONA_PROFILE.at(-1)[1];
}

export function resolveMoonCloudComposite(cloudAlpha) {
  const opacity = Number.isFinite(cloudAlpha)
    ? Math.max(0, Math.min(1, cloudAlpha))
    : 0;
  const transmission = 1 - opacity;
  return Object.freeze({
    disk: transmission,
    corona: MOON_CORONA_ENERGY.transmitted * transmission
      + MOON_CORONA_ENERGY.scattered,
  });
}

export function resolveMoonBloomGate(bloomThreshold) {
  const authoredThreshold = positive(
    bloomThreshold,
    MOON_BLOOM_KNEE.nightThreshold,
  );
  const releaseSpan = MOON_BLOOM_KNEE.releaseThreshold
    - MOON_BLOOM_KNEE.nightThreshold;
  const release = smoothstep01(
    (authoredThreshold - MOON_BLOOM_KNEE.nightThreshold) / releaseSpan,
  );
  const knee = MOON_BLOOM_KNEE.radius * (1 - release);
  return Object.freeze({
    authoredThreshold,
    knee,
    threshold: authoredThreshold - knee,
    smoothWidth: Math.max(MOON_BLOOM_KNEE.stockWidth, knee * 2),
  });
}

export function resolveMoonOptics({
  distance = MOON_DISTANCE,
  diskAngularDiameterDeg = MOON_ANGULAR_DIAMETER_DEG,
  coronaAngularDiameterDeg = MOON_CORONA_DIAMETER_DEG,
} = {}) {
  const resolvedDistance = positive(distance, MOON_DISTANCE);
  const diskAngle = positive(diskAngularDiameterDeg, MOON_ANGULAR_DIAMETER_DEG);
  const coronaAngle = Math.max(
    diskAngle,
    positive(coronaAngularDiameterDeg, MOON_CORONA_DIAMETER_DEG),
  );
  return Object.freeze({
    distance: resolvedDistance,
    diskAngularDiameterDeg: diskAngle,
    coronaAngularDiameterDeg: coronaAngle,
    diskRadius: sphereRadiusForAngularDiameter(resolvedDistance, diskAngle),
    coronaSpan: planeSpanForAngularDiameter(resolvedDistance, coronaAngle),
  });
}

export const DEFAULT_MOON_OPTICS = resolveMoonOptics();

// Product night aerial (U2): the 31° day survey looks so steep that the 46° lens's top
// ray sits ~8° *below* the horizon, so a lunar disc above the ridge never enters the
// frame. Night aerial softens camera elevation and keeps the moon on a low positive
// elevation so disc + corona land in the upper sky band while the directional light
// still models form from above. Values mirror `VILLAGE_NIGHT_AERIAL_ELEVATION` /
// `AERIAL_AZIMUTH` / `VILLAGE_LENS.aerial` — freeze them here so pure gates do not
// import the camera module.
export const NIGHT_AERIAL_MOON_FRAME = Object.freeze({
  cameraElevationDeg: 15,
  cameraAzimuthDeg: 9,
  verticalFovDeg: 46,
  aspect: 16 / 9,
  // Keep disc clear of chrome / letterbox; corona may graze the margin.
  ndcMargin: 0.08,
});

/**
 * Project a world-space celestial direction into NDC for a look-at aerial camera
 * sitting on a sphere about the target (Three.js Y-up, look along −Z in camera space).
 * Direction is camera-relative for the moon, so origin cancels and only the ray matters.
 */
export function projectCelestialDirectionNdc(
  direction,
  {
    cameraElevationDeg = NIGHT_AERIAL_MOON_FRAME.cameraElevationDeg,
    cameraAzimuthDeg = NIGHT_AERIAL_MOON_FRAME.cameraAzimuthDeg,
    verticalFovDeg = NIGHT_AERIAL_MOON_FRAME.verticalFovDeg,
    aspect = NIGHT_AERIAL_MOON_FRAME.aspect,
  } = {},
) {
  const src = Array.isArray(direction) ? direction : [direction?.x, direction?.y, direction?.z];
  const length = Math.hypot(
    Number(src[0]) || 0,
    Number(src[1]) || 0,
    Number(src[2]) || 0,
  );
  if (!(length > 0)) {
    return Object.freeze({
      ndcX: 0, ndcY: 0, depth: 0, inFront: false,
    });
  }
  const mx = src[0] / length;
  const my = src[1] / length;
  const mz = src[2] / length;

  const camElev = (Number.isFinite(cameraElevationDeg) ? cameraElevationDeg : NIGHT_AERIAL_MOON_FRAME.cameraElevationDeg) * DEG;
  const camAz = (Number.isFinite(cameraAzimuthDeg) ? cameraAzimuthDeg : NIGHT_AERIAL_MOON_FRAME.cameraAzimuthDeg) * DEG;
  // Camera sits on a sphere about the target at (elev, az); Three.js lookAt uses
  // z = normalize(eye − target), x = normalize(up × z), y = z × x (Y-up).
  const zx = Math.cos(camElev) * Math.sin(camAz);
  const zy = Math.sin(camElev);
  const zz = Math.cos(camElev) * Math.cos(camAz);
  // up × z with up = (0,1,0)
  let xx = zz;
  let xy = 0;
  let xz = -zx;
  const xLen = Math.hypot(xx, xy, xz) || 1;
  xx /= xLen; xy /= xLen; xz /= xLen;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const cx = mx * xx + my * xy + mz * xz;
  const cy = mx * yx + my * yy + mz * yz;
  const cz = mx * zx + my * zy + mz * zz;
  const vfov = positive(verticalFovDeg, NIGHT_AERIAL_MOON_FRAME.verticalFovDeg) * DEG;
  const asp = positive(aspect, NIGHT_AERIAL_MOON_FRAME.aspect);
  const halfV = Math.tan(vfov * 0.5);
  const halfH = halfV * asp;
  const depth = -cz;
  if (!(depth > 1e-8)) {
    return Object.freeze({
      ndcX: 0, ndcY: 0, depth: cz, inFront: false,
    });
  }
  return Object.freeze({
    ndcX: (cx / depth) / halfH,
    ndcY: (cy / depth) / halfV,
    depth: cz,
    inFront: true,
  });
}

/**
 * Night aerial moon framing contract: disc (and soft corona budget) inside the product
 * aerial frustum for the authored night moon direction. Used by pure gates and by
 * product aerial elevation selection — no renderer.
 */
export function resolveNightAerialMoonFrame(
  sunDir,
  {
    cameraElevationDeg = NIGHT_AERIAL_MOON_FRAME.cameraElevationDeg,
    cameraAzimuthDeg = NIGHT_AERIAL_MOON_FRAME.cameraAzimuthDeg,
    verticalFovDeg = NIGHT_AERIAL_MOON_FRAME.verticalFovDeg,
    aspect = NIGHT_AERIAL_MOON_FRAME.aspect,
    ndcMargin = NIGHT_AERIAL_MOON_FRAME.ndcMargin,
    coronaAngularDiameterDeg = MOON_CORONA_DIAMETER_DEG,
  } = {},
) {
  const projected = projectCelestialDirectionNdc(sunDir, {
    cameraElevationDeg,
    cameraAzimuthDeg,
    verticalFovDeg,
    aspect,
  });
  const margin = Number.isFinite(ndcMargin) ? Math.max(0, ndcMargin) : NIGHT_AERIAL_MOON_FRAME.ndcMargin;
  const limit = 1 - margin;
  const discInFrame = projected.inFront
    && Math.abs(projected.ndcX) <= limit
    && Math.abs(projected.ndcY) <= limit;
  // Corona half-angle as a conservative vertical NDC radius at frame center depth.
  const halfV = Math.tan(positive(verticalFovDeg, NIGHT_AERIAL_MOON_FRAME.verticalFovDeg) * DEG * 0.5);
  const coronaHalfDeg = positive(coronaAngularDiameterDeg, MOON_CORONA_DIAMETER_DEG) * 0.5;
  const coronaNdcRadius = Math.tan(coronaHalfDeg * DEG) / halfV;
  const coronaInFrame = projected.inFront
    && Math.abs(projected.ndcX) <= 1
    && Math.abs(projected.ndcY) <= 1
    && Math.abs(projected.ndcY) + coronaNdcRadius * 0.35 <= 1.05;
  return Object.freeze({
    ndcX: projected.ndcX,
    ndcY: projected.ndcY,
    inFront: projected.inFront,
    discInFrame,
    coronaInFrame,
    cameraElevationDeg,
    verticalFovDeg,
  });
}

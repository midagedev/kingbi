import * as THREE from 'three';

// Shared deterministic modulation for the single physical hanji-light path.
export const NIGHTLIGHT_FLICK_GLSL = /* glsl */`
float nightlightFlick(float t, float ph) {
  float breathe = 0.5 * sin(t * 1.7 + ph) + 0.5 * sin(t * 0.63 + ph * 1.7);
  float jitter = sin(t * 9.3 + ph * 3.1);
  return clamp(1.0 + 0.12 * breathe + 0.03 * jitter, 0.62, 1.15);
}

float nightlightIntensity(
  float lit,
  float threshold,
  float phase,
  float visualDistance
) {
  float on = smoothstep(threshold, threshold + 0.16, uNight);
  float nearFade = smoothstep(uFadeNear, uFadeNearEnd, visualDistance);
  return lit * on * nightlightFlick(uTime, phase) * nearFade * uWave;
}
`;

const VERTEX_SHADER = /* glsl */`
uniform float uNight;
uniform float uTime;
uniform float uFadeNear;
uniform float uFadeNearEnd;
uniform float uLensScale;
uniform float uWave;

attribute vec3 aAnchor;
attribute vec3 aOutward;
attribute vec2 aOpeningSize;
attribute float aPhase;
attribute float aLit;
attribute float aThreshold;
attribute float aWarm;

varying float vIntensity;
varying float vWarm;
varying vec2 vUv;

${NIGHTLIGHT_FLICK_GLSL}

void main() {
  // Capacity slots without an authored opening stay in the deterministic
  // buffers, but must not normalize an unused basis or write dead varyings.
  if (aLit <= 0.002 || min(aOpeningSize.x, aOpeningSize.y) <= 0.001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 outward = normalize(aOutward);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), outward));
  vec3 up = normalize(cross(outward, right));
  vec3 physicalPosition = aAnchor
    + right * position.x * aOpeningSize.x
    + up * position.y * aOpeningSize.y
    // Sit immediately outside the authored fixed hanji plane. This is enough
    // to avoid coplanar shimmer without turning the light into a free prop.
    + outward * 0.004;
  vec4 mv = modelViewMatrix * vec4(physicalPosition, 1.0);
  float visualDistance = max(-mv.z, 0.001) / max(uLensScale, 0.0001);
  vIntensity = nightlightIntensity(
    aLit,
    aThreshold,
    aPhase,
    visualDistance
  );
  vWarm = aWarm;
  vUv = uv;
  if (vIntensity <= 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = projectionMatrix * mv;
}
`;

const PAPER_PROFILE_GLSL = /* glsl */`
float nightlightPaperProfile(vec2 uv) {
  float edgeDistance = min(
    min(uv.x, 1.0 - uv.x),
    min(uv.y, 1.0 - uv.y)
  );
  float edge = smoothstep(0.0, max(fwidth(edgeDistance) * 1.25, 0.002), edgeDistance);
  vec2 centered = uv - 0.5;
  float quietCenter = 1.0 - smoothstep(0.08, 0.72, length(centered));
  return edge * (0.72 + quietCenter * 0.30);
}
`;

const FRAGMENT_SHADER = /* glsl */`
precision highp float;
uniform vec3 uColorCandle;
uniform vec3 uColorLamp;
varying float vIntensity;
varying float vWarm;
varying vec2 vUv;

${PAPER_PROFILE_GLSL}

void main() {
  float paper = nightlightPaperProfile(vUv);
  if (paper * vIntensity <= 0.002) discard;
  vec3 color = mix(uColorCandle, uColorLamp, vWarm);
  // The rectangle is a shallow emissive hanji proxy, not a point halo. Bloom
  // and optical defocus remain downstream linear-HDR operations.
  gl_FragColor = vec4(color * paper * vIntensity * 0.72, 1.0);
}
`;

const DEPTH_FRAGMENT_SHADER = /* glsl */`
precision highp float;
#include <packing>
varying float vIntensity;
varying vec2 vUv;

${PAPER_PROFILE_GLSL}

void main() {
  float paper = nightlightPaperProfile(vUv);
  // Match the visible proxy and keep only source-bright hanji. Dim edges remain
  // bloom support instead of becoming an opaque depth card.
  if (paper * vIntensity * 0.72 <= 0.18) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}
`;

function instancedAttribute(array, itemSize) {
  return new THREE.InstancedBufferAttribute(array, itemSize)
    .setUsage(THREE.DynamicDrawUsage);
}

/**
 * Build one front-facing physical hanji proxy batch from renderer-authored
 * owner/slot arrays. No randomness or per-house Object3D/material is introduced.
 */
export function createPhysicalNightlightBatch({
  count,
  arrays,
  uniforms,
}) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aAnchor', instancedAttribute(arrays.position, 3));
  geometry.setAttribute('aOutward', instancedAttribute(arrays.outward, 3));
  geometry.setAttribute('aOpeningSize', instancedAttribute(arrays.openingSize, 2));
  geometry.setAttribute('aPhase', instancedAttribute(arrays.phase, 1));
  geometry.setAttribute('aLit', instancedAttribute(arrays.lit, 1));
  geometry.setAttribute('aThreshold', instancedAttribute(arrays.threshold, 1));
  geometry.setAttribute('aWarm', instancedAttribute(arrays.warm, 1));
  geometry.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  material.name = 'nightlight-physical-color';
  material.customProgramCacheKey = () => 'cheoma-nightlight-physical-color-v1';

  const depthMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: DEPTH_FRAGMENT_SHADER,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
  depthMaterial.name = 'nightlight-physical-dof-depth';
  depthMaterial.allowOverride = false;
  depthMaterial.customProgramCacheKey = () => 'cheoma-nightlight-physical-depth-v1';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'nightlight-physical';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.userData.dofDepthMaterial = depthMaterial;
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    mesh.visible = false;
    mesh.removeFromParent();
    delete mesh.userData.dofDepthMaterial;
    geometry.dispose();
    material.dispose();
    depthMaterial.dispose();
  }

  return {
    object: mesh,
    geometry,
    material,
    depthMaterial,
    dynamicAttributes: Object.freeze([
      'aAnchor',
      'aOutward',
      'aOpeningSize',
      'aPhase',
      'aLit',
      'aThreshold',
      'aWarm',
    ]),
    resource: Object.freeze({
      drawCalls: 1,
      dofDepthDrawCalls: 1,
      triangles: count * 2,
      materials: 2,
      programs: 2,
      textures: 0,
      lights: 0,
      attributeBytes:
        // Shared unit-quad position + uv + Uint16 index buffers are 92 bytes.
        92
        + arrays.position.byteLength
        + arrays.outward.byteLength
        + arrays.openingSize.byteLength
        + arrays.phase.byteLength
        + arrays.lit.byteLength
        + arrays.threshold.byteLength
        + arrays.warm.byteLength,
    }),
    dispose,
  };
}

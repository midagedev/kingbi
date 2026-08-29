import * as THREE from 'three';
import {
  MATERIAL_PROGRAM_PATCH,
  addMaterialProgramKey,
} from '../render/material-program-key.js';
import { patchLodScreenDoorMaterial } from '../render/lod-screen-door.js';

// One accumulation shader shared by the standalone environment and village runtime.
// Profiles only change coverage/colour constants, so materials with the same native
// defines still share programs instead of creating per-object snow variants.
const PROFILES = Object.freeze({
  surface: {
    color: [0.95, 0.96, 0.98], ceiling: 1, thickFill: 0.85,
    backfaceBoost: 1.05, steepMinimum: 1, floorMin: 0.90, coverage: 1,
  },
  tile: {
    color: [0.92, 0.93, 0.95], ceiling: 1, thickFill: 0.62,
    backfaceBoost: 0.78, steepMinimum: 0.55, floorMin: 0.90, coverage: 1,
  },
  thatch: {
    color: [0.80, 0.80, 0.78], ceiling: 0.50, thickFill: 0.28,
    backfaceBoost: 0.30, steepMinimum: 1, floorMin: 0.72, coverage: 1,
  },
  terrain: {
    color: [0.92, 0.94, 0.96], ceiling: 1, thickFill: 0.12,
    backfaceBoost: 0, steepMinimum: 0.72, floorMin: 0.48, coverage: 0.88,
  },
  foliage: {
    color: [0.88, 0.90, 0.91], ceiling: 1, thickFill: 0.08,
    backfaceBoost: 0.20, steepMinimum: 0.82, floorMin: 0.35, coverage: 0.66,
  },
});

export const SNOW_AMOUNT_MAX = 0.82;
export const SNOW_ACCUMULATE_SECONDS = 46;
export const SNOW_MELT_SECONDS = 16;

export function snowProfileForObject(object, material = object?.material) {
  if (material?.userData?.role === 'roof') {
    for (let node = object; node; node = node.parent) {
      if (node.userData?.snowRoofKind) return node.userData.snowRoofKind === 'choga' ? 'thatch' : 'tile';
      if ((node.name || '').includes('-choga')) return 'thatch';
    }
    return 'tile';
  }
  const ownName = (object?.name || '').toLowerCase();
  if (ownName.startsWith('flora-')) {
    if (ownName.includes('stone') || ownName.includes('rock')) return 'terrain';
    if (ownName.includes('leaf')) return 'foliage';
    return 'surface';
  }
  for (let node = object; node; node = node.parent) {
    const name = (node.name || '').toLowerCase();
    if (['terrain', 'paddy', 'ground', 'road', 'court', 'pad', 'rock', 'stone', 'bridge']
      .some((token) => name.includes(token))) return 'terrain';
    if (name.includes('tree') || name.includes('forest') || name.includes('flora')) return 'foliage';
  }
  return 'surface';
}

export function patchSnowMaterial(material, amountUniform, { profile = 'surface' } = {}) {
  if (!material?.isMeshStandardMaterial || !amountUniform || material.userData?.__snowPatched
    || material.userData?.snowSurface === false) return false;
  const P = PROFILES[profile] || PROFILES.surface;
  material.userData = material.userData || {};
  material.userData.__snowPatched = true;
  material.userData.__snowProfile = profile;
  material.userData.__snowPatchVersion = MATERIAL_PROGRAM_PATCH.SNOW;
  // R8 program diet (#220 residual): snow-patched stock materials always carry the LOD
  // screen-door path so clear→snow and plain→LOD never fork independent snow families.
  // Coverage defaults to affine 1; true LOD roots alone rewrite matrix[3][3].
  patchLodScreenDoorMaterial(material);

  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousCompile) previousCompile(shader, renderer);
    shader.uniforms.uSnowAmount = amountUniform;
    shader.uniforms.uSnowColor = { value: new THREE.Vector3(...P.color) };
    shader.uniforms.uSnowProfile = {
      value: new THREE.Vector4(P.thickFill, P.steepMinimum, P.floorMin, P.coverage),
    };
    shader.uniforms.uSnowExtra = { value: new THREE.Vector2(P.ceiling, P.backfaceBoost) };
    const twoSided = material.side === THREE.DoubleSide ? '1.0' : '0.0';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWN;\nvarying vec3 vSnowWP;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        #ifdef USE_INSTANCING
          vSnowWN = mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal;
        #else
          vSnowWN = mat3(modelMatrix) * objectNormal;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vSnowWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vSnowWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSnowWN;
        varying vec3 vSnowWP;
        uniform float uSnowAmount;
        uniform vec3 uSnowColor;
        uniform vec4 uSnowProfile;
        uniform vec2 uSnowExtra;
        float snowCov = 0.0;
        float snowFix = 0.0;
        float snowHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float snowNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(snowHash(i), snowHash(i + vec2(1.0, 0.0)), f.x),
                     mix(snowHash(i + vec2(0.0, 1.0)), snowHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 swn = normalize(vSnowWN);
          float fixup = ${twoSided} * step(swn.y, -0.05)
                      * smoothstep(0.30, 0.55, abs(swn.y))
                      * smoothstep(0.0, 0.20, uSnowAmount);
          vec3 vUp = normalize((viewMatrix * vec4(-swn, 0.0)).xyz);
          normal = normalize(mix(normal, vUp, fixup));
          snowFix = fixup;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 wn = normalize(vSnowWN);
          float ny = mix(wn.y, abs(wn.y), ${twoSided});
          float thresh = mix(0.72, 0.20, uSnowAmount);
          float up = smoothstep(thresh - 0.10, thresh + 0.18, ny);
          float ridge = 0.5 + 0.5 * sin(vSnowWP.x * 3.0 + vSnowWP.z * 0.6);
          float blotch = 0.34 + 0.66 * (0.68 * snowNoise(vSnowWP.xz * 0.13)
                                     + 0.32 * snowNoise(vSnowWP.xz * 0.31 + vec2(17.0)));
          float flatFace = smoothstep(0.80, 0.97, wn.y);
          float slopeCov = (0.72 + 0.28 * blotch) * (0.86 + 0.14 * ridge);
          float floorCov = uSnowProfile.z + (1.0 - uSnowProfile.z) * blotch;
          float thick = smoothstep(0.35, 0.85, uSnowAmount);
          slopeCov = mix(slopeCov, 0.98, thick * uSnowProfile.x);
          float cov = up * mix(slopeCov, floorCov, flatFace);
          cov *= smoothstep(0.0, 0.14, uSnowAmount);
          cov *= mix(uSnowProfile.y, 1.0, smoothstep(0.34, 0.66, ny));
          cov = clamp(cov * uSnowExtra.x * uSnowProfile.w, 0.0, 1.0);
          snowCov = cov;
          diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, cov);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.96, snowCov);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.0, snowCov);`)
      .replace('#include <dithering_fragment>', `{
          gl_FragColor.rgb *= 1.0 + snowFix * snowCov * uSnowExtra.y;
        }
        #include <dithering_fragment>`);
  };

  addMaterialProgramKey(material, MATERIAL_PROGRAM_PATCH.SNOW);
  material.needsUpdate = true;
  return true;
}

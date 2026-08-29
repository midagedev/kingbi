import * as THREE from 'three';

function disposeOwned(...resources) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const resource of resources) resource.dispose();
  };
}

function disposeRepresentation(object, ...resources) {
  const disposeResources = disposeOwned(...resources);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    object.visible = false;
    object.removeFromParent();
    delete object.userData.dofDepthMaterial;
    disposeResources();
  };
}

function copyBaseGeometry(base, count) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  // The custom materials consume only position. Carrying generated normal/uv buffers
  // would spend geometry memory without changing the result.
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.instanceCount = count;
  return geometry;
}

function createCrossedFlakeGeometry() {
  const positions = new Float32Array([
    -0.304878, 0, 0, 0, 0.5, 0, 0.304878, 0, 0,
    -0.304878, 0, 0, 0, -0.5, 0, 0.304878, 0, 0,
    0, 0, -0.304878, 0, 0.5, 0, 0, 0, 0.304878,
    0, 0, -0.304878, 0, -0.5, 0, 0, 0, 0.304878,
    -0.304878, 0, 0, 0, 0, -0.304878, 0.304878, 0, 0,
    -0.304878, 0, 0, 0, 0, 0.304878, 0.304878, 0, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

// 실제 빗방울 폭(≈2mm)·눈송이 지름(≈2cm)은 어떤 프레임에서도 1픽셀보다 얇다. 물리 치수만 쓰면
// 근접 몇 미터를 제외한 모든 거리에서 강수가 화면에서 사라지고(look-audit R3·U3), 반대로 거리에
// 비례해 월드 치수를 JS 에서 한 번에 키우면 볼륨 깊이(부감 3:1)만큼 폭이 갈려 앞쪽 입자가
// 흰 막대로 부푼다(#116 계열). 그래서 하한은 정점당(=입자당) 투영 깊이에서 직접 잡는다:
// projectionMatrix[1][1] = 1/tan(halfFovY) 이므로 "화면 높이 대비 비율 uScreen 을 유지하는 월드 치수"는
// uScreen * viewDepth / P11 이다. 입자는 여전히 월드 공간의 실제 삼각형이고 깊이·가림·DoF 에
// 정상 참여한다 — 카메라 대면 빌보드도, gl_PointSize 렌즈도, 타깃 높이 추론도 아니다.
// 오브젝트 스케일(낙하 볼륨 배율)은 중심 위치에만 적용되고 입자 치수에는 곱해지지 않는다.
const PRECIPITATION_SCREEN_FLOOR = `
  float screenFloorWorld(vec3 centerWorld, float screenFraction, float cap) {
    float depth = max(0.001, -(viewMatrix * vec4(centerWorld, 1.0)).z);
    return min(cap, screenFraction * depth / max(1e-4, projectionMatrix[1][1]));
  }`;

const PHYSICAL_SNOW_VERTEX = `
  attribute vec3 aCenter;
  attribute float aSize;
  attribute float aOpacity;
  attribute float aPhase;
  uniform float uTime;
  uniform float uWorldScale;
  uniform float uScreenSize;
  uniform float uScreenSizeCap;
  varying float vOpacity;
  mat3 rotX(float a) {
    float c = cos(a), s = sin(a);
    return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c);
  }
  mat3 rotY(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c);
  }
  ${PRECIPITATION_SCREEN_FLOOR}
  void main() {
    float turn = aPhase + uTime * (0.32 + 0.11 * sin(aPhase));
    float tumble = aPhase * 0.73 + uTime * 0.21;
    vec3 centerWorld = (modelMatrix * vec4(aCenter, 1.0)).xyz;
    float size = max(
      aSize * uWorldScale,
      screenFloorWorld(centerWorld, uScreenSize, uScreenSizeCap)
    );
    vec3 offset = rotY(turn) * rotX(tumble) * position * size;
    gl_Position = projectionMatrix * viewMatrix * vec4(centerWorld + offset, 1.0);
    vOpacity = aOpacity;
  }`;

const PHYSICAL_RAIN_VERTEX = `
  attribute vec3 aCenter;
  attribute float aLength;
  attribute float aOpacity;
  uniform vec2 uLean;
  uniform float uRadius;
  uniform float uScreenWidth;
  uniform float uScreenWidthCap;
  uniform float uLengthScale;
  varying float vOpacity;
  ${PRECIPITATION_SCREEN_FLOOR}
  void main() {
    vec3 axis = normalize(vec3(-uLean.x, -1.0, -uLean.y));
    vec3 tangent = normalize(cross(
      abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0),
      axis
    ));
    vec3 bitangent = cross(axis, tangent);
    vec3 centerWorld = (modelMatrix * vec4(aCenter, 1.0)).xyz;
    float radius = max(
      uRadius,
      screenFloorWorld(centerWorld, uScreenWidth, uScreenWidthCap)
    );
    vec3 offset = tangent * position.x * radius
      + axis * position.y * aLength * uLengthScale
      + bitangent * position.z * radius;
    gl_Position = projectionMatrix * viewMatrix * vec4(centerWorld + offset, 1.0);
    vOpacity = aOpacity;
  }`;

const PHYSICAL_DEPTH_FRAGMENT = `
  #include <packing>
  uniform float uFade;
  uniform float uAlphaScale;
  varying float vOpacity;
  float weatherDepthHash(vec2 point) {
    return fract(52.9829189 * fract(dot(point, vec2(0.06711056, 0.00583715))));
  }
  void main() {
    // Match transition coverage with a stable screen door instead of turning a
    // translucent fade into one opaque packed-depth plate. At FULL weight every
    // real flake/streak triangle owns its exact depth.
    float coverage = clamp(uFade * uAlphaScale * vOpacity, 0.0, 1.0);
    if (weatherDepthHash(gl_FragCoord.xy) > coverage) discard;
    gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
  }`;

function createPhysicalDepthMaterial(uniforms, vertexShader, name) {
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: PHYSICAL_DEPTH_FRAGMENT,
    depthTest: true,
    depthWrite: true,
    blending: THREE.NoBlending,
    side: THREE.DoubleSide,
  });
  material.allowOverride = false;
  material.name = name;
  return material;
}

// 강수 표현의 거리 종속 조정기. 오브젝트 스케일은 낙하 볼륨(±46m 박스)의 커버리지만 키우고
// 입자 치수에는 관여하지 않는다(정점 셰이더가 중심만 modelMatrix 로 옮기고 오프셋은 월드 공간에서
// 만든다). 그래서 부감에서 볼륨이 프레임을 덮어도 입자가 함께 부풀지 않는다.
function applyPresentation(object, uniforms, geometry, count, {
  boxScale = 1, lengthScale = null, density = 1,
} = {}) {
  const box = Number.isFinite(boxScale) && boxScale > 0 ? boxScale : 1;
  if (object.scale.x !== box) object.scale.setScalar(box);
  if (lengthScale != null && Number.isFinite(lengthScale) && uniforms.uLengthScale) {
    uniforms.uLengthScale.value = Math.max(1, lengthScale);
  }
  // 밀도는 그리는 인스턴스 비율로만 낸다. CPU state 는 전량 진행시켜(정지→재등장 팟 방지)
  // 원경 비용은 정점·프래그먼트에서만 줄인다.
  const drawn = Math.max(1, Math.round(count * Math.max(0, Math.min(1, density))));
  if (geometry.instanceCount !== drawn) geometry.instanceCount = drawn;
}

function physicalSnowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uTime: { value: 0 },
      // 1.3–3.2cm across for the product's 1.1–2.7 size range. Close flakes
      // grow by projection instead of a camera-facing pixel-size floor.
      uWorldScale: { value: 0.012 },
      // 화면 높이 대비 눈송이 지름 하한(≈1.4px @900px). 이 하한이 없으면 3cm 눈송이는
      // 30m만 가도 서브픽셀이 되어 강설이 소거된다. cap 은 폭주 방지용 절대 상한(m).
      uScreenSize: { value: 0.0032 },
      uScreenSizeCap: { value: 0.6 },
      uAlphaScale: { value: 0.72 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: PHYSICAL_SNOW_VERTEX,
    fragmentShader: `
      uniform float uFade;
      uniform float uAlphaScale;
      varying float vOpacity;
      void main() {
        float alpha = uAlphaScale * uFade * vOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(0.96, 0.985, 1.0, alpha);
      }`,
  });
}

export function createPhysicalSnowRepresentation(state) {
  const base = createCrossedFlakeGeometry();
  const geometry = copyBaseGeometry(base, state.count);
  base.dispose();
  const center = new THREE.InstancedBufferAttribute(state.positions, 3);
  geometry.setAttribute('aCenter', center);
  geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(state.sizes, 1));
  geometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(state.opacities, 1));
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(state.phases, 1));
  const material = physicalSnowMaterial();
  const depthMaterial = createPhysicalDepthMaterial(
    material.uniforms,
    PHYSICAL_SNOW_VERTEX,
    'weather-snow-physical-dof-depth',
  );
  const object = new THREE.Mesh(geometry, material);
  object.name = 'weatherSnowPhysical';
  object.frustumCulled = false;
  object.renderOrder = 20;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  return {
    kind: 'snow-physical',
    object,
    sourcePositions: state.positions,
    triangles: 6 * state.count,
    sync({ level = 1, time = 0 } = {}) {
      center.needsUpdate = true;
      material.uniforms.uFade.value = level;
      material.uniforms.uTime.value = time;
    },
    setPresentation(presentation) {
      applyPresentation(object, material.uniforms, geometry, state.count, presentation);
    },
    dispose: disposeRepresentation(object, geometry, material, depthMaterial),
  };
}

function physicalRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uLean: { value: new THREE.Vector2() },
      // An 8mm triangular volume is already a generous visual upper bound for rain.
      uRadius: { value: 0.004 },
      // 화면 높이 대비 빗줄기 폭 하한(≈0.8px @900px) — 실사진의 빗줄기와 같은 규약. 이보다 굵으면
      // 흰 막대로 읽히고, 낮은 알파와 함께 bloom 문턱을 넘어 번져 "흰 물감 자국"이 된다.
      uScreenWidth: { value: 0.0017 },
      uScreenWidthCap: { value: 0.5 },
      // 거리 종속 길이 배율(강수 전용 밴드가 소유). 폭은 위 화면 하한이 소유한다.
      uLengthScale: { value: 1 },
      // 비는 대기에 녹아드는 결(veil)로 읽혀야 한다 — 역광 하이라이트를 넘기지 않도록 낮게 둔다.
      uAlphaScale: { value: 0.15 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: PHYSICAL_RAIN_VERTEX,
    fragmentShader: `
      uniform float uFade;
      uniform float uAlphaScale;
      varying float vOpacity;
      void main() {
        float alpha = uAlphaScale * uFade * vOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(0.56, 0.63, 0.72, alpha);
      }`,
  });
}

export function createPhysicalRainRepresentation(state) {
  const base = new THREE.CylinderGeometry(1, 1, 1, 3, 1, false);
  const geometry = copyBaseGeometry(base, state.count);
  base.dispose();
  const center = new THREE.InstancedBufferAttribute(state.positions, 3);
  geometry.setAttribute('aCenter', center);
  geometry.setAttribute('aLength', new THREE.InstancedBufferAttribute(state.lengths, 1));
  geometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(state.opacities, 1));
  const material = physicalRainMaterial();
  const depthMaterial = createPhysicalDepthMaterial(
    material.uniforms,
    PHYSICAL_RAIN_VERTEX,
    'weather-rain-physical-dof-depth',
  );
  const object = new THREE.Mesh(geometry, material);
  object.name = 'weatherRainPhysical';
  object.frustumCulled = false;
  object.renderOrder = 21;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  return {
    kind: 'rain-physical',
    object,
    sourcePositions: state.positions,
    triangles: 12 * state.count,
    sync({ level = 1 } = {}) {
      center.needsUpdate = true;
      material.uniforms.uFade.value = level;
      material.uniforms.uLean.value.set(state.leanX, state.leanZ);
    },
    setPresentation(presentation) {
      applyPresentation(object, material.uniforms, geometry, state.count, presentation);
    },
    dispose: disposeRepresentation(object, geometry, material, depthMaterial),
  };
}

export function representationAttributeBytes(representation) {
  const geometry = representation.object.geometry;
  const arrays = new Set();
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    const array = attribute?.array;
    if (!array || arrays.has(array)) continue;
    arrays.add(array);
    bytes += array.byteLength;
  }
  if (geometry.index?.array && !arrays.has(geometry.index.array)) {
    bytes += geometry.index.array.byteLength;
  }
  return bytes;
}

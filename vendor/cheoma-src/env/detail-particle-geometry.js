import * as THREE from 'three';

// Reusable world-space detail particles. Simulation modules own each TypedArray
// once; render views only describe how WebGL reads those arrays.

function sharedInstanceAttribute(attribute) {
  const view = new THREE.InstancedBufferAttribute(
    attribute.array,
    attribute.itemSize,
    attribute.normalized,
  );
  view.setUsage(attribute.usage);
  return view;
}

function attributeBytes(attributes) {
  const arrays = new Set();
  let bytes = 0;
  for (const attribute of Object.values(attributes)) {
    if (!attribute?.array || arrays.has(attribute.array)) continue;
    arrays.add(attribute.array);
    bytes += attribute.array.byteLength;
  }
  return bytes;
}

function baseGeometryBytes(geometry) {
  let bytes = geometry.index?.array?.byteLength || 0;
  const arrays = new Set();
  for (const attribute of Object.values(geometry.attributes)) {
    if (!attribute?.array || attribute.isInstancedBufferAttribute || arrays.has(attribute.array)) continue;
    arrays.add(attribute.array);
    bytes += attribute.array.byteLength;
  }
  return bytes;
}

function bindOwnedDepthMaterial(material, depthMaterial) {
  const disposeColor = material.dispose.bind(material);
  let disposed = false;
  material.dispose = () => {
    if (disposed) return;
    disposed = true;
    depthMaterial.dispose();
    disposeColor();
  };
}

function ownedRepresentationDisposer(object, geometry, material) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    object.visible = false;
    object.removeFromParent();
    delete object.userData.dofDepthMaterial;
    geometry.dispose();
    // bindOwnedDepthMaterial makes the color material own depth teardown.
    material.dispose();
  };
}

export function createLeafSaddleGeometry() {
  // One normalized fan topology morphs between cherry petal, ginkgo fan, and
  // maple palmate silhouettes without adding a draw call.
  const petal = [
    [0, -0.5], [0.12, -0.43], [0.24, -0.28], [0.31, -0.06],
    [0.31, 0.16], [0.25, 0.35], [0.12, 0.5], [0, 0.41],
    [-0.12, 0.5], [-0.25, 0.35], [-0.31, 0.16], [-0.31, -0.06],
    [-0.24, -0.28], [-0.12, -0.43], [-0.04, -0.49], [0.04, -0.49],
  ];
  const ginkgo = [
    [0, -0.5], [0.06, -0.34], [0.18, -0.24], [0.34, -0.15],
    [0.47, 0.04], [0.48, 0.27], [0.35, 0.45], [0.12, 0.5],
    [0, 0.38], [-0.12, 0.5], [-0.35, 0.45], [-0.48, 0.27],
    [-0.47, 0.04], [-0.34, -0.15], [-0.18, -0.24], [-0.06, -0.34],
  ];
  const maple = [
    [0, -0.5], [0.05, -0.22], [0.24, -0.32], [0.16, -0.09],
    [0.45, 0.02], [0.21, 0.14], [0.33, 0.42], [0.08, 0.28],
    [0, 0.5], [-0.08, 0.28], [-0.33, 0.42], [-0.21, 0.14],
    [-0.45, 0.02], [-0.16, -0.09], [-0.24, -0.32], [-0.05, -0.22],
  ];
  const shape = (outline) => {
    const values = [0, 0, 0.075];
    for (let index = 0; index < outline.length; index++) {
      const [x, y] = outline[index];
      const z = (index % 2 ? 1 : -1) * 0.012 - x * x * 0.035 + y * y * 0.018;
      values.push(x, y, z);
    }
    return values;
  };
  const indices = [];
  for (let index = 0; index < petal.length; index++) {
    indices.push(0, index + 1, ((index + 1) % petal.length) + 1);
  }
  const vertexNormals = (positions) => {
    const values = new Float32Array(positions.length);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const edgeAB = new THREE.Vector3();
    const edgeAC = new THREE.Vector3();
    const face = new THREE.Vector3();
    for (let index = 0; index < indices.length; index += 3) {
      const ia = indices[index] * 3;
      const ib = indices[index + 1] * 3;
      const ic = indices[index + 2] * 3;
      a.fromArray(positions, ia);
      b.fromArray(positions, ib);
      c.fromArray(positions, ic);
      face.crossVectors(edgeAB.subVectors(b, a), edgeAC.subVectors(c, a));
      for (const offset of [ia, ib, ic]) {
        values[offset] += face.x;
        values[offset + 1] += face.y;
        values[offset + 2] += face.z;
      }
    }
    for (let offset = 0; offset < values.length; offset += 3) {
      a.fromArray(values, offset).normalize().toArray(values, offset);
    }
    return values;
  };
  const petalShape = shape(petal);
  const ginkgoShape = shape(ginkgo);
  const mapleShape = shape(maple);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(petalShape, 3));
  geometry.setAttribute('aGinkgoShape', new THREE.Float32BufferAttribute(ginkgoShape, 3));
  geometry.setAttribute('aMapleShape', new THREE.Float32BufferAttribute(mapleShape, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(vertexNormals(petalShape), 3));
  geometry.setAttribute('aGinkgoNormal', new THREE.Float32BufferAttribute(vertexNormals(ginkgoShape), 3));
  geometry.setAttribute('aMapleNormal', new THREE.Float32BufferAttribute(vertexNormals(mapleShape), 3));
  geometry.setIndex(indices);
  return geometry;
}

function makeOctahedronBaseGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    1, 0, 0, -1, 0, 0,
    0, 1, 0, 0, -1, 0,
    0, 0, 1, 0, 0, -1,
  ], 3));
  geometry.setIndex([
    0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0,
    0, 4, 3, 4, 1, 3, 1, 5, 3, 5, 0, 3,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

const ROTATE_GLSL = /* glsl */`
vec3 rotateXYZ(vec3 p, vec3 a) {
  vec3 s = sin(a), c = cos(a);
  p.yz = mat2(c.x, -s.x, s.x, c.x) * p.yz;
  p.xz = mat2(c.y, s.y, -s.y, c.y) * p.xz;
  p.xy = mat2(c.z, -s.z, s.z, c.z) * p.xy;
  return p;
}
`;

export const LEAF_SHAPE_GLSL = /* glsl */`
attribute vec3 aGinkgoShape;
attribute vec3 aMapleShape;
attribute vec3 aGinkgoNormal;
attribute vec3 aMapleNormal;
vec3 leafSpeciesShape(float species) {
  vec3 shape = mix(position, aGinkgoShape, step(0.5, species));
  return mix(shape, aMapleShape, step(1.5, species));
}
vec3 leafSpeciesNormal(float species) {
  vec3 shapeNormal = mix(normal, aGinkgoNormal, step(0.5, species));
  return normalize(mix(shapeNormal, aMapleNormal, step(1.5, species)));
}
`;

const PARTICLE_DEPTH_COVERAGE_GLSL = /* glsl */`
float detailDepthHash(vec2 point) {
  return fract(52.9829189 * fract(dot(point, vec2(0.06711056, 0.00583715))));
}
`;

const PETAL_VERTEX_STATE_GLSL = /* glsl */`
attribute vec3 aOffset;
attribute float aSize;
attribute vec3 aColor;
attribute float aRot;
attribute float aRotSpd;
attribute float aOpacity;
attribute float aSpecies;
attribute float aThresh;
uniform float uFade;
uniform float uTime;
uniform float uActive;
uniform float uWorldScale;
${ROTATE_GLSL}
${LEAF_SHAPE_GLSL}
void petalVertexState(
  out vec4 clipPosition,
  out vec3 worldNormal,
  out float visibleAlpha
) {
  float speed = abs(aRotSpd);
  vec3 angles = vec3(
    sin(uTime * (0.72 + speed * 0.13) + aRot * 1.7) * (0.52 + aSpecies * 0.11),
    aRot * 0.61 + uTime * aRotSpd * 0.23,
    aRot + uTime * aRotSpd
  );
  vec3 silhouette = leafSpeciesShape(aSpecies);
  float speciesScale = mix(0.48, 1.0, step(0.5, aSpecies));
  vec3 local = rotateXYZ(silhouette * (aSize * uWorldScale * speciesScale), angles);
  vec3 rotatedNormal = normalize(rotateXYZ(leafSpeciesNormal(aSpecies), angles));
  vec4 world = modelMatrix * vec4(aOffset + local, 1.0);
  clipPosition = projectionMatrix * viewMatrix * world;
  worldNormal = normalize(mat3(modelMatrix) * rotatedNormal);
  float gust = smoothstep(aThresh - 0.16, aThresh + 0.04, uActive);
  visibleAlpha = aOpacity * uFade * gust;
}
`;

export function createPetalWorldRepresentation(sourceGeometry, {
  renderOrder = 18,
  // aSize is an artistic scalar, not metres. Species scaling maps the current
  // ranges to ~1.9–4.0cm spring petals and ~13.7–28.8cm autumn leaves end-to-end
  // (autumn was raised 2.4× on 2026-07-25 by user direction — "make the silhouette
  // readable, slightly exaggerated". That lands on the real 오동·플라타너스 20~30cm
  // band rather than 단풍 ~10cm, so it is an exaggeration of species mix, not of botany.)
  worldScale = 0.03,
} = {}) {
  const geometry = createLeafSaddleGeometry();
  const source = sourceGeometry.attributes;
  geometry.setAttribute('aOffset', sharedInstanceAttribute(source.position));
  geometry.setAttribute('aSize', sharedInstanceAttribute(source.aSize));
  geometry.setAttribute('aColor', sharedInstanceAttribute(source.aColor));
  geometry.setAttribute('aRot', sharedInstanceAttribute(source.aRot));
  geometry.setAttribute('aRotSpd', sharedInstanceAttribute(source.aRotSpd));
  geometry.setAttribute('aOpacity', sharedInstanceAttribute(source.aOpacity));
  geometry.setAttribute('aSpecies', sharedInstanceAttribute(source.aSpecies));
  geometry.setAttribute('aThresh', sharedInstanceAttribute(source.aThresh));
  geometry.instanceCount = source.position.count;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uTime: { value: 0 },
      uActive: { value: 0 },
      uWorldScale: { value: worldScale },
      uLightDir: { value: new THREE.Vector3(-0.35, 0.82, 0.44).normalize() },
    },
    vertexShader: /* glsl */`
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vVisibleAlpha;
      ${PETAL_VERTEX_STATE_GLSL}
      void main() {
        vec4 clipPosition;
        petalVertexState(clipPosition, vNormal, vVisibleAlpha);
        gl_Position = clipPosition;
        vColor = aColor;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uLightDir;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vVisibleAlpha;
      ${PARTICLE_DEPTH_COVERAGE_GLSL}
      void main() {
        if (vVisibleAlpha < 0.02 || detailDepthHash(gl_FragCoord.xy) > vVisibleAlpha) discard;
        float wrap = 0.58 + 0.42 * max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
        gl_FragColor = vec4(vColor * wrap, 1.0);
      }`,
    side: THREE.DoubleSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });

  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uFade: material.uniforms.uFade,
      uTime: material.uniforms.uTime,
      uActive: material.uniforms.uActive,
      uWorldScale: material.uniforms.uWorldScale,
    },
    vertexShader: /* glsl */`
      varying float vVisibleAlpha;
      ${PETAL_VERTEX_STATE_GLSL}
      void main() {
        vec4 clipPosition;
        vec3 unusedNormal;
        petalVertexState(clipPosition, unusedNormal, vVisibleAlpha);
        gl_Position = clipPosition;
      }`,
    fragmentShader: /* glsl */`
      #include <packing>
      varying float vVisibleAlpha;
      ${PARTICLE_DEPTH_COVERAGE_GLSL}
      void main() {
        if (vVisibleAlpha < 0.02 || detailDepthHash(gl_FragCoord.xy) > vVisibleAlpha) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }`,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
  });
  depthMaterial.allowOverride = false;
  bindOwnedDepthMaterial(material, depthMaterial);

  const object = new THREE.Mesh(geometry, material);
  object.name = 'seasonPetalsWorld';
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  const seasonAttributes = [
    geometry.attributes.aColor,
    geometry.attributes.aSize,
    geometry.attributes.aRotSpd,
    geometry.attributes.aSpecies,
  ];

  const dispose = ownedRepresentationDisposer(object, geometry, material);
  return {
    object,
    material,
    geometry,
    syncPosition() {
      geometry.attributes.aOffset.needsUpdate = true;
    },
    syncSeasonAttributes() {
      for (const attribute of seasonAttributes) attribute.needsUpdate = true;
    },
    stats: {
      instances: geometry.instanceCount,
      triangles: geometry.instanceCount * 16,
      sharedCpuBytes: attributeBytes(source),
      baseGeometryBytes: baseGeometryBytes(geometry),
      colorPrograms: 1,
      dofDepthPrograms: 1,
    },
    sharesSourceArrays() {
      return geometry.attributes.aOffset.array === source.position.array
        && geometry.attributes.aSize.array === source.aSize.array
        && geometry.attributes.aRot.array === source.aRot.array;
    },
    dispose,
  };
}

const MOTE_VERTEX_STATE_GLSL = /* glsl */`
attribute vec3 aOffset;
attribute vec4 aRand;
uniform float uTime;
uniform float uIntensity;
uniform float uFirefly;
uniform vec3 uSunDir;
uniform float uDrift;
uniform vec3 uWindDir;
uniform float uWindSway;
uniform float uGust;
uniform float uNearA;
uniform float uNearB;
uniform float uLensScale;
uniform float uDustRadius;
uniform float uFireflyRadius;
${ROTATE_GLSL}
void moteVertexState(
  out vec4 clipPosition,
  out vec3 worldNormal,
  out vec3 viewDirection,
  out float visibleAlpha,
  out float firefly
) {
  vec3 p = aOffset;
  float ph = aRand.x;
  float fm = aRand.y;
  p.x += uDrift * sin(uTime * 0.50 * fm + ph);
  p.y += uDrift * 0.55 * sin(uTime * 0.37 * fm + ph * 1.7 + 1.3);
  p.z += uDrift * cos(uTime * 0.43 * fm + ph * 2.1);
  float windAmp = uWindSway * (0.35 + uGust);
  float ws = 0.5 + 0.5 * sin(uTime * 0.30 + ph);
  p.x += uWindDir.x * windAmp * ws;
  p.z += uWindDir.z * windAmp * ws;

  firefly = step(aRand.z, -0.0001);
  float radius = mix(uDustRadius, uFireflyRadius, firefly) * aRand.w;
  vec3 angles = vec3(
    ph + uTime * (0.31 + fm * 0.11),
    ph * 1.7 + uTime * 0.23,
    ph * 2.3 - uTime * 0.19
  );
  vec3 local = rotateXYZ(position * radius, angles);
  vec3 rotatedNormal = normalize(rotateXYZ(normal, angles));
  vec4 world = modelMatrix * vec4(p + local, 1.0);
  vec4 mv = viewMatrix * world;
  clipPosition = projectionMatrix * mv;
  viewDirection = normalize(world.xyz - cameraPosition);
  worldNormal = normalize(mat3(modelMatrix) * rotatedNormal);

  float visualDepth = -mv.z / max(uLensScale, 0.0001);
  float nearFade = smoothstep(uNearA, uNearB, visualDepth);
  float forward = max(dot(viewDirection, normalize(uSunDir)), 0.0);
  float shimmer = 0.12 + 0.88 * forward * forward * forward;
  float twinkle = 0.72 + 0.28 * sin(uTime * (1.7 + fm) + ph * 3.1);
  float dustAlpha = abs(aRand.z) * uIntensity * shimmer * twinkle * nearFade;
  float pulseBase = 0.5 + 0.5 * sin(uTime * (0.72 + fm * 0.31) + ph * 2.7);
  float pulse = pulseBase * pulseBase;
  pulse *= pulse * pulse * pulse;
  float fireflyAlpha = (0.18 + 0.82 * pulse) * 0.88 * nearFade * uFirefly;
  visibleAlpha = mix(dustAlpha, fireflyAlpha, firefly);
}
`;

export function createMoteWorldRepresentation(sourceGeometry, {
  renderOrder = 4,
  // Dust is a visible scattering clump; the firefly includes its luminous
  // envelope as a 2–3cm volume and lets optics, rather than geometry, make the
  // resulting bokeh large.
  dustRadius = 0.006,
  fireflyRadius = 0.014,
} = {}) {
  const geometry = makeOctahedronBaseGeometry();
  const source = sourceGeometry.attributes;
  geometry.setAttribute('aOffset', sharedInstanceAttribute(source.position));
  geometry.setAttribute('aRand', sharedInstanceAttribute(source.aRand));
  geometry.instanceCount = source.position.count;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uColor: { value: new THREE.Color(0xffdca8) },
      uFirefly: { value: 0 },
      uFireflyColor: { value: new THREE.Color(0xe8f58a) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDrift: { value: 0.75 },
      uWindDir: { value: new THREE.Vector3(1, 0, 0) },
      uWindSway: { value: 0.6 },
      uGust: { value: 0 },
      uNearA: { value: 3 },
      uNearB: { value: 9 },
      uLensScale: { value: 1 },
      uDustRadius: { value: dustRadius },
      uFireflyRadius: { value: fireflyRadius },
    },
    vertexShader: /* glsl */`
      varying float vVisibleAlpha;
      varying float vFirefly;
      varying float vFacing;
      ${MOTE_VERTEX_STATE_GLSL}
      void main() {
        vec4 clipPosition;
        vec3 worldNormal;
        vec3 viewDirection;
        moteVertexState(
          clipPosition, worldNormal, viewDirection, vVisibleAlpha, vFirefly
        );
        gl_Position = clipPosition;
        vFacing = 0.35 + 0.65 * abs(dot(worldNormal, -viewDirection));
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uColor;
      uniform vec3 uFireflyColor;
      varying float vVisibleAlpha;
      varying float vFirefly;
      varying float vFacing;
      void main() {
        if (vVisibleAlpha < 0.008) discard;
        // A compact HDR centre is a real world volume, allowing source-depth DoF
        // to form an aperture image without a camera-facing sprite.
        float emission = mix(1.0, 7.0, vFirefly);
        vec3 color = mix(uColor * vFacing, uFireflyColor * emission, vFirefly);
        gl_FragColor = vec4(color, min(vVisibleAlpha, 1.0));
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: material.uniforms.uTime,
      uIntensity: material.uniforms.uIntensity,
      uFirefly: material.uniforms.uFirefly,
      uSunDir: material.uniforms.uSunDir,
      uDrift: material.uniforms.uDrift,
      uWindDir: material.uniforms.uWindDir,
      uWindSway: material.uniforms.uWindSway,
      uGust: material.uniforms.uGust,
      uNearA: material.uniforms.uNearA,
      uNearB: material.uniforms.uNearB,
      uLensScale: material.uniforms.uLensScale,
      uDustRadius: material.uniforms.uDustRadius,
      uFireflyRadius: material.uniforms.uFireflyRadius,
    },
    vertexShader: /* glsl */`
      varying float vVisibleAlpha;
      ${MOTE_VERTEX_STATE_GLSL}
      void main() {
        vec4 clipPosition;
        vec3 unusedNormal;
        vec3 unusedViewDirection;
        float unusedFirefly;
        moteVertexState(
          clipPosition, unusedNormal, unusedViewDirection, vVisibleAlpha, unusedFirefly
        );
        gl_Position = clipPosition;
      }`,
    fragmentShader: /* glsl */`
      #include <packing>
      varying float vVisibleAlpha;
      ${PARTICLE_DEPTH_COVERAGE_GLSL}
      void main() {
        if (vVisibleAlpha < 0.008 || detailDepthHash(gl_FragCoord.xy) > vVisibleAlpha) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }`,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
  });
  depthMaterial.allowOverride = false;
  bindOwnedDepthMaterial(material, depthMaterial);

  const object = new THREE.Mesh(geometry, material);
  object.name = 'dustMotesWorld';
  object.renderOrder = renderOrder;
  object.frustumCulled = false;
  object.visible = false;
  object.userData.dofDepthMaterial = depthMaterial;

  const dispose = ownedRepresentationDisposer(object, geometry, material);
  return {
    object,
    material,
    geometry,
    stats: {
      instances: geometry.instanceCount,
      triangles: geometry.instanceCount * 8,
      sharedCpuBytes: attributeBytes(source),
      baseGeometryBytes: baseGeometryBytes(geometry),
      colorPrograms: 1,
      dofDepthPrograms: 1,
    },
    sharesSourceArrays() {
      return geometry.attributes.aOffset.array === source.position.array
        && geometry.attributes.aRand.array === source.aRand.array;
    },
    dispose,
  };
}

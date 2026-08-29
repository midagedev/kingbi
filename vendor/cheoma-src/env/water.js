import * as THREE from 'three';
import { makeRng } from '../rng.js';

// 물(개울) 레이어 + 공유 물 "재질감".
//   buildWater({ valley, heightAt, uniforms }) → { group, update(dt), covers(x,z), material }
//   createWaterUniforms() → 개울·논이 공유하는 uniform 다발(시간·하늘색·요동)
//   injectWaterLook(shader, u, { wet }) → MeshStandard 셰이더에 가짜 하늘 반사+흐름 요동 주입
//
// 구현 방침:
//  - envMap 없이 하늘빛으로 읽히게: fresnel(시선·법선) 기반으로 하늘색을 emissive 로 더한다
//    (grazing 각에서 밝은 하늘, 정면은 짙은 물색). 직사광 스펙큘러(roughness 낮음)가
//    태양 반짝임을 만들고, 흐름 방향으로 스크롤되는 미세 노멀 요동이 그 반짝임을 흐르게 한다.
//  - 논(paddies)의 봄 물댄 논도 같은 주입 헬퍼를 써 하늘 반영을 공유한다(uTime 공유).
//  - MeshStandardMaterial 이므로 weather.js 적설 traverse 가 색 프래그먼트를 뒤에 체이닝한다
//    (겨울엔 얼어붙은 듯 하얗게 덮임) — 충돌 없음.

export const WATER_SKY = 0xaecbe0;    // 반사되는 하늘색(옅은 청)

// 개울·논이 공유하는 uniform. update 로 uTime 한 번만 올리면 전부 반영.
//   uGlint: 태양(낮)·달빛(밤) 반짝임의 색×강도(vec3, 선형). setTime 이 시간대별로 갈아끼운다.
export function createWaterUniforms() {
  return {
    uTime: { value: 0 },
    uSky: { value: new THREE.Color().setHex(WATER_SKY, THREE.SRGBColorSpace) },
    uRipple: { value: 1.0 },
    uFlow: { value: new THREE.Vector2(-1, 0.12) },  // 개울 흐름 방향(월드 xz)
    uGlint: { value: new THREE.Vector3(0.9, 0.78, 0.5) }, // 기본 낮 햇살 글린트
    // 시간대별 거칠기 가산(0..1). 0=기본(낮·단일 씬 불변). 야간·석양 부감에서 저각 광원
    // (달빛·석양)이 저거칠기 수면에 날카로운 스펙큘러 리본을 만들어 bloom 을 타므로, 마을
    // 라우팅(setVillageWaterTime)에서만 이 값을 올려 그 하이라이트를 넓고 은은한 시트로
    // 퍼뜨린다(peak 를 bloom 임계 아래로). 단일 씬 env 물은 setTime 이 건드리지 않아 0 유지.
    uRough: { value: 0 },
  };
}

// 시간대별 물 글린트(색×강도, 선형). 낮=따뜻한 햇살, 석양=저각 금빛, 밤=성긴 은빛 달빛.
// 은은함이 원칙(수묵) — 값이 곧 additive emissive 크기라 작게 유지한다. 야간·석양은 강하면
// bloom(night threshold 0.32)에 흰 리본으로 피어오르므로(참조: ambient-water-night) 눌러둔다.
const WATER_GLINT = {
  dawn: new THREE.Vector3(0.44, 0.42, 0.36),
  day: new THREE.Vector3(0.85, 0.74, 0.48),
  sunset: new THREE.Vector3(0.60, 0.40, 0.22),   // 금빛(시안 아님)
  night: new THREE.Vector3(0.20, 0.25, 0.36),    // 성긴 은빛 달빛 (U2 weak ribbon)
};
// 시간대별 하늘반사 색(프레넬 emissive). 이 항이 시간대 무연동이면 밤·석양의 어두운 씬에서도
// 낮 밝기(시안)로 남아 흰 띠가 된다 → 낮은 WATER_SKY 유지, 야간=어두운 달빛 청, 석양=따뜻한
// 저채도로 하향해 반사가 씬에 가라앉게 한다(마을 개울 populate.js 와 동일 톤).
const WATER_SKY_TIME = {
  dawn: 0x7a8496,
  day: WATER_SKY,
  sunset: 0x7a5f48,
  night: 0x2c3c54,
};

// MeshStandard 셰이더에 물 표면감을 주입한다. wet 이 문자열이면 그 이름의 varying/uniform
// (0..1)으로 강도를 게이트한다(논: 봄에만 물). 없으면 항상 물(개울).
export function injectWaterLook(shader, u, {
  wet = null,
  reflection = 1,
  ripple = 1,
} = {}) {
  shader.uniforms.uTime = u.uTime;
  shader.uniforms.uSky = u.uSky;
  shader.uniforms.uRipple = u.uRipple;
  shader.uniforms.uFlow = u.uFlow;
  shader.uniforms.uGlint = u.uGlint;
  shader.uniforms.uRough = u.uRough;
  shader.uniforms.uWaterReflection = { value: reflection };
  shader.uniforms.uWaterRippleScale = { value: ripple };

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWP;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');

  const wetExpr = wet ? wet : '1.0';
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform float uTime;
      uniform vec3 uSky;
      uniform float uRipple;
      uniform vec2 uFlow;
      uniform vec3 uGlint;
      uniform float uRough;
      uniform float uWaterReflection;
      uniform float uWaterRippleScale;
      varying vec3 vWaterWP;`)
    // 시간대 거칠기 가산: 저각 광원 스펙큘러의 뾰족한 peak 를 낮춰 bloom 임계 아래로.
    // wetK 로 게이트(논: 봄에만 물). uRough=0 이면 완전 무연산(기본 룩 불변).
    // 상한만 min 으로(하한 clamp 없음) → uRough=0 이면 roughnessFactor 그대로(항상 ≤1)라
    // 강우 wet 감쇠 등 어떤 상태에서도 완전 무연산. uRough>0 일 때만 거칠기를 더한다.
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = min(roughnessFactor + uRough * clamp(${wetExpr}, 0.0, 1.0), 1.0);`)
    // 노멀 요동: 흐름 방향으로 스크롤되는 잔물결(스펙큘러 반짝임을 흐르게)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        float wetK = clamp(${wetExpr}, 0.0, 1.0);
        vec2 fd = normalize(uFlow + 1e-4);
        vec2 pw = vWaterWP.xz;
        float a = sin(dot(pw, fd) * 1.7 - uTime * 1.4);
        float b = sin(dot(pw, vec2(-fd.y, fd.x)) * 2.6 + uTime * 0.85);
        float c = sin(dot(pw, fd) * 4.3 - uTime * 2.3) * 0.4;
        vec3 dn = vec3(a * 0.09 + c, 0.0, b * 0.09 - c * 0.6)
          * uRipple * uWaterRippleScale * wetK;
        normal = normalize(normal + dn);
      }`)
    // 가짜 하늘 반사: fresnel 로 하늘색을 더한다(envMap 대체) + 태양/달빛 글린트 스파클.
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        float wetK = clamp(${wetExpr}, 0.0, 1.0);
        vec3 V = normalize(vViewPosition);
        float fres = pow(clamp(1.0 - abs(dot(normalize(normal), V)), 0.0, 1.0), 2.4);
        totalEmissiveRadiance += uSky * (0.10 + 0.85 * fres) * uWaterReflection * wetK;
        // 글린트: 흐름 따라 흐르는 교차 고주파 → 성기고 뾰족한 하이라이트만(수묵 감성).
        // grazing(fres)으로 게이트해 은은하게 얹는다.
        vec2 gp = vWaterWP.xz;
        float g1 = sin(dot(gp, vec2(1.9, -1.3)) + uTime * 1.7);
        float g2 = sin(dot(gp, vec2(-1.1, 2.3)) - uTime * 1.05);
        float spark = pow(clamp(g1 * g2, 0.0, 1.0), 8.0);
        totalEmissiveRadiance += uGlint * spark * (0.35 + 0.65 * fres)
          * uWaterReflection * wetK;
      }`);
}

// 저폴리 둥근 돌 프로토(약간 눌린 정이십면체)
function pebbleGeo(rng) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  g.scale(rng.range(0.8, 1.3), rng.range(0.4, 0.7), rng.range(0.8, 1.3));
  return g;
}

export function buildWater({ valley, heightAt, uniforms, seed = 33113 }) {
  const group = new THREE.Group();
  group.name = 'water';
  const rng = makeRng(seed);
  const u = uniforms || createWaterUniforms();

  // ---------- 개울 중심선 폴리라인 ----------
  // 수면 y 는 실제 카브된 채널 바닥(heightAt) 바로 위에 앉힌다(이상적 floorY 가 아니라 →
  // 파묻힘 방지). 채널 중심이 가장 낮으므로 물이 자연스럽게 담긴다.
  const xHead = -34;                       // 마을 옆(상류) — 게이트가 올라오는 지점
  const xTail = valley.xEnd + 10;          // 하류 끝(원경 직전)
  const N = 96;
  const line = [];
  for (let i = 0; i <= N; i++) {
    const x = xHead + (xTail - xHead) * (i / N);
    const cz = valley.centerZ(x);
    line.push({ x, z: cz, y: heightAt(x, cz) + 0.1 });
  }
  const streamHalf = (x) => 1.0 + 0.5 * valley.tWide(x);   // 반폭 1.0→1.5 (폭 2.0~3.0m)

  // ---------- 리본 지오메트리 ----------
  const pos = [];
  const idx = [];
  const uvs = [];
  const tmpT = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const p = line[i];
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(N, i + 1)];
    tmpT.set(b.x - a.x, 0, b.z - a.z).normalize();       // 접선(xz)
    const nx = -tmpT.z, nz = tmpT.x;                     // 좌우 법선
    const hw = streamHalf(p.x);
    pos.push(p.x + nx * hw, p.y, p.z + nz * hw);         // 좌
    pos.push(p.x - nx * hw, p.y, p.z - nz * hw);         // 우
    uvs.push(0, i / N * 8, 1, i / N * 8);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x35566a, metalness: 0.35, roughness: 0.17,
  });
  material.onBeforeCompile = (shader) => injectWaterLook(shader, u);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'stream';
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  group.add(mesh);

  // ---------- 개울가 돌 무리 (InstancedMesh) ----------
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x8b8478, roughness: 0.96, metalness: 0, flatShading: true,
  });
  const stoneMats = [];
  const M4 = () => new THREE.Matrix4();
  // 물가에 바짝 붙는 작은 돌 몇 무리 — 물이 주역, 돌은 액센트(트레일처럼 안 읽히게).
  for (let i = 6; i < N - 4; i += 4) {
    if (rng() > 0.5) continue;
    const p = line[i];
    const a = line[i - 1], b = line[i + 1];
    tmpT.set(b.x - a.x, 0, b.z - a.z).normalize();
    const nx = -tmpT.z, nz = tmpT.x;
    const hw = streamHalf(p.x);
    const side = rng() < 0.5 ? 1 : -1;
    const cluster = rng.int(1, 2);
    for (let k = 0; k < cluster; k++) {
      const off = hw + rng.range(-0.1, 0.4);       // 물가에 바짝
      const jx = rng.range(-0.3, 0.3), jz = rng.range(-0.3, 0.3);
      const sx = p.x + nx * off * side + jx;
      const sz = p.z + nz * off * side + jz;
      const sy = heightAt(sx, sz);
      const s = rng.range(0.22, 0.44);
      const m = M4().makeTranslation(sx, sy + s * 0.15, sz);
      m.multiply(M4().makeRotationY(rng.range(0, 6.28)));
      m.multiply(M4().makeScale(s, s, s));
      stoneMats.push(m);
    }
  }
  if (stoneMats.length) {
    const inst = new THREE.InstancedMesh(pebbleGeo(rng), stoneMat, stoneMats.length);
    inst.name = 'streamStones';
    stoneMats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    group.add(inst);
  }

  // ---------- 징검다리 (마을 쪽 교차점, 폭 가로질러 1열) ----------
  // 마을에 가장 가까운 상류 지점에서 개울을 가로지르는 판석 열.
  const cross = line[6];
  const ca = line[5], cb = line[7];
  tmpT.set(cb.x - ca.x, 0, cb.z - ca.z).normalize();
  const cnx = -tmpT.z, cnz = tmpT.x;
  const slabMat = new THREE.MeshStandardMaterial({
    color: 0x9a938a, roughness: 0.9, metalness: 0, flatShading: true,
  });
  const chw = streamHalf(cross.x);
  const waterYcross = cross.y;                         // 개울 수면 높이(교차점)
  const slabMats = [];
  const nSlab = 5;
  for (let s = 0; s < nSlab; s++) {
    const t = (s / (nSlab - 1) - 0.5) * 2;            // -1..1
    const off = t * (chw + 0.5);
    const sx = cross.x + cnx * off + rng.range(-0.1, 0.1);
    const sz = cross.z + cnz * off + rng.range(-0.1, 0.1);
    const sy = waterYcross + 0.16;                     // 수면 위로 살짝 솟게
    const m = M4().makeTranslation(sx, sy, sz);
    m.multiply(M4().makeRotationY(Math.atan2(cnz, cnx) + rng.range(-0.12, 0.12)));
    m.multiply(M4().makeScale(rng.range(0.85, 1.1), 1, rng.range(0.7, 0.95)));
    slabMats.push(m);
  }
  const slabGeo = new THREE.BoxGeometry(0.85, 0.22, 0.62);
  const slabInst = new THREE.InstancedMesh(slabGeo, slabMat, slabMats.length);
  slabInst.name = 'steppingStones';
  slabMats.forEach((m, i) => slabInst.setMatrixAt(i, m));
  slabInst.instanceMatrix.needsUpdate = true;
  slabInst.castShadow = true; slabInst.receiveShadow = true;
  group.add(slabInst);

  // 시간대 색 크로스페이드 목표(글린트·하늘반사). setTime 이 목표만 세팅하고 update 가 지수 접근.
  const glintTarget = new THREE.Vector3().copy(u.uGlint.value);
  const skyTarget = new THREE.Color().copy(u.uSky.value);
  const TIME_RATE = 2.4;   // ≈1.6s 안에 시간대 물색 전환(sky 크로스페이드와 결이 맞게)

  function update(dt) {
    u.uTime.value += dt;
    const k = Math.min(1, dt * TIME_RATE);
    u.uGlint.value.lerp(glintTarget, k);
    u.uSky.value.lerp(skyTarget, k);
  }

  // 시간대별 글린트 색·강도 + 하늘반사 색(개울·논 물면 공유). sky 시간대 전환과 함께 호출된다.
  //   opts.immediate=true(shot·초기 로드) 면 즉시, 아니면 update 에서 크로스페이드.
  function setTime(name, opts = {}) {
    const g = WATER_GLINT[name] || WATER_GLINT.day;
    glintTarget.copy(g);
    const skyHex = (name in WATER_SKY_TIME) ? WATER_SKY_TIME[name] : WATER_SKY;
    skyTarget.setHex(skyHex, THREE.SRGBColorSpace);
    if (opts.immediate) { u.uGlint.value.copy(glintTarget); u.uSky.value.copy(skyTarget); }
  }

  // 나무 배치 제외 마스크: 개울 폭 + 여유
  function covers(x, z) {
    if (x > xHead + 1 || x < xTail - 1) return false;
    const cz = valley.centerZ(x);
    return Math.abs(z - cz) < streamHalf(x) + 1.6;
  }

  return {
    group, update, setTime, covers, material, uniforms: u,
    // 징검다리 교차점(cross)의 월드 좌표 — 위치성 물소리 앵커. env group 은 원점이라
    // local == world. 수면 위로 살짝 올려 청감상 물가에 앉힌다.
    get anchor() { return new THREE.Vector3(cross.x, cross.y + 0.25, cross.z); },
  };
}

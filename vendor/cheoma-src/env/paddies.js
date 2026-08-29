import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { injectWaterLook, createWaterUniforms } from './water.js';

// 다랑이 논 — 계곡 +z 사면에 계단식 논(heightfield). 논둑을 z-종속 물결로 굽혀
// 등고선을 따르는 유기적 곡선으로 만든다(직선 격자 금지).
//   buildPaddies({ valley, heightAt, waterUniforms }) →
//     { group, update(dt), setSeason(name), covers(x,z) }
//
// 계절(자체 보간, seasons.js 가 setSeason/update 를 전파):
//   spring: 물댄 논 — water.js 하늘 반사 공유(uWet) + 옅은 모내기 점열
//   summer: 짙은 초록 벼(이랑 줄무늬)
//   autumn: 황금 들판(누런 + 살짝 붉은 기)
//   winter: 물 빠진 휴경 논. snow 날씨가 오면 공통 적설 셰이더가 그 위를 덮음.

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 계절별 목표: 논면색·논둑색·이랑강도·물강도·붉은기
const TARGET = {
  spring: { field: 0x74804a, bund: 0x84924f, furrow: 0.18, wet: 1.0, red: 0.0 },
  summer: { field: 0x4d7a2c, bund: 0x6f7b40, furrow: 0.60, wet: 0.0, red: 0.0 },
  autumn: { field: 0xc8a338, bund: 0x9c8b4e, furrow: 0.50, wet: 0.0, red: 0.5 },
  winter: { field: 0x82765f, bund: 0x766c57, furrow: 0.24, wet: 0.0, red: 0.0 },
};

export function buildPaddies({ valley, heightAt, waterUniforms }) {
  const group = new THREE.Group();
  group.name = 'paddies';
  const waterU = waterUniforms || createWaterUniforms();

  // ---------- 영역 ----------
  const xHi = -40, xLo = -104;         // 상류(높음)→하류(낮음)
  const zInner = 2.2;                  // 개울(중심선)에서 안쪽 여백 — 논이 개울을 안 침범
  const bandW = 11;                    // +z 사면 하단(낮고 넓은 계단 앞치마) — 둔덕화 방지
  const NT = 5;                        // 계단 수 — 넓은 논면 위해 적게(골판지화 방지)
  const margin = 0.1;                  // 지형 위로 살짝 띄워 지형 뚫림 방지
  const NX = 150, NZ = 44;

  // 논둑 곡선(등고선) 물결 — 격자 금지의 핵심. 계단 경계를 z에 따라 굽힌다.
  const wobble = (x, z) => 0.4 * Math.sin(z * 0.14 + x * 0.045) + 0.2 * Math.sin(z * 0.31 - x * 0.02);

  const pos = [], rice = [];
  const idx = [];
  const stride = NZ + 1;
  for (let i = 0; i <= NX; i++) {
    const x = xHi + (xLo - xHi) * (i / NX);
    const cz = valley.centerZ(x);
    const zb0 = cz + zInner;
    // 계단별 평탄 표고: 각 단의 사면 위(uphill) 경계에서 지형을 샘플 → 그 위에 평평히 앉힘.
    // 지형은 uphill 로 갈수록 높으므로, 이 표고면 단 전체가 지형 위(fill)에 놓여 뚫림이 없다.
    const lev = [];
    for (let k = 0; k < NT; k++) lev[k] = heightAt(x, zb0 + bandW * ((k + 1) / NT)) + margin;
    for (let j = 0; j <= NZ; j++) {
      const jt = j / NZ;                               // 0 개울쪽(낮음) .. 1 사면 위(높음)
      const z = zb0 + bandW * jt;
      const p = jt * NT + wobble(x, z);
      let k = Math.floor(p);
      k = Math.min(NT - 1, Math.max(0, k));
      const f = Math.min(1, Math.max(0, p - k));       // 단 내 위치(0 하류엣지..1 사면위엣지)
      // 논둑: 하류(낮은 jt) 엣지에 낮고 얇은 흙둑(물을 가둠) + 안/바깥 테두리
      const bundDown = smoothstep(0.10, 0.015, f);
      const rimOuter = smoothstep(0.92, 1.0, jt);
      const rimInner = smoothstep(0.08, 0.0, jt);
      const lip = 0.20 * bundDown + 0.13 * (rimOuter + rimInner);
      const y = lev[k] + lip;
      // aRice: 넓은 평탄 논면 1 / 얇은 논둑·테두리 0(풀)
      const bundWide = smoothstep(0.14, 0.04, f) + rimOuter + rimInner;
      const r = 1 - Math.min(1, bundWide);
      pos.push(x, y, z);
      rice.push(r);
    }
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NZ; j++) {
      const v00 = i * stride + j, v10 = (i + 1) * stride + j;
      const v01 = i * stride + j + 1, v11 = (i + 1) * stride + j + 1;
      idx.push(v00, v10, v01, v10, v11, v01);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aRice', new THREE.Float32BufferAttribute(rice, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // ---------- 재질 (계절 uniform + 물 하늘 반사 공유) ----------
  const uField = { value: new THREE.Color().setHex(TARGET.summer.field, THREE.SRGBColorSpace) };
  const uBund = { value: new THREE.Color().setHex(TARGET.summer.bund, THREE.SRGBColorSpace) };
  const uFurrow = { value: TARGET.summer.furrow };
  const uWet = { value: TARGET.summer.wet };
  const uRed = { value: TARGET.summer.red };

  // DoubleSide: 계단 벽(riser) 면이 컬링돼 구멍이 나는 것 방지.
  const material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uField = uField;
    shader.uniforms.uBund = uBund;
    shader.uniforms.uFurrow = uFurrow;
    shader.uniforms.uWet = uWet;
    shader.uniforms.uRed = uRed;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRice;\nvarying float vRice;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRice = aRice;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uField;
        uniform vec3 uBund;
        uniform float uFurrow;
        uniform float uWet;
        uniform float uRed;
        varying float vRice;`)
      // 젖은 논면은 roughness/metalness 를 살짝 낮춰 잔잔한 물빛(과한 거울 반짝임은 피함)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, uWet * vRice);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.12, uWet * vRice);')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 base = mix(uBund, uField, vRice);
          // 이랑 줄무늬(벼 심긴 결) — 논면에만
          float rows = 0.5 + 0.5 * sin(vWaterWP.x * 3.3 + vWaterWP.z * 0.7);
          base *= (1.0 - uFurrow * 0.30 * vRice) + uFurrow * 0.30 * vRice * rows;
          // 가을: 이랑 골에 살짝 붉은 기
          base = mix(base, base * vec3(1.18, 0.82, 0.6), uRed * (1.0 - rows) * vRice * 0.5);
          // 봄: 물댄 논 — 논면을 물빛(어두운 청록)으로 무르익힘(그 위에 하늘 반사가 얹힘)
          base = mix(base, vec3(0.15, 0.21, 0.23), uWet * vRice * 0.6);
          // 옅은 모내기 점열
          float dots = step(0.82, (0.5 + 0.5 * sin(vWaterWP.x * 6.5)) * (0.5 + 0.5 * sin(vWaterWP.z * 6.5)));
          base = mix(base, vec3(0.32, 0.5, 0.24), uWet * vRice * dots * 0.6);
          diffuseColor.rgb = base;
        }`);
    // 물 하늘 반사(봄 물댄 논): uWet*vRice 로 게이트 — vWaterWP 도 여기서 선언됨
    injectWaterLook(shader, waterU, { wet: 'vRice * uWet' });
  };

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'paddyField';
  mesh.receiveShadow = true;
  group.add(mesh);

  // ---------- 계절 상태(자체 보간) ----------
  const cur = {
    field: uField.value.clone(), bund: uBund.value.clone(),
    furrow: uFurrow.value, wet: uWet.value, red: uRed.value,
  };
  const goal = { ...TARGET.summer };
  const goalField = new THREE.Color().setHex(goal.field, THREE.SRGBColorSpace);
  const goalBund = new THREE.Color().setHex(goal.bund, THREE.SRGBColorSpace);
  const RATE = 2.4;

  function setSeason(name) {
    const t = TARGET[name] || TARGET.summer;
    goalField.setHex(t.field, THREE.SRGBColorSpace);
    goalBund.setHex(t.bund, THREE.SRGBColorSpace);
    goal.furrow = t.furrow; goal.wet = t.wet; goal.red = t.red;
  }
  function applyImmediate(name) {
    const t = TARGET[name] || TARGET.summer;
    uField.value.setHex(t.field, THREE.SRGBColorSpace);
    uBund.value.setHex(t.bund, THREE.SRGBColorSpace);
    uFurrow.value = t.furrow; uWet.value = t.wet; uRed.value = t.red;
    goalField.copy(uField.value); goalBund.copy(uBund.value);
    goal.furrow = t.furrow; goal.wet = t.wet; goal.red = t.red;
  }
  function update(dt) {
    const k = Math.min(1, dt * RATE);
    uField.value.lerp(goalField, k);
    uBund.value.lerp(goalBund, k);
    uFurrow.value += (goal.furrow - uFurrow.value) * k;
    uWet.value += (goal.wet - uWet.value) * k;
    uRed.value += (goal.red - uRed.value) * k;
  }

  // 나무 배치 제외 마스크: 논 영역(약간의 여유 포함)
  function covers(x, z) {
    if (x > xHi + 2 || x < xLo - 2) return false;
    const cz = valley.centerZ(x);
    const dz = z - cz;
    return dz > zInner - 2 && dz < zInner + bandW + 2;
  }

  return { group, update, setSeason, applyImmediate, covers, material };
}

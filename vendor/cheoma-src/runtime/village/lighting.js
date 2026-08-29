import * as THREE from 'three';
import { TIME_PRESETS } from '../../env/sky.js';

// 마을 부감에서 배산 북사면과 처마 밑이 순흑으로 뭉개지지 않게 하는 전용 보조광.
// scene의 주 태양·hemi·post 값은 건드리지 않고, 마을 모드 수명 동안 rig 자체를 add/remove한다.
export const VILLAGE_LIGHT_BY_TIME = {
  dawn: {
    hemiSky: 0xb9c2da, hemiGround: 0x86745c, hemiInt: 0.62,
    fillColor: 0xffcda0, fillInt: 0.85, fillElev: 0.34, glowBoost: 1.0,
  },
  day: {
    hemiSky: 0xbcd4ec, hemiGround: 0x8a7a63, hemiInt: 0.22,
    fillColor: 0xfff0e0, fillInt: 0.18, fillElev: 0.4, glowBoost: 1.0,
  },
  sunset: {
    // 쿨한 상부광은 유지하고 웜 바운스와 fill을 낮춰 큰 능선의 주황 blowout을 막는다.
    hemiSky: 0x9fb0d6, hemiGround: 0x2a241e, hemiInt: 0.54,
    fillColor: 0xecc09c, fillInt: 0.62, fillElev: 0.42, glowBoost: 1.0,
  },
  // #150-H: retune only the existing village hemi + anti-solar fill (no new lights).
  // Cooler moon fill models wall/column depth under eaves; glowBoost still scales hanji only.
  night: {
    hemiSky: 0x42567a, hemiGround: 0x1e2838, hemiInt: 0.50,
    fillColor: 0xb0c4e6, fillInt: 0.38, fillElev: 0.42, glowBoost: 1.5,
  },
};

export function createVillageLightRig() {
  const rig = new THREE.Group();
  rig.name = 'village-lights';

  const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 0);
  const fill = new THREE.DirectionalLight(0xffffff, 0);
  fill.castShadow = false;
  rig.add(hemi, fill, fill.target);

  const rate = 2.4;
  const targetHemiSky = new THREE.Color();
  const targetHemiGround = new THREE.Color();
  const targetFillColor = new THREE.Color();
  const currentDirection = new THREE.Vector3(1, 0.4, 1).normalize();
  const targetDirection = new THREE.Vector3(1, 0.4, 1).normalize();
  const position = new THREE.Vector3();
  let targetHemiIntensity = 0;
  let targetFillIntensity = 0;
  let warmScale = 1;

  function setSiteRadius(radius) {
    const siteRadius = typeof radius === 'number' && radius > 0 ? radius : 150;
    const scaleT = Math.min(1, Math.max(0, (siteRadius - 170) / (300 - 170)));
    warmScale = Math.max(0.3, 1 - scaleT * 0.6);
  }

  function setTarget(name) {
    const preset = VILLAGE_LIGHT_BY_TIME[name] || VILLAGE_LIGHT_BY_TIME.day;
    targetHemiSky.setHex(preset.hemiSky);
    targetHemiGround.setHex(preset.hemiGround);
    targetHemiIntensity = preset.hemiInt;
    targetFillColor.setHex(preset.fillColor);
    targetFillIntensity = preset.fillInt;
    if (name === 'sunset' || name === 'dawn') {
      targetHemiIntensity *= warmScale;
      targetFillIntensity *= warmScale;
    }

    const sun = (TIME_PRESETS[name] || TIME_PRESETS.day).sunDir;
    const horizontal = Math.hypot(sun[0], sun[2]) || 1;
    targetDirection.set(-sun[0], horizontal * preset.fillElev, -sun[2]).normalize();
  }

  function placeFill() {
    position.copy(currentDirection).multiplyScalar(200);
    fill.position.copy(position);
    fill.target.position.set(0, 0, 0);
    fill.target.updateMatrixWorld();
  }

  function apply(name, { immediate = false } = {}) {
    setTarget(name);
    if (!immediate) return;
    hemi.color.copy(targetHemiSky);
    hemi.groundColor.copy(targetHemiGround);
    hemi.intensity = targetHemiIntensity;
    fill.color.copy(targetFillColor);
    fill.intensity = targetFillIntensity;
    currentDirection.copy(targetDirection);
    placeFill();
  }

  function update(dt) {
    const amount = Math.min(1, dt * rate);
    hemi.color.lerp(targetHemiSky, amount);
    hemi.groundColor.lerp(targetHemiGround, amount);
    hemi.intensity += (targetHemiIntensity - hemi.intensity) * amount;
    fill.color.lerp(targetFillColor, amount);
    fill.intensity += (targetFillIntensity - fill.intensity) * amount;
    currentDirection.lerp(targetDirection, amount).normalize();
    placeFill();
  }

  return {
    rig,
    apply,
    update,
    setSiteRadius,
    dispose() {
      hemi.dispose();
      fill.dispose();
    },
  };
}

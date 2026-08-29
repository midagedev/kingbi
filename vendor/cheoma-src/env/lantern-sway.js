import * as THREE from 'three';
import { getWind } from './wind.js';
import { makePresenceGate } from './present-gate.js';

// Choma lantern pendulum motion. The detector intentionally stays independent
// of bulb color so product and focus-overlay lanterns share one implementation.
export function setupLanternSway({ scene, getBuilding = null, scope = null }) {
  let enabled = false;
  let t = 0;
  let detected = false;
  let lanterns = [];
  const gate = getBuilding ? makePresenceGate({ delay: 1.2, up: 1.6, down: 0.4 }) : null;
  let lastBld = null;

  const HANG = 0.4;
  const BASE_AMP = 0.030;
  const position = new THREE.Vector3();

  function detect() {
    const root = (typeof scope === 'function' ? scope() : scope)
      || scene.getObjectByName('environment');
    if (!root) return false;
    const lights = [];
    const bulbs = [];
    for (const object of root.children) {
      if (object.isPointLight) lights.push(object);
      else if (object.isMesh && object.geometry?.type === 'SphereGeometry'
        && object.geometry.parameters?.radius < 0.5) bulbs.push(object);
    }
    if (!bulbs.length) return false;
    lanterns = bulbs.map((bulb, index) => {
      let light = null;
      let best = Infinity;
      for (const candidate of lights) {
        const distance = candidate.position.distanceToSquared(bulb.position);
        if (distance < best) { best = distance; light = candidate; }
      }
      return {
        bulb,
        light: best < 0.01 ? light : null,
        base: bulb.position.clone(),
        phX: index * 1.7,
        phZ: index * 2.3 + 0.9,
        w1: 0.9 + index * 0.07,
        w2: 1.43 + index * 0.05,
        w3: 0.83 + index * 0.06,
        w4: 1.27 + index * 0.04,
      };
    });
    return true;
  }

  function update(dt) {
    if (!enabled) return;
    if (!detected) { detected = detect(); if (!detected) return; }
    let presence = 1;
    if (gate) {
      const building = getBuilding();
      const reset = building !== lastBld;
      lastBld = building;
      presence = gate.update(dt, { present: !!building?.visible, reset });
      if (presence < 0.999) {
        for (const lantern of lanterns) {
          lantern.bulb.visible = lantern.bulb.visible && presence > 0.04;
          if (lantern.light) lantern.light.intensity *= presence;
        }
      }
    }

    t += dt;
    const wind = getWind(t);
    const gustAmp = 1 + wind.gust * 1.6;
    const lean = wind.speed * 0.010;
    for (const lantern of lanterns) {
      let ax = BASE_AMP * (
        0.6 * Math.sin(t * lantern.w1 + lantern.phX)
        + 0.4 * Math.sin(t * lantern.w2 + lantern.phX * 1.7)
      );
      let az = BASE_AMP * (
        0.6 * Math.sin(t * lantern.w3 + lantern.phZ)
        + 0.4 * Math.sin(t * lantern.w4 + lantern.phZ * 1.3)
      );
      ax = ax * gustAmp + wind.dirX * lean;
      az = az * gustAmp + wind.dirZ * lean;
      const dx = HANG * Math.sin(ax);
      const dz = HANG * Math.sin(az);
      const dy = HANG * ((1 - Math.cos(ax)) + (1 - Math.cos(az))) * 0.5;
      position.set(
        lantern.base.x + dx,
        lantern.base.y + dy,
        lantern.base.z + dz,
      );
      lantern.bulb.position.copy(position);
      if (lantern.light) lantern.light.position.copy(position);
    }
  }

  function setEnabled(value) {
    enabled = !!value;
    if (enabled) return;
    for (const lantern of lanterns) {
      lantern.bulb.position.copy(lantern.base);
      if (lantern.light) lantern.light.position.copy(lantern.base);
    }
  }

  return { update, setEnabled };
}

import {
  patchSnowMaterial,
  snowProfileForObject,
  SNOW_ACCUMULATE_SECONDS,
  SNOW_AMOUNT_MAX,
  SNOW_MELT_SECONDS,
} from '../../env/snow-material.js';

export function createVillageSnowController(villageGroup) {
  const amountUniform = { value: 0 };
  let target = 0;
  let accumulated = 0;
  let pinned = null;

  function inject(root) {
    if (!root) return 0;
    let patched = 0;
    root.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
      for (const material of materials) {
        const profile = snowProfileForObject(object, material);
        // Keep shader variants bounded: broad building wall/wood/opening materials do
        // not visibly hold snow. Roofs, terrain-like groups, vegetation, and explicit
        // stone roles cover every readable accumulation surface in aerial and focus views.
        if (profile === 'surface') continue;
        if ((profile === 'tile' || profile === 'thatch') && !material?.userData?.snowSurface) continue;
        if (patchSnowMaterial(material, amountUniform, { profile })) patched++;
      }
    });
    return patched;
  }

  function setAccumulation(value) {
    pinned = value;
    if (value != null) {
      accumulated = value;
      amountUniform.value = value * SNOW_AMOUNT_MAX;
    }
  }

  villageGroup.userData.setSnowAccum = setAccumulation;
  villageGroup.userData.getSnowInfo = () => ({
    target,
    accum: +accumulated.toFixed(3),
    value: +amountUniform.value.toFixed(3),
    pinned,
  });

  return {
    inject,
    isActive: () => target > 0,
    setWeather(name, opts = {}) {
      target = name === 'snow' ? 1 : 0;
      if (target > 0) inject(villageGroup);
      if (opts.immediate) {
        accumulated = target > 0 ? (opts.accum ?? 1) : 0;
        amountUniform.value = accumulated * SNOW_AMOUNT_MAX;
      }
    },
    update(dt) {
      if (pinned != null) accumulated = pinned;
      else if (target > 0) accumulated = Math.min(1, accumulated + dt / SNOW_ACCUMULATE_SECONDS);
      else accumulated = Math.max(0, accumulated - dt / SNOW_MELT_SECONDS);
      amountUniform.value = accumulated * SNOW_AMOUNT_MAX;
    },
  };
}

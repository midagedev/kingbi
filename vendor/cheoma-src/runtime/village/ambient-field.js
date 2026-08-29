import { createAmbientField } from '../../env/focus.js';

/** Camera-proximity ambience for non-focused residential parcels. */
export function createVillageAmbientFieldController({
  plan,
  site,
  proxyById,
  excludedParcelIds,
  findSun,
}) {
  const enabled = typeof location === 'undefined'
    || new URLSearchParams(location.search).get('ambfield') !== '0';
  let field = null;
  let time = 'day';
  let season = 'summer';
  let waveWeight = 1;

  function buildDescriptors() {
    const descriptors = [];
    for (const parcel of plan.parcels) {
      if (parcel.hero) continue;
      const proxy = proxyById.get(parcel.id);
      if (!proxy) continue;
      const style = parcel.kind === 'giwa' ? 'giwa' : 'choga';
      const { rotY, worldCenter } = proxy;
      const baseY = parcel.baseY != null ? parcel.baseY : worldCenter.y;
      const width = parcel.plotW || 20;
      const depth = parcel.plotD || 18;
      const sign = (parcel.seed & 4) ? 1 : -1;
      const localX = width * 0.22 * sign;
      const localZ = -depth * 0.30;
      const cos = Math.cos(rotY);
      const sin = Math.sin(rotY);
      descriptors.push({
        id: parcel.id,
        cx: worldCenter.x,
        cz: worldCenter.z,
        baseY,
        rotY,
        W: width,
        D: depth,
        style,
        seed: (parcel.seed || 7) >>> 0,
        chimney: {
          x: parcel.center.x + localX * cos + localZ * sin,
          y: baseY + (style === 'giwa' ? 4.6 : 3.4),
          z: parcel.center.z - localX * sin + localZ * cos,
        },
      });
    }
    return descriptors;
  }

  function enter(scene, { deferSceneServices = false } = {}) {
    if (!enabled || !scene) return;
    if (field) {
      if (!deferSceneServices) field.activateSceneServices();
      return;
    }
    field = createAmbientField(scene, {
      heightAt: (x, z) => site?.heightAt?.(x, z) ?? 0,
      sun: findSun(scene),
      deferSceneServices,
    });
    field.setParcels(buildDescriptors());
    field.setExcluded((id) => excludedParcelIds.has(id));
    field.setTime(time, true);
    field.setSeason(season);
  }

  function exit() {
    field?.dispose();
    field = null;
  }

  return {
    enter,
    exit,
    update(dt, camera, lod) { field?.update(dt, camera, lod, waveWeight); },
    setWaveFade(value) {
      waveWeight = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    },
    setTime(name, immediate = false) { time = name; field?.setTime(name, immediate); },
    setSeason(name, immediate = false) { season = name; field?.setSeason(name, immediate); },
    // field가 아직 생성되지 않았거나 exit로 해제된 뒤에도 wave 소유권 자체는 읽을 수 있다.
    // 준비→웨이브→취소 수명 검증이 scene 리소스의 존재 여부와 controller 상태를 혼동하지 않게 한다.
    debug() {
      return {
        waveWeight,
        ownerWeight: waveWeight,
        entered: !!field,
        ...(field?._debug?.() || {}),
      };
    },
  };
}

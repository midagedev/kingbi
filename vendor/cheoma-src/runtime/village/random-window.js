import { makeRng, hashString } from '../../rng.js';
import { setTextureRandom } from '../../builder/palette.js';
import { setGateRandom } from '../../layout/gate.js';

export const DEFAULT_VILLAGE_SEED = 20260716;

export function resolveVillageSeed(seed) {
  return (typeof seed === 'number' ? seed
    : typeof seed === 'string' ? hashString(seed)
      : DEFAULT_VILLAGE_SEED) >>> 0;
}

// 비동기 생성은 한 인스턴스를 만든 뒤 모든 rAF slice에서 같은 RNG closure를 재사용해야 한다.
// slice 밖에서는 원래 Math.random을 즉시 복구해 앱 render loop의 난수 흐름을 오염시키지 않는다.
export function createVillageRandomWindow(seed) {
  const texRng = makeRng((seed ^ 0x7e17) >>> 0);
  const gateRng = makeRng((seed ^ 0x6a1e) >>> 0);
  const mainRng = makeRng((seed ^ 0x9e3779b9) >>> 0);

  return function runInVillageRandomWindow(fn) {
    const originalRandom = Math.random;
    setTextureRandom(texRng);
    setGateRandom(gateRng);
    Math.random = mainRng;
    try {
      return fn();
    } finally {
      Math.random = originalRandom;
      setTextureRandom(null);
      setGateRandom(null);
    }
  };
}

// 편집 overlay처럼 각 작업이 자기 seed stream을 처음부터 쓰는 일회성 경로.
export function withVillageRandomSeed(seed, fn) {
  return createVillageRandomWindow(seed)(fn);
}

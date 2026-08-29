import { distance2D, fadeBeyond } from '../../core/lod.js';
import {
  lensScaleForCamera,
  villageScreenDistanceForCamera,
} from '../../camera/optics.js';
import { VILLAGE_DETAIL_LOD, villageDetailReach } from '../../village/lod-policy.js';

export const VILLAGE_DETAIL_TIER = Object.freeze({
  FAR: 'far',
  MID: 'mid',
  NEAR: 'near',
});

const DETAIL_TIER_BANDS = Object.freeze({
  farToMid: 58,
  midToFar: 66,
  midToNear: 38,
  nearToMid: 46,
});

function nextDetailTier(previous, distance) {
  if (!previous) {
    if (distance <= DETAIL_TIER_BANDS.midToNear) return VILLAGE_DETAIL_TIER.NEAR;
    if (distance <= DETAIL_TIER_BANDS.farToMid) return VILLAGE_DETAIL_TIER.MID;
    return VILLAGE_DETAIL_TIER.FAR;
  }
  if (previous === VILLAGE_DETAIL_TIER.NEAR) {
    return distance >= DETAIL_TIER_BANDS.nearToMid
      ? VILLAGE_DETAIL_TIER.MID : VILLAGE_DETAIL_TIER.NEAR;
  }
  if (previous === VILLAGE_DETAIL_TIER.MID) {
    if (distance <= DETAIL_TIER_BANDS.midToNear) return VILLAGE_DETAIL_TIER.NEAR;
    if (distance >= DETAIL_TIER_BANDS.midToFar) return VILLAGE_DETAIL_TIER.FAR;
    return VILLAGE_DETAIL_TIER.MID;
  }
  return distance <= DETAIL_TIER_BANDS.farToMid
    ? VILLAGE_DETAIL_TIER.MID : VILLAGE_DETAIL_TIER.FAR;
}

// 매 프레임 한 번 계산해 주택 외 생활 디테일이 공유하는 카메라/시선 셀 상태를 만든다.
// target은 OrbitControls.target을 권장하며, 없는 독립 하네스는 카메라 아래 지형점을 쓴다.
export function createVillageDetailLodState(camera, target, site, previous = null) {
  const position = camera?.position;
  if (!position) {
    return {
      anchor: { x: 0, y: 0, z: 0 }, altitude: Infinity,
      viewDistance: Infinity, visualAltitude: Infinity, visualDistance: Infinity,
      detailDistance: Infinity, lensScale: 1,
      viewPitchDeg: 90, chunkReach: 1,
      tier: VILLAGE_DETAIL_TIER.FAR,
      groundWeight: 0, particleWeight: 0, groundActive: false,
      aerialWeight: 1,
    };
  }
  const hasTarget = Number.isFinite(target?.x) && Number.isFinite(target?.z);
  const x = hasTarget ? target.x : position.x;
  const z = hasTarget ? target.z : position.z;
  const terrainY = site?.heightAt?.(x, z) ?? 0;
  const y = terrainY;
  const altitude = Math.max(0, position.y - y);
  const dx = position.x - x, dy = position.y - y, dz = position.z - z;
  const viewDistance = Math.hypot(dx, dy, dz);
  const visualAltitude = villageScreenDistanceForCamera(altitude, camera);
  const visualDistance = villageScreenDistanceForCamera(viewDistance, camera);
  const lensScale = lensScaleForCamera(camera);
  // altitude는 부감 여부, viewDistance는 줌 수준을 나타낸다. 낮은 고도로 멀리 바라보는
  // 구도에서도 서브픽셀 동물/입자를 계속 돌리지 않도록 둘 중 더 보수적인 강도를 쓴다.
  const altitudeWeight = fadeBeyond(
    visualAltitude, VILLAGE_DETAIL_LOD.altitude.full, VILLAGE_DETAIL_LOD.altitude.hidden,
  );
  const viewWeight = fadeBeyond(
    visualDistance, VILLAGE_DETAIL_LOD.view.full, VILLAGE_DETAIL_LOD.view.hidden,
  );
  const particleAltitudeWeight = fadeBeyond(
    visualAltitude, VILLAGE_DETAIL_LOD.particles.full, VILLAGE_DETAIL_LOD.particles.hidden,
  );
  const particleViewWeight = fadeBeyond(
    visualDistance, VILLAGE_DETAIL_LOD.particleView.full, VILLAGE_DETAIL_LOD.particleView.hidden,
  );
  const groundWeight = Math.min(altitudeWeight, viewWeight);
  const particleWeight = Math.min(particleAltitudeWeight, particleViewWeight);
  const detailDistance = Math.max(visualAltitude, visualDistance * 0.72);
  const tier = nextDetailTier(previous?.tier, detailDistance);
  // 시선 피치는 카메라→시선 타깃 광선에서 읽는다. matrixWorld 를 읽지 않으므로 위치만 가진
  // 격리 하네스 fixture 에서도 정의되고, 타깃이 없으면 카메라 아래를 보는 것과 같아 부감이 된다.
  const viewPitchDeg = viewDistance > 1e-6
    ? Math.asin(Math.max(-1, Math.min(1, dy / viewDistance))) * 180 / Math.PI
    : 90;
  return {
    anchor: { x, y, z }, altitude, viewDistance, visualAltitude, visualDistance,
    detailDistance, lensScale, tier,
    viewPitchDeg, chunkReach: villageDetailReach(viewPitchDeg),
    groundWeight, particleWeight,
    // tier는 셀 밀도/히스테리시스의 이산 상태이고, 가시성은 연속 weight가 끝까지 소유한다.
    // 낮은 고도로 멀리 보는 구도에서 tier가 먼저 FAR가 되더라도 남은 10~20%를 갑자기
    // 잘라내지 않고 fadeBeyond의 hidden 경계까지 자연스럽게 소거한다.
    groundActive: groundWeight > 0.002,
    aerialWeight: 1 - groundWeight,
  };
}

// 지면 디테일은 낮게 본다는 이유만으로 마을 전역을 켜지 않는다. 현재 시선 셀과의 수평거리까지
// 함께 적용해, 가까운 동물만 자연스럽게 나타나고 원경 개체의 애니메이션/드로우콜은 잠든다.
export function villageDetailWeightAt(state, point) {
  if (!state || !point) return 0;
  const spatial = fadeBeyond(
    distance2D(state.anchor, point),
    VILLAGE_DETAIL_LOD.spatial.full,
    VILLAGE_DETAIL_LOD.spatial.hidden,
  );
  return state.groundWeight * spatial;
}

import { cityGateFootprint } from './citywall-contour.js';
import { TEMPLE_PATH_CLEARANCE, templeFootprint } from './temple-plan.js';
export { terrainGridSize, terrainMeshHeightAt } from './terrain-grid.js';

// 지형 신축 밴드의 안쪽 경계 반경. 도로 폭까지 포함해 이 반경 안의 terrain grid는 좌표가
// 변형되지 않는다는 전제를 road-surface와 forest worker가 하나의 순수 계약으로 공유한다.
export function computeFixedRadius(plan, site) {
  let radius = site.bowlR * 1.05;
  const consider = (x, z, margin = 0) => {
    radius = Math.max(radius, Math.hypot(x, z) + margin);
  };
  for (const parcel of plan.parcels || []) {
    const halfDiagonal = Math.hypot(parcel.plotW || 0, parcel.plotD || 0) / 2;
    consider(parcel.center.x, parcel.center.z, halfDiagonal);
  }
  for (const field of plan.paddies || []) for (const point of field.poly) consider(point.x, point.z);
  for (const road of plan.roads || []) {
    for (const point of road.pts) consider(point.x, point.z, road.width * 0.5 + 1);
  }
  if (site.stream) for (const point of site.stream.pts) consider(point.x, point.z);
  const features = plan.features || {};
  const wall = features.cityWall;
  if (wall?.radii?.length) {
    for (let i = 0; i < wall.radii.length; i++) {
      const angle = i / wall.radii.length * Math.PI * 2;
      consider(wall.cx + Math.sin(angle) * wall.radii[i],
        wall.cz + Math.cos(angle) * wall.radii[i], 2);
    }
    for (const gate of wall.gates || []) {
      for (const point of cityGateFootprint(gate)) consider(point.x, point.z, 1);
    }
  }
  const considerFeature = (feature, margin) => {
    if (feature && typeof feature.x === 'number') consider(feature.x, feature.z, margin);
  };
  if (features.temple && typeof features.temple.x === 'number') {
    for (const point of templeFootprint(features.temple, 1)) consider(point.x, point.z);
    for (const point of features.temple.path || []) consider(point.x, point.z, TEMPLE_PATH_CLEARANCE);
  }
  considerFeature(features.palace, 26);
  considerFeature(features.govCore, 24);
  considerFeature(features.pavilion, 8);
  for (const prop of features.props || []) considerFeature(prop, 4);

  // 외곽 안개용 신축 밴드는 항상 남긴다. 이 clamp보다 바깥에 콘텐츠가 생기면 검증에서
  // 명시적으로 실패해야 하며, 조용히 warp된 terrain에 해석 좌표를 쓰면 안 된다.
  const terrainR = site.terrainR || site.R;
  return Math.min(radius, terrainR - Math.max(8, terrainR * 0.06));
}

export function terrainWarpInner(plan, site) {
  const terrainR = site.terrainR || site.R;
  return Math.max(computeFixedRadius(plan, site) + 6, Math.min(site.R * 0.9, terrainR - 6));
}

import * as G from '../core/math/geom2.js';
import { createRoadSpatialIndex } from './road-spatial.js';

// 렌더러(buildWaterRibbon)가 소비하는 동일 centerline·half-width를 기준으로 한 개울 계약.
// analytic streamZat(center.x) 근사는 회전된 필지 모서리와 사행 접선을 놓치므로 배치·식생·
// 회귀 검사는 이 모듈을 통해 실제 폴리라인 리본과 비교한다.
// 중심점 근사의 옛 +4.5m는 필지 반폭을 대신하려던 휴리스틱이었다. 폴리곤 자체를 재므로
// 실제 물가 밖 배수 여유까지 직접 재므로 더 강한 안전 계약을 유지하면서 수변 취락 밀도를 잃지 않는다.
export const STREAM_PARCEL_BANK_CLEARANCE = 1.2;
export const STREAM_SATELLITE_BANK_CLEARANCE = 1.2;
export const STREAM_PADDY_BANK_CLEARANCE = 2;
export const STREAM_VEGETATION_BANK_CLEARANCE = 1.2;
export const STREAM_GUARDIAN_BASE_CLEARANCE = 2.5;

export function streamClearanceAt(site, point) {
  if (!site?.stream?.pts?.length) return Infinity;
  return G.distToPolyline(point, site.stream.pts).d - Math.max(0, site.streamHalf || 0);
}

export function streamIntersectsPolygon(site, poly, margin = 0) {
  if (!site?.stream?.pts?.length || !poly?.length) return false;
  const corridor = Math.max(0, site.streamHalf || 0) + Math.max(0, margin || 0);
  return G.polylinePolygonDistance(site.stream.pts, poly) < corridor;
}

export function streamBlocksCircle(site, point, radius = 0, margin = 0) {
  return streamClearanceAt(site, point) < Math.max(0, radius || 0) + Math.max(0, margin || 0);
}

// 수백~수만 필지 후보를 검사하는 배치 경로는 centerline 전수 순회를 반복하지 않는다.
// 도로와 개울은 모두 폭을 가진 polyline corridor이므로 이미 검증된 uniform-grid broad phase를
// 그대로 재사용한다. 저빈도 단건 소비자는 위의 stateless 함수만 써도 된다.
export function createStreamSpatialIndex(site) {
  if (!site?.stream?.pts?.length) {
    return Object.freeze({
      intersectsPolygon: () => false,
      stats: Object.freeze({ cellSize: 0, cells: 0, segments: 0 }),
    });
  }
  const spatial = createRoadSpatialIndex([site.stream]);
  return Object.freeze({
    intersectsPolygon(poly, margin = 0) {
      return spatial.intersectsRoadCorridor(poly, Math.max(0, margin || 0), site.stream);
    },
    stats: spatial.stats,
  });
}

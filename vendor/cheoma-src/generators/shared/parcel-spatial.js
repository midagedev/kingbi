import { facingY } from '../../core/math/geom2.js';
import {
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_LENS,
  dollyDistanceForFov,
} from '../../camera/optics.js';

const DEG = Math.PI / 180;
// Stay inside the south-light opening instead of orbiting far enough sideways for
// public structures to enter the view axis. A shallow three-quarter angle still
// reveals bay depth while reading primarily as the house's south-facing elevation.
const FOCUS_AZIMUTH_MAX = 14 * DEG;
// Aim at the doors from the shared product-tested courtyard elevation. The protected
// south-light opening keeps the camera on the house axis; the lift clears walls and
// gates without turning the close view into an aerial survey.
const FOCUS_DISTANCE = dollyDistanceForFov(
  2.25,
  VILLAGE_LENS.parcel.referenceFov,
  VILLAGE_LENS.parcel.fov,
);

// A focused house is composed around its doors, not the roof mass. Keeping this
// pure value beside the XZ framing lets picking, hero landing, and regression
// checks share one semantic aim point without renderer-only corrections.
export function parcelFocusTargetLift(height) {
  return Math.max(1.65, Math.min(2.5, height * 0.26));
}

// THREE.Vector3.applyAxisAngle(Y, angle)의 연산 순서를 그대로 옮긴 순수 helper. 단순 cos/sin
// 전개는 수학적으로 같아도 마지막 비트가 달라 기존 pick-proxy 결정론 해시가 바뀐다.
function rotateFocusOffsetY(x, y, z, angle) {
  const half = angle / 2, s = Math.sin(half);
  const qx = 0 * s, qy = s, qz = 0 * s, qw = Math.cos(half);
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return {
    x: x + qw * tx + qy * tz - qz * ty,
    y: y + qw * ty + qz * tx - qx * tz,
    z: z + qw * tz + qx * ty - qy * tx,
  };
}

// 필지와 집 생성기가 공유하는 월드 회전 계약. THREE가 필요 없는 계획/회귀 검사에서도
// 포커스 카메라와 실제 인스턴스가 같은 방향을 사용하도록 순수 모듈에 둔다.
export function parcelRotY(parcel) {
  return facingY(parcel.frontDir) + (parcel.yaw || 0);
}

function parcelBounds(parcel) {
  const mja = parcel?.mjaHouse;
  const outer = mja?.kind === 'mja-banga' ? mja.bounds?.outer : null;
  if (outer && [outer.minX, outer.maxX, outer.minZ, outer.maxZ].every(Number.isFinite)) {
    return {
      width: outer.maxX - outer.minX,
      depth: outer.maxZ - outer.minZ,
      centerX: (outer.minX + outer.maxX) * 0.5,
      centerZ: (outer.minZ + outer.maxZ) * 0.5,
    };
  }
  const points = parcel.shape?.pts;
  if (!points || points.length < 3) {
    return { width: parcel.plotW, depth: parcel.plotD, centerX: 0, centerZ: 0 };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return {
    width: maxX - minX,
    depth: maxZ - minZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

function parcelFocusAzimuthRange(parcel, bounds) {
  const corridor = parcel.solarAccess;
  if (!corridor) return { min: -FOCUS_AZIMUTH_MAX, max: FOCUS_AZIMUTH_MAX };
  const forward = Math.max(1, corridor.localEnd - bounds.centerZ);
  const left = Math.max(0.2, corridor.halfWidth - 0.3 + bounds.centerX);
  const right = Math.max(0.2, corridor.halfWidth - 0.3 - bounds.centerX);
  return {
    min: -Math.min(FOCUS_AZIMUTH_MAX, Math.atan2(left, forward)),
    max: Math.min(FOCUS_AZIMUTH_MAX, Math.atan2(right, forward)),
  };
}

function parcelFocusAzimuth(parcel, bounds, range) {
  if (!parcel.solarAccess) return FOCUS_AZIMUTH_MAX;
  // Turn away from an off-centre fitted house. The complete safe interval is
  // retained for the deterministic visibility selector, which may step toward
  // the centre without leaving the reserved solar opening.
  return bounds.centerX > 0 ? range.min : range.max;
}

// 필지 포커스 프록시와 카메라의 순수 XZ 계획. picking.js가 THREE 객체를 조립하고,
// DOM/THREE 없는 계약 검사는 같은 결과를 직접 소비한다.
export function planParcelFocus(parcel) {
  const bounds = parcelBounds(parcel);
  const width = bounds.width * 1.08;
  const depth = bounds.depth * 1.08;
  const mjaHeight = parcel?.mjaHouse?.kind === 'mja-banga'
    ? Math.max(
      parcel.mjaHouse.gate?.roofTopY || 0,
      ...parcel.mjaHouse.wings.map((wing) => wing.roofTopY || 0),
    ) + 0.35
    : null;
  const height = mjaHeight || (parcel.hero ? 14 : (parcel.kind === 'giwa' ? 9 : 6.5));
  const rotationY = parcelRotY(parcel);
  const azimuthRange = parcelFocusAzimuthRange(parcel, bounds);
  const azimuth = parcelFocusAzimuth(parcel, bounds, azimuthRange);
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const worldX = parcel.center.x + bounds.centerX * cos + bounds.centerZ * sin;
  const worldZ = parcel.center.z - bounds.centerX * sin + bounds.centerZ * cos;
  const radius = FOCUS_DISTANCE * Math.max(width, depth, height);
  const horizontal = radius * Math.cos(VILLAGE_FOCUS_ELEVATION);
  const localX = horizontal * Math.sin(azimuth);
  const localZ = horizontal * Math.cos(azimuth);
  const offset = rotateFocusOffsetY(
    localX,
    radius * Math.sin(VILLAGE_FOCUS_ELEVATION),
    localZ,
    rotationY,
  );
  const targetLift = parcelFocusTargetLift(height);
  return {
    width,
    depth,
    height,
    rotationY,
    azimuth,
    azimuthMin: azimuthRange.min,
    azimuthMax: azimuthRange.max,
    worldX,
    worldZ,
    cameraX: worldX + offset.x,
    cameraZ: worldZ + offset.z,
    cameraLift: offset.y,
    targetLift,
    fov: VILLAGE_LENS.parcel.fov,
    referenceFov: VILLAGE_LENS.parcel.referenceFov,
  };
}

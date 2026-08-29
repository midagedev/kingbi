import { planParcelFocus } from '../generators/shared/parcel-spatial.js';
import { parcelRoofPolygons } from './house-footprint.js';

// The focus camera looks through the parcel's south opening. A single center ray
// is not enough: a pavilion can miss that ray while its broad eaves still cover a
// door or roof corner. This pure XZ envelope protects the visible house width and
// narrows toward the authored camera, matching perspective without THREE state.
export const FOCUS_FRAME_MARGIN = 0.6;
export const FOCUS_FRAME_NEAR_T = 0.04;
export const FOCUS_FRAME_FAR_T = 0.96;

export function parcelFocusViewEnvelope(parcel) {
  const focus = planParcelFocus(parcel);
  const target = { x: focus.worldX, z: focus.worldZ };
  const camera = { x: focus.cameraX, z: focus.cameraZ };
  const dx = camera.x - target.x, dz = camera.z - target.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= 1e-8) {
    return { focus, target, camera, distance: 0, forward: { x: 0, z: 1 }, right: { x: 1, z: 0 }, halfWidth: 0 };
  }
  const forward = { x: dx / distance, z: dz / distance };
  const right = { x: -forward.z, z: forward.x };
  let halfWidth = 0;
  for (const polygon of parcelRoofPolygons(parcel)) {
    for (const point of polygon) {
      halfWidth = Math.max(
        halfWidth,
        Math.abs((point.x - target.x) * right.x + (point.z - target.z) * right.z),
      );
    }
  }
  // Non-house landmarks can still use the framing helper. Their focus proxy width
  // is the conservative fallback when no residential roof polygon exists.
  if (halfWidth <= 1e-8) halfWidth = focus.width * 0.5;
  return { focus, target, camera, distance, forward, right, halfWidth };
}

export function circleBlocksParcelFocusFrame(
  parcel,
  obstruction,
  radius = obstruction?.radius || 0,
  margin = FOCUS_FRAME_MARGIN,
) {
  if (!parcel || !Number.isFinite(obstruction?.x) || !Number.isFinite(obstruction?.z)) return false;
  const envelope = parcelFocusViewEnvelope(parcel);
  if (envelope.distance <= 1e-8) return false;
  const ox = obstruction.x - envelope.target.x;
  const oz = obstruction.z - envelope.target.z;
  const along = ox * envelope.forward.x + oz * envelope.forward.z;
  const t = along / envelope.distance;
  // Geometry almost at the subject belongs to its own parcel; geometry at or
  // behind the camera is a camera-collision concern, not a visible occluder.
  if (t <= FOCUS_FRAME_NEAR_T || t >= FOCUS_FRAME_FAR_T) return false;
  const lateral = Math.abs(ox * envelope.right.x + oz * envelope.right.z);
  const visibleHalfWidth = envelope.halfWidth * (1 - t) + Math.max(0, margin);
  return lateral <= visibleHalfWidth + Math.max(0, radius);
}

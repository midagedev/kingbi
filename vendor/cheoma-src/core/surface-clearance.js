// Small, world-space separations shared by building generators.
//
// Coplanar decoration should be fixed in geometry, not with polygonOffset: the
// latter makes the result camera-dependent and can still flicker at village
// scale. Six centimetres matches the terrain-road/pad lift contract and stays
// resolvable with the aerial camera's adaptive near plane.
export const FOUNDATION_SINK = 0.06;
export const COURTYARD_SURFACE_LIFT = 0.06;
export const OPENING_FACE_CLEARANCE = 0.02;
export const ROOF_WALL_TUCK = 0.16;
// Tile outer vs structural 개판 underside (roof stack, not room 반자).
// Zero-thickness DoubleSide put both faces on one plane (z-fight). See docs/ceiling.md.
// 0.10m: 0.08 still read as under-eave static with reverse light + assembly motion on
// steep 팔작 faces (depth precision at the eave lip); 10cm stays within eave-board band.
export const ROOF_SHELL_THICKNESS = 0.10;
// How far a hip/valley maru tube centreline sits clear of the outer tile so the
// tube body does not pierce the shell (radius embed → coplanar z-fight under
// assembly motion and close eave cameras). Positive = above the surface path.
export const ROOF_MARU_SURFACE_CLEAR = 0.02;

// Preserve the visible top while extending the lowest solid below grade.
export function sunkPrism(top, bottom = 0, sink = FOUNDATION_SINK) {
  const sunkBottom = bottom - sink;
  return {
    bottom: sunkBottom,
    top,
    height: top - sunkBottom,
    center: (top + sunkBottom) * 0.5,
  };
}

// Bed a ground stone (디딤돌 · 댓돌) instead of resting it on grade.
//
// A trodden stone is set into the ground and settles: its underside is soil-borne,
// never a slab face parked exactly on the surface plane. Modelling it flush is also
// what breaks depth — a stone whose bottom sits at grade and whose top lands on the
// lifted courtyard surface shares a plane with the ground it stands on, so the two
// faces trade pixels. `standAbove` is therefore measured from the *visible surface*
// the stone rises out of, not from y = 0, and the base runs below grade.
export function beddedStone(surfaceY, standAbove, sink = FOUNDATION_SINK) {
  return sunkPrism(surfaceY + standAbove, 0, sink);
}

// Put an overlay's visible face beyond its host without pulling the whole
// overlay out of the wall. The rear may remain embedded; only the two visible
// faces need a stable depth ordering.
export function overlayCenterOffset(
  hostThickness,
  overlayThickness,
  clearance = OPENING_FACE_CLEARANCE,
) {
  return (hostThickness - overlayThickness) * 0.5 + clearance;
}

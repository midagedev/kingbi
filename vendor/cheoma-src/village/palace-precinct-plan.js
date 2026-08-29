// Pure outer-precinct contract shared by the palace renderer and semantic
// interaction index. Interior ilgwak placement remains palace.js-owned; the
// palace wall and Gwanghwamun must never be reconstructed from unrelated boxes.

export const PALACE_OUTER_WALL = Object.freeze({
  height: 3,
  thickness: 0.7,
  wallStyle: 'jeondol',
  gateGap: 8,
  gateType: 'soseuldaemun',
  gateWidth: 3.4,
});

export function palaceOuterPrecinctPlan(width, depth) {
  const W = Number.isFinite(width) && width > 0 ? width : 60;
  const D = Number.isFinite(depth) && depth > 0 ? depth : 90;
  const halfW = W * 0.5;
  const halfD = D * 0.5;
  return {
    width: W,
    depth: D,
    wall: {
      points: [
        { x: -halfW, z: halfD }, { x: halfW, z: halfD },
        { x: halfW, z: -halfD }, { x: -halfW, z: -halfD },
      ],
      height: PALACE_OUTER_WALL.height,
      thickness: PALACE_OUTER_WALL.thickness,
      wallStyle: PALACE_OUTER_WALL.wallStyle,
      opening: { seg: 0, center: 0.5, width: PALACE_OUTER_WALL.gateGap },
    },
    gate: {
      type: PALACE_OUTER_WALL.gateType,
      width: PALACE_OUTER_WALL.gateWidth,
      position: { x: 0, z: halfD },
      rotationY: 0,
    },
  };
}

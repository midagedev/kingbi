// Renderer-free spatial grammar for the walled parcel compounds built by
// layout/parcel.js. Interaction, planning, and rendering must agree on the
// south gate opening, wall envelope, and flanking corridors without copying
// style-specific dimensions into each subsystem.

export const PARCEL_COMPOUND_STYLES = Object.freeze({
  palace: Object.freeze({
    preset: 'korea', gateType: 'soseuldaemun', gateGap: 6.6, gateWidth: 2.6,
    plot: Object.freeze([34, 28]), fenceH: 2.2, wings: true, wallStyle: 'jeondol',
  }),
  temple: Object.freeze({
    preset: 'temple', gateType: 'soseuldaemun', gateGap: 6.6, gateWidth: 2.6,
    plot: Object.freeze([30, 30]), fenceH: 2.2, wings: false, wallStyle: 'toseok',
  }),
  choga: Object.freeze({
    preset: 'choga', gateType: 'saripmun', gateGap: 1.8, gateWidth: 1.5,
    plot: Object.freeze([13, 12]), fenceH: 1.3, wings: false, wallStyle: 'stone',
  }),
  hanok: Object.freeze({
    preset: 'hanok', gateType: 'soseuldaemun', gateGap: 5.2, gateWidth: 2.6,
    plot: Object.freeze([24, 22]), fenceH: 2.0, wings: true, wallStyle: 'toseok',
  }),
});

export function parcelCompoundPlan({ style = 'palace', plotW, plotD } = {}) {
  const config = PARCEL_COMPOUND_STYLES[style] || PARCEL_COMPOUND_STYLES.palace;
  const width = Number.isFinite(plotW) && plotW > 0 ? plotW : config.plot[0];
  const depth = Number.isFinite(plotD) && plotD > 0 ? plotD : config.plot[1];
  const halfW = width * 0.5;
  const halfD = depth * 0.5;
  const fencePoints = [
    { x: -halfW, z: halfD }, { x: halfW, z: halfD },
    { x: halfW, z: -halfD }, { x: -halfW, z: -halfD },
  ];
  const wings = [];
  if (config.wings && width > 20) {
    const z0 = -halfD + 3;
    const z1 = halfD - config.gateGap * 0.5 - 2.5;
    const x = halfW - 2.2;
    for (const side of [1, -1]) {
      wings.push({
        side,
        points: [{ x: side * x, z: z0 }, { x: side * x, z: z1 }],
        depth: 2.4,
        colH: config.fenceH + 0.4,
        innerSide: side > 0 ? -1 : 1,
        seedOffset: side > 0 ? 1 : 2,
      });
    }
  }
  return {
    style,
    config,
    width,
    depth,
    halfW,
    halfD,
    fence: {
      points: fencePoints,
      height: config.fenceH,
      thickness: config.wallStyle === 'stone' ? 0.5 : 0.46,
      wallStyle: config.wallStyle,
      opening: { seg: 0, center: 0.5, width: config.gateGap },
    },
    gate: {
      type: config.gateType,
      width: config.gateWidth,
      position: { x: 0, z: halfD },
      rotationY: 0,
    },
    wings,
  };
}

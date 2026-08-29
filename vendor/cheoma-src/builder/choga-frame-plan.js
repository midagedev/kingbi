// Renderer-free vertical contract for the 민도리 frame under a choga roof.
//
// The roof's eave edge is its global low point. Keeping the dori top below that
// plane prevents the front/back cylinders from piercing the hipped shoulders,
// while deriving the jangyeo from the dori makes the two members meet instead
// of occupying the same volume.

export const CHOGA_FRAME_DIMENSIONS = Object.freeze({
  doriRadius: 0.09,
  jangyeoHeight: 0.12,
  roofClearance: 0.02,
  supportEndInset: 0.15,
  supportOutset: 0.05,
});

export function planChogaMindoriFrame(layout) {
  const eaveY = Number(layout?.eaveEdgeY);
  if (!Number.isFinite(eaveY)) {
    throw new TypeError('Choga mindori frame requires a finite eaveEdgeY');
  }
  const changbangHeight = Number(layout?.plateH);
  if (!Number.isFinite(changbangHeight) || changbangHeight <= 0) {
    throw new TypeError('Choga mindori frame requires a positive finite plateH');
  }
  const xL = Number(layout?.xPos?.[0]);
  const xR = Number(layout?.xPos?.at?.(-1));
  const zB = Number(layout?.zPos?.[0]);
  const zF = Number(layout?.zPos?.at?.(-1));
  if (![xL, xR, zB, zF].every(Number.isFinite) || xR <= xL || zF <= zB) {
    throw new TypeError('Choga mindori frame requires ordered finite column lines');
  }

  const {
    doriRadius,
    jangyeoHeight,
    roofClearance,
    supportEndInset,
    supportOutset,
  } = CHOGA_FRAME_DIMENSIONS;
  const supportW = xR - xL - supportEndInset * 2;
  const supportD = zF - zB - supportEndInset * 2;
  if (supportW <= 0 || supportD <= 0) {
    throw new RangeError('Choga mindori support runs require more than two end insets');
  }
  const doriCenterY = eaveY - roofClearance - doriRadius;
  const jangyeoCenterY = doriCenterY - doriRadius - jangyeoHeight / 2;
  const changbangCenterY = jangyeoCenterY - jangyeoHeight / 2 - changbangHeight / 2;
  const changbangRuns = Object.freeze([
    Object.freeze({ id: 'front', axis: 'x', length: xR - xL, x: (xL + xR) / 2, z: zF }),
    Object.freeze({ id: 'back', axis: 'x', length: xR - xL, x: (xL + xR) / 2, z: zB }),
    Object.freeze({ id: 'left', axis: 'z', length: zF - zB, x: xL, z: (zB + zF) / 2 }),
    Object.freeze({ id: 'right', axis: 'z', length: zF - zB, x: xR, z: (zB + zF) / 2 }),
  ]);
  const supportRuns = Object.freeze([
    Object.freeze({ id: 'front', axis: 'x', length: supportW, x: (xL + xR) / 2, z: zF + supportOutset }),
    Object.freeze({ id: 'back', axis: 'x', length: supportW, x: (xL + xR) / 2, z: zB - supportOutset }),
    Object.freeze({ id: 'left', axis: 'z', length: supportD, x: xL - supportOutset, z: (zB + zF) / 2 }),
    Object.freeze({ id: 'right', axis: 'z', length: supportD, x: xR + supportOutset, z: (zB + zF) / 2 }),
  ]);

  return Object.freeze({
    changbangHeight,
    changbangCenterY,
    changbangTopY: changbangCenterY + changbangHeight / 2,
    changbangRuns,
    doriRadius,
    doriCenterY,
    doriTopY: doriCenterY + doriRadius,
    doriBottomY: doriCenterY - doriRadius,
    jangyeoHeight,
    jangyeoCenterY,
    jangyeoBottomY: jangyeoCenterY - jangyeoHeight / 2,
    jangyeoTopY: jangyeoCenterY + jangyeoHeight / 2,
    roofClearance,
    supportRuns,
  });
}

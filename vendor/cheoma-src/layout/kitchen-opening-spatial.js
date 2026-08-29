// Renderer-independent east-wall reservations for residential kitchen openings.
// The builder owns Three.js assembly; residential opening planning owns which
// remaining wall spans may receive habitable windows.

const GIWA_KITCHEN = Object.freeze({
  centerZ: 0.7,
  openingWidth: 1.38,
  openingHeight: 1.58,
  frameThickness: 0.11,
  lightRange: 3.6,
});

const CHOGA_KITCHEN = Object.freeze({
  centerZ: -0.25,
  openingWidth: 1.12,
  openingHeight: 1.42,
  frameThickness: 0.11,
  lightRange: 3.2,
});

function planKitchenOpening(style, wallX, dimensions) {
  if (!Number.isFinite(wallX)) throw new TypeError(`${style} kitchen wallX must be finite`);
  const openingHalf = dimensions.openingWidth / 2;
  const reservedHalf = openingHalf + dimensions.frameThickness;
  return Object.freeze({
    wall: 'east',
    wallX,
    ...dimensions,
    openingSpanZ: Object.freeze({
      min: dimensions.centerZ - openingHalf,
      max: dimensions.centerZ + openingHalf,
    }),
    spanZ: Object.freeze({
      min: dimensions.centerZ - reservedHalf,
      max: dimensions.centerZ + reservedHalf,
    }),
  });
}

export function planGiwaKitchenOpening(wallX) {
  return planKitchenOpening('giwa', wallX, GIWA_KITCHEN);
}

export function planChogaKitchenOpening(wallX) {
  return planKitchenOpening('choga', wallX, CHOGA_KITCHEN);
}

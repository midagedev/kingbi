export const PAVILION_DEFAULTS = Object.freeze({
  radius: 2.5,
  postH: 3.0,
  eaveOverhang: 1.55,
  roofRise: 2.55,
  cornerLift: 0.55,
  planCurve: 0.42,
  profileCurve: 0.6,
  finialAllowance: 1.5,
});

export function pavilionPlanningRoofRadius(spec = PAVILION_DEFAULTS) {
  const exact = spec.radius + spec.eaveOverhang + spec.planCurve;
  return Math.ceil(exact * 10) / 10;
}

export function pavilionPlanningHeight(spec = PAVILION_DEFAULTS) {
  const podium = 0.5;
  const eaveAboveColumns = 0.35;
  return podium + spec.postH + eaveAboveColumns + spec.roofRise + spec.finialAllowance;
}

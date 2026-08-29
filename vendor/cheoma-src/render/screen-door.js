// One static screen-space IGN vocabulary for opaque screen-door presentation.
// A positive signed coverage owns the low subset; a negative one owns the complementary high
// subset. Complementary c and -(1-c) therefore cover every pixel exactly once.
//
// Locals are keyed by the varying name so LOD screen-door (`vLodScreenDoor`) and
// instance fade (`vInstFade`) can share one material without redefinition when
// rim's universal LOD path composes with tree/yard-life instFade patches.
export function screenDoorDiscard(varyingName) {
  const id = String(varyingName || 'c').replace(/[^A-Za-z0-9_]/g, '') || 'c';
  const cov = `_screenDoorCoverage_${id}`;
  const ign = `_screenDoorIgn_${id}`;
  return `float ${cov} = clamp(abs(${varyingName}), 0.0, 1.0);
  if (${cov} < 0.999) {
    float ${ign} = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (${varyingName} >= 0.0) {
      if (${ign} >= ${cov}) discard;
    } else {
      if (${ign} < 1.0 - ${cov}) discard;
    }
  }`;
}

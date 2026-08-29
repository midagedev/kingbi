import { PRESETS, computeLayout, giwaFootprint, giwaFootprintPolygon } from '../params.js';
import {
  CHOGA_VARIANTS,
  GIWA_VARIANTS,
  variantOv,
  variantThatchAge,
} from './variants.js';
import {
  KOREA_COLORS,
  VILLAGE_MATERIAL_COLORS,
  srgbChannelToLinear,
  srgbHexToLinear3,
} from '../builder/material-colors.js';

const multiply3 = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const toneOrNeutral = (tone) => tone || [1, 1, 1];
const clampIndex = (list, index) => Math.min(list.length - 1, Math.max(0, index | 0));

function thatchLinearColor(age) {
  const value = Math.min(1, Math.max(0, age));
  const fresh = [0xd6, 0xb4, 0x60], old = [0x74, 0x70, 0x64];
  const materialTone = [1.04 - value * 0.14, 1 - value * 0.08, 0.9 + value * 0.04];
  return fresh.map((channel, index) => {
    const srgb = (channel + (old[index] - channel) * value) / 255;
    return srgbChannelToLinear(srgb) * materialTone[index];
  });
}

function roofRect(x0, x1, z0, z1, axis, eaveY, ridgeY, ridgeHalf) {
  return { x0, x1, z0, z1, axis, eaveY, ridgeY, ridgeHalf };
}

// 실제 house variant와 같은 치수·평면·재료색에서 원경용 저폴리 명세만 파생한다.
// THREE 비의존이라 빌더를 만들지 않고도 모든 variant의 mirror/지붕/색 계약을 검사할 수 있다.
export function impostorHouseSpec(parcel) {
  const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
  const params = { ...PRESETS[kind], ...variantOv(parcel) };
  const layout = computeLayout(params);
  const roofTone = toneOrNeutral(parcel.roofTone);
  const wallTone = toneOrNeutral(parcel.wallTone);
  const woodTone = toneOrNeutral(parcel.woodTone);
  const stoneTone = toneOrNeutral(parcel.stoneTone);

  if (kind === 'choga') {
    const age = parcel.thatchAge ?? variantThatchAge(parcel);
    const halfW = layout.W * 0.5, halfD = layout.D * 0.5;
    return {
      kind,
      mirrored: false,
      body: {
        polygon: [
          { x: -halfW, z: -halfD }, { x: halfW, z: -halfD },
          { x: halfW, z: halfD }, { x: -halfW, z: halfD },
        ],
        y0: layout.podTopY,
        y1: layout.eaveEdgeY,
      },
      foundation: { y0: 0, y1: layout.podTopY },
      roofs: [roofRect(
        -layout.xEave, layout.xEave, -layout.zEave, layout.zEave,
        'x', layout.eaveEdgeY, layout.ridgeY, layout.ridgeHalf,
      )],
      colors: {
        roof: multiply3(thatchLinearColor(age), roofTone),
        ridge: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.chogaRidge), roofTone),
        wall: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.chogaWall), wallTone),
        wood: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.chogaWood), woodTone),
        stone: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.chogaStone), stoneTone),
      },
    };
  }

  const variant = GIWA_VARIANTS[clampIndex(GIWA_VARIANTS, parcel.variant)] || GIWA_VARIANTS[0];
  const mirrored = variant.mirrorOf != null;
  const { planShape, bays, a, b, w, c } = giwaFootprint(params);
  let polygon = giwaFootprintPolygon(params);
  if (mirrored) polygon = polygon.map((point) => ({ x: -point.x, z: point.z })).reverse();
  const eave = params.eaveOverhang;
  const wingRidgeY = layout.eaveEdgeY + w * 0.5 * params.riseScale;
  const roofs = [roofRect(
    -a - eave, a + eave, -b - eave, b + eave,
    'x', layout.eaveEdgeY, layout.ridgeY, Math.max(0.45, a - b),
  )];
  const addWing = (side) => {
    const x0 = side < 0 ? -a - eave : a - w - eave;
    const x1 = side < 0 ? -a + w + eave : a + eave;
    roofs.push(roofRect(
      x0, x1, b - eave, b + c + eave,
      'z', layout.eaveEdgeY, wingRidgeY, Math.max(0.35, (c - w) * 0.5),
    ));
  };
  if (planShape === 'l') addWing(mirrored ? -1 : 1);
  else if (planShape === 'u') { addWing(-1); addWing(1); }
  return {
    kind,
    mirrored,
    planShape,
    bays,
    body: { polygon, y0: layout.podTopY, y1: layout.eaveEdgeY },
    foundation: { y0: 0, y1: layout.podTopY },
    roofs,
    colors: {
      roof: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.giwaRoofAverage), roofTone),
      ridge: multiply3(srgbHexToLinear3(KOREA_COLORS.tileDark), roofTone),
      wall: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.giwaWall), wallTone),
      wood: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.giwaWood), woodTone),
      stone: multiply3(srgbHexToLinear3(VILLAGE_MATERIAL_COLORS.giwaStone), stoneTone),
    },
  };
}

export const IMPOSTOR_VARIANT_COUNTS = {
  choga: CHOGA_VARIANTS.length,
  giwa: GIWA_VARIANTS.length,
};

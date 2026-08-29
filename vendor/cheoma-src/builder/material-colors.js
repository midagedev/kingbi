// 재질 생성과 저비용 프록시가 함께 쓰는 sRGB 색 토큰. THREE에 의존하지 않아 순수 계획/형상
// 검사에서도 실제 팔레트와 같은 선형 색을 계산할 수 있다.
export const KOREA_COLORS = {
  seokganju: 0x8e4a35,
  noerok: 0x4c6559,
  juhong: 0x9c4632,
  samcheong: 0x3e5f9e,
  hwang: 0xc8a34a,
  baek: 0xe8e4d8,
  meok: 0x2e2a28,
  // 회흑 기와 베이스. tileDark 는 마루(ridge) 적층 톤으로 tile 보다 분명히 어둡되
  // 순흑(crushed black) 직전까지는 내리지 않는다 — #150 item I telephoto 검은 선 뭉침 완화.
  tile: 0x4a4d53,
  tileDark: 0x3f4249,
  plaster: 0xd9d2c4,
  stone: 0xb8b2a6,
  stoneDark: 0x99938a,
  hanji: 0xefe6d2,
  ground: 0xb5a893,
};

export const VILLAGE_MATERIAL_COLORS = {
  // tile texture 홈·등 하이라이트를 합친 원경 평균(softened groove 이후도 중성 회흑 유지)
  giwaRoofAverage: 0x56585f,
  giwaWall: 0xe0dccb,
  giwaWood: 0x9a8a6f,
  chogaWall: 0xc9ad84,
  chogaWood: 0x4e3b28,
  chogaRidge: 0x766748,
  chogaStone: 0xaa9878,
  giwaStone: 0xa79f8f,
};

// #150 item I — 기와 look contract (telephoto black-line + reverse-light gold stipple).
// sRGB luminance band + matte roughness + restrained bump. Palette / roof-skeleton / pure
// gate all read these numbers. Do not darken albedo further for an "ink black roof"
// (docs/surface-materials.md §판정 1). Reverse-light gold threads on tile grooves are
// mostly PBR specular on corrugation (not Fresnel rim alone) — keep roughness high and bump low.
export const TILE_LOOK = Object.freeze({
  tileLumMin: 0.28,
  tileLumMax: 0.34,
  tileDarkLumMin: 0.24,
  tileDarkLumMax: 0.30,
  // tile − tileDark: ridge hierarchy without near-black steps
  tileDarkSeparationMin: 0.025,
  tileDarkSeparationMax: 0.08,
  roofAverageLumMin: 0.30,
  roofAverageLumMax: 0.40,
  // Clay matte — low roughness specularises grooves under telephoto / sunset
  roughnessMin: 0.97,
  roughnessMax: 0.995,
  tileFlatRoughness: 0.985,
  tileRidgeRoughness: 0.98,
  tileConvexRoughness: 0.985,
  tileSurfaceRoughness: 0.985,
  sugiwaRoughness: 0.985,
  // Bump defaults (roof-skeleton / palette / tileroof share these)
  bumpSurface: 0.32,
  bumpSugiwa: 0.22,
  bumpMatbae: 0.45, // slightly stronger than paljak; still below the old 0.9
  // Roof instanceColor channel ends — wide jitter blackens roofs and clumps lines
  roofToneChannelMin: 0.88,
  roofToneChannelMax: 1.06,
  roofToneJitterMax: 0.03,
});

export function srgbChannelToLinear(channel) {
  const value = Math.min(1, Math.max(0, channel));
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

export function srgbHexToLinear3(hex) {
  return [
    srgbChannelToLinear(((hex >> 16) & 0xff) / 255),
    srgbChannelToLinear(((hex >> 8) & 0xff) / 255),
    srgbChannelToLinear((hex & 0xff) / 255),
  ];
}

// 문서·게이트가 쓰는 sRGB 상대휘도(선형 변환 전). surface-materials.md 표와 동일 정의.
export function srgbRelativeLuminance(hex) {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// 순수 계약: 색 토큰이 TILE_LOOK 밴드와 tileDark 분리 규칙을 지키는지. 실패 시 이유 문자열 배열.
export function tileLookBandViolations(colors = KOREA_COLORS, village = VILLAGE_MATERIAL_COLORS) {
  const look = TILE_LOOK;
  const tileLum = srgbRelativeLuminance(colors.tile);
  const darkLum = srgbRelativeLuminance(colors.tileDark);
  const avgLum = srgbRelativeLuminance(village.giwaRoofAverage);
  const sep = tileLum - darkLum;
  const fails = [];
  if (tileLum < look.tileLumMin || tileLum > look.tileLumMax) {
    fails.push(`tile luminance ${tileLum.toFixed(3)} outside [${look.tileLumMin}, ${look.tileLumMax}]`);
  }
  if (darkLum < look.tileDarkLumMin || darkLum > look.tileDarkLumMax) {
    fails.push(`tileDark luminance ${darkLum.toFixed(3)} outside [${look.tileDarkLumMin}, ${look.tileDarkLumMax}]`);
  }
  if (sep < look.tileDarkSeparationMin || sep > look.tileDarkSeparationMax) {
    fails.push(`tile−tileDark separation ${sep.toFixed(3)} outside [${look.tileDarkSeparationMin}, ${look.tileDarkSeparationMax}]`);
  }
  if (avgLum < look.roofAverageLumMin || avgLum > look.roofAverageLumMax) {
    fails.push(`giwaRoofAverage luminance ${avgLum.toFixed(3)} outside [${look.roofAverageLumMin}, ${look.roofAverageLumMax}]`);
  }
  for (const key of [
    'tileFlatRoughness', 'tileRidgeRoughness', 'tileConvexRoughness',
    'tileSurfaceRoughness', 'sugiwaRoughness',
  ]) {
    const r = look[key];
    if (r < look.roughnessMin || r > look.roughnessMax) {
      fails.push(`${key}=${r} outside roughness band [${look.roughnessMin}, ${look.roughnessMax}]`);
    }
  }
  return fails;
}

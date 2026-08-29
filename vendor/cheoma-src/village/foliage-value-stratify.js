import { smoothstep } from '../core/math/scalar.js';

// 농담(濃淡) 층화 — docs/tree-look.md §3.4·원리 ⑤. forest near 인스턴스색과 scatter
//   instanceColor 곱틴트가 같은 축·같은 수치를 쓴다(드리프트 금지).
//   · 그루별 t — 고주파 모자이크(±16%). 인접 그루의 농담이 갈려 수관에 결이 생긴다.
//   · 고도 hillBias — 저주파 밴드(±20%). 능선은 짙고 차갑게, 산자락은 밝고 따뜻하게.
//   · 침엽 deep — 한 단 더 짙게 눌러 수종 간 값 간격을 벌린다.
// Three/DOM-free. RGB 튜플만 반환한다(호출부가 Color·Float32Array 에 쓴다).

export const FOLIAGE_VALUE_STRATIFY = Object.freeze({
  valueT: 0.32,
  valueHill: 0.40,
  coolHill: 0.16,
  baseScale: 0.84,
  hillBase: 1.20,
  deepScale: 0.92,
  hillLo: 0.3,
  hillHi: 0.85,
  coolPivot: 0.35,
});

export function foliageHillBias(hill) {
  const C = FOLIAGE_VALUE_STRATIFY;
  return smoothstep(C.hillLo, C.hillHi, hill);
}

// 입력 색에 값·온도 층화를 곱한다. out 없이 {r,g,b} 를 반환.
export function stratifyFoliageRgb(r, g, b, t, hillBias, deep = false) {
  const C = FOLIAGE_VALUE_STRATIFY;
  const tt = Math.min(1, Math.max(0, t));
  const hh = Math.min(1, Math.max(0, hillBias));
  const scale = (C.baseScale + C.valueT * tt)
    * (C.hillBase - C.valueHill * hh)
    * (deep ? C.deepScale : 1);
  const cool = C.coolHill * (hh - C.coolPivot);
  return {
    r: r * scale * (1 - cool * 0.9),
    g: g * scale,
    b: b * scale * (1 + cool * 1.4),
  };
}

// scatter 전용: vertexColors(덩이별 절대색) × instanceColor(그루별 곱틴트).
//   흰색 베이스에 층화를 걸어 1 근방 배율을 만든다 — 줄기 갈기/잎 녹 비율을 유지한 채 값만 벌린다.
export function foliageInstanceTint(t, hillBias, deep = false) {
  return stratifyFoliageRgb(1, 1, 1, t, hillBias, deep);
}

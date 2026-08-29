import { smoothstep } from '../core/math/scalar.js';

// A horizontal transparent annulus reads as distant ground mist from an eye-level
// view, but its triangles become broad overlapping wedges when the camera looks
// down through the surface. The separate upright ridge mist remains visible after
// this weight settles and continues to own focused/aerial atmosphere.
//
// 부감을 0 으로 끄지는 않는다(R5/U1 #211): 이 링은 지형 절단면과 외곽 수관 실루엣을 대기로 녹이는
//   유일한 장치라, 부감에서 완전히 꺼지면 마을이 하늘에 하드컷으로 붙은 "떠 있는 디오라마 원반"이
//   된다. 마을 fog near=R*2.2 는 capital/hanyang 에서 terrainR 보다 멀어 절단면이 scene fog 에
//   전혀 안 걸리므로, 이 링의 부감 바닥 가중치가 사실상 유일한 로컬 소실 레버다.
//   웨지가 두드러지지 않는 수준의 바닥 가중치만 남긴다 — 부감에서 링은 마을 바깥 외곽 밴드에만
//   걸리므로(populate 의 rIn≈0.78), 분지 내부를 흐리게 덮던 구 룩으로는 돌아가지 않는다.
//   아이레벨 10° 시작 → 30° 전이 대역은 유지(고도 감쇠 계약). 부감 제품 피치(≈31°) 는 이미 바닥값.
const FADE_START = Math.sin(10 * Math.PI / 180);
const FADE_END = Math.sin(30 * Math.PI / 180);
// 15/16 — dyadic fraction for exact gate equality; capital/hanyang aerial must nearly keep
//   full ring strength so the terrain cut dissolves (fog near is beyond terrainR).
export const EDGE_MIST_AERIAL_FLOOR = 0.9375;

export function edgeMistViewWeight(cameraForwardY) {
  if (!Number.isFinite(cameraForwardY)) return 0;
  const down = Math.max(0, -cameraForwardY);
  return 1 - (1 - EDGE_MIST_AERIAL_FLOOR) * smoothstep(FADE_START, FADE_END, down);
}

// 능선 물안개(직립 카메라 대면 뱅크)는 아이레벨이 주역·부감이 보조다. 그 뱅크는 아이레벨에서
//   배경 사면을 여백으로 소실시키는 장치이고, 부감에서는 yaw 만 카메라를 따르므로 31° 내려봐도
//   거의 정면 그대로 남아 산 사면에 넓은 회색 얼룩으로 얹힐 수 있다. 부감에서 0 으로 끄지도
//   않는다 — 능선 겹침·원경 절단 몫은 남겨야 하드컷 원반이 다시 선다(U1 #211).
// 3/4 — dyadic fraction; always below the ring floor so aerial keeps the horizontal ring as
//   the primary cut softener and the upright banks as a secondary layer only.
export const RIDGE_MIST_AERIAL_FLOOR = 0.75;

export function ridgeMistViewWeight(cameraForwardY) {
  if (!Number.isFinite(cameraForwardY)) return 0;
  const down = Math.max(0, -cameraForwardY);
  return 1 - (1 - RIDGE_MIST_AERIAL_FLOOR) * smoothstep(FADE_START, FADE_END, down);
}

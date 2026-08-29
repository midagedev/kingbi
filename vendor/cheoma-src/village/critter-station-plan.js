import { parcelEffectiveRoofBounds } from './house-footprint.js';
import { villageWallLayout } from './wall-contract.js';
import { makeRng } from '../rng.js';

// 개·고양이가 앉고 걷는 자리는 담·대문의 실제 계약값에서만 나온다(THREE 없는 순수 계획).
//   추정으로 담 높이를 다시 짐작하면 담 위 고양이가 떠 보이고, 개는 자기 집 담을 통과해 걷는다.
//   그래서 필지마다 walls.js 와 같은 layout 계약을 한 번 풀어 station 기록으로 넘긴다.
// 좌표는 전부 필지 로컬(+z = 앞/대문 쪽, parcelMatrix T·Ry 규약 이전)이고 y 는 baseY 기준 상대값이다.
// 소비자: src/runtime/village/fauna.js(월드 변환) + src/env/critter-plan.js(자리 결정).

const SOLID_WALL = new Set(['tile', 'stone', 'mud']);

export function parcelCritterStation(parcel, site, char01 = 0.5) {
  const pts = parcel?.shape?.pts;
  if (!pts || pts.length < 3 || parcel.hero) return null;
  const style = parcel.wallType || 'stone';
  const layout = villageWallLayout(parcel.shape, {
    style,
    kind: parcel.kind,
    seed: parcel.seed,
    char01,
    aux: parcel.aux,
    auxRequested: parcel.auxRequested,
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    gateEdge: parcel.access?.gateEdge,
    gateT: parcel.access?.gateT,
    parcel,
    site,
    baseY: parcel.baseY,
    wallHeightK: parcel.wallHeightK,
  }, makeRng(((parcel.seed | 0) ^ 0x51de) >>> 0));
  const count = pts.length;
  const gateEdge = layout.gate?.edge ?? layout.gateEdge ?? 0;
  const gateT = layout.gate?.centerT ?? layout.gateT ?? 0.5;
  const a = pts[gateEdge % count], b = pts[(gateEdge + 1) % count];
  const gate = { x: a.x + (b.x - a.x) * gateT, z: a.z + (b.z - a.z) * gateT };
  const edgeLen = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const tangent = { x: (b.x - a.x) / edgeLen, z: (b.z - a.z) / edgeLen };
  let inward = { x: -tangent.z, z: tangent.x };
  if ((layout.centerX - gate.x) * inward.x + (layout.centerZ - gate.z) * inward.z < 0) {
    inward = { x: -inward.x, z: -inward.z };
  }
  const gateEdgeLayout = layout.edgeLayouts?.find((edge) => edge.index === gateEdge) || null;
  const roof = parcelEffectiveRoofBounds(parcel);
  const house = Number.isFinite(roof?.minX) && Number.isFinite(roof?.maxZ) ? {
    x: (roof.minX + roof.maxX) * 0.5,
    z: (roof.minZ + roof.maxZ) * 0.5,
    hw: Math.abs(roof.maxX - roof.minX) * 0.5,
    hd: Math.abs(roof.maxZ - roof.minZ) * 0.5,
  } : null;
  const W = parcel.plotW || 20, D = parcel.plotD || 18;
  return {
    pts: pts.map((point) => ({ x: point.x, z: point.z })),
    gate, inward, tangent, edgeLen, gateT,
    // 대문이 있는 변의 실제 담 상단(솔리드 담만). 생울·개방은 대문 기둥 상단을 쓴다.
    wallTop: SOLID_WALL.has(style) && gateEdgeLayout ? gateEdgeLayout.height : null,
    gatePostTop: layout.gate?.height ?? null,
    gateHalfGap: (layout.gate?.gap ?? 2.2) * 0.5,
    wallThickness: layout.thickness || 0.5,
    house,
    // 닭 무리(populate)는 (+W*0.08, +D*0.24)를 쓴다. 고양이는 마당 반대쪽 햇볕 자리로.
    yard: { x: -W * 0.16, z: D * 0.20 },
  };
}

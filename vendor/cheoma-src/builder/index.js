import * as THREE from 'three';
import { computeLayout } from '../params.js';
import { makeMaterials, applyDoorPattern } from './palette.js';
import { buildPodium } from './podium.js';
import { buildColumns } from './columns.js';
import { buildBrackets } from './brackets.js';
import { buildWalls } from './walls.js';
import { buildRoof } from './roof.js';
import { buildGiwa } from './giwa.js';
import { disposeBuilding, registerBuildingResources } from './lifecycle.js';
import { normalizeChogaShape } from '../layout/choga-shape.js';
import { attachShadowDepthTextureLifecycle } from '../render/shadow-depth-texture-lifecycle.js';
import { planRankedHallCeiling } from './ceiling-plan.js';
import { ROOF_SHELL_THICKNESS } from '../core/surface-clearance.js';

export { disposeBuilding };

// 파라미터 → 건물 그룹. 파트별 그룹 이름을 달아 조립 애니메이션에 대비한다.
//   P.mats(옵트인, #149): 호출측이 공유 재질셋을 주면 makeMaterials 를 건너뛰고 그걸 쓴다.
//   궁궐(palace.js)은 한 벌의 'palace' 재질셋을 전 전각에 공유시켜 부감 병합(palaceMerged)이
//   전각 경계까지 무너지게 한다(드로우콜 −). 미지정(마을 giwa/choga·히어로)이면 전과 동일하게
//   호출마다 새 재질셋 — 옵트인이라 기존 경로는 바이트 불변.
export function buildBuilding(P) {
  // Normalize the full choga shape once before any geometry/material consumer.
  // This prevents planner-safe NaN/Infinity fallback from diverging in a raw
  // production bay loop while preserving every supported preset byte-for-byte.
  const params = P.style === 'choga' ? { ...P, ...normalizeChogaShape(P) } : P;
  const M = params.mats || makeMaterials(params.style || 'palace', params);
  // 창호 살 패턴 변주(#55) — 부재 조립 전에 창호 텍스처 교체(문짝 클론이 새 패턴 상속).
  //   공유 재질(P.mats)에는 적용하지 않는다: M.door.map 교체가 재질셋을 공유하는 다른 전각·행각까지
  //   전파되기 때문. 궁 경로는 doorPattern 을 쓰지 않으므로 실질 무영향(방어적 가드).
  if (params.doorPattern && !params.mats) applyDoorPattern(M, params.doorPattern);
  // 기와집(ㄱ자 반가): L 평면 전용 경로 (스켈레톤 지붕 + L 몸체).
  if (params.style === 'giwa') {
    const root = buildGiwa(params, M);
    root.userData.layout = computeLayout(params);
    root.userData.materials = M;
    attachShadowDepthTextureLifecycle(root);
    return registerBuildingResources(root, M, !params.mats);
  }
  const L = computeLayout(params);
  const root = new THREE.Group();
  root.name = 'building';

  const parts = {
    podium: buildPodium(params, L, M),
    columns: buildColumns(params, L, M),
    walls: buildWalls(params, L, M),
    brackets: buildBrackets(params, L, M),
    roof: buildRoof(params, L, M),
  };
  for (const [name, group] of Object.entries(parts)) {
    group.name = name;
    root.add(group);
  }

  root.userData.layout = L;
  root.userData.materials = M;
  // Interior roadmap: space finish plan (방 반자 / 대청·처마 연등). See docs/ceiling.md.
  root.userData.ceilingPlan = planRankedHallCeiling({
    style: params.style || 'palace',
    podiumTopY: L.podTopY ?? 0,
    columnTopY: L.colTopY ?? L.plateY ?? 3,
    eaveY: L.eaveEdgeY ?? L.eaveInnerY ?? 3.5,
    shellThickness: ROOF_SHELL_THICKNESS,
  });
  attachShadowDepthTextureLifecycle(root);
  return registerBuildingResources(root, M, !params.mats);
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { bakeSphericalNormals, canopyCenter, FOLIAGE_PROFILE, foliageDome, foliageLeafMass } from '../core/foliage-geometry.js';
import { injectCloudShadow } from '../builder/palette.js';
import { crunchForest, makeEcotoneField, GRANITE } from './forest-crunch.js';

// 한국 산 v2(#122·#121·#115) — 사용자 원지시 복원: "빽빽한 진짜 나무가 주인공".
//   #123 워커 오프로드: 배치 "수치 크런치"(그루/암괴 좌표·계절색)는 forest-crunch.js 로 분리해
//   워커(populate.worker.js)·메인이 공유하고, 이 파일은 그 버퍼로 InstancedMesh "조립"만 한다.
//   결과 룩·드로우콜·결정론은 불변(크런치는 수학만 이설, 조립 코드는 원본 그대로).
//
// 구성: 소나무 수관 InstancedMesh(1) + 활엽 수관 InstancedMesh(1) + 화강암 InstancedMesh(1) = 3 드로우콜.
//   전용 rng(plan.seed 파생, 공유 시퀀스 불침해 → determinism). 지형 규약 공유 warp + 격자 onMesh(#86).
//   #127 terrainR(TR) 클램프 로직(나무 반경 제한)은 크런치 모듈(makeTerrainSampler·target 식)에 그대로 보존.

// 하위호환 재-export(populate.js 가 forest.js 에서 import) — 크런치 모듈이 실소유.
export { makeEcotoneField, GRANITE };

// ───────────────────────── 초저폴리 나무 프로토(수관만) ─────────────────────────
// 룩 복원 Phase 3.5 단계 1(docs/tree-look.md §5) — 실루엣 어휘 교체. 이전 어휘는 원뿔 2단(=전나무
//   픽토그램)과 등축구 1개였고, 수묵 모드에서 면 노멀 때문에 캐노피 안쪽 폴리곤 경계가 전부 필선으로
//   드러났다(§3.3). 지금은 동양화 조형 문법을 따른 잎덩이 어휘 + 구체 노멀 전사로 바꾼다.
//   ★ 불변 계약: 삼각형 예산(PINE_TRIS 20 / BROAD_TRIS 20 / FAR_TRIS 40, forest-crunch.js)을 넘기지
//     않고(소나무는 24→20 으로 감소), 프로토 최대 XZ 반경(FOREST_VISUAL_RADIUS pine 1.55 / broad 1.97
//     / far 1.46) 안에 머문다.
//     반경이 커지면 배치 수용 판정(mask·성벽 클리어런스)이 달라져 골든 해시가 바뀐다(§3.6-4).
//   ★ 노멀: 덩이별이 아니라 수관 매스 하나의 중심에서 전사해야 덩이 경계 필선까지 사라진다.

// 소나무 — 층운형 잎덩이 2단(원리 ③, 조선 산수 적송 관습). 20면체 하나를 위도 프로파일로 조각해
//   "넓은 아래 층 → 허리 → 두 번째 층 → 좁은 정수리"를 만들고, lean 으로 축을 기울여 굽은 줄기를
//   실루엣으로 대신한다(줄기 기하는 이 예산에 없다). 20 삼각(구 원뿔 2단 24 → 감소).
const CONIFER_MASS = {
  radius: 1.52, up: 2.05, down: 1.95, y: 2.10, profile: FOLIAGE_PROFILE.pine,
  jitter: 0.16, phase: 0.4, lean: 0.42, spin: 0.18,
};
// 활엽 — 등축구 그대로가 아니라 위치 기반 지터로 표면을 흔든 비대칭 뭉치(원리 ①의 군집 리듬).
//   정수리를 눌러 위로 좁아지는 실제 수관 프로파일. 20 삼각(구 등축구와 동일 예산).
const BROADLEAF_MASS = {
  radius: 1.94, up: 1.80, down: 1.70, y: 1.95, profile: FOLIAGE_PROFILE.broad,
  jitter: 0.17, phase: 1.1, lean: 0.26, spin: 0.42,
};

function makeConiferProto() {
  return bakeSphericalNormals(foliageLeafMass(CONIFER_MASS), { x: 0.16, y: 2.20, z: 0 });
}
function makeBroadleafProto() {
  return bakeSphericalNormals(foliageLeafMass(BROADLEAF_MASS), { x: 0.10, y: 1.95, z: 0 });
}
// #137 원경 LOD 캐노피 블롭 — 클러스터(여러 그루) 1인스턴스. 단위 크기(반경~1·높이~1.3, 밑면 y≈0)로
//   author 하고 크런치가 매트릭스 스케일(spread, blobH, spread)로 클러스터 footprint·매스에 맞춘다.
//   Phase 3.5: 매끄러운 이중 돔 → 미점법의 "포갠 점"(원리 ②) 요철 표면 단일 돔(10링 2단 = 40 삼각).
//   요철은 실루엣과 깊이 불연속에만 나타나고(먹은 실루엣에 몰린다) 내부는 구체 노멀로 매끈하다.
function makeCanopyBlobProto() {
  const g = foliageDome({
    segments: 10, spin: 0.24,
    lowerRadius: 1.16, lowerY: 0.42,
    lowerRadii: [1.00, 0.86, 1.08, 0.90, 1.14, 0.88, 1.02, 0.94, 1.10, 0.84],
    lowerLift: [0.06, -0.08, 0.04, -0.06, 0.08, -0.05, 0.03, -0.07, 0.05, -0.04],
    upperRadius: 0.74, upperY: 0.92, upperOffset: [0.14, -0.10], upperSpin: Math.PI / 10,
    upperRadii: [0.94, 1.06, 0.86, 1.10, 0.90, 1.02, 0.82, 1.08, 0.92, 1.00],
    upperLift: [0.05, -0.06, 0.03, -0.07, 0.06, -0.04, 0.02, -0.05, 0.04, -0.03],
    top: 1.32, bottom: 0,
  });
  return bakeSphericalNormals(g, { x: 0.05, y: 0.58, z: -0.04 });
}

// ───────────────────────── 화강암 암릉·암괴 프로토(#121) ─────────────────────────
function makeCragProto(seed) {
  const rng = makeRng(seed);
  const parts = [];
  const n = 2 + ((rng() * 2) | 0);
  for (let k = 0; k < n; k++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const sx = rng.range(0.85, 1.25), sy = rng.range(0.8, 1.15), sz = rng.range(0.85, 1.25);
    g.scale(sx, sy, sz);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      p.setXYZ(v, p.getX(v) * (0.9 + 0.2 * rng()), p.getY(v) * (0.9 + 0.2 * rng()), p.getZ(v) * (0.9 + 0.2 * rng()));
    }
    g.translate((rng() - 0.5) * 0.8, sy * 0.25, (rng() - 0.5) * 0.8);
    g.deleteAttribute('uv');
    parts.push(g);
  }
  const m = mergeGeometries(parts, false);
  m.computeBoundingBox(); m.translate(0, -m.boundingBox.min.y, 0);
  m.computeVertexNormals(); m.computeBoundingBox();
  return m;
}

// ───────────────────────── 조립(크런치 버퍼 → InstancedMesh) ─────────────────────────
// 나무: 소나무·활엽 InstancedMesh(공유 재질) + 계절색 setSeason. treeC = 크런치 산출(메인 또는 워커).
function assembleTrees(treeC, cloudU) {
  const group = new THREE.Group(); group.name = 'forest-trees';
  // Phase 3.5 단계 0: flatShading 해제. flatShading 은 프래그먼트 도함수로 노멀을 재계산해
  //   프로토에 구운 구체 노멀(bakeSphericalNormals)을 무효화한다(docs/tree-look.md §3.6-3).
  //   해제하면 수관이 하나의 둥근 매스로 셰이딩되고 프레넬 림이 덩이 가장자리를 연속으로 흐른다.
  //   프로그램 개수는 불변이고 FLAT_SHADED 정의가 빠져 cacheKey 패밀리만 한 번 갈린다.
  //   암괴(assembleGranite)는 준(皴)의 각진 질감이 대비축이므로 flatShading 을 유지한다.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0, flatShading: false });
  injectCloudShadow(mat, cloudU);
  const insts = [];
  const build = (proto, matBuf, colBuf, name) => {
    const count = matBuf.length / 16;
    if (!count) return;
    const inst = new THREE.InstancedMesh(proto, mat, count);
    inst.instanceMatrix = new THREE.InstancedBufferAttribute(matBuf, 16);
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceColor = new THREE.InstancedBufferAttribute(colBuf.summer.slice(), 3);
    inst.name = name; inst.castShadow = true; inst.receiveShadow = true; inst.frustumCulled = false;
    group.add(inst); insts.push({ inst, colBuf });
  };
  build(makeConiferProto(), treeC.pineMat, treeC.pineCol, 'forest-pine');
  build(makeBroadleafProto(), treeC.broadMat, treeC.broadCol, 'forest-broad');
  // #137 원경 LOD: nearR 밖 산나무 클러스터 블롭(단일 병합 FAR 메시 = 소나무·활엽 통합, +1 드로우콜).
  //   계절색은 클러스터 평균이 perInstance 4버퍼로 실려 setSeason 이 다른 메시들과 동일하게 스왑.
  if (treeC.farMat && treeC.farMat.length) build(makeCanopyBlobProto(), treeC.farMat, treeC.farCol, 'forest-far');
  const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
  const setSeason = (name) => {
    const se = SEASONS.includes(name) ? name : 'summer';
    for (const it of insts) {
      it.inst.instanceColor.array.set(it.colBuf[se]);
      it.inst.instanceColor.needsUpdate = true;
    }
  };
  return { group, setSeason, count: treeC.pineCount + treeC.broadCount, pineCount: treeC.pineCount, broadCount: treeC.broadCount, farCount: treeC.farCount || 0, ridgePine: treeC.ridgePine, triCount: treeC.triCount };
}
// 화강암: 단일 InstancedMesh(perInstance 색). rockC = 크런치 산출. proto 는 메인에서 결정론 생성.
function assembleGranite(rockC, cloudU, protoSeed) {
  if (!rockC || !rockC.count) return null;
  const proto = makeCragProto((protoSeed ^ 0x5a17c0) >>> 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, flatShading: true });
  injectCloudShadow(mat, cloudU);
  const inst = new THREE.InstancedMesh(proto, mat, rockC.count);
  inst.instanceMatrix = new THREE.InstancedBufferAttribute(rockC.mat, 16);
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor = new THREE.InstancedBufferAttribute(rockC.col, 3);
  inst.instanceColor.needsUpdate = true;
  inst.name = 'forest-rocks';
  inst.castShadow = true; inst.receiveShadow = true; inst.frustumCulled = false;
  return { mesh: inst, anchors: rockC.anchors, count: rockC.count, ridgeCount: rockC.ridgeCount };
}

// ───────────────────────── 최상위 ─────────────────────────
// buildForest(plan, site, warp, mask, cloudU, clearDist, precomputed)
//   precomputed(#123): 워커가 계산한 { trees, rocks } 버퍼. 있으면 크런치 생략(메인 스레드 조립만).
//   없으면 메인에서 crunchForest 실행(?worker=0·동기 createVillage·shoot 도구 경로 — 결정론 동일).
export function buildForest(plan, site, warp, mask, cloudU, clearDist, precomputed) {
  const group = new THREE.Group(); group.name = 'village-forest';
  const seed = ((plan.seed || 0) ^ 0x0f03e5) >>> 0;

  const crunch = precomputed || crunchForest(plan, site, { warp, mask, clearDist });
  const trees = assembleTrees(crunch.trees, cloudU);
  if (trees) group.add(trees.group);
  // 화강암 proto 시드는 원본과 동일하게 granite 시드((forestSeed^0xb2))에서 파생해야 한다(byte-identical).
  const rocks = assembleGranite(crunch.rocks, cloudU, (seed ^ 0xb2) >>> 0);
  if (rocks) group.add(rocks.mesh);

  let drawCalls = 0;
  if (trees) drawCalls += trees.group.children.length;
  if (rocks) drawCalls++;

  const setSeason = (name) => { trees?.setSeason(name); };
  const setHaze = (_c) => { /* v2: 나무는 씬 fog 로 원경 페이드 */ };
  setSeason('summer');

  group.userData = {
    drawCalls,
    treeCount: trees ? trees.count : 0,
    pineCount: trees ? trees.pineCount : 0,
    broadCount: trees ? trees.broadCount : 0,
    farCount: trees ? trees.farCount : 0,
    treeTris: trees ? trees.triCount : 0,
    shellVertexCount: 0, shellFaceCount: 0,
    rockCount: rocks ? rocks.count : 0,
    ridgeRockCount: rocks ? rocks.ridgeCount : 0,
    rockAnchors: rocks ? rocks.anchors : [],
    setSeason, setHaze,
  };
  return {
    group, setSeason, setHaze, drawCalls,
    treeCount: trees ? trees.count : 0,
    treeTris: trees ? trees.triCount : 0,
    shellVertexCount: 0, shellFaceCount: 0,
    rockCount: rocks ? rocks.count : 0,
    ridgeRockCount: rocks ? rocks.ridgeCount : 0,
    rockAnchors: rocks ? rocks.anchors : [],
  };
}

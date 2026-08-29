// 링-청크 분할 — 도성 스케일 성능 코어(#47, 설계 노트 #56 웨이브 접점).
//   문제: 현 populate 는 정규 주택을 전역 InstancedMesh(재질별)로, 담·랜드마크를 전역 mergeStatic
//   으로 묶는다 → 각 메시의 바운딩이 마을 전체를 덮어 three.js frustum culling 이 절대 안 걸린다
//   (실측: aerial calls == eye calls). 도성 4배에선 화면 밖 절반도 매 프레임 제출돼 GPU 낭비.
//
//   해법: 앵커(분지 중심) 기준 방사 링 × 섹터로 필지를 공간 분할한다. 각 청크를 독립 그룹(자체
//   InstancedMesh + 자체 병합 담)으로 지으면 바운딩이 청크 크기로 좁아져 컬링이 살아난다. 청크는
//   컬링 단위이자 향후 리롤 웨이브(#56)의 방사 단위(중심→밖 order) 이기도 하다.
//
//   드로우콜 트레이드오프: 청크마다 (존재 변주 × 재질) 만큼 드로우콜이 늘지만, 같은 공간 셀은
//   신분(rank) 그라디언트가 좁아 변주·종류가 몰려 실제 증가는 완만하다. 소규모(≤70호)는 단일
//   청크로 유지해 기존 4종 규모의 드로우콜·룩을 회귀 없이 보존한다(sectorsFor 참조).

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 링 폭(m). ringW=150 이면 capital(bowlR≈148)까지는 링 0 하나 → 단일 청크(회귀 안전),
//   hanyang(bowlR≈296)만 링 0/1 로 갈린다.
const RING_W = 150;
const MAX_ARC_SECTORS = 24;

// 링 내 섹터(각) 분할 수 — 필지 수 함수. ≤70 이면 1(단일: 소규모·중심 응집 보존),
//   그 이상은 ~40호당 1섹터로 쪼개되 6 상한(과도한 드로우콜 방지).
function sectorsFor(count) {
  if (count <= 70) return 1;
  return clamp(Math.ceil(count / 40), 2, 6);
}

// partitionParcels(parcels, anchor, opts) → chunks[]
//   chunk: { key, ring, sector, parcels[], center:{x,z}, boundingRadius, dist, order, far }
//   · center/boundingRadius: 컬링·정렬용(청크 바운딩 구).
//   · dist: 앵커에서 청크 중심까지 거리 — order(웨이브 순서, 중심→밖) 산출.
//   · opts.maxArcLength: 유한한 값이면 링의 최대 호 길이를 제한한다. 컬링 바운드와
//     런타임 LOD 교체 단위가 마을 반대편까지 넓어지지 않게 한다.
//     상한을 생략하면 기존 count 기반 분할을 그대로 보존한다.
//   · far: 가장 가까운 필지 footprint가 opts.farDist 밖인지 나타내는 공간 메타데이터.
//     한양의 런타임 LOD는 중앙·외곽 모두에 적용되며, 이 값은 분할 계약/분석/하위호환용이다.
//     중심점 거리는 반대편 필지끼리 상쇄될 수 있어 카메라 LOD 경계로 쓰지 않는다.
export function partitionParcels(parcels, anchor, opts = {}) {
  const ringW = opts.ringW || RING_W;
  const farDist = opts.farDist != null ? opts.farDist : Infinity;
  const maxArcLength = Number.isFinite(opts.maxArcLength) && opts.maxArcLength > 0
    ? opts.maxArcLength
    : Infinity;
  const withPolar = parcels.map((p) => {
    const dx = p.center.x - anchor.x, dz = p.center.z - anchor.z;
    const r = Math.hypot(dx, dz);
    return { p, r, th: Math.atan2(dz, dx), ring: Math.floor(r / ringW) };
  });
  const ringCount = new Map();
  for (const e of withPolar) ringCount.set(e.ring, (ringCount.get(e.ring) || 0) + 1);

  const chunks = new Map();
  for (const e of withPolar) {
    // count 기반 분할은 소규모의 기존 출력을 보존한다. 카메라 LOD를 쓰는 호출자만
    // maxArcLength를 넘겨 청크 중심과 필지가 너무 멀어지지 않도록 방위 분할을 추가한다.
    // 링은 [ring*ringW, (ring+1)*ringW)이므로 중간 반지름으로 필요 섹터 수를 계산한다.
    let nsec = sectorsFor(ringCount.get(e.ring));
    if (e.ring > 0 && Number.isFinite(maxArcLength)) {
      const arcSectors = Math.ceil(TAU * (e.ring + 0.5) * ringW / maxArcLength);
      nsec = clamp(Math.max(nsec, arcSectors), 1, MAX_ARC_SECTORS);
    }
    const sector = nsec === 1 ? 0 : Math.floor(((e.th + Math.PI) / TAU) * nsec) % nsec;
    const key = e.ring * 100 + sector;
    let c = chunks.get(key);
    if (!c) { c = { key, ring: e.ring, sector, parcels: [] }; chunks.set(key, c); }
    c.parcels.push(e.p);
  }

  const out = [];
  for (const c of chunks.values()) {
    let sx = 0, sz = 0;
    for (const p of c.parcels) { sx += p.center.x; sz += p.center.z; }
    const n = c.parcels.length;
    const cx = sx / n, cz = sz / n;
    let rad = 0, nearestFootprint = Infinity;
    for (const p of c.parcels) {
      const footprint = Math.hypot(p.plotW || 10, p.plotD || 10) * 0.5;
      const d = Math.hypot(p.center.x - cx, p.center.z - cz) + footprint;
      if (d > rad) rad = d;
      nearestFootprint = Math.min(nearestFootprint,
        Math.hypot(p.center.x - anchor.x, p.center.z - anchor.z) - footprint);
    }
    c.center = { x: cx, z: cz };
    c.boundingRadius = rad;
    c.dist = Math.hypot(cx - anchor.x, cz - anchor.z);
    c.far = nearestFootprint > farDist;
    out.push(c);
  }
  out.sort((a, b) => a.dist - b.dist);   // 중심→밖(웨이브 sweep 순서)
  out.forEach((c, i) => { c.order = i; });
  return out;
}

// 카메라와 청크가 실제로 소유한 필지 중심 사이의 최소 거리. centroid는 반대편 필지끼리
// 상쇄될 수 있으므로 런타임 LOD 근접 판정에 쓰지 않는다. y를 주면 필지 대지(baseY)까지의
// 3D 거리를 써 부감 카메라가 수평상 가까운 외곽 청크를 불필요하게 풀디테일로 바꾸지 않는다.
// y 생략은 기존 순수 XZ 계약을 보존한다. 매 프레임 호출되므로 임시 Vector나 배열을 만들지 않는다.
export function chunkLodDistance(chunk, x, z, y) {
  const parcels = chunk?.parcels;
  if (parcels?.length) {
    const useY = Number.isFinite(y);
    let minSq = Infinity;
    for (const parcel of parcels) {
      const dx = x - parcel.center.x;
      const dz = z - parcel.center.z;
      const dy = useY ? y - (parcel.baseY || 0) : 0;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < minSq) minSq = dSq;
    }
    return Math.sqrt(minSq);
  }
  const center = chunk?.center || chunk;
  return center ? Math.hypot(x - center.x, z - center.z) : Infinity;
}

// 여러 청크의 종류별 은닉 핸들을 하나의 API 로 합친다(픽킹·편집이 id 로 필지를 은닉).
//   각 청크 buildHouseInstances 그룹의 userData(setHidden/isHidden/locate)를 id→청크핸들 맵으로.
export function combineHouseHandles(kind, groups) {
  const owner = new Map();   // parcelId -> 같은 필지를 표현하는 tier별 그룹 userData[]
  for (const gp of groups) {
    const uh = gp.userData;
    if (!uh || !uh.locate) continue;
    for (const id of uh.locate.keys()) {
      let list = owner.get(id);
      if (!list) { list = []; owner.set(id, list); }
      list.push(uh);
    }
  }
  return {
    kind,
    locate: owner,
    setHidden(id, on) {
      const list = owner.get(id);
      if (list) for (const uh of list) uh.setHidden(id, on);
    },
    setExportHidden(id, on) {
      const list = owner.get(id);
      if (list) for (const uh of list) uh.setExportHidden?.(id, on);
    },
    isHidden(id) {
      const list = owner.get(id);
      return list?.length ? list.every((uh) => uh.isHidden(id)) : false;
    },
    isExportHidden(id) {
      const list = owner.get(id);
      return list?.length ? list.every((uh) => uh.isExportHidden?.(id)) : false;
    },
  };
}

// 여러 청크의 병합 소스(mergeStatic ids 또는 임포스터 필지 레인지) 은닉 핸들을 하나로 합친다.
// 각 그룹 userData(setHidden/isHidden/srcIds)를 id→소유 그룹으로 디스패치한다.
export function combineSourceHideHandles(groups) {
  const owner = new Map();   // parcelId -> 소스 그룹 userData
  for (const gp of groups) {
    const uh = gp && gp.userData;
    if (!uh || !uh.srcIds) continue;
    for (const id of uh.srcIds) owner.set(id, uh);
  }
  return {
    locate: owner,
    setHidden(id, on) { const uh = owner.get(id); if (uh) uh.setHidden(id, on); },
    setExportHidden(id, on) { const uh = owner.get(id); if (uh) uh.setExportHidden?.(id, on); },
    isHidden(id) { const uh = owner.get(id); return uh ? uh.isHidden(id) : false; },
    isExportHidden(id) { const uh = owner.get(id); return uh ? uh.isExportHidden?.(id) === true : false; },
  };
}

export function combineWallHandles(groups) {
  return combineSourceHideHandles(groups);
}

import { CHUNK_LOD_LEVEL } from '../../village/lod-policy.js';

// 정규 필지의 부감 표현은 FAR mass·MID/FULL 인스턴스·병합 담의 여러 경로에 걸쳐 있다.
// 오버레이가 소유권을 얻거나 돌려줄 때 반드시 한 함수로 함께 전환해 중복/잔상을 막는다.
export function setParcelBaseHidden(handle, parcel, hidden) {
  if (!handle || !parcel) return false;
  const houses = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga'];
  const sources = [
    houses?.userData,
    handle.walls,
    handle.impostors,
    handle.auxiliaries,
  ];
  let changed = false;
  for (const source of sources) {
    if (!source?.setHidden) continue;
    if (source.isHidden?.(parcel.id) === hidden) continue;
    source.setHidden(parcel.id, hidden);
    changed = true;
  }
  return changed;
}

// A persistent edited overlay owns exported architecture as well as live
// presentation. Unlike setParcelBaseHidden, this updates only the immutable GLB
// source snapshots; transient focus must never call it.
export function setParcelBaseExportHidden(handle, parcel, hidden) {
  if (!handle || !parcel) return false;
  const houses = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga'];
  const sources = [
    houses?.userData,
    handle.walls,
    handle.impostors,
    handle.auxiliaries,
  ];
  let changed = false;
  for (const source of sources) {
    if (!source?.setExportHidden) continue;
    if (source.isExportHidden?.(parcel.id) === hidden) continue;
    source.setExportHidden(parcel.id, hidden);
    changed = true;
  }
  return changed;
}

// 검증·디버그가 정책값만 보며 자기검증하지 않도록 실제 은닉 핸들과 청크 루트 가시성을 읽는다.
// 안정 상태는 한 표현, 짧은 screen-door 이행은 인접 두 표현, overlay는 다시 단독 소유다.
export function parcelRepresentationState(handle, parcel, overlayVisible = false) {
  if (!handle || !parcel) return null;
  const houses = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga']?.userData;
  const impostors = handle.impostors;
  const auxiliaries = handle.auxiliaries;
  const impostorOwner = impostors?.locate?.get(parcel.id) || null;
  const auxiliaryOwner = auxiliaries?.locate?.get(parcel.id) || null;
  const lod = impostorOwner?.lod || null;
  const level = lod?.level || CHUNK_LOD_LEVEL.FULL;
  const baseHidden = houses?.isHidden(parcel.id) === true;
  const wallHidden = handle.walls?.isHidden(parcel.id) === true;
  const impostorHidden = impostors?.isHidden(parcel.id) === true;
  const auxiliaryHidden = auxiliaries?.isHidden(parcel.id) === true;
  const auxiliaryPresent = !!auxiliaryOwner;
  const auxiliaryVisible = auxiliaryPresent && !auxiliaryHidden;
  const fullRootVisible = lod?.fullRoot ? lod.fullRoot.visible : true;
  const farRootVisible = lod?.farRoot ? lod.farRoot.visible
    : lod?.impostorRoot ? lod.impostorRoot.visible : false;
  const midRootVisible = lod?.midRoot ? lod.midRoot.visible : false;
  const fullDetail = fullRootVisible && !baseHidden;
  const midDetail = midRootVisible && !baseHidden;
  const farMass = farRootVisible && !impostorHidden;
  const impostor = farMass;   // 하위호환 디버그 이름
  const overlay = !!overlayVisible;
  const representations = Number(fullDetail) + Number(midDetail) + Number(farMass) + Number(overlay);
  const tierOwners = [];
  if (farMass) tierOwners.push(CHUNK_LOD_LEVEL.FAR);
  if (midDetail) tierOwners.push(CHUNK_LOD_LEVEL.MID);
  if (fullDetail) tierOwners.push(CHUNK_LOD_LEVEL.FULL);
  const transition = lod?.transition || null;
  const transitionActive = transition?.active === true;
  const weights = lod?.weights || {
    far: level === CHUNK_LOD_LEVEL.FAR ? 1 : 0,
    mid: level === CHUNK_LOD_LEVEL.MID ? 1 : 0,
    full: level === CHUNK_LOD_LEVEL.FULL ? 1 : 0,
  };
  const adjacent = (transition?.from === CHUNK_LOD_LEVEL.FAR && transition?.to === CHUNK_LOD_LEVEL.MID)
    || (transition?.from === CHUNK_LOD_LEVEL.MID && transition?.to === CHUNK_LOD_LEVEL.FAR)
    || (transition?.from === CHUNK_LOD_LEVEL.MID && transition?.to === CHUNK_LOD_LEVEL.FULL)
    || (transition?.from === CHUNK_LOD_LEVEL.FULL && transition?.to === CHUNK_LOD_LEVEL.MID);
  const transitionWeight = transitionActive
    ? weights[transition.from] + weights[transition.to] : 0;
  const stableValid = !transitionActive && tierOwners.length === 1
    && tierOwners[0] === level && weights[level] === 1;
  const transitionValid = transitionActive && adjacent && tierOwners.length === 2
    && tierOwners.includes(transition.from) && tierOwners.includes(transition.to)
    && weights[transition.from] > 0 && weights[transition.to] > 0
    && Math.abs(transitionWeight - 1) < 1e-6;
  const overlayValid = overlay && representations === 1
    && baseHidden && wallHidden
    && (!impostorOwner || impostorHidden)
    && (!auxiliaryOwner || auxiliaryHidden);
  const valid = overlay ? overlayValid : representations === tierOwners.length
    && (transitionActive ? transitionValid : stableValid);

  return {
    parcelId: parcel.id,
    chunkId: lod?.chunkId || null,
    level,
    distance: Number.isFinite(lod?.distance) ? +lod.distance.toFixed(3) : null,
    // 검증 하네스가 특정 LOD 밴드로 카메라를 물릴 때 키 식(렌즈 보정 × 시선 피치 상세 깊이)을
    // 복제하지 않고 런타임이 실제로 쓴 물리↔키 환산비를 읽을 수 있도록 함께 노출한다.
    physicalDistance: Number.isFinite(lod?.physicalDistance)
      ? +lod.physicalDistance.toFixed(3) : null,
    detailReach: Number.isFinite(lod?.detailReach) ? lod.detailReach : null,
    swapIn: lod?.swapIn ?? null,
    swapOut: lod?.swapOut ?? null,
    far: !!impostorOwner,
    fullRootVisible, midRootVisible, farRootVisible,
    impostorRootVisible: farRootVisible,
    fullDetail,
    midDetail,
    farMass,
    impostor,
    overlay,
    owners: overlay ? ['overlay'] : tierOwners,
    weights: { far: weights.far, mid: weights.mid, full: weights.full },
    transition: transitionActive ? {
      active: true,
      from: transition.from,
      to: transition.to,
      progress: transition.progress,
      direction: transition.direction,
    } : { active: false, from: null, to: null, progress: 0, direction: 0 },
    baseHidden,
    wallHidden,
    impostorHidden,
    auxiliaryPresent,
    auxiliaryHidden,
    auxiliaryVisible,
    representations,
    valid,
  };
}

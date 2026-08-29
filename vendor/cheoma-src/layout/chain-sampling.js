// 지붕면 상단 폴리라인을 고정된 segment 수로 나누되, 모든 원래 꺾임점을 보존한다.
// 꺾임점을 잃으면 인접 face의 마루 경계가 서로 다른 chord가 되어 지붕 사이가 벌어진다.

const planDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function resampleChainPreservingKnots(chain, segmentCount) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new TypeError('chain must contain at least one point');
  }
  if (!Number.isInteger(segmentCount) || segmentCount < 1) {
    throw new RangeError('segmentCount must be a positive integer');
  }
  if (chain.length === 1) {
    return Array.from({ length: segmentCount + 1 }, () => ({ ...chain[0] }));
  }

  const lengths = [];
  let total = 0;
  for (let i = 0; i + 1 < chain.length; i++) {
    const length = planDistance(chain[i], chain[i + 1]);
    lengths.push(length);
    total += length;
  }
  if (total < 1e-6) {
    return Array.from({ length: segmentCount + 1 }, () => ({ ...chain[0] }));
  }
  if (segmentCount < lengths.length) {
    throw new RangeError('segmentCount must cover every chain segment');
  }

  // 각 원래 구간에 하나씩 먼저 배정한 뒤, 현재 표본 간격이 가장 긴 구간을 반복 분할한다.
  // 총 정점 수는 기존과 같고 짧은 꺾임 구간도 사라지지 않는다.
  const counts = lengths.map(() => 1);
  for (let used = counts.length; used < segmentCount; used++) {
    let split = 0;
    for (let i = 1; i < counts.length; i++) {
      if (lengths[i] / counts[i] > lengths[split] / counts[split]) split = i;
    }
    counts[split]++;
  }

  const out = [{ ...chain[0] }];
  for (let i = 0; i < counts.length; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    for (let step = 1; step <= counts[i]; step++) {
      const t = step / counts[i];
      out.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        h: a.h + (b.h - a.h) * t,
      });
    }
  }
  return out;
}

// BufferAttribute upload ownership. Ranges use typed-array component units,
// matching Three's addUpdateRange(start, count) contract.
export function markAttributeRange(attribute, start, count) {
  const length = attribute?.array?.length || 0;
  if (!Number.isFinite(start) || !Number.isFinite(count)) return false;
  const requestedStart = Math.trunc(start);
  const requestedEnd = requestedStart + Math.max(0, Math.trunc(count));
  const first = Math.min(length, Math.max(0, requestedStart));
  const end = Math.min(length, Math.max(0, requestedEnd));
  if (!length || end <= first) return false;

  if (first === 0 && end === length) attribute.clearUpdateRanges();
  attribute.addUpdateRange(first, end - first);
  attribute.needsUpdate = true;
  return true;
}

export function markAttributeItems(attribute, firstItem, itemCount = 1) {
  const itemSize = attribute?.itemSize || 0;
  return markAttributeRange(attribute, firstItem * itemSize, itemCount * itemSize);
}

export function markAttributeFull(attribute) {
  return markAttributeRange(attribute, 0, attribute?.array?.length || 0);
}

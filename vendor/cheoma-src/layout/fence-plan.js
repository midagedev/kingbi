// Pure polyline/opening splitter for layout fences. Rendering and semantic
// occlusion consume the same spans so an invisible wall cannot cover a visible
// gate or leave a rendered wall click-through.

export function planFenceRuns(points, { closed = false, openings = [] } = {}) {
  const vertices = (points || []).map((point) => ({ x: point.x, z: point.z }));
  const segmentCount = closed ? vertices.length : Math.max(0, vertices.length - 1);
  const segments = [];
  const resolvedOpenings = [];
  for (let index = 0; index < segmentCount; index++) {
    const a = vertices[index], b = vertices[(index + 1) % vertices.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length <= 0) continue;
    const rotationY = Math.atan2(-dz, dx);
    const gaps = openings.filter((opening) => opening.seg === index)
      .map((opening) => {
        const center = opening.center * length;
        return {
          start: center - opening.width * 0.5,
          end: center + opening.width * 0.5,
          opening,
        };
      })
      .sort((left, right) => left.start - right.start);
    for (const gap of gaps) {
      const center = (gap.start + gap.end) * 0.5;
      resolvedOpenings.push({
        position: { x: a.x + dx * center / length, z: a.z + dz * center / length },
        rotationY,
        width: gap.opening.width,
        seg: index,
      });
    }
    let cursor = 0;
    const runs = [];
    for (const gap of gaps) {
      if (gap.start - cursor > 0.05) runs.push({ start: cursor, end: gap.start });
      cursor = Math.max(cursor, gap.end);
    }
    if (length - cursor > 0.05) runs.push({ start: cursor, end: length });
    segments.push({ index, a, b, dx, dz, length, rotationY, runs });
  }
  return { vertices, segments, openings: resolvedOpenings };
}

// 반가 안채의 순수 평면 생성기. single=ㅡ자 / l=ㄱ자 / u=ㄷ자.
// 렌더러와 분리해 편집 UI와 지붕 형상 계약이 같은 footprint를 검증할 수 있게 한다.

export function hanokFootprint(shape = 'l', bays = 3) {
  const nb = Math.max(2, Math.min(4, Math.round(bays || 3)));
  const bayW = 10 / 3;               // bays=3이면 본채 폭 10m
  const halfW = (nb * bayW) / 2;
  const halfD = 2.6;
  const wingLen = 5.4;

  if (shape === 'single') {
    return [
      { x: -halfW, z: -halfD }, { x: halfW, z: -halfD },
      { x: halfW, z: halfD }, { x: -halfW, z: halfD },
    ];
  }
  if (shape === 'u') {
    const wingW = Math.min(3.6, halfW - 1.2);
    return [
      { x: -halfW, z: -halfD }, { x: halfW, z: -halfD },
      { x: halfW, z: halfD + wingLen }, { x: halfW - wingW, z: halfD + wingLen },
      { x: halfW - wingW, z: halfD }, { x: -halfW + wingW, z: halfD },
      { x: -halfW + wingW, z: halfD + wingLen }, { x: -halfW, z: halfD + wingLen },
    ];
  }

  const wingW = Math.min(3.6, 2 * halfW - 2);
  return [
    { x: -halfW, z: -halfD }, { x: halfW, z: -halfD }, { x: halfW, z: halfD },
    { x: -halfW + wingW, z: halfD }, { x: -halfW + wingW, z: halfD + wingLen },
    { x: -halfW, z: halfD + wingLen },
  ];
}

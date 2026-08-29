// 유형별 소품(props) 라이브러리 진입점.
// buildProp(name, opts) → THREE.Group. 시드 결정론(makeRng). 재질은 공유 인스턴스.
// 도시 생성기가 PROP_SETS로 유형별 샘플링해 필지·공용부에 배치한다.
import { buildPagoda, buildStoneLantern, buildDanggan, buildBudo } from './temple.js';
import { buildHaetae, buildDeumeu, buildRankStones, buildDingCenser } from './palace.js';
import { buildJangdokdae, buildWell, buildSteppingStones, buildGardenRock, buildStoneWall } from './giwa.js';
import { buildHaystack, buildMortarPestle, buildJige, buildBrushFence, buildChickenCoop } from './choga.js';
import { buildJangseung, buildJangseungPair, buildSotdae, buildStrawMat } from './common.js';

// 이름 → 빌더 레지스트리
export const PROP_BUILDERS = {
  // 절
  'pagoda': buildPagoda,
  'stone-lantern': buildStoneLantern,
  'danggan': buildDanggan,
  'budo': buildBudo,
  // 궁
  'haetae': buildHaetae,
  'deumeu': buildDeumeu,
  'rank-stones': buildRankStones,
  'ding-censer': buildDingCenser,
  // 기와집
  'jangdokdae': buildJangdokdae,
  'well': buildWell,
  'stepping-stones': buildSteppingStones,
  'garden-rock': buildGardenRock,
  'stone-wall': buildStoneWall,
  // 초가
  'haystack': buildHaystack,
  'mortar-pestle': buildMortarPestle,
  'jige': buildJige,
  'brush-fence': buildBrushFence,
  'chicken-coop': buildChickenCoop,
  // 공용
  'jangseung': buildJangseung,
  'jangseung-pair': buildJangseungPair,
  'sotdae': buildSotdae,
  'straw-mat': buildStrawMat,
};

// 유형별 세트 (도시 생성기가 샘플링)
export const PROP_SETS = {
  temple: ['pagoda', 'stone-lantern', 'danggan', 'budo'],
  palace: ['haetae', 'deumeu', 'rank-stones', 'ding-censer'],
  giwa: ['jangdokdae', 'well', 'stepping-stones', 'garden-rock', 'stone-wall'],
  choga: ['haystack', 'mortar-pestle', 'jige', 'brush-fence', 'chicken-coop'],
  common: ['jangseung-pair', 'sotdae', 'straw-mat'],
};

// 한글 라벨 (쇼케이스·UI)
export const PROP_LABELS = {
  'pagoda': '삼층석탑', 'stone-lantern': '석등', 'danggan': '당간지주', 'budo': '부도',
  'haetae': '해태', 'deumeu': '드므', 'rank-stones': '품계석', 'ding-censer': '정(鼎) 향로',
  'jangdokdae': '장독대', 'well': '우물', 'stepping-stones': '디딤돌 길', 'garden-rock': '정원석', 'stone-wall': '석축',
  'haystack': '낟가리', 'mortar-pestle': '절구·공이', 'jige': '지게', 'brush-fence': '싸리 울타리', 'chicken-coop': '닭장',
  'jangseung': '장승', 'jangseung-pair': '장승 한 쌍', 'sotdae': '솟대', 'straw-mat': '멍석',
};

// buildProp('pagoda', { seed, scale, ...opts }) → THREE.Group
export function buildProp(name, opts = {}) {
  const fn = PROP_BUILDERS[name];
  if (!fn) throw new Error(`buildProp: unknown prop "${name}"`);
  const g = fn(opts);
  g.userData.propName = name;
  return g;
}

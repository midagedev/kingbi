import { smoothstep } from '../../core/math/scalar.js';
import * as THREE from 'three';
import { sampleRoadSurface } from '../../village/road-surface.js';
import { createPackedEarthTile } from '../../surfaces/packed-earth.js';
import { createPackedEarthTextures } from '../../surfaces/packed-earth-textures.js';

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
// ───────────────────────── 도로 ─────────────────────────
// 도로 폴리라인을 지면에 밟힌 흙 리본으로. 등급별 폭(경국대전). 지형에 살짝 띄워 z-fighting 방지.
// 로드 톤 뮤트(#78): 도로가 급사면(좌청룡·우백호 측면 능선 등)을 직선으로 오를 때 생기는
//   인위적 "베이지 띠"를 없앤다. vertexColors 로 평지=밟힌 흙(기존색 그대로), 급사면일수록 주변
//   지형색(초지→숲)에 근접시켜 산자락에 녹인다. 완사면(대부분 도로)은 무변 → 타 규모 룩 회귀 0.
const R_BEIGE = linCol(0x9a8b70);   // 평지 도로(밟힌 흙) — 기존값
const R_GRASS = linCol(0x676f45);   // 지형 초지(buildSiteTerrain 과 동일 톤)
const R_FOREST = linCol(0x435a2a);  // 지형 숲(능선)
const ROAD_TEXTURE_METERS = 16;
const ROAD_TEXTURE_COS = 0.8910065242; // 27°: avoid axis-aligned bands on N–S/E–W roads.
const ROAD_TEXTURE_SIN = 0.4539904997;
const PACKED_EARTH_SOURCE = createPackedEarthTile();
export function buildRoads(site, roads) {
  const group = new THREE.Group(); group.name = 'village-roads';
  const tmp = new THREE.Color(), terr = new THREE.Color();
  const roadColAt = (x, z, level, out) => {
    const hill = site.hillAt(x, z);
    // 도성 대로는 길찾기·구도 축이라 흙색을 유지하고, 산속의 작은 길일수록 지형에 더 녹인다.
    // 같은 리본 안에서 초록 얼룩이 구멍처럼 읽히지 않도록 등급별 상한을 둔다.
    const muteK = level === 'daero' ? 0 : level === 'jungno' ? 0.25 : 0.8;
    const mute = smoothstep(0.30, 0.60, hill) * muteK;
    if (mute <= 0) return out.copy(R_BEIGE);
    terr.copy(R_GRASS).lerp(R_FOREST, smoothstep(0.06, 0.55, hill));
    return out.copy(R_BEIGE).lerp(terr, mute);
  };
  const pos = [], col = [], uv = [], idx = [];
  // terrain-cell 경계에서 이웃 clip 조각이 공유하는 정점을 재사용한다. level을 key에 포함해
  // 서로 다른 등급(색)의 겹친 길이 한 정점으로 섞이지 않게 한다.
  const pointIndex = new Map();
  const addPoint = (point, level) => {
    const key = `${level}:${point.x.toFixed(6)}:${point.y.toFixed(6)}:${point.z.toFixed(6)}`;
    const found = pointIndex.get(key);
    if (found != null) return found;
    const index = pos.length / 3;
    pos.push(point.x, point.y, point.z);
    roadColAt(point.x, point.z, level, tmp); col.push(tmp.r, tmp.g, tmp.b);
    // World-space UV keeps one continuous grain frame across strips, joins, and road levels.
    uv.push(
      (point.x * ROAD_TEXTURE_COS + point.z * ROAD_TEXTURE_SIN) / ROAD_TEXTURE_METERS,
      (-point.x * ROAD_TEXTURE_SIN + point.z * ROAD_TEXTURE_COS) / ROAD_TEXTURE_METERS,
    );
    pointIndex.set(key, index);
    return index;
  };
  for (const road of roads) {
    if (road.pts.length < 2) continue;
    const { strips, joins } = sampleRoadSurface(site, road);
    if (!strips.length) continue;
    const addTriangle = (triangle) => idx.push(...triangle.map((point) => addPoint(point, road.level)));
    for (const strip of strips) for (const triangle of strip.triangles) addTriangle(triangle);
    for (const join of joins) for (const triangle of join.triangles) addTriangle(triangle);
  }
  if (!idx.length) return group;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const packedEarth = createPackedEarthTextures(PACKED_EARTH_SOURCE);
  // Vertex colour still owns road hierarchy and slope muting. The neutral map adds only
  // compacted-earth variation; bump uses the same scale without extra geometry or materials.
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: packedEarth.albedo,
    bumpMap: packedEarth.height,
    bumpScale: 0.08,
    roughness: 1,
    metalness: 0,
  });
  roadMat.name = 'packed-earth-road';
  // Kept visibly trodden during snowfall; terrain/roof accumulation still surrounds it.
  // This also avoids a dedicated map+bump+vertexColor snow program family for one flat plane.
  roadMat.userData.snowSurface = false;
  const mesh = new THREE.Mesh(geo, roadMat);
  mesh.name = 'village-roads-m0';
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

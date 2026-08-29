import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 소품 조립기(Kit): 원시 지오메트리를 재질별 버킷에 모았다가 build()에서 재질당 하나로 병합.
// → 소품 하나가 재질 수만큼의 메시(수 개)로 압축되어 드로우콜이 적고 도시 인스턴싱에 유리.
// 재질은 materials.js의 공유 인스턴스를 참조하므로 소품 수백 개가 재질을 공유한다.
export class Kit {
  constructor(materials) {
    this.mats = materials;
    this.buckets = new Map(); // matKey -> { material, geoms: [] }
  }

  _push(matKey, geom, pos, rot, scale) {
    const mat = this.mats[matKey];
    if (!mat) throw new Error(`Kit: unknown material "${matKey}"`);
    let b = this.buckets.get(matKey);
    if (!b) { b = { material: mat, geoms: [] }; this.buckets.set(matKey, b); }
    // 위치·회전·스케일을 지오메트리에 구워 넣어(bake) 병합 대비
    const s = Array.isArray(scale) ? scale : [scale, scale, scale];
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(pos[0] || 0, pos[1] || 0, pos[2] || 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0)),
      new THREE.Vector3(s[0], s[1], s[2])
    );
    // uv/normal 속성 보장(병합은 속성 구성이 같아야 함)
    if (!geom.getAttribute('uv')) {
      const n = geom.getAttribute('position').count;
      geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (!geom.getAttribute('normal')) geom.computeVertexNormals();
    geom.applyMatrix4(m);
    b.geoms.push(geom);
    return this;
  }

  // pos:[x,y,z], rot:[rx,ry,rz], scale:number|[sx,sy,sz]
  box(matKey, w, h, d, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    return this._push(matKey, new THREE.BoxGeometry(w, h, d), pos, rot, scale);
  }
  cyl(matKey, rTop, rBot, h, seg = 8, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1, opts = {}) {
    return this._push(matKey, new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, opts.open || false), pos, rot, scale);
  }
  sphere(matKey, r, pos = [0, 0, 0], scale = 1, ws = 8, hs = 6) {
    return this._push(matKey, new THREE.SphereGeometry(r, ws, hs), pos, [0, 0, 0], scale);
  }
  lathe(matKey, pts, seg = 12, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    const v = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    return this._push(matKey, new THREE.LatheGeometry(v, seg), pos, rot, scale);
  }
  torus(matKey, r, tube, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1, rseg = 6, tseg = 14, arc = Math.PI * 2) {
    return this._push(matKey, new THREE.TorusGeometry(r, tube, rseg, tseg, arc), pos, rot, scale);
  }
  cone(matKey, r, h, seg = 8, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    return this._push(matKey, new THREE.ConeGeometry(r, h, seg), pos, rot, scale);
  }
  geom(matKey, geometry, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    return this._push(matKey, geometry, pos, rot, scale);
  }

  build(name = 'prop') {
    const group = new THREE.Group();
    group.name = name;
    for (const [key, b] of this.buckets) {
      if (!b.geoms.length) continue;
      let geo;
      if (b.geoms.length === 1) geo = b.geoms[0];
      else {
        try { geo = mergeGeometries(b.geoms, false); }
        catch { geo = b.geoms[0]; }
      }
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, b.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = key;
      group.add(mesh);
    }
    return group;
  }
}

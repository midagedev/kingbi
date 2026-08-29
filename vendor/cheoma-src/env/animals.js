import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { presentationWeight } from '../core/lod.js';
import { makeRng } from '../rng.js';

// 소동물 확장(태스크 #43): 마당 닭 무리(암탉·병아리·수탉) + 논의 소(한우).
//   setupAnimals(parent, { heightAt, layout, yard, cowSite, seed }) →
//     { update(dt), setTime(name), setSeason(name), setEnabled(bool), setFade(v), setDetail(v), cowAnchor }
//   parent: 환경 group(critters 와 동일). 여기에 animals 서브그룹을 붙여 env ON/OFF 가시성에 묶인다.
//
// 배치 앵커는 인자로 받는다(마을에서도 필지 마당·논 앵커를 주입해 재사용).
//   yard:    { x, z, r }        닭 무리 중심(초가 마당). 없으면 layout 앞마당에서 파생.
//   cowSite: { x, z, yaw }      논/논둑 소 위치. 없으면 소 생략(논 없는 필지). 지면 Y 는
//                               논면(paddyField) 다운캐스트로 정확히 얹고, 실패 시 heightAt.
//
// 스타일: critters.js 와 통일된 로우폴리·복셀풍(box/ico/cone + 균일 vertex color + flatShading).
// 좌표 규약: 모든 모델은 로컬 +X 를 정면으로. 지면 부착은 heightAt(또는 논면 캐스트).
// 모션 원칙(앰비언트): 뼈대 애니 없이 부위 그룹 회전/사인 합성. 무엇도 완전히 정지하지 않되
//   눈에 띄는 큰 동작은 간헐(포아송). 밤엔 닭이 홰 자세로 웅크리고 활동 정지(소는 그대로).

const lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const M4 = () => new THREE.Matrix4();
const TAU = Math.PI * 2;

// 파트에 균일 vertex color 부여 + 비인덱스 통일(merge 안전). uv 는 제거해 속성 세트를 맞춘다.
function tint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = lin(hex);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}
// 파트 배치: 이동 → 회전(z,y) → 스케일 순으로 로컬 변환.
function place(geo, x, y, z, o = {}) {
  const { ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = o;
  const m = M4().makeTranslation(x, y, z);
  if (rz) m.multiply(M4().makeRotationZ(rz));
  if (ry) m.multiply(M4().makeRotationY(ry));
  m.multiply(M4().makeScale(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const ico = (r) => new THREE.IcosahedronGeometry(r, 1);
const cone = (r, h) => new THREE.ConeGeometry(r, h, 5);

// 지수 분포(포아송 간격) — 간헐 이벤트 스케줄. lo/hi 로 클램프.
function poisson(rng, mean, lo, hi) {
  const u = Math.max(1e-6, rng());
  return Math.min(hi, Math.max(lo, -mean * Math.log(u)));
}

// ==================================================================
// 닭 지오메트리 (로컬 +X 정면, y=0 접지). 부위 분리:
//   body = 몸통+다리+꽁지(merge), head = 머리+부리+볏+육수(neck 피벗 기준), wing = 한쪽 날개.
// 반환 앵커로 assembler 가 headPivot/wingPivot 위치를 잡는다.
// ==================================================================
function buildFowl(o) {
  const {
    bodyCol, wingCol, tailCol, combCol, beakCol, legCol,
    bodyR = 0.13, bodyLong = 1.15, upright = 0,     // upright: 자세 세움(수탉↑)
    combTall = 0, wattle = false, tail = true, wings = true, hackle = null,
  } = o;
  const bodyY = 0.17 + bodyR;                        // 몸통 중심 높이(다리 위)
  const neck = { x: 0.06 + bodyR * 0.55, y: bodyY + 0.04 + upright * 0.10, z: 0 };
  const shoulder = { x: 0.0, y: bodyY + 0.02, z: bodyR * 0.72 };

  // --- 몸통 + 다리 + 꽁지 ---
  const P = [];
  // 다리(가는 각): 두 개. 발끝 y=0.
  const legH = 0.17;
  P.push(tint(place(box(0.032, legH, 0.032), 0.02, legH / 2, 0.055), legCol));
  P.push(tint(place(box(0.032, legH, 0.032), 0.02, legH / 2, -0.055), legCol));
  // 발가락(짧은 앞뻗음)
  P.push(tint(place(box(0.075, 0.028, 0.055), 0.055, 0.014, 0.055), legCol));
  P.push(tint(place(box(0.075, 0.028, 0.055), 0.055, 0.014, -0.055), legCol));
  // 몸통(달걀형): 뒤가 통통, 앞가슴 살짝 든다.
  P.push(tint(place(ico(bodyR), 0, bodyY, 0, { sx: bodyLong, sy: 0.98 + upright * 0.12, sz: 0.86 }), bodyCol));
  // 가슴(앞 아래 볼륨)
  P.push(tint(place(ico(bodyR * 0.72), bodyR * 0.62, bodyY - 0.02 + upright * 0.05, 0, { sx: 0.9, sy: 0.9, sz: 0.82 }), bodyCol));
  // 접은 날개(양옆 결) — 몸통에 붙는 정지 실루엣. 홰칠 때 별도 wing 메시가 위로 뜬다.
  P.push(tint(place(box(bodyR * 1.5, bodyR * 0.5, 0.03), -bodyR * 0.15, bodyY, bodyR * 0.86, { rz: 0.06 }), wingCol));
  P.push(tint(place(box(bodyR * 1.5, bodyR * 0.5, 0.03), -bodyR * 0.15, bodyY, -bodyR * 0.86, { rz: 0.06 }), wingCol));
  if (hackle != null) { // 목덜미 깃(수탉 금빛)
    P.push(tint(place(ico(bodyR * 0.6), neck.x - 0.02, neck.y - 0.02, 0, { sx: 0.8, sy: 1.0, sz: 0.9 }), hackle));
  }
  if (upright > 0.5) {
    // 수탉: 위로 휘어 올라가는 낫깃 플룸(가는 깃 여러 겹) — 이질적 수직 슬라브 금지.
    for (const [len, ang, zoff] of [[0.24, 0.62, 0.0], [0.28, 0.9, 0.03], [0.22, 1.2, -0.03]]) {
      P.push(tint(place(box(len, 0.045, 0.035), -bodyR - Math.cos(ang) * len * 0.5, bodyY + 0.05 + Math.sin(ang) * len * 0.5, zoff, { rz: ang }), tailCol));
    }
  } else if (tail) {
    // 암탉: 짧고 위로 선 부채 꼬리.
    P.push(tint(place(box(0.15, 0.11, 0.05), -bodyR - 0.045, bodyY + 0.075, 0, { rz: 0.82 }), tailCol));
  }
  const bodyGeo = mergeGeometries(P, false);

  // --- 머리(neck 피벗 로컬: 원점=목 밑동, +X 앞·+Y 위) ---
  const H = [];
  const hr = bodyR * 0.62;
  H.push(tint(place(box(0.035, 0.09 + upright * 0.05, 0.05), 0.0, 0.05, 0), bodyCol)); // 목
  H.push(tint(place(ico(hr), 0.03, 0.10 + upright * 0.03, 0), bodyCol));               // 머리
  H.push(tint(place(cone(0.026, 0.07), 0.03 + hr, 0.09 + upright * 0.03, 0, { rz: -Math.PI / 2 }), beakCol)); // 부리(+X)
  // 볏(머리 위 붉은 관): 암탉 작게, 수탉 크고 톱니.
  const cy = 0.10 + upright * 0.03 + hr * 0.9;
  const cn = combTall > 0.5 ? 4 : 2;
  for (let i = 0; i < cn; i++) {
    const cw = combTall > 0.5 ? 0.03 : 0.02;
    const ch = (combTall > 0.5 ? 0.05 : 0.022) * (1 - i * 0.12);
    H.push(tint(place(box(cw, ch, 0.018), 0.02 + i * cw * 1.05 - cn * cw * 0.4, cy + ch * 0.4, 0), combCol));
  }
  if (wattle) { // 육수(부리 아래 붉은 살) — 수탉
    H.push(tint(place(box(0.02, 0.05, 0.02), 0.03 + hr * 0.7, 0.02, 0), combCol));
  }
  const headGeo = mergeGeometries(H, false);

  // --- 날개(홰치기용, +Z 측 한 장. 피벗=어깨 로컬 원점) ---
  //   기본은 몸통에 접혀 아래로 살짝 드리운 형태(rest 에서 rz 로 처짐) → 홰칠 때만 위로 펼침.
  let wingGeo = null;
  if (wings) {
    wingGeo = tint(place(box(bodyR * 1.35, 0.03, bodyR * 0.85), -bodyR * 0.2, -bodyR * 0.15, bodyR * 0.5, { rz: -0.12 }), wingCol);
  }
  return { bodyGeo, headGeo, wingGeo, neck, shoulder };
}

// 병아리: 아주 작은 노란 솜뭉치(머리 피벗만, 날개·꽁지 없음).
function buildChick(col, beakCol) {
  const bodyGeo = (() => {
    const P = [];
    P.push(tint(place(ico(0.05), 0, 0.06, 0, { sx: 1.0, sy: 1.05, sz: 0.92 }), col)); // 몸통
    P.push(tint(place(box(0.02, 0.05, 0.02), 0.0, 0.028, 0.028), beakCol));            // 다리
    P.push(tint(place(box(0.02, 0.05, 0.02), 0.0, 0.028, -0.028), beakCol));
    return mergeGeometries(P, false);
  })();
  const headGeo = (() => {
    const P = [];
    P.push(tint(place(ico(0.034), 0.02, 0.05, 0), col));                                   // 머리
    P.push(tint(place(cone(0.014, 0.03), 0.02 + 0.03, 0.048, 0, { rz: -Math.PI / 2 }), beakCol)); // 부리
    return mergeGeometries(P, false);
  })();
  return { bodyGeo, headGeo, neck: { x: 0.02, y: 0.075, z: 0 } };
}

// ==================================================================
// 소 지오메트리 (한우, 로컬 +X 정면, y=0 접지). 부위 분리:
//   body = 몸통+다리+어깨두덩(merge), head = 목+머리+주둥이+뿔(poll 피벗 기준),
//   ear = 한쪽 귀, tail = 꼬리+술.
// ==================================================================
function buildCow(o) {
  const { hide = 0x9a5f31, hideDk = 0x6f3f22, cream = 0xcdb590, horn = 0xe0d2b0, hoof = 0x271c14, tuft = 0x2b1f16 } = o || {};
  const legH = 0.8, torsoY = 0.66 + legH;           // 몸통 중심 y
  const halfW = 0.29, halfL = 0.86;                 // 반길이(긴 몸통 → 소다움)
  const P = [];
  // 다리 4 + 발굽. 앞다리 살짝 안쪽(가슴 아래), 뒷다리 뒤로.
  const leg = (x, z) => {
    P.push(tint(place(box(0.16, legH, 0.16), x, legH / 2 + 0.08, z), hideDk));
    P.push(tint(place(box(0.18, 0.14, 0.18), x, 0.07, z), hoof));
  };
  leg(halfL * 0.7, halfW * 0.82); leg(halfL * 0.7, -halfW * 0.82);
  leg(-halfL * 0.72, halfW * 0.82); leg(-halfL * 0.72, -halfW * 0.82);
  // 몸통: 낮은 상자 심 + 큰 ico 배럴로 옆·윗면 각을 깨 통형으로(승합차 상자 탈피).
  P.push(tint(place(box(halfL * 1.9, 0.52, halfW * 1.75), 0, torsoY, 0), hide));
  P.push(tint(place(ico(0.5), 0, torsoY - 0.02, 0, { sx: halfL * 1.8, sy: 0.86, sz: halfW * 2.9 }), hide)); // 배럴 볼륨(사이드 불룩)
  // 어깨 두덩(한우 견갑 융기) — 앞 위로 솟음
  P.push(tint(place(box(0.42, 0.26, halfW * 1.7), halfL * 0.46, torsoY + 0.4, 0), hide));
  // 엉덩이(뒤) 살짝 낮게 좁게
  P.push(tint(place(box(0.4, 0.5, halfW * 1.75), -halfL * 0.62, torsoY - 0.06, 0), hide));
  // 배 아래 크림 언더벨리
  P.push(tint(place(box(halfL * 1.5, 0.16, halfW * 1.4), 0, torsoY - 0.34, 0), cream));
  const bodyGeo = mergeGeometries(P, false);

  // 머리(poll 피벗 로컬: 원점=목 밑동(어깨 앞 위). +X 앞·아래로 목→머리→주둥이가 뻗음.
  //   기본 자세에서도 머리가 앞으로 뚜렷이 돌출해 '소' 실루엣이 읽히게 목을 길게 낸다.)
  const H = [];
  H.push(tint(place(box(0.62, 0.42, 0.36), 0.26, -0.16, 0, { rz: -0.42 }), hide));   // 목(아래·앞 경사)
  H.push(tint(place(box(0.42, 0.36, 0.32), 0.66, -0.42, 0, { rz: -0.12 }), hide));   // 머리(이마)
  H.push(tint(place(box(0.3, 0.27, 0.28), 0.95, -0.52, 0), cream));                  // 주둥이(크림, 앞 돌출)
  H.push(tint(place(box(0.12, 0.07, 0.29), 1.08, -0.55, 0), hideDk));                // 콧등 그늘
  // 뿔(한우 짧고 흰 뿔, 위·바깥으로)
  H.push(tint(place(cone(0.055, 0.26), 0.6, -0.1, 0.13, { rz: 0.55, ry: 0.35 }), horn));
  H.push(tint(place(cone(0.055, 0.26), 0.6, -0.1, -0.13, { rz: 0.55, ry: -0.35 }), horn));
  const headGeo = mergeGeometries(H, false);

  // 귀(피벗=머리 옆. 바깥으로 뻗은 큰 나뭇잎꼴) — 좌측(+Z). 우측은 mesh 미러.
  const earGeo = tint(place(box(0.22, 0.06, 0.14), 0.09, 0, 0.05), hide);
  // 꼬리(피벗=엉덩이 위. 아래로 길게 늘어지고 끝에 검은 술)
  const T = [];
  T.push(tint(place(box(0.07, 0.72, 0.07), 0, -0.36, 0), hideDk));
  T.push(tint(place(ico(0.09), 0, -0.74, 0, { sy: 1.5 }), tuft));
  const tailGeo = mergeGeometries(T, false);

  return {
    bodyGeo, headGeo, earGeo, tailGeo,
    poll: { x: halfL * 0.7, y: torsoY + 0.44, z: 0 },        // 목 밑동(머리 피벗)
    earAt: { x: 0.62, y: -0.26, z: 0.17 },                   // 머리 로컬 귀 부착
    rump: { x: -halfL - 0.02, y: torsoY + 0.28, z: 0 },      // 꼬리 피벗
  };
}

// ------------------------------------------------------------------

export function setupAnimals(parent, {
  heightAt = () => 0,
  layout = {},
  yard = null,
  cowSite = null,
  seed = 4343,
  chickens = true,          // false 면 닭 무리 생략(마을 논 필지 소 전용 호출 등)
} = {}) {
  const group = new THREE.Group();
  group.name = 'animals';
  parent.add(group);

  const rng = makeRng(seed);
  const solidMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true,
    // Keep one opaque/depth-writing shader while focus, distance LOD, and village
    // rerolls crossfade. alphaHash turns opacity into a stable stipple without
    // transparent sorting or a new program at every ownership transition.
    alphaHash: true,
  });

  let time = 'day';
  let live = 1;             // 활동성(밤엔 낮춤)
  let roostGoal = 0;        // 닭 홰 자세 목표(밤=1)
  let t = 0;
  let enabled = true;
  let fadeWeight = 1;       // focus-ring ownership crossfade
  let detailWeight = 1;     // shared camera / view-cell LOD
  let waveWeight = 1;       // reroll/scale wave multiplier (visible/detail ownership stays here)
  const LOD_EPSILON = 0.002;
  const lod = { weight: 1, waveWeight: 1, active: true, updates: 0, skipped: 0 };

  const _ray = new THREE.Raycaster();
  const _down = new THREE.Vector3(0, -1, 0);
  const _org = new THREE.Vector3();

  // 앞마당 앵커(초가 마당 바이어스): 없으면 layout 에서 파생 — 처마·기단·계단 밖 열린 +z 앞마당.
  //   정면 계단축(x≈0)을 피해 살짝 +x 로 치우친다(닭이 계단·기단에 얹히지 않게).
  const xEave = layout.xEave ?? 9, zEave = layout.zEave ?? 6;
  const clear = Math.max(xEave, zEave);
  const Y = yard || { x: clear * 0.42, z: clear + 2.4, r: 2.0 };
  const yardR = Y.r ?? 2.0;

  // ==================================================================
  // 1) 닭 무리 — 암탉 1~2 + 병아리 3~4 + 수탉 1 (마당)
  // ==================================================================
  const flock = chickens ? (() => {
    // 부위 지오메트리(재사용): 암탉·수탉·병아리.
    const henParts = buildFowl({
      bodyCol: 0xb98a52, wingCol: 0x8d6839, tailCol: 0x6d4f2d,
      combCol: 0xc0392b, beakCol: 0xdca63f, legCol: 0xd0913c,
      bodyR: 0.125, bodyLong: 1.16, upright: 0.0, combTall: 0, wattle: false,
    });
    const roosterParts = buildFowl({
      bodyCol: 0x8a4a26, wingCol: 0x5e3218, tailCol: 0x20291f,
      combCol: 0xd23a24, beakCol: 0xdca63f, legCol: 0xcf8b34,
      bodyR: 0.145, bodyLong: 1.12, upright: 1.0, combTall: 1, wattle: true, hackle: 0xc7963f,
    });
    const chickParts = buildChick(0xf1cf49, 0xe0902e);

    // 한 마리 조립: 몸통 + headPivot(머리) + [wingPivotL/R]. group.position 은 지면 위.
    function makeBird(parts, opt = {}) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(parts.bodyGeo, solidMat); body.castShadow = true;
      g.add(body);
      const headPivot = new THREE.Group();
      headPivot.position.set(parts.neck.x, parts.neck.y, parts.neck.z);
      const head = new THREE.Mesh(parts.headGeo, solidMat); head.castShadow = true;
      headPivot.add(head); g.add(headPivot);
      const wings = [];
      if (parts.wingGeo) {
        for (const s of [1, -1]) {
          const wp = new THREE.Group();
          wp.position.set(parts.shoulder.x, parts.shoulder.y, parts.shoulder.z * s);
          const w = new THREE.Mesh(parts.wingGeo, solidMat);
          w.scale.z = s;                        // 우측 미러
          wp.add(w); g.add(wp);
          wings.push(wp);
        }
      }
      if (opt.scale) g.scale.setScalar(opt.scale);
      group.add(g);
      return { g, headPivot, wings };
    }

    // 개체 상태 생성.
    function spawnFowl(parts, kind, opt = {}) {
      const b = makeBird(parts, opt);
      const a = opt.a ?? rng.range(0, TAU), r = opt.r ?? rng.range(0, yardR * 0.8);
      const px = Y.x + Math.cos(a) * r, pz = Y.z + Math.sin(a) * r;
      const o = {
        ...b, kind, px, pz, heading: rng.range(0, TAU),
        mode: 'idle', tMode: t + poisson(rng, 3, 1, 6), ph: rng.range(0, TAU),
        head: 0, headTarget: 0, peckPh: 0, gaitPh: rng.range(0, TAU),
        flap: 0, wp: { x: px, z: pz }, hop: 0,
        crow: kind === 'rooster', restH: kind === 'rooster' ? 0.06 : 0.0,
      };
      b.g.position.set(px, heightAt(px, pz), pz);
      b.g.rotation.y = -o.heading;
      return o;
    }

    // 마당 안 새 목적지(무리 중심 근처, 반경 안).
    function pickSpot() {
      const a = rng.range(0, TAU), r = rng.range(0.3, yardR);
      return { x: Y.x + Math.cos(a) * r, z: Y.z + Math.sin(a) * r };
    }

    // 어른들은 각도를 벌려 배치(무리가 한 덩어리로 뭉치지 않게).
    const hens = [];
    const hensN = rng.int(1, 2);
    for (let i = 0; i < hensN; i++) hens.push(spawnFowl(henParts, 'hen', { a: 0.4 + i * 2.1, r: yardR * 0.55 }));
    const rooster = spawnFowl(roosterParts, 'rooster', { scale: 1.06, a: 3.6, r: yardR * 0.7 });
    const chicks = [];
    const chicksN = rng.int(3, 4);
    for (let i = 0; i < chicksN; i++) {
      const c = spawnFowl(chickParts, 'chick', { scale: 1.0 });
      c.follow = i;                            // 어미(hens[0]) 뒤 느슨한 대형 오프셋 인덱스
      c.offA = rng.range(0, TAU); c.offR = rng.range(0.35, 0.7);
      chicks.push(c);
    }

    const adults = [...hens, rooster];

    // 어른 새 1마리 업데이트(암탉·수탉 공용): 쪼기·종종 이동·간헐 홰치기.
    function stepAdult(o, dt) {
      const L = live;
      // 모드 전환
      if (t >= o.tMode) {
        const roll = rng();
        if (o.mode === 'walk') { o.mode = 'peck'; o.tMode = t + poisson(rng, 4, 2, 8) / L; }
        else if (roll < (o.kind === 'rooster' ? 0.22 : 0.14)) {
          o.mode = 'flap'; o.flap = 0; o.tMode = t + 0.65;         // 홰치기(짧게)
        } else if (roll < 0.55) {
          o.mode = 'walk'; o.wp = pickSpot(); o.tMode = t + 6;     // 새 자리로 종종
        } else if (o.kind === 'rooster' && roll < 0.72) {
          o.mode = 'crow'; o.tMode = t + 1.1;                      // 목 세워 우는 자세
        } else {
          o.mode = 'peck'; o.tMode = t + poisson(rng, 5, 2, 10) / L;
        }
      }

      if (o.mode === 'walk') {
        const dx = o.wp.x - o.px, dz = o.wp.z - o.pz, d = Math.hypot(dx, dz);
        if (d < 0.12) { o.mode = 'peck'; o.tMode = t + poisson(rng, 4, 2, 8) / L; }
        else {
          const want = Math.atan2(dz, dx);
          let da = ((want - o.heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
          o.heading += Math.max(-3.5 * dt, Math.min(3.5 * dt, da));
          const sp = 0.5 * L;
          o.px += Math.cos(o.heading) * sp * dt; o.pz += Math.sin(o.heading) * sp * dt;
          o.gaitPh += dt * 11 * L;
        }
        o.headTarget = 0.0;
      } else if (o.mode === 'peck') {
        // 반복 쪼기: 아래로 콕 → 되돌림. 사이사이 짧은 정지.
        o.peckPh += dt * (5.5 + 2 * (o.kind === 'rooster' ? 0.6 : 1)) * L;
        const dip = Math.max(0, Math.sin(o.peckPh));
        o.headTarget = -1.15 * dip * dip;                          // 부리 땅으로
      } else if (o.mode === 'crow') {
        o.headTarget = 0.55;                                       // 목 위로 세움
      } else { // idle
        o.headTarget = 0.06 * Math.sin(t * 1.4 + o.ph);
      }

      // 홰치기: 날개 위아래 + 몸 살짝 튐(+앞). 종료 시 idle.
      if (o.mode === 'flap') {
        o.flap = Math.min(1, o.flap + dt * 3.2);
        const beat = Math.sin(t * 26);
        const amp = Math.sin(Math.PI * o.flap);                    // 시작·끝 부드럽게
        if (o.wings.length) {
          // 위로 아치를 그리며 퍼덕(수평 널빤지 회피 — 최대 ~0.8rad).
          const lift = (0.15 + 0.65 * (0.5 + 0.5 * beat)) * amp;
          o.wings[0].rotation.x = -lift;
          o.wings[1].rotation.x = lift;
        }
        o.hop = Math.abs(Math.sin(t * 13)) * 0.06 * amp;
        o.headTarget = 0.35 * amp;
      } else {
        o.hop *= (1 - Math.min(1, dt * 6));
        if (o.wings.length) {
          o.wings[0].rotation.x += (0 - o.wings[0].rotation.x) * Math.min(1, dt * 8);
          o.wings[1].rotation.x += (0 - o.wings[1].rotation.x) * Math.min(1, dt * 8);
        }
      }

      applyBird(o, dt);
    }

    // 병아리: 어미 뒤 느슨한 추종 + 빠른 종종걸음(고빈도 상하 바운스·머리 콕).
    function stepChick(o, dt) {
      const mom = hens[0] || rooster;
      // 어미 등 뒤(진행 반대쪽) 부채꼴 지점 + 개체 오프셋.
      const back = mom.heading + Math.PI;
      const tx = mom.px + Math.cos(back + (o.offA - Math.PI)) * o.offR;
      const tz = mom.pz + Math.sin(back + (o.offA - Math.PI)) * o.offR;
      const dx = tx - o.px, dz = tz - o.pz, d = Math.hypot(dx, dz);
      let moving = 0;
      if (d > 0.08) {
        const want = Math.atan2(dz, dx);
        let da = ((want - o.heading + Math.PI) % TAU + TAU) % TAU - Math.PI;
        o.heading += Math.max(-6 * dt, Math.min(6 * dt, da));
        const sp = Math.min(1.4, 0.7 + d * 1.6) * live;             // 멀면 빨리 쫓아감
        o.px += Math.cos(o.heading) * sp * dt; o.pz += Math.sin(o.heading) * sp * dt;
        o.gaitPh += dt * 18 * live; moving = 1;
      } else {
        // 멈춰 쪼기
        o.peckPh += dt * 7 * live;
        o.headTarget = -0.9 * Math.max(0, Math.sin(o.peckPh)) ** 2;
      }
      if (moving) o.headTarget = 0.12 * Math.sin(o.gaitPh);
      o.hop = moving ? Math.abs(Math.sin(o.gaitPh)) * 0.035 : o.hop * (1 - Math.min(1, dt * 6));
      applyBird(o, dt);
    }

    // 공통: 위치·헤딩·머리각·홰 자세 적용.
    function applyBird(o, dt) {
      o.head += (o.headTarget - o.head) * Math.min(1, dt * 12);
      // 밤 홰 자세: 몸 웅크리고(내려앉음) 머리 등에 파묻음. roost 0→1 보간.
      const roost = o._roost = (o._roost ?? 0) + (roostGoal - (o._roost ?? 0)) * Math.min(1, dt * 1.5);
      const gy = heightAt(o.px, o.pz);
      o.g.position.set(o.px, gy + o.hop - roost * (o.restH + 0.04), o.pz);
      o.g.rotation.y = -o.heading;
      o.headPivot.rotation.z = o.head * (1 - roost) - roost * 0.9;   // 밤엔 목을 웅크림
    }

    function update(dt) {
      for (const o of adults) stepAdult(o, dt);
      for (const o of chicks) stepChick(o, dt);
    }
    // 검증용: 무리 중심 월드 좌표(스크린샷 조준).
    function center() { return new THREE.Vector3(Y.x, heightAt(Y.x, Y.z) + 0.4, Y.z); }
    return { update, center };
  })() : null;

  // ==================================================================
  // 2) 소 1 — 논/논둑 방목(한우). 느린 고개 끄덕임(풀 뜯기)·꼬리 스윙·귀 플릭.
  //   지면 Y 는 논면(paddyField) 다운캐스트로 정확히 얹는다(논둑 lip 포함).
  // ==================================================================
  const cow = cowSite ? (() => {
    const parts = buildCow();
    const g = new THREE.Group();
    g.name = 'cow';
    const body = new THREE.Mesh(parts.bodyGeo, solidMat); body.castShadow = true;
    g.add(body);
    const headPivot = new THREE.Group();
    headPivot.position.set(parts.poll.x, parts.poll.y, parts.poll.z);
    const head = new THREE.Mesh(parts.headGeo, solidMat); head.castShadow = true;
    headPivot.add(head);
    // 귀(머리 자식 → 고개와 함께 움직임). 좌/우 미러.
    const ears = [];
    for (const s of [1, -1]) {
      const ep = new THREE.Group();
      ep.position.set(parts.earAt.x, parts.earAt.y, parts.earAt.z * s);
      const e = new THREE.Mesh(parts.earGeo, solidMat); e.scale.z = s;
      ep.add(e); headPivot.add(ep); ears.push(ep);
    }
    g.add(headPivot);
    const tailPivot = new THREE.Group();
    tailPivot.position.set(parts.rump.x, parts.rump.y, parts.rump.z);
    const tail = new THREE.Mesh(parts.tailGeo, solidMat); tail.castShadow = true;
    tailPivot.add(tail); g.add(tailPivot);
    group.add(g);

    // 배치: cowSite(x,z) + yaw. 지면 Y 는 첫 update 에서 논면 캐스트로 확정(월드행렬 준비 후).
    const px = cowSite.x, pz = cowSite.z;
    g.position.set(px, heightAt(px, pz) + 0.02, pz);
    g.rotation.y = cowSite.yaw ?? -Math.PI / 2;
    let grounded = false;

    // 풀 뜯기 사이클: 고개 든 경계 자세 ↔ 숙여 뜯기. 포아송 전환.
    //   기본(첫) 자세는 고개를 든 상태 → 정지 프레임·첫인상에서 소 실루엣(머리·뿔)이 뚜렷이 읽힌다.
    let graze = 0.1, grazeGoal = 0.1, tGoal = t + poisson(rng, 7, 3, 12);
    let earPh = rng.range(0, TAU), tailPh = rng.range(0, TAU), flick = 0, tFlick = t + poisson(rng, 5, 2, 9);

    function resolveGround() {
      const mesh = parent.getObjectByName('paddyField');
      let y = heightAt(px, pz);
      if (mesh) {
        mesh.updateWorldMatrix(true, false);
        _org.set(px, y + 40, pz);
        _ray.set(_org, _down);
        const hit = _ray.intersectObject(mesh, false);
        if (hit.length) y = hit[0].point.y;         // 논면(논둑 lip 포함) 정확 표고
      }
      g.position.y = y + 0.02;
      grounded = true;
    }

    function update(dt) {
      if (!grounded) resolveGround();
      const L = 0.4 + 0.6 * live;                     // 밤에도 느리게 계속(소는 그대로 무방)
      if (t >= tGoal) {
        // 0=고개 듦(경계), 1=바닥 뜯기. 뜯기(숙임)와 고개 듦을 오가되 완전 수직까진 안 감.
        grazeGoal = rng() < 0.6 ? rng.range(0.55, 0.9) : rng.range(0.0, 0.3);
        tGoal = t + poisson(rng, 9, 4, 16);
      }
      graze += (grazeGoal - graze) * Math.min(1, dt * 0.9);
      // 숙였을 때 미세 뜯음 진동(입질)
      const nibble = graze > 0.55 ? 0.05 * Math.sin(t * 6.5) * (graze - 0.55) : 0;
      headPivot.rotation.z = -(graze * 0.85 + nibble);          // +X 앞→아래로 숙임(기하가 이미 목 경사)
      // 꼬리 스윙(상시, 느리게) + 이따금 큰 휘두름
      tailPivot.rotation.x = 0.22 * Math.sin(t * 1.1 + tailPh) + 0.12 * Math.sin(t * 0.37);
      tailPivot.rotation.z = 0.05 * Math.sin(t * 0.8 + tailPh);
      // 귀 플릭(간헐 빠른 튕김)
      if (t >= tFlick) { flick = 1; tFlick = t + poisson(rng, 5, 2, 9) / L; }
      flick *= (1 - Math.min(1, dt * 5));
      const fk = flick * Math.sin(t * 30);
      ears[0].rotation.z = 0.15 + 0.5 * fk;
      ears[1].rotation.z = 0.15 - 0.5 * fk;
      ears[0].rotation.x = 0.1 * Math.sin(t * 0.9 + earPh);
      ears[1].rotation.x = 0.1 * Math.sin(t * 0.9 + earPh + 1.3);
      // 무게중심 미세 흔들(호흡·되새김)
      body.rotation.z = 0.008 * Math.sin(t * 0.6);
    }
    function anchor() { return g.position; }
    return { update, anchor, group: g };
  })() : null;

  // ---------- 공개 API ----------
  function update(dt) {
    // Pause both animation and event scheduling when the layer cannot be seen.
    if (!lod.active) { lod.skipped++; return; }
    lod.updates++;
    t += dt;
    if (flock) flock.update(dt);
    if (cow) cow.update(dt);
  }
  function setTime(name) {
    time = name;
    live = name === 'night' ? 0.4 : 1;
    roostGoal = name === 'night' ? 1 : 0;              // 밤: 닭 홰 자세
  }
  function setSeason(_name) { /* 계절 연동 여지(현재 무영향) */ }
  function applyPresentation() {
    const wasVisible = group.visible;
    const alpha = presentationWeight(fadeWeight, detailWeight, waveWeight);
    lod.weight = detailWeight;
    lod.waveWeight = waveWeight;
    lod.active = enabled && alpha > LOD_EPSILON;
    group.visible = lod.active;
    solidMat.opacity = alpha;
    return wasVisible !== group.visible;
  }
  function setEnabled(v) { enabled = !!v; return applyPresentation(); }
  // 근접 링 활성/해제 크로스페이드(0..1). 고정 alphaHash 재질이므로
  // 매 프레임 opacity 균일값만 바꾸고 투명 프로그램과 정렬 경로는 생성하지 않는다.
  function setFade(v) {
    fadeWeight = Math.max(0, Math.min(1, v));
    return applyPresentation();
  }
  // Village detail is independent from the focus-ring presence fade. Multiplying the
  // weights keeps either owner from overwriting the other's visibility decision.
  function setDetail(v) {
    detailWeight = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    return applyPresentation();
  }
  // Village reroll/scale wave owns only this multiplier. It must not write group.visible or
  // material opacity itself because camera LOD can change concurrently during a reframe.
  function setWaveFade(v) {
    waveWeight = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    return applyPresentation();
  }

  group.userData.waveFade = { setWeight: setWaveFade };

  // Stable world anchors let the village runtime evaluate the shared view-cell policy
  // without walking the object tree or allocating vectors every frame.
  const detailAnchors = [];
  if (flock) detailAnchors.push(flock.center());
  if (cow) detailAnchors.push(cow.anchor());

  return {
    update, setTime, setSeason, setEnabled, setFade, setDetail, setWaveFade,
    group, detailAnchors, lod,
    // 소 라이브 월드 위치(오디오·마을 배치·검증 조준). 없으면 null.
    get cowAnchor() { return cow ? cow.anchor() : null; },
    // 검증 전용: 닭 무리 중심 월드 좌표.
    debugFlockCenter() { return flock ? flock.center() : null; },
  };
}

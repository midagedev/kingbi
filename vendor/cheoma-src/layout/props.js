import * as THREE from 'three';
import { markSharedResource } from '../core/three-resources.js';

// 필지 등롱(마당·대문 걸이등롱) — 태스크 #83.
//   조선 감성: 대문(솟을대문·사립문) 처마 밑 걸이등롱 + 반가 마당 기둥걸이 등롱(장명등 계열).
//   두 소비처가 이 모듈의 단일 배치(lanternLayout)를 공유한다:
//     · buildParcel(오버레이/풀디테일): attachOverlayLanterns 로 PointLight + 소형 bulb 를 필지 루트
//       직속 자식으로 심는다 → env/motes.js setupLanternSway(focus 링, #79)가 그 스코프의 직속 자식을
//       훑어 bulb↔light 를 짝지어 바람 흔들림(dormant 였던 레이어를 자동 구동). frame(갓·걸이·기둥)은
//       하위 Group 에 담아 탐지에서 제외(직속 소형 Sphere 만 bulb 로 오인되지 않게).
//     · gardens.js(마을 정적 병합): buildParcelLanternGeo 로 발광 몸체·프레임 지오를 반환 → 레이어 병합
//       (드로우콜 +1: flora-lantern). 야간 발광은 마을 adapter(collectGlowMats)가 아래 glow 재질의
//       userData.hanjiGlow 태그를 잡아 창호와 동일 경로(#66/#70)로 시간대 크로스페이드한다(env 무수정).
//
// 결정론: rng 객체 미사용(호출자 공유 시퀀스 불침해). 좌/우 배치만 seed 비트로 가른다. 배치 개수는
//   parcel.lantern({gate,yard}, variants.js) 또는 유형 기본(STYLE_LANTERN)에서 온다.

// 등롱 공유 재질(단일 인스턴스). glow 는 오버레이 bulb·마을 정적 등롱이 공유 → 어댑터가 1회 수집·램프하면
//   전부 발광(창호·석등과 동일 hanjiGlow 규약). 낮=소등(emissiveIntensity 0), 야간=WARM 호롱빛(adapter 구동).
let _mats = null;
export function getLanternMaterials() {
  if (_mats) return _mats;
  const glow = new THREE.MeshStandardMaterial({
    color: 0xe8c79a, roughness: 0.6, metalness: 0,
    emissive: 0xff8a3c, emissiveIntensity: 0,
  });
  // 창호(hanji 0.26)보다 살짝 높은 계수 — #70 석등 화창과 동일(은은히 도드라지되 blowout 금지).
  glow.userData.hanjiGlow = 0.30;
  const frame = new THREE.MeshStandardMaterial({ color: 0x241f19, roughness: 0.82, metalness: 0.1 });
  _mats = { glow: markSharedResource(glow), frame: markSharedResource(frame) };
  return _mats;
}

// 유형별 기본 등롱 구성(오버레이가 config 미지정 시). 반가(hanok 종가)·관아(palace)는 대문 한 쌍 + 마당 1,
//   절(temple)은 대문 한 쌍, 민가(choga)는 대문 1. 마을 정적 배치는 parcel.lantern 이 우선.
const STYLE_LANTERN = {
  hanok: { gate: 2, yard: 1 }, palace: { gate: 2, yard: 1 },
  temple: { gate: 2, yard: 0 }, choga: { gate: 1, yard: 0 },
};

// 필지 로컬 좌표(+z=남=대문, 원점=대지 중심). gate=대문 처마밑 걸이, yard=마당 기둥걸이.
//   반환 placement: { kind, x, z, lampY(램프 중심), topY(걸이/처마/팔 상단), side }.
export function lanternLayout(style, seed, W, D, config = null) {
  const cfg = config || STYLE_LANTERN[style] || { gate: 1, yard: 0 };
  const nGate = Math.max(0, cfg.gate | 0), nYard = Math.max(0, cfg.yard | 0);
  const hd = D / 2;
  const narrow = style === 'choga';
  const gateHalf = narrow ? 0.85 : 1.55;   // 대문 개구부 반폭(등롱은 문설주 바깥쪽)
  const gateEaveY = narrow ? 2.15 : 2.7;   // 대문 처마 밑
  const gateLampY = gateEaveY - 0.42;
  const out = [];
  // 대문 걸이: 2개면 좌우 쌍, 1개면 seed 로 좌/우.
  for (let i = 0; i < nGate; i++) {
    const s = nGate >= 2 ? (i === 0 ? 1 : -1) : ((seed & 1) ? 1 : -1);
    out.push({ kind: 'gate', x: s * (gateHalf + 0.35), z: hd - 0.55, lampY: gateLampY, topY: gateEaveY, side: s });
  }
  // 마당 기둥걸이: 앞마당 off-axis(중앙 동선 회피). 1개면 seed, 2개면 좌우.
  const ys = (seed & 2) ? 1 : -1;
  for (let i = 0; i < nYard; i++) {
    const s = i === 0 ? ys : -ys;
    out.push({ kind: 'yard', x: s * (W * 0.26), z: hd * 0.2, lampY: 1.95, topY: 2.3, side: s });
  }
  return out;
}

// ── 오버레이(풀디테일) 등롱: 필지 루트 직속에 bulb + PointLight 를 심는다(setupLanternSway 탐지 계약). ──
//   frame(갓·걸이·기둥)은 하위 Group 에 담아 직속 소형 Sphere 오인 방지. 반환: 심은 등롱 수.
// emitLight(#141, 기본 true): PointLight 를 심을지. focus 오버레이(parcel.js)·앰비언스 필드 셀은
//   false 로 호출 — 셀/오버레이가 자기 PointLight 를 씬에 두면 focus-in/out·hop·필드 셀 스핀업마다
//   numPointLights 가 요동해 씬 전체 조명 재질이 개수별로 재컴파일된다(전환 셰이더 폭풍). 발광 bulb
//   (공유 glow 재질 emissive — 야간 어댑터가 hanjiGlow 로 점등)만 남기고, 국소 조명(warm cast)은
//   env/focus.js 의 고정 PointLight 풀이 카메라/링 근접 순으로 배정한다(개수 불변).
export function attachOverlayLanterns(root, { style = 'hanok', W = 24, D = 22, seed = 7, emitLight = true } = {}) {
  const { glow, frame } = getLanternMaterials();
  const places = lanternLayout(style, seed, W, D, null);
  let count = 0;
  for (const pl of places) {
    // 램프 몸체(bulb) — SphereGeometry radius<0.5 + glow 재질. 직속 자식 → 탐지·흔들림 대상.
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), glow);
    bulb.name = 'lantern-bulb';
    bulb.scale.set(1, 1.4, 1);   // 세로로 살짝 늘린 등롱 몸체(지오 파라미터 radius 는 불변 → 탐지 유지)
    bulb.position.set(pl.x, pl.lampY, pl.z);
    bulb.castShadow = false; bulb.receiveShadow = false;
    root.add(bulb);
    // 등롱 빛 — WARM PointLight(직속 자식 → 탐지·흔들림). 저강도(낮엔 태양에 묻히고 밤엔 호롱빛).
    if (emitLight) {
      const light = new THREE.PointLight(0xffb266, 0.65, 5.5, 2);
      light.name = 'lantern-light';
      light.position.set(pl.x, pl.lampY, pl.z);
      light.castShadow = false;
      root.add(light);
    }
    // 프레임(갓·걸이 끈·기둥·팔) — 하위 Group(탐지 제외). 정적(흔들리는 램프를 붙드는 지지물).
    const fg = new THREE.Group();
    fg.name = 'lantern-frame';
    const capTopY = pl.lampY + 0.24;
    fg.add(mkFrame(new THREE.CylinderGeometry(0.10, 0.12, 0.06, 8), frame, pl.x, capTopY, pl.z));            // 갓(상단 캡)
    fg.add(mkFrame(new THREE.CylinderGeometry(0.03, 0.008, 0.12, 6), frame, pl.x, pl.lampY - 0.26, pl.z));   // 술(하단 매듭)
    if (pl.kind === 'gate') {
      const cordLen = Math.max(0.05, pl.topY - capTopY);
      fg.add(mkFrame(new THREE.CylinderGeometry(0.015, 0.015, cordLen, 5), frame, pl.x, (pl.topY + capTopY) / 2, pl.z));
    } else {
      // 마당 기둥 + 걸이 팔 + 끈.
      const pole = mkFrame(new THREE.CylinderGeometry(0.05, 0.07, pl.topY, 6), frame, pl.x + 0.32 * pl.side, pl.topY / 2, pl.z);
      fg.add(pole);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 5), frame);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(pl.x + 0.16 * pl.side, pl.topY, pl.z);
      arm.castShadow = true;
      fg.add(arm);
      const cordLen = Math.max(0.05, pl.topY - capTopY);
      fg.add(mkFrame(new THREE.CylinderGeometry(0.015, 0.015, cordLen, 5), frame, pl.x, (pl.topY + capTopY) / 2, pl.z));
    }
    root.add(fg);
    count++;
  }
  return count;
}

function mkFrame(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = false;
  return m;
}

// ── 마을 정적(병합) 등롱 지오: 필지 로컬 좌표의 발광 몸체·프레임 BufferGeometry 배열. ──
//   gardens.js 가 parcelMatrix 로 월드변환 후 레이어 병합(glow→flora-lantern, frame→flora-wood tint).
export function buildParcelLanternGeo(style, seed, W, D, config) {
  const places = lanternLayout(style, seed, W, D, config);
  const glow = [], frame = [];
  for (const pl of places) {
    // 발광 몸체(세로로 늘린 저폴리 구) — 부감·중경에서 야간 점점이 등불로 읽힌다.
    const body = new THREE.SphereGeometry(0.17, 6, 5);
    body.applyMatrix4(new THREE.Matrix4().makeTranslation(pl.x, pl.lampY, pl.z).multiply(new THREE.Matrix4().makeScale(1, 1.4, 1)));
    glow.push(body);
    const capTopY = pl.lampY + 0.22;
    const cap = new THREE.CylinderGeometry(0.06, 0.075, 0.05, 6); cap.translate(pl.x, capTopY, pl.z);
    frame.push(cap);
    if (pl.kind === 'yard') {
      const pole = new THREE.CylinderGeometry(0.05, 0.065, pl.topY, 5); pole.translate(pl.x + 0.3 * pl.side, pl.topY / 2, pl.z);
      frame.push(pole);
    } else {
      const cordLen = Math.max(0.05, pl.topY - capTopY);
      const cord = new THREE.CylinderGeometry(0.018, 0.018, cordLen, 4); cord.translate(pl.x, (pl.topY + capTopY) / 2, pl.z);
      frame.push(cord);
    }
  }
  return { glow, frame };
}

// 필지의 등롱 배치 스타일 키(gardens 편의). 히어로는 heroStyle, 정규는 kind(giwa/choga).
export function lanternStyleFor(parcel) {
  if (parcel.hero) return parcel.heroStyle || 'hanok';
  return parcel.kind === 'giwa' ? 'giwa' : 'choga';
}

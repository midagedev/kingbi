import * as THREE from 'three';
import { addMaterialTextures, markSharedResource } from '../core/three-resources.js';

// 볏짚/짚 결 텍스처(낟가리·멍석·솟대 지푸라기). palette.js의 지붕 볏짚과 톤 조화.
function makeStrawTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#c2a866');
  grad.addColorStop(0.5, '#ab8d4c');
  grad.addColorStop(1, '#8f7238');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * 128, y = Math.random() * 128, len = 6 + Math.random() * 18;
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(90,68,32,0.30)' : 'rgba(214,190,140,0.32)';
    g.lineWidth = 0.8 + Math.random();
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 3, y + len); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 멍석 짚 엮음(가로 결) 텍스처.
function makeMatTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#b89a5a'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(120,92,48,0.5)'; g.lineWidth = 3;
  for (let y = 4; y < 128; y += 9) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); }
  g.strokeStyle = 'rgba(224,200,150,0.35)'; g.lineWidth = 2;
  for (let x = 4; x < 128; x += 9) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 장승 몸통 명문(銘文) 텍스처: 세로로 쓴 붓글씨 느낌 + 목재 바탕. label로 글자 지정.
function makeJangseungText(label) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7a5a38'; g.fillRect(0, 0, 128, 512);    // 목재 바탕
  // 흰 바탕 명문판
  g.fillStyle = 'rgba(232,224,206,0.92)';
  g.fillRect(40, 150, 48, 320);
  g.fillStyle = '#25201a';
  g.font = 'bold 34px "Apple SD Gothic Neo", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const chars = label.split('');
  const top = 178, step = 300 / chars.length;
  chars.forEach((ch, i) => g.fillText(ch, 64, top + step * i));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let _cache = null;

// 소품 공유 재질 세트(메모이즈). 소품 수백 개가 이 인스턴스들을 공유한다.
export function getPropMaterials() {
  if (_cache) return _cache;
  const std = (color, rough, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });

  const strawTex = makeStrawTexture();

  _cache = {
    // 화강암: 밝은 회백, flatShading으로 깎은 면 느낌(모서리 마모 대신 각진 파세트)
    granite: std(0xcac4b6, 0.92, { flatShading: true }),
    graniteDark: std(0x9d968a, 0.95, { flatShading: true }),
    graniteWarm: std(0xc0b6a0, 0.9, { flatShading: true }),   // 갑석·밝은 마감돌
    graniteMoss: std(0x8f9079, 0.98, { flatShading: true }),  // 이끼 낀 정원석

    // 청동: 짙은 녹청 파티나, 약한 금속감
    bronze: new THREE.MeshStandardMaterial({ color: 0x5c6a4f, roughness: 0.5, metalness: 0.55 }),
    bronzeDark: new THREE.MeshStandardMaterial({ color: 0x40483a, roughness: 0.55, metalness: 0.5 }),

    // 옹기: 짙은 갈 유약 광택(roughness 낮게 → 유약 반들)
    onggi: std(0x3a2818, 0.42, { metalness: 0.06 }),
    onggiLid: std(0x2f2114, 0.4, { metalness: 0.06 }),

    // 목재: builder 팔레트 톤과 조화(아교재·고재)
    wood: std(0x6f4d2e, 0.82),
    woodDark: std(0x4a3420, 0.85),
    woodLight: std(0x9a7c4a, 0.8),        // 싸리·대나무·밝은 생목
    woodPaint: std(0x7a5a38, 0.8),        // 장승 몸통 바탕(명문판 대비)

    // 볏짚/짚
    straw: std(0xffffff, 1.0, { map: strawTex }),
    strawDark: std(0x7d6636, 0.98),
    thatch: std(0xb09354, 0.98),          // 닭장·소품 지붕 볏짚
    mat: std(0xffffff, 0.95, { map: makeMatTexture() }),
    rope: std(0x8a7040, 0.9),             // 새끼줄

    // 물(우물·드므): 어둡고 반사 있는 면
    water: new THREE.MeshStandardMaterial({ color: 0x243036, roughness: 0.15, metalness: 0.2 }),

    // 도장(장승·솟대 새·해태 눈): 캔버스 페인트 느낌 단색
    paintRed: std(0x9a3b2a, 0.7),
    paintBlack: std(0x241f1a, 0.6),
    paintWhite: std(0xe8e2d2, 0.7),
    paintDark: std(0x2a2622, 0.7),

    // 어두운 실내(석등 화창·닭장 내부)
    dark: std(0x1a1610, 0.9),
    // 석등 화창 불빛: 주간엔 소등(emissive 0 — 낮에 흰 blowout 나던 결함 해소), 야간엔 웜 호롱빛.
    //   야간 발광은 마을 야간광 시스템(adapter/night-glow)이 아래 userData.hanjiGlow 태그를 잡아
    //   창호와 동일 경로로 시간대 크로스페이드(#50) 게이트한다(WARM emissive × vnight). 여기선
    //   불 꺼진 화창의 diffuse(따뜻한 종이·화강 톤)만 정의. 불꽃색은 짙은 호박(창보다 웜).
    lantern: std(0xe8c79a, 0.6, { emissive: 0xff8a3c, emissiveIntensity: 0.0 }),
  };
  // 석등 불빛 시간 게이트(태스크 #70): 창호(hanji 0.26)보다 살짝 높은 계수로 화창 불꽃이
  //   은은히 도드라지되 blowout 하지 않게. 낮=소등, 황혼·야간=WARM 호롱빛(adapter 가 구동).
  _cache.lantern.userData.hanjiGlow = 0.30;
  // 장승 명문 텍스처 생성 헬퍼도 노출(좌/우 글자 다름)
  _cache._jangseungText = makeJangseungText;
  // 모듈 캐시는 모든 건물·마을이 빌린다. 개별 root teardown이 끊지 않게 원본 identity만
  // process-lifetime 공유로 표시한다(Material.clone 파생본에는 WeakSet 표식이 전파되지 않는다).
  for (const value of Object.values(_cache)) {
    if (!value?.isMaterial) continue;
    markSharedResource(value);
    const textures = new Set();
    addMaterialTextures(value, textures);
    for (const texture of textures) markSharedResource(texture);
  }
  return _cache;
}

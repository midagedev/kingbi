// 포스트카드 캡처 — 현재 뷰 위에 낙관(도장)을 찍어 공유용 한 장을 만든다.
//   capturePostcard(renderer, render, { title, filename, download }) → dataURL(PNG)
//
// render() 는 현재 모드(pbr/dof/ink) 그대로 한 프레임을 렌더하는 콜백.
// preserveDrawingBuffer 없이도, render 직후 같은 태스크 안에서 캔버스를 읽으면
// 드로잉 버퍼가 유효하므로 그대로 2D 캔버스에 복사해 낙관을 합성한다.
// pixelRatio 2 로의 승격은 컴포저 크기와 함께 호출부(main.js)에서 처리한다.

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 결정적 마모 노이즈용 소형 RNG.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 낙관(전각 인장): 우하단에 작은 빨간 전각 사각 + 백문 '처마' 2자 + 옆 초소형 서명.
// 스탬프 높이는 화면의 ~6%. 마모 노이즈로 손으로 찍은 자국의 절제된 질감.
function drawSeal(ctx, W, H, title) {
  const sealH = Math.round(H * 0.062);
  const sealW = Math.round(sealH * 0.76);
  const margin = Math.round(H * 0.035);
  const x = W - margin - sealW;
  const y = H - margin - sealH;

  // 낙관은 별도 캔버스에 그린 뒤 마모(destination-out)를 파내고 합성 → 눌린 자국.
  const s = document.createElement('canvas');
  s.width = sealW; s.height = sealH;
  const c = s.getContext('2d');

  const r = Math.max(2, Math.round(sealW * 0.1));
  roundRect(c, 0, 0, sealW, sealH, r);
  c.fillStyle = '#b1362b';                 // 인주(주묵) 빨강
  c.fill();
  // 안쪽 눌림 테
  const lw = Math.max(1, sealW * 0.03);
  c.lineWidth = lw;
  roundRect(c, lw, lw, sealW - 2 * lw, sealH - 2 * lw, r * 0.7);
  c.strokeStyle = 'rgba(90,25,18,0.35)';
  c.stroke();

  // 백문(글자는 종이색으로 뚫림) — 한글 전각 '처마' 2자 세로 스택. 한국어 명조 폴백 체인.
  c.fillStyle = '#f4efe4';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const fs = Math.round(sealW * 0.56);
  c.font = `700 ${fs}px "AppleMyungjo","Nanum Myeongjo","Noto Serif CJK KR","Apple SD Gothic Neo",serif`;
  c.fillText('처', sealW / 2, sealH * 0.30);
  c.fillText('마', sealW / 2, sealH * 0.71);

  // 마모: 가장자리에 더 잦게 인주가 덜 묻은 자국을 파낸다.
  c.globalCompositeOperation = 'destination-out';
  const rnd = mulberry32(0x9e3779b9);
  const specks = Math.round(sealW * sealH * 0.02);
  for (let i = 0; i < specks; i++) {
    const px = rnd() * sealW, py = rnd() * sealH;
    const edge = Math.min(px, py, sealW - px, sealH - py) / (sealW * 0.5);
    if (rnd() < 0.5 + (1 - edge) * 0.5) {
      c.globalAlpha = 0.15 + rnd() * 0.5;
      c.beginPath();
      c.arc(px, py, 0.4 + rnd() * 1.6, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';

  // 합성 — 종이에 눌린 옅은 그림자.
  ctx.save();
  ctx.shadowColor = 'rgba(60,30,20,0.25)';
  ctx.shadowBlur = Math.max(2, sealW * 0.08);
  ctx.shadowOffsetY = Math.max(1, sealW * 0.03);
  ctx.drawImage(s, x, y);
  ctx.restore();

  // 옆 초소형 세리프 서명 (원본 6px 기준, 해상도 비례).
  const fs2 = Math.max(6, Math.round(H * 0.0095));
  ctx.font = `${fs2}px Georgia,"Times New Roman",serif`;
  ctx.fillStyle = 'rgba(40,34,28,0.72)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title || 'cheoma', x - Math.round(sealW * 0.35), y + sealH - fs2 * 0.3);
}

export function capturePostcard(renderer, render, { title = 'cheoma', filename, download = true } = {}) {
  render(); // 현재 모드로 한 프레임을 지금 렌더 → 드로잉 버퍼 유효

  const src = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;   // 디바이스 픽셀(=CSS폭 × pixelRatio)
  out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);

  drawSeal(ctx, out.width, out.height, title);

  const url = out.toDataURL('image/png');
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'cheoma.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return url;
}

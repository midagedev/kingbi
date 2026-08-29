import * as THREE from 'three';

// 시네마틱 카메라 드라이브 — 프레임워크 무관 ES 모듈.
//   setupCinematic(camera, controls, { getLayout | layout, domElement })
//     → { names, play(name), stop(), update(dt), isPlaying(), isActive(),
//         setProgress(t, name), record(name, onDone) }
//
// 각 드라이브는 카메라 위치 CatmullRomCurve3 + lookAt 타깃(Vector3 보간)으로 구성.
// 시간축은 easeInOutCubic 으로 매핑해 시작/끝 속도 0(orbit만 등속 루프).
// 드라이브 중에는 OrbitControls 를 끄고 카메라를 직접 몰며, controls.target 도
// 매 프레임 시선에 동기화한다 → 종료 시 OrbitControls 로 이음매 없이 넘어간다.

const DEG = Math.PI / 180;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const curve = (points, closed = false) => new THREE.CatmullRomCurve3(points, closed, 'centripetal');

// 치수(layout)로부터 5종 드라이브 경로를 만든다. 모든 좌표는 건물 원점 기준.
function buildDrives(L) {
  const { W, D, totalH, plateY, eaveEdgeY, podTopY, ridgeY, zEave } = L;
  // setAngle 과 동일한 기준 치수(프레이밍 스케일).
  const big = Math.max(W + 4, D + 4, totalH);
  // FOV 28 프레이밍 보정: 카메라 FOV 를 35→28 로 좁힌 만큼(tan(35/2)/tan(28/2)≈1.265)
  // 건물과의 거리(establishing/wide 반경)를 늘려 기존 프레이밍을 유지한다.
  const FR = 1.265;

  // three-quarter 안착 지점 — main.js setAngle('three-quarter') 공식과 동일.
  // (r=3.0*big 은 이미 FOV28 보정값이므로 FR 을 추가로 곱하지 않는다.)
  // reveal 종착을 여기에 맞춰 드라이브가 끝나면 OrbitControls 가 자연스럽게 잇는다.
  const tqTarget = v(0, totalH * 0.42, 0);
  const az = 38 * DEG, el = 13 * DEG, r = 3.0 * big; // setAngle 'three-quarter' r 과 동일
  const tqPos = v(
    r * Math.cos(el) * Math.sin(az),
    tqTarget.y + r * Math.sin(el),
    r * Math.cos(el) * Math.cos(az)
  );

  // orbit — 건물 3/4 높이를 바라보며 느린 등속 선회. 고도는 두 번 완만히 물결.
  // 반경은 spec 의 maxDim*2.2 에 FOV 보정(FR)을 곱하고, 카메라 고도를 캐노피 위로
  // 살짝 올려(수목 사이 매몰 방지) 3/4 높이를 내려다보게 한다.
  const R = big * 2.2 * FR;
  // 고도를 수목 캐노피(≈13m) 위로 확실히 띄운다: 최저점(camY-waveA)도 캐노피를
  // 넘겨 선회 중 나무 위를 지나가게 → 매몰 방지. 3/4 높이를 살짝 내려다본다.
  const camY = totalH * 1.28, waveA = totalH * 0.10;
  const orbitPts = [];
  const N = 24, th0 = Math.PI * 0.15;
  for (let i = 0; i < N; i++) {
    const th = th0 + (i / N) * Math.PI * 2;
    orbitPts.push(v(R * Math.sin(th), camY + Math.sin(th * 2) * waveA, R * Math.cos(th)));
  }

  return {
    // 3/4 높이를 응시하며 한 바퀴. 등속 루프(이징 없음).
    orbit: {
      duration: 24, loop: true,
      posCurve: curve(orbitPts, true),
      targetFixed: v(0, totalH * 0.72, 0),
    },
    // 멀리 정면 낮은 앵글 → 처마 밑까지 다가가 도리·공포가 화면을 채우며 끝.
    approach: {
      duration: 12, loop: false,
      posCurve: curve([
        v(0.0, podTopY + 2.0, big * 2.6 * FR),
        v(1.0, podTopY + 1.6, big * 1.7 * FR),
        v(2.5, plateY - 1.4, zEave + 6),
        v(3.0, plateY - 1.6, zEave + 2.6),
      ]),
      targetCurve: curve([
        v(0, totalH * 0.50, 0),
        v(0, totalH * 0.52, 0),
        v(0, eaveEdgeY + 0.5, 0),
        v(0, eaveEdgeY + 0.7, zEave * 0.35),
      ]),
    },
    // 지면 가까이 정면에서 상승 — 지붕 너머 뒤편 산 능선까지 드러나는 크레인.
    crane: {
      duration: 14, loop: false,
      posCurve: curve([
        v(0, 1.4, big * 1.60 * FR),
        v(0, totalH * 0.50, big * 1.65 * FR),
        v(0, totalH * 1.05, big * 1.70 * FR),
        v(0, totalH * 1.50, big * 1.75 * FR),
      ]),
      targetCurve: curve([
        v(0, podTopY + 1.0, 0),
        v(0, totalH * 0.55, 0),
        v(0, ridgeY, 0),
        v(0, ridgeY * 0.82, -big * 0.9),
      ]),
    },
    // 측면 멀리서 낮게 진입 → 처마 곁을 스치듯 통과, lookAt 이 건물을 따라 회전.
    flyby: {
      duration: 10, loop: false,
      posCurve: curve([
        v(big * 1.8 * FR, eaveEdgeY - 2.0, zEave + 3),
        v(W * 0.5 + 3, eaveEdgeY - 1.0, zEave + 2),
        v(0, eaveEdgeY - 0.6, zEave + 2.5),
        v(-(W * 0.5 + 3), eaveEdgeY - 1.0, zEave + 2),
        v(-big * 1.8 * FR, eaveEdgeY - 1.8, zEave + 4),
      ]),
      targetCurve: curve([
        v(W * 0.35, eaveEdgeY - 0.3, 0),
        v(0, eaveEdgeY - 0.6, 0),
        v(0, plateY, 0),
        v(0, eaveEdgeY - 0.6, 0),
        v(-W * 0.35, eaveEdgeY - 0.3, 0),
      ]),
    },
    // 건물 뒤편 능선 쪽 높은 곳 → 하강·전진하며 정면 3/4 뷰로 안착.
    reveal: {
      duration: 12, loop: false,
      posCurve: curve([
        v(big * 0.6 * FR, totalH * 1.70, -big * 1.4 * FR),
        v(big * 1.6 * FR, totalH * 1.20, -big * 0.3 * FR),
        v(big * 1.6 * FR, totalH * 0.90, big * 0.7 * FR),
        tqPos.clone(),
      ]),
      targetCurve: curve([
        v(0, ridgeY, 0),
        v(0, totalH * 0.50, 0),
        tqTarget.clone(),
        tqTarget.clone(),
      ]),
    },
  };
}

export function setupCinematic(camera, controls, { layout, getLayout, domElement } = {}) {
  const YMIN = 1.2; // 지형/건물 관통 방지 하한 (env.heightAt 대신 안전 마진)
  const resolveLayout = getLayout || (() => layout);
  let drives = buildDrives(resolveLayout());
  const names = Object.keys(drives);

  let state = 'idle';   // idle | playing | holding
  let current = names[0];
  let elapsed = 0;
  let singleCycle = false; // 녹화/정지프레임 시 loop 드라이브를 1회만 매핑
  let playScale = 1;       // play(opts.timeScale) — 드라이브 재생 배속(히어로 reveal 압축용)
  let recorder = null;

  const _pos = new THREE.Vector3();
  const _tgt = new THREE.Vector3();

  function frameAt(drive, t) {
    let u;
    if (drive.loop && !singleCycle) u = ((t % 1) + 1) % 1; // 등속 루프
    else if (drive.loop) u = clamp01(t);                   // loop 를 1회로
    else u = easeInOutCubic(clamp01(t));                   // 시작/끝 속도 0
    drive.posCurve.getPoint(u, _pos);
    if (drive.targetFixed) _tgt.copy(drive.targetFixed);
    else drive.targetCurve.getPoint(u, _tgt);
    if (_pos.y < YMIN) _pos.y = YMIN;
  }

  function apply() {
    camera.position.copy(_pos);
    controls.target.copy(_tgt); // controls.update() 와 좌표계 일치 → 시선 안 튐
    camera.lookAt(_tgt);
  }

  function play(name, opts = {}) {
    if (!drives[name]) return;
    drives = buildDrives(resolveLayout()); // 건물 재생성 후 최신 치수 반영
    current = name;
    elapsed = 0;
    singleCycle = !!opts.singleCycle;
    // 재생 배속(기본 1). <1 이면 드라이브가 그만큼 빨리 끝난다(히어로 reveal 압축).
    // 곡선/좌표는 불변 — 시간축만 스케일하므로 이징·안착 지점 그대로 유지.
    playScale = opts.timeScale > 0 ? opts.timeScale : 1;
    state = 'playing';
    controls.enabled = false;
  }

  function stop() {
    if (state === 'idle') return;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    state = 'idle';
    controls.enabled = true;
    controls.target.copy(_tgt); // 마지막 시선을 OrbitControls 에 인계
  }

  function finish() {
    frameAt(drives[current], 1); // 종착 프레임 확정
    apply();
    stop();
  }

  function update(dt) {
    if (state !== 'playing') return;
    const d = drives[current];
    elapsed += dt;
    const t = elapsed / (d.duration * playScale);   // playScale 로 재생 배속
    if ((!d.loop || singleCycle) && t >= 1) { finish(); return; }
    frameAt(d, t);
    apply();
  }

  // 정지 프레임(스크린샷/스크럽 검증). loop 드라이브도 t 를 그대로 매핑.
  function setProgress(t, name) {
    if (name && drives[name]) current = name;
    drives = buildDrives(resolveLayout());
    const d = drives[current];
    if (!d) return;
    singleCycle = d.loop;
    state = 'holding';
    controls.enabled = false;
    elapsed = clamp01(t) * d.duration;
    frameAt(d, clamp01(t));
    apply();
  }

  // 현재 드라이브를 t=0 부터 1사이클 재생하며 녹화 → joseon-{name}.webm 다운로드.
  function record(name, onDone) {
    const done = () => { if (onDone) onDone(); };
    if (!domElement || typeof domElement.captureStream !== 'function' || !window.MediaRecorder) {
      done(); return;
    }
    const stream = domElement.captureStream(60);
    let mime = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8';
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    } catch { done(); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `joseon-${name}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      recorder = null;
      done();
    };
    recorder = rec;
    rec.start();
    play(name, { singleCycle: true }); // loop 드라이브(orbit)도 1회만 녹화
  }

  // 사용자가 드래그/휠 하면 즉시 중단(정지프레임 holding 은 유지).
  const interrupt = () => { if (state === 'playing') stop(); };
  if (domElement) {
    domElement.addEventListener('pointerdown', interrupt, { passive: true });
    domElement.addEventListener('wheel', interrupt, { passive: true });
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    if (domElement) {
      domElement.removeEventListener('pointerdown', interrupt);
      domElement.removeEventListener('wheel', interrupt);
    }
  }

  return {
    names,
    play, stop, update, setProgress, record, dispose,
    isPlaying: () => state === 'playing',
    isActive: () => state !== 'idle',
  };
}

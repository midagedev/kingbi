// 야간 창호 실내광 — 밤에 한지 창이 호롱불 온기로 은은히 밝아 "생활감"을 준다.
//   setupNightGlow({ getBuilding }) → { setTime(name), onBuildingChanged(), setEnabled(v), dispose() }
//
// 구현 방침 (builder 파일 무수정 — weather.js 처럼 traverse/userData 접근만):
//  - night 일 때 건물 공유 재질(building.userData.materials)의 한지 창호(door·hanji)에
//    따뜻한 emissive(호롱불색)를 부여. emissiveMap = 재질 map 으로 두어 한지 밝은 부분만
//    발광하고 살·문틀은 어둡게(형광등 아닌 은은한 창빛). 절 살창(salchang)은 미약하게.
//  - 방별 결정론 dim·phase로 일부 창을 어둡게 하고 밝기 편차를 만든다. 레이아웃을 추정한 별도 광원이나
//    scene object를 추가하지 않으므로 벽 너머로 빛이 새거나 rebuild 때 조명 수가 바뀌지 않는다.
//  - 멱등(setTime 반복 안전), regenerate 시 재적용(onBuildingChanged), night 아니면 완전 원복.

const WARM = 0xffb35c;   // 호롱불 온기 (형광등 금지)

const fract = (x) => x - Math.floor(x);

// 촛불/호롱불 밝기 변조 계수 — 결정론적(시간 t·위상 phase 함수, 난수 없음 → shot 재현성).
//  저주파 숨쉬기 ±12%(비정수비 사인 2개) + 미세 고주파 지터 + 이따금 깊은 딥(바람, ~-30%).
//  위상별 딥 주기(5~8s)를 달리해 창·등불이 동기화되어 껌뻑이지 않게 한다.
export function candleFlicker(t, phase) {
  const breathe = 0.5 * Math.sin(t * 1.7 + phase) + 0.5 * Math.sin(t * 0.63 + phase * 1.7);
  const jitter = Math.sin(t * 9.3 + phase * 3.1);
  const period = 5.0 + 3.0 * fract(phase * 0.37 + 0.11);   // 5~8s
  const ph = fract(t / period + phase * 0.19);
  const dipW = 0.15 / period;                              // ~0.15s 폭
  const dip = ph < dipW ? -0.3 * Math.sin((ph / dipW) * Math.PI) : 0;
  const m = 1 + 0.12 * breathe + 0.03 * jitter + dip;
  return Math.min(1.15, Math.max(0.5, m));
}

export function setupNightGlow({ getBuilding }) {
  let disposed = false;
  let time = 'day';
  let enabled = false;
  let t = 0;   // 플리커 누적 시계(결정론)

  // 창빛 크로스페이드: 밤 진입/이탈 시 창호 발광을 nightness(0..1)로 서서히 밝히/꺼뜨린다.
  //   첫 프레임 전(setup) 호출은 즉시 스냅(로드 시 페이드-인 방지) — started 로 게이트.
  //   shot 은 setup 에서 스냅되어 캡처(3프레임) 재현성 유지.
  let nightness = 0;
  let nightGoal = 0;
  let started = false;
  const NIGHT_RATE = 2.4;   // ≈1.6s (sky 크로스페이드와 결이 맞게)

  // 원복용 재질 상태: [{ mat, emHex, emInt, emMap }]
  let patched = [];

  // 발광 대상 창·문 재질 수집(#66): 건물 트리를 훑어 userData.hanjiGlow 태그가 있는 재질을 모은다.
  //   문짝(門)은 walls.js/giwa.js 에서 per-mesh clone 되지만 태그가 클론에 전파되므로 창과 함께 잡힌다
  //   (구 코드는 공유 M.door 만 패치 → 클론 문짝은 발광 못 함 = 사용자 지적 "문으로도 빛"). 각 재질은
  //   base=단위면적 발광 계수(문<창), phase=플리커 위상, dim=방별 밝기 편차(일부 어둑한 방)를 부여한다.
  //   위상·편차는 traverse 순서(빌드 결정론)로 정해 shot 재현성 유지(난수 없음).
  function collectGlow(b) {
    if (!b) return [];
    const out = [], seen = new Set();
    let i = 0;
    b.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        const base = m && m.userData ? m.userData.hanjiGlow : null;
        if (base == null || seen.has(m)) continue;
        seen.add(m);
        const idx = i++;
        const h = fract(Math.sin((idx + 1) * 12.9898) * 43758.5453);   // 결정론 해시(방별)
        const dim = h < 0.16 ? 0.42 + h : 0.82 + 0.18 * h;             // ~16% 어둑한 방(불 꺼진 방 근사)
        out.push({ mat: m, base, phase: idx * 1.7, dim });
      }
    });
    return out;
  }
  function restore() {
    for (const rec of patched) {
      rec.mat.emissive.setHex(rec.emHex);
      rec.mat.emissiveIntensity = rec.emInt;
      rec.mat.emissiveMap = rec.emMap;
      rec.mat.needsUpdate = true;
    }
    patched = [];
  }

  function applyGlow() {
    const b = getBuilding && getBuilding();
    if (!b) return;
    restore();   // 멱등: 이전 상태 원복 후 신선하게 재적용

    for (const { mat, base, phase, dim } of collectGlow(b)) {
      patched.push({
        mat, emHex: mat.emissive.getHex(), emInt: mat.emissiveIntensity, emMap: mat.emissiveMap,
        base, phase, dim,
      });
      mat.emissive.setHex(WARM);
      mat.emissiveMap = mat.map || null;   // 살·문틀은 어둡게(맵 있는 문짝) / 민무늬 창은 면 균일(강도로 절제)
      mat.emissiveIntensity = base * dim;
      mat.needsUpdate = true;
    }
  }

  // 창호 emissive 강도를 nightness × (선택)플리커로 설정.
  function setGlowLevel(flickerOn) {
    for (const rec of patched) {
      const fl = flickerOn ? candleFlicker(t, rec.phase) : 1;
      rec.mat.emissiveIntensity = rec.base * rec.dim * nightness * fl;
    }
  }

  function reconcile() {
    nightGoal = (enabled && time === 'night') ? 1 : 0;
    if (!started) nightness = nightGoal;   // 로드 시 스냅(페이드-인 없음)
    if (nightness > 0.001) {
      if (!patched.length) applyGlow();     // 재질 패치(1회)
      setGlowLevel(false);                  // 즉시 레벨 반영(플리커는 update)
    } else if (patched.length) {
      restore();
    }
  }

  // 촛불 일렁임 + 밤 진입/이탈 크로스페이드. 매 프레임 호출(내부에서 게이트).
  function update(dt) {
    if (disposed) return;
    started = true;
    if (Math.abs(nightness - nightGoal) > 1e-4) {
      nightness += (nightGoal - nightness) * Math.min(1, dt * NIGHT_RATE);
      if (Math.abs(nightness - nightGoal) <= 1e-4) nightness = nightGoal;
      if (nightness > 0.001 && !patched.length) applyGlow();
      if (nightness <= 0.001 && patched.length) { restore(); return; }
    }
    if (!patched.length) return;
    t += dt;
    setGlowLevel(true);
  }

  function setTime(name) { if (disposed) return; time = name; reconcile(); }
  function setEnabled(v) { if (disposed) return; enabled = !!v; reconcile(); }
  function onBuildingChanged() { if (disposed) return; if (patched.length) restore(); reconcile(); }   // 새 건물 재질에 재적용
  function dispose() {
    if (disposed) return;
    disposed = true;
    enabled = false;
    nightGoal = 0;
    nightness = 0;
    restore();
  }

  return { setTime, onBuildingChanged, setEnabled, update, dispose };
}

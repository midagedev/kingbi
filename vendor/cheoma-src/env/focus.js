import * as THREE from 'three';
import { setupAnimals } from './animals.js';
import { setupSmoke } from './smoke.js';
import { setupMotes } from './motes.js';
import { setupLanternSway } from './lantern-sway.js';
import { makePresenceGate } from './present-gate.js';
import { setupGrass } from './grass.js';
import { attachOverlayLanterns, getLanternMaterials } from '../layout/props.js';
import { aerialLifePresence } from '../core/lod.js';
import {
  planFocusLitterSpots,
  seasonGroundCarpetGoal,
} from './season-ground-plan.js';
import { buildSeasonGroundCarpet } from './season-ground-carpet.js';

// 필지 스타일별 대문 개구부 폭(buildParcel STYLE_MAP 대응) — 풀이 대문 앞을 막지 않게 비운다.
const GATE_W = { palace: 6.6, temple: 6.6, hanok: 5.2, choga: 1.8 };

// 앰비언스 근접 링(#79·#84) — 부감에서 필지에 focus-in 하면 그 필지 반경에 "집 모드"의 풀 앰비언스
// (마당 닭·굴뚝 연기·먼지 모트·등롱 흔들림 + 날씨 시 지붕 적설/빗물)를 점등한다. 앰비언스는 배율에
// 종속 — 부감은 저비용 세트, focus-in 은 근접 링.
//
//   const ring = createFocusRing(scene, { heightAt, sun?, renderer? });
//   ring.set({ group, parcel, radius = 18, seed, getWeather? });  // group=풀디테일 buildParcel 컴파운드
//   ring.clear();                                     // focus-out — 페이드아웃 후 dispose
//   ring.update(dt, timeName, detailLod);             // 매 프레임. 지상/입자 LOD와 같은 연속 강도
//
// 원칙:
//  - 기존 env 시스템 재사용(신규 발명 금지): animals.js·smoke.js·motes.js(모트+등롱흔들림)·grass.js
//    + season-ground-carpet(#219 봄/가을 지면 카펫, 담 스커트·구석 스팟, +1 draw).
//    (#131: 지붕 적설 쉘·빗물 리벌릿 물리는 제거 — 눈은 weather.js 지붕 흰틴트(uSnowAmount)가 대체.)
//    (#215: 근경 처마 낙수·최소 스플래시는 weather.js eave-rain 이 소유 — 링에 붙이지 않는다.
//     엔진이 focus 오버레이를 setEaveSubject 로 넘긴다.)
//  - 활성/해제 모두 크로스페이드(팟 금지) — present-gate(조립 정착 후 상승)를 강도(strength)로 쓴다.
//  - 동시 1개 링만. set 재호출 시 기존 링을 페이드아웃(retiring) 후 교체, ~0 도달 시 dispose.
//  - dispose 철저: 지오/재질/텍스처 누수 금지(Sprite 공유 지오는 제외 — 전역 손상 방지).
//
// 날씨: 눈=지붕 흰틴트(weather uSnowAmount), 비=낙하 커튼 + #215 근경 처마 낙수(eave-rain).
//   readWeather 는 잔존하나 링 자체는 미사용(dormant) — eave-rain 은 engine setEaveSubject 경로.
//
// 좌표: buildParcel 컴파운드는 이미 필지 월드 위치에 놓여 있다(group.matrixWorld). 링 컨테이너는
//   씬 루트(identity)에 두고 모든 배치를 월드 좌표로 계산한다(populate 소동물 배치 패턴과 동일).

const CLEAR_WEATHER = Object.freeze({ accum: 0, rain: 0, snow: 0, wet: 0, wind: null });

// window.__wx(weather.js 노출) 자동 판독. getWeather 오버라이드 우선. 핫 루프에서 기존 객체를
// 그대로 읽어 반딧불 날씨 게이트 때문에 매 프레임 임시 객체가 생기지 않게 한다.
function readWeather(getWeather) {
  if (getWeather) { const w = getWeather(); if (w) return w; }
  if (typeof window !== 'undefined' && window.__wx) return window.__wx;
  return CLEAR_WEATHER;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

// 씬에서 태양(DirectionalLight)을 찾는다 — 계약 시그니처가 sun 을 강제하지 않으므로 폴백.
function findSun(scene) {
  let sun = null;
  scene.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
  return sun;
}

// 서브트리 dispose: 지오·재질·텍스처를 중복 제거해 각 1회만 해제한다.
//   Sprite 는 three 내부 공유 지오(_geometry)를 쓰므로 지오 dispose 제외(전역 손상 방지).
function disposeSubtree(obj) {
  const geos = new Set(), mats = new Set(), texs = new Set();
  obj.traverse((o) => {
    if (o.geometry && !o.isSprite) geos.add(o.geometry);
    const m = o.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => mm && mats.add(mm));
  });
  for (const m of mats) for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
  for (const t of texs) t.dispose();
  for (const m of mats) m.dispose();
  for (const g of geos) g.dispose();
}

// 단일 링 인스턴스(활성 또는 페이드아웃 중). 자기 컨테이너·서브시스템·게이트를 소유한다.
function makeRing({
  scene, heightAt, sun, renderer, group, parcel, radius, seed, getWeather, season,
  chickens, grassObstacles,
}) {
  const container = new THREE.Group();
  container.name = 'focusRing';
  // Hop 중 active/retiring 링이 공존하므로 검증·조명 풀은 각 링의 필지 소유권을
  // 전역 개수 대신 이 안정적인 id로 구분한다.
  container.userData.parcelId = parcel?.id || group.userData?.parcel?.id || null;
  scene.add(container);

  // focus 오버레이의 월드 변환(위치·회전) — 이미 배치 완료 상태.
  group.updateWorldMatrix(true, false);
  group.matrixWorld.decompose(_pos, _quat, _scl);
  const worldX = _pos.x, groundY = _pos.y, worldZ = _pos.z;
  // 필지 강체행렬(위치·회전, 스케일 무시) — 풀 배치를 로컬에서 계산해 이 행렬로 월드 변환.
  const parcelRigid = new THREE.Matrix4().compose(_pos.clone(), _quat.clone(), new THREE.Vector3(1, 1, 1));
  const parcelRigidInv = parcelRigid.clone().invert();

  // 필지 치수(buildParcel 이 root.userData 에 심음). 없으면 보수적 기본값.
  const ud = group.userData || {};
  const W = ud.W || 20, D = ud.D || 18, style = ud.style || 'hanok';
  const residential = style === 'choga' || style === 'hanok' || style === 'giwa';

  // 마당(닭 무리) 월드 앵커: parcel.yard(월드) 우선, 없으면 필지 로컬 앞마당(+z 대문측·+x off-axis)을
  //   오버레이 월드행렬로 변환(회전 반영). buildParcel 좌표규약: +z=남(대문), 몸채는 -z(북).
  let yardX, yardZ, yardR;
  if (parcel?.hero && residential) {
    // Residential hero compounds have a deep south gate and side corridors. The
    // regular parcel yard anchor sits immediately behind that gate, hiding the whole
    // flock even at the courtyard camera elevation. Keep domestic life in the open
    // inner yard; formal government/palace heroes never opt into this domestic policy.
    const local = new THREE.Vector3(W * 0.18, 0, D * 0.10).applyMatrix4(group.matrixWorld);
    yardX = local.x; yardZ = local.z;
  } else if (parcel && parcel.yard && Number.isFinite(parcel.yard.x)) {
    yardX = parcel.yard.x; yardZ = parcel.yard.z; yardR = parcel.yard.r;
  } else {
    const local = new THREE.Vector3(W * 0.08, 0, D * 0.24).applyMatrix4(group.matrixWorld);
    yardX = local.x; yardZ = local.z;
  }
  if (yardR == null) yardR = Math.max(1.4, Math.min(3.2, Math.min(W, D) * 0.11));

  // 소동물: 격식 건물(궁·절·관아) 마당엔 닭이 부적절하다. 호출자가 base flock 중복을
  // 피하려고 `chickens`를 명시해도 주거 style 경계 밖에서는 국내 가축을 되살리지 않는다.
  const requestedChickens = chickens != null
    ? !!chickens
    : parcel && parcel.chickens != null ? !!parcel.chickens : true;
  const wantChickens = residential && requestedChickens;
  const cowSite = parcel && parcel.cowSite ? parcel.cowSite : null;

  // 1) 소동물 — 이미 populate base flock이 있는 필지는 그 LOD-managed flock을 그대로 쓴다.
  // focus ring이 같은 마당에 두 번째 flock을 만들지 않으면 lease/즉시 hide/교체 pop이 모두 사라지고,
  // 원거리→근거리 발현은 공통 village detail weight 하나가 계속 소유한다.
  const animals = (wantChickens || cowSite) ? setupAnimals(container, {
    heightAt: () => groundY,
    yard: { x: yardX, z: yardZ, r: yardR },
    cowSite,
    seed: (seed ^ 0x6b17) >>> 0,
    chickens: wantChickens,
  }) : null;
  container.userData.hasAnimals = !!animals;
  container.userData.hasChickens = wantChickens;

  // 2) 굴뚝 연기·아궁이 — 오버레이 내부 몸채 조회(교체 self-heal). name='chimney'(plan emission) + agungi*.
  const getBuilding = () => group.getObjectByName('building') || group.getObjectByName('hanok') || null;
  const smoke = setupSmoke({ scene, getBuilding });
  container.add(smoke.group);
  smoke.setEnabled(true);

  // 3) 먼지 모트 — 마당 볼륨 한정(반경을 필지에 맞춰 좁힘). 볼륨을 필지 상공으로 이설.
  //    수직 스팬을 납작하게(ySpan) + centerY 낮춰 "대기 헤이즈"가 아닌 "마당 먼지"로 조인다(#79 크리틱).
  //    최대 높이 ≈ centerY + moteR*ySpan ≈ 지붕 처마선(≈2.8+moteR·0.22) — 마루 위로 뜨지 않게.
  const moteR = Math.min(radius, Math.max(5.5, Math.max(W, D) * 0.5));
  const motes = setupMotes({
    scene, sun, renderer, radius: moteR, centerY: 2.8, ySpan: 0.22, count: 90,
    isInk: () => renderer?.toneMapping === THREE.NoToneMapping,
    fireflies: true, // 인스턴스 중 ~8% — 여름·맑은 밤에만 희박한 물리 보케 씨앗
  });
  motes.group.position.set(worldX, groundY, worldZ);
  container.add(motes.group);
  motes.setEnabled(true);
  motes.setSeason(season, { immediate: true });

  // 4) 등롱 바람 흔들림 — focus 오버레이 스코프(env 전역 lanternSway 와 대상 분리). 오버레이(parcel-*)는
  //    emitLight:false 로 발광 bulb 만 갖는다(#141) → light 없이 bulb 만 흔들린다.
  const lantern = setupLanternSway({ scene, getBuilding, scope: group });
  lantern.setEnabled(true);
  // 오버레이 등롱 국소 조명(#141): 오버레이는 PointLight 를 안 갖는다(개수 요동 방지). bulb 를 모아
  //   createFocusRing 고정 풀(ringPool)이 링 강도로 점등 → focus-in/out·hop 로 오버레이가 add/remove
  //   돼도 씬 조명 개수 불변. group 직속 자식 bulb 만 수집(frame·건물 배제).
  const ringLanterns = [];
  for (const c of group.children) if (c.name === 'lantern-bulb') ringLanterns.push({ bulb: c, baseI: 0.65 });

  // 4.5) 바람 풀(#90) — 담장 밑·마당 가장자리·필지 외곽에 인스턴스드 풀 포기. 마당 중앙 동선·
  //    건물 발자국·대문 앞은 비운다. 버텍스 셰이더 흔들림(wind.js 판독, 연기·낙엽과 동방향).
  //    로컬 필지 좌표로 배치 후 강체행렬로 월드 변환(회전 반영). 마당(닭) 중심은 로컬로 환산해 비움.
  const yardLocal = new THREE.Vector3(yardX, groundY, yardZ).applyMatrix4(parcelRigidInv);
  const grass = setupGrass(container, {
    bounds: { W, D }, matrix: parcelRigid,
    yard: { x: yardLocal.x, z: yardLocal.z, r: yardR },
    style, gateW: GATE_W[style] || 2.4,
    sun, seed: (seed ^ 0x3aa9) >>> 0, season, grassObstacles,
    // 담 밑동은 낮게 비켜 준다 — mud-wall.md 가 authored 한 하부 습윤 흔적·막돌 굽이 근접 컷에서
    //   보여야 한다(docs/architectural-authenticity.md §7.5 W3-3). 배제 규칙 본문은 grass.js.
    wallSkirt: 0.55,
  });

  // 4.6) 계절 지면 카펫(#219 / U4) — 봄 벚꽃 패치·가을 낙엽. 담 스커트·마당 구석 스팟만
  //    (전 필지 고밀도 카펫 금지). 단일 InstancedMesh(+1 draw), FAR Points 없음. 부감은 링 자체가
  //    없으므로 자동 소거. ground strength 와 동기.
  const gateW = GATE_W[style] || 2.4;
  const carpetSpots = planFocusLitterSpots({
    W, D, gateW, seed: (seed ^ 0x7c11) >>> 0,
  });
  const carpet = buildSeasonGroundCarpet({
    spots: carpetSpots,
    name: 'focusSeasonLitter',
    season: seasonGroundCarpetGoal(season) ? season : 'autumn',
  });
  const carpetRoot = new THREE.Group();
  carpetRoot.name = 'focusSeasonLitterRoot';
  carpetRoot.position.set(worldX, groundY, worldZ);
  carpetRoot.quaternion.copy(_quat);
  if (carpet) {
    carpetRoot.add(carpet.mesh);
    container.add(carpetRoot);
    if (seasonGroundCarpetGoal(season)) {
      carpet.setSeason(season);
      // strength 램프 전까지 숨김 — update 가 level 을 소유.
      carpet.setLevel(0);
    }
  }
  let carpetSeason = season || 'summer';

  // 5) 지붕 적설/빗물(#131): 눈 쌓임 볼륨 쉘·빗물 리벌릿 물리는 사용자 지시로 제거(roofcapture +
  //    2×mergeGeometries 성능 부담). 눈은 weather.js 지붕 흰틴트(uSnowAmount 공유 uniform)가 대체하고
  //    focus-in 지붕도 그 전역 셰이더 틴트로 자동 흰색화(별도 배선 불필요), 비는 낙하 커튼만 남긴다.

  // present-gate 를 강도(strength)로 재사용: 조립 정착(delay) 후 상승(up), 해제 시 하강(down).
  //   첫 프레임 present=false 강제(prime→0) → 오버레이가 이미 보여도 팟 없이 페이드인.
  const gate = makePresenceGate({ delay: 0.9, up: 0.7, down: 0.6 });
  let firstFrame = true;
  let phase = 'in';   // 'in' 활성 | 'out' 페이드아웃(retiring)
  let strength = 0, particleStrength = 0, baseStrength = 0;
  let _wt = 0;        // 날씨 시뮬 시계(__wx.wind 부재 시 getWind 폴백용)
  let disposed = false;

  function setTime(name, immediate) {
    animals?.setTime(name);
    smoke.setTime(name, { immediate: !!immediate });
    motes.setTime(name, { immediate: !!immediate });
    grass.setTime(name, { immediate: !!immediate });
  }
  function setSeason(name, opts = {}) {
    grass.setSeason(name, opts);
    motes.setSeason(name, opts);
    carpetSeason = name;
    if (carpet && seasonGroundCarpetGoal(name)) carpet.setSeason(name);
  }

  function update(dt, detailLod = 1) {
    let present;
    if (phase === 'out') present = false;
    else if (firstFrame) present = false;               // prime → 0(팟 방지)
    else { const b = getBuilding(); present = !!(b && b.visible); }
    firstFrame = false;
    baseStrength = gate.update(dt, { present });
    const groundWeight = typeof detailLod === 'number'
      ? detailLod : (detailLod?.groundWeight ?? 1);
    const particleWeight = typeof detailLod === 'number'
      ? detailLod : (detailLod?.particleWeight ?? groundWeight);
    strength = baseStrength * Math.max(0, Math.min(1, groundWeight));
    particleStrength = baseStrength * Math.max(0, Math.min(1, particleWeight));

    animals?.setFade(strength);
    smoke.setFade(particleStrength);
    motes.setFade(particleStrength);
    motes.setLensScale(detailLod?.lensScale ?? 1);
    motes.setWeather(readWeather(getWeather));
    grass.setFade(strength);
    if (carpet) {
      carpet.setLevel(strength * seasonGroundCarpetGoal(carpetSeason));
    }

    // 0에 가까운 링은 렌더뿐 아니라 시뮬레이션도 쉰다. gate 자체는 계속 흘러 다음 근접
    // 프레임에 자연스럽게 이어지고, 보이는 단계에서만 소동물·입자 행렬을 갱신한다.
    if (strength > 0.002) {
      animals?.update(dt);
      lantern.update(dt);
      grass.update(dt);
    }
    if (particleStrength > 0.002) {
      smoke.update(dt);
      motes.update(dt);
    }

    // 지붕 적설/빗물(#131): 물리 제거됨 — 눈은 weather.js 지붕 흰틴트가, 비는 낙하 커튼이 담당(위 5 참조).
  }

  function beginOut() { phase = 'out'; }
  function dead() { return phase === 'out' && baseStrength < 0.01; }
  function dispose() {
    if (disposed) return;
    disposed = true;
    smoke.setEnabled(false);    // 건물의 아궁이 불씨(그룹 밖 라이트)까지 소등 후 해제
    lantern.setEnabled(false);
    motes.dispose();
    if (carpet) {
      carpetRoot.remove(carpet.mesh);
      carpet.dispose();
    }
    scene.remove(container);
    disposeSubtree(container);
  }

  return { setTime, setSeason, update, beginOut, dead, dispose, lanterns: ringLanterns, get strength() { return strength; }, get phase() { return phase; } };
}

export function createFocusRing(scene, { heightAt = () => 0, sun = null, renderer = null } = {}) {
  const _sun = sun || findSun(scene);
  let active = null;
  const retiring = [];
  let curTime = 'day';
  let curSeason = 'summer';

  // 오버레이 등롱 국소 조명 고정 풀(#141) — createFocusRing 수명 동안 씬에 상주하는 RING_POOL_N 개
  //   PointLight. 항상 visible(개수 불변) → focus-in/out·hop 로 오버레이가 add/remove 돼도 씬 조명
  //   개수 불변. 미사용은 intensity 0 파킹. 활성 링(≤3 등롱) 우선 배정, 남으면 페이드아웃 링(hop
  //   크로스페이드)에 배분. 카메라 불요(단일 필지라 링 강도로만 점등).
  const RING_POOL_N = 4;
  const ringPool = (() => {
    const lights = [];
    for (let i = 0; i < RING_POOL_N; i++) {
      const l = new THREE.PointLight(0xffb266, 0, 5.5, 2);   // attachOverlayLanterns 등롱과 동일 파라미터
      l.name = 'ringPoolLight'; l.castShadow = false; l.visible = true;
      scene.add(l); lights.push(l);
    }
    const _wp = new THREE.Vector3();
    function assign() {
      let slot = 0;
      const use = (ring) => {
        if (!ring || slot >= RING_POOL_N) return;
        const ls = ring.lanterns, s = ring.strength;
        if (!ls || !ls.length || s < 0.02) return;
        for (const L of ls) {
          if (slot >= RING_POOL_N) break;
          L.bulb.getWorldPosition(_wp);
          lights[slot].position.copy(_wp); lights[slot].intensity = L.baseI * s; slot++;
        }
      };
      use(active);
      for (const r of retiring) use(r);
      for (; slot < RING_POOL_N; slot++) lights[slot].intensity = 0;
    }
    function dispose() { for (const l of lights) scene.remove(l); }
    return { assign, dispose };
  })();

  // 활성 링 점등. 기존 링은 페이드아웃 대기열로. getWeather: __wx 대신 쓸 명시 날씨 게터(선택).
  //   season: 풀 색 계절(spring|summer|autumn|winter). 기본 현행 유지(마지막 setSeason 값).
  function set({
    group, parcel = null, radius = 18, seed = 4343, getWeather = null, season,
    chickens = null, grassObstacles = null,
  } = {}) {
    if (!group) return;
    if (season) curSeason = season;
    if (active) { active.beginOut(); retiring.push(active); active = null; }
    const next = makeRing({
      scene, heightAt, sun: _sun, renderer, group, parcel, radius,
      seed: seed >>> 0, getWeather, season: curSeason, chickens,
      grassObstacles,
    });
    try {
      next.setTime(curTime, true);   // 시간대 프로파일 즉시 정합(발현 세기는 strength 로 페이드)
      active = next;
    } catch (error) {
      next.dispose();
      throw error;
    }
  }

  function setTime(name, immediate = false) {
    if (!name) return;
    curTime = name;
    if (active) active.setTime(name, immediate);
    for (const r of retiring) r.setTime(name, immediate);
  }

  // 계절 변경(풀 색 크로스페이드). 앱 engine 이 env.setSeason 과 나란히 호출(main 배선 명세).
  function setSeason(name, opts = {}) {
    if (!name) return;
    curSeason = name;
    if (active) active.setSeason(curSeason, opts);
    for (const r of retiring) r.setSeason(curSeason, opts);
  }

  // focus-out: 활성 링 페이드아웃 후 dispose.
  function clear() {
    if (active) { active.beginOut(); retiring.push(active); active = null; }
  }

  function update(dt, timeName, detailLod = 1) {
    if (timeName && timeName !== curTime) setTime(timeName, false);
    if (active) active.update(dt, detailLod);
    for (let i = retiring.length - 1; i >= 0; i--) {
      const r = retiring[i];
      r.update(dt, detailLod);
      if (r.dead()) { r.dispose(); retiring.splice(i, 1); }
    }
    ringPool.assign();   // #141 오버레이 등롱 국소광을 고정 풀에 배정(개수 불변)
  }

  // 전체 해제(즉시 dispose — 씬 파괴 시).
  function dispose() {
    if (active) { active.dispose(); active = null; }
    for (const r of retiring) r.dispose();
    retiring.length = 0;
    ringPool.dispose();
  }

  return {
    set, clear, setTime, setSeason, update, dispose,
    // 검증 전용: 현재 활성 링 강도(0..1)·페이드아웃 대기 수.
    get strength() { return active ? active.strength : 0; },
    get retiringCount() { return retiring.length; },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 카메라 앵커 앰비언스 필드(#105)
// ══════════════════════════════════════════════════════════════════════════════
// 선택 종속(focus 링 1개)이던 앰비언스를 카메라 지면점 기준 3계층 LOD 필드로 확장한다. 어댑터가
// updateLod(camera) 경로에서 구동하며, 비선택(인스턴스) 이웃 필지에 계층별 앰비언스를 점등한다.
//   (선택 필지 자체는 engine focusRing 이 풀 오버레이 링으로 담당 — 필드는 excluded 로 제외해 중복 방지.)
//
//   const field = createAmbientField(scene, { heightAt, sun, renderer, deferSceneServices });
//   field.setParcels(descriptors);         // 어댑터가 필지 서술자 배열 주입(월드좌표·치수·굴뚝·seed)
//   field.setExcluded(fn);                 // (id)=>bool — 오버레이(선택) 필지 제외
//   field.setTime(name, immediate); field.setSeason(name);
//   field.update(dt, camera);              // 매 프레임(어댑터 update 에서 same-frame dt·camera). 없으면 no-op.
//   field.dispose();
//   window.__ambLookahead(x, z)            // 시네마틱 프리워밍 훅 — 드론 경로 앞 지점 선행 점등(TTL)
//
// 3계층:
//   근접(NEAR): 먼지 모트(여름 맑은 밤 일부는 반딧불) + 등롱 sway + 공유 굴뚝 연기. 캡 NEAR_CAP.
//               (풀·소동물·지붕 날씨 오버레이는 오버레이 지오가 필요 → 선택 필지 engine 링 전용.
//                필드 이웃은 지오가 없어 생략 — 드로우콜 예산 준수. 풀은 #106 그대로 engine 링 +1.)
//   중간(MID) : 등롱 sway(프레임 제거 bulb+light) + 공유 굴뚝 연기. 캡 MID_CAP, 거리랭크 LRU 교체.
//   원경      : 어댑터 기존 일괄(vnight·정적 등롱 발광) — 필드 무개입.
//
// 원칙:
//  - 히스테리시스: 진입 반경 < 이탈 반경(1인칭 워커가 경계에서 왕복해도 명멸 없게).
//  - 속도 게이트: 카메라 이동 속도(위치 히스토리 추정)가 높으면 신규 점등 억제, 감속 시 재개.
//  - 프레임 분산: 한 프레임에 신규 셀 1개까지(히치 방지).
//  - 크로스페이드: 셀 present-gate(팟 금지). 공유 연기는 앵커 집합 변경에도 게이트 미리셋(smoke gateOnChange=false).
//  - 공유 연기: 굴뚝 앵커를 합성 name='chimney' 미니 메시(비렌더)로 등록 → setupSmoke 재사용(smoke.js 무개입).
//  - 드로우콜 절약: 등롱은 프레임(갓·끈·기둥) 제거 후 bulb+light 만(공유 재질). 셀 dispose 시 공유 재질 미해제.

const NEAR_ENTER = 26, NEAR_EXIT = 34;     // 근접 진입/이탈 반경(m) — 히스테리시스 8m
const MID_ENTER = 62, MID_EXIT = 74;       // 중간 진입/이탈 반경(m) — 히스테리시스 12m
const NEAR_CAP = 2, MID_CAP = 6;           // 계층별 동시 셀 상한
const SPEED_GATE = 18, SPEED_RESUME = 11;  // 신규 점등 억제 속도(m/s) — 히스테리시스
// 공유 연기 캡(스프라이트 = 개별 드로우콜). 부감에서 마을이 살아있음을 전하는 유일한 표현이므로
//   골든의 24 드로우 예산을 컬럼 수 쪽으로 재배분한다(6기둥 × 5입자 = 30 — 부감 예산 +75~100 안).
const SMOKE_ANCHORS = 6, SMOKE_PARTICLES = 5;
const LOOKAHEAD_TTL = 3.0;                  // 프리워밍 지점 유효시간(초) — 갱신 없으면 소멸

const nowSec = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

export function createAmbientField(scene, {
  heightAt = () => 0,
  sun = null,
  renderer = null,
  // 웨이브의 새 필드는 smoke/motes/bulb만 미리 붙인다. PointLight 10개와 전역 lookahead는
  // 옛 필드가 해제되는 승격 프레임에 넘겨받아 light-count shader variant를 늘리지 않는다.
  deferSceneServices = false,
} = {}) {
  const _sun = sun || findSun(scene);
  const shared = getLanternMaterials();
  const sharedMats = new Set([shared.glow, shared.frame]);   // 셀 dispose 시 미해제(공유 재질 보호)

  let parcels = [];
  const descById = new Map();
  let excluded = () => false;
  let curTime = 'day', curSeason = 'summer';
  let enabled = true;
  let lastOwnerWeight = 1;

  // 공유 굴뚝 연기 — 다중 앵커(합성 chimney 메시)를 하나의 스프라이트 풀로. 앵커 집합 변경에도 미명멸.
  const anchorGroup = new THREE.Group(); anchorGroup.name = 'ambFieldChimneys';
  scene.add(anchorGroup);
  const chimneyGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const chimneyMat = new THREE.MeshBasicMaterial({ visible: false });   // 비렌더(드로우콜 0), bbox 만 제공
  const smoke = setupSmoke({ scene, getBuilding: () => anchorGroup, particles: SMOKE_PARTICLES, maxAnchors: SMOKE_ANCHORS, gateOnChange: false });
  scene.add(smoke.group);
  smoke.setTime(curTime, { immediate: true });
  smoke.setEnabled(true);
  let smokeKey = '';
  let smokeFade = 0;

  const cells = new Map();   // id -> cell(active)
  const retiring = [];
  let frameNo = 0;

  // PointLight 고정 풀(#141) — 필드 수명 동안 씬에 상주하는 POOL_N 개 PointLight. 항상 visible 이라
  //   씬의 numPointLights 가 상수(=재컴파일 폭풍 소멸). 미사용 슬롯은 intensity 0 으로 파킹(visible=false 는
  //   개수에서 빠져 다시 요동하므로 금지). 매 프레임 active/retiring 셀 등롱을 카메라 근접 순으로 배정,
  //   초과분은 자연 탈락(기존에도 원경 등롱은 국소광이 약했음). N=10 은 근접 우선 점등 + 프래그먼트 상한.
  const POOL_N = 10;
  function makeLightPool() {
    const lights = [];
    for (let i = 0; i < POOL_N; i++) {
      const l = new THREE.PointLight(0xffb266, 0, 5.5, 2);   // attachOverlayLanterns 등롱과 동일 파라미터
      l.name = 'ambPoolLight'; l.castShadow = false; l.visible = true;
      scene.add(l); lights.push(l);
    }
    const _wp = new THREE.Vector3();
    const _cand = [];   // 재사용 후보 배열(프레임당 clear)
    function assign(camera) {
      _cand.length = 0;
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      const gather = (cell) => {
        const ls = cell.lanterns; if (!ls) return;
        const s = cell.strength; if (s < 0.02) return;
        for (const L of ls) {
          L.bulb.getWorldPosition(_wp);
          const dx = _wp.x - cx, dy = _wp.y - cy, dz = _wp.z - cz;
          _cand.push({ x: _wp.x, y: _wp.y, z: _wp.z, i: L.baseI * s, d: dx * dx + dy * dy + dz * dz });
        }
      };
      for (const c of cells.values()) gather(c);
      for (const r of retiring) gather(r);
      _cand.sort((a, b) => a.d - b.d);
      for (let i = 0; i < POOL_N; i++) {
        const c = _cand[i];
        if (c) { lights[i].position.set(c.x, c.y, c.z); lights[i].intensity = c.i; }
        else lights[i].intensity = 0;
      }
    }
    function clear() { for (const l of lights) l.intensity = 0; }
    function dispose() { for (const l of lights) scene.remove(l); }
    return { assign, clear, dispose, get size() { return POOL_N; } };
  }
  let lightPool = null;

  // 카메라 히스토리(속도) + 앵커(지면점) + 룩어헤드(프리워밍).
  const _camPrev = new THREE.Vector3(); let _camHas = false; let speed = 0; let speedHot = false;
  const _dir = new THREE.Vector3();
  let anchorX = 0, anchorZ = 0;
  let lookahead = null;      // { x, z, t }
  const lookaheadFn = (x, z) => { if (Number.isFinite(x) && Number.isFinite(z)) lookahead = { x, z, t: nowSec() }; };
  function activateSceneServices() {
    if (!lightPool) lightPool = makeLightPool();
    if (typeof window !== 'undefined') window.__ambLookahead = lookaheadFn;
  }
  if (!deferSceneServices) activateSceneServices();

  // ── 셀 공용 helpers ──
  function stripLanternFrames(scope) {
    for (let i = scope.children.length - 1; i >= 0; i--) {
      const c = scope.children[i];
      if (c.name === 'lantern-frame') { c.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); scope.remove(c); }  // 지오만(재질 공유)
    }
  }
  function attachSway(container, desc) {
    const scope = new THREE.Group();
    scope.position.set(desc.cx, desc.baseY, desc.cz); scope.rotation.y = desc.rotY;
    container.add(scope);
    // PointLight 풀링(#141): 셀은 발광 bulb(공유 glow 재질 emissive — 야간 어댑터가 hanjiGlow 로 점등)만
    //   두고 PointLight 는 심지 않는다(emitLight:false). 셀 스핀업/은퇴마다 조명 개수가 요동해 씬 전체
    //   조명 재질이 개수별로 재컴파일되는 전환 셰이더 폭풍을 막는다. 국소 조명(warm cast)은 필드 고정
    //   풀(makeLightPool)이 카메라 근접 순으로 배정한다.
    attachOverlayLanterns(scope, { style: desc.style, W: desc.W, D: desc.D, seed: desc.seed, emitLight: false });
    stripLanternFrames(scope);
    const bulbs = [], lanterns = [];
    for (const c of scope.children) {
      if (c.name === 'lantern-bulb') { bulbs.push({ mesh: c, base: c.scale.clone() }); lanterns.push({ bulb: c, baseI: 0.65 }); }
    }
    const sway = setupLanternSway({ scene, scope }); sway.setEnabled(true);   // light 없이 bulb 만 흔들림(#141)
    return { sway, bulbs, lanterns };
  }
  function applyLanternFade(bulbs, s) {
    for (const b of bulbs) {
      b.mesh.visible = s > 0.002;
      b.mesh.scale.set(b.base.x * s, b.base.y * s, b.base.z * s);
    }
  }
  // 셀 dispose: 지오·전용 재질만 해제(공유 등롱 재질 보호). motes ShaderMaterial·bulb SphereGeometry 등.
  function disposeCell(container) {
    const geos = new Set(), mats = new Set(), texs = new Set();
    container.traverse((o) => {
      if (o.geometry && !o.isSprite) geos.add(o.geometry);
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => { if (mm && !sharedMats.has(mm)) mats.add(mm); });
    });
    for (const m of mats) for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
    for (const t of texs) t.dispose();
    for (const m of mats) m.dispose();
    for (const g of geos) g.dispose();
  }

  function makeCell(tier, container, desc, subs) {
    const gate = makePresenceGate({ delay: 0.12, up: 0.7, down: 0.6 });
    let firstFrame = true, phase = 'in', strength = 0, baseStrength = 0;
    return {
      tier, container, desc, _dist: 0, touch: frameNo,
      lanterns: subs.lanterns || null,   // #141 풀 배정용(bulb 월드좌표·baseI). strength 곱해 국소 조명.
      setTime(name, imm) { if (subs.motes) subs.motes.setTime(name, { immediate: !!imm }); },
      setSeason(name, imm) { if (subs.motes) subs.motes.setSeason(name, { immediate: !!imm }); },
      update(dt, detailLod = 1) {
        const present = phase === 'out' ? false : firstFrame ? false : true;   // 첫 프레임 prime→0(팟 방지)
        firstFrame = false;
        baseStrength = gate.update(dt, { present });
        const groundWeight = typeof detailLod === 'number'
          ? detailLod : (detailLod?.groundWeight ?? 1);
        const particleWeight = typeof detailLod === 'number'
          ? detailLod : (detailLod?.particleWeight ?? groundWeight);
        strength = baseStrength * groundWeight;
        const particleStrength = baseStrength * particleWeight;
        if (subs.motes) {
          subs.motes.setFade(particleStrength);
          subs.motes.setLensScale(detailLod?.lensScale ?? 1);
          subs.motes.setWeather(readWeather());
          if (particleStrength > 0.002) subs.motes.update(dt);
        }
        if (subs.sway && strength > 0.002) subs.sway.update(dt);
        applyLanternFade(subs.bulbs, strength);
      },
      beginOut() { phase = 'out'; },
      dead() { return phase === 'out' && baseStrength < 0.02; },
      dispose() {
        if (subs.sway) subs.sway.setEnabled(false);
        if (subs.motes) subs.motes.dispose();
        scene.remove(container);
        disposeCell(container);
      },
      get strength() { return strength; },
    };
  }
  function buildNearCell(desc) {
    const container = new THREE.Group(); container.name = 'ambNear'; scene.add(container);
    const moteR = Math.max(5.5, Math.max(desc.W, desc.D) * 0.5);
    const motes = setupMotes({
      scene, sun: _sun, renderer, radius: moteR, centerY: 2.8, ySpan: 0.22, count: 70,
      isInk: () => renderer?.toneMapping === THREE.NoToneMapping,
      fireflies: true,
    });
    motes.group.position.set(desc.cx, desc.baseY, desc.cz);
    container.add(motes.group); motes.setEnabled(true);
    motes.setTime(curTime, { immediate: true });
    motes.setSeason(curSeason, { immediate: true });
    const sway = attachSway(container, desc);
    return makeCell('near', container, desc, { motes, ...sway });
  }
  function buildMidCell(desc) {
    const container = new THREE.Group(); container.name = 'ambMid'; scene.add(container);
    const sway = attachSway(container, desc);
    return makeCell('mid', container, desc, { ...sway });
  }

  // ── 티어 판정(히스테리시스) ──
  function tierFor(cur, dist) {
    if (cur === 'near') return dist <= NEAR_EXIT ? 'near' : dist <= MID_EXIT ? 'mid' : null;
    if (cur === 'mid') return dist <= NEAR_ENTER ? 'near' : dist <= MID_EXIT ? 'mid' : null;
    return dist <= NEAR_ENTER ? 'near' : dist <= MID_ENTER ? 'mid' : null;
  }

  function computeAnchor(camera) {
    camera.getWorldDirection(_dir);
    if (_dir.y < -1e-3) {
      const t = -camera.position.y / _dir.y;   // y=0 평면(지면) 교점 = 카메라가 보는 지면점
      if (t > 0 && t < 1400) { anchorX = camera.position.x + _dir.x * t; anchorZ = camera.position.z + _dir.z * t; return; }
    }
    anchorX = camera.position.x; anchorZ = camera.position.z;   // 위/수평 시선 폴백
  }
  function updateSpeed(camera, dt) {
    if (_camHas && dt > 1e-4) {
      const inst = camera.position.distanceTo(_camPrev) / dt;
      speed += (inst - speed) * Math.min(1, dt * 6);   // 평활(순간 지터 억제)
    }
    _camPrev.copy(camera.position); _camHas = true;
    if (speed > SPEED_GATE) speedHot = true; else if (speed < SPEED_RESUME) speedHot = false;
  }

  // 부감 굴뚝 앵커(look-audit R4). 지면 디테일 밴드가 닫힌 원경에서는 활성 셀이 하나도 없어
  //   앵커 집합이 비고 연기가 통째로 사라졌다. 셀(모트·등롱·지오)을 만들지 않고 필지 서술자에서
  //   굴뚝 좌표만 직접 골라 같은 스프라이트 풀에 물린다 — 추가 비용은 스프라이트 드로우뿐이다.
  //   부감에서는 "가장 가까운 N채"가 화면 한 점에 뭉치므로, 거리 정렬 위에서 등간격 표본을 뽑아
  //   마을 전역에 연기 기둥이 퍼지게 한다(결정론 — 난수 없음).
  function aerialSmokeCandidates(limit) {
    const pool = [];
    for (const d of parcels) {
      if (!d.chimney || excluded(d.id) || cells.has(d.id)) continue;
      pool.push({ id: d.id, ch: d.chimney, dist: Math.hypot(d.cx - anchorX, d.cz - anchorZ) });
    }
    if (pool.length <= limit) return pool;
    pool.sort((a, b) => (a.dist - b.dist) || (a.id < b.id ? -1 : 1));
    const picked = [];
    for (let i = 0; i < limit; i++) {
      const index = Math.min(pool.length - 1, Math.round((i + 0.5) / limit * pool.length));
      picked.push(pool[index]);
    }
    return picked;
  }

  function syncSmokeAnchors(aerial) {
    const list = [];
    for (const [id, cell] of cells) { const d = descById.get(id); if (d && d.chimney) list.push({ id, ch: d.chimney, dist: cell._dist }); }
    list.sort((a, b) => a.dist - b.dist);
    // 셀이 하나라도 살아 있으면 앵커는 셀이 단독 소유한다. 전환 중 셀이 한 프레임에 하나씩
    //   올라오는 구간에서 부감 후보까지 섞으면 앵커 집합이 매 프레임 바뀌어(smokeKey → detect)
    //   스프라이트가 명멸한다. 순수 부감(셀 0)에서만 필지에서 직접 고른다.
    if (aerial && cells.size === 0) {
      for (const candidate of aerialSmokeCandidates(SMOKE_ANCHORS)) list.push(candidate);
    }
    const chosen = list.slice(0, SMOKE_ANCHORS);
    const key = chosen.map((c) => c.id).sort().join(',');
    if (key !== smokeKey) {
      smokeKey = key;
      for (let i = anchorGroup.children.length - 1; i >= 0; i--) anchorGroup.remove(anchorGroup.children[i]);
      for (const c of chosen) { const m = new THREE.Mesh(chimneyGeo, chimneyMat); m.name = 'chimney'; m.position.set(c.ch.x, c.ch.y, c.ch.z); anchorGroup.add(m); }
      smoke.onBuildingChanged();
    }
  }

  function update(dt, camera, lod = null, ownerWeight = 1) {
    if (!enabled || !camera) { lightPool?.clear(); smoke.update(dt); return; }
    frameNo++;
    if (lod?.anchor && Number.isFinite(lod.anchor.x) && Number.isFinite(lod.anchor.z)) {
      anchorX = lod.anchor.x; anchorZ = lod.anchor.z;
    } else {
      computeAnchor(camera);
    }
    updateSpeed(camera, dt);
    if (lookahead && (nowSec() - lookahead.t) > LOOKAHEAD_TTL) lookahead = null;
    lastOwnerWeight = Math.max(0, Math.min(1, Number.isFinite(ownerWeight) ? ownerWeight : 0));
    const groundWeight = (lod ? Math.max(0, Math.min(1, lod.groundWeight || 0)) : 1)
      * lastOwnerWeight;
    const particleWeight = (lod ? Math.max(0, Math.min(1, lod.particleWeight || 0)) : 1)
      * lastOwnerWeight;
    const detailWeights = { groundWeight, particleWeight, lensScale: lod?.lensScale ?? 1 };
    const groundActive = lod ? lod.groundActive === true : true;
    // 근경 모트 이미터(ambNear)는 이산 tier 하나에만 걸려 있어, 망원 근경이 tier=mid 로 읽히는
    //   순간 마당 먼지 모트가 통째로 사라졌다(look-audit R4 — 골든 dustMotes 3, HEAD 1).
    //   NEAR_ENTER(26m) 반경 자체가 이미 공간 상한이므로, 입자 밴드가 열려 있으면 tier 와
    //   무관하게 근접 셀을 허용한다. 원경은 particleWeight=0 이 그대로 닫는다.
    const nearAllowed = !lod || lod.tier === 'near' || particleWeight > 0.02;
    // 부감 생명감(look-audit R4): 지면 밴드가 0이어도 굴뚝 연기는 남는다. 웨이브 소유권만 곱한다.
    const life = aerialLifePresence(lod?.visualDistance);
    const lifeWeight = life.weight * lastOwnerWeight;
    smoke.setAerial(life.boost);

    // 희망 티어 산출(유효거리 = min(앵커, 룩어헤드)).
    const desired = new Map();
    // wave가 아직 소유권을 주지 않은 새 필드는 셀 지오/모트/등롱을 미리 만들지 않는다.
    // owner가 실제로 오르기 시작한 프레임부터 한 셀씩 스핀업해, 숨은 새 마을 준비 비용도 0에 가깝게 둔다.
    if (groundActive && lastOwnerWeight > 0.002 && parcels.length) {
      for (const d of parcels) {
        if (excluded(d.id)) continue;
        let dist = Math.hypot(d.cx - anchorX, d.cz - anchorZ);
        if (lookahead) dist = Math.min(dist, Math.hypot(d.cx - lookahead.x, d.cz - lookahead.z));
        const cur = cells.get(d.id);
        let tier = tierFor(cur ? cur.tier : null, dist);
        if (!nearAllowed && tier === 'near') tier = 'mid';
        if (tier) desired.set(d.id, { tier, dist });
      }
      // 캡(거리 랭크). near 초과분은 mid 강등(범위 내) 아니면 드롭. mid 초과분(원거리)은 드롭 = LRU.
      const near = [...desired].filter(([, v]) => v.tier === 'near').sort((a, b) => a[1].dist - b[1].dist);
      for (let i = NEAR_CAP; i < near.length; i++) { const [id, v] = near[i]; if (v.dist <= MID_EXIT) v.tier = 'mid'; else desired.delete(id); }
      const mid = [...desired].filter(([, v]) => v.tier === 'mid').sort((a, b) => a[1].dist - b[1].dist);
      for (let i = MID_CAP; i < mid.length; i++) desired.delete(mid[i][0]);
    }

    // 리컨사일: 드롭/티어변경 → 리타이어, 유지 → 거리·touch 갱신.
    for (const [id, cell] of [...cells]) {
      const d = desired.get(id);
      if (!d || d.tier !== cell.tier) { cell.beginOut(); retiring.push(cell); cells.delete(id); }
      else { cell._dist = d.dist; cell.touch = frameNo; }
    }
    // 프레임 분산 스핀업(속도 게이트 시 신규 억제). 희망인데 미생성인 가장 가까운 1개만.
    if (!speedHot) {
      let bestId = null, bestDist = Infinity, bestTier = null;
      for (const [id, v] of desired) { if (cells.has(id)) continue; if (v.dist < bestDist) { bestDist = v.dist; bestId = id; bestTier = v.tier; } }
      if (bestId != null) {
        const desc = descById.get(bestId);
        const cell = bestTier === 'near' ? buildNearCell(desc) : buildMidCell(desc);
        cell._dist = bestDist; cell.setTime(curTime, true);
        cells.set(bestId, cell);
      }
    }

    for (const c of cells.values()) c.update(dt, detailWeights);
    for (let i = retiring.length - 1; i >= 0; i--) {
      const r = retiring[i];
      r.update(dt, detailWeights);
      if (r.dead()) { r.dispose(); retiring.splice(i, 1); }
    }

    lightPool?.assign(camera);   // #141 활성 필드만 고정 풀을 소유(웨이브 중 총 개수 불변)

    syncSmokeAnchors(lifeWeight > 0.02);
    const sTarget = anchorGroup.children.length > 0 ? Math.max(particleWeight, lifeWeight) : 0;
    smokeFade += (sTarget - smokeFade) * Math.min(1, dt * 1.4);
    smoke.setFade(smokeFade);
    smoke.update(dt);
  }

  function setParcels(list) {
    parcels = Array.isArray(list) ? list : [];
    descById.clear();
    for (const d of parcels) descById.set(d.id, d);
  }
  function setExcluded(fn) { excluded = typeof fn === 'function' ? fn : () => false; }
  function setTime(name, immediate) {
    if (!name) return; curTime = name;
    smoke.setTime(name, { immediate: !!immediate });
    for (const c of cells.values()) c.setTime(name, immediate);
    for (const r of retiring) r.setTime(name, immediate);
  }
  function setSeason(name, immediate = false) {
    if (!name) return;
    curSeason = name;
    for (const c of cells.values()) c.setSeason(name, immediate);
    for (const r of retiring) r.setSeason(name, immediate);
  }
  function setEnabled(v) { enabled = !!v; }

  function dispose() {
    if (typeof window !== 'undefined' && window.__ambLookahead === lookaheadFn) delete window.__ambLookahead;
    for (const c of cells.values()) c.dispose(); cells.clear();
    for (const r of retiring) r.dispose(); retiring.length = 0;
    lightPool?.dispose();
    lightPool = null;
    smoke.setEnabled(false); scene.remove(smoke.group); disposeSubtree(smoke.group);
    scene.remove(anchorGroup);
    chimneyGeo.dispose(); chimneyMat.dispose();
  }

  return {
    setParcels, setExcluded, setTime, setSeason, setEnabled,
    activateSceneServices, update, dispose,
    // 검증 전용: 연기 서브시스템 가시성 토글(드로우콜 표에서 구조/연기 분해 실측용).
    _setSmokeVisible(v) { smoke.group.visible = !!v; },
    // 검증 전용.
    _debug() {
      const near = [], mid = [];
      for (const [id, c] of cells) (c.tier === 'near' ? near : mid).push(id);
      return {
        nearIds: near, midIds: mid, near: near.length, mid: mid.length,
        retiring: retiring.length, speed: +speed.toFixed(2), speedHot,
        smokeAnchors: anchorGroup.children.length, lookahead: !!lookahead,
        anchorX: +anchorX.toFixed(1), anchorZ: +anchorZ.toFixed(1),
        ownerWeight: lastOwnerWeight,
        maxStrength: Math.max(0, ...[...cells.values(), ...retiring].map((cell) => cell.strength)),
        smokeFade,
        lightPoolSize: lightPool?.size || 0,
      };
    },
  };
}

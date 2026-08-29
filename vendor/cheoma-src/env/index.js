import * as THREE from 'three';
import { disposeObjectTree } from '../core/three-resources.js';
import { buildTerrain } from './terrain.js';
import { buildTrees } from './trees.js';
import { buildMountains } from './mountains.js';
import { createSky } from './sky.js';
import { setupSeasons } from './seasons.js';
import { buildWater, createWaterUniforms } from './water.js';
import { buildPaddies } from './paddies.js';
import { setupCritters } from './critters.js';
import { setupAnimals } from './animals.js';
import { setupSmoke } from './smoke.js';
import { setupMotes } from './motes.js';
import { setupLanternSway } from './lantern-sway.js';
import { setupClouds, createCloudUniforms } from './clouds.js';
export { createFocusRing } from './focus.js';   // 앰비언스 근접 링(#79) — focus-in 필지 풀 앰비언스
export { setupGrass } from './grass.js';         // focus 링 바람 풀(#90) — 줌인 한정 인스턴스드 풀

// 환경 ON/OFF 경계에서 호출자 소유 scene/light 상태를 identity와 정밀도 손실 없이 보존한다.
// 별도 함수라 Texture/CubeTexture 배경과 FogExp2 계약을 전체 환경 생성 없이 빠르게 검증할 수 있다.
export function captureEnvironmentFallback(scene, { sun, hemi, renderer }) {
  return {
    background: scene.background,
    backgroundColor: scene.background?.isColor ? scene.background.clone() : null,
    fog: scene.fog,
    fogColor: scene.fog?.color?.clone?.() || null,
    fogNear: scene.fog?.near,
    fogFar: scene.fog?.far,
    fogDensity: scene.fog?.density,
    exposure: renderer.toneMappingExposure,
    sunPos: sun.position.clone(), sunColor: sun.color.clone(), sunInt: sun.intensity,
    hemiSky: hemi.color.clone(), hemiGround: hemi.groundColor.clone(), hemiInt: hemi.intensity,
  };
}

export function restoreEnvironmentFallback(scene, { sun, hemi, renderer }, fallback) {
  scene.background = fallback.background;
  if (fallback.backgroundColor && scene.background?.isColor) scene.background.copy(fallback.backgroundColor);
  scene.fog = fallback.fog;
  if (scene.fog && fallback.fogColor) {
    scene.fog.color.copy(fallback.fogColor);
    if (scene.fog.isFogExp2) scene.fog.density = fallback.fogDensity;
    else { scene.fog.near = fallback.fogNear; scene.fog.far = fallback.fogFar; }
  }
  renderer.toneMappingExposure = fallback.exposure;
  sun.position.copy(fallback.sunPos); sun.color.copy(fallback.sunColor); sun.intensity = fallback.sunInt;
  hemi.color.copy(fallback.hemiSky); hemi.groundColor.copy(fallback.hemiGround); hemi.intensity = fallback.hemiInt;
}

// 산수화 환경 레이어를 조립한다.
//   setupEnvironment(scene, { sun, hemi, renderer, layout })
//     → { group, setTime(name, opts), setSunsetLook(name, opts), setSeason(name, opts), setLensScale(k),
//         update(dt), setEnabled(bool), dispose() }
// opts.immediate=true 는 숨김→재노출 같은 씬 수명주기 경계에서 하늘·물·연기·모트를 한 번에
// 정착시키는 계약이다. 보이는 상태의 일반 변경은 opts 없이 호출해 크로스페이드를 유지한다.
// 환경 OFF 시 셋업 시점의 배경·안개·조명 상태로 복원한다(기존 단순 배경 폴백).
export function setupEnvironment(scene, { sun, hemi, renderer, layout }) {
  // 폴백(현 상태) 캡처. Texture/CubeTexture 배경과 FogExp2까지 호출자 객체 identity를
  // 그대로 돌려준다. 환경이 켜진 동안 Color/Fog 값이 in-place로 바뀔 수 있어 값도 함께 보존한다.
  const fb = captureEnvironmentFallback(scene, { sun, hemi, renderer });

  const group = new THREE.Group();
  group.name = 'environment';
  scene.add(group);

  const clearance = Math.max(layout.xEave ?? 9, layout.zEave ?? 6) + 9;

  // 비정형 월드 테두리 엣지 처리 스타일(기본 mist). 검증 하네스는 ?edge=ink|diorama|mist 로 비교.
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const edgeStyle = ['ink', 'mist', 'diorama'].includes(q.get('edge')) ? q.get('edge') : 'mist';

  // 흐르는 구름 그림자 uniform(지형 재질 ↔ clouds 표류 공유). 물 uniform 공유 패턴과 동일.
  const cloudUniforms = createCloudUniforms();
  // 엣지 헤이즈는 대기(fog)색을 매 프레임 따라간다(시간대·#50 크로스페이드 자동 정합).
  const terrain = buildTerrain({
    clearance, cloudUniforms, edgeStyle,
    getHaze: () => (scene.fog ? scene.fog.color : null),
  });
  // 다랑이 논·개울은 지형 계곡(valley)에 정렬된다. 물 재질감(하늘 반사)은 uniform 공유.
  const waterUniforms = createWaterUniforms();
  const paddies = buildPaddies({ valley: terrain.valley, heightAt: terrain.heightAt, waterUniforms });
  const water = buildWater({ valley: terrain.valley, heightAt: terrain.heightAt, uniforms: waterUniforms });
  // 나무는 논·개울(및 논둑 여유) 위에 서지 않도록 마스크로 제외(rng 소비 순서는 보존).
  const treeMask = (x, z) => paddies.covers(x, z) || water.covers(x, z);
  const trees = buildTrees({ clearance, heightAt: terrain.heightAt, mask: treeMask });
  const mountains = buildMountains({});
  group.add(mountains.group);   // 원경 먼저
  group.add(terrain.group);
  group.add(paddies.group);
  group.add(water.group);
  group.add(trees.group);

  // 산 구름·물안개 표류 + 흐르는 구름 그림자. sun 상태를 매 프레임 읽어 라이팅·그림자 세기 산출.
  //   외곽선(terrain.edge)·반경(terrain.R) 공유. shot 모드는 표류 t=0 고정, ?clouds=0 옵트아웃.
  const clouds = setupClouds(group, {
    sun, edge: terrain.edge, terrainMax: terrain.R, uniforms: cloudUniforms,
    getHaze: () => scene.fog?.color || null,
  });

  const sky = createSky({ scene, sun, hemi, renderer, group, mountains, layout });

  // 계절(단풍·벚꽃·신록). 트리/지형/논 재질을 셰이더 패치하므로 setupWeather 보다 먼저
  // 세팅돼야 적설 패치가 뒤에 체이닝된다(잎 색 vertex → 눈 fragment 합성).
  const seasons = setupSeasons(group, { layout, paddies });

  // 생물 앰비언트(새 떼·까치·개·고양이). env group 자식이라 ON/OFF 가시성에 함께 묶인다.
  const critters = setupCritters(group, { heightAt: terrain.heightAt, layout });

  // 소동물(태스크 #43): 마당 닭 무리 + 논의 소(한우). env group 자식이라 가시성에 함께 묶인다.
  //   닭 마당 앵커는 layout(앞마당)에서 파생. 소는 다랑이 논 +z 사면 중단(논면 캐스트로 표고 확정).
  const cowZ = terrain.valley.centerZ(-50) + 6.5;   // paddies 밴드 [centerZ+2.2 .. +13.2] 중단
  const animals = setupAnimals(group, {
    heightAt: terrain.heightAt, layout,
    // yaw=π: 하류(-x)를 바라봄 — 등고선을 따라 서서 풀 뜯을 때 머리가 오르막(+z)에 박히지 않고,
    //   +z 측 기본 카메라에서 소가 옆모습(broadside)으로 읽힌다("논에는 소가 있어야 제맛" 키 샷).
    cowSite: { x: -50, z: cowZ, yaw: Math.PI },
  });

  // 굴뚝 연기 + 아궁이 불씨. 건물은 scene 자식(name='building')이라 조회로 참조 —
  // main.js 배선 없이 재생성도 self-heal(update에서 참조 변경 감지). env group 자식이라
  // ON/OFF·가시성에 함께 묶인다.
  const smoke = setupSmoke({ scene, getBuilding: () => scene.getObjectByName('building') });
  group.add(smoke.group);

  // 앰비언트 생명감(태스크 #32): 공기 중 먼지 모트 + 처마 등롱 미세 흔들림.
  //  - 모트: 역광 게이트로 골든아워에 빛을 받는 단일 물리 인스턴스 draw. renderer 는
  //    ink 모드 감지(NoToneMapping)용 read-only. sun.position(=태양·달 방향)으로 forward-scatter.
  //  - 등롱: sky.js 가 만든 등롱 bulb/light 를 env 그룹 traverse 로 찾아 진자 요동(위치만).
  //    둘 다 env group 자식/게이트에 함께 묶인다.
  const motes = setupMotes({
    sun,
    renderer,
    isInk: () => renderer.toneMapping === THREE.NoToneMapping,
  });
  group.add(motes.group);
  const lanternSway = setupLanternSway({ scene, getBuilding: () => scene.getObjectByName('building') });

  let enabled = false;
  let disposed = false;
  let currentTime = 'day';
  let currentSunsetLook = sky.sunsetLook;
  let currentSeason = 'summer';
  let everApplied = false;   // 첫 적용은 항상 즉시(로드 시 트윈-인 방지). 이후 다이얼만 크로스페이드.
  let immediateMode = false; // ink 모드 등: 트윈·fog 합성을 끄고 즉시 스냅(setImmediate 로 토글).

  // ── fog 합성 훅 ────────────────────────────────────────────────────────────
  // 시간대 크로스페이드가 매 틱 base fog 를 다시 쓰므로, 마을 fog·날씨 대기 틴트가 씻긴다.
  // 해법: env 가 base fog 의 단일 소스가 되고, 등록된 모디파이어가 매 틱 최종 fog 를 만든다.
  //   modifier(scene): scene.fog/background 를 in-place 변형(멱등 — 매 틱 fresh base 위에 적용).
  //   src/village/adapter.js(마을 fog)·소비자(날씨 대기)가 마을/날씨 활성 동안 등록/해제한다.
  const fogMods = [];
  function applyFogBaseAndMods() {
    const b = sky.getBaseFog();
    if (!scene.fog) scene.fog = new THREE.Fog(0, 1, 100);
    scene.fog.color.copy(b.color); scene.fog.near = b.near; scene.fog.far = b.far;
    if (scene.background && scene.background.isColor) scene.background.copy(b.color);
    for (const fn of fogMods) { try { fn(scene); } catch (e) { /* 모디파이어 오류가 루프를 깨지 않게 */ } }
    // 돔 지평 밴드를 "최종" 대기색에 맞춘다(R5) — 날씨 틴트·마을 모디파이어까지 반영된 색이라야
    //   지형 외곽이 배경과 같은 색으로 소실된다. 변화 없으면 sky 쪽에서 no-op.
    sky.syncHaze(scene.fog.color);
  }
  function composeFogNow() { if (enabled && !immediateMode) applyFogBaseAndMods(); }
  function addFogModifier(fn) { if (!disposed && fn && !fogMods.includes(fn)) { fogMods.push(fn); composeFogNow(); } }
  function removeFogModifier(fn) { if (disposed) return; const i = fogMods.indexOf(fn); if (i >= 0) { fogMods.splice(i, 1); composeFogNow(); } }
  // ink 모드 등에서 트윈·fog 합성을 끈다(즉시 스냅으로 종이색 fog 를 침해하지 않게).
  function setImmediate(v) { if (!disposed) immediateMode = !!v; }

  function restoreFallback() {
    restoreEnvironmentFallback(scene, { sun, hemi, renderer }, fb);
  }

  // 시그니처 유지(opts 신설): opts.immediate=true(shot·초기 로드) 면 즉시 스냅, 그 외엔 크로스페이드.
  function setTime(name, opts = {}) {
    if (disposed) return;
    const immediate = !!opts.immediate || immediateMode || !enabled || !everApplied;
    currentTime = name;
    critters.setTime(name);   // 밤엔 새 떼 숨김·이동 자제(이산 — 트윈 불필요)
    animals.setTime(name);    // 밤엔 닭 홰 자세(웅크림), 소는 계속 풀 뜯기
    water.setTime(name, { immediate });  // 물 글린트 색·강도(낮 햇살↔밤 달빛)
    smoke.setTime(name, { immediate });  // 연기 세기·색·아궁이 불씨(새벽·해질녘 밥짓기 최대)
    motes.setTime(name, { immediate });  // 먼지 모트 강도·색(해질녘·새벽 최대, 낮 미약, 밤 극미)
    if (enabled) { sky.apply(name, { immediate }); everApplied = true; }
  }
  // Sunset colour is a presentation sub-profile, not a fifth time of day. This keeps
  // animals/audio/water on the existing `sunset` simulation state while sky, lights and
  // haze transition together. Calling it outside sunset only stores the next look.
  function setSunsetLook(name, opts = {}) {
    if (disposed) return currentSunsetLook;
    currentSunsetLook = sky.setSunsetLook(name, {
      immediate: !!opts.immediate || immediateMode || !enabled || !everApplied,
    });
    return currentSunsetLook;
  }
  function setSeason(name, opts = {}) {
    if (disposed) return;
    currentSeason = name;
    seasons.setSeason(name, opts);
    critters.setSeason(name);
    animals.setSeason(name);
    terrain.setSeason(name, opts);  // 들판 금빛(가을) 자체 보간
    sky.setSeason(name, { immediate: !!opts.immediate || !enabled });  // 능선 가을 훅(크로스페이드)
    // 카메라 추종 계절 입자 필드(#111): weather.js 소유(scene 루트·setWeatherCenter 추종)라 season 을
    //   window.__wx 브릿지로 전달한다(engine 은 weather 에 season 미전달 — env↔weather 유일 연결).
    //   __wx 부재(env 단독 검증 하네스·weather 미생성)면 no-op.
    if (typeof window !== 'undefined' && window.__wx && window.__wx.setSeason) window.__wx.setSeason(name);
  }
  // A compensated village lens dollies the camera while preserving composition. The
  // single-house motes become visible as soon as village mode exits, so they must follow
  // that lens continuously during the return tween instead of snapping to identity first.
  function setLensScale(value) {
    if (!disposed) motes.setLensScale(value);
  }
  // MeshBasic ridge silhouettes do not participate in the shared lit-surface snow
  // shader. Weather forwards the same accumulation clock here so their high crests
  // gain a restrained snow line without adding meshes or draw calls.
  function setSnowAccumulation(value) {
    if (!disposed) mountains.setSnow(value);
  }
  // 마을은 자체 지형·생활 디테일을 소유하므로 env.group을 숨긴 동안 단일집 전용
  // CPU 작업은 쉬게 한다. scene 레벨 시간대·조명·fog를 소유한 sky는 계속 갱신한다.
  function update(dt) {
    if (disposed) return;
    sky.update(dt);       // 시간대·하늘·fog·조명은 마을에서도 계속 이어진다.

    if (group.visible) {
      seasons.update(dt);   // 논 계절 보간도 seasons 가 전파
      terrain.update(dt);   // 들판 금빛 보간
      water.update(dt);     // 개울 물결 시간(uTime) — 논 물면과 공유
      critters.update(dt);  // 새 떼 boids·개·고양이·까치
      animals.update(dt);   // 마당 닭 무리(쪼기·종종·홰치기)·논 소(풀 뜯기·꼬리·귀)
      sky.updateFlicker(dt); // 처마 등롱 촛불 일렁임(등불 켜졌을 때)
      smoke.update(dt);      // 굴뚝 연기 상승·소산·바람 드리프트 + 아궁이 불씨 일렁임
      motes.update(dt);      // 먼지 모트 드리프트·바람 쓸림·역광 반짝(ink 모드 자동 비표시)
      lanternSway.update(dt);// 처마 등롱 진자 미세 요동(바람 거스트 연동, 위치만)
      clouds.update(dt);   // 산 구름·물안개 표류 + 흐르는 구름 그림자 세기(태양 상태 판독)
    }
    // fog 재합성: 시간대 트윈 중이거나 모디파이어(마을 거리·날씨 대기)가 등록돼 있으면 base+모디파이어로.
    if (enabled && !immediateMode && (sky.isTweening() || fogMods.length)) applyFogBaseAndMods();
  }
  function setEnabled(v) {
    if (disposed) return;
    enabled = !!v;
    group.visible = enabled;
    sky.setEnabled(enabled);
    smoke.setEnabled(enabled); // 건물의 아궁이 불씨(그룹 밖)도 함께 소등/점등
    motes.setEnabled(enabled);
    lanternSway.setEnabled(enabled); // OFF 시 등롱 위치 원복
    if (enabled) {
      everApplied = true;
      sky.setSeason(currentSeason, { immediate: true });
      sky.apply(currentTime, { immediate: true });  // 켜질 때는 항상 즉시(트윈-인 없이 현 상태로)
      composeFogNow();                               // 등록 모디파이어(마을 fog)를 정착 상태에서도 반영
    } else {
      restoreFallback();
    }
  }

  function dispose() {
    if (disposed) return;
    // 건물에 걸친 등롱·아궁이 상태와 scene-level fog/light를 먼저 원복한 뒤,
    // 환경이 소유한 Object3D 리소스만 identity-dedupe해 해제한다.
    setEnabled(false);
    disposed = true;
    fogMods.length = 0;
    motes.dispose();
    seasons.dispose();
    sky.dispose();
    scene.remove(group);
    disposeObjectTree(group);
    group.clear();
  }

  return {
    group, setTime, setSunsetLook, setSeason, setLensScale, setSnowAccumulation, update, setEnabled, dispose,
    addFogModifier, removeFogModifier, setImmediate,
    get time() { return currentTime; },
    get sunsetLook() { return currentSunsetLook; },
    get season() { return currentSeason; },
    // 개울 징검다리 교차점 월드 좌표(위치성 물소리 앵커). water 없으면 null.
    get streamAnchor() { return !disposed && water ? water.anchor : null; },
    // 개의 라이브 월드 위치·상태(오디오 개 짖음 positional 앵커·촉발 타이밍).
    get dogAnchor() { return disposed ? null : critters.dogAnchor; },
    get dogState() { return disposed ? null : critters.dogState; },
    // 검증 전용: 까치를 나무 페르치로 스냅(스크린샷 조준용).
    debugMagpieTree() { return disposed ? null : critters.debugMagpieTree(); },
    // 논 소 라이브 월드 위치(검증 조준·오디오 여지). 없으면 null.
    get cowAnchor() { return disposed ? null : animals.cowAnchor; },
    // 검증 전용: 마당 닭 무리 중심 월드 좌표.
    debugFlockCenter() { return disposed ? null : animals.debugFlockCenter(); },
  };
}

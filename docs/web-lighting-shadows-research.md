# 웹에서 물리 기반 조명·그림자를 효율적으로 만드는 방법 — 리서치

> 조사일: 2026-09-02 · 목적: kingbi(새벽까지) 야간 조명/그림자 아키텍처 결정 지원
> 배경 실측: 데스크톱 스트레스 리그에서 실제 PointLight 2개 추가 ≈ **-6fps**(프래그먼트
> 광원 수가 화면 전체 셰이더 비용으로 직결). 광원 수와 픽셀 비용을 분리하는 기법이 본 과제의 핵심.

## 요약 (TL;DR)

1. **웹에서 하드웨어 레이트레이싱은 아직 없다** — WebGPU가 전 브라우저 기본 탑재(2025.11~)됐지만
   RT 코어 접근은 표준에 없음(gpuweb #535 진행 중). 현재 가능한 건 컴퓨트 셰이더 접근뿐.
2. **광원 N개 문제의 정석은 클러스터드 라이팅(Forward+)** — three.js r185(우리 버전)부터
   WebGPURenderer에 정식 탑재. 단 WebGPURenderer 전환이 필요.
3. **kingbi에는 더 잘 맞는 특수해가 두 개**: ①복셀 색광 전파(마인크래프트식 flood-fill — 이미
   그리드가 있음), ②정적 SDF 소프트 섀도우(복셀 그리드 → 거리장 베이크 → 섀도맵 패스 제거).
4. 표준 레시피: **실그림자 1개(방향광, 캐시) + 나머지 광원은 클러스터드/베이크 + 동적 캐릭터는
   분석적 근사(스티크) + 접촉 그림자는 스크린스페이스 보강.**

---

## 1. 클러스터드 라이팅 (Forward+) — 광원 수와 프래그먼트 비용 분리

프레임마다 보이는 광원을 뷰 프러스텀의 3D 클러스터 그리드에 배정(CPU 또는 컴퓨트), 각
프래그먼트는 자기 클러스터의 광원만 평가. 광원을 추가해도 전체 화면 셰이더가 늘어나지 않음.

| 구현 | 내용 | 제약 |
|---|---|---|
| **PlayCanvas** (v1.56~ 기본) | 월드 스페이스 3D 그리드 + 광원 인덱스 텍스처, **옴니/스팟 최대 254개**, 그림자·쿠키는 공유 아틀라스 1장 분할(화면 크기 큰 광원이 큰 영역, 초과 시 작은 광원이 그림자 상실) | 그림자는 여전히 광원당 아틀라스 렌더. 셀 수↑는 CPU 비용 |
| **three.js r185 WebGPURenderer** | `ClusteredLightsNode`(Forward+ Clustered Shading) 정식 탐재, 공식 예제 `webgpu_lights_clustered` | **WebGPURenderer 전환 필요** — cheoma composer/포스트체인 포팅이 관문 |
| **Babylon.js 9.0** | 클러스터드 라이팅 내장 | 엔진 전환 필요 |
| **toji/webgpu-clustered-shading** | WebGPU 스펙 기여자의 미니멀 참고 구현 | 직접 구현시 참고 |

- 커뮤니티 쇼케이스 기준 ~240fps 유지(수백 광원).
- 우리 케이스 적용 요건: WebGPURenderer + cheoma `setupPost` 대응. 별도 프로젝트급.

## 2. 복셀 색광 전파 (flood-fill lighting) — **kingbi 1순위**

마인크래프트식: 광원 셀에서 시작해 6방향(대각 감쇠) BFS로 빛을 전파하면 **가림(occlusion)이
반영된 색조명**이 셀마다 기록된다 — "석등 뒤 벽은 어둡고, 뚫린 창으로 불빛이 방 안에 스민다".

- **비용 구조가 핵심**: 광원 추가 비용 = 전파 영역(거리 감쇠 반경)에만 비례. 프래그먼트 광원 수 0.
- GPU 버전(Meor/Lionel Pigou, 2021): 햇빛/앰비언트/포인트광을 별도 전파, RGB 3채널 + 방향
  벡터까지 전파해 표면 각도 셰이딩, cascading clipmap LOD. 실시간 동작.
- kingbi 적합도: 이미 집별 `cellSlot` 그리드 존재. 석등·화재를 광원 셀로 등록 → 전파 →
  복셀 인스턴스 색에 반영. 집이 파이면(chew/collapse) 해당 영역만 재홍수. 렌더 비용은
  인스턴스 컬러 갱신뿐(기존 flush 경로 재사용).
- 한계: 복셀 해상도(0.11~0.7m)만큼 뭉개진 그림자. 부드러움은 오히려 수묵 화풍에 유리.

## 3. 정적 SDF 소프트 섀도우 — kingbi 2순위

정적 장면을 3D 거리장(signed distance field) 텍스처로 베이크 → 프래그먼트에서 광원 방향으로
레이마치(통상 **7~64스텝**, IQ의 `softshadow()`) → PCF 근사가 아닌 **정확한 소프트 섀도우**.

- 광원 방향이 유니폼이므로 **같은 SDF로 달·석등·화재 어느 광원의 그림자든** 즉시 계산.
  섀도우맵 렌더 패스 자체가 사라짐(달맵 캐시의 "전투 중 재렌더" 문제도 소멸).
- 복셀 그리드 → 거리장 베이크는 자연스러움(jump flooding 등 실시간 생성 연구도 있음).
- 한계: 동적 지오메트리(좀비·파편)는 SDF에 없어 캐스터 불가 → **스티크 시스템과 역할 분담**.
- 참고: three.js 포럼 "Ray-traced shadows for the poor"(픽셀당 최대 64스텝, 통상 ~7스텝).

## 4. 스크린스페이스 보강 기법

- **콘택트 섀도우**: depth 프리패스 위 화면 레이마치로 근거리 접촉 그림자만 보강.
  광원 수 무관. Unity HDRP(광원별 켜기), 구 Godot GLES3, 직접 구현기 존재.
- 업계 표준 조합: 실그림자 캐스터 1개(방향광) + 나머지 광원 무그림자/베이크 + 콘택트 보강.

## 5. WebGPU 하드웨어 RT 현황 (2026)

- WebGPU 자체는 2025.11부터 Chrome/Edge/Firefox/Safari **전부 기본 탑재**.
- **하드웨어 ray query는 표준에 없음** — gpuweb #535 오픈 상태, 2027년 이후 전망.
- 현재 가능: 컴퓨트 셰이더 패스레이싱(James Randall의 WebGPU 실시간 패스트레이서),
  WebRTX(실험적 에뮬레이션, 스펙 불안정).
- 로드맵 분석들도 정설: "RT를 기다리는 동안 베이크하라".

## 6. kingbi 권고 아키텍처 (비용 대비 효과 순)

1. **복셀 색광 전파** — 석등·화재 광원 등록 → 그리드 BFS 전파 → 인스턴스 색 반영.
   "광원마다 그림자"의 물리적 근사를 광원 0 추가로. 발광 원판/스티크는 보조로 축소.
2. **정적 SDF 소프트 섀도우** — 달빛 그림자를 섀도맵 캐시 대체(품질↑, 전투 중 재렌더 부담↓).
   같은 SDF로 석등 그림자 즉시 가능.
3. **장기: WebGPURenderer + ClusteredLightsNode** — 불꽃 파티클 개별 광원화 같은 미래.
   cheoma 포스트체인 포팅이 선행 과제.
4. **유지 원칙**: 동적 캐릭터 그림자 = 스티크 / 달맵 캐시 / 실광원 추가 전 반드시 스트레스 실측.

## 출처

- Clustered lighting — PlayCanvas 문서 · 블로그/포럼:
  https://developer.playcanvas.com/user-manual/graphics/lighting/clustered-lighting/
  https://blog.playcanvas.com/clustered-lighting-open-beta-have-hundreds-of-dynamic-lights-in-your-scene/
- three.js r185 ClusteredLighting/ClusteredLightsNode:
  https://threejs.org/docs/pages/ClusteredLighting.html
  https://discourse.threejs.org/t/clustered-rendering-on-webgpu/81042
  https://github.com/toji/webgpu-clustered-shading
- 복셀 광 전파:
  https://0fps.net/2018/02/21/voxel-lighting/
  https://www.reddit.com/r/gamedev/comments/2iru8i/fast_flood_fill_lighting_in_a_blocky_voxel_game/
  http://lionelpigou.com/globillum (GPU flood-fill GI)
- SDF 소프트 섀도우:
  https://iquilezles.org/articles/raymarchingdf/
  https://discourse.threejs.org/t/ray-traced-shadows-for-the-poor/82665
  https://diglib.eg.org/bitstream/handle/10.2312/pg20201232/049-050.pdf (실시간 SDF 생성, jump flooding)
- 스크린스페이스 콘택트 섀도우:
  https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@14.0/manual/Override-Contact-Shadows.html
  https://panoskarabelas.com/blog/posts/screen_space_shadows/
  https://github.com/godotengine/godot-proposals/issues/14141
- WebGPU RT 현황:
  https://github.com/gpuweb/gpuweb/issues/535
  https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/
  https://www.jamesdrandall.com/posts/building-a-real-time-path-tracer-in-webgpu/
  https://github.com/codedhead/webrtx
  https://kaelan.fyi/research/webgpu-future-roadmap/

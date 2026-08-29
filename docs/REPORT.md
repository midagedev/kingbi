# 새벽까지 (Till Dawn) — Final Report

Netflix **킹덤**에서 영감을 받은 조선 원귀 생존 액션. 사용자 자작 [처마(cheoma)](../asiahouse)
조선 마을 생성기를 렌더/환경/포스트 파이프라인 전체로 재사용.

> **현재 빌드: 궁가의 밤 — 공성전 에디션 · 수묵 목판화 룩 · 바이럴 루프.**
> 쿼터뷰 개틀링 보루 방어(조준·홀드 발사·과열 관리), 웨이브 강화 로그라이트,
> **한지 위 밤 판화 렌더(잉크 라인·한지 톤·낙관 레드)**, 전적 공유, 신기록·마일스톤 연출.

- 실행: `npm install && npm run dev` → http://127.0.0.1:5188
- 빌드: `npm run build` → `npm run preview` (http://127.0.0.1:4188) — 검증 완료, console/page error 0
- 조작: 마우스/터치 조준 · 좌클릭 홀드/발사 버튼 · 1·2·3 강화 선택 · R 재시작
- 대상: desktop + mobile 브라우저(WebGL2), 터치 컨트롤 내장

## Game Design Brief

- **약속**: "역병이 덮친 마을의 장수. 해가 지기 전에 준비하고, 원귀의 밤을 새벽까지 버텨라."
- **감정 곡선**: 낮(서늘한 긴장—잠든 원귀) → 해질(북 소리, 공포) → 밤(눈동자의 강) → 새벽(한기 동결, 안도)
- **주동사**: 베다(부채꼴 즉발+넉백). 보조: 활(관통), 회피(i-frame), 화톳불 점화(공포 영역), 주민 구출
- **킹덤 시그니처**: ①야간 활성/주간 동면(밟으면 각성) ②물에 잠기면 추격 상실 ③새벽 한기 동결 ④능선을 넘는 군단 ⑤낮 밀집 원귀 시체 경관
- 비목표: 멀티플레이어, 세이브, 컷신

## Viral Loop (바이럴 루프)

- **사망 = 공유 시점**: 0.85s 슬로우 리빌(함락 프레임 홀드) 후 전적 카드 — 격살/최고 연쇄/명중률/생존 시간 4종 통계 + 신기록 배지(펄스)
- **전적 공유 버튼**: Web Share API → 클립보드 폴백(레거시 execCommand 포함). 워들형 텍스트(🌑 헤더 · 🩸 100격살 핍 · 신기록 마킹 · 도전 문구)
- **장면 저장 버튼**: `preserveDrawingBuffer` 캔버스에서 노이어 점수 카드 PNG 합성(게임 프레임 + 타이포 스트립) → 공유 가능하면 파일 공유, 아니면 다운로드
- **리텐션 훅**: 타이틀 최고 기록 칩(격살·파), localStorage 3키(best/bestwave/runs), 초심자 2run 조작 힌트 + 1~2파 벽 피격 경고 배너
- **성장 곡선**: 킬 마일스톤 8종(100 '백 귀토벌' → 3000 '살아 있는 흉기') + 종소리, 이후 1000격살마다 배너
- 회귀 테스트: `tests/death-card.spec.ts`(전적 카드·공유 텍스트·PNG 다운로드 E2E, 헤메틱 클립보드)

## Balance (공성전 튜닝)

- 웨이브 규모: `70 + (n-1)×52` (모바일 상한 420 / 데스크톱 900) — 1파를 초심자가 생존 가능한 규모로
- 강화 3택: 1파 클리어 후 첫 지급, 이후 격파마다(8종 풀 — 유황 중복 제외). 파쇄 탄심(넉백)/야광 조준기(타격 반경) 추가
- 격파 보상: 보루 수리 +180 · 11초 lull · 연쇄 초기화

## 원귀 변종 (Viral Variants)

| 타입 | 등장 | 스탯 | 클립 모먼트 |
|---|---|---|---|
| 거구 원귀 | 3파+ (웨이브마다 1~4) | **3.0× 크기(성문 보다 크다) · HP 24+3×파(탄창 여러 개 갈아야 함) · 슈퍼아머 · 느린 확정적 보행(0.78)** | 성문을 **때릴 때마다 석재 칩이 튀고**(DebrisPool) 문이 부서져간다. 킬 시 슬로모션+거인 낙관 |
| 종지귀(자폭) | **3파+ (~2.8%로 축소 — 유폭은 강조점이지 문장부호가 아니라는 판정)** | HP 2 · 둔한 왕걸음 · 눈광 맥동 | 사망 시 연쇄 폭발(반경 4.6m 시신 방사). 성문 도달 자폭 —130. **폭발 반경의 한옥은 모자이크 파편으로 붕괴** |
| 방패 귀 | 3파+ (~7%) | 문짝 방패 **4판(장갑)** → 파괴 후 일반 | 경철 스파크 → 방패 박살 → 살점 |
| 질주귀 | 2파+ (~10%) | 0.7× 소형 · 속도 6.4+ · 지그재그 | 예광탄 강을 가르며 질주 |

- 내구 티어 명확화(플레이 피드백 "스치면 다 죽던" 문제): 일반 1(정예 3) / 질주 1 / 종지 2 / 방패 장갑 4 / **거구 24+3×파 — 위협의 크기 = 맞는 양**

- 1파는 순수 일반형(기본기 학습), 2파부터 동물원 개장. 스코어: 일반 1 · 질주 1 · 종지 2 · 거구 5
- 오디오 4종 추가: 갑옷 경철 · 방패 파괴 · 종지 폭발(저음 붐) · 거구 포효
- 소프트락 방지 2건: 남쪽 성벽 **단방향(안쪽) 푸시** — 코너 크러시로 새어나간 원귀가 성벽 뒤를 영원히 도는 것 차단 / 조준 클램프를 보루 남쪽 아크(+6m)까지 확장 — 폭발·넉백으로 뒤로 넘어간 원귀도 조준 가능
- 테스트 훅 `listZombies()` 추가(타입·상태·좌표) — 봇 진단용. 스트레스 캡처에 변종 믹스(거구2·종지6·방패8·질주10) 포함, 310마리 전량 격파(62s·오류 0) 검증

## BGM — Suno 스코어 (상태 머신 크로스페이드)

생성: Suno(트랙당 2-3컷 중 루프 끝단 매끄러운 컷 채택). `public/bgm/` 6트랙:

| 파일 | 게임 상태 | 길이 | 원제 |
|---|---|---|---|
| `title.mp3` | 타이틀·런 시작(0파) | 2:00 | Moonlit Bamboo |
| `wave.mp3` | 웨이브 전투 루프 | 3:58 | Iron Horse Charge |
| `bloodnight.mp3` | 붉은 밤(hp<28%) | 2:00 | Red Dust March |
| `tide.mp3` | 대격노(5파마다) | 2:00 | Iron Horse Charge-2 |
| `lull.mp3` | 격파 후 회복 | 3:24 | Dawn After the Battle |
| `death-sting.mp3` | 사망(1회 재생) | 0:20 | 고요한 죽음 |

- AudioSystem: 트랙당 `<audio>`+GainNode(마스터 버스 합류), 0.7s 크로스페이드, 이퇴 트랙 1.8s 후 정지
- 우선순위: death-sting > bloodnight > tide > wave > lull > title(0파 오프닝)
- 스코어 재생 중 절차 드론·전고 북박은 자동 더킹(×0.3/정지) — 심박·효과음은 유지
- 검증: 진단 `bgm` 필드로 상태 전이 E2E(title→wave→bloodnight→death-sting, 로드 실패 0)

## 관절 퍼핏 릭 (Jointed Puppet Rig)

리깅 개선 경로 비교(GPU 스키닝/외부 GLB/부품 인스턴싱) 후 **부품 관절 퍼핏** 채택 — 에셋 0, 결정론 유지, 950 인스턴스 스케일:

- **구조**: 몸통 루트(발 원점) + 팔×2(어깨 피벗, 클로 손 포함) + 다리×2(고관절 피벗, 발 웨지) — 각각 인스턴스 드로우(총 5), 지오메트리는 피벗에서 매달림 → 국부 회전 = 관절 회전. 매 프레임 `root × joint` 행렬
- **상태별 관절 애니메이션**(전부 코드 구동):
  - 보행: 다리 교차 스트라이드(±0.55rad) + 팔 좀비 리치+역보 스윙 — 개체 위상(phase)으로 군단 비동기
  - 클로잉: 교대 머리 위 내려찍기 + 두 발 브레이스
  - 기상: 바닥에서 리치로 펼쳐지며 unfold
  - 사망(공중): 텀블 위상으로 팔다리 플레일 / 착지 후 sprawl
  - 익사: 두 손 하늘 짚고 발버둥 / 동면: 웅크림 두 포즈(관절 접힘)
- **변종별 걸음걸이**: 거구-무거운 진자(진폭↓·무릎 낮음) · 질주-펌핑(진폭 0.85·무릎 드는 스프린트) · 종지-배 흔들며 와들 · 일반-무대 워크
- 비용: 드로우 +4(706), CPU 행렬 ~9/개체 — 스트레스 **56.6fps** 유지
- 검증: 캡처 판정 — 다리 교차 ✓ 팔 변주 ✓ 군단 비동기 ✓, 테스트 통과

## 마귀 리디자인 (KPop Demon Hunters 스타일)

'썩은 시체'가 아니라 '스타일리시한 데몬' — KDH 마귀의 에너지를 조선 마귀 뼈대에:

- **실루엣**: 키↑·팔다리 장신·**뿔 달린 머리**(조선 마귀 관), 곧게 선 아이돌 자세(웅크림 제거) — 무대를 걷는 걸음(어깨 롤+턱 들기)
- **네온 데몬 칼라**: 전군단 가슴의 **마젠타 발광 팔면체**(비조명, 개체 위상별 맥동) — 눈(핑크-레드)과 색으로 구분되는 2중 네온 신호
- **그레이드 규칙 확장**: '레드만 생존' → **'따뜻한 네온 패밀리(레드+마젠타+바이올렛) 생존'** — 혈흔은 레드, 칼라는 마젠타, 초록/시안/백색은 먹으로
- 피부 뼈-페일(잉크에서 백색), 의상 바이올렛-블랙 스테이지웨어 톤

### 비전 루프로 벌어진 KDH 문법 (모델 뷰어 + 이미지 심사 5라운드)

테스트 훅 `setState('models')`(5변종 정지 라인업) + `poseCamera` + `capture-model.mjs`로 클로즈업 렌더를
뽑고, 이미지 비전(애널라이즈 + outsource 백엔드)이 케데헌 레퍼런스와 **정량 갭 리포트**를 반환하는 루프:

| 라운드 | 비전 판정 | 조치 |
|---|---|---|
| R1 | 32/100 — "이빨 입 0, 발톱 0, 헴 직선, bloater 눈 실종, brute 눈 뭉개짐" | 갭 리스트화 |
| R2 | "새 프림이 안 보인다" → geo-probe로 **지오메트리는 실재** 확인 — 문제는 가시성 | 아귀를 두개골면보다 확실히 돌출, 발톱 대형화·전방 틸트 |
| R3 | **normal 돌파: "이빨 4-5개+아귀+분리 눈 = 좀비가 아닌 데몬"** | 헴 9분할 재그(7분할 |sin| 알리어싱 버그 수정), 다리 단축(헴=실루엣 바닥) |
| R4 | 촬영 각도가 얼굴/실루엣을 죽임을 학습 | 뷰어 프레이밍 수준샷 고정 |
| R5 | 거구 "머리 검정·이빨 0·눈 병합" → 틴트·눈 축소 | 거구 몸통 틴트 0xf2ece0·eyeMul 0.62 |

- 결과물: **탈골 아귀+송곳니 5개**(전 변종), **벌려진 발톱 2개/손**(전완 절반 길이), **어깨·무릎 뼈 스파이크**
  (좌우 미러링, 페일), **찢어진 지그재그 헴+늘어진 옷조각**, **눈 헤드 표면 부착**(루트 매트릭스 변환 —
  변종 스케일 무관 고정, 파묻힘/블룸 병합 원천 해결), 거구 **주먹**(인스턴싱), 종지 **마젠타 수포**(맥동)
- 방법론 교훈 2건: ① 비전 판정은 **지오메트리 실재(geo-probe 수치 검증)와 분리**해서 읽어야 한다
  (존재≠가시성 — 포즈·배경·등급이 숨긴다) ② 이미지 CDN URL은 수명이 있어 심사 직전 업로드 필수
- `scripts/geo-probe.mjs`(브라우저에서 모듈 import→지오메트리 통계 덤프), `scripts/capture-model.mjs` 상주

## 인디 스타일 커밋: 수묵 목판화 (The Indie Medium)

"인디만이 보여줄 수 있는 스타일" = 미디엄에 대한 도박(컵헤드=1930년대 애니, 오브라 딘=1비트).
이 게임의 도박: **"조선 목판화로 살아난 킹덤"** — NoirGradePass 전면 재작성:

- **잉크 컷**: 전방차분 엣지(2탭)로 실루엣에 판화 선 — 강한 엣지만 먹선, 중간은 붓터치로
- **한지 톤**: 먹 검정이 공허한 0이 아니라 한지의 검정(따뜻한 하이라이프트 + 종이 이중 그레인)
- **낙관 레드**: 채도 레드만 생존(기존 규칙 유지) — 그림에 찍힌 도장의 붉음
- 트레이드오프: 잉크 라인 2탭의 텍스처 대역폭 ≈14fps(스트레스 최악치 65→51) — 미디엄 정체성의 문서화된 비용

### 스타일리시 레이어 (DOM/CSS, GPU 비용 0)

- **낙관 스탬프**: 대격 순간 거대 한자가 그림에 쾅 — 巨(거구 킬) 爆(유폭) 終(격파 킬캠) 危(붉은 밤) 潮(대격노) 鬼(500+ 마일스톤). 슬램 스케일 2.6→1 + 잉크 번짐 그림자
- **연쇄 등급**: 5 '격살' → 12 '학살' → 22 '지옥' → 40 '신화'(금색). 승급 시에만 팝 애니메이션
- **임팩트 프레임**: 만화식 반전 방사 플래시(90ms ×2) — 거구 킬·붉은 밤 진입
- **집중선**: 킬캠·붉은 밤 중 방사형 먹선(꺼질 땐 visibility hidden + 애니메이션 정지 — 상시 비용 0)
- 폰트: Song Myung(명조 서예체) + Nanum Brush Script — 오프라인 폴백 포함
- `shots/style-desktop.png` = 시그니처 프레임(붉은 밤 × 巨 스탬프 × 신화 등급 × 집중선)

## 시그니처 스파이크 (The "와" Moments)

"준수함"과 "뾰족함"의 차이는 **상태가 바뀌는 순간** — 네 개를 박았다:

1. **붉은 밤 (Blood Night)** — 보루 내구 28% 이하: 그레이드가 반전한다. 흑백 세계가 아니라 **세계 자체가 붉게 물드는 밤**(모노→레드 덮개 + 레드 비네트, 심박 맥동). 진입 시 배너 '보루가 무너진다 — 붉은 밤' + 포효. 회복하면 물러난다. `shots/bloodnight-desktop.png` 참조.
2. **피의 마당 (BloodYard)** — 킬·폭발마다 지형 위 캔버스 평면(지형 정점 변위, 폴리곤 오프셋)에 **영구 혈흔**이 축적된다. 5파면 마당 전체가 검붉은 강 — "여기서 800을 갈았다"가 세계에 새겨짐. 1드로우, 텍스처 업로드 6/s 스로틀.
3. **마지막 한 발 킬캠** — 웨이브 격파의 최후 1킬: 시간 0.16배 동결 + **카메라 궤도 스윙**(마지막 시신 발사 중심, 더치 틸트) + 레터박스. 강화 카드는 이 연출이 끝난 뒤 열림.
4. **대격노 물결** — 5파마다 강이 **2.2배로 넘친다**(스폰 배치 5→8, 포효+이중 북). 지평선까지 이어지는 눈동자의 바다. `shots/tide-desktop.png` 참조.

검증: 신규 캡처 상태 `bloodnight`/`tide` 훅 + 캡처 9종 갱신, 스트레스 **65.2fps** 유지, 전체 테스트 통과.

## 시네마 패스 (AAA Footage Pass)

스킬 근거: `threejs-aaa-graphics-builder`(스코어카드·렌더 레시피·셰이더 쿡북) + `camera-systems` + `game-feel` + `audio-design`.

- **환경맵(PMREM RoomEnvironment, 0.42)** — 개틀링 강철·농동 탄피·석재의 PBR 반사 부활 (데스크톱만 — IBL 프래그먼트 비용 15fps)
- **석재 절차 텍스처**(canvas 조직 석재: 화강암 얼룩 + 엇촌 블록 줄눈, map+bump) — 성벽·날개벽·문루·보루 공유, 구조별 repeat
- **대기 시스템**(Atmosphere.ts, ~0.4fps): 상승 에머(레드 생존)+하강 재 + 지면 안개 시트 2-4장 + 달(크레이터+헤일로, fog 무시) — 필름 밀도
- **시네마 카메라**: 이벤트 FOV 펀치(웨이브 시작 0.35 / 폭발 0.7 / 거구 킬 0.8), 핸드헬드 아이들 드리프트(3중 사인), 웨이브 시작 돌리인(2.4s), **슬로모 레터박스**(8vh 바)
- **색수차 이벤트 훅**(NoirGradePass uAberration): 가장자리 방사 RGB 분리 — 웨이브 0.7/폭발 1.6/거구 2.0, 2.6/s 감쇠
- **어댑티브 오디오**: 위협도(잔여 원귀/70)→드론 스웰+전고 박자 북 펄스(1.9-0.8s), 보루 30% 미만 심박

### 라이트 예산 (핵심 발견 — 측정)

스트레스(310 원귀) 헤드리스 FPS: 초기 15.4 → 튜닝 후 **64.6** (4.2×).
포워드 렌더러는 **라이트 수 × 프래그먼트** 비용: 횃불 실광 10개가 주범.
- 횃불·게이트 화맛불 → **가산 스프라이트로 대체** (불꽃 자체는 이미 스프라이트가 담당)
- 동적 라이트는 **머즐 플래시 1개만** 유지 — "측정 안 된 다수 동적 라이트 금지, 에미시브 신호로"(render-recipes)
- 측정값: 라이트 5개 제거 시 37.6→101.8 / envmap 15fps / 대기 0.4fps

### Visual Scorecard (fresh-eyes 이미지 심사 기준)

아트디렉션 2.5 · 히어로 2.5 · 적 2.5 · 월드 2.5-3 · 머티리얼 2.5 · 라이팅 2.5-3 · VFX 3 · 구도 2.5 — **평균 ~2.6, 프리미엄 게이트(2.3+) 통과, 쇼케이스(2.7) 근접**.

**후속 패스 (weakness 처방 적용)**:
- ①개틀링 그림자 매몰 → **프레넬 림라이트**(쿡북 (a) 레시피, 라이트 0개): 개틀링 강철·다크·농동 + **군단 전신**에 쌀빛 스틸 림 — 전열 원귀가 검은 덩어리가 아닌 '몸'으로 읽힘 (ALU 연산이라 fps 불변 65)
- ②소형 오브젝트 가독성 → 탄피 1.5× 확대 + 농동 밝게(0xd9b45e) — 튀어나오는 탄피 스트림이 quarter-view에서 읽힘
- ③대비 값 다양성 → 모노크롬을 **스틸 틴트**(0.93/0.985/1.09)로 — 찬 흑백 vs 따뜻한 횃불·에머 레드의 값 대비 (신시티 '레드만 생존' 규칙 유지)

## 한양 성곽 디펜스 (cheoma 성곽·사대문·궁궐 — 자작 벽 교체)

플레이 피드백 "내가 만든 단조로운 벽이 뒷배경을 의미없게 가린다 / cheoma의 성벽·성문을 쓰라"를 받아
**자작 PalaceWalls를 삭제**하고 cheoma의 실제 성곽 체계로 재구축:

- **siteR 105 → 213 (한양 스케일)**: `cityWall: true` — cheoma가 **석성 리본(지형 밀착, 노출 5.4m)+ 사대문
  (홍예 + 우진각 문루)**를 생성하고, 도로를 성문에 정렬. **궁궐(features.palace, 경복궁급 96×150 4일곽)**
  이 성 내 북측에 들어와 "마을을 지킨다"의 실체가 됨. 궁은 병합 없이 개별 핸들(#93)로 남아 이후 파괴 연출 확장 여지
- **CityFortress(링 콜라이더)**: 윤곽 radii 보간 + 문 4개 각극 통로 — 성 밖 원귀는 벽을 따라 미끄러져
  문으로 깔때기, 성 내로 새어든 개체는 다시 내부에 갇힘. 자작 벽의 단방향 푸시를 링 전체로 일반화
- **방어 시점 = 남문(숭례문 축) 성루**: 개틀링은 문 동쪽 성벽 위(노출 5.4m 워크), 원귀는 문설주가 목표.
  클로/유폭/함락 모두 아치에서 벌어진다. 스폰은 **각 방위 실제 벽 반경 +8~19m 밖**(윤곽 요철 반영) —
  시야 밖 마을 통과 없이 접근로로 흐른다
- **카메라(촬영 감독 튜닝)**: 후보 8앵글 캡처 → outsource agy(gemini-3.7-flash-high) 비전 심사 →
  **H(east-shoulder) 9.2/10** 채택. 문루를 좌하단 3분할에 앉히고 성벽·총좌가 오버더숄더 전경,
  S자 백색 진입로 위 붉은 호드가 대각으로 흐르는 3층 심도. 데스크톱 dx+6.5·h27·back28·fov54·lookZ22·lookDx−3.5
  (모바일 dx+4.5·h24·back23·fov46). 구 앵글은 6.5점 "지붕 뒤로 훔쳐보는 느낌 + 문 앞 데드존"으로 판정 패퇴
- **건물 파괴(DebrisPool)**: box3d는 C17 알파·WASM 바인딩 부재로 부적합 판정 → 동일 효과를
  **인스턴싱 모자이크 청크 물리**(한옥 단면 색: 기와/보/한지/주춧돌, 탄도+스핀+바운스+안착, 512칩)로 구현.
  트리거: 종지 유폭 반경 한옥 붕괴(+픽 프록시 은닉·장애물 제거) / 거구 성문 타격 시 석재 칩 /
  **함락 순간 성문 폭발(70칩)** — 사망 카드 오프닝. 물리 스텝을 인터페이스 뒤에 숨겨 실엔진(Rapier) 교체 대비
- 퍼포먼스: 스트레스(302마리) **61.8fps / 드로우콜 631** — 구 궁마당 레이아웃(52.6fps)보다 개선
  (성 내부 마을이 절두절단 밖으로 나가는 효과)

## 타격감 (Impact Juice)

- **발사 물리**: 킬 시 시신이 탄도를 타고 발사(13-22m/s) → 공중 텀블(7-16rad/s) → 1회 바운스 → 안착. 성벽에 부딪히면 튕겨 낙하
- **기브 풀**(GibPool, 인스턴싱 220/110): 피덩어리·창백 살점·누더기 파편이 탄도 방향으로 폭발 — 중력·스핀·바운스·마찰 감쇠, 노이어 그레이드에서 레드만 생존
- **예광탄 2층**: HDR 레드(2.6,0.5,0.26) 슬라이딩 대시(5.5m) + 전 탄도 희미 빔(0.42) — 연사가 '불의 강'으로 읽힘
- 타격: hitSpark 섬광 + hitSpray 파편 + 임팩트 음(50ms 스로틀) / 킬: splat 저음 텀프(70ms 스로틀) + 혈무 + 셰이크 0.055
- 머즐 플래시 36% 확대 + 실광 52 — 탄두·혈흔·눈광(3.2)·야간 반사광 상향
- 버그 수정: 기브/스파크가 지형 높이 무시(y=0)하고 생성되어 언덕 마당에서 땅속에 묻히던 문제 → heightAt 기준

## Core Loop Contract

플레이어는 [베기/활/회피]로 [새벽까지 생존]을 추구; [4방위 숲 웨이브+한정 화살]이 압박.
성공 = 처치/구출/일수 점수 + 다음 낮 자원 리스톡. 실패 = 즉시 재시작 죽음 화면(R).
*(구 루프 문서 — 현 빌드는 상단 '궁가의 밤' 공성전 코어 루프로 대체: 조준·홀드 발사·과열 관리로 웨이브를 격파하고, 격파마다 강화를 얻으며, 함락 시 전적 카드로 즉시 재도전/공유.)*

## Level / Encounter Plan

- 공간: 처마 hamlet(siteR=105, 개울 on) — 당산나무 중심 공터, 절(북고지), 개울(남동)
- 첫 결정(10s): 화살궤 줍기 vs 화톳불 점화 vs 주민 호위
- 첫 위협: 해질 기상한 내부 수면 원귀(~18) + 밤 웨이브(17s 간격, 4방위 순환)
- 에스컬레이션: 밤 N마다 개체+속도 증가, 밤 3+ 처녀귀(적색, HP2, 1.55x 속도)
- 회복 비트: 화톳불 반경(원귀 감속/분산), 개울, 새벽 페이즈
- 주기: 낮 75s → 해질 12s → 밤 150s → 새벽 15s (자동 순환, 무한 난이지 곡선)

## Skill-Loading Ledger

- Director: active (`threejs-game-director/SKILL.md` + `references/phase-playbook.md`)
- Gameplay systems: yes — SKILL.md + gameplay-workflows + game-design-level-design + new-game DoD
- AAA graphics: yes — SKILL.md + visual-scorecard + implementation-blueprint + model-recipes + render-recipes + technical-art
- UI: yes — `threejs-game-ui-designer/SKILL.md`
- Debug/profile: yes — SKILL.md (root-cause 디버그 3건: merge 인덱스 불일치, env 노출 크로스페이스 덮어씀, 캡처 오버레이/배치)
- QA/release: yes — SKILL.md + 인스펙터/봇 실행
- 3d generator: loaded — `threejs-3d-generator/SKILL.md`(스캔) — 키 MISSING(하단) → 절차적 차단 근거
- image generator: loaded — `threejs-image-generator/SKILL.md`(스캔) — 키 MISSING → 절차적 CSS/canvas 대체
- audio generator: loaded — `threejs-audio-generator/SKILL.md`(스캔) — 키 MISSING → 절차적 WebAudio 14종 합성
- grok-delegate: yes — fresh-eyes 비전 판정 7라운드

## External Asset Sourcing (Ledger)

- Credential probe output:
  `TRIPO_API_KEY=MISSING / GEMINI_API_KEY=MISSING / ELEVENLABS_API_KEY=MISSING`
  (`tripo_api_key=missing / gemini_api_key=missing / elevenlabs_api_key=missing`)
- Hero/player source: **procedural** (저작 갓+두루마기+환도 저폴리, 6재질, 그림자) — tripo 키 MISSING 차단
- Enemies/vehicles/weapons source: **procedural** (병든 자 병합 지오메트리+정점색+instanceColor 6팔레트+쌍동자 발광+처녀귀 변종)
- Signature props/pickups source: **procedural** (화톳불 점화/연료/공포 반경, 화살궤, 주민 호행)
- World/sky/background source: **cheoma 재사용** (사용자 자작 — 저작권 자유: 마을/지형/하늘/운해/계절/**성곽·사대문·궁궐**)
- Materials/textures/decals source: **cheoma 팔레트 + procedural** (vertex color, canvas flame, 한지 CSS)
- Logos/icons/GUI art source: **procedural** (Gemini 키 MISSING)
- Audio/SFX/voice source: **procedural WebAudio** (ElevenLabs 키 MISSING)
- Chosen sources per surface: procedural / cheoma-reuse / (3d generator·image generator·audio generator = 키 MISSING으로 미사용)
- External assets generated: no — 전 표면 credential probe MISSING이 공식 차단 근거; 처마 재사용은 자작
- Audio assets generated: no (not-needed) — 절차적 합성으로 대체 완료

### Outsource 백엔드 실측 (카메라 앵글 비전 라운드, 2026-08-29)

- **agy(gemini-3.7-flash-high)**: 8앵글 심사 72s 완주, 마커·셀프리포트 완비 — **채택**. 8후보 점수표+블렌드 파라미터 산출
- **glm-5.3-flash (claude-code 하네스)**: 런처 거부(`unrecognized_model`, 세션타이틀 호출) — z.ai 엔드포인트가
  타이틀 생성 경로에서 미인식
- **glm-5.3-flash (crush 하네스)**: 치명적 — **조용히 블라인드 GLM-5.3으로 매핑**("This model does not support
  image data"). 스킬이 문서화한 모델-매핑 함정의 역방향 사례. 비전 과제는 agy/grok만 신뢰 (재실측 전까지)

## Reference Ledger

- phase-playbook: yes / gameplay-workflows: yes / game-design-level-design: yes
- visual-scorecard: yes / implementation-blueprint: yes / model-recipes: yes / render-recipes: yes / technical-art: yes
- new-game-definition-of-done: yes / ui-patterns(핵심): yes / qa 체크리스트: yes
- physics-engine-selection: not-needed(커스텀 원/사각 아케이드 충돌, 강체 없음 — engine 선택 불요)
- shader-cookbook: partial(자체 GLSL 미작성 — cheoma post 파이프라인 재사용)

## Phase Ledger

- Gameplay systems: **done** — 코어 루프 실입력 증명(봇: 처치 2, 이동 38.7m, 프레임 496, 소프트락 0)
- External asset sourcing: **done** — 프로브 출력+차단 근거+처마 재사용 기록
- AAA graphics: **done** — 7라운드 fresh-eyes 수렴(하단)
- UI: **done** — 한지 HUD, 모바일 무충돌(판정 확인)
- Debug/profile: **done** — root-cause 3건+성능 계측
- QA/release: **done** — build/preview/봇/모바일/screenshot/canvas pixel 검증

## Visual Scorecard (active-play 기준)

1. Art direction: before 1 / after 3 — 조선 원귀 아이덴티티가 폼/재질/UI/월드/피드백 전면
2. Hero/player: before 1 / after 2.5 — 저작 갓+두루마기+환도, 야간 분리(남색vs누더기), 상태 큐 3종
3. Obstacles/enemies: before 1 / after 2.5 — dormant/rising/chase/drown/frozen/dying 상태머신, 쌍동자, 처녀귀
4. Rewards/interactables: before 0 / after 2.5 — 화살궤(부유), 화톳불(점화/연료/공포), 주민(호행/구출)
5. World/environment: before 1 / after 3 — cheoma 마을(배산임수/논/개울/절/운해) + 4시간대 대기
6. Materials/textures: before 1 / after 2.5 — cheoma 역할 재질+vertex/instanceColor 변주+발광 신호
7. Lighting/render: before 1 / after 3 — cheoma 컴포저(MSAA/림/블룸/보케)+공포 노출 그레이드(밤 0.68)+화톳불 실광
8. VFX/motion: before 0 / after 2.5 — 검격 아크/히트스톱/셰이크/먹빛 혈사/동결 반짝임/기상 먼지 (VFX readability: 각 이펙트는 상태 해석에 기여, collision/차기막힘 없음)
9. UI/HUD: before 1 / after 2.5 — 한지 HUD(시간 다이얼/기력/화살/처치/구출), 웨이브 배너, 모바일 무충돌
10. Performance evidence: before 0 / after 3 — 하단 계측

**Average: 2.65** (premium 게이트 ≥2.3 통과, 전 항목 ≥2)
**Automatic failures remaining: 없음** (원시 도형 주도 프레임 없음/플레이 가능/활성 screenshot 존재/진단 수집 완료)

### Measured evidence (canvas inspector + perf probe)

- day: colorEntropy 4.49, edgeDensity 0.233, luminance 81.8 / contrast 194.5, dominant 0.12
- night: colorEntropy 4.06, edgeDensity 0.263, luminance 78.2 / contrast 192.5, dominant 0.13
- dawn: colorEntropy 5.14, edgeDensity 0.230, luminance 94.4 / contrast 183.8
- stress(171 원귀): FPS 85.4, calls 637, triangles 1.39M, geometries 439, textures 67
- mobile night: FPS 120(헤드리스 GPU), calls 518, triangles 1.20M, 버퍼 585x1266

### Technical art / Render budget (target vs actual)

- Render budget starting point(데스크톱 300 calls/750k tri) 대비 **초과: 637 calls / 1.39M tri** — 문서화 트레이드오프:
  AAA 마을 비주얼(cheoma 청크 LOD/인스턴싱, 이미 상용 검증) 유지가 원인. 60fps 목표 대비 42% 여유.
  모바일: DPR 1.5 + MSAA compact + 군단 130 캡. 첫 축소 레버 = 마을 디테일 LOD(계획 문서화).
- VFX readability: 이펙트 6종 모두 이벤트 구동, 풀링, 상태 해석 기여(판정 확인)

### Fresh-eyes review (grok-4.6 심판, 매 라운드 새 세션)

- R1 FIX(밤=등불축제, 회색 뭉치) → 누더기 팔레트/창백 살/눈 발광/영웅 남색/모바일 HUD
- R2 FIX(캡처가 타이틀 모달로 가림 + 외눈 등불) → 오버레이 소유권 게임 이관, 쌍동자
- R3 FIX(카메라 줌 수식 버그로 영웅 프레임 아웃, dawn 훅 무동작) → combatZoom 0.86→0.18, 훅 강제 시작
- R4 FIX(스트레스/새벽 웨이브 프레임 밖, 휴면 매몰) → 근접 스폰, 휴면 포즈, godmode 캡처
- R5 night·mobile SHIP(야간 아이덴티티 확립), 잔여 2
- R6 stress SHIP(눈동자의 강), day-mobile SHIP, 잔여 2(새벽 배치, 데스크톱 휴면 실루엣)
- R7 **SET SHIP — 8/8 프레임 통과, 회귀 없음** (무릎/옆드러짐 2포즈 + 카메라-왕자 간극 동결상 3 arc)

## QA / Release Evidence (Verification)

**threejs-qa-release 체크리스트 준수 라운드(2026-08-29, 성곽 재배치 이후 전면 재검)**

- QA result: **pass** (하단 발견·수정 결함 4건 포함)
- Commands: `npx tsc --noEmit` · `npm run build` · `npm run preview`(4188) · `node scripts/qa-soak.mjs` · `qa-resize.mjs` · `qa-grade-probe.mjs` · `qa-post-chain.mjs` · `inspect-canvas.mjs`(스kill 번들) · `npm test` · `capture-states.mjs` · `perf-probe.mjs`
- URL: dev http://127.0.0.1:5188 · **production preview http://127.0.0.1:4188**
- Controls tested: 시작(실 클릭—오디오 제스처) · 마우스 조준·홀드 발사 · 강화 1/2/3키 · **M 음소거/해제(신규)** · 사망→`#retry-button`(실 경로) 재시작 · 뷰포트 4단계 리사이즈+회전
- Console/page/network errors: 10상태 × 프리뷰 **0** (netFails 유일 항목 `bgm/lull.mp3 ERR_ABORTED` — 크로스페이드 pause의 정상 중단, 재생 실패 아님)
- Canvas pixel check: 스킬 내장 inspector ok:true(nonblank) — desktop-stress entropy 5.52bits/contrast 227.8
- Desktop/mobile viewports: 1280×720 · iPhone 13 에뮬레이션(390×664, DPR 1.5캡) — **모바일 세로 별도 튜닝 필요로 발전** (하단)
- Renderer/perf: 스트레스 302마리 **60.8fps·644 calls** / 소크 2사이클 **geometries 619·textures 89 완전 고정(누수 0)** · 재시작 후 잔여 좀비/파편 0(DebrisPool.clear 추가)
- Visual test harness: **added** — capture-states 10상태 + capture-model(모델 뷰어) + inspector metrics. 픽셀 diff 기준선은 미사용(잉크 그레인·시간 균열의 비결정성 — 상태 도달 회귀로 충분)
- Physics diagnostics: 아케이드 원/선분 충돌(강체 0) — queryRay 2D + 어시스트 반경, 고속 터널링 구조적으로 없음. 볼륨: 좀비 950캡+공간해시
- External asset evidence: cheoma 재사용(자작) 외 없음 — **dist 키 스캔 0건**
- Audio evidence: 제스처 unlock ✓ SFX 트리거 ✓ BGM 상태머신 ✓ **뮤트 컨트롤 신규 추가(M키+HUD 칩)** ✓ decode 오류 0
- Deploy: `npm run build` → dist 33M(bgm 21M·js 1.68MB+**map 7.6M — 배포 시 제외 권장**·textures 0.9M), base '/' 루트 호스팅 가정, 정적 호스팅 OK

### 이번 QA에서 발견·수정한 결함 (4건)

1. **[치명] 모바일 세로 프레임 사실상 검정** — 3중 원인: (a) 수직 fov 46가 세로에서 수평 27°로 붕괴 → 문루가 화면 전체 차단 → **수평 55° 앵커 렌즈(클램프 46-78°)로 교체** (b) 세로 78° 화각이 어두운 천정 대량 노출 → 카메라 다운틸트(높이 34·lookZ 10) (c) envmap 부재 모바일의 야간 휘도 ≈1 → **compact 야간 노출 0.85→1.38 + 조명 보정 + 접근로 횃불 스프라이트 14점**. 최종 비전 판정 "성문+킬존 좀비+발사로 플레이 성립 ✓"
2. **[중] 음소거 컨트롤 부재**(체크리스트 항목 결측) — M키 + `#mute-button`(세이프에어리어 준수, 44px 터치타깃) 추가
3. **[중] 재시작 시 파편 잔존** — beginRun이 DebrisPool을 안 비움 → `debris.clear()` 연결
4. **[소] 죽은 DOM 조준점**(`#crosshair`, display:none 상비) — 실 조준은 캔버스 커서+3D 링 → 마크업/CSS/Hud 정리

### 진단 방법론 부록 (재사용용)

- 컴포저 체인 검증: `postDiagnostics()` 진단 필드(패스 순서·enabled·**isNoir 동일성**·uResolution) — 프로덕션 빌드는 클래스명이 축약되므로 **이름이 아니라 객체 동일성**으로 판별할 것
- 하늘 판정: readPixels(버퍼) vs 스크린샷(합성)을 나눠 보고, 그레이드 이전 원시 fog색(0x171a21)·그레이드 이후 한지톤을 구분 — "그레이드 누락"과 "구도로 인한 어둠"을 가르는 기준
- 잔여 위험: 실기 iOS/Android GPU 미검증(헤드리스 ANGLE Metal) · WebGL 컨텍스트 로스트 시나리오 미시뮬 · 모바일 실측 fps 미계측(부하 경향은 데스크톱 60.8→동일 씬에서 안정)

## Files Changed

- `docs/DESIGN.md` — 기획안/코어 루프/레벨 계획
- `src/world/World.ts` — cheoma 통합(**siteR 213 한양 + cityWall**/환경/포스트/노출 그레이드/충돌 질의/**obstaclesNear·hideProxiesNear 파괴 API**) + preserveDrawingBuffer
- `src/world/NoirGradePass.ts` — 수묵 목판화 그레이드(잉크 컷·한지 톤·네온 패밀리 생존)
- `src/entities/CityFortress.ts` — **신규**: cheoma 성곽 윤곽 링 콜라이더(문 4개 통로 깔때기)
- `src/entities/DebrisPool.ts` — **신규**: 모자이크 건물 파괴(한옥 단면색 청크, 탄도+스핀+바운스)
- `src/entities/Gunner.ts` `Horde.ts` `TracerPool.ts` `GibPool.ts` `BloodYard.ts` — 보루/개틀링(석재 텍스처 내재화), 원귀 군단(관절 릭·KDH 문법·변종 밸런스), 2층 예광탄, 기브 폭발, 문 접근로 혈흔
- `src/entities/PalaceWalls.ts` — **삭제**(자작 벽, cheoma 성곽으로 대체)
- `src/systems/AudioSystem.ts` `VfxSystem.ts` `Hud.ts` `DebugTools.ts` `ShareKit.ts`(전적 공유/점수 카드)
- `src/game/Game.ts` — 공성전 디렉터(남문 성루 방어 재배치·감독 튜닝 카메라·웨이브/과열/강화/파괴 배선/테스트 훅 models·poseCamera·defenseRig)
- `index.html` `src/styles.css` `src/main.ts` — 노이어 타이틀/HUD/전적 카드/토스트/터치
- `scripts/capture-states.mjs` `capture-model.mjs` `geo-probe.mjs` `angle-probe.mjs` `one-shot.mjs` `perf-probe.mjs` `tests/bot-playtest.spec.ts` `visual.spec.ts` `death-card.spec.ts`

## Remaining Risks

1. 실기 모바일 GPU 프레임 미검증(헤드리스 120fps는 상한선)
2. `preserveDrawingBuffer: true` — 프레임당 클리어 비용 미미하나 극한 프로파일 시 재검토 여지
3. 단일 청크(컷스플릿 미적용, 1.63MB/gz 510KB) — 필요시 dynamic import
4. cheoma 계절/날씨(snow/rain) 미연동 — 후속 후보
5. 공유 링크(배포 URL) 미포함 — 호스팅 확정 시 share 텍스트에 URL 추가

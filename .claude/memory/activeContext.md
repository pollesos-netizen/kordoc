# Active Context — kordoc 본체

**마지막 업데이트**: 2026-07-03 (연속 세션 3: 지표 전수 재측정 → 2단 조판 픽스 + recall 1.0 + pdf perf 트랙)
**상태**: 테스트 632/632. score 전 게이트 PASS. main 3커밋(09a8587·cfd6ef6·48f113f) — 릴리스는 미실시(다음 판단)

## 이번 세션 완료 (2026-07-03 연속 3차)

- **① 2단 조판 본문 오인 픽스** (`fix:` 09a8587) — assembly-minutes(1955 국회 속기록, 마지막
  미분석 per-doc 미달)의 루트 원인 2겹: ⑴ 문단 끝 짧은 줄 쌍("한 것이올시다."|"다.")이
  cluster 헤더로 오인 → 본문이 2열 표로 흡수 ⑵ 들여쓰기 x-피크가 레거시 컬럼(3+열)로
  오인 → 행 인터리브 탭 텍스트. `findTwoColumnProseCutX`(줄-투표 중앙 빈 띠 + 양단
  prose·justify≥0.55·폭대칭≥0.6·숫자≤15%·마커≤10%) 신설, cluster 강등 + 컬럼 감지 우회 +
  전폭 목차가 XY-Cut 막는 페이지는 컷으로 직접 좌/우/전폭 분리. **fullPage 호출에만 적용**
  (XY-Cut 그룹 재호출에서 seoul-archives p202 오발화 → 가드로 차단).
  assembly 0.98363→**0.99955**, pdf micro 0.99591→**0.99607**. 8,411페이지 전수 발화=속기록뿐,
  hash-sweep 타 문서 바이트 동일. p1(상단 목차+2단 혼합)만 좌단 justify 0.43으로 미포착 — 수용
- **② hwpx recall 1.0 도달** (`bench:` cfd6ef6) — review/36434527 "가." 2자 miss는 파서 손실이
  아니라 **채점기 함정**: 인접 별표 문단들이 normKey 공백 제거로 288자 한 덩어리가 되고,
  모수 제외 대상인 마스킹-only 유닛(96자)이 길이순 Pass 1에서 "가.+별표89" 유닛의 별표 구간을
  먼저 소비 → 앞머리 거짓 miss. align Pass 1 정렬을 "본문문자 유닛 우선→긴 순"으로.
  recallMicro 0.999949→**1**(75건 전건), phantom 0.000069→0.000046
- **③ perf.mjs pdf 트랙 신설** (`bench:` 48f113f) — 기본 dirs에 pdf, 웜 반복 생략(연산 지배적),
  페이지당 ms + 🐢 top5. 파일 크기를 파싱 전 저장(pdf 파서의 버퍼 detach로 buf.length=0 함정)

## 지표 대시보드 (2026-07-03 연속 3차 종료)

| 지표 | 값 | 게이트 | 병목/비고 |
|---|---|---|---|
| hwpx recallMicro | **1.0** ✨ | 0.999 | 75건 전건 만점 |
| hwpx phantom | 0.000046 | 0.005 | |
| 표 exact / cellExact / cellF1 | 316/316 · 0.999037 · 1.0 | 0.99/0.995/0.999 | |
| contentNED / orderAvg | 0.999655 · 1.0 | 0.999/0.995 | |
| pdf coverage(micro) | **0.99607** | 0.985 | 42건 전건 채점 |
| pdf per-doc 미달 | eval-perf-2024 0.9785 **1건뿐** | 0.985 | 벡터 아웃라인(OCR 영역) — 종결 |
| hwpx 파싱 | 콜드 median ~7.8ms | — | |
| pdf 파싱 | 콜드 median 603ms · **8.2ms/p** | — | 최악 changwon 22.4ms/p(328p 7.3s), gwd 12.2ms/p |
| hwp5 big_file 10.1MB | ~200ms · 50MB/s | — | |
| no-op 라운드트립 | 88/88 | 88 | |
| 테스트 / tsc | 632/632 / 에러 13(동수) | — | 회전표 4종 아님, 2단조판 4종 추가 |

## 다음 세션 = 검증 전면 확장 → 전 영역 100점

**`.claude/plans/next-session-full-score.md` 읽고 시작** (구 next-session-perf-debt.md 대체).
Phase A: 채점 사각지대 신규 검증 신설(pdf 표 구조·생성 라운드트립·hwp5 게이트 승격·
docx/xlsx/hwp3/hwpml 트랙·폼 정오·fuzz 스윕) → Phase B: 미달 전수 개선
(cellExact/contentNED 특정, eval-perf-2024 OCR, changwon 22.4ms/p 프로파일, 회전 표)

## 남은 백로그 (전부 저순위)

- assembly p1(전폭 목차+2단 혼합)의 좌단 justify 0.43 미포착 — 문턱 완화는 SWOT 오발화 위험, 수용
- PDF: 텍스트순서 mid 바닥글(cbe/ice-arc 잔여), eval-perf 벡터 아웃라인 숫자(OCR 영역)
- HWP5 중첩표 셀 수정(스캔 구조 필요, 최후순위), IR filler 전략2 병합 행(기록만)
- pdf parse()가 입력 버퍼 detach(의도된 트레이드오프, parser.ts:79 주석) — API 문서화 후보

## 재론 금지 (기존 결정 유지)

- LINE_SEG 원본 유지 / 공문서 장평 95%·굴림체 1.0em·함초롬 0.97em / 한컴 빈 문단 생략형
- PDF 머리글/바닥글 y-클러스터 규칙 재도입 금지 (본문 오삭제 사고)
- PDF coverage 참조 trigram **줄 단위(perLine)** — 줄 경계 gram 재도입 금지
- hidden text 필터 회전 예외 유지 / **extractLines CTM 추적 제거 금지** / **pdfjs cMap 자산 지정 유지**
- **findTwoColumnProseCutX는 fullPage 호출에만** — XY-Cut 그룹(부분집합) 재호출에서 오발화
- align Pass 1 "본문문자 유닛 우선" 유지 — 마스킹-only 유닛이 본문 구간을 가로채는 함정

## 코퍼스/도구 메모

- 실파일 코퍼스(gitignore): review/ 45건 · hwp5/ 13+30건 · pdf/ 42건
- PDF 수집법: 검색엔진 `filetype:pdf site:go.kr` 직링크 (korea.kr RSS 폐지)
- score pdf 트랙 pdftotext(poppler) 필수 (/opt/homebrew/bin/pdftotext)
- perf: `node bench/perf.mjs` (기본 review hwp5 pdf) — pdf는 콜드만·페이지당·top5
- npm publish: `~/.npmrc` bypass 2FA granular 토큰 유효

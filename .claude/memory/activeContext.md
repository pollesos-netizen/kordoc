# Active Context — kordoc 본체

**마지막 업데이트**: 2026-07-03 (연속 세션 7: PR#39 인수→v3.9.0 릴리스 + 법령 줄바꿈 검증 + 레이아웃 렌더 PoC 성립)
**상태**: 테스트 673/673. `npm run bench:gate` **5체인** 전부 PASS (신규 게이트 3종 포함). tsc 13(동수)

## 이번 세션 완료 (2026-07-03 연속 7차)

- **⓪ PR #39 인수 → v3.9.0 릴리스** — 기여자(leehuiso) 수식 생성 PR을 main 리베이스
  (충돌 없이 자동 병합) 후 리뷰 확정 8건을 4수술로 직접 수정, maintainerCanModify로
  포크 브랜치 갱신 → draft 해제 → **정식 머지(MERGED, 기여자 커밋 e74b284 보존)**.
  npm publish + tag + gh release + CHANGELOG/README/CLAUDE.md 모듈표(equation 2행 추가)
- **① 4수술 상세** — ⑴ $$스캐너 재작성: 미종결 통삼킴→일반 문단 폴백, 닫는 $$ 뒤
  텍스트 보존, 빈줄/코드펜스 경계, 이스케이프 \$$ 홀수 백슬래시 판정 ⑵ 깊이(64)/
  길이(10K) 가드: 중괄호 폭탄·\frac 체인 스택 오버플로 차단 ⑶ 어휘 왕복 공용화:
  ast→AST·leftarrow→larrow, 읽기 CONVERT_MAP에 +-·cdot 추가, normalizeEqEdit
  접합 제거(공백만), pmatrix/bmatrix 네이티브, LEFT/RIGHT 이스케이프 구분자(\{),
  예약어=토큰맵 키 도출+LaTeX 원문 선따옴표(변환 산출물 재따옴표 방지 — \pi 함정),
  \text→"…" 리터럴, 읽기 "…"→\text{} 언쿼트 (고정점) ⑷ 공문 run 예외 equation.
  **전 토큰 왕복 고정점 테스트**(COMMAND_MAP/ACCENT 전 항목) 신설
- **② 게이트 편입** — roundtrip: equation fixture+equationErrors, law fixture+
  lineErrors / fuzz: mdgen 60런(markdownToHwpx crash/hang/slow/genInvalid) —
  $$ 게이트 무감 구멍 봉합. 코퍼스 hash-sweep 동일(hwpx 75건에 수식 0건 실증)
- **③ 법령 md→hwpx 줄바꿈 검증 (유저 요청)** — 민원처리법 전문 md 왕복 실측:
  228문단, 빈 문단 0, 마커 단독 0, 223줄→223줄 쪼개짐/조각 0, XML lineBreak/
  개행/강제 페이지브레이크 0. **현행 버전 문제 없음** → law fixture lineErrors
  게이트로 클래스 고정
- **④ 레이아웃 보존 렌더 PoC 성립** — `.claude/plans/render-poc/` (스크립트+findings).
  결재문서(로고 PNG·표·하단 결재란)와 사진대지(BMP) 1페이지 SVG 재현 성공.
  핵심 산식: 최상위 lineseg=본문영역 로컬 / 셀=셀 로컬 / PARA 개체 밀어내기 역산
  `호스트vp−(omTop+h+omBottom)` 실측 정확 일치 / PAGE+BOTTOM=트레일러 하단 고정 /
  textLength=horzsize로 장평·배분정렬 재현. 잔여: 인라인(tac=1) 스케일·중첩 컨테이너
  pic·탭 청크·charPr — findings.md 참조

## 지표 대시보드 (2026-07-03 연속 7차 종료 — v3.9.0)

| 트랙 | 지표 | 값 | 게이트 | 비고 |
|---|---|---|---|---|
| hwpx(85) | recallMicro / phantom | **1.0** / 0.000054 | 0.999 / 0.005 | |
| hwpx | 표 exact / cellF1 | **611/611** / 1.0 | 0.99 / 0.999 | |
| pdf(48) | coverage(micro) | **0.99609** | 0.985 | 미달 1건 = eval-perf-2024 0.9785 |
| hwp쌍(10) | 유사도 / 커버 | **0.9946 / 0.9929** | 0.99 / 0.99 | |
| formats | docx/xlsxStr/hml | 0.998903/**1.0**/0.995974 | 0.998/0.999/0.995 | |
| roundtrip | fwd / bwd / 헤딩 / 수식 / 줄 | **0.999632 / 0.99915** / 0 / 0 / 0에러 | 0.999/0.998/0/0/0 ✨수식·줄 신설 | |
| pdf표GT(6쌍) | 매칭/exact/cellF1 | **0.8472/0.5417/0.6324** | 0.845/0.54/0.63 | |
| fuzz(792런) | crash/hang/noCode/slow/genInvalid | **0/0/0/0/0** | 전부 0 | ✨mdgen 60런 편입 |
| 테스트/tsc | **673/673** / 13(동수) | — | — | +수식 회귀/왕복 20건 |

## 릴리스

- **v3.9.0 발행됨** (2026-07-03): Markdown 수식 → HWPX native 수식 (#38, #39
  leehuiso 기여 + 리뷰 8건 수술) + 게이트 3종. npm+tag+gh release
- 커밋: e74b284(기여자) → a218af4(수술) → 7dcb7a9(bench) → 1dd819d(머지) → a125035(release)

## 다음 세션 (플랜: .claude/plans/next-session-pdf-gt-leftovers.md 갱신 2차 — 사용자 지시 반영)

**완주 목표: 작업 → npm 배포 → 문서 현행화 → 스레드 포스팅까지 한 번에.**
- ⓪ 한컴 실물 확인 피드백 처리 (수식검증-일반/공문.hwpx 2개 전달됨 — 결과 먼저 묻기)
- ① 렌더 모듈화 (메인): PoC 잔여 4건 → src/render/ + CLI — render-poc/findings.md
- ② 릴리스: 렌더 성립 시 v3.10.0 (아니면 v3.9.1) + CHANGELOG/README/CLAUDE.md 현행화
- ③ 스레드 포스팅 (threads-post 스킬): v3.8.4~v3.9.0 개선 요약 — 숫자 훅(0.947→0.9996 등),
  초안 사용자 컨펌 후 발행
- ④ 여유 시 pdf-table-gt 분할병합 / 소액 백로그

## 재론 금지 (기존 유지 + 신규)

- LINE_SEG 원본 유지 / 공문서 장평 95%·한컴 빈 문단 생략형 / PDF 머리글 y-클러스터 재도입 금지
- PDF coverage perLine trigram / hidden text 회전 예외 / extractLines CTM 추적 / pdfjs cMap 자산
- findTwoColumnProseCutX fullPage만 + finite 가드·상한 400 유지 / align Pass 1 본문문자 우선
- 셀 장식 관용은 heading paraPr 마킹 줄에만 / changwon 성능 재론 금지
- formats 추출기 = 파서 경계 미러 / xlsx 시트 순서 = workbook 순서 / UNIT_CAP 5만
- pdf-table-gt 모수 = 최상위 2×2+ / docx vMerge val 없음=계속 셀
- **pdf 헤어라인 tolerance 완화 금지** (6차 실험 기록 — GT 양방향 회귀)
- **파서 md `*` 이스케이프 유지** / generator 센티널 언이스케이프 유지 / 생성 헤딩 =
  OUTLINE + 빈 서식 numbering / 파서 빈 서식 paraHead 접두 발명 금지
- **수식 왕복 정합 유지**: 쓰기 COMMAND_MAP 값은 반드시 읽기 CONVERT_MAP이 같은
  LaTeX로 되돌리는 토큰 (전 토큰 고정점 테스트가 잠금 — 새 토큰 추가 시 양쪽 동시).
  예약어 따옴표는 **변환 전 LaTeX 원문에만** (산출물 재따옴표 = \pi→"pi" 함정)
- ⚠ hash-sweep EXTS에 .hml 미포함 — hml 파서 검증은 md 해시 별도 대조

## 코퍼스/도구 메모

- 실파일 코퍼스(gitignore): review/ 45 · hwp5/ 13+30 · pdf/ 42 · pairs/ 26 · formats/ 27
- 게이트 일괄: `npm run bench:gate`(5체인) / PDF표: `node bench/pdf-table-gt.mjs`
- npm publish: `~/.npmrc` bypass 2FA granular 토큰 유효. 릴리스 관례 = release 커밋
  (CHANGELOG+README `## vX.Y.Z 변경사항`+package.json) + 경량 태그 + npm publish + gh release
- PR 인수 관례: maintainerCanModify면 포크 브랜치에 force-push → draft면 `gh pr ready` → merge
- 렌더 PoC 재현: `python3 .claude/plans/render-poc/poc-render.py <hwpx> out.svg` →
  headless Chrome 스크린샷. 코퍼스 hwpx 75건에 수식 0건 (수식 검증은 fixture로만 가능)

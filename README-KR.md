# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

HWP, HWPX, PDF — 관공서에서 쏟아지는 모든 문서를 파싱하고, 비교하고, 분석하고, 생성합니다.

[English](./README.md)

![kordoc 데모](./demo.gif)

---

## v1.4.0 신기능

- **문서 비교 (Diff)** — IR 레벨 블록 비교로 신구대조표 생성. HWP↔HWPX 크로스 포맷 지원.
- **양식 인식** — 공문서 테이블에서 label-value 쌍 자동 추출. 성명, 소속, 전화번호 등.
- **구조화 파싱** — `IRBlock[]`과 `DocumentMetadata`에 직접 접근. 마크다운 넘어선 데이터 활용.
- **페이지 범위** — `parse(buffer, { pages: "1-3" })` — 필요한 페이지만 빠르게.
- **Markdown → HWPX** — 역변환. AI가 생성한 내용을 바로 공문서로.
- **OCR 연동** — 이미지 기반 PDF도 텍스트 추출 (Tesseract, Claude Vision 등 프로바이더 직접 제공).
- **Watch 모드** — `kordoc watch ./수신함 -d ./변환결과 --webhook https://...`
- **MCP 7개 도구** — parse_document, detect_format, parse_metadata, parse_pages, parse_table, compare_documents, parse_form
- **에러 코드** — `"ENCRYPTED"`, `"ZIP_BOMB"`, `"IMAGE_BASED_PDF"` 등 구조화된 에러 핸들링

---

## 설치

```bash
npm install kordoc

# PDF 파싱이 필요하면 (선택)
npm install pdfjs-dist
```

## 빠른 시작

### 문서 파싱

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const buffer = readFileSync("사업계획서.hwpx")
const result = await parse(buffer.buffer)

if (result.success) {
  console.log(result.markdown)       // 마크다운 텍스트
  console.log(result.blocks)         // IRBlock[] 구조화 데이터
  console.log(result.metadata)       // { title, author, createdAt, ... }
}
```

### 문서 비교 (신구대조표)

```typescript
import { compare } from "kordoc"

const diff = await compare(구버전Buffer, 신버전Buffer)
// diff.stats → { added: 3, removed: 1, modified: 5, unchanged: 42 }
// diff.diffs → BlockDiff[] (테이블은 셀 단위 diff 포함)
```

HWP vs HWPX 크로스 포맷 비교도 가능합니다.

### 양식 필드 추출

```typescript
import { parse, extractFormFields } from "kordoc"

const result = await parse(buffer)
if (result.success) {
  const form = extractFormFields(result.blocks)
  // form.fields → [{ label: "성명", value: "홍길동", row: 0, col: 0 }, ...]
  // form.confidence → 0.85
}
```

### HWPX 생성 (역변환)

```typescript
import { markdownToHwpx } from "kordoc"

const hwpxBuffer = await markdownToHwpx("# 제목\n\n본문 텍스트\n\n| 이름 | 직급 |\n| --- | --- |\n| 홍길동 | 과장 |")
writeFileSync("출력.hwpx", Buffer.from(hwpxBuffer))
```

### 페이지 범위 지정

```typescript
const result = await parse(buffer, { pages: "1-3" })      // 1~3 페이지만
const result = await parse(buffer, { pages: [1, 5, 10] })  // 특정 페이지
```

### OCR (이미지 PDF)

```typescript
const result = await parse(buffer, {
  ocr: async (pageImage, pageNumber, mimeType) => {
    return await myOcrService.recognize(pageImage)
  }
})
```

## CLI

```bash
npx kordoc 사업계획서.hwpx                          # 터미널 출력
npx kordoc 보고서.hwp -o 보고서.md                  # 파일 저장
npx kordoc *.pdf -d ./변환결과/                     # 일괄 변환
npx kordoc 검토서.hwpx --format json               # JSON (blocks + metadata 포함)
npx kordoc 보고서.hwpx --pages 1-3                  # 페이지 범위
npx kordoc watch ./수신함 -d ./변환결과              # 폴더 감시 모드
npx kordoc watch ./문서 --webhook https://api/hook  # 웹훅 알림
```

## MCP 서버 (Claude / Cursor / Windsurf)

```json
{
  "mcpServers": {
    "kordoc": {
      "command": "npx",
      "args": ["-y", "kordoc-mcp"]
    }
  }
}
```

**7개 도구:**

| 도구 | 설명 |
|------|------|
| `parse_document` | HWP/HWPX/PDF → 마크다운 (메타데이터 포함) |
| `detect_format` | 매직 바이트로 포맷 감지 |
| `parse_metadata` | 메타데이터만 빠르게 추출 |
| `parse_pages` | 특정 페이지 범위만 파싱 |
| `parse_table` | N번째 테이블만 추출 |
| `compare_documents` | 두 문서 비교 (크로스 포맷) |
| `parse_form` | 양식 필드를 JSON으로 추출 |

## API

### 핵심 함수

| 함수 | 설명 |
|------|------|
| `parse(buffer, options?)` | 포맷 자동 감지 → Markdown + IRBlock[] |
| `parseHwpx(buffer, options?)` | HWPX 전용 |
| `parseHwp(buffer, options?)` | HWP 5.x 전용 |
| `parsePdf(buffer, options?)` | PDF 전용 |
| `detectFormat(buffer)` | `"hwpx" \| "hwp" \| "pdf" \| "unknown"` |

### 고급 함수

| 함수 | 설명 |
|------|------|
| `compare(bufferA, bufferB, options?)` | IR 레벨 문서 비교 |
| `extractFormFields(blocks)` | IRBlock[]에서 양식 필드 인식 |
| `markdownToHwpx(markdown)` | Markdown → HWPX 역변환 |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown 문자열 |

### 타입

```typescript
import type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRTable, IRCell, CellContext,
  DocumentMetadata, ParseOptions, ErrorCode,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult,
  OcrProvider, WatchOptions,
} from "kordoc"
```

## 지원 포맷

| 포맷 | 엔진 | 특징 |
|------|------|------|
| **HWPX** (한컴 2020+) | ZIP + XML DOM | 매니페스트, 중첩 테이블, 병합 셀, 손상 ZIP 복구 |
| **HWP 5.x** (한컴 레거시) | OLE2 + CFB | 21종 제어문자, zlib 압축 해제, DRM 감지 |
| **PDF** | pdfjs-dist | 라인 그룹핑, 테이블 감지, 이미지 PDF + OCR |

## 보안

프로덕션급 보안 강화: ZIP bomb 방지, XXE/Billion Laughs 방지, 압축 폭탄 방지, 경로 순회 차단, MCP 에러 정제, 파일 크기 제한(500MB). 자세한 내용은 [SECURITY.md](./SECURITY.md) 참조.

## 만든 사람

대한민국 지방공무원. 광진구청에서 7년간 HWP 파일과 싸우다가 이걸 만들었습니다.
5개 공공 프로젝트에서 수천 건의 실제 관공서 문서를 파싱하며 검증했습니다.

## 라이선스

[MIT](./LICENSE)

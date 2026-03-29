# kordoc

**모두 파싱해버리겠다** — The Korean Document Platform.

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/kordoc.svg)](https://nodejs.org)

> *Parse, compare, extract, and generate Korean documents. HWP, HWPX, PDF — all of them.*

[한국어](./README-KR.md)

![kordoc demo](./demo.gif)

---

## What's New in v1.4.0

- **Document Compare** — Diff two documents at IR level. Cross-format (HWP vs HWPX) supported.
- **Form Field Recognition** — Extract label-value pairs from government forms automatically.
- **Structured Parsing** — Access `IRBlock[]` and `DocumentMetadata` directly, not just markdown.
- **Page Range Parsing** — Parse only pages 1-3: `parse(buffer, { pages: "1-3" })`.
- **Markdown to HWPX** — Reverse conversion. Generate valid HWPX files from markdown.
- **OCR Integration** — Pluggable OCR for image-based PDFs (bring your own provider).
- **Watch Mode** — `kordoc watch ./incoming --webhook https://...` for auto-conversion.
- **7 MCP Tools** — parse_document, detect_format, parse_metadata, parse_pages, parse_table, compare_documents, parse_form.
- **Error Codes** — Structured `code` field: `"ENCRYPTED"`, `"ZIP_BOMB"`, `"IMAGE_BASED_PDF"`, etc.

---

## Why kordoc?

South Korea's government runs on **HWP** — a proprietary word processor the rest of the world has never heard of. Every day, 243 local governments and thousands of public institutions produce mountains of `.hwp` files. Extracting text from them has always been a nightmare.

**kordoc** was born from that document hell. Built by a Korean civil servant who spent **7 years** buried under HWP files. Battle-tested across 5 real government projects. If a Korean public servant wrote it, kordoc can parse it.

---

## Installation

```bash
npm install kordoc

# PDF support (optional)
npm install pdfjs-dist
```

## Quick Start

### Parse Any Document

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const buffer = readFileSync("document.hwpx")
const result = await parse(buffer.buffer)

if (result.success) {
  console.log(result.markdown)       // Markdown text
  console.log(result.blocks)         // IRBlock[] structured data
  console.log(result.metadata)       // { title, author, createdAt, ... }
}
```

### Compare Two Documents

```typescript
import { compare } from "kordoc"

const diff = await compare(bufferA, bufferB)
// diff.stats → { added: 3, removed: 1, modified: 5, unchanged: 42 }
// diff.diffs → BlockDiff[] with cell-level table diffs
```

Cross-format supported: compare HWP against HWPX of the same document.

### Extract Form Fields

```typescript
import { parse, extractFormFields } from "kordoc"

const result = await parse(buffer)
if (result.success) {
  const form = extractFormFields(result.blocks)
  // form.fields → [{ label: "성명", value: "홍길동", row: 0, col: 0 }, ...]
  // form.confidence → 0.85
}
```

### Generate HWPX from Markdown

```typescript
import { markdownToHwpx } from "kordoc"

const hwpxBuffer = await markdownToHwpx("# Title\n\nParagraph text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |")
writeFileSync("output.hwpx", Buffer.from(hwpxBuffer))
```

### Parse Specific Pages

```typescript
const result = await parse(buffer, { pages: "1-3" })     // pages 1-3 only
const result = await parse(buffer, { pages: [1, 5, 10] }) // specific pages
```

### OCR for Image-Based PDFs

```typescript
const result = await parse(buffer, {
  ocr: async (pageImage, pageNumber, mimeType) => {
    return await myOcrService.recognize(pageImage) // Tesseract, Claude Vision, etc.
  }
})
```

## CLI

```bash
npx kordoc document.hwpx                          # stdout
npx kordoc document.hwp -o output.md              # save to file
npx kordoc *.pdf -d ./converted/                  # batch convert
npx kordoc report.hwpx --format json              # JSON with blocks + metadata
npx kordoc report.hwpx --pages 1-3                # page range
npx kordoc watch ./incoming -d ./output            # watch mode
npx kordoc watch ./docs --webhook https://api/hook # webhook notification
```

## MCP Server (Claude / Cursor / Windsurf)

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

**7 Tools:**

| Tool | Description |
|------|-------------|
| `parse_document` | Parse HWP/HWPX/PDF → Markdown with metadata |
| `detect_format` | Detect file format via magic bytes |
| `parse_metadata` | Extract metadata only (fast, no full parse) |
| `parse_pages` | Parse specific page range |
| `parse_table` | Extract Nth table from document |
| `compare_documents` | Diff two documents (cross-format) |
| `parse_form` | Extract form fields as structured JSON |

## API Reference

### Core

| Function | Description |
|----------|-------------|
| `parse(buffer, options?)` | Auto-detect format, parse to Markdown + IRBlock[] |
| `parseHwpx(buffer, options?)` | HWPX only |
| `parseHwp(buffer, options?)` | HWP 5.x only |
| `parsePdf(buffer, options?)` | PDF only |
| `detectFormat(buffer)` | Returns `"hwpx" \| "hwp" \| "pdf" \| "unknown"` |

### Advanced

| Function | Description |
|----------|-------------|
| `compare(bufferA, bufferB, options?)` | Document diff at IR level |
| `extractFormFields(blocks)` | Form field recognition from IRBlock[] |
| `markdownToHwpx(markdown)` | Markdown → HWPX reverse conversion |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown string |

### Types

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

## Supported Formats

| Format | Engine | Features |
|--------|--------|----------|
| **HWPX** (한컴 2020+) | ZIP + XML DOM | Manifest, nested tables, merged cells, broken ZIP recovery |
| **HWP 5.x** (한컴 Legacy) | OLE2 + CFB | 21 control chars, zlib decompression, DRM detection |
| **PDF** | pdfjs-dist | Line grouping, table detection, image PDF + OCR |

## Security

Production-grade hardening: ZIP bomb protection, XXE/Billion Laughs prevention, decompression bomb guard, path traversal guard, MCP error sanitization, file size limits (500MB). See [SECURITY.md](./SECURITY.md) for details.

## Credits

Production-tested across 5 Korean government projects: school curriculum plans, facility inspection reports, legal document annexes, municipal newsletters, and public data extraction tools. Thousands of real government documents parsed.

## License

[MIT](./LICENSE)

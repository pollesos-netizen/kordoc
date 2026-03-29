/** HWP 5.x 바이너리 파서 — OLE2 컨테이너 → 섹션 → Markdown */

import {
  readRecords, decompressStream, parseFileHeader, extractText,
  TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE,
  FLAG_COMPRESSED, FLAG_ENCRYPTED, FLAG_DRM,
  type HwpRecord,
} from "./record.js"
import { buildTable, blocksToMarkdown, MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { CellContext, IRBlock, DocumentMetadata, InternalParseResult, ParseOptions } from "../types.js"
import { KordocError } from "../utils.js"
import { parsePageRange } from "../page-range.js"

import { createRequire } from "module"
const require = createRequire(import.meta.url)
const CFB: CfbModule = require("cfb")

interface CfbEntry { name?: string; content?: Buffer | Uint8Array }
interface CfbContainer { FileIndex?: CfbEntry[] }
interface CfbModule {
  parse(data: Buffer): CfbContainer
  find(cfb: CfbContainer, path: string): CfbEntry | null
}

/** 최대 섹션 수 — 비정상 파일에 의한 무한 루프 방지 */
const MAX_SECTIONS = 100
/** 누적 압축 해제 최대 크기 (100MB) */
const MAX_TOTAL_DECOMPRESS = 100 * 1024 * 1024

export function parseHwp5Document(buffer: Buffer, options?: ParseOptions): InternalParseResult {
  const cfb = CFB.parse(buffer)

  const headerEntry = CFB.find(cfb, "/FileHeader")
  if (!headerEntry?.content) throw new KordocError("FileHeader 스트림 없음")
  const header = parseFileHeader(Buffer.from(headerEntry.content))
  if (header.signature !== "HWP Document File") throw new KordocError("HWP 시그니처 불일치")
  if (header.flags & FLAG_ENCRYPTED) throw new KordocError("암호화된 HWP는 지원하지 않습니다")
  if (header.flags & FLAG_DRM) throw new KordocError("DRM 보호된 HWP는 지원하지 않습니다")
  const compressed = (header.flags & FLAG_COMPRESSED) !== 0

  const metadata: DocumentMetadata = {
    version: `${header.versionMajor}.x`,
  }
  extractHwp5Metadata(cfb, metadata)

  const sections = findSections(cfb)
  if (sections.length === 0) throw new KordocError("섹션 스트림을 찾을 수 없습니다")

  metadata.pageCount = sections.length

  // 페이지 범위 필터링 (섹션 단위 근사치)
  const pageFilter = options?.pages ? parsePageRange(options.pages, sections.length) : null

  const blocks: IRBlock[] = []
  let totalDecompressed = 0
  for (let si = 0; si < sections.length; si++) {
    if (pageFilter && !pageFilter.has(si + 1)) continue
    const sectionData = sections[si]
    const data = compressed ? decompressStream(Buffer.from(sectionData)) : Buffer.from(sectionData)
    totalDecompressed += data.length
    if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new KordocError("총 압축 해제 크기 초과 (decompression bomb 의심)")
    const records = readRecords(data)
    blocks.push(...parseSection(records))
  }

  const markdown = blocksToMarkdown(blocks)
  return { markdown, blocks, metadata }
}

// ─── 메타데이터 추출 (best-effort) ───────────────────

/**
 * OLE2 SummaryInformation 스트림에서 제목/작성자 추출.
 * HWP5는 \005HwpSummaryInformation 또는 \005SummaryInformation에 저장.
 * OLE2 Property Set 포맷의 간이 파싱 — 실패 시 조용히 무시.
 */
function extractHwp5Metadata(cfb: CfbContainer, metadata: DocumentMetadata): void {
  try {
    // HWP 전용 SummaryInformation 먼저, 없으면 표준 OLE2
    const summaryEntry =
      CFB.find(cfb, "/\x05HwpSummaryInformation") ||
      CFB.find(cfb, "/\x05SummaryInformation")
    if (!summaryEntry?.content) return

    const data = Buffer.from(summaryEntry.content)
    if (data.length < 48) return

    // OLE2 Property Set Header: byte order(2) + version(2) + OS(4) + CLSID(16) + numSets(4) = 28
    // Then FMTID(16) + offset(4)
    const numSets = data.readUInt32LE(24)
    if (numSets === 0) return

    const setOffset = data.readUInt32LE(44)
    if (setOffset >= data.length - 8) return

    // Property Set: size(4) + numProperties(4) + [propertyId(4) + offset(4)] * N
    const numProps = data.readUInt32LE(setOffset + 4)
    if (numProps === 0 || numProps > 100) return

    for (let i = 0; i < numProps; i++) {
      const entryOffset = setOffset + 8 + i * 8
      if (entryOffset + 8 > data.length) break

      const propId = data.readUInt32LE(entryOffset)
      const propOffset = setOffset + data.readUInt32LE(entryOffset + 4)
      if (propOffset + 8 > data.length) continue

      // Property ID: 2=Title, 4=Author, 6=Subject/Description
      if (propId !== 2 && propId !== 4 && propId !== 6) continue

      const propType = data.readUInt32LE(propOffset)
      // Type 0x1E = VT_LPSTR (ANSI string)
      if (propType !== 0x1e) continue

      const strLen = data.readUInt32LE(propOffset + 4)
      if (strLen === 0 || strLen > 10000 || propOffset + 8 + strLen > data.length) continue

      const str = data.subarray(propOffset + 8, propOffset + 8 + strLen).toString("utf8").replace(/\0+$/, "").trim()
      if (!str) continue

      if (propId === 2) metadata.title = str
      else if (propId === 4) metadata.author = str
      else if (propId === 6) metadata.description = str
    }
  } catch {
    // best-effort — 실패 시 조용히 무시
  }
}

/** 메타데이터만 추출 (전체 파싱 없이) — MCP parse_metadata용 */
export function extractHwp5MetadataOnly(buffer: Buffer): DocumentMetadata {
  const cfb = CFB.parse(buffer)
  const headerEntry = CFB.find(cfb, "/FileHeader")
  if (!headerEntry?.content) throw new KordocError("FileHeader 스트림 없음")
  const header = parseFileHeader(Buffer.from(headerEntry.content))
  if (header.signature !== "HWP Document File") throw new KordocError("HWP 시그니처 불일치")

  const metadata: DocumentMetadata = {
    version: `${header.versionMajor}.x`,
  }
  extractHwp5Metadata(cfb, metadata)

  const sections = findSections(cfb)
  metadata.pageCount = sections.length

  return metadata
}

function findSections(cfb: CfbContainer): Buffer[] {
  const sections: Array<{ idx: number; content: Buffer }> = []

  for (let i = 0; i < MAX_SECTIONS; i++) {
    const entry = CFB.find(cfb, `/BodyText/Section${i}`)
    if (!entry?.content) break
    sections.push({ idx: i, content: Buffer.from(entry.content) })
  }

  if (sections.length === 0 && cfb.FileIndex) {
    for (const entry of cfb.FileIndex) {
      if (sections.length >= MAX_SECTIONS) break
      if (entry.name?.startsWith("Section") && entry.content) {
        const idx = parseInt(entry.name.replace("Section", ""), 10) || 0
        sections.push({ idx, content: Buffer.from(entry.content) })
      }
    }
  }

  return sections.sort((a, b) => a.idx - b.idx).map(s => s.content)
}

function parseSection(records: HwpRecord[]): IRBlock[] {
  const blocks: IRBlock[] = []
  let i = 0

  while (i < records.length) {
    const rec = records[i]

    if (rec.tagId === TAG_PARA_HEADER && rec.level === 0) {
      const { paragraph, tables, nextIdx } = parseParagraphWithTables(records, i)
      if (paragraph) blocks.push({ type: "paragraph", text: paragraph })
      for (const t of tables) blocks.push({ type: "table", table: t })
      i = nextIdx
      continue
    }

    if (rec.tagId === TAG_CTRL_HEADER && rec.level <= 1 && rec.data.length >= 4) {
      const ctrlId = rec.data.subarray(0, 4).toString("ascii")
      if (ctrlId === " lbt" || ctrlId === "tbl ") {
        const { table, nextIdx } = parseTableBlock(records, i)
        if (table) blocks.push({ type: "table", table })
        i = nextIdx
        continue
      }
    }

    i++
  }

  return blocks
}

function parseParagraphWithTables(records: HwpRecord[], startIdx: number) {
  const startLevel = records[startIdx].level
  let text = ""
  const tables: ReturnType<typeof buildTable>[] = []
  let i = startIdx + 1

  while (i < records.length) {
    const rec = records[i]
    if (rec.tagId === TAG_PARA_HEADER && rec.level <= startLevel) break

    if (rec.tagId === TAG_PARA_TEXT) {
      text = extractText(rec.data)
    }

    if (rec.tagId === TAG_CTRL_HEADER && rec.data.length >= 4) {
      const ctrlId = rec.data.subarray(0, 4).toString("ascii")
      if (ctrlId === " lbt" || ctrlId === "tbl ") {
        const { table, nextIdx } = parseTableBlock(records, i)
        if (table) tables.push(table)
        i = nextIdx
        continue
      }
    }
    i++
  }

  const trimmed = text.trim()
  return { paragraph: trimmed || null, tables, nextIdx: i }
}

function parseTableBlock(records: HwpRecord[], startIdx: number) {
  const tableLevel = records[startIdx].level
  let i = startIdx + 1
  let rows = 0, cols = 0
  const cells: CellContext[] = []

  while (i < records.length) {
    const rec = records[i]
    if (rec.tagId === TAG_PARA_HEADER && rec.level <= tableLevel) break
    if (rec.tagId === TAG_CTRL_HEADER && rec.level <= tableLevel) break

    if (rec.tagId === TAG_TABLE && rec.data.length >= 8) {
      rows = Math.min(rec.data.readUInt16LE(4), MAX_ROWS)
      cols = Math.min(rec.data.readUInt16LE(6), MAX_COLS)
    }

    if (rec.tagId === TAG_LIST_HEADER) {
      const { cell, nextIdx } = parseCellBlock(records, i, tableLevel)
      if (cell) cells.push(cell)
      i = nextIdx
      continue
    }
    i++
  }

  if (rows === 0 || cols === 0 || cells.length === 0) return { table: null, nextIdx: i }

  const cellRows = arrangeCells(rows, cols, cells)
  return { table: buildTable(cellRows), nextIdx: i }
}

function parseCellBlock(records: HwpRecord[], startIdx: number, tableLevel: number) {
  const rec = records[startIdx]
  const cellLevel = rec.level
  const texts: string[] = []

  // LIST_HEADER에서 셀 병합 정보 추출
  // HWP5 셀 LIST_HEADER 구조: paraCount(u16) + flags(u32) + colAddr(u16) + rowAddr(u16) + colSpan(u16) + rowSpan(u16)
  let colSpan = 1
  let rowSpan = 1
  if (rec.data.length >= 14) {
    const cs = rec.data.readUInt16LE(10)
    const rs = rec.data.readUInt16LE(12)
    if (cs > 0) colSpan = Math.min(cs, MAX_COLS)
    if (rs > 0) rowSpan = Math.min(rs, MAX_ROWS)
  }

  let i = startIdx + 1

  while (i < records.length) {
    const r = records[i]
    if (r.tagId === TAG_LIST_HEADER && r.level <= cellLevel) break
    if (r.level <= tableLevel && (r.tagId === TAG_PARA_HEADER || r.tagId === TAG_CTRL_HEADER)) break

    if (r.tagId === TAG_PARA_TEXT) {
      const t = extractText(r.data).trim()
      if (t) texts.push(t)
    }
    i++
  }

  return { cell: { text: texts.join("\n"), colSpan, rowSpan } as CellContext, nextIdx: i }
}

function arrangeCells(rows: number, cols: number, cells: CellContext[]): CellContext[][] {
  const grid: (CellContext | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null))
  let cellIdx = 0

  for (let r = 0; r < rows && cellIdx < cells.length; r++) {
    for (let c = 0; c < cols && cellIdx < cells.length; c++) {
      if (grid[r][c] !== null) continue
      const cell = cells[cellIdx++]
      grid[r][c] = cell

      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < rows && c + dc < cols)
            grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 }
        }
      }
    }
  }

  return grid.map(row => row.map(c => c || { text: "", colSpan: 1, rowSpan: 1 }))
}

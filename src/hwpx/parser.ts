/**
 * HWPX 파서 — manifest 멀티섹션, colSpan/rowSpan, 중첩테이블
 *
 * lexdiff 기반 + edu-facility-ai 손상ZIP 복구
 */

import JSZip from "jszip"
import { inflateRawSync } from "zlib"
import { DOMParser } from "@xmldom/xmldom"
import { buildTable, convertTableToText, blocksToMarkdown, MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { CellContext, IRBlock, DocumentMetadata, InternalParseResult, ParseOptions } from "../types.js"
import { KordocError, isPathTraversal } from "../utils.js"
import { parsePageRange } from "../page-range.js"

/** 압축 해제 최대 크기 (100MB) — ZIP bomb 방지 */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024
/** 손상 ZIP 복구 시 최대 엔트리 수 */
const MAX_ZIP_ENTRIES = 500

/** colSpan/rowSpan을 안전한 범위로 클램핑 */
function clampSpan(val: number, max: number): number {
  return Math.max(1, Math.min(val, max))
}

interface TableState { rows: CellContext[][]; currentRow: CellContext[]; cell: CellContext | null }

/** XXE/Billion Laughs 방지 — DOCTYPE 제거 (내부 DTD 서브셋 포함) */
function stripDtd(xml: string): string {
  return xml.replace(/<!DOCTYPE\s[^[>]*(\[[\s\S]*?\])?\s*>/gi, "")
}

export async function parseHwpxDocument(buffer: ArrayBuffer, options?: ParseOptions): Promise<InternalParseResult> {
  // Best-effort 사전 검증 — CD 선언 크기 기반 (위조 가능, 실제 방어는 per-file 누적 체크)
  const precheck = precheckZipSize(buffer)
  if (precheck.totalUncompressed > MAX_DECOMPRESS_SIZE) {
    throw new KordocError("ZIP 비압축 크기 초과 (ZIP bomb 의심)")
  }
  if (precheck.entryCount > MAX_ZIP_ENTRIES) {
    throw new KordocError("ZIP 엔트리 수 초과 (ZIP bomb 의심)")
  }

  let zip: JSZip

  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    return extractFromBrokenZip(buffer)
  }

  // loadAsync 후 실제 엔트리 수 검증 — CD 위조와 무관한 진짜 방어선
  const actualEntryCount = Object.keys(zip.files).length
  if (actualEntryCount > MAX_ZIP_ENTRIES) {
    throw new KordocError("ZIP 엔트리 수 초과 (ZIP bomb 의심)")
  }

  // 메타데이터 추출 (best-effort)
  const metadata: DocumentMetadata = {}
  await extractHwpxMetadata(zip, metadata)

  const sectionPaths = await resolveSectionPaths(zip)
  if (sectionPaths.length === 0) throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")

  metadata.pageCount = sectionPaths.length

  // 페이지 범위 필터링 (섹션 단위 근사치)
  const pageFilter = options?.pages ? parsePageRange(options.pages, sectionPaths.length) : null

  let totalDecompressed = 0
  const blocks: IRBlock[] = []
  for (let si = 0; si < sectionPaths.length; si++) {
    if (pageFilter && !pageFilter.has(si + 1)) continue
    const file = zip.file(sectionPaths[si])
    if (!file) continue
    const xml = await file.async("text")
    totalDecompressed += xml.length * 2
    if (totalDecompressed > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")
    blocks.push(...parseSectionXml(xml))
  }

  const markdown = blocksToMarkdown(blocks)
  return { markdown, blocks, metadata }
}

// ─── 메타데이터 추출 (best-effort) ───────────────────

/**
 * HWPX ZIP 내 메타데이터 파일에서 Dublin Core 정보 추출.
 * 표준 경로: meta.xml, docProps/core.xml, META-INF/container.xml
 */
async function extractHwpxMetadata(zip: JSZip, metadata: DocumentMetadata): Promise<void> {
  try {
    // meta.xml (HWPX 표준) 또는 docProps/core.xml (OOXML 호환)
    const metaPaths = ["meta.xml", "META-INF/meta.xml", "docProps/core.xml"]
    for (const mp of metaPaths) {
      const file = zip.file(mp) || Object.values(zip.files).find(f => f.name.toLowerCase() === mp.toLowerCase()) || null
      if (!file) continue
      const xml = await file.async("text")
      parseDublinCoreMetadata(xml, metadata)
      if (metadata.title || metadata.author) return
    }
  } catch {
    // best-effort
  }
}

/** Dublin Core (dc:) 메타데이터 XML 파싱 */
function parseDublinCoreMetadata(xml: string, metadata: DocumentMetadata): void {
  const parser = new DOMParser()
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  if (!doc.documentElement) return

  const getText = (tagNames: string[]): string | undefined => {
    for (const tag of tagNames) {
      const els = doc.getElementsByTagName(tag)
      if (els.length > 0) {
        const text = els[0].textContent?.trim()
        if (text) return text
      }
    }
    return undefined
  }

  metadata.title = metadata.title || getText(["dc:title", "title"])
  metadata.author = metadata.author || getText(["dc:creator", "creator", "cp:lastModifiedBy"])
  metadata.description = metadata.description || getText(["dc:description", "description", "dc:subject", "subject"])
  metadata.createdAt = metadata.createdAt || getText(["dcterms:created", "meta:creation-date"])
  metadata.modifiedAt = metadata.modifiedAt || getText(["dcterms:modified", "meta:date"])

  const keywords = getText(["dc:keyword", "cp:keywords", "meta:keyword"])
  if (keywords && !metadata.keywords) {
    metadata.keywords = keywords.split(/[,;]/).map(k => k.trim()).filter(Boolean)
  }
}

/** 메타데이터만 추출 (전체 파싱 없이) — MCP parse_metadata용 */
export async function extractHwpxMetadataOnly(buffer: ArrayBuffer): Promise<DocumentMetadata> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new KordocError("HWPX ZIP을 열 수 없습니다")
  }

  const metadata: DocumentMetadata = {}
  await extractHwpxMetadata(zip, metadata)

  const sectionPaths = await resolveSectionPaths(zip)
  metadata.pageCount = sectionPaths.length

  return metadata
}

/**
 * loadAsync 전 raw buffer에서 Central Directory를 파싱하여
 * 선언된 비압축 크기 합산 + 엔트리 수를 사전 검증.
 *
 * ⚠️ 한계: CD에 선언된 비압축 크기는 공격자가 위조 가능.
 * 이 함수는 "정직한 ZIP"에 대한 조기 거부(best-effort early rejection)만 수행.
 * 실제 ZIP bomb 방어는 loadAsync 후 per-file 누적 크기 체크에서 담당.
 *
 * Central Directory가 손상된 경우(extractFromBrokenZip으로 폴백될 케이스)에는
 * 안전한 기본값을 반환하여 loadAsync가 시도되도록 함.
 *
 * @internal 테스트 전용 export — public API(index.ts)에서 재노출하지 않음
 */
export function precheckZipSize(buffer: ArrayBuffer): { totalUncompressed: number; entryCount: number } {
  try {
    const data = new DataView(buffer)
    const len = buffer.byteLength
    if (len < 22) return { totalUncompressed: 0, entryCount: 0 }

    // End of Central Directory (EOCD) 시그니처를 뒤에서부터 탐색
    // EOCD는 최소 22바이트, comment 최대 65535바이트
    const searchStart = Math.max(0, len - 22 - 65535)
    let eocdOffset = -1
    for (let i = len - 22; i >= searchStart; i--) {
      if (data.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break }
    }
    if (eocdOffset < 0) return { totalUncompressed: 0, entryCount: 0 }

    const entryCount = data.getUint16(eocdOffset + 10, true)
    const cdSize = data.getUint32(eocdOffset + 12, true)
    const cdOffset = data.getUint32(eocdOffset + 16, true)

    if (cdOffset + cdSize > len) return { totalUncompressed: 0, entryCount }

    // Central Directory 엔트리 순회
    let totalUncompressed = 0
    let pos = cdOffset
    for (let i = 0; i < entryCount && pos + 46 <= cdOffset + cdSize; i++) {
      if (data.getUint32(pos, true) !== 0x02014b50) break
      totalUncompressed += data.getUint32(pos + 24, true)
      const nameLen = data.getUint16(pos + 28, true)
      const extraLen = data.getUint16(pos + 30, true)
      const commentLen = data.getUint16(pos + 32, true)
      pos += 46 + nameLen + extraLen + commentLen
    }

    return { totalUncompressed, entryCount }
  } catch {
    // DataView 범위 초과 등 예외 시 안전한 기본값 반환
    return { totalUncompressed: 0, entryCount: 0 }
  }
}

// ─── 손상 ZIP 복구 (edu-facility-ai에서 포팅) ──────────

function extractFromBrokenZip(buffer: ArrayBuffer): InternalParseResult {
  const data = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let pos = 0
  const blocks: IRBlock[] = []
  let totalDecompressed = 0
  let entryCount = 0

  while (pos < data.length - 30) {
    // PK\x03\x04 시그니처 확인
    if (data[pos] !== 0x50 || data[pos + 1] !== 0x4b || data[pos + 2] !== 0x03 || data[pos + 3] !== 0x04) break

    if (++entryCount > MAX_ZIP_ENTRIES) break

    const method = view.getUint16(pos + 8, true)
    const compSize = view.getUint32(pos + 18, true)
    const nameLen = view.getUint16(pos + 26, true)
    const extraLen = view.getUint16(pos + 28, true)

    // nameLen 상한 — 비정상 값에 의한 대규모 버퍼 할당 방지
    if (nameLen > 1024 || extraLen > 65535) { pos += 30 + nameLen + extraLen; continue }

    const fileStart = pos + 30 + nameLen + extraLen
    // 범위 초과 검증 — OOB 및 무한 루프 방지
    if (fileStart + compSize > data.length) break
    if (compSize === 0 && method !== 0) { pos = fileStart; continue }

    const nameBytes = data.slice(pos + 30, pos + 30 + nameLen)
    const name = new TextDecoder().decode(nameBytes)

    // 경로 순회 방지 — 상위 디렉토리 참조 및 절대 경로 차단
    if (isPathTraversal(name)) { pos = fileStart + compSize; continue }
    const fileData = data.slice(fileStart, fileStart + compSize)
    pos = fileStart + compSize

    if (!name.toLowerCase().includes("section") || !name.endsWith(".xml")) continue

    try {
      let content: string
      if (method === 0) {
        content = new TextDecoder().decode(fileData)
      } else if (method === 8) {
        const decompressed = inflateRawSync(Buffer.from(fileData), { maxOutputLength: MAX_DECOMPRESS_SIZE })
        content = new TextDecoder().decode(decompressed)
      } else {
        continue
      }
      totalDecompressed += content.length * 2
      if (totalDecompressed > MAX_DECOMPRESS_SIZE) throw new KordocError("압축 해제 크기 초과")
      blocks.push(...parseSectionXml(content))
    } catch {
      continue
    }
  }

  if (blocks.length === 0) throw new KordocError("손상된 HWPX에서 섹션 데이터를 복구할 수 없습니다")
  const markdown = blocksToMarkdown(blocks)
  return { markdown, blocks }
}

// ─── Manifest 해석 ───────────────────────────────────

async function resolveSectionPaths(zip: JSZip): Promise<string[]> {
  const manifestPaths = ["Contents/content.hpf", "content.hpf"]
  for (const mp of manifestPaths) {
    const mpLower = mp.toLowerCase()
    const file = zip.file(mp) || Object.values(zip.files).find(f => f.name.toLowerCase() === mpLower) || null
    if (!file) continue
    const xml = await file.async("text")
    const paths = parseSectionPathsFromManifest(xml)
    if (paths.length > 0) return paths
  }

  // fallback: section*.xml 직접 검색
  const sectionFiles = zip.file(/[Ss]ection\d+\.xml$/)
  return sectionFiles.map(f => f.name).sort()
}

function parseSectionPathsFromManifest(xml: string): string[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  const items = doc.getElementsByTagName("opf:item")
  const spine = doc.getElementsByTagName("opf:itemref")

  const isSectionId = (id: string) => /^s/i.test(id) || id.toLowerCase().includes("section")
  const idToHref = new Map<string, string>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.getAttribute("id") || ""
    let href = item.getAttribute("href") || ""
    const mediaType = item.getAttribute("media-type") || ""
    if (!isSectionId(id) && !mediaType.includes("xml")) continue
    if (!href.startsWith("/") && !href.startsWith("Contents/") && isSectionId(id))
      href = "Contents/" + href
    idToHref.set(id, href)
  }

  if (spine.length > 0) {
    const ordered: string[] = []
    for (let i = 0; i < spine.length; i++) {
      const href = idToHref.get(spine[i].getAttribute("idref") || "")
      if (href) ordered.push(href)
    }
    if (ordered.length > 0) return ordered
  }
  return Array.from(idToHref.entries())
    .filter(([id]) => isSectionId(id))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, href]) => href)
}

// ─── 섹션 XML 파싱 ──────────────────────────────────

function parseSectionXml(xml: string): IRBlock[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  if (!doc.documentElement) return []

  const blocks: IRBlock[] = []
  walkSection(doc.documentElement, blocks, null, [])
  return blocks
}

function walkSection(
  node: Node, blocks: IRBlock[],
  tableCtx: TableState | null, tableStack: TableState[]
): void {
  const children = node.childNodes
  if (!children) return

  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType !== 1) continue

    const tag = el.tagName || el.localName || ""
    const localTag = tag.replace(/^[^:]+:/, "")

    switch (localTag) {
      case "tbl": {
        if (tableCtx) tableStack.push(tableCtx)
        const newTable: TableState = { rows: [], currentRow: [], cell: null }
        walkSection(el, blocks, newTable, tableStack)

        if (newTable.rows.length > 0) {
          if (tableStack.length > 0) {
            const parentTable = tableStack.pop()!
            const nestedText = convertTableToText(newTable.rows)
            if (parentTable.cell) {
              parentTable.cell.text += (parentTable.cell.text ? "\n" : "") + nestedText
            }
            tableCtx = parentTable
          } else {
            blocks.push({ type: "table", table: buildTable(newTable.rows) })
            tableCtx = null
          }
        } else {
          tableCtx = tableStack.length > 0 ? tableStack.pop()! : null
        }
        break
      }

      case "tr":
        if (tableCtx) {
          tableCtx.currentRow = []
          walkSection(el, blocks, tableCtx, tableStack)
          if (tableCtx.currentRow.length > 0) tableCtx.rows.push(tableCtx.currentRow)
          tableCtx.currentRow = []
        }
        break

      case "tc":
        if (tableCtx) {
          tableCtx.cell = { text: "", colSpan: 1, rowSpan: 1 }
          walkSection(el, blocks, tableCtx, tableStack)
          if (tableCtx.cell) {
            tableCtx.currentRow.push(tableCtx.cell)
            tableCtx.cell = null
          }
        }
        break

      case "cellSpan":
        if (tableCtx?.cell) {
          const cs = parseInt(el.getAttribute("colSpan") || "1", 10)
          const rs = parseInt(el.getAttribute("rowSpan") || "1", 10)
          tableCtx.cell.colSpan = clampSpan(cs, MAX_COLS)
          tableCtx.cell.rowSpan = clampSpan(rs, MAX_ROWS)
        }
        break

      case "p": {
        const text = extractParagraphText(el)
        if (text) {
          if (tableCtx?.cell) {
            tableCtx.cell.text += (tableCtx.cell.text ? "\n" : "") + text
          } else if (!tableCtx) {
            blocks.push({ type: "paragraph", text })
          }
        }
        walkSection(el, blocks, tableCtx, tableStack)
        break
      }

      default:
        walkSection(el, blocks, tableCtx, tableStack)
        break
    }
  }
}

function extractParagraphText(para: Node): string {
  let text = ""
  const walk = (node: Node) => {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType === 3) { text += child.textContent || ""; continue }
      if (child.nodeType !== 1) continue

      const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
      switch (tag) {
        case "t": text += child.textContent || ""; break
        case "tab": text += "\t"; break
        case "br":
          if ((child.getAttribute("type") || "line") === "line") text += "\n"
          break
        case "fwSpace": case "hwSpace": text += " "; break
        case "tbl": break // 테이블은 walkSection에서 처리
        default: walk(child); break
      }
    }
  }
  walk(para)
  return text.replace(/[ \t]+/g, " ").trim()
}

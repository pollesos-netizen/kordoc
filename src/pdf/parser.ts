/**
 * PDF 텍스트 추출 (pdfjs-dist static import 기반)
 *
 * polyfill을 먼저 import해야 DOMMatrix/Path2D/pdfjsWorker가 주입됨.
 * ES 모듈 호이스팅 때문에 별도 파일로 분리되어 있음.
 */

import type { ParseResult, IRBlock, DocumentMetadata, ParseOptions } from "../types.js"
import { KordocError } from "../utils.js"
import { parsePageRange } from "../page-range.js"
// polyfill 먼저 (ES 모듈 호이스팅되므로 별도 파일 필수)
import "./polyfill.js"
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs"

// worker 비활성화 (polyfill에서 pdfjsWorker를 이미 주입했으므로)
GlobalWorkerOptions.workerSrc = ""

// ─── 안전 한계값 (구조적 파싱과 무관) ────────────────
const MAX_PAGES = 5000
const MAX_TOTAL_TEXT = 100 * 1024 * 1024 // 100MB

interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

interface NormItem {
  text: string
  x: number
  y: number
  w: number
  h: number
}

export async function parsePdfDocument(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise

  try {
    const pageCount = doc.numPages
    if (pageCount === 0) return { success: false, fileType: "pdf", pageCount: 0, error: "PDF에 페이지가 없습니다.", blocks: [] } as unknown as ParseResult

    // 메타데이터 추출 (best-effort)
    const metadata: DocumentMetadata = { pageCount }
    await extractPdfMetadata(doc, metadata)

    const pageTexts: string[] = []
    const blocks: IRBlock[] = []
    let totalChars = 0
    let totalTextBytes = 0
    const effectivePageCount = Math.min(pageCount, MAX_PAGES)

    // 페이지 범위 필터링
    const pageFilter = options?.pages ? parsePageRange(options.pages, effectivePageCount) : null

    for (let i = 1; i <= effectivePageCount; i++) {
      if (pageFilter && !pageFilter.has(i)) continue
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const pageText = extractPageContent(tc.items as PdfTextItem[])
      totalChars += pageText.replace(/\s/g, "").length
      totalTextBytes += pageText.length * 2
      if (totalTextBytes > MAX_TOTAL_TEXT) throw new KordocError("텍스트 추출 크기 초과")
      pageTexts.push(pageText)
      blocks.push({ type: "paragraph", text: pageText })
    }

    const parsedPageCount = pageFilter ? pageFilter.size : effectivePageCount
    if (totalChars / Math.max(parsedPageCount, 1) < 10) {
      // OCR 프로바이더가 있으면 이미지 기반 PDF도 텍스트 추출 시도
      if (options?.ocr) {
        try {
          const { ocrPages } = await import("../ocr/provider.js")
          const ocrBlocks = await ocrPages(doc, options.ocr, pageFilter, effectivePageCount)
          if (ocrBlocks.length > 0) {
            const ocrMarkdown = ocrBlocks.map(b => b.text || "").filter(Boolean).join("\n\n")
            return { success: true, fileType: "pdf", markdown: ocrMarkdown, pageCount: parsedPageCount, blocks: ocrBlocks, metadata, isImageBased: true }
          }
        } catch {
          // OCR 실패 시 원래 에러 반환
        }
      }
      return { success: false, fileType: "pdf", pageCount, isImageBased: true, error: `이미지 기반 PDF (${pageCount}페이지, ${totalChars}자)`, code: "IMAGE_BASED_PDF" }
    }

    let markdown = pageTexts.filter(t => t.trim()).join("\n\n")
    markdown = cleanPdfText(markdown)

    return { success: true, fileType: "pdf", markdown, pageCount: parsedPageCount, blocks, metadata }
  } finally {
    await doc.destroy().catch(() => {})
  }
}

// ─── PDF 메타데이터 추출 ────────────────────────────

async function extractPdfMetadata(doc: { getMetadata(): Promise<unknown> }, metadata: DocumentMetadata): Promise<void> {
  try {
    const result = await doc.getMetadata() as { info?: Record<string, unknown> } | null
    if (!result?.info) return
    const info = result.info

    if (typeof info.Title === "string" && info.Title.trim()) metadata.title = info.Title.trim()
    if (typeof info.Author === "string" && info.Author.trim()) metadata.author = info.Author.trim()
    if (typeof info.Creator === "string" && info.Creator.trim()) metadata.creator = info.Creator.trim()
    if (typeof info.Subject === "string" && info.Subject.trim()) metadata.description = info.Subject.trim()
    if (typeof info.Keywords === "string" && info.Keywords.trim()) {
      metadata.keywords = info.Keywords.split(/[,;]/).map((k: string) => k.trim()).filter(Boolean)
    }
    if (typeof info.CreationDate === "string") metadata.createdAt = parsePdfDate(info.CreationDate)
    if (typeof info.ModDate === "string") metadata.modifiedAt = parsePdfDate(info.ModDate)
  } catch {
    // best-effort
  }
}

/** PDF 날짜 형식 (D:YYYYMMDDHHmmSS) → ISO 8601 변환 */
function parsePdfDate(dateStr: string): string | undefined {
  const m = dateStr.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!m) return undefined
  const [, year, month = "01", day = "01", hour = "00", min = "00", sec = "00"] = m
  return `${year}-${month}-${day}T${hour}:${min}:${sec}`
}

/** 메타데이터만 추출 (전체 파싱 없이) — MCP parse_metadata용 */
export async function extractPdfMetadataOnly(buffer: ArrayBuffer): Promise<DocumentMetadata> {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise

  try {
    const metadata: DocumentMetadata = { pageCount: doc.numPages }
    await extractPdfMetadata(doc, metadata)
    return metadata
  } finally {
    await doc.destroy().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════
// 페이지 콘텐츠 추출 (열 경계 학습 기반 테이블 감지)
// ═══════════════════════════════════════════════════════

function extractPageContent(rawItems: PdfTextItem[]): string {
  const items = normalizeItems(rawItems)
  if (items.length === 0) return ""

  const yLines = groupByY(items)
  const columns = detectColumns(yLines)

  if (columns && columns.length >= 3) {
    return extractWithColumns(yLines, columns)
  }

  // 테이블 없으면 기존 방식
  return yLines.map(line => mergeLineSimple(line)).join("\n")
}

function normalizeItems(rawItems: PdfTextItem[]): NormItem[] {
  return rawItems
    .filter(i => typeof i.str === "string" && i.str.trim() !== "")
    .map(i => ({
      text: i.str.trim(),
      x: Math.round(i.transform[4]),
      y: Math.round(i.transform[5]),
      w: Math.round(i.width),
      h: Math.round(i.height),
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x)
}

function groupByY(items: NormItem[]): NormItem[][] {
  if (items.length === 0) return []
  const lines: NormItem[][] = []
  let curY = items[0].y
  let curLine: NormItem[] = [items[0]]

  for (let i = 1; i < items.length; i++) {
    // Y좌표 허용 오차 3px — PDF 렌더링 미세 오차 보정, 별표 행 경계 감지에 최적화된 값
    if (Math.abs(items[i].y - curY) > 3) {
      lines.push(curLine)
      curLine = []
      curY = items[i].y
    }
    curLine.push(items[i])
  }
  if (curLine.length > 0) lines.push(curLine)
  return lines
}

// ═══════════════════════════════════════════════════════
// 열 경계 감지 — 빈도 기반 x-히스토그램 클러스터링
// ═══════════════════════════════════════════════════════

/** prose 라인 판별: 아이템 간 gap이 모두 작으면 문장 (단어 나열) */
function isProseSpread(items: NormItem[]): boolean {
  if (items.length < 4) return false
  const sorted = [...items].sort((a, b) => a.x - b.x)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w))
  }
  // gap의 최대값이 작고 평균 단어 길이가 짧으면 prose
  const maxGap = Math.max(...gaps)
  const avgLen = items.reduce((s, i) => s + i.text.length, 0) / items.length
  // 짧은 단어들이 좁은 간격으로 나열 = prose (예: "위 표 제3호나목에서 남은 유효기간...")
  return maxGap < 40 && avgLen < 5
}

function detectColumns(yLines: NormItem[][]): number[] | null {
  const allItems = yLines.flat()
  if (allItems.length === 0) return null
  const pageWidth = Math.max(...allItems.map(i => i.x + i.w)) - Math.min(...allItems.map(i => i.x))
  if (pageWidth < 100) return null

  // "비고" 이전 아이템만 사용 (비고 이후는 prose)
  let bigoLineIdx = -1
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some(item => item.text === "비고")) {
      bigoLineIdx = i
      break
    }
  }
  const tableYLines = bigoLineIdx >= 0 ? yLines.slice(0, bigoLineIdx) : yLines

  // Step 1: 모든 아이템의 x를 수집 (prose 라인 제외)
  // CLUSTER_TOL 22px — 한국 공문서 PDF 열 간격에 최적화, 별표 표 열 감지 핵심값
  const CLUSTER_TOL = 22
  const xClusters: { center: number; count: number; minX: number }[] = []

  for (const line of tableYLines) {
    if (isProseSpread(line)) continue
    for (const item of line) {
      let found = false
      for (const c of xClusters) {
        if (Math.abs(item.x - c.center) <= CLUSTER_TOL) {
          c.center = Math.round((c.center * c.count + item.x) / (c.count + 1))
          c.minX = Math.min(c.minX, item.x)
          c.count++
          found = true
          break
        }
      }
      if (!found) {
        xClusters.push({ center: item.x, count: 1, minX: item.x })
      }
    }
  }

  // Step 2: 빈도 피크 — 최소 3회 이상 등장 (단발성 텍스트 노이즈 제거)
  const peaks = xClusters
    .filter(c => c.count >= 3)
    .sort((a, b) => a.minX - b.minX)

  // 최소 3개 열이 있어야 테이블로 판별 — 2열은 일반 2단 레이아웃과 구분 불가
  if (peaks.length < 3) return null

  // Step 3: 가까운 피크 병합 — MERGE_TOL 30px (같은 논리 열의 미세 위치 차이 흡수)
  const MERGE_TOL = 30
  const merged: { center: number; count: number; minX: number }[] = [peaks[0]]
  for (let i = 1; i < peaks.length; i++) {
    const prev = merged[merged.length - 1]
    if (peaks[i].minX - prev.minX < MERGE_TOL) {
      // 빈도 높은 쪽 유지, 최소 x는 작은 값
      if (peaks[i].count > prev.count) {
        prev.center = peaks[i].center
      }
      prev.count += peaks[i].count
      prev.minX = Math.min(prev.minX, peaks[i].minX)
    } else {
      merged.push({ ...peaks[i] })
    }
  }

  // 열 경계 = 각 클러스터의 minX (왼쪽 정렬 기준), 병합 후 재검증
  const columns = merged.filter(c => c.count >= 3).map(c => c.minX)
  return columns.length >= 3 ? columns : null
}

function findColumn(x: number, columns: number[]): number {
  for (let i = columns.length - 1; i >= 0; i--) {
    // 10px 왼쪽 허용 오차 — 셀 내 텍스트 미세 좌측 이탈 보정
    if (x >= columns[i] - 10) return i
  }
  return 0
}

// ═══════════════════════════════════════════════════════
// 열 기반 추출 — 테이블/텍스트 영역 분리
// ═══════════════════════════════════════════════════════

function extractWithColumns(yLines: NormItem[][], columns: number[]): string {
  const result: string[] = []
  const colMin = columns[0]
  const colMax = columns[columns.length - 1]

  // "비고" 라인 감지 — 이후는 텍스트로 처리
  let bigoIdx = -1
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some(item => item.text === "비고")) {
      bigoIdx = i
      break
    }
  }

  // 테이블 시작: 첫 번째 다열(3+ 열 사용) 라인
  let tableStart = -1
  for (let i = 0; i < (bigoIdx >= 0 ? bigoIdx : yLines.length); i++) {
    const usedCols = new Set(yLines[i].map(item => findColumn(item.x, columns)))
    if (usedCols.size >= 3) {
      tableStart = i
      break
    }
  }

  const tableEnd = bigoIdx >= 0 ? bigoIdx : yLines.length

  // 테이블 시작 이전 = 텍스트
  for (let i = 0; i < (tableStart >= 0 ? tableStart : tableEnd); i++) {
    result.push(mergeLineSimple(yLines[i]))
  }

  // 테이블 영역: 모든 라인을 그리드에 포함 (단일 아이템 라인도)
  if (tableStart >= 0) {
    const tableLines = yLines.slice(tableStart, tableEnd)
    // 테이블 x범위 밖의 라인만 텍스트로 분리
    // 좌측 20px, 우측 200px 허용 — 비고/주석 열이 오른쪽에 넓게 위치하는 공문서 특성 반영
    const gridLines: NormItem[][] = []
    for (const line of tableLines) {
      const inRange = line.some(item =>
        item.x >= colMin - 20 && item.x <= colMax + 200
      )
      if (inRange && !isProseSpread(line)) {
        gridLines.push(line)
      } else {
        // 그리드 밖 라인은 현재까지 축적된 그리드 출력 후 텍스트로
        if (gridLines.length > 0) {
          result.push(buildGridTable(gridLines.splice(0), columns))
        }
        result.push(mergeLineSimple(line))
      }
    }
    if (gridLines.length > 0) {
      result.push(buildGridTable(gridLines, columns))
    }
  }

  // 비고 영역
  if (bigoIdx >= 0) {
    result.push("")
    for (let i = bigoIdx; i < yLines.length; i++) {
      result.push(mergeLineSimple(yLines[i]))
    }
  }

  return result.join("\n")
}

// ═══════════════════════════════════════════════════════
// 그리드 테이블 빌더 — y-라인을 열에 배치 후 행 병합
// ═══════════════════════════════════════════════════════

function buildGridTable(lines: NormItem[][], columns: number[]): string {
  const numCols = columns.length

  // Step 1: 각 y-라인을 열에 배치
  const yRows: string[][] = lines.map(items => {
    const row = Array(numCols).fill("")
    for (const item of items) {
      const col = findColumn(item.x, columns)
      row[col] = row[col] ? row[col] + " " + item.text : item.text
    }
    return row
  })

  // Step 2: 행 병합 — 새 논리적 행 판별
  // 데이터 열 기준점 (가격 등이 들어가는 오른쪽 열들)
  const dataColStart = Math.max(2, Math.floor(numCols / 2))
  const merged: string[][] = []

  for (const row of yRows) {
    if (row.every(c => c === "")) continue

    if (merged.length === 0) {
      merged.push([...row])
      continue
    }

    const prev = merged[merged.length - 1]
    const filledCols = row.map((c, i) => c ? i : -1).filter(i => i >= 0)
    const filledCount = filledCols.length

    let isNewRow = false

    // Rule 1: col 0에 텍스트 (3글자 이상) → 새 행 (단, "권"처럼 짧은 건 continuation)
    if (row[0] && row[0].length >= 3) {
      isNewRow = true
    }

    // Rule 2: col 1에 텍스트 → 항상 새 행 (새 항목 시작)
    if (!isNewRow && numCols > 1 && row[1]) {
      isNewRow = true
    }

    // Rule 3: 데이터 열(3+)에 새 값이 있고 이전 행 데이터 열에도 이미 값 있음 → 새 가격 행
    if (!isNewRow) {
      const hasData = row.slice(dataColStart).some(c => c !== "")
      const prevHasData = prev.slice(dataColStart).some(c => c !== "")
      if (hasData && prevHasData) {
        isNewRow = true
      }
    }

    // Exception: filledCount=1이고 col 0에 짧은 텍스트(≤2자) → word continuation (예: "권", "여권")
    if (isNewRow && filledCount === 1 && row[0] && row[0].length <= 2) {
      isNewRow = false
    }

    if (isNewRow) {
      merged.push([...row])
    } else {
      for (let c = 0; c < numCols; c++) {
        if (row[c]) {
          prev[c] = prev[c] ? prev[c] + " " + row[c] : row[c]
        }
      }
    }
  }

  if (merged.length < 2) {
    return merged.map(r => r.filter(c => c).join(" ")).join("\n")
  }

  // Step 3: 헤더 행 병합 — 첫 N행이 모두 데이터열(dataColStart+)에 값이 없으면 헤더
  let headerEnd = 0
  for (let r = 0; r < merged.length; r++) {
    const hasDataValues = merged[r].slice(dataColStart).some(c => c && /\d/.test(c))
    if (hasDataValues) break
    headerEnd = r + 1
  }

  if (headerEnd > 1) {
    // 헤더 행들을 하나로 합침
    const headerRow = Array(numCols).fill("")
    for (let r = 0; r < headerEnd; r++) {
      for (let c = 0; c < numCols; c++) {
        if (merged[r][c]) {
          headerRow[c] = headerRow[c] ? headerRow[c] + " " + merged[r][c] : merged[r][c]
        }
      }
    }
    merged.splice(0, headerEnd, headerRow)
  }

  // Step 4: 마크다운 테이블
  const md: string[] = []
  md.push("| " + merged[0].join(" | ") + " |")
  md.push("| " + merged[0].map(() => "---").join(" | ") + " |")
  for (let r = 1; r < merged.length; r++) {
    md.push("| " + merged[r].join(" | ") + " |")
  }
  return md.join("\n")
}

// ═══════════════════════════════════════════════════════
// 유틸
// ═══════════════════════════════════════════════════════

function mergeLineSimple(items: NormItem[]): string {
  if (items.length <= 1) return items[0]?.text || ""
  const sorted = [...items].sort((a, b) => a.x - b.x)
  let result = sorted[0].text
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)
    // 15px+ 갭 = 탭 (열 구분), 3px+ 갭 = 공백 (단어 구분)
    if (gap > 15) result += "\t"
    else if (gap > 3) result += " "
    result += sorted[i].text
  }
  return result
}

export function cleanPdfText(text: string): string {
  return mergeKoreanLines(
    text
      .replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "")
      .replace(/^\s*\d+\s*\/\s*\d+\s*$/gm, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function startsWithMarker(line: string): boolean {
  const t = line.trimStart()
  return /^[가-힣ㄱ-ㅎ][.)]/.test(t) || /^\d+[.)]/.test(t) || /^\([가-힣ㄱ-ㅎ\d]+\)/.test(t) ||
    /^[○●※▶▷◆◇■□★☆\-·]\s/.test(t) || /^제\d+[조항호장절]/.test(t)
}

function isStandaloneHeader(line: string): boolean {
  return /^제\d+[조항호장절](\([^)]*\))?(\s+\S+){0,7}$/.test(line.trim())
}

function mergeKoreanLines(text: string): string {
  if (!text) return ""
  const lines = text.split("\n")
  if (lines.length <= 1) return text
  const result: string[] = [lines[0]]

  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1]
    const curr = lines[i]
    if (/[가-힣·,\-]$/.test(prev) && /^[가-힣(]/.test(curr) && !startsWithMarker(curr) && !isStandaloneHeader(prev)) {
      result[result.length - 1] = prev + " " + curr
    } else {
      result.push(curr)
    }
  }
  return result.join("\n")
}

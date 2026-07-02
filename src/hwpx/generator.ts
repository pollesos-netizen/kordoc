/**
 * Markdown → HWPX 역변환
 *
 * 지원: 헤딩(h1~h6), 단락, 볼드, 이탤릭, 인라인코드, 코드블록,
 *       순서/비순서 리스트, 수평선, 인용문, 테이블
 * jszip으로 HWPX ZIP 패키징.
 */

import JSZip from "jszip"
import {
  type GongmunOptions,
  type ResolvedGongmun,
  resolveGongmun,
  GongmunNumberer,
  computeSuppression,
  levelIndent,
  mmToHwpunit,
} from "./gongmun.js"
import { fitRatioForFewerLines } from "./text-metrics.js"
import { parseHtmlTable, htmlCellInnerToLines, extractTopLevelTables, type HtmlRowInfo } from "../roundtrip/markdown-units.js"

const NS_SECTION = "http://www.hancom.co.kr/hwpml/2011/section"
const NS_PARA = "http://www.hancom.co.kr/hwpml/2011/paragraph"
const NS_HEAD = "http://www.hancom.co.kr/hwpml/2011/head"
const NS_CORE = "http://www.hancom.co.kr/hwpml/2011/core"
const NS_OPF = "http://www.idpf.org/2007/opf/"
const NS_HPF = "http://www.hancom.co.kr/schema/2011/hpf"
const NS_OCF = "urn:oasis:names:tc:opendocument:xmlns:container"

// ─── 스타일 ID 매핑 ─────────────────────────────────
// charPr: 0=본문, 1=볼드, 2=이탤릭, 3=볼드이탤릭, 4=인라인코드, 5=h1, 6=h2, 7=h3, 8=h4~h6, 9=표 헤더 셀, 10=인용문
// paraPr: 0=본문, 1=h1, 2=h2, 3=h3, 4=h4~h6, 5=코드블록, 6=인용문, 7=리스트

const CHAR_NORMAL = 0
const CHAR_BOLD = 1
const CHAR_ITALIC = 2
const CHAR_BOLD_ITALIC = 3
const CHAR_CODE = 4
const CHAR_H1 = 5
const CHAR_H2 = 6
const CHAR_H3 = 7
const CHAR_H4 = 8
const CHAR_TABLE_HEADER = 9
const CHAR_QUOTE = 10

const PARA_NORMAL = 0
const PARA_H1 = 1
const PARA_H2 = 2
const PARA_H3 = 3
const PARA_H4 = 4
const PARA_CODE = 5
const PARA_QUOTE = 6
const PARA_LIST = 7

/** HWPX 생성 시 적용할 시각 테마 (모두 선택) */
export interface HwpxTheme {
  /**
   * 헤딩 레벨별 텍스트 색상. 미지정 시 검정.
   * 현재 charPr 매핑은 h1/h2/h3/h4 4단계 (h5, h6은 h4와 같은 charPr 공유)이므로
   * 키는 1~4만 받는다.
   */
  headingColors?: Partial<Record<1 | 2 | 3 | 4, string>>
  /** 본문 단락 텍스트 색상. 미지정 시 검정 */
  bodyColor?: string
  /**
   * 인용문 텍스트 색상. 미지정 시 검정.
   *
   * 주의: 이 옵션을 지정하면 인용문이 별도 charPr(이탤릭)로 렌더링된다.
   * 미지정 시 기존 동작 그대로 본문 charPr로 렌더링 (이탤릭 아님).
   */
  quoteColor?: string
  /** 표 첫 행 텍스트 색상. 미지정 시 본문과 동일 */
  tableHeaderColor?: string
  /** 표 첫 행 텍스트를 굵게 표시 (기본 false) */
  tableHeaderBold?: boolean
}

/** markdownToHwpx 옵션 */
export interface MarkdownToHwpxOptions {
  theme?: HwpxTheme
  /**
   * 공문서 모드 — 지정 시 한국 행정 공문서 표준 서식으로 렌더링한다.
   * (공식 여백, 명조 15pt 본문, 항목부호 8단계 행갈굼 정렬, 줄간격 등)
   * 미지정 시 기존 범용 마크다운 변환 동작 그대로 유지.
   */
  gongmun?: GongmunOptions
}

const DEFAULT_TEXT_COLOR = "#000000"

function resolveTheme(theme?: HwpxTheme) {
  return {
    h1: theme?.headingColors?.[1] ?? DEFAULT_TEXT_COLOR,
    h2: theme?.headingColors?.[2] ?? DEFAULT_TEXT_COLOR,
    h3: theme?.headingColors?.[3] ?? DEFAULT_TEXT_COLOR,
    h4: theme?.headingColors?.[4] ?? theme?.headingColors?.[3] ?? DEFAULT_TEXT_COLOR,
    body: theme?.bodyColor ?? DEFAULT_TEXT_COLOR,
    quote: theme?.quoteColor ?? DEFAULT_TEXT_COLOR,
    /** quoteColor가 명시되었는지 — blockquote charPr 분기에 사용 (baseline 호환) */
    hasQuoteOption: theme?.quoteColor !== undefined,
    tableHeader: theme?.tableHeaderColor ?? theme?.bodyColor ?? DEFAULT_TEXT_COLOR,
    tableHeaderBold: !!theme?.tableHeaderBold,
  }
}

type ResolvedTheme = ReturnType<typeof resolveTheme>

/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 */
export async function markdownToHwpx(
  markdown: string,
  options?: MarkdownToHwpxOptions,
): Promise<ArrayBuffer> {
  const theme = resolveTheme(options?.theme)
  const gongmun = options?.gongmun ? resolveGongmun(options.gongmun) : null
  const blocks = parseMarkdownToBlocks(markdown)
  const gongmunList = gongmun ? precomputeGongmunList(blocks, gongmun) : null
  const fit = gongmun && gongmunList ? computeGongmunFitPlan(blocks, gongmun, gongmunList) : null
  const sectionXml = blocksToSectionXml(blocks, theme, gongmun, gongmunList, fit)

  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
  zip.file("META-INF/container.xml", generateContainerXml())
  zip.file("Contents/content.hpf", generateManifest())
  zip.file("Contents/header.xml", generateHeaderXml(theme, gongmun, fit?.variants ?? []))
  zip.file("Contents/section0.xml", sectionXml)
  // Preview/ — 한글 프로그램의 일부 버전(특히 macOS)이 존재 여부를 확인함
  zip.file("Preview/PrvText.txt", buildPrvText(blocks))

  return await zip.generateAsync({ type: "arraybuffer" })
}

/** Preview/PrvText.txt — 문서 앞부분 텍스트 스냅샷 (최대 1KB) */
function buildPrvText(blocks: MdBlock[]): string {
  const lines: string[] = []
  let bytes = 0
  for (const b of blocks) {
    let text = b.text || (b.rows ? b.rows.map(r => r.join(" ")).join("\n") : "")
    if (b.type === "html_table") text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (!text) continue
    lines.push(text)
    bytes += text.length * 3
    if (bytes > 1024) break
  }
  return lines.join("\n").slice(0, 1024)
}

// ─── 마크다운 파싱 ───────────────────────────────────

interface MdBlock {
  type: "paragraph" | "heading" | "table" | "html_table" | "code_block" | "hr" | "blockquote" | "list_item"
  text?: string
  level?: number
  rows?: string[][]
  lang?: string
  ordered?: boolean
  indent?: number
}

function parseMarkdownToBlocks(md: string): MdBlock[] {
  const lines = md.split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue }

    // 코드블록
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      const lang = fenceMatch[2].trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // 닫는 fence
      blocks.push({ type: "code_block", text: codeLines.join("\n"), lang })
      continue
    }

    // 수평선
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" })
      i++; continue
    }

    // 헤딩
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: "heading", text: headingMatch[2].trim(), level: headingMatch[1].length })
      i++; continue
    }

    // HTML 표 (병합·중첩 — kordoc parse가 병합/중첩표를 내보내는 형식)
    if (/^<table[\s>]/i.test(line.trimStart())) {
      const htmlLines: string[] = []
      let depth = 0
      while (i < lines.length) {
        const l = lines[i]
        htmlLines.push(l)
        depth += (l.match(/<table[\s>]/gi) ?? []).length
        depth -= (l.match(/<\/table>/gi) ?? []).length
        i++
        if (depth <= 0) break
      }
      blocks.push({ type: "html_table", text: htmlLines.join("\n") })
      continue
    }

    // 테이블
    if (line.trimStart().startsWith("|")) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = lines[i]
        if (/^[\s|:\-]+$/.test(row)) { i++; continue }
        const cells = row.split("|").slice(1, -1).map(c => c.trim())
        if (cells.length > 0) tableRows.push(cells)
        i++
      }
      if (tableRows.length > 0) blocks.push({ type: "table", rows: tableRows })
      continue
    }

    // 인용문
    if (line.trimStart().startsWith("> ")) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i].trimStart().startsWith("> ") || lines[i].trimStart().startsWith(">"))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""))
        i++
      }
      for (const ql of quoteLines) {
        blocks.push({ type: "blockquote", text: ql.trim() || "" })
      }
      continue
    }

    // 리스트
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)]) (.+)$/)
    if (listMatch) {
      const indent = Math.floor(listMatch[1].length / 2)
      const ordered = /\d/.test(listMatch[2])
      blocks.push({ type: "list_item", text: listMatch[3].trim(), ordered, indent })
      i++; continue
    }

    // 일반 단락
    blocks.push({ type: "paragraph", text: line.trim() })
    i++
  }

  return blocks
}

// ─── 인라인 마크다운 → 멀티 run ─────────────────────

interface InlineSpan {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
}

function parseInlineMarkdown(text: string): InlineSpan[] {
  // 전처리: 마크다운 링크/이미지 → 텍스트만 추출
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")   // ![alt](url) → alt
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t, u) => t || u) // [text](url) → text or url
  // 전처리: ~~취소선~~ → 텍스트만
  text = text.replace(/~~([^~]+)~~/g, "$1")

  const spans: InlineSpan[] = []
  // 패턴: `code`, ***bolditalic***, **bold**, *italic*, __bold__, _italic_
  const regex = /(`[^`]+`|\*{3}[^*]+\*{3}|\*{2}[^*]+\*{2}|\*[^*]+\*|_{2}[^_]+_{2}|_[^_]+_)/g
  let lastIdx = 0

  for (const match of text.matchAll(regex)) {
    const idx = match.index!
    if (idx > lastIdx) {
      spans.push({ text: text.slice(lastIdx, idx), bold: false, italic: false, code: false })
    }
    const raw = match[0]
    if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: false, code: true })
    } else if (raw.startsWith("***") || raw.startsWith("___")) {
      spans.push({ text: raw.slice(3, -3), bold: true, italic: true, code: false })
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      spans.push({ text: raw.slice(2, -2), bold: true, italic: false, code: false })
    } else {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: true, code: false })
    }
    lastIdx = idx + raw.length
  }
  if (lastIdx < text.length) {
    spans.push({ text: text.slice(lastIdx), bold: false, italic: false, code: false })
  }
  if (spans.length === 0) {
    spans.push({ text, bold: false, italic: false, code: false })
  }
  return spans
}

function spanToCharPrId(span: InlineSpan): number {
  if (span.code) return CHAR_CODE
  if (span.bold && span.italic) return CHAR_BOLD_ITALIC
  if (span.bold) return CHAR_BOLD
  if (span.italic) return CHAR_ITALIC
  return CHAR_NORMAL
}

// ─── XML 생성 헬퍼 ───────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function generateRuns(text: string, defaultCharPr: number = CHAR_NORMAL, mapCharId?: (id: number) => number): string {
  const spans = parseInlineMarkdown(text)
  return spans.map(span => {
    let charId = span.code || span.bold || span.italic ? spanToCharPrId(span) : defaultCharPr
    if (mapCharId) charId = mapCharId(charId)
    return `<hp:run charPrIDRef="${charId}"><hp:t>${escapeXml(span.text)}</hp:t></hp:run>`
  }).join("")
}

function generateParagraph(text: string, paraPrId: number = PARA_NORMAL, charPrId: number = CHAR_NORMAL, mapCharId?: (id: number) => number): string {
  if (paraPrId === PARA_CODE) {
    // 코드블록은 인라인 파싱 안 함
    return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
  }
  const runs = generateRuns(text, charPrId, mapCharId)
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0">${runs}</hp:p>`
}

function headingParaPrId(level: number): number {
  if (level === 1) return PARA_H1
  if (level === 2) return PARA_H2
  if (level === 3) return PARA_H3
  return PARA_H4
}

function headingCharPrId(level: number): number {
  if (level === 1) return CHAR_H1
  if (level === 2) return CHAR_H2
  if (level === 3) return CHAR_H3
  return CHAR_H4
}

// ─── HWPX 구조 파일 생성 ─────────────────────────────

function generateContainerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="${NS_OCF}" xmlns:hpf="${NS_HPF}">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </ocf:rootfiles>
</ocf:container>`
}

function generateManifest(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="${NS_OPF}" xmlns:hpf="${NS_HPF}" xmlns:hh="${NS_HEAD}">
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="no"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`
}

// ─── charPr 생성 헬퍼 ───────────────────────────────

function charPr(
  id: number,
  height: number,
  bold: boolean,
  italic: boolean,
  fontId: number = 0,
  textColor: string = DEFAULT_TEXT_COLOR,
  ratioPct: number = 100,
): string {
  const boldAttr = bold ? ` bold="1"` : ""
  const italicAttr = italic ? ` italic="1"` : ""
  // 볼드면 fontfaces의 bold variant(id=2: HY견고딕/Arial Black, weight=9) 참조해
  // macOS 한컴에서 합성 굵기 안 되는 케이스 커버. 코드(fontId=1)는 bold 아닌 경우에만
  // 원본 id 유지 (Consolas/함초롬돋움).
  const effFont = bold ? 2 : fontId
  // 장평(ratio): 공문서 본문은 95%로 가로 압축 — 한두 글자만 다음 줄로 넘어가는
  // orphan을 줄여 한 줄에 담는다(실제 공문서 관행). 한글·라틴만, 나머지는 100.
  return `      <hh:charPr id="${id}" height="${height}" textColor="${textColor}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"${boldAttr}${italicAttr}>
        <hh:fontRef hangul="${effFont}" latin="${effFont}" hanja="${effFont}" japanese="${effFont}" other="${effFont}" symbol="${effFont}" user="${effFont}"/>
        <hh:ratio hangul="${ratioPct}" latin="${ratioPct}" hanja="${ratioPct}" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>`
}

// ─── paraPr 생성 헬퍼 ───────────────────────────────

function paraPr(id: number, opts: { align?: string; spaceBefore?: number; spaceAfter?: number; lineSpacing?: number; indent?: number; left?: number; keepWord?: boolean } = {}): string {
  const { align = "JUSTIFY", spaceBefore = 0, spaceAfter = 0, lineSpacing = 160, indent = 0, left = 0, keepWord = false } = opts
  // keepWord=true면 한글도 어절(단어) 단위로만 줄바꿈 — 단어 중간에서 끊기지 않음.
  // 단, snapToGrid="1"(글자 격자 강제 정렬)이 켜져 있으면 한컴이 격자에 맞추려고
  // 어절을 깨버린다. 어절 단위 줄나눔에는 반드시 격자를 꺼야 한다(실제 공문서도 0).
  const breakNonLatin = keepWord ? "KEEP_WORD" : "BREAK_WORD"
  const snapGrid = keepWord ? "0" : "1"
  return `      <hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="${snapGrid}" suppressLineNumbers="0" checked="0" textDir="AUTO">
        <hh:align horizontal="${align}" vertical="BASELINE"/>
        <hh:heading type="NONE" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${breakNonLatin}" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        <hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${spaceBefore}" unit="HWPUNIT"/><hc:next value="${spaceAfter}" unit="HWPUNIT"/></hh:margin>
        <hh:lineSpacing type="PERCENT" value="${lineSpacing}"/>
        <hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>`
}

// ─── 공문서 모드 paraPr ID 매핑 ──────────────────────
// 공문서 모드에서는 기존 0~7 paraPr 뒤에 항목 단계별(8단계) paraPr를 추가한다.
// 단계 d(0~7) → paraPrIDRef = GONGMUN_LIST_BASE + d
const GONGMUN_LIST_BASE = 8
const GONGMUN_LIST_LEVELS = 8
// 본문 크기 가운데정렬 단락(발신명의 등) — 항목단계 paraPr 다음 id
const GONGMUN_CENTER = GONGMUN_LIST_BASE + GONGMUN_LIST_LEVELS

// ─── 공문서 자동 장평(orphan 축소) ───────────────────
// 기본 charPr 11종(0~10) 뒤에, 자동 장평이 필요한 문단용 변형 charPr를 붙인다.
// 변형 vi번째 장평 r → charPr id = CHAR_VARIANT_BASE + vi×4 + (0 본문|1 볼드|2 이탤릭|3 볼드이탤릭)
const CHAR_VARIANT_BASE = 11
/** 공문서 본문 기본 장평(%) — 실제 공문서 관행 (v3.5.3) */
const GONGMUN_BODY_RATIO = 95

interface GongmunFitPlan {
  /** blockIdx → 축소 장평(%) */
  ratioByBlock: Map<number, number>
  /** 등장한 고유 장평 목록(변형 charPr 발급 순서) */
  variants: number[]
}

/** 렌더될 문자열(마크다운 강조 문법 제거) — 폭 계산용 */
function plainRenderText(text: string): string {
  return parseInlineMarkdown(text).map(s => s.text).join("")
}

/**
 * 문단별 자동 장평 계획 — 어절 줄바꿈 시뮬레이션으로 "장평을 줄이면 한 줄을
 * 아낄 수 있는" 문단을 찾아 95→minRatio 범위의 가장 큰 장평을 배정한다.
 * 대상: 일반 문단·항목(list_item). 제목/가운데정렬/코드/인용/표는 제외.
 */
function computeGongmunFitPlan(
  blocks: MdBlock[],
  gongmun: ResolvedGongmun,
  gongmunList: Map<number, { marker: string; depth: number }>,
): GongmunFitPlan | null {
  const minRatio = gongmun.autoFitMinRatio
  if (minRatio === null || minRatio >= GONGMUN_BODY_RATIO) return null
  const pageW = 59528 - mmToHwpunit(gongmun.margins.left) - mmToHwpunit(gongmun.margins.right)
  const ratioByBlock = new Map<number, number>()
  const variants: number[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let text: string
    let firstW: number
    let contW: number
    if (block.type === "list_item" && gongmunList.has(i)) {
      const { marker, depth } = gongmunList.get(i)!
      const content = plainRenderText(block.text || "")
      text = marker ? `${marker} ${content}` : content
      const { left, indent } = levelIndent(depth, gongmun.bodyHeight, gongmun.numbering)
      // 음수 intent(내어쓰기): 첫 줄은 left에서, 둘째 줄부터 left+|intent|에서 시작
      firstW = pageW - left - Math.max(indent, 0)
      contW = pageW - left - Math.max(-indent, 0)
    } else if (block.type === "paragraph") {
      const raw = (block.text || "").trim()
      if (/^<center>[\s\S]*<\/center>$/i.test(raw)) continue // 가운데정렬 — 대상 아님
      text = plainRenderText(raw)
      firstW = contW = pageW
    } else {
      continue
    }
    if (!text) continue
    const r = fitRatioForFewerLines(text, firstW, contW, gongmun.bodyHeight, GONGMUN_BODY_RATIO, minRatio)
    if (r === null) continue
    ratioByBlock.set(i, r)
    if (!variants.includes(r)) variants.push(r)
  }
  return ratioByBlock.size > 0 ? { ratioByBlock, variants } : null
}

/** fit 계획에 따른 charPr id 매퍼 — 본문 계열(0~3)만 변형으로 치환 */
function variantMapper(fit: GongmunFitPlan, blockIdx: number): ((id: number) => number) | undefined {
  const r = fit.ratioByBlock.get(blockIdx)
  if (r === undefined) return undefined
  const vi = fit.variants.indexOf(r)
  return (id) => (id >= 0 && id <= 3 ? CHAR_VARIANT_BASE + vi * 4 + id : id)
}

/** charProperties 블록 생성 — 공문서 모드면 본문/제목 height를 표준값으로 */
function buildCharProperties(theme: ResolvedTheme, gongmun: ResolvedGongmun | null, ratioVariants: number[] = []): string {
  // 비공문서(기존 동작): 본문 10pt
  let body = 1000, code = 900, h1 = 1800, h2 = 1400, h3 = 1200, h4 = 1100
  if (gongmun) {
    body = gongmun.bodyHeight
    code = Math.max(body - 200, 900)
    h1 = gongmun.preset === "report" || gongmun.preset === "plan" ? 2000 : 1700
    h2 = 1600
    h3 = body
    h4 = Math.max(body - 100, 1300)
  }
  // 공문서 본문 장평 95%(orphan 압축). 비공문서·제목은 100 유지.
  const bodyRatio = gongmun ? GONGMUN_BODY_RATIO : 100
  const rows = [
    charPr(0, body, false, false, 0, theme.body, bodyRatio),
    charPr(1, body, true, false, 0, theme.body, bodyRatio),
    charPr(2, body, false, true, 0, theme.body, bodyRatio),
    charPr(3, body, true, true, 0, theme.body, bodyRatio),
    charPr(4, code, false, false, 1),
    charPr(5, h1, true, false, 1, theme.h1),
    charPr(6, h2, true, false, 1, theme.h2),
    charPr(7, h3, true, false, 1, theme.h3),
    charPr(8, h4, true, false, 1, theme.h4),
    charPr(CHAR_TABLE_HEADER, body, theme.tableHeaderBold, false, 0, theme.tableHeader),
    charPr(CHAR_QUOTE, body, false, true, 0, theme.quote),
  ]
  // 자동 장평 변형 — 본문 계열(0~3)의 장평만 바꾼 복제본
  for (const r of ratioVariants) {
    rows.push(
      charPr(rows.length, body, false, false, 0, theme.body, r),
      charPr(rows.length + 1, body, true, false, 0, theme.body, r),
      charPr(rows.length + 2, body, false, true, 0, theme.body, r),
      charPr(rows.length + 3, body, true, true, 0, theme.body, r),
    )
  }
  return `<hh:charProperties itemCnt="${rows.length}">\n${rows.join("\n")}\n    </hh:charProperties>`
}

/** paraProperties 블록 생성 — 공문서 모드면 본문 줄간격·제목 가운데 + 항목단계 8종 추가 */
function buildParaProperties(gongmun: ResolvedGongmun | null): string {
  if (!gongmun) {
    const base = [
      paraPr(0),
      paraPr(1, { align: "LEFT", spaceBefore: 800, spaceAfter: 200, lineSpacing: 180 }),
      paraPr(2, { align: "LEFT", spaceBefore: 600, spaceAfter: 150, lineSpacing: 170 }),
      paraPr(3, { align: "LEFT", spaceBefore: 400, spaceAfter: 100, lineSpacing: 160 }),
      paraPr(4, { align: "LEFT", spaceBefore: 300, spaceAfter: 100, lineSpacing: 160 }),
      paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400 }),
      paraPr(6, { align: "LEFT", lineSpacing: 150, indent: 600 }),
      paraPr(7, { align: "LEFT", lineSpacing: 160, indent: 600 }),
    ]
    return `<hh:paraProperties itemCnt="${base.length}">\n${base.join("\n")}\n    </hh:paraProperties>`
  }
  const ls = gongmun.lineSpacing
  const titleAlign = gongmun.centerTitle ? "CENTER" : "LEFT"
  // 공문서 모드 전 문단 어절 단위 줄바꿈(keepWord) — 한글이 단어 중간에서 끊기지 않음
  const base = [
    paraPr(0, { lineSpacing: ls, keepWord: true }),
    paraPr(1, { align: titleAlign, spaceBefore: 400, spaceAfter: 400, lineSpacing: ls, keepWord: true }),
    paraPr(2, { align: "LEFT", spaceBefore: 600, spaceAfter: 150, lineSpacing: ls, keepWord: true }),
    paraPr(3, { align: "LEFT", spaceBefore: 400, spaceAfter: 100, lineSpacing: ls, keepWord: true }),
    paraPr(4, { align: "LEFT", spaceBefore: 300, spaceAfter: 100, lineSpacing: ls, keepWord: true }),
    paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400, keepWord: true }),
    paraPr(6, { align: "LEFT", lineSpacing: ls, indent: 600, keepWord: true }),
    paraPr(7, { align: "LEFT", lineSpacing: ls, indent: 600, keepWord: true }),
  ]
  // 항목 단계별 paraPr (8 ~ 8+7): left/내어쓰기 indent
  for (let d = 0; d < GONGMUN_LIST_LEVELS; d++) {
    const { left, indent } = levelIndent(d, gongmun.bodyHeight, gongmun.numbering)
    // 보고서(□○-) 1단계 □ 앞에 단락 간격 — 정부 보고서의 섹션 구분 관행
    const sectionGap = gongmun.numbering === "report" && d === 0 ? Math.round(gongmun.bodyHeight * 0.5) : 0
    base.push(paraPr(GONGMUN_LIST_BASE + d, { align: "JUSTIFY", lineSpacing: ls, left, indent, spaceBefore: sectionGap, keepWord: true }))
  }
  // 가운데정렬 본문 단락(발신명의 등)
  base.push(paraPr(GONGMUN_CENTER, { align: "CENTER", lineSpacing: ls, keepWord: true }))
  return `<hh:paraProperties itemCnt="${base.length}">\n${base.join("\n")}\n    </hh:paraProperties>`
}

function generateHeaderXml(theme: ResolvedTheme, gongmun: ResolvedGongmun | null, ratioVariants: number[] = []): string {
  // 본문 한글 글꼴 (공문서 gothic 프리셋이면 맑은 고딕)
  const bodyFace = gongmun?.bodyFont === "gothic" ? "맑은 고딕" : "함초롬바탕"
  const charPropsXml = buildCharProperties(theme, gongmun, ratioVariants)
  const paraPropsXml = buildParaProperties(gongmun)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head xmlns:hh="${NS_HEAD}" xmlns:hp="${NS_PARA}" xmlns:hc="${NS_CORE}" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="7">
      <hh:fontface lang="HANGUL" fontCnt="3">
        <hh:font id="0" face="${bodyFace}" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="1" face="함초롬돋움" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="2" face="HY견고딕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="LATIN" fontCnt="3">
        <hh:font id="0" face="Times New Roman" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_OLDSTYLE" weight="5" proportion="4" contrast="2" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="4"/>
        </hh:font>
        <hh:font id="1" face="Consolas" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_MODERN" weight="5" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
        <hh:font id="2" face="Arial Black" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="HANJA" fontCnt="1">
        <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="JAPANESE" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="OTHER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="SYMBOL" fontCnt="1">
        <hh:font id="0" face="Symbol" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="USER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="2">
      <hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:topBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>
      </hh:borderFill>
      <hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>
      </hh:borderFill>
    </hh:borderFills>
    ${charPropsXml}
    <hh:tabProperties itemCnt="0"/>
    <hh:numberings itemCnt="0"/>
    <hh:bullets itemCnt="0"/>
    ${paraPropsXml}
    <hh:styles itemCnt="1">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langIDRef="1042" lockForm="0"/>
    </hh:styles>
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP2018"><hh:layoutCompatibility/></hh:compatibleDocument>
</hh:head>`
}

// ─── 섹션 속성 (공문서 표준 여백) ────────────────────

function generateSecPr(gongmun: ResolvedGongmun | null): string {
  // A4: 210mm × 297mm → 59528 × 84188 HWPUNIT (1mm ≈ 283.46 HWPUNIT)
  // 비공문서(기존): 위 30 / 아래 15 / 좌 20 / 우 15mm, 머리말·꼬리말 10mm.
  // 공문서 표준(편람 서식 작성방법 해설·시행규칙 별표4): 위 20 / 아래 10 / 좌 20 / 우 20mm,
  //   머리말·꼬리말·제본 0mm. (기존 위30 등은 권위 출처 없는 값이라 공문서 모드에서만 교체)
  const m = gongmun
    ? {
        top: mmToHwpunit(gongmun.margins.top),
        bottom: mmToHwpunit(gongmun.margins.bottom),
        left: mmToHwpunit(gongmun.margins.left),
        right: mmToHwpunit(gongmun.margins.right),
        header: 0,
        footer: 0,
      }
    : { top: 8504, bottom: 4252, left: 5670, right: 4252, header: 2835, footer: 2835 }
  return `<hp:secPr textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>` +
    `<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">` +
      `<hp:margin header="${m.header}" footer="${m.footer}" gutter="0" left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}"/>` +
    `</hp:pagePr>` +
    `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
  `</hp:secPr>`
}

// ─── 테이블 생성 ─────────────────────────────────────
//
// HWPX 스펙 완전 준수 버전 — 한글 프로그램(Windows/macOS)이 문서를 거부하지 않으려면
// <hp:tbl> 필수 속성 + <hp:sz>/<hp:pos>/<hp:outMargin>/<hp:inMargin> + 각 cell의
// <hp:subList> 래퍼, <hp:cellAddr>, <hp:cellSz>, <hp:cellMargin>이 전부 있어야 함.
// 또한 테이블은 paragraph 안의 <hp:run><hp:ctrl>... 로 감싸야 한다.
//
// 이슈 #4 참고: v2.4.1 이전엔 최소 스켈레톤만 내서 macOS 한글이 "파일이 깨졌다"며 거부.

// 기본 셀 크기 (HWPUnit) — A4 기준 적당한 기본값
const TABLE_ID_BASE = 1000
let tableIdCounter = TABLE_ID_BASE
function nextTableId(): number { return ++tableIdCounter }

function generateTable(rows: string[][], theme: ResolvedTheme): string {
  const rowCnt = rows.length
  const colCnt = Math.max(...rows.map(r => r.length), 1)
  // A4 portrait: 폭 약 44000 HWPUnit 사용 가능 → colCnt로 균등 분배
  const cellW = Math.floor(44000 / colCnt)
  const cellH = 1500  // 기본 행 높이
  const tblW = cellW * colCnt
  const tblH = cellH * rowCnt

  const tblId = nextTableId()

  // theme.tableHeaderColor 또는 tableHeaderBold가 설정되면 첫 행 셀에 별도 charPr 사용
  const useHeaderStyle =
    theme.tableHeader !== theme.body || theme.tableHeaderBold

  const trElements = rows.map((row, rowIdx) => {
    // 부족한 셀은 빈 문자열로 채워 colCnt 맞춤
    const cells = row.length < colCnt ? [...row, ...Array(colCnt - row.length).fill("")] : row
    const isHeaderRow = rowIdx === 0
    const headerCharPr = isHeaderRow && useHeaderStyle ? CHAR_TABLE_HEADER : CHAR_NORMAL
    const tdElements = cells.map((cell, colIdx) => {
      const runs = generateRuns(cell, headerCharPr)
      const p = `<hp:p paraPrIDRef="0" styleIDRef="0">${runs}</hp:p>`
      // <hp:tc> 필수 속성 + subList + cellAddr + cellSpan + cellSz + cellMargin
      return `<hp:tc name="" header="${isHeaderRow ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="2">`
        + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${p}</hp:subList>`
        + `<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`
        + `<hp:cellSpan colSpan="1" rowSpan="1"/>`
        + `<hp:cellSz width="${cellW}" height="${cellH}"/>`
        + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
        + `</hp:tc>`
    }).join("")
    return `<hp:tr>${tdElements}</hp:tr>`
  }).join("")

  // <hp:tbl>에 필수 속성 + <hp:sz>/<hp:outMargin>/<hp:inMargin> (pos는 inline-level 기준)
  const tblInner = `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tblH}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>`
    + trElements

  const tbl = `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="2" noShading="0">${tblInner}</hp:tbl>`

  // 테이블은 paragraph 안의 run → 가 아니라 별도 p로 감쌈 (block-level inline-anchored)
  return `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
}

// ─── HTML 표 생성 (병합셀 colspan/rowspan + 중첩표 재귀) ───
//
// kordoc parse는 병합/중첩표를 <table><tr><th|td colspan rowspan>…</table> HTML로
// 내보낸다. 그 출력을 다시 HWPX로 만들 때 구조를 보존한다 — parse → 편집 →
// markdownToHwpx 라운드트립의 표 구멍을 막는 경로.

interface PlacedHtmlCell {
  r: number
  c: number
  colSpan: number
  rowSpan: number
  inner: string
  isHeader: boolean
}

/** HTML 행 목록 → 그리드 배치 (colspan/rowspan 점유 반영) */
function layoutHtmlRows(rows: HtmlRowInfo[]): { placed: PlacedHtmlCell[]; rowCnt: number; colCnt: number } {
  const occupied = new Set<string>()
  const placed: PlacedHtmlCell[] = []
  let colCnt = 0
  for (let r = 0; r < rows.length; r++) {
    let c = 0
    for (const cell of rows[r].cells) {
      while (occupied.has(`${r},${c}`)) c++
      const colSpan = Math.max(1, cell.colSpan)
      const rowSpan = Math.max(1, cell.rowSpan)
      placed.push({ r, c, colSpan, rowSpan, inner: cell.inner, isHeader: rows[r].tag === "th" })
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) occupied.add(`${r + dr},${c + dc}`)
      }
      c += colSpan
      colCnt = Math.max(colCnt, c)
    }
  }
  return { placed, rowCnt: rows.length, colCnt }
}

/** HTML 엔티티 복원 (sanitizeText 이스케이프의 역변환) — &amp;는 마지막에 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * HTML 표 원문 → <hp:tbl> XML. 병합셀은 cellSpan/cellAddr로, 셀 안 중첩표는
 * subList 안에 재귀 생성한다. 파싱 불가면 null (호출부가 문단 폴백).
 * @param totalWidth 표 전체 폭(HWPUNIT) — 중첩표는 부모 셀폭에 맞춰 축소
 */
function generateHtmlTableXml(rawHtml: string, theme: ResolvedTheme, totalWidth: number = 44000): string | null {
  const rows = parseHtmlTable(rawHtml)
  if (!rows || rows.length === 0) return null
  const { placed, rowCnt, colCnt } = layoutHtmlRows(rows)
  if (rowCnt === 0 || colCnt === 0) return null

  const colW = Math.floor(totalWidth / colCnt)
  const cellH = 1500
  const tblW = colW * colCnt
  const tblId = nextTableId()
  const useHeaderStyle = theme.tableHeader !== theme.body || theme.tableHeaderBold

  const tcXmls = placed.map(cell => {
    const headerCharPr = cell.isHeader && useHeaderStyle ? CHAR_TABLE_HEADER : CHAR_NORMAL
    const { lines } = htmlCellInnerToLines(cell.inner)
    const paras: string[] = lines.map(line =>
      `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${headerCharPr}"><hp:t>${escapeXml(unescapeHtml(line))}</hp:t></hp:run></hp:p>`,
    )
    // 중첩표 — 셀폭(마진 제외)에 맞춰 재귀 생성. 셀 높이는 중첩표만큼 키움
    // (한컴은 자동 확장하지만 초기 높이가 맞아야 다른 뷰어에서도 안 잘림)
    let nestedH = 0
    for (const nested of extractTopLevelTables(cell.inner)) {
      const nestedXml = generateHtmlTableXml(nested, theme, Math.max(colW * cell.colSpan - 1020, 4000))
      if (nestedXml) {
        paras.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${nestedXml}</hp:run></hp:p>`)
        nestedH += ((nested.match(/<tr[\s>]/gi) ?? []).length) * cellH + 300
      }
    }
    if (paras.length === 0) {
      paras.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${headerCharPr}"><hp:t></hp:t></hp:run></hp:p>`)
    }
    const cellHeight = Math.max(cellH * cell.rowSpan, Math.max(lines.length, 1) * 800 + nestedH)
    return `<hp:tc name="" header="${cell.isHeader ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="2">`
      + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras.join("")}</hp:subList>`
      + `<hp:cellAddr colAddr="${cell.c}" rowAddr="${cell.r}"/>`
      + `<hp:cellSpan colSpan="${cell.colSpan}" rowSpan="${cell.rowSpan}"/>`
      + `<hp:cellSz width="${colW * cell.colSpan}" height="${cellHeight}"/>`
      + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
      + `</hp:tc>`
  })

  // 행별로 tr 묶기 (placed는 행 순서 유지)
  const trXmls: string[] = []
  for (let r = 0; r < rowCnt; r++) {
    const rowTcs = tcXmls.filter((_, i) => placed[i].r === r)
    trXmls.push(`<hp:tr>${rowTcs.join("")}</hp:tr>`)
  }

  return `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="2" noShading="0">`
    + `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${cellH * rowCnt}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>`
    + trXmls.join("")
    + `</hp:tbl>`
}

// ─── 섹션 XML 생성 ──────────────────────────────────

/**
 * 공문서 모드 리스트 사전 처리 — 연속된 list_item run마다 단계별 부호 산출 +
 * 단일 형제 부호 생략. block 인덱스 → {marker, depth} 매핑 반환.
 */
function precomputeGongmunList(
  blocks: MdBlock[],
  gongmun: ResolvedGongmun,
): Map<number, { marker: string; depth: number }> {
  const result = new Map<number, { marker: string; depth: number }>()
  let i = 0
  while (i < blocks.length) {
    if (blocks[i].type !== "list_item") { i++; continue }
    // 연속 run 수집 — 항목 사이에 낀 표는 run을 끊지 않는다 (공문 관행: 항목 아래
    // 근거 표를 붙이고 다음 항목 번호가 이어짐). 표 뒤에 항목이 없으면 거기서 종료.
    const run: number[] = []
    while (i < blocks.length) {
      const t = blocks[i].type
      if (t === "list_item") { run.push(i); i++; continue }
      if (t === "table" || t === "html_table") {
        let j = i + 1
        while (j < blocks.length && (blocks[j].type === "table" || blocks[j].type === "html_table")) j++
        if (j < blocks.length && blocks[j].type === "list_item") { i = j; continue }
      }
      break
    }
    const depths = run.map((bi) => Math.min(Math.max(blocks[bi].indent || 0, 0), GONGMUN_LIST_LEVELS - 1))
    // 단일 형제 부호 생략은 법정 번호(standard)에만. 불릿(report)은 항상 표시.
    const suppress = gongmun.numbering === "standard"
      ? computeSuppression(depths)
      : depths.map(() => false)
    const numberer = new GongmunNumberer(gongmun.numbering)
    run.forEach((bi, k) => {
      const marker = numberer.next(depths[k], suppress[k])
      result.set(bi, { marker, depth: depths[k] })
    })
  }
  return result
}

function blocksToSectionXml(
  blocks: MdBlock[],
  theme: ResolvedTheme,
  gongmun: ResolvedGongmun | null,
  gongmunList: Map<number, { marker: string; depth: number }> | null = gongmun ? precomputeGongmunList(blocks, gongmun) : null,
  fit: GongmunFitPlan | null = null,
): string {
  const paraXmls: string[] = []
  let isFirst = true
  // 순서 있는 목록 카운터 — indent 레벨별 별도 유지. 다른 블록 만나면 해당 레벨 리셋.
  const orderedCounters: Record<number, number> = {}
  let prevWasOrdered = false

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx]
    let xml = ""

    // 순서 있는 list_item이 아니면 카운터 전부 리셋 (연속되지 않은 목록은 다시 1부터)
    if (block.type !== "list_item" || !block.ordered) {
      if (prevWasOrdered) {
        for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
      }
      prevWasOrdered = false
    }

    switch (block.type) {
      case "heading": {
        const pId = headingParaPrId(block.level || 1)
        const cId = headingCharPrId(block.level || 1)
        xml = generateParagraph(block.text || "", pId, cId)
        break
      }
      case "paragraph": {
        // 공문서 모드: <center>…</center> → 가운데 정렬 (행정기관명·발신명의)
        const ctr = gongmun && /^<center>([\s\S]*)<\/center>$/i.exec((block.text || "").trim())
        if (ctr) {
          xml = generateParagraph(ctr[1].trim(), GONGMUN_CENTER)
        } else {
          xml = generateParagraph(block.text || "", PARA_NORMAL, CHAR_NORMAL, fit ? variantMapper(fit, blockIdx) : undefined)
        }
        break
      }
      case "code_block": {
        const codeLines = (block.text || "").split("\n")
        xml = codeLines.map(line => generateParagraph(line || " ", PARA_CODE)).join("\n  ")
        break
      }
      case "blockquote":
        // baseline 호환: quoteColor 옵션 없으면 기존처럼 CHAR_NORMAL (이탤릭 아님)
        xml = generateParagraph(
          block.text || "",
          PARA_QUOTE,
          theme.hasQuoteOption ? CHAR_QUOTE : CHAR_NORMAL,
        )
        break
      case "list_item": {
        // 공문서 모드: 항목부호 8단계 + paraPr 단계별 들여쓰기/내어쓰기
        if (gongmun && gongmunList) {
          const info = gongmunList.get(blockIdx)
          const depth = info?.depth ?? 0
          const marker = info?.marker ?? ""
          const content = block.text || ""
          // 부호 + 1타(공백 1개) + 내용 (부호 없으면 내용만)
          const text = marker ? `${marker} ${content}` : content
          // 보고서(□○-) 모드의 1단계 □ 대제목은 굵게 — 정부 보고서 관행
          const listCharPr = gongmun.numbering === "report" && depth === 0 ? CHAR_BOLD : CHAR_NORMAL
          xml = generateParagraph(text, GONGMUN_LIST_BASE + depth, listCharPr, fit ? variantMapper(fit, blockIdx) : undefined)
          break
        }
        const indent = block.indent || 0
        let marker: string
        if (block.ordered) {
          // 러닝 카운터: indent 레벨별로 증가. 하위 레벨(더 깊은 indent)은 별도 세퀀스.
          orderedCounters[indent] = (orderedCounters[indent] || 0) + 1
          // 상위 레벨 번호가 바뀌면 하위는 자동 리셋되어야 함 — 한 레벨 위로 올라갈 때 하위 카운터 초기화
          for (const k of Object.keys(orderedCounters)) {
            if (+k > indent) delete orderedCounters[+k]
          }
          marker = `${orderedCounters[indent]}. `
          prevWasOrdered = true
        } else {
          marker = "· "
          if (prevWasOrdered) {
            for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
          }
          prevWasOrdered = false
        }
        const indentPrefix = "  ".repeat(indent)
        xml = generateParagraph(indentPrefix + marker + (block.text || ""), PARA_LIST)
        break
      }
      case "hr":
        // 수평선 — 긴 대시로 대체
        xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>────────────────────────────────────────</hp:t></hp:run></hp:p>`
        break
      case "table":
        if (block.rows) {
          if (isFirst) {
            // 테이블이 첫 블록이면 빈 단락에 secPr
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
            isFirst = false
          }
          xml = generateTable(block.rows, theme)
        }
        break
      case "html_table": {
        const tbl = generateHtmlTableXml(block.text || "", theme)
        if (tbl) {
          if (isFirst) {
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
            isFirst = false
          }
          xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
        } else {
          // 파싱 불가 — 태그 제거한 텍스트 문단 폴백 (원문 HTML을 그대로 싣지 않음)
          const plain = (block.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
          xml = plain ? generateParagraph(plain) : ""
        }
        break
      }
    }

    if (!xml) continue

    // 첫 번째 단락에 secPr 주입
    if (isFirst && block.type !== "table") {
      xml = xml.replace(
        /<hp:run charPrIDRef="(\d+)">/,
        `<hp:run charPrIDRef="$1">${generateSecPr(gongmun)}`
      )
      isFirst = false
    }

    paraXmls.push(xml)
  }

  // 블록이 없으면 빈 단락
  if (paraXmls.length === 0) {
    paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run></hp:p>`)
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}">
  ${paraXmls.join("\n  ")}
</hs:sec>`
}

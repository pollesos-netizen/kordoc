/** 2-pass colSpan/rowSpan 테이블 빌더 및 Markdown 변환 */

import type { CellContext, IRBlock, IRCell, IRTable } from "../types.js"

/** 하이퍼링크 URL 살균 — javascript: 등 XSS 위험 스킴 차단 */
const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|#)/i
function sanitizeHref(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || !SAFE_HREF_RE.test(trimmed)) return null
  return trimmed
}

/** 테이블 열 수 상한 — 한국 공공문서 기준 충분한 값 */
export const MAX_COLS = 200
/** 테이블 행 수 상한 — 메모리 폭주 방지 */
export const MAX_ROWS = 10000

export function buildTable(rows: CellContext[][]): IRTable {
  if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS)
  const numRows = rows.length

  // Pass 1: maxCols 계산 (sparse Set — 메모리 효율적)
  const tempOccupied = new Set<number>()
  let maxCols = 0

  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0
    for (const cell of rows[rowIdx]) {
      while (colIdx < MAX_COLS && tempOccupied.has(rowIdx * MAX_COLS + colIdx)) colIdx++
      if (colIdx >= MAX_COLS) break

      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < Math.min(colIdx + cell.colSpan, MAX_COLS); c++) {
          tempOccupied.add(r * MAX_COLS + c)
        }
      }
      colIdx += cell.colSpan
      if (colIdx > maxCols) maxCols = colIdx
    }
  }
  tempOccupied.clear()

  if (maxCols === 0) return { rows: 0, cols: 0, cells: [], hasHeader: false }

  // Pass 2: 실제 배치
  const grid: IRCell[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: maxCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
  )
  const occupied: boolean[][] = Array.from({ length: numRows }, () => Array(maxCols).fill(false))

  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0
    let cellIdx = 0

    while (colIdx < maxCols && cellIdx < rows[rowIdx].length) {
      while (colIdx < maxCols && occupied[rowIdx][colIdx]) colIdx++
      if (colIdx >= maxCols) break

      const cell = rows[rowIdx][cellIdx]
      grid[rowIdx][colIdx] = {
        text: cell.text.trim(),
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
      }

      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < Math.min(colIdx + cell.colSpan, maxCols); c++) {
          occupied[r][c] = true
        }
      }

      colIdx += cell.colSpan
      cellIdx++
    }
  }

  // 빈 후행 열 제거 — HWP5에서 cols가 실제보다 큰 경우 보정
  let effectiveCols = maxCols
  while (effectiveCols > 0) {
    const colEmpty = grid.every(row => !row[effectiveCols - 1]?.text?.trim())
    if (!colEmpty) break
    effectiveCols--
  }
  if (effectiveCols < maxCols && effectiveCols > 0) {
    const trimmed = grid.map(row => row.slice(0, effectiveCols))
    return { rows: numRows, cols: effectiveCols, cells: trimmed, hasHeader: numRows > 1 }
  }

  return { rows: numRows, cols: maxCols, cells: grid, hasHeader: numRows > 1 }
}

export function convertTableToText(rows: CellContext[][]): string {
  return rows
    .map(row =>
      row
        .map(c => c.text.trim().replace(/\n/g, " "))
        .filter(Boolean)
        .join(" | ")
    )
    .filter(Boolean)
    .join("\n")
}

/** HWP 자동생성 도형/개체 대체텍스트 정규식 — 한컴오피스가 삽입하는 모든 알려진 패턴 */
const HWP_SHAPE_ALT_TEXT_RE = /(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|이등변 삼각형|직각 삼각형|선|직선|곡선|화살표|굵은 화살표|이중 화살표|오각형|육각형|팔각형|별|[4-8]점별|십자|십자형|구름|구름형|마름모|도넛|평행사변형|사다리꼴|부채꼴|호|반원|물결|번개|하트|빗금|블록 화살표|수식|표|그림|개체|그리기\s?개체|묶음\s?개체|글상자|수식\s?개체|OLE\s?개체)\s?입니다\.?/g

/** HWP PUA 특수문자 및 도형 대체텍스트 제거 — 모든 포맷 공통 */
function sanitizeText(text: string): string {
  let result = text
    // Supplementary Private Use Area (U+F0000-U+FFFFD) — HWP 전용 기호
    .replace(/[\u{F0000}-\u{FFFFD}]/gu, "")
    // HWP 도형/개체 자동생성 대체텍스트 제거
    .replace(HWP_SHAPE_ALT_TEXT_RE, "")
    .replace(/  +/g, " ")
    .trim()
  // 균등배분 스페이스 정리 ("현 장 대 응 단 장" → "현장대응단장")
  // 짧은 텍스트(30자 이하)에서 70%+ 토큰이 한글 1글자면 균등배분으로 판단
  if (result.length <= 30 && result.includes(" ")) {
    const tokens = result.split(" ")
    // 한글 1글자 토큰만 카운트 — ASCII 특수문자(< > & 등)는 균등배분이 아님
    const koreanSingleCharCount = tokens.filter(t => t.length === 1 && /[\uAC00-\uD7AF\u3131-\u318E]/.test(t)).length
    if (tokens.length >= 3 && koreanSingleCharCount / tokens.length >= 0.7) {
      result = tokens.join("")
    }
  }
  return result
}

export function blocksToMarkdown(blocks: IRBlock[]): string {
  const lines: string[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    // 헤딩 블록
    if (block.type === "heading" && block.text) {
      const prefix = "#".repeat(Math.min(block.level || 2, 6))
      const headingText = sanitizeText(block.text)
      if (headingText) lines.push("", `${prefix} ${headingText}`, "")
      continue
    }

    // 이미지 블록 — ![alt](filename) 참조
    if (block.type === "image" && block.text) {
      lines.push("", `![image](${block.text})`, "")
      continue
    }

    // 구분선 블록
    if (block.type === "separator") {
      lines.push("", "---", "")
      continue
    }

    // 리스트 블록
    if (block.type === "list" && block.text) {
      const listText = sanitizeText(block.text)
      if (!listText) continue
      // 텍스트가 이미 번호로 시작하면 그대로 출력 (원래 번호 보존)
      const alreadyNumbered = block.listType === "ordered" && /^\d+\.\s/.test(listText)
      const prefix = alreadyNumbered ? "" : block.listType === "ordered" ? "1. " : "- "
      lines.push(`${prefix}${listText}`)
      if (block.children) {
        for (const child of block.children) {
          const childPrefix = child.listType === "ordered" ? "1." : "-"
          lines.push(`  ${childPrefix} ${child.text || ""}`)
        }
      }
      continue
    }

    if (block.type === "paragraph" && block.text) {
      let text = sanitizeText(block.text)
      if (!text) continue

      // 별표 패턴 (기존 호환)
      if (/^\[별표\s*\d+/.test(text)) {
        const nextBlock = blocks[i + 1]
        if (nextBlock?.type === "paragraph" && nextBlock.text && /관련\)?$/.test(nextBlock.text)) {
          lines.push("", `## ${text} ${nextBlock.text}`, "")
          i++
        } else {
          lines.push("", `## ${text}`, "")
        }
        continue
      }

      if (/^\([^)]*조[^)]*관련\)$/.test(text)) {
        lines.push(`*${text}*`, "")
        continue
      }

      // 하이퍼링크가 있으면 텍스트에 링크 삽입 (javascript: 등 위험 스킴 제거)
      if (block.href) {
        const href = sanitizeHref(block.href)
        if (href) text = `[${text}](${href})`
      }

      // 각주가 있으면 괄호로 인라인 삽입
      if (block.footnoteText) {
        text += ` (주: ${block.footnoteText})`
      }

      lines.push(text)
    } else if (block.type === "table" && block.table) {
      // 테이블 앞에 빈 줄 보장 (마크다운 렌더링 필수)
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("")
      }
      lines.push(tableToMarkdown(block.table))
      lines.push("")
    }
  }

  return lines.join("\n").trim()
}

function tableToMarkdown(table: IRTable): string {
  if (table.rows === 0 || table.cols === 0) return ""

  const { cells, rows: numRows, cols: numCols } = table

  // 1행 1열 → 구조화된 텍스트
  if (numRows === 1 && numCols === 1) {
    const content = sanitizeText(cells[0][0].text)
    return content
      .split(/\n/)
      .map(line => {
        const trimmed = line.trim()
        if (!trimmed) return ""
        if (/^\d+\.\s/.test(trimmed)) return `**${trimmed}**`
        if (/^[가-힣]\.\s/.test(trimmed)) return `  ${trimmed}`
        return trimmed
      })
      .filter(Boolean)
      .join("\n")
  }

  // 1열 다행 테이블 → 각 행을 별도 라인으로 출력 (목록성 데이터)
  if (numCols === 1 && numRows >= 2) {
    return cells
      .map(row => sanitizeText(row[0].text).replace(/\n/g, " "))
      .filter(Boolean)
      .join("\n")
  }

  // 병합 셀: 행/열 병합된 셀은 빈 칸으로
  const display: string[][] = Array.from({ length: numRows }, () => Array(numCols).fill(""))
  const skip = new Set<string>()

  for (let r = 0; r < numRows; r++) {
    // colSpan이 있으면 cells[r]의 실제 인덱스 ≠ display 열 인덱스
    // display 열 기준으로 순회하되, cells[r]에서는 순차적으로 소비
    let cellIdx = 0
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue
      const cell = cells[r]?.[cellIdx]
      if (!cell) break
      cellIdx++
      display[r][c] = sanitizeText(cell.text).replace(/\n/g, "<br>")

      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < numRows && c + dc < numCols) {
            skip.add(`${r + dr},${c + dc}`)
          }
        }
      }
      // colSpan > 1이면 display 열 인덱스를 건너뜀
      c += cell.colSpan - 1
    }
  }

  // rowSpan 잔류 처리:
  // 1) 완전 빈 행 제거
  // 2) "첫 열만 값, 나머지 빈" 행 → 다음 데이터 행의 첫 열에 값을 전파
  //    단, colSpan으로 인한 빈 열(skip 셀)은 이 대상이 아님
  const uniqueRows: string[][] = []
  let pendingFirstCol = ""
  for (let r = 0; r < display.length; r++) {
    const row = display[r]
    const isEmptyPlaceholder = row.every(cell => cell === "")
    if (isEmptyPlaceholder) continue

    // 빈 열이 skip(colSpan/rowSpan 커버)인지 확인 — skip이면 "첫 열만 값" 대상 아님
    const hasSkippedCols = row.some((cell, c) => cell === "" && skip.has(`${r},${c}`))

    // 첫 열만 값이 있고 나머지 모두 빈 행 → 임시 저장 (colSpan 스킵 제외)
    const nonEmptyCols = row.filter(cell => cell !== "")
    if (!hasSkippedCols && nonEmptyCols.length === 1 && row[0] !== "" && row.slice(1).every(c => c === "")) {
      pendingFirstCol = row[0]
      continue
    }

    // 저장된 첫 열 값을 현재 행의 빈 첫 열에 전파
    if (pendingFirstCol && row[0] === "") {
      row[0] = pendingFirstCol
      pendingFirstCol = ""
    } else {
      pendingFirstCol = ""
    }
    uniqueRows.push(row)
  }

  if (uniqueRows.length === 0) return ""

  const md: string[] = []
  md.push("| " + uniqueRows[0].join(" | ") + " |")
  md.push("| " + uniqueRows[0].map(() => "---").join(" | ") + " |")
  for (let i = 1; i < uniqueRows.length; i++) {
    md.push("| " + uniqueRows[i].join(" | ") + " |")
  }
  return md.join("\n")
}

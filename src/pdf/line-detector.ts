/**
 * PDF 그래픽 명령에서 수평/수직 선을 추출하고,
 * 선 교차점 기반으로 테이블 그리드를 구성하는 모듈.
 *
 * ODL(OpenDataLoader) TableBorderBuilder 알고리즘을 TypeScript로 포팅.
 * pdfjs-dist의 getOperatorList() 결과를 입력으로 받음.
 */

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

// ─── 타입 ─────────────────────────────────────────────

export interface LineSegment {
  x1: number; y1: number
  x2: number; y2: number
  lineWidth: number
}

export interface TableGrid {
  /** 행 Y 좌표 경계 (위→아래 내림차순) */
  rowYs: number[]
  /** 열 X 좌표 경계 (좌→우 오름차순) */
  colXs: number[]
  /** 테이블 바운딩 박스 */
  bbox: { x1: number; y1: number; x2: number; y2: number }
}

export interface ExtractedCell {
  row: number; col: number
  rowSpan: number; colSpan: number
  /** 셀 바운딩 박스 */
  bbox: { x1: number; y1: number; x2: number; y2: number }
}

// ─── 상수 ─────────────────────────────────────────────

/** 수평/수직 판별 허용 오차 (pt) */
const ORIENTATION_TOL = 2
/** 최소 선 길이 (너무 짧은 장식선 무시) */
const MIN_LINE_LENGTH = 10
/** 좌표 병합 tolerance — ODL: 4 * vertexRadius, 여기선 고정 3pt */
const COORD_MERGE_TOL = 3
/** 두 선이 같은 테이블에 속하는지 판별하는 거리 */
const CONNECT_TOL = 5
/** 셀 경계 내부 판별 여유 (텍스트 매핑용) */
const CELL_PADDING = 2

// ─── 선 추출 ──────────────────────────────────────────

/**
 * pdfjs operatorList에서 수평/수직 선을 추출.
 * constructPath(91) 내의 moveTo→lineTo, rectangle 패턴을 인식.
 */
export function extractLines(
  fnArray: Uint32Array | number[],
  argsArray: unknown[][],
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const horizontals: LineSegment[] = []
  const verticals: LineSegment[] = []
  let lineWidth = 1

  // 현재 path의 세그먼트를 수집
  let currentPath: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  let pathStartX = 0, pathStartY = 0
  let curX = 0, curY = 0

  function flushPath(isStroke: boolean) {
    if (!isStroke) { currentPath = []; return }
    for (const seg of currentPath) {
      classifyAndAdd(seg, lineWidth, horizontals, verticals)
    }
    currentPath = []
  }

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    const args = argsArray[i]

    switch (op) {
      case OPS.setLineWidth:
        lineWidth = (args as number[])[0] || 1
        break

      case OPS.constructPath: {
        const subOps = (args as [number[], number[], number[]])[0]
        const coords = (args as [number[], number[], number[]])[1]
        let ci = 0

        for (const subOp of subOps) {
          if (subOp === OPS.moveTo) {
            curX = coords[ci++]; curY = coords[ci++]
            pathStartX = curX; pathStartY = curY
          } else if (subOp === OPS.lineTo) {
            const x2 = coords[ci++], y2 = coords[ci++]
            currentPath.push({ x1: curX, y1: curY, x2, y2 })
            curX = x2; curY = y2
          } else if (subOp === OPS.rectangle) {
            const rx = coords[ci++], ry = coords[ci++]
            const rw = coords[ci++], rh = coords[ci++]
            // 사각형 → 4변 (매우 얇으면 선 1개로)
            if (Math.abs(rh) < ORIENTATION_TOL * 2) {
              // 얇은 수평 사각형 → 수평선
              currentPath.push({ x1: rx, y1: ry + rh / 2, x2: rx + rw, y2: ry + rh / 2 })
            } else if (Math.abs(rw) < ORIENTATION_TOL * 2) {
              // 얇은 수직 사각형 → 수직선
              currentPath.push({ x1: rx + rw / 2, y1: ry, x2: rx + rw / 2, y2: ry + rh })
            } else {
              // 일반 사각형 → 4변
              currentPath.push(
                { x1: rx, y1: ry, x2: rx + rw, y2: ry },           // bottom
                { x1: rx + rw, y1: ry, x2: rx + rw, y2: ry + rh }, // right
                { x1: rx + rw, y1: ry + rh, x2: rx, y2: ry + rh }, // top
                { x1: rx, y1: ry + rh, x2: rx, y2: ry },           // left
              )
            }
          } else if (subOp === OPS.closePath) {
            if (curX !== pathStartX || curY !== pathStartY) {
              currentPath.push({ x1: curX, y1: curY, x2: pathStartX, y2: pathStartY })
            }
            curX = pathStartX; curY = pathStartY
          } else if (subOp === OPS.curveTo) {
            ci += 6 // skip control points
          } else if (subOp === OPS.curveTo2 || subOp === OPS.curveTo3) {
            ci += 4
          }
        }
        break
      }

      case OPS.stroke:
      case OPS.closeStroke:
        flushPath(true)
        break

      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        // fill된 사각형도 테이블 선으로 처리 (셀 배경이 아닌 경우)
        flushPath(true)
        break

      case OPS.endPath:
        flushPath(false)
        break
    }
  }

  return { horizontals, verticals }
}

function classifyAndAdd(
  seg: { x1: number; y1: number; x2: number; y2: number },
  lineWidth: number,
  horizontals: LineSegment[],
  verticals: LineSegment[],
) {
  const dx = Math.abs(seg.x2 - seg.x1)
  const dy = Math.abs(seg.y2 - seg.y1)
  const length = Math.sqrt(dx * dx + dy * dy)

  if (length < MIN_LINE_LENGTH) return

  if (dy <= ORIENTATION_TOL) {
    // 수평선
    const y = (seg.y1 + seg.y2) / 2
    const x1 = Math.min(seg.x1, seg.x2)
    const x2 = Math.max(seg.x1, seg.x2)
    horizontals.push({ x1, y1: y, x2, y2: y, lineWidth })
  } else if (dx <= ORIENTATION_TOL) {
    // 수직선
    const x = (seg.x1 + seg.x2) / 2
    const y1 = Math.min(seg.y1, seg.y2)
    const y2 = Math.max(seg.y1, seg.y2)
    verticals.push({ x1: x, y1, x2: x, y2, lineWidth })
  }
  // 대각선은 무시 (테이블 경계가 아님)
}

// ─── 페이지 경계(클립) 선 필터링 ──────────────────────

/** 페이지 전체를 감싸는 클립 경계 선 제거 */
export function filterPageBorderLines(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  pageWidth: number,
  pageHeight: number,
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const margin = 5
  return {
    horizontals: horizontals.filter(l =>
      !(Math.abs(l.y1) < margin || Math.abs(l.y1 - pageHeight) < margin) ||
      (l.x2 - l.x1) < pageWidth * 0.9
    ),
    verticals: verticals.filter(l =>
      !(Math.abs(l.x1) < margin || Math.abs(l.x1 - pageWidth) < margin) ||
      (l.y2 - l.y1) < pageHeight * 0.9
    ),
  }
}

// ─── 테이블 그리드 구성 ────────────────────────────────

/**
 * 수평/수직 선에서 테이블 그리드를 추출.
 * 1. 교차하는 선들을 그룹화 (연결 컴포넌트)
 * 2. 각 그룹에서 X/Y 좌표를 클러스터링하여 그리드 구성
 */
export function buildTableGrids(
  horizontals: LineSegment[],
  verticals: LineSegment[],
): TableGrid[] {
  if (horizontals.length < 2 || verticals.length < 2) return []

  // 1. 선들을 교차 관계로 그룹화
  const allLines = [
    ...horizontals.map((l, i) => ({ ...l, type: "h" as const, id: i })),
    ...verticals.map((l, i) => ({ ...l, type: "v" as const, id: i + horizontals.length })),
  ]

  const groups = groupConnectedLines(allLines)

  const grids: TableGrid[] = []

  for (const group of groups) {
    const hLines = group.filter(l => l.type === "h")
    const vLines = group.filter(l => l.type === "v")

    // 최소 2개 수평 + 2개 수직 선이 있어야 테이블
    if (hLines.length < 2 || vLines.length < 2) continue

    // 2. Y 좌표 클러스터링 (수평선의 y 값)
    const rawYs = hLines.map(l => l.y1)
    const rowYs = clusterCoordinates(rawYs).sort((a, b) => b - a) // 위→아래 (PDF는 y가 위가 큼)

    // 3. X 좌표 클러스터링 (수직선의 x 값)
    const rawXs = vLines.map(l => l.x1)
    const colXs = clusterCoordinates(rawXs).sort((a, b) => a - b)

    // 최소 2행 2열
    if (rowYs.length < 2 || colXs.length < 2) continue

    // 그리드에 실제로 셀이 형성되는지 검증
    const bbox = {
      x1: colXs[0], y1: rowYs[rowYs.length - 1],
      x2: colXs[colXs.length - 1], y2: rowYs[0],
    }

    grids.push({ rowYs, colXs, bbox })
  }

  return grids
}

/** 좌표값 클러스터링 — 가까운 값끼리 병합 */
function clusterCoordinates(values: number[]): number[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const clusters: { sum: number; count: number }[] = [{ sum: sorted[0], count: 1 }]

  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1]
    const avg = last.sum / last.count
    if (Math.abs(sorted[i] - avg) <= COORD_MERGE_TOL) {
      last.sum += sorted[i]
      last.count++
    } else {
      clusters.push({ sum: sorted[i], count: 1 })
    }
  }

  return clusters.map(c => c.sum / c.count)
}

type TypedLine = LineSegment & { type: "h" | "v"; id: number }

/** 교차하는 선들을 Union-Find로 그룹화 */
function groupConnectedLines(lines: TypedLine[]): TypedLine[][] {
  const parent = lines.map((_, i) => i)

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // O(n²) 교차 검사 — 선 수가 수백 수준이므로 충분
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (linesIntersect(lines[i], lines[j])) {
        union(i, j)
      }
    }
  }

  const groups = new Map<number, TypedLine[]>()
  for (let i = 0; i < lines.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(lines[i])
  }

  return [...groups.values()]
}

/** 수평선과 수직선의 교차 판정 (tolerance 포함) */
function linesIntersect(a: TypedLine, b: TypedLine): boolean {
  // 같은 방향이면 교차 안 함 (평행)
  if (a.type === b.type) {
    // 같은 방향이라도 연결된 선일 수 있음 (끝점이 가까운 경우)
    if (a.type === "h") {
      if (Math.abs(a.y1 - b.y1) > CONNECT_TOL) return false
      // X 범위 겹침
      return Math.min(a.x2, b.x2) >= Math.max(a.x1, b.x1) - CONNECT_TOL
    } else {
      if (Math.abs(a.x1 - b.x1) > CONNECT_TOL) return false
      return Math.min(a.y2, b.y2) >= Math.max(a.y1, b.y1) - CONNECT_TOL
    }
  }

  // 수평 + 수직 교차
  const h = a.type === "h" ? a : b
  const v = a.type === "h" ? b : a
  const tol = CONNECT_TOL

  return (
    v.x1 >= h.x1 - tol && v.x1 <= h.x2 + tol &&
    h.y1 >= v.y1 - tol && h.y1 <= v.y2 + tol
  )
}

// ─── 셀 구조 추출 (colspan/rowspan 감지) ──────────────

/**
 * 테이블 그리드에서 셀 목록을 추출.
 * 수평/수직 선의 존재 여부로 셀 병합(colspan/rowspan)을 감지.
 */
export function extractCells(
  grid: TableGrid,
  horizontals: LineSegment[],
  verticals: LineSegment[],
): ExtractedCell[] {
  const { rowYs, colXs } = grid
  const numRows = rowYs.length - 1
  const numCols = colXs.length - 1
  if (numRows <= 0 || numCols <= 0) return []

  // 셀이 이미 병합된 셀에 포함되는지 추적
  const occupied = Array.from({ length: numRows }, () => Array(numCols).fill(false))
  const cells: ExtractedCell[] = []

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (occupied[r][c]) continue

      // 이 셀에서 오른쪽/아래로 병합 가능한 범위 찾기
      let colSpan = 1
      let rowSpan = 1

      // colSpan: 오른쪽 경계에 수직선이 없으면 병합
      while (c + colSpan < numCols) {
        const borderX = colXs[c + colSpan]
        const topY = rowYs[r]
        const botY = rowYs[r + 1]
        if (hasVerticalLine(verticals, borderX, topY, botY)) break
        colSpan++
      }

      // rowSpan: 아래쪽 경계에 수평선이 없으면 병합
      while (r + rowSpan < numRows) {
        const borderY = rowYs[r + rowSpan]
        const leftX = colXs[c]
        const rightX = colXs[c + colSpan]
        if (hasHorizontalLine(horizontals, borderY, leftX, rightX)) break
        rowSpan++
      }

      // 병합 영역 마킹
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          occupied[r + dr][c + dc] = true
        }
      }

      cells.push({
        row: r, col: c, rowSpan, colSpan,
        bbox: {
          x1: colXs[c], y1: rowYs[r + rowSpan],
          x2: colXs[c + colSpan], y2: rowYs[r],
        },
      })
    }
  }

  return cells
}

/** 특정 X 위치에 수직선이 Y 범위를 커버하는지 확인 */
function hasVerticalLine(verticals: LineSegment[], x: number, topY: number, botY: number): boolean {
  const tol = COORD_MERGE_TOL + 1
  for (const v of verticals) {
    if (Math.abs(v.x1 - x) <= tol) {
      // 선의 Y 범위가 셀 경계의 상당 부분(50%)을 커버하는지
      const cellH = Math.abs(topY - botY)
      const overlapTop = Math.min(v.y2, topY)
      const overlapBot = Math.max(v.y1, botY)
      const overlap = overlapTop - overlapBot
      if (overlap >= cellH * 0.5) return true
    }
  }
  return false
}

/** 특정 Y 위치에 수평선이 X 범위를 커버하는지 확인 */
function hasHorizontalLine(horizontals: LineSegment[], y: number, leftX: number, rightX: number): boolean {
  const tol = COORD_MERGE_TOL + 1
  for (const h of horizontals) {
    if (Math.abs(h.y1 - y) <= tol) {
      const cellW = Math.abs(rightX - leftX)
      const overlapLeft = Math.max(h.x1, leftX)
      const overlapRight = Math.min(h.x2, rightX)
      const overlap = overlapRight - overlapLeft
      if (overlap >= cellW * 0.5) return true
    }
  }
  return false
}

// ─── 텍스트→셀 매핑 ──────────────────────────────────

export interface TextItem {
  text: string
  x: number; y: number; w: number; h: number
  fontSize: number; fontName: string
}

/**
 * 텍스트 아이템을 셀에 매핑.
 * 각 텍스트의 중심점이 어떤 셀의 bbox 안에 있는지로 판별.
 */
export function mapTextToCells(
  items: TextItem[],
  cells: ExtractedCell[],
): Map<ExtractedCell, TextItem[]> {
  const result = new Map<ExtractedCell, TextItem[]>()
  for (const cell of cells) {
    result.set(cell, [])
  }

  for (const item of items) {
    const cx = item.x + item.w / 2
    const cy = item.y
    const pad = CELL_PADDING

    let bestCell: ExtractedCell | null = null
    let bestDist = Infinity

    for (const cell of cells) {
      // 중심점이 셀 bbox 안에 있는지 (패딩 포함)
      if (cx >= cell.bbox.x1 - pad && cx <= cell.bbox.x2 + pad &&
          cy >= cell.bbox.y1 - pad && cy <= cell.bbox.y2 + pad) {
        // 여러 셀에 해당하면 가장 가까운 셀 중심에 배정
        const cellCx = (cell.bbox.x1 + cell.bbox.x2) / 2
        const cellCy = (cell.bbox.y1 + cell.bbox.y2) / 2
        const dist = Math.abs(cx - cellCx) + Math.abs(cy - cellCy)
        if (dist < bestDist) {
          bestDist = dist
          bestCell = cell
        }
      }
    }

    if (bestCell) {
      result.get(bestCell)!.push(item)
    }
  }

  return result
}

/**
 * 셀 내 텍스트 아이템을 읽기 순서로 정렬 후 합치기.
 * Y 내림차순 (위→아래) → X 오름차순 (좌→우)
 */
export function cellTextToString(items: TextItem[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0].text

  // Y좌표로 행 그룹핑 (tolerance: max(3, fontSize*0.6))
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: TextItem[][] = []
  let curLine: TextItem[] = [sorted[0]]
  let curY = sorted[0].y

  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(3, Math.min(sorted[i].fontSize, curLine[0].fontSize) * 0.6)
    if (Math.abs(sorted[i].y - curY) <= tol) {
      curLine.push(sorted[i])
    } else {
      lines.push(curLine)
      curLine = [sorted[i]]
      curY = sorted[i].y
    }
  }
  lines.push(curLine)

  // 각 행을 텍스트로 변환 — 한글 간 작은 갭은 공백 없이 붙임
  const textLines = lines.map(line => {
    const s = line.sort((a, b) => a.x - b.x)
    if (s.length === 1) return s[0].text
    let result = s[0].text
    for (let j = 1; j < s.length; j++) {
      const gap = s[j].x - (s[j - 1].x + s[j - 1].w)
      const avgFs = (s[j].fontSize + s[j - 1].fontSize) / 2
      // 한글-한글 사이 매우 작은 갭 (< fontSize * 0.3) → PDF 문자 개별 배치 잔재
      if (gap < avgFs * 0.3 && /[가-힣]$/.test(result) && /^[가-힣]/.test(s[j].text)) {
        result += s[j].text
      } else {
        result += " " + s[j].text
      }
    }
    return result
  })

  // 한국어 줄바꿈 병합: "전자여\n권" → "전자여권"
  // 셀 컨텍스트에서는 더 공격적으로: 8자 이하 순수 한글 또는 한글+숫자 단어
  if (textLines.length <= 1) return textLines[0] || ""
  const merged: string[] = [textLines[0]]
  for (let i = 1; i < textLines.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = textLines[i]
    // 짧은 순수 한글 (8자 이하, 공백 없음) = 잘린 단어 조각 또는 조사
    if (/[가-힣]$/.test(prev) && /^[가-힣]+$/.test(curr) && curr.length <= 8 && !curr.includes(" ")) {
      merged[merged.length - 1] = prev + curr
    } else {
      merged.push(curr)
    }
  }
  return merged.join("\n")
}

/**
 * HWPX 원본 서식 유지 채우기 — ZIP 내 section XML 직접 수정
 *
 * IRBlock 중간 표현을 거치지 않고, 원본 HWPX ZIP의 section XML에서
 * 테이블 셀 텍스트(<hp:t>)만 교체하여 모든 스타일을 보존합니다.
 */

import JSZip from "jszip"
import { DOMParser, XMLSerializer } from "@xmldom/xmldom"
import { isLabelCell } from "../form/recognize.js"
import { KordocError, stripDtd } from "../utils.js"
import type { FormField } from "../types.js"

/** 채우기 결과 */
export interface HwpxFillResult {
  /** 채워진 HWPX 바이너리 */
  buffer: ArrayBuffer
  /** 실제 채워진 필드 목록 */
  filled: FormField[]
  /** 매칭 실패한 라벨 */
  unmatched: string[]
}

/**
 * HWPX 원본을 직접 수정하여 서식 필드를 채움 — 스타일 100% 보존.
 *
 * @param hwpxBuffer 원본 HWPX 파일 버퍼
 * @param values 채울 값 맵 (라벨 → 값)
 * @returns HwpxFillResult
 */
export async function fillHwpx(
  hwpxBuffer: ArrayBuffer,
  values: Record<string, string>,
): Promise<HwpxFillResult> {
  const zip = await JSZip.loadAsync(hwpxBuffer)
  const filled: FormField[] = []
  const matchedLabels = new Set<string>()

  // 입력 라벨 정규화
  const normalizedValues = new Map<string, string>()
  for (const [label, value] of Object.entries(values)) {
    normalizedValues.set(normalizeLabel(label), value)
  }

  // section XML 파일 찾기
  const sectionFiles = Object.keys(zip.files)
    .filter(name => /[Ss]ection\d+\.xml$/i.test(name))
    .sort()

  if (sectionFiles.length === 0) {
    throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")
  }

  const xmlParser = new DOMParser()
  const xmlSerializer = new XMLSerializer()

  for (const sectionPath of sectionFiles) {
    const rawXml = await zip.file(sectionPath)!.async("text")
    const doc = xmlParser.parseFromString(stripDtd(rawXml), "text/xml")
    if (!doc.documentElement) continue

    let modified = false

    // 모든 테이블 요소 탐색
    const tables = findAllElements(doc.documentElement as unknown as Node, "tbl")

    for (const tblEl of tables) {
      const rows = findDirectChildren(tblEl, "tr")

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const trEl = rows[rowIdx]
        const cells = findDirectChildren(trEl, "tc")

        // 전략 1: 인접 라벨-값 셀 (label | value 패턴)
        for (let colIdx = 0; colIdx < cells.length - 1; colIdx++) {
          const labelText = extractCellText(cells[colIdx])
          if (!isLabelCell(labelText)) continue

          const normalizedCellLabel = normalizeLabel(labelText)
          if (!normalizedCellLabel) continue

          const matchKey = findMatchingKey(normalizedCellLabel, normalizedValues)
          if (matchKey === undefined) continue

          const newValue = normalizedValues.get(matchKey)!
          replaceCellText(cells[colIdx + 1], newValue)
          matchedLabels.add(matchKey)
          filled.push({
            label: labelText.trim().replace(/[:：]\s*$/, ""),
            value: newValue,
            row: rowIdx,
            col: colIdx,
          })
          modified = true
        }
      }

      // 전략 2: 헤더+데이터 행 패턴 (첫 행 전부 라벨)
      if (rows.length >= 2) {
        const headerCells = findDirectChildren(rows[0], "tc")
        const allShortText = headerCells.every(cell => {
          const t = extractCellText(cell).trim()
          return t.length > 0 && t.length <= 20
        })

        if (allShortText) {
          for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
            const dataCells = findDirectChildren(rows[rowIdx], "tc")
            for (let colIdx = 0; colIdx < Math.min(headerCells.length, dataCells.length); colIdx++) {
              const headerLabel = normalizeLabel(extractCellText(headerCells[colIdx]))
              const matchKey = findMatchingKey(headerLabel, normalizedValues)
              if (matchKey === undefined) continue
              if (matchedLabels.has(matchKey)) continue  // 전략 1에서 이미 채운 필드 스킵

              const newValue = normalizedValues.get(matchKey)!
              replaceCellText(dataCells[colIdx], newValue)
              matchedLabels.add(matchKey)
              filled.push({
                label: extractCellText(headerCells[colIdx]).trim(),
                value: newValue,
                row: rowIdx,
                col: colIdx,
              })
              modified = true
            }
          }
        }
      }
    }

    // 인라인 "라벨: 값" 패턴도 처리 (테이블 밖 paragraph)
    const allParagraphs = findAllElements(doc.documentElement as unknown as Node, "p")
    for (const pEl of allParagraphs) {
      // 테이블 내부 paragraph는 스킵 (이미 처리됨)
      if (isInsideTable(pEl)) continue

      const pText = extractElementText(pEl)
      const pattern = /([가-힣A-Za-z]{2,10})\s*[:：]\s*([^\n,;]{0,100})/g
      let match
      while ((match = pattern.exec(pText)) !== null) {
        const rawLabel = match[1]
        const normalized = normalizeLabel(rawLabel)
        const matchKey = findMatchingKey(normalized, normalizedValues)
        if (matchKey === undefined) continue

        const newValue = normalizedValues.get(matchKey)!
        // <hp:t> 텍스트 노드에서 직접 교체
        replaceInlineFieldInParagraph(pEl, rawLabel, match[2], newValue)
        matchedLabels.add(matchKey)
        filled.push({ label: rawLabel.trim(), value: newValue, row: -1, col: -1 })
        modified = true
      }
    }

    if (modified) {
      const newXml = xmlSerializer.serializeToString(doc)
      zip.file(sectionPath, newXml)
    }
  }

  const unmatched = [...normalizedValues.keys()]
    .filter(k => !matchedLabels.has(k))
    .map(k => {
      for (const orig of Object.keys(values)) {
        if (normalizeLabel(orig) === k) return orig
      }
      return k
    })

  const buffer = await zip.generateAsync({ type: "arraybuffer" })
  return { buffer, filled, unmatched }
}

// ─── XML 탐색 헬퍼 ──────────────────────────────────

/** 로컬 태그명 추출 (네임스페이스 프리픽스 제거) */
function localName(el: Element): string {
  return (el.tagName || el.localName || "").replace(/^[^:]+:/, "")
}

/** 문서 전체에서 특정 로컬 태그명의 요소를 재귀 탐색 */
function findAllElements(node: Node, tagLocalName: string): Element[] {
  const result: Element[] = []
  const walk = (n: Node) => {
    const children = n.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType !== 1) continue
      if (localName(child) === tagLocalName) result.push(child)
      walk(child)
    }
  }
  walk(node)
  return result
}

/** 직계 자식 중 특정 로컬 태그명 요소만 반환 */
function findDirectChildren(parent: Node, tagLocalName: string): Element[] {
  const result: Element[] = []
  const children = parent.childNodes
  if (!children) return result
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType === 1 && localName(child) === tagLocalName) {
      result.push(child)
    }
  }
  return result
}

/** 요소가 <tbl> 안에 있는지 확인 (부모 체인 탐색) */
function isInsideTable(el: Element): boolean {
  let parent = el.parentNode as Element | null
  while (parent) {
    if (parent.nodeType === 1 && localName(parent) === "tbl") return true
    parent = parent.parentNode as Element | null
  }
  return false
}

// ─── 셀 텍스트 추출/교체 ────────────────────────────

/** 셀(<hp:tc>) 내 모든 <hp:t> 텍스트를 합쳐 반환 */
function extractCellText(tcEl: Element): string {
  const parts: string[] = []
  const walk = (node: Node) => {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType === 3) {
        parts.push(child.textContent || "")
      } else if (child.nodeType === 1) {
        const tag = localName(child)
        if (tag === "t") walk(child)
        else if (tag === "run" || tag === "r" || tag === "p") walk(child)
        else if (tag === "tab") parts.push("\t")
        else if (tag === "br") parts.push("\n")
      }
    }
  }
  walk(tcEl)
  return parts.join("")
}

/** 요소 내 모든 텍스트 추출 (paragraph용) */
function extractElementText(el: Element): string {
  const parts: string[] = []
  const walk = (node: Node) => {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType === 3) {
        parts.push(child.textContent || "")
      } else if (child.nodeType === 1) {
        walk(child)
      }
    }
  }
  walk(el)
  return parts.join("")
}

/**
 * 셀(<hp:tc>) 내 텍스트를 새 값으로 교체 — 스타일 보존 전략:
 *
 * 1) 첫 번째 <hp:run>의 <hp:t>에 새 텍스트 설정
 * 2) 나머지 <hp:run>의 <hp:t>는 빈 문자열로
 * 3) 두 번째 이후 <hp:p>는 제거 (다중 단락 → 단일 단락)
 *
 * 이렇게 하면 첫 번째 run의 charPrIDRef(글꼴, 크기, 굵기 등)가 보존됨
 */
function replaceCellText(tcEl: Element, newValue: string): void {
  const paragraphs = findAllElements(tcEl, "p")
  if (paragraphs.length === 0) return

  // 첫 번째 paragraph의 run들 처리
  const firstP = paragraphs[0]
  const runs = findAllElements(firstP, "run").concat(findAllElements(firstP, "r"))

  if (runs.length > 0) {
    // 첫 번째 run에 텍스트 설정
    setRunText(runs[0], newValue)
    // 나머지 run은 텍스트 비우기
    for (let i = 1; i < runs.length; i++) {
      setRunText(runs[i], "")
    }
  } else {
    // run이 없으면 새 run 생성은 피하고 <hp:t> 직접 탐색
    const tElements = findAllElements(firstP, "t")
    if (tElements.length > 0) {
      clearChildren(tElements[0])
      tElements[0].appendChild(tElements[0].ownerDocument!.createTextNode(newValue))
      for (let i = 1; i < tElements.length; i++) {
        clearChildren(tElements[i])
      }
    }
  }

  // 두 번째 이후 paragraph 제거 (첫 p만 유지)
  for (let i = 1; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    if (p.parentNode) {
      // paragraph 내용만 비우기 (요소 자체는 유지 — HWPX 뷰어 호환)
      const pRuns = findAllElements(p, "run").concat(findAllElements(p, "r"))
      for (const run of pRuns) setRunText(run, "")
      const pTs = findAllElements(p, "t")
      for (const t of pTs) clearChildren(t)
    }
  }
}

/** <hp:run> 요소의 <hp:t> 텍스트를 교체 */
function setRunText(runEl: Element, text: string): void {
  const tElements = findAllElements(runEl, "t")
  if (tElements.length > 0) {
    // 첫 번째 <t>에만 텍스트 설정
    clearChildren(tElements[0])
    tElements[0].appendChild(tElements[0].ownerDocument!.createTextNode(text))
    // 나머지 <t>는 비우기
    for (let i = 1; i < tElements.length; i++) {
      clearChildren(tElements[i])
    }
  }
}

/** 요소의 모든 자식 노드 제거 */
function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

/** 인라인 "라벨: 값" 패턴의 값 부분만 교체 */
function replaceInlineFieldInParagraph(
  pEl: Element,
  label: string,
  oldValue: string,
  newValue: string,
): void {
  const tElements = findAllElements(pEl, "t")
  // <hp:t> 요소들의 텍스트를 연결하면서 교체 대상 찾기
  for (const t of tElements) {
    const content = t.textContent || ""
    // "라벨: 기존값"을 "라벨: 새값"으로 교체
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const escapedOld = oldValue.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(
      `(${escapedLabel}\\s*[:：]\\s*)${escapedOld || "[^\\n,;]{0,100}"}`,
    )
    if (pattern.test(content)) {
      const replaced = content.replace(pattern, `$1${newValue}`)
      clearChildren(t)
      t.appendChild(t.ownerDocument!.createTextNode(replaced))
    }
  }
}

// ─── 공통 유틸 (filler.ts와 동일) ───────────────────

function normalizeLabel(label: string): string {
  return label.trim().replace(/[:：\s]/g, "")
}

function findMatchingKey(cellLabel: string, values: Map<string, string>): string | undefined {
  if (values.has(cellLabel)) return cellLabel
  for (const key of values.keys()) {
    if (cellLabel.includes(key) || key.includes(cellLabel)) return key
  }
  return undefined
}

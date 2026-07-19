/**
 * 래스터 괘선 감지 — 스캔/이미지 페이지의 픽셀에서 표 괘선(수평/수직 선)을
 * 찾아 선 기반 표 파이프라인(line-detector → table-grid)에 공급한다.
 *
 * PDF 그래픽 ops 가 없는 OCR 경로는 종전에 클러스터 감지기만 탔는데,
 * 병합 라벨 셀 + 다중줄 서술형 서식(정부 제출 서식류)은 라인 클러스터로
 * 행 경계를 잡을 수 없다. 괘선은 이미지에 실존하므로 이진화 + 런렝스로
 * 직접 감지한다 — ML 없음, 축 정렬 전제(스캔 스큐 보정은 스코프 밖).
 *
 * 오탐 방어 3겹 (실측: 우수사례 제출 서식 스캔 — 진짜 괘선은 길고 얇음):
 * - 최소 길이 20pt: 글리프 획(가로 ≤한 글자폭·세로 ≤글자높이)은 걸러짐
 * - 두께 상한 2.5pt: 굵은 제목 획(6~13px)·텍스트 줄 밴드·채운 색상바 탈락
 * - 양측 잉크 포위 제외: 색상바(붙임 박스 등) 안 흰 글자 틈새 슬리버 탈락
 */

import type { LineSegment } from "../pdf/line-types.js"

/** 잉크 판정 휘도 상한 — 셀 배경 음영(회색 ~220)은 통과, 실선(진회~검정·남색)만 잉크 */
const INK_LUMA_MAX = 190
/** 최소 선 길이 (pt) — 최소 셀 변(≈7mm)과 대형 글리프 획(≤1em) 사이 */
const MIN_LINE_LENGTH_PT = 20
/** 선 두께 상한 (pt) — 진짜 괘선(0.12~0.7mm ≈ 0.3~2pt)과 굵은 글리프 획(2pt+) 분리 */
const MAX_LINE_WIDTH_PT = 2.5
/** 런 내 허용 끊김 (px) — 스캔 노이즈/JPEG 아티팩트 */
const GAP_TOL_PX = 2
/** 밴드 병합 시 요구하는 x(또는 y) 범위 겹침 비율 (짧은 쪽 기준) */
const BAND_OVERLAP_RATIO = 0.5
/** 밴드 양측(±2px)이 이 비율 이상 잉크면 채운 영역 내부 슬리버로 판정 */
const SURROUND_INK_RATIO = 0.35

/** 픽셀 공간(top-left origin) 선분 — 두께는 밴드 픽셀 수 */
export interface PxSegment {
  x1: number; y1: number
  x2: number; y2: number
  thicknessPx: number
}

export interface RulingLines {
  horizontals: PxSegment[]
  verticals: PxSegment[]
}

/**
 * RGBA 래스터에서 수평/수직 괘선 감지.
 * @param scale 렌더 스케일 (px/pt) — 길이·두께 임계를 pt 기준으로 환산
 */
export function detectRulingLines(
  rgba: Uint8Array,
  width: number,
  height: number,
  scale: number,
): RulingLines {
  const minLenPx = Math.round(MIN_LINE_LENGTH_PT * scale)
  const maxThickPx = Math.max(1, Math.floor(MAX_LINE_WIDTH_PT * scale))

  // 잉크 마스크 1회 구축 — 수평/수직 두 패스가 공유
  const ink = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
    // ITU-R BT.601 휘도 근사 (정수 시프트)
    const luma = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
    if (luma <= INK_LUMA_MAX && rgba[i + 3] >= 128) ink[p] = 1
  }

  const horizontals = detectBands(ink, width, height, minLenPx, maxThickPx, false)
  const verticals = detectBands(ink, width, height, minLenPx, maxThickPx, true)
  return { horizontals, verticals }
}

/** 열린 밴드 — 인접 스캔라인의 런을 누적 */
interface Band {
  lo: number // 런 진행축 시작 (h: x1, v: y1)
  hi: number // 런 진행축 끝
  first: number // 직교축 시작 스캔라인 (h: yTop, v: xLeft)
  last: number // 직교축 마지막 스캔라인
}

/**
 * 스캔라인 런렝스 → 인접 라인 밴드 병합 → 두께 필터 → 선분 방출.
 * transpose=false 면 수평선(행 스캔), true 면 수직선(열 스캔).
 */
function detectBands(
  ink: Uint8Array,
  width: number,
  height: number,
  minLenPx: number,
  maxThickPx: number,
  transpose: boolean,
): PxSegment[] {
  const lines = transpose ? width : height // 스캔라인 개수 (직교축)
  const span = transpose ? height : width // 런 진행축 길이
  const at = transpose
    ? (line: number, pos: number) => ink[pos * width + line]
    : (line: number, pos: number) => ink[line * width + pos]

  const out: PxSegment[] = []
  let open: Band[] = []

  /** 밴드 양측(±2px 스캔라인)의 잉크 비율 — 채운 색상바 안 흰 글자 틈새 슬리버 판별 */
  const surroundInkRatio = (b: Band, side: number): number => {
    if (side < 0 || side >= lines) return 0
    let dark = 0, total = 0
    for (let pos = b.lo; pos <= b.hi; pos += 3) {
      total++
      if (at(side, pos) === 1) dark++
    }
    return total > 0 ? dark / total : 0
  }

  const emit = (b: Band) => {
    const thick = b.last - b.first + 1
    if (thick > maxThickPx) return // 색상바·텍스트 밴드
    if (
      surroundInkRatio(b, b.first - 2) >= SURROUND_INK_RATIO &&
      surroundInkRatio(b, b.last + 2) >= SURROUND_INK_RATIO
    ) return // 채운 영역 내부 슬리버
    const center = (b.first + b.last) / 2
    out.push(
      transpose
        ? { x1: center, y1: b.lo, x2: center, y2: b.hi, thicknessPx: thick }
        : { x1: b.lo, y1: center, x2: b.hi, y2: center, thicknessPx: thick },
    )
  }

  for (let line = 0; line < lines; line++) {
    // 1) 이 스캔라인의 잉크 런 수집 (GAP_TOL_PX 이하 끊김 허용)
    const runs: Array<{ lo: number; hi: number }> = []
    let runStart = -1
    let gap = 0
    for (let pos = 0; pos <= span; pos++) {
      const on = pos < span && at(line, pos) === 1
      if (on) {
        if (runStart < 0) runStart = pos
        gap = 0
      } else if (runStart >= 0) {
        if (++gap > GAP_TOL_PX || pos >= span) {
          const hi = pos - gap
          if (hi - runStart + 1 >= minLenPx) runs.push({ lo: runStart, hi })
          runStart = -1
          gap = 0
        }
      }
    }

    // 2) 열린 밴드와 병합 — 직전 스캔라인까지 이어졌고 범위가 겹치면 확장
    const next: Band[] = []
    const used = new Set<number>()
    for (const band of open) {
      if (band.last !== line - 1) { emit(band); continue } // 연속 끊김 → 확정
      let merged = false
      for (let r = 0; r < runs.length; r++) {
        if (used.has(r)) continue
        const run = runs[r]
        const overlap = Math.min(band.hi, run.hi) - Math.max(band.lo, run.lo) + 1
        const shorter = Math.min(band.hi - band.lo, run.hi - run.lo) + 1
        if (overlap >= shorter * BAND_OVERLAP_RATIO) {
          band.lo = Math.min(band.lo, run.lo)
          band.hi = Math.max(band.hi, run.hi)
          band.last = line
          next.push(band)
          used.add(r)
          merged = true
          break
        }
      }
      if (!merged) emit(band)
    }
    for (let r = 0; r < runs.length; r++) {
      if (!used.has(r)) next.push({ lo: runs[r].lo, hi: runs[r].hi, first: line, last: line })
    }
    open = next
  }
  for (const band of open) emit(band)
  return out
}

/**
 * 픽셀 선분 → PDF pt LineSegment (bottom-up, classifyAndAdd 규약:
 * 수평선 y1==y2·x1<x2, 수직선 x1==x2·y1<y2).
 */
export function rulingToPdfLines(
  ruling: RulingLines,
  scale: number,
  pdfHeight: number,
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const horizontals: LineSegment[] = ruling.horizontals.map(s => {
    const y = pdfHeight - (s.y1 + s.y2) / 2 / scale
    return {
      x1: Math.min(s.x1, s.x2) / scale,
      y1: y,
      x2: Math.max(s.x1, s.x2) / scale,
      y2: y,
      lineWidth: s.thicknessPx / scale,
    }
  })
  const verticals: LineSegment[] = ruling.verticals.map(s => {
    const x = (s.x1 + s.x2) / 2 / scale
    const yA = pdfHeight - Math.max(s.y1, s.y2) / scale
    const yB = pdfHeight - Math.min(s.y1, s.y2) / scale
    return { x1: x, y1: yA, x2: x, y2: yB, lineWidth: s.thicknessPx / scale }
  })
  return { horizontals, verticals }
}

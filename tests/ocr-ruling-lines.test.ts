import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectRulingLines, rulingToPdfLines } from "../src/ocr/ruling-lines.js"

// ─── 합성 래스터 헬퍼 ─────────────────────────────────
// 흰 배경 RGBA 캔버스에 잉크(어두운 픽셀)를 그려 스캔 페이지를 흉내낸다.

function makeCanvas(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4)
  rgba.fill(255)
  return rgba
}

function ink(rgba: Uint8Array, w: number, x: number, y: number, v = 0) {
  const i = (y * w + x) * 4
  rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255
}

/** 수평선: (x1..x2, y), thickness px */
function drawHLine(rgba: Uint8Array, w: number, x1: number, x2: number, y: number, thick = 2) {
  for (let t = 0; t < thick; t++) for (let x = x1; x <= x2; x++) ink(rgba, w, x, y + t)
}

/** 수직선: (x, y1..y2), thickness px */
function drawVLine(rgba: Uint8Array, w: number, x: number, y1: number, y2: number, thick = 2) {
  for (let t = 0; t < thick; t++) for (let y = y1; y <= y2; y++) ink(rgba, w, x + t, y)
}

/** 채운 사각형 (제목 색상바 등) */
function drawFilledRect(rgba: Uint8Array, w: number, x1: number, y1: number, x2: number, y2: number) {
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) ink(rgba, w, x, y)
}

/** 글자 흉내 — 세로 30px 획들이 촘촘히 이어지는 텍스트 밴드 */
function drawTextBand(rgba: Uint8Array, w: number, x1: number, x2: number, yTop: number, glyphH = 30) {
  for (let x = x1; x <= x2; x++) {
    if (x % 8 < 5) for (let y = yTop; y < yTop + glyphH; y++) ink(rgba, w, x, y)
  }
}

const SCALE = 3 // OCR 렌더 스케일 (216dpi)

describe("detectRulingLines — 래스터 괘선 감지", () => {
  it("2×2 그리드의 수평 3·수직 3선을 좌표 오차 ±2px 내로 감지", () => {
    const w = 900, h = 600
    const rgba = makeCanvas(w, h)
    // 그리드: x 100..800, y 100..500, 중간 x=450, y=300
    drawHLine(rgba, w, 100, 800, 100)
    drawHLine(rgba, w, 100, 800, 300)
    drawHLine(rgba, w, 100, 800, 500)
    drawVLine(rgba, w, 100, 100, 500)
    drawVLine(rgba, w, 450, 100, 500)
    drawVLine(rgba, w, 800, 100, 500)

    const { horizontals, verticals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(horizontals.length, 3, "수평선 3개")
    assert.equal(verticals.length, 3, "수직선 3개")

    const hYs = horizontals.map(s => (s.y1 + s.y2) / 2).sort((a, b) => a - b)
    for (const [i, expect] of [100, 300, 500].entries()) {
      assert.ok(Math.abs(hYs[i] - expect) <= 2, `수평선 y=${expect} (실제 ${hYs[i]})`)
    }
    const vXs = verticals.map(s => (s.x1 + s.x2) / 2).sort((a, b) => a - b)
    for (const [i, expect] of [100, 450, 800].entries()) {
      assert.ok(Math.abs(vXs[i] - expect) <= 2, `수직선 x=${expect} (실제 ${vXs[i]})`)
    }
    // 스팬 확인 (병합셀 그리드 구성에 x/y 범위가 정확해야 함)
    for (const s of horizontals) {
      assert.ok(Math.abs(s.x1 - 100) <= 2 && Math.abs(s.x2 - 800) <= 2, "수평선 x 범위")
    }
  })

  it("채운 사각형(제목 색상바)은 선으로 오탐하지 않음", () => {
    const w = 900, h = 300
    const rgba = makeCanvas(w, h)
    drawFilledRect(rgba, w, 100, 50, 700, 110) // 두께 60px 색상바
    const { horizontals, verticals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(horizontals.length, 0, "색상바에서 수평선 미검출")
    assert.equal(verticals.length, 0, "색상바에서 수직선 미검출")
  })

  it("텍스트 밴드는 선으로 오탐하지 않음", () => {
    const w = 900, h = 300
    const rgba = makeCanvas(w, h)
    drawTextBand(rgba, w, 100, 800, 100)
    const { horizontals, verticals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(horizontals.length, 0, "텍스트에서 수평선 미검출")
    assert.equal(verticals.length, 0, "텍스트에서 수직선 미검출")
  })

  it("짧은 장식선(체크박스 등)은 무시", () => {
    const w = 900, h = 300
    const rgba = makeCanvas(w, h)
    // 15pt × scale3 = 45px 미만
    drawHLine(rgba, w, 100, 130, 100)
    drawVLine(rgba, w, 200, 100, 130)
    const { horizontals, verticals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(horizontals.length, 0)
    assert.equal(verticals.length, 0)
  })

  it("1~2px 끊김(스캔 노이즈)이 있어도 한 선으로 이어 감지", () => {
    const w = 900, h = 300
    const rgba = makeCanvas(w, h)
    drawHLine(rgba, w, 100, 400, 100)
    drawHLine(rgba, w, 403, 800, 100) // 2px 갭
    const { horizontals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(horizontals.length, 1, "갭 너머로 병합")
    assert.ok(Math.abs(horizontals[0].x1 - 100) <= 2 && Math.abs(horizontals[0].x2 - 800) <= 2)
  })

  it("굵은 제목 획(두께 8px·길이 90px)은 선으로 오탐하지 않음", () => {
    const w = 900, h = 300
    const rgba = makeCanvas(w, h)
    drawHLine(rgba, w, 100, 190, 100, 8) // 대형 볼드 글리프 가로획
    drawVLine(rgba, w, 400, 80, 170, 8) // 대형 볼드 글리프 세로획
    const { horizontals, verticals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(horizontals.length, 0, "굵은 가로획 미검출")
    assert.equal(verticals.length, 0, "굵은 세로획 미검출")
  })

  it("색상바 안 흰 글자 틈새(잉크 포위 슬리버)는 선으로 오탐하지 않음", () => {
    const w = 900, h = 300
    // 남색 바(80..760 × 50..170) 위에 흰 세로 획들 — 붙임 박스 흉내
    const rgba = makeCanvas(w, h)
    drawFilledRect(rgba, w, 80, 50, 760, 170)
    for (let gx = 120; gx <= 720; gx += 40) {
      for (let y = 60; y <= 160; y++) for (let t = 0; t < 20; t++) ink(rgba, w, gx + t, y, 255)
    }
    const { verticals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(verticals.length, 0, "색상바 틈새 세로 슬리버 미검출")
  })

  it("옅은 셀 배경 음영(회색 220)은 잉크로 취급하지 않음", () => {
    const w = 900, h = 300
    const rgba = makeCanvas(w, h)
    for (let y = 80; y <= 200; y++) for (let x = 100; x <= 800; x++) ink(rgba, w, x, y, 220)
    const { horizontals, verticals } = detectRulingLines(rgba, w, h, SCALE)
    assert.equal(horizontals.length, 0)
    assert.equal(verticals.length, 0)
  })
})

describe("rulingToPdfLines — 픽셀 → PDF pt 좌표 변환", () => {
  it("y축 뒤집기(bottom-up) + 스케일 환산 + LineSegment 규약(y1==y2, x1<x2)", () => {
    const pdfH = 200 // pt
    const scale = 3
    const ruling = {
      horizontals: [{ x1: 90, y1: 149, x2: 600, y2: 150, thicknessPx: 2 }],
      verticals: [{ x1: 300, y1: 60, x2: 301, y2: 450, thicknessPx: 2 }],
    }
    const { horizontals, verticals } = rulingToPdfLines(ruling, scale, pdfH)

    assert.equal(horizontals.length, 1)
    const hl = horizontals[0]
    assert.equal(hl.y1, hl.y2, "수평선 y1==y2")
    assert.ok(Math.abs(hl.y1 - (pdfH - 150 / scale)) <= 1, `수평선 y pt (실제 ${hl.y1})`)
    assert.ok(hl.x1 < hl.x2 && Math.abs(hl.x1 - 30) <= 1 && Math.abs(hl.x2 - 200) <= 1)

    assert.equal(verticals.length, 1)
    const vl = verticals[0]
    assert.equal(vl.x1, vl.x2, "수직선 x1==x2")
    assert.ok(Math.abs(vl.x1 - 100) <= 1)
    assert.ok(vl.y1 < vl.y2, "수직선 y1<y2 (bottom-up)")
    assert.ok(Math.abs(vl.y1 - (pdfH - 450 / scale)) <= 1 && Math.abs(vl.y2 - (pdfH - 60 / scale)) <= 1)
  })
})

/**
 * bridgeSplitColumnVerticals 단위 테스트 (v4.0.6 예산서 부서명 유실).
 *
 * 세출예산 사업명세서류 표는 요약행 밴드(재원구분 시/구 행)에 수직 괘선이
 * 없어 동일 열 수직선이 위/아래로 끊긴다 — Union-Find 그룹이 파편화되어
 * 헤더행·부서/정책 요약행이 그리드에서 탈락하고 부서명이 유실되던 회귀.
 * 브리지는 (a)간격 상한 (b)간격 내부 수평선 실존 (c)3열+ 동시 단절
 * (d)내부 열 경계와 끝점 정합(셀 단위 행 괘선 증거)을 모두 요구한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { bridgeSplitColumnVerticals, buildTableGrids } from "../src/pdf/line-detector.js"
import type { LineSegment } from "../src/pdf/line-detector.js"

const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 1 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 1 })

const COLS = [40, 290, 390, 470, 550]

describe("bridgeSplitColumnVerticals — 무괘선 요약행 밴드 브리지", () => {
  it("무괘선 밴드로 끊긴 동일 열 수직선을 잇고 한 그리드로 복원한다 (예산서 축소)", () => {
    // 사업명세서 실측 축소: 헤더 스트립(618~650) + 본표(100~520) 사이 무괘선
    // 밴드(520~618)에 셀 단위로 쪼개 그은 요약행 괘선(y=560)만 존재.
    const horizontals = [
      h(650, 40, 550), h(620, 40, 550), // 헤더 스트립
      // 요약행 하변 — 셀 단위 세그먼트 (끝점이 열 경계 290/390/470과 정합)
      h(560, 40, 290), h(560, 290, 390), h(560, 390, 470), h(560, 470, 550),
      h(520, 40, 550), h(400, 40, 550), h(300, 40, 550), h(200, 40, 550), h(100, 40, 550), // 본표
    ]
    const verticals = [
      ...COLS.map(x => v(x, 618, 650)), // 헤더 스트립
      ...COLS.map(x => v(x, 100, 520)), // 본표 — 밴드(520~618)에서 끊김
    ]

    const bridged = bridgeSplitColumnVerticals(horizontals, verticals)
    assert.equal(bridged.length, verticals.length + COLS.length, "열마다 브리지 세그먼트 1개 합성")
    for (const x of COLS) {
      const synth = bridged.find(l => l.x1 === x && l.y1 === 100 && l.y2 === 650)
      assert.ok(synth, `x=${x} 브리지가 위/아래 이웃 세그먼트 전체를 덮어야 함 (75% 커버 판정용)`)
    }

    const grids = buildTableGrids(horizontals, bridged)
    assert.equal(grids.length, 1, "파편화 없이 한 그리드여야 함")
    assert.equal(grids[0].rowYs.length - 1, 7, "요약행 밴드(520~560~620)가 행으로 편입")
    assert.equal(grids[0].colXs.length - 1, 4)

    // 브리지 없이는 헤더 스트립이 별도 그리드로 파편화되는 원 결함 확인
    const broken = buildTableGrids(horizontals, verticals)
    assert.ok(broken.length >= 2, "브리지 없인 파편화 (결함 재현)")
  })

  it("간격 내부에 수평선이 없는 별개 적층 표는 잇지 않는다", () => {
    // 열 구조가 같은 표 두 개가 위아래로 놓임 — 사이는 빈 공간
    const horizontals = [
      h(600, 40, 550), h(500, 40, 550), h(400, 40, 550), // 위 표
      h(300, 40, 550), h(200, 40, 550), h(100, 40, 550), // 아래 표
    ]
    const verticals = [
      ...COLS.map(x => v(x, 400, 600)),
      ...COLS.map(x => v(x, 100, 300)),
    ]
    const bridged = bridgeSplitColumnVerticals(horizontals, verticals)
    assert.equal(bridged.length, verticals.length, "합성 없음")
    assert.equal(buildTableGrids(horizontals, bridged).length, 2, "두 표 유지")
  })

  it("간격 내부의 단일 전폭 구분선(제목 밑줄류)만으론 잇지 않는다 — 끝점 정합 가드", () => {
    const horizontals = [
      h(600, 40, 550), h(500, 40, 550), h(400, 40, 550),
      h(350, 40, 550), // 표 사이 전폭 구분선 — 끝점이 외곽에만 정합
      h(300, 40, 550), h(200, 40, 550), h(100, 40, 550),
    ]
    const verticals = [
      ...COLS.map(x => v(x, 400, 600)),
      ...COLS.map(x => v(x, 100, 300)),
    ]
    const bridged = bridgeSplitColumnVerticals(horizontals, verticals)
    assert.equal(bridged.length, verticals.length, "합성 없음")
  })

  it("동시 단절 열이 3개 미만이면 잇지 않는다", () => {
    const xs = [40, 550]
    const horizontals = [
      h(650, 40, 550), h(620, 40, 550),
      h(560, 40, 290), h(560, 290, 550),
      h(520, 40, 550), h(400, 40, 550),
    ]
    const verticals = [
      ...xs.map(x => v(x, 618, 650)),
      ...xs.map(x => v(x, 400, 520)),
    ]
    const bridged = bridgeSplitColumnVerticals(horizontals, verticals)
    assert.equal(bridged.length, verticals.length, "합성 없음")
  })

  it("간격이 상한(120pt)을 넘으면 잇지 않는다", () => {
    const horizontals = [
      h(700, 40, 550), h(670, 40, 550),
      h(500, 40, 290), h(500, 290, 550), // 내부 세그먼트 수평선 존재해도
      h(400, 40, 550), h(300, 40, 550),
    ]
    const verticals = [
      ...COLS.map(x => v(x, 668, 700)),
      ...COLS.map(x => v(x, 300, 400)), // 간격 668-400=268 > 120
    ]
    const bridged = bridgeSplitColumnVerticals(horizontals, verticals)
    assert.equal(bridged.length, verticals.length, "합성 없음")
  })
})

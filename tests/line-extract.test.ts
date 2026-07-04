/**
 * closeOpenTableEdges (개방변 표 테두리 합성) 단위 테스트.
 *
 * 회귀: 끝점 정렬 그룹핑이 폭만 보고 y-간격 제약이 없어, 위아래로 쌓인 두 개방변 표를
 * yMin~yMax 관통 가상 수직테두리로 "용접"하고 사이 본문을 거대 병합셀로 흡수하던 자료손상.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { closeOpenTableEdges } from "../src/pdf/line-detector.js"
import type { LineSegment } from "../src/pdf/line-detector.js"

const h = (y: number): LineSegment => ({ x1: 100, y1: y, x2: 500, y2: y, lineWidth: 0.5 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.5 })

describe("closeOpenTableEdges — 상하 스택 표 용접 방지", () => {
  it("스택된 두 개방변 표를 사이 본문 관통 테두리로 용접하지 않는다", () => {
    // 표 A: y660/680/700, 표 B: y560/580/600 (둘 다 x100~500, 좌우 테두리 없음)
    // 사이 본문 프로즈: y600~660
    const horizontals = [h(560), h(580), h(600), h(660), h(680), h(700)]
    const verticals = [v(300, 560, 600), v(300, 660, 700)]  // 각 표의 내부 수직선
    const result = closeOpenTableEdges(horizontals, verticals)
    const synth = result.filter(s => !verticals.includes(s))

    // 프로즈 간격(600~660)을 관통하는 합성 테두리가 없어야 한다 (용접 금지)
    const welds = synth.filter(s => s.y1 <= 600 && s.y2 >= 660)
    assert.equal(welds.length, 0, `표 사이를 용접하는 테두리 발생: ${JSON.stringify(welds)}`)
    // 각 표는 개별적으로 닫혀야 한다 (표당 좌우 2개 → 4개)
    assert.equal(synth.length, 4, `표별 좌우 테두리가 합성돼야 함: ${JSON.stringify(synth)}`)
    // 합성 테두리는 표 A(660~700) 또는 표 B(560~600) 한쪽에만 걸쳐야 함
    for (const s of synth) {
      const inB = s.y1 >= 560 - 1 && s.y2 <= 600 + 1
      const inA = s.y1 >= 660 - 1 && s.y2 <= 700 + 1
      assert.ok(inA || inB, `테두리가 한 표 안에 있어야 함: ${JSON.stringify(s)}`)
    }
  })

  it("연속 단일 개방변 표에는 y-간격 분할이 발동하지 않는다 (무회귀)", () => {
    // 균일 간격(20) 단일 표 — 분할 없이 표 전체를 닫는 좌우 테두리 2개
    const horizontals = [h(600), h(620), h(640), h(660)]
    const verticals = [v(300, 600, 660)]
    const result = closeOpenTableEdges(horizontals, verticals)
    const synth = result.filter(s => !verticals.includes(s))

    assert.equal(synth.length, 2, `단일 표는 좌우 테두리 2개: ${JSON.stringify(synth)}`)
    for (const s of synth) {
      assert.ok(s.y1 <= 601 && s.y2 >= 659, `테두리가 표 전체(600~660)를 닫아야 함: ${JSON.stringify(s)}`)
    }
  })

  it("한 행만 유난히 큰 간격은 분할하지 않는다 (한쪽 괘선 수 부족)", () => {
    // 3줄 + 큰 간격 + 1줄: 아래쪽이 최소 괘선 수(3) 미만이라 쪼개지 않음 → 단일 표 유지
    const horizontals = [h(600), h(620), h(640), h(760)]
    const verticals = [v(300, 600, 760)]
    const result = closeOpenTableEdges(horizontals, verticals)
    const synth = result.filter(s => !verticals.includes(s))
    // 분할되지 않고 전체 y범위(600~760)를 닫는 테두리
    const spanning = synth.filter(s => s.y1 <= 601 && s.y2 >= 759)
    assert.ok(spanning.length >= 1, `단일 표로 유지돼 전체를 닫아야 함: ${JSON.stringify(synth)}`)
  })
})

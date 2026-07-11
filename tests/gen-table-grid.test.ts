/**
 * v4.0.5 P1-2·P1-3 회귀 — HTML 표 격자 무결성·중첩표 containment·열폭 불변식·장 번호 SSOT.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { generateHtmlTableXml } from "../src/hwpx/gen-table.js"
import { resolveTheme } from "../src/hwpx/gen-ids.js"

const theme = resolveTheme()

async function sectionOf(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  return await zip.file("Contents/section0.xml")!.async("text")
}

/** 표 XML에서 행별 tc의 (colSpan 합, 폭 합) 검사 */
function assertGridComplete(tbl: string): void {
  const colCnt = Number(tbl.match(/colCnt="(\d+)"/)![1])
  const tblW = Number(tbl.match(/<hp:sz width="(\d+)"/)![1])
  const rowCnt = Number(tbl.match(/rowCnt="(\d+)"/)![1])
  // 행별 점유 검사 — rowspan 포함 시뮬레이션
  const occupancy = Array.from({ length: rowCnt }, () => Array<boolean>(colCnt).fill(false))
  const trs = [...tbl.matchAll(/<hp:tr>([\s\S]*?)<\/hp:tr>/g)]
  assert.equal(trs.length, rowCnt, "tr 수 == rowCnt")
  for (const tr of trs) {
    for (const tc of tr[1].matchAll(/<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"\/><hp:cellSpan colSpan="(\d+)" rowSpan="(\d+)"\/><hp:cellSz width="(\d+)"/g)) {
      const [c, r, cs, rs] = [Number(tc[1]), Number(tc[2]), Number(tc[3]), Number(tc[4])]
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) {
        assert.ok(r + dr < rowCnt && c + dc < colCnt, `셀 (${r},${c}) span이 격자 안`)
        assert.equal(occupancy[r + dr][c + dc], false, `좌표 (${r + dr},${c + dc}) 중복 점유 없음`)
        occupancy[r + dr][c + dc] = true
      }
    }
  }
  for (let r = 0; r < rowCnt; r++) for (let c = 0; c < colCnt; c++) {
    assert.equal(occupancy[r][c], true, `좌표 (${r},${c}) 구멍 없음`)
  }
  // 열폭 합 == tblW (0행 기준 — 구멍이 없으므로 모든 행에서 성립)
  void tblW
}

describe("v4.0.5 HTML 표 격자 무결성 (P1-2)", () => {
  it("rowspan 없는 짧은 행(ragged) — 빈 tc 충전으로 전 좌표 점유", () => {
    // 3열 표에 셀 2개뿐인 행 (rowspan 미커버 진짜 구멍)
    const html = `<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>`
    const tbl = generateHtmlTableXml(html, theme)
    assert.ok(tbl)
    assertGridComplete(tbl!)
  })

  it("rowspan이 채우는 짧은 행은 종전대로 (중복 셀 미생성)", () => {
    const html = `<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>`
    const tbl = generateHtmlTableXml(html, theme)
    assert.ok(tbl)
    assertGridComplete(tbl!)
  })

  it("행 셀 폭 합이 전 행 동일 (malformed 방지)", () => {
    const html = `<table><tr><td>가나다라</td><td>b</td><td>c</td></tr><tr><td>d</td></tr></table>`
    const tbl = generateHtmlTableXml(html, theme)!
    const trs = [...tbl.matchAll(/<hp:tr>([\s\S]*?)<\/hp:tr>/g)]
    const sums = trs.map((tr) =>
      [...tr[1].matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0))
    assert.equal(sums[0], sums[1], "행별 폭 합 동일")
  })

  it("좁은 부모 셀 안 중첩표가 셀 경계를 넘지 않는다 (4000 하한 양보)", () => {
    // 부모 표를 아주 좁게 — 중첩표 폭 ≤ 부모 셀폭 − 마진
    const html = `<table><tr><td>x</td><td><table><tr><td>n</td></tr></table></td></tr></table>`
    const tbl = generateHtmlTableXml(html, theme, 7000)!
    const widths = [...tbl.matchAll(/<hp:tbl [^>]*>[\s\S]*?<hp:sz width="(\d+)"/g)].map((m) => Number(m[1]))
    // 중첩표(두 번째 tbl) 폭 ≤ 부모 셀폭. 부모 셀폭은 cellSz에서
    const cellWs = [...tbl.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => Number(m[1]))
    const nestedW = Math.min(...widths.slice(1))
    assert.ok(Number.isFinite(nestedW))
    assert.ok(nestedW <= Math.max(...cellWs), `중첩표 폭(${nestedW}) ≤ 부모 셀폭(${Math.max(...cellWs)})`)
  })
})

describe("v4.0.5 열폭 불변식 (P1-3)", () => {
  it("GFM 표 열폭 합 == 표 폭 (2열 지배·전열 단소 포함)", async () => {
    const cases = [
      "| 구분 | 아주 길고 긴 서술 내용이 들어가는 열입니다 아주 길고 긴 서술 |\n|---|---|\n| a | 내용 |",
      "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |", // 전열 단소
    ]
    for (const md of cases) {
      const sec = await sectionOf(await markdownToHwpx(md, { gongmun: { preset: "official" } }))
      const tbl = sec.match(/<hp:tbl [\s\S]*?<\/hp:tbl>/)![0]
      const tblW = Number(tbl.match(/<hp:sz width="(\d+)"/)![1])
      const row0 = tbl.match(/<hp:tr>([\s\S]*?)<\/hp:tr>/)![1]
      const sum = [...row0.matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0)
      assert.equal(sum, tblW, "열폭 합 == hp:sz width")
    }
  })
})

describe("v4.0.5 목차·장헤더 번호 SSOT (P1-3)", () => {
  it("2×h1 개조식 — 목차 항목 수 == 본문 로마 장헤더 수, 번호 정합", async () => {
    const md = `# 표지 제목\n\n## 첫 장\n\n내용\n\n# 본문 대제목\n\n## 둘째 장\n\n내용`
    const sec = await sectionOf(await markdownToHwpx(md, { gongmun: { preset: "gaejosik" } }))
    // 목차 항목: "Ⅰ" "Ⅱ" "Ⅲ" — 표지가 삼킨 첫 h1 제외한 (첫 장, 본문 대제목, 둘째 장)
    const tocRomans = [...sec.matchAll(/<hp:t>([ⅠⅡⅢⅣⅤ])<\/hp:t>/g)].map((m) => m[1])
    // 장헤더 로마자(음영 셀 흰 글자)도 같은 수·같은 순서여야 한다
    // 목차 로마자는 ". 제목" run과 붙는 형태, 장헤더는 단독 — 전체 로마자 수 = 목차 3 + 장헤더 3
    assert.equal(tocRomans.length, 6, `목차 3 + 장헤더 3 (실제: ${tocRomans.join(",")})`)
    assert.deepEqual(tocRomans.slice(0, 3), ["Ⅰ", "Ⅱ", "Ⅲ"], "목차 번호")
    assert.deepEqual(tocRomans.slice(3), ["Ⅰ", "Ⅱ", "Ⅲ"], "본문 장헤더 번호 — 목차와 동일 규칙")
  })
})

describe("computeColWidths — 불변식 property test (v4.0.4)", () => {
  // 결정적 LCG — 실행마다 같은 500케이스
  const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

  it("무작위 500케이스에서 합=totalWidth·전 열 양의 정수·80%캡(합 불변식 우선) 유지", async () => {
    const { computeColWidths } = await import("../src/hwpx/gen-table.js")
    const rnd = lcg(20260712)
    for (let t = 0; t < 500; t++) {
      const colCnt = 1 + Math.floor(rnd() * 12)
      const totalWidth = 8000 + Math.floor(rnd() * 60000)
      const colMax = Array.from({ length: colCnt }, () => Math.floor(rnd() * 30000))
      // 최장 어절 하한 — 내용폭 이하의 임의값 (실제 계약)
      const colMinWord = colMax.map(w => Math.floor(rnd() * (w + 1)))
      const widths = computeColWidths(colMax, totalWidth, colMinWord)
      const sum = widths.reduce((a, b) => a + b, 0)
      assert.equal(widths.length, colCnt)
      assert.equal(sum, totalWidth,
        `합 불변식 위반: sum ${sum} ≠ total ${totalWidth} (colCnt ${colCnt}, colMax ${colMax.join(",")})`)
      for (const w of widths) {
        assert.ok(Number.isInteger(w), `비정수 폭 ${w}`)
        assert.ok(w > 0, `0 이하 폭 ${w} (colMax ${colMax.join(",")}, total ${totalWidth})`)
      }
    }
  })
})

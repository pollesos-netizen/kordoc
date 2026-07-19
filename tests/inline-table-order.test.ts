/**
 * 인라인 표·텍스트 문서 순서 보존 (#49/#50, v4.2.3)
 *
 * #50 — 최상위 blocks: 한 문단 안에서 treatAsChar 표 뒤에 오는 텍스트가
 *        표보다 앞 블록으로 나오던 역전 수정 (walkSection 문단 분할 방출).
 * #49 — IRCell.blocks: 셀 안에서 표·텍스트가 번갈아 놓이면 텍스트가 한 문단으로
 *        병합되어 앞으로 이동하던 것 수정 (생성기 원문 배치 보존 + 파서 분할 방출).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { markdownToHwpx, parseHwpx } from "../src/index.js"

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

function sec(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`
}

async function makeHwpx(sectionXml: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", sectionXml)
  return await zip.generateAsync({ type: "arraybuffer" })
}

/** treatAsChar 1×1 인라인 표 */
function inlineTbl(id: number, cellText: string): string {
  return `<hp:tbl id="${id}" rowCnt="1" colCnt="1">` +
    `<hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="COLUMN"/>` +
    `<hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>${cellText}</hp:t></hp:run></hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>` +
    `<hp:cellSz width="1000" height="300"/></hp:tc></hp:tr></hp:tbl>`
}

function shape(b: { type: string; text?: string; table?: { cells: { text: string }[][] } }): string {
  if (b.type === "table") return `table(${b.table!.cells[0][0].text})`
  return `${b.type}(${b.text})`
}

describe("#50 — 최상위 blocks 인라인 표·텍스트 문서 순서", () => {
  it("한 run 안에서 [표] 텍스트 순서면 표가 앞 블록으로 나온다", async () => {
    const body = `<hp:p id="1" paraPrIDRef="0"><hp:run charPrIDRef="0">` +
      inlineTbl(1, "구매요구총액") + `<hp:t>  첨 부 서 류 :</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    assert.deepEqual(r.blocks.map(shape), ["table(구매요구총액)", "paragraph(첨 부 서 류 :)"])
  })

  it("텍스트 [표] 텍스트 — 앞뒤 조각이 표를 사이에 두고 분할 방출된다", async () => {
    const body = `<hp:p id="1" paraPrIDRef="0"><hp:run charPrIDRef="0">` +
      `<hp:t>라벨: </hp:t>` + inlineTbl(1, "값") + `<hp:t> 이후 안내</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    assert.deepEqual(r.blocks.map(shape), ["paragraph(라벨:)", "table(값)", "paragraph(이후 안내)"])
  })

  it("텍스트가 표 앞에만 있으면 기존과 동일 (텍스트 → 표)", async () => {
    const body = `<hp:p id="1" paraPrIDRef="0"><hp:run charPrIDRef="0">` +
      `<hp:t>제목 문구</hp:t>` + inlineTbl(1, "본문") + `</hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    assert.deepEqual(r.blocks.map(shape), ["paragraph(제목 문구)", "table(본문)"])
  })

  it("표 없는 문단은 종전 경로 그대로 (단일 paragraph)", async () => {
    const body = `<hp:p id="1" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>평범한 문단</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    assert.deepEqual(r.blocks.map(shape), ["paragraph(평범한 문단)"])
  })
})

describe("#49 — IRCell.blocks 셀 안 표·텍스트 교대 배치 순서 (라운드트립)", () => {
  it("[표] 부터 [표] 까지 — blocks가 원문 배치 순서로 보존된다", async () => {
    const md = "<table><tr><td>계획일정</td><td>" +
      "<table><tr><td>2026-01-01</td></tr></table> 부터 " +
      "<table><tr><td>2026-12-31</td></tr></table> 까지" +
      "</td></tr></table>"
    const r = await parseHwpx(Buffer.from(await markdownToHwpx(md)))
    assert.ok(r.success)
    const outer = r.blocks.find((b) => b.type === "table")
    assert.ok(outer?.table)
    const cell = outer.table.cells[0][1]
    assert.ok(cell.blocks, "교대 배치 셀은 blocks를 보존해야 함")
    assert.deepEqual(
      cell.blocks.map(shape),
      ["table(2026-01-01)", "paragraph(부터)", "table(2026-12-31)", "paragraph(까지)"],
      "어느 날짜가 시작이고 끝인지 구분 가능해야 함 (#49)"
    )
    // 평탄화 text도 문서 순서 (하위 호환 필드)
    assert.equal(cell.text, "2026-01-01\n부터\n2026-12-31\n까지")
  })

  it("텍스트 뒤 중첩표 셀은 기존 순서 유지 (텍스트 → 표)", async () => {
    const md = "<table><tr><td>구분</td><td>안내문<br>" +
      "<table><tr><td>세부표</td></tr></table>" +
      "</td></tr></table>"
    const r = await parseHwpx(Buffer.from(await markdownToHwpx(md)))
    assert.ok(r.success)
    const outer = r.blocks.find((b) => b.type === "table")
    const cell = outer!.table!.cells[0][1]
    assert.ok(cell.blocks)
    assert.deepEqual(cell.blocks.map(shape), ["paragraph(안내문)", "table(세부표)"])
  })
})

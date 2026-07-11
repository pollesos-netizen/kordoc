/**
 * CLI/MCP 표면 파리티 (v4.0.6 회귀) — 프로필 경계 검증(profile-io)과
 * 프리셋 비호환 옵션 경고(incompatibleGongmunWarnings)의 순수 로직 잠금.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseFormatProfileJson } from "../src/hwpx/profile-io.js"
import { incompatibleGongmunWarnings } from "../src/hwpx/gongmun.js"
import { markdownToHwpx, hwpxToProfile } from "../src/index.js"

describe("parseFormatProfileJson — 프로필 JSON 경계 검증", () => {
  it("추출 프로필(hwpxToProfile)이 스키마를 통과한다 (왕복 정합)", async () => {
    const buf = await markdownToHwpx("| 구분 | 금액 |\n| --- | --- |\n| 세입 | 100 |\n")
    const profile = await hwpxToProfile(buf)
    const parsed = parseFormatProfileJson(JSON.stringify(profile))
    assert.equal(parsed.tables.length, profile.tables.length)
  })
  it("손편집 오타 JSON은 위치·사유와 함께 거부", () => {
    assert.throws(() => parseFormatProfileJson('{"tables":[{"rows":0}]}'), /스키마 불일치.*table_index/)
    assert.throws(() => parseFormatProfileJson("not json"), /JSON 파싱 실패/)
  })
  it("괘선 값 검증 (v4.0.4) — type 열거·width mm 형식·color 16진을 거부한다", () => {
    const tbl = (bf: object) => JSON.stringify({
      tables: [{ table_index: 0, rows: 1, cols: 1, cells: [], used_border_fills: { "1": bf } }],
    })
    // 오타 type(SOILD)·px 단위 width·3자리 색상 — 한컴 로드 전 거부
    assert.throws(() => parseFormatProfileJson(tbl({ topBorder: { type: "SOILD", width: "0.1 mm", color: "#000000" } })), /스키마 불일치/)
    assert.throws(() => parseFormatProfileJson(tbl({ topBorder: { type: "SOLID", width: "2px", color: "#000000" } })), /mm 단위/)
    assert.throws(() => parseFormatProfileJson(tbl({ topBorder: { type: "SOLID", width: "0.1 mm", color: "#00f" } })), /RRGGBB/)
    assert.throws(() => parseFormatProfileJson(tbl({ fill: { faceColor: "blue" } })), /RRGGBB/)
    // 정상 값 + 0.3.0 신규 필드(fontName_hangul·anchor_row) 통과
    const ok = JSON.stringify({
      tables: [{
        table_index: 0, rows: 1, cols: 1, anchor_row: "제목",
        cells: [{ row: 0, col: 0, charPrIDRef: "c" }],
        used_border_fills: { "1": { topBorder: { type: "DOUBLE_SLIM", width: "0.5 mm", color: "#0000FF" }, fill: { faceColor: "none" } } },
        used_char_prs: { "c": { fontName_hangul: "휴먼명조" } },
      }],
    })
    assert.equal(parseFormatProfileJson(ok).tables[0].anchor_row, "제목")
  })
})

describe("incompatibleGongmunWarnings — 프리셋 비호환 옵션 경고", () => {
  it("비호환 조합마다 경고 1건", () => {
    assert.match(incompatibleGongmunWarnings({ preset: "보고서", docHead: { org: "x" } })[0], /doc_head.*무시됨/)
    assert.match(incompatibleGongmunWarnings({ preset: "기안문", noticeHead: { no: "1" } })[0], /notice_head.*무시됨/)
    assert.match(incompatibleGongmunWarnings({ preset: "보도자료", cover: true })[0], /보도자료.*표지·목차/)
    assert.match(incompatibleGongmunWarnings({ preset: "기안문", sizes: { dae: 20 } })[0], /sizes.*무시됨/)
    assert.match(incompatibleGongmunWarnings({ preset: "보고서", suppressSingle: true })[0], /suppress_single.*무동작/)
  })
  it("호환 조합은 경고 없음", () => {
    assert.equal(incompatibleGongmunWarnings({ preset: "기안문", docHead: { org: "x" }, suppressSingle: true }).length, 0)
    assert.equal(incompatibleGongmunWarnings({ preset: "개조식", sizes: { dae: 20 } }).length, 0)
    // plan에 numbering standard 병기 시 suppressSingle 유효 (문서화된 우회로)
    assert.equal(incompatibleGongmunWarnings({ preset: "계획서", numbering: "standard", suppressSingle: true }).length, 0)
  })
})

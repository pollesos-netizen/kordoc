/**
 * patchHwp (HWP5 서식 보존 라운드트립 패치) 테스트 — 합성 CFB 컨테이너 기반.
 *
 * 검증 항목: 문단 텍스트 교체(nChars/CHAR_SHAPE/LINE_SEG 연쇄 갱신), 표 셀 수정,
 * no-op 바이트 동일성, 컨트롤 문단 graceful skip, 암호화 거부, 특수문자/길이 변화,
 * 비수정 스트림 바이트 보존.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "module"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { patchHwp, splitParaText } from "../src/roundtrip/hwp5-patch.js"
import { parseHwp5Document } from "../src/hwp5/parser.js"
import { FLAG_ENCRYPTED, readRecords, TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CHAR_SHAPE } from "../src/hwp5/record.js"

const require = createRequire(import.meta.url)
const CFB = require("cfb")

// ─── 합성 HWP 빌더 ───────────────────────────────────

function rec(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20), 0)
  return Buffer.concat([header, data])
}

function utf16(s: string): Buffer {
  return Buffer.from(s, "utf16le")
}

/** PARA_HEADER(24B) + PARA_TEXT(+0x0d) + CHAR_SHAPE(8B) + LINE_SEG(36B) */
function paragraph(text: string, level = 0): Buffer {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(text.length + 1, 0) // nChars (문단끝 포함)
  header.writeUInt32LE(0, 4)               // ctrlMask
  header.writeUInt16LE(1, 12)              // charShapeCount
  header.writeUInt16LE(0, 14)              // rangeTagCount
  header.writeUInt16LE(1, 16)              // lineSegCount
  const textData = Buffer.concat([utf16(text), Buffer.from([0x0d, 0x00])])
  return Buffer.concat([
    rec(0x42, level, header),
    rec(0x43, level + 1, textData),
    rec(0x44, level + 1, Buffer.alloc(8)),
    rec(0x45, level + 1, Buffer.alloc(36)),
  ])
}

/** 탭(인라인 컨트롤) 포함 문단 — ctrlMask에 탭 비트 세팅 */
function paragraphWithTab(text: string): Buffer {
  const tab = Buffer.alloc(16)
  tab.writeUInt16LE(0x09, 0)
  const textData = Buffer.concat([tab, utf16(text), Buffer.from([0x0d, 0x00])])
  const header = Buffer.alloc(24)
  header.writeUInt32LE(textData.length / 2, 0)
  header.writeUInt32LE(1 << 9, 4) // ctrlMask: 탭
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(1, 16)
  return Buffer.concat([
    rec(0x42, 0, header),
    rec(0x43, 1, textData),
    rec(0x44, 1, Buffer.alloc(8)),
    rec(0x45, 1, Buffer.alloc(36)),
  ])
}

/** PARA_TEXT 레코드 자체가 없는 빈 문단 — 한컴의 빈 문단 생략 저장형 (nChars=1, 문단끝만 계상) */
function noTextParagraph(level = 0): Buffer {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(1, 0)  // nChars = 1 (문단끝) — PARA_TEXT 없음
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(1, 16)
  return Buffer.concat([
    rec(0x42, level, header),
    rec(0x44, level + 1, Buffer.alloc(8)),
    rec(0x45, level + 1, Buffer.alloc(36)),
  ])
}

/** 2x2 표 (앵커 문단 + tbl 컨트롤 + 셀 4개). 셀 값 null = PARA_TEXT 생략형 빈 문단 */
function table2x2(cells: (string | null)[][]): Buffer {
  const anchorHeader = Buffer.alloc(24)
  const ctrlChar = Buffer.alloc(16)
  ctrlChar.writeUInt16LE(0x0b, 0)
  ctrlChar.write(" lbt", 2, "ascii") // "tbl " LE on-disk
  ctrlChar.writeUInt16LE(0x0b, 14)
  const anchorText = Buffer.concat([ctrlChar, Buffer.from([0x0d, 0x00])])
  anchorHeader.writeUInt32LE(anchorText.length / 2, 0)
  anchorHeader.writeUInt32LE(1 << 11, 4) // ctrlMask: 개체
  anchorHeader.writeUInt16LE(1, 12)
  anchorHeader.writeUInt16LE(1, 16)

  const tableData = Buffer.alloc(8)
  tableData.writeUInt16LE(2, 4)
  tableData.writeUInt16LE(2, 6)

  const parts = [
    rec(0x42, 0, anchorHeader),
    rec(0x43, 1, anchorText),
    rec(0x44, 1, Buffer.alloc(8)),
    rec(0x45, 1, Buffer.alloc(36)),
    rec(0x47, 1, Buffer.concat([Buffer.from(" lbt", "ascii"), Buffer.alloc(42)])),
    rec(0x4d, 2, tableData),
  ]
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const lh = Buffer.alloc(34)
      lh.writeUInt16LE(1, 0)  // paraCount
      lh.writeUInt16LE(c, 8)  // colAddr
      lh.writeUInt16LE(r, 10) // rowAddr
      lh.writeUInt16LE(1, 12)
      lh.writeUInt16LE(1, 14)
      parts.push(rec(0x48, 2, lh))
      const v = cells[r][c]
      parts.push(v === null ? noTextParagraph(2) : paragraph(v, 2))
    }
  }
  return Buffer.concat(parts)
}

/** 병합셀 표 (HTML 렌더) — (0,0)이 colSpan=2로 첫 행 병합, 둘째 행은 일반 셀 2개. null = PARA_TEXT 생략형 빈 문단 */
function tableMerged(headerText: string, leftText: string | null, rightText: string): Buffer {
  const anchorHeader = Buffer.alloc(24)
  const ctrlChar = Buffer.alloc(16)
  ctrlChar.writeUInt16LE(0x0b, 0)
  ctrlChar.write(" lbt", 2, "ascii")
  ctrlChar.writeUInt16LE(0x0b, 14)
  const anchorText = Buffer.concat([ctrlChar, Buffer.from([0x0d, 0x00])])
  anchorHeader.writeUInt32LE(anchorText.length / 2, 0)
  anchorHeader.writeUInt32LE(1 << 11, 4)
  anchorHeader.writeUInt16LE(1, 12)
  anchorHeader.writeUInt16LE(1, 16)

  const tableData = Buffer.alloc(8)
  tableData.writeUInt16LE(2, 4) // rows
  tableData.writeUInt16LE(2, 6) // cols

  const parts = [
    rec(0x42, 0, anchorHeader),
    rec(0x43, 1, anchorText),
    rec(0x44, 1, Buffer.alloc(8)),
    rec(0x45, 1, Buffer.alloc(36)),
    rec(0x47, 1, Buffer.concat([Buffer.from(" lbt", "ascii"), Buffer.alloc(42)])),
    rec(0x4d, 2, tableData),
  ]
  // (0,0) colSpan=2 (병합), (1,0), (1,1)
  const defs = [
    { col: 0, row: 0, cs: 2, rs: 1, text: headerText },
    { col: 0, row: 1, cs: 1, rs: 1, text: leftText },
    { col: 1, row: 1, cs: 1, rs: 1, text: rightText },
  ]
  for (const d of defs) {
    const lh = Buffer.alloc(34)
    lh.writeUInt16LE(1, 0)       // paraCount
    lh.writeUInt16LE(d.col, 8)   // colAddr
    lh.writeUInt16LE(d.row, 10)  // rowAddr
    lh.writeUInt16LE(d.cs, 12)   // colSpan
    lh.writeUInt16LE(d.rs, 14)   // rowSpan
    parts.push(rec(0x48, 2, lh))
    parts.push(d.text === null ? noTextParagraph(2) : paragraph(d.text, 2))
  }
  return Buffer.concat(parts)
}

/**
 * 선두에 개체(0x0b, 16바이트) 앵커 + 본문 텍스트가 있는 문단.
 * CHAR_SHAPE는 multi-run [(0,id0),(8,id1)] — 개체(pos 0~7) / 텍스트(pos 8~).
 * 정부 보도자료 본문의 전형(도형/이미지가 문단 선두에 앵커)을 합성한다.
 */
function anchorParagraph(text: string, level = 0): Buffer {
  const anchor = Buffer.alloc(16)        // 개체 inline control: 2 + 14바이트 = 8 WCHAR
  anchor.writeUInt16LE(0x0b, 0)
  anchor.writeUInt16LE(0x0b, 14)
  const textData = Buffer.concat([anchor, utf16(text), Buffer.from([0x0d, 0x00])])
  const header = Buffer.alloc(24)
  header.writeUInt32LE(textData.length / 2, 0)  // nChars = 8(개체) + text + 1(문단끝)
  header.writeUInt32LE(1 << 11, 4)              // ctrlMask: 개체
  header.writeUInt16LE(2, 12)                   // charShapeCount = 2 (multi-run)
  header.writeUInt16LE(0, 14)
  header.writeUInt16LE(1, 16)
  const cs = Buffer.alloc(16)                    // [(pos0, shape100), (pos8, shape200)]
  cs.writeUInt32LE(0, 0); cs.writeUInt32LE(100, 4)
  cs.writeUInt32LE(8, 8); cs.writeUInt32LE(200, 12)
  return Buffer.concat([
    rec(0x42, level, header),
    rec(0x43, level + 1, textData),
    rec(0x44, level + 1, cs),
    rec(0x45, level + 1, Buffer.alloc(36)),
  ])
}

/** 합성 HWP 파일 (무압축, CFB) */
function buildHwp(sectionParts: Buffer[], flags = 0): Uint8Array {
  const fileHeader = Buffer.alloc(256)
  fileHeader.write("HWP Document File", 0, "ascii")
  fileHeader[35] = 5
  fileHeader.writeUInt32LE(flags, 36)

  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/FileHeader", fileHeader)
  CFB.utils.cfb_add(cfb, "/DocInfo", Buffer.alloc(0))
  CFB.utils.cfb_add(cfb, "/BodyText/Section0", Buffer.concat(sectionParts))
  CFB.utils.cfb_add(cfb, "/PrvText", utf16("미리보기"))
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Buffer)
}

// ─── 테스트 ──────────────────────────────────────────

describe("patchHwp — 문단 텍스트 교체", () => {
  it("문단 수정이 적용되고 재파싱에 반영된다", async () => {
    const hwp = buildHwp([paragraph("첫 번째 문단입니다"), paragraph("두 번째 문단입니다")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const edited = md.replace("두 번째 문단입니다", "수정된 두 번째 문단")

    const r = await patchHwp(hwp, edited)
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.equal(r.skipped.length, 0)
    const reparsed = parseHwp5Document(Buffer.from(r.data!))
    assert.ok(reparsed.markdown.includes("수정된 두 번째 문단"))
    assert.ok(reparsed.markdown.includes("첫 번째 문단입니다"))
    assert.equal(r.verification?.stats.added, 0)
    assert.equal(r.verification?.stats.removed, 0)
    assert.equal(r.verification?.stats.modified, 0)
  })

  it("길이가 크게 달라져도 nChars/레코드 크기가 정합 (축소/확장)", async () => {
    const hwp = buildHwp([paragraph("원래 텍스트"), paragraph("바뀔 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const long = "이 텍스트는 원본보다 훨씬 길어서 레코드 크기 재계산을 시험합니다 ".repeat(20).trim()

    const r1 = await patchHwp(hwp, md.replace("바뀔 문단", long))
    assert.equal(r1.success, true)
    assert.equal(r1.applied, 1)
    assert.ok(parseHwp5Document(Buffer.from(r1.data!)).markdown.includes("시험합니다"))

    const r2 = await patchHwp(hwp, md.replace("바뀔 문단", "짧"))
    assert.equal(r2.success, true)
    assert.equal(r2.applied, 1)
    assert.ok(parseHwp5Document(Buffer.from(r2.data!)).markdown.includes("짧"))
  })

  it("특수문자/이모지(서로게이트 페어) 텍스트가 보존된다", async () => {
    const hwp = buildHwp([paragraph("교체 대상 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const special = "조건 x < 3 & \"y\" > 5 😀 별점"
    const r = await patchHwp(hwp, md.replace("교체 대상 문단", special))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.ok(parseHwp5Document(Buffer.from(r.data!)).markdown.includes("😀"))
  })

  it("no-op 패치는 원본과 바이트 동일", async () => {
    const hwp = buildHwp([paragraph("그대로인 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md)
    assert.equal(r.success, true)
    assert.equal(r.applied, 0)
    assert.deepEqual(Buffer.from(r.data!), Buffer.from(hwp))
  })
})

describe("patchHwp — 표 셀", () => {
  it("GFM 표 셀 수정이 좌표 기반으로 적용된다", async () => {
    const hwp = buildHwp([
      paragraph("표 앞 문단"),
      table2x2([["항목", "값"], ["점수", "80"]]),
    ])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    assert.ok(md.includes("| 점수 | 80 |"), `GFM 표 렌더 확인: ${md}`)
    const r = await patchHwp(hwp, md.replace("| 점수 | 80 |", "| 점수 | 95 |"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    const reparsed = parseHwp5Document(Buffer.from(r.data!)).markdown
    assert.ok(reparsed.includes("| 점수 | 95 |"))
    assert.ok(reparsed.includes("| 항목 | 값 |"))
  })

  it("부등호(<) 평문 셀 — HTML 태그로 오인하지 않고 수정 적용", async () => {
    const hwp = buildHwp([
      table2x2([["유의확률", "값"], ["P-value", "<0.01"]]),
    ])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    assert.ok(md.includes("<0.01"), `부등호 셀 렌더 확인: ${md}`)
    const r = await patchHwp(hwp, md.replace("<0.01", "<0.05"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.equal(r.skipped.length, 0)
    const reparsed = parseHwp5Document(Buffer.from(r.data!)).markdown
    assert.ok(reparsed.includes("<0.05"))
  })
})

describe("splitParaText — PARA_TEXT 분해 무손실/안전", () => {
  it("선두 개체(0x0b 16B) + 텍스트 + 문단끝 → 무손실 분해 + prefixUnits=8(WCHAR)", () => {
    const anchor = Buffer.alloc(16)
    anchor.writeUInt16LE(0x0b, 0); anchor.writeUInt16LE(0x0b, 14)
    const data = Buffer.concat([anchor, utf16("본문 텍스트"), Buffer.from([0x0d, 0x00])])
    const seg = splitParaText(data)
    assert.ok(seg)
    assert.equal(seg!.prefixUnits, 8)   // 개체 16바이트 = 8 WCHAR (control 확장 포함)
    assert.equal(seg!.suffixUnits, 1)   // 문단끝 0x0d
    assert.equal(seg!.core, "본문 텍스트")
    // 무손실 재조립 — prefix + core + suffix == 원본 (한컴 변조감지 방지의 근간)
    const re = Buffer.concat([seg!.prefix, Buffer.from(seg!.core, "utf16le"), seg!.suffix])
    assert.ok(re.equals(data))
  })

  it("탭 등 가시 control이 텍스트와 섞이면 null (보수적 미지원)", () => {
    const tab = Buffer.alloc(16); tab.writeUInt16LE(0x09, 0)
    const data = Buffer.concat([utf16("A"), tab, utf16("B"), Buffer.from([0x0d, 0x00])])
    assert.equal(splitParaText(data), null)
  })

  it("일반 텍스트 문단(control 없음)도 동일 경로로 무손실 분해", () => {
    const data = Buffer.concat([utf16("순수 텍스트 문단"), Buffer.from([0x0d, 0x00])])
    const seg = splitParaText(data)
    assert.ok(seg)
    assert.equal(seg!.prefixUnits, 0)
    assert.equal(seg!.core, "순수 텍스트 문단")
    const re = Buffer.concat([seg!.prefix, Buffer.from(seg!.core, "utf16le"), seg!.suffix])
    assert.ok(re.equals(data))
  })

  it("문단끝(0x0d)만 있는 빈 문단 → 빈 코어 분해 (suffix=문단끝)", () => {
    const seg = splitParaText(Buffer.from([0x0d, 0x00]))
    assert.ok(seg)
    assert.equal(seg!.core, "")
    assert.equal(seg!.prefixUnits, 0)
    assert.equal(seg!.suffixUnits, 1)
    assert.ok(Buffer.concat([seg!.prefix, seg!.suffix]).equals(Buffer.from([0x0d, 0x00])))
  })

  it("개체(0x0b)만 + 문단끝 빈 문단 → 개체는 prefix (새 텍스트가 개체 뒤에 붙도록)", () => {
    const anchor = Buffer.alloc(16)
    anchor.writeUInt16LE(0x0b, 0); anchor.writeUInt16LE(0x0b, 14)
    const data = Buffer.concat([anchor, Buffer.from([0x0d, 0x00])])
    const seg = splitParaText(data)
    assert.ok(seg)
    assert.equal(seg!.core, "")
    assert.equal(seg!.prefixUnits, 8)
    assert.equal(seg!.suffixUnits, 1)
    const re = Buffer.concat([seg!.prefix, Buffer.from(seg!.core, "utf16le"), seg!.suffix])
    assert.ok(re.equals(data))
  })

  it("탭(가시 control)만 있는 빈 문단 → null 유지 (보수적 미지원)", () => {
    const tab = Buffer.alloc(16); tab.writeUInt16LE(0x09, 0)
    assert.equal(splitParaText(Buffer.concat([tab, Buffer.from([0x0d, 0x00])])), null)
  })

  it("완전 빈 데이터 → 빈 코어 분해", () => {
    const seg = splitParaText(Buffer.alloc(0))
    assert.ok(seg)
    assert.equal(seg!.core, "")
    assert.equal(seg!.prefixUnits, 0)
    assert.equal(seg!.suffixUnits, 0)
  })
})

describe("patchHwp — 빈 셀 채우기", () => {
  it("빈 PARA_TEXT([0x0d]) 셀 값 채우기 — 치환 경로", async () => {
    const hwp = buildHwp([table2x2([["항목", ""], ["점수", "80"]])])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    assert.ok(md.includes("| 항목 |  |"), `빈 셀 렌더 확인: ${md}`)
    const r = await patchHwp(hwp, md.replace("| 항목 |  |", "| 항목 | 신규값 |"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.equal(r.skipped.length, 0)
    const re = parseHwp5Document(Buffer.from(r.data!)).markdown
    assert.ok(re.includes("| 항목 | 신규값 |"), `채움 반영: ${re}`)
    assert.ok(re.includes("| 점수 | 80 |"), "미수정 셀 보존")
    assert.equal(r.verification?.stats.modified, 0)
  })

  it("PARA_TEXT 레코드가 없는(nChars=1 생략형) 셀 값 채우기 — 레코드 삽입 경로", async () => {
    const hwp = buildHwp([table2x2([["항목", null], ["점수", "80"]])])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    assert.ok(md.includes("| 항목 |  |"), `빈 셀 렌더 확인: ${md}`)
    const r = await patchHwp(hwp, md.replace("| 항목 |  |", "| 항목 | 삽입값 |"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.equal(r.skipped.length, 0)
    const re = parseHwp5Document(Buffer.from(r.data!)).markdown
    assert.ok(re.includes("| 항목 | 삽입값 |"), `삽입 반영: ${re}`)
    assert.ok(re.includes("| 점수 | 80 |"), "미수정 셀 보존")
    assert.equal(r.verification?.stats.modified, 0)
  })

  it("삽입된 PARA_TEXT 레코드의 nChars/CHAR_SHAPE 정합", async () => {
    const hwp = buildHwp([table2x2([["항목", null], ["점수", "80"]])])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md.replace("| 항목 |  |", "| 항목 | 정합검증 |"))
    assert.equal(r.applied, 1)
    const cfb = CFB.parse(Buffer.from(r.data!))
    const stream = Buffer.from(CFB.find(cfb, "/BodyText/Section0")!.content)
    const recs = readRecords(stream)
    // 채워진 문단: PARA_HEADER nChars = 4(정합검증) + 1(문단끝), 뒤따르는 PARA_TEXT 존재
    const idx = recs.findIndex(rc => rc.tagId === TAG_PARA_TEXT
      && rc.data.subarray(0, 8).toString("utf16le") === "정합검증")
    assert.ok(idx > 0, "삽입된 PARA_TEXT를 찾지 못함")
    assert.equal(recs[idx - 1].tagId, TAG_PARA_HEADER, "PARA_TEXT가 PARA_HEADER 직후에 위치해야 함")
    assert.equal(recs[idx - 1].data.readUInt32LE(0), 5, "nChars = 텍스트 4 + 문단끝 1")
    assert.equal(recs[idx + 1].tagId, TAG_CHAR_SHAPE, "CHAR_SHAPE가 PARA_TEXT 뒤를 따라야 함")
    // 문단끝(0x0d) 포함 확인 — 원본 nChars=1(문단끝 계상)이었으므로
    assert.equal(recs[idx].data.readUInt16LE(recs[idx].data.length - 2), 0x0d)
  })

  it("빈 셀 유지 no-op — 삽입 인프라가 비수정 경로에 영향 없음 (바이트 동일)", async () => {
    for (const cell of ["", null] as const) {
      const hwp = buildHwp([table2x2([["항목", cell], ["점수", "80"]])])
      const md = parseHwp5Document(Buffer.from(hwp)).markdown
      const r = await patchHwp(hwp, md)
      assert.equal(r.success, true)
      assert.equal(r.applied, 0)
      assert.deepEqual(Buffer.from(r.data!), Buffer.from(hwp))
    }
  })

  it("HTML 병합 표의 빈 셀 채우기 — 치환/삽입 양 경로 (applyCellEdit5)", async () => {
    for (const cell of ["", null] as const) {
      const hwp = buildHwp([tableMerged("머리글", cell, "오른쪽")])
      const md = parseHwp5Document(Buffer.from(hwp)).markdown
      assert.ok(md.includes("<table") && md.includes("<td></td>"), `빈 셀 HTML 렌더 확인: ${md}`)
      const r = await patchHwp(hwp, md.replace("<td></td>", "<td>채운값</td>"))
      assert.equal(r.success, true, `${JSON.stringify(r.skipped)}`)
      assert.equal(r.applied, 1, `cell=${JSON.stringify(cell)}: ${JSON.stringify(r.skipped)}`)
      assert.equal(r.skipped.length, 0)
      const re = parseHwp5Document(Buffer.from(r.data!)).markdown
      assert.ok(re.includes("채운값"), `채움 반영: ${re}`)
      assert.ok(re.includes("머리글") && re.includes("오른쪽"), "미수정 셀 보존")
    }
  })
})

// ─── 실파일 스윕 (bench/corpus/hwp5 — gitignore, 존재할 때만 실행) ───

const HWP5_CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus", "hwp5")

describe("patchHwp e2e: 실파일 (.hwp)", { skip: !existsSync(HWP5_CORPUS) }, () => {
  it("no-op 패치는 전 실파일 바이트 동일", async () => {
    const files = readdirSync(HWP5_CORPUS).filter(f => f.endsWith(".hwp"))
    for (const f of files) {
      const buf = readFileSync(join(HWP5_CORPUS, f))
      let md: string
      try { md = parseHwp5Document(buf).markdown } catch { continue }
      const r = await patchHwp(new Uint8Array(buf), md)
      assert.equal(r.success, true, `${f}: ${r.error}`)
      assert.equal(r.applied, 0, f)
      assert.deepEqual(Buffer.from(r.data!), buf, `${f}: no-op 바이트 불일치`)
    }
  })

  it("셀 비우기 → 재채움 왕복 — 실제 한컴 빈 문단 구조에서 채우기 검증", async () => {
    const path = join(HWP5_CORPUS, "merging-cell.hwp")
    if (!existsSync(path)) return
    const buf = readFileSync(path)
    const md = parseHwp5Document(buf).markdown
    assert.ok(md.includes("| 1,1 |"), `표 셀 렌더 확인: ${md.slice(0, 120)}`)

    const r1 = await patchHwp(new Uint8Array(buf), md.replace("| 1,1 |", "|  |"))
    assert.equal(r1.applied, 1, `비우기: ${JSON.stringify(r1.skipped)}`)
    const md1 = parseHwp5Document(Buffer.from(r1.data!)).markdown
    assert.ok(md1.includes("|  |"), "비운 셀이 재파싱에 반영")

    const r2 = await patchHwp(new Uint8Array(Buffer.from(r1.data!)), md1.replace("|  |", "| 재채움 |"))
    assert.equal(r2.applied, 1, `재채움: ${JSON.stringify(r2.skipped)}`)
    assert.equal(r2.skipped.length, 0)
    const md2 = parseHwp5Document(Buffer.from(r2.data!)).markdown
    assert.ok(md2.includes("| 재채움 |"), "재채움이 재파싱에 반영")
    assert.equal(r2.verification?.stats.modified, 0)
  })
})

describe("patchHwp — 개체 앵커 문단 (선두 control 보존)", () => {
  /** 패치본 Section0 레코드에서 개체 문단의 PARA_HEADER/PARA_TEXT/CHAR_SHAPE 정합 검증 */
  function inspectAnchorPara(data: Uint8Array) {
    const cfb = CFB.read(Buffer.from(data), { type: "buffer" })
    const si = cfb.FullPaths.findIndex((x: string) => /BodyText\/Section0$/i.test(x))
    const recs = readRecords(Buffer.from(cfb.FileIndex[si].content as Uint8Array))
    for (let i = 0; i < recs.length; i++) {
      if (recs[i].tagId !== TAG_PARA_HEADER || !(recs[i].data.readUInt32LE(4) & (1 << 11))) continue
      let text: Buffer | null = null, cs: Buffer | null = null
      for (let j = i + 1; j < recs.length && recs[j].level > recs[i].level; j++) {
        if (recs[j].level !== recs[i].level + 1) continue
        if (recs[j].tagId === TAG_PARA_TEXT && !text) text = recs[j].data
        else if (recs[j].tagId === TAG_CHAR_SHAPE && !cs) cs = recs[j].data
      }
      if (text) return { nChars: recs[i].data.readUInt32LE(0) & 0x7fffffff, charShapeCount: recs[i].data.readUInt16LE(12), text, cs: cs! }
    }
    throw new Error("개체 문단 없음")
  }

  it("선두 개체 + 본문 — 길이 변경 수정 시 개체 16바이트 보존 + nChars=WCHAR수 정합", async () => {
    const hwp = buildHwp([anchorParagraph("개체가 앞에 붙은 본문 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    assert.ok(md.includes("개체가 앞에 붙은 본문 문단"), `렌더 확인: ${md}`)

    const r = await patchHwp(hwp, md.replace("개체가 앞에 붙은 본문 문단", "개체가 앞에 붙은 문단을 훨씬 더 길게 고친 본문"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.equal(r.skipped.length, 0)

    const re = parseHwp5Document(Buffer.from(r.data!))
    assert.ok(re.markdown.includes("훨씬 더 길게 고친 본문"))

    const { nChars, text } = inspectAnchorPara(r.data!)
    // nChars는 control 확장 WCHAR 포함 전체 WCHAR 수와 일치해야 한컴 변조감지를 통과
    assert.equal(nChars, text.length / 2, "nChars == PARA_TEXT WCHAR 총수")
    // 선두 개체 16바이트 원본 보존 (0x0b … 0x0b)
    assert.equal(text.readUInt16LE(0), 0x0b)
    assert.equal(text.readUInt16LE(14), 0x0b)
  })

  it("multi-run CHAR_SHAPE — 선두 개체 run 보존 + 코어 서식 유지, position < nChars", async () => {
    const hwp = buildHwp([anchorParagraph("서식 보존 검증 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md.replace("서식 보존 검증 문단", "서식 보존 검증 문단 수정"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)

    const { nChars, charShapeCount, cs } = inspectAnchorPara(r.data!)
    assert.equal(charShapeCount, cs.length / 8, "charShapeCount == CHAR_SHAPE run 수")
    // 개체 run(pos0,shape100) 보존 + 코어 run(pos8,shape200) 유지
    assert.equal(cs.readUInt32LE(0), 0)
    assert.equal(cs.readUInt32LE(4), 100)
    assert.equal(cs.readUInt32LE(8), 8)
    assert.equal(cs.readUInt32LE(12), 200)
    // 마지막 run position이 nChars 미만 (한컴 정합 요건)
    const lastPos = cs.readUInt32LE((cs.length / 8 - 1) * 8)
    assert.ok(lastPos < nChars, `CHAR_SHAPE 마지막 pos(${lastPos}) < nChars(${nChars})`)
  })

  it("개체 문단 LINE_SEG는 원본 그대로 보존 (단일화하지 않음)", async () => {
    const hwp = buildHwp([anchorParagraph("줄 레이아웃 보존 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md.replace("줄 레이아웃 보존 문단", "줄 레이아웃 보존"))
    assert.equal(r.applied, 1)
    // LINE_SEG(0x45) 레코드 바이트가 원본과 동일해야 함
    const orig = CFB.read(Buffer.from(hwp), { type: "buffer" })
    const patched = CFB.read(Buffer.from(r.data!), { type: "buffer" })
    const so = orig.FullPaths.findIndex((x: string) => /Section0$/i.test(x))
    const sp = patched.FullPaths.findIndex((x: string) => /Section0$/i.test(x))
    const ro = readRecords(Buffer.from(orig.FileIndex[so].content as Uint8Array))
    const rp = readRecords(Buffer.from(patched.FileIndex[sp].content as Uint8Array))
    const lsO = ro.find(r => r.tagId === 0x45)!
    const lsP = rp.find(r => r.tagId === 0x45)!
    assert.ok(lsO.data.equals(lsP.data), "LINE_SEG 원본 바이트 보존")
  })
})

describe("patchHwp — 안전 게이트", () => {
  it("컨트롤 문자(탭) 포함 문단은 graceful skip — 파일은 그대로", async () => {
    const hwp = buildHwp([paragraphWithTab("탭이 있는 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const target = md.split("\n\n").find(u => u.includes("탭이 있는 문단"))!
    const r = await patchHwp(hwp, md.replace(target, "탭 없는 새 문단"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 0)
    assert.ok(r.skipped.length >= 1)
    assert.deepEqual(Buffer.from(r.data!), Buffer.from(hwp))
  })

  it("암호화 문서는 전체 거부", async () => {
    const hwp = buildHwp([paragraph("본문")], FLAG_ENCRYPTED)
    const r = await patchHwp(hwp, "아무 마크다운")
    assert.equal(r.success, false)
    assert.match(r.error!, /암호화|배포용|DRM/)
  })

  it("블록 추가/삭제는 skip으로 보고", async () => {
    const hwp = buildHwp([paragraph("하나"), paragraph("둘셋넷")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md + "\n\n새로 추가된 문단")
    assert.equal(r.success, true)
    assert.ok(r.skipped.some(s => s.reason.includes("추가")))
  })

  it("비수정 스트림(PrvText 등)은 바이트 보존", async () => {
    const hwp = buildHwp([paragraph("수정될 문단"), paragraph("고정 문단")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md.replace("수정될 문단", "바뀐 문단"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    const c1 = CFB.parse(Buffer.from(hwp))
    const c2 = CFB.parse(Buffer.from(r.data!))
    for (const p of ["/FileHeader", "/DocInfo", "/PrvText"]) {
      const a = Buffer.from(CFB.find(c1, p).content)
      const b = Buffer.from(CFB.find(c2, p).content)
      assert.deepEqual(b, a, `${p} 스트림이 변경됨`)
    }
    // 이물질 엔트리 미주입 — 원본에 없던 엔트리가 패치본에 생기면 안 됨
    // (합성 원본은 테스트 빌더의 CFB.write가 넣은 Sh33tJ5를 이미 포함 — 그 이상 금지)
    const names1 = new Set<string>(c1.FullPaths)
    for (const p of c2.FullPaths as string[]) {
      assert.ok(names1.has(p), `원본에 없던 엔트리 주입됨: ${JSON.stringify(p)}`)
    }
  })
})

describe("patchHwp — 표 매핑 (시그니처 디스앰비규에이션)", () => {
  it("같은 시그니처 표 2개 — 내용으로 올바른 표에 매핑 (서수 밀림 방지)", async () => {
    const hwp = buildHwp([
      table2x2([["사과", "1"], ["배", "2"]]),
      table2x2([["서울", "9"], ["부산", "8"]]),
    ])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md.replace("| 부산 | 8 |", "| 부산 | 88 |"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    const re = parseHwp5Document(Buffer.from(r.data!)).markdown
    assert.ok(re.includes("| 부산 | 88 |"), "둘째 표 셀 수정 반영")
    assert.ok(re.includes("| 사과 | 1 |"), "첫 표는 무변경 보존")
    assert.ok(re.includes("| 서울 | 9 |"))
  })
})

describe("patchHwp — HTML 병합셀 표", () => {
  it("병합셀 표가 HTML로 렌더되고 일반 셀 수정이 적용된다", async () => {
    const hwp = buildHwp([tableMerged("머리글", "왼쪽 칸", "오른쪽 칸")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    assert.ok(md.includes("<table") && /colspan="2"/i.test(md), `HTML 병합 렌더 확인: ${md}`)
    const r = await patchHwp(hwp, md.replace("오른쪽 칸", "오른쪽 칸 수정"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.equal(r.skipped.length, 0)
    const re = parseHwp5Document(Buffer.from(r.data!)).markdown
    assert.ok(re.includes("오른쪽 칸 수정"))
    assert.ok(re.includes("왼쪽 칸"), "미편집 셀 보존")
    assert.ok(re.includes("머리글"))
  })

  it("병합 헤더 셀(colspan=2) 수정도 적용된다", async () => {
    const hwp = buildHwp([tableMerged("머리글", "왼쪽", "오른쪽")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const r = await patchHwp(hwp, md.replace("머리글", "새 머리글"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.ok(parseHwp5Document(Buffer.from(r.data!)).markdown.includes("새 머리글"))
  })
})

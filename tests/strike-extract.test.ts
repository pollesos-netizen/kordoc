import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { hasRealStrike } from "../src/hwp5/parser.js"
import { isRealStrikeShape, extractHwpxStyles } from "../src/hwpx/styles.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { IRBlock } from "../src/types.js"

// 한컴은 취소선 없는 문자에도 취소선 비트(18-20)를 1로 넣는다 — 판별자는
// 취소선 모양(HWP5: bit 26-29 ≤12, HWPX: shape 화이트리스트) (rhwp 0a967e0d/#154)

describe("hasRealStrike — HWP5 CharShape 취소선 판정", () => {
  const attr = (bits: number, shape: number) => (bits << 18) | (shape << 26)

  it("비트=1 + placeholder 모양(15)은 취소선 아님 (한컴 기본값 함정)", () => {
    assert.equal(hasRealStrike(attr(1, 15)), false)
  })

  it("비트=1 + SOLID(0)는 진짜 취소선", () => {
    assert.equal(hasRealStrike(attr(1, 0)), true)
  })

  it("비트=0이면 모양과 무관하게 취소선 아님", () => {
    assert.equal(hasRealStrike(attr(0, 0)), false)
  })

  it("표 27 경계: 모양 12는 취소선, 13은 fail-closed", () => {
    assert.equal(hasRealStrike(attr(2, 12)), true)
    assert.equal(hasRealStrike(attr(2, 13)), false)
  })

  it("bold/italic 비트와 무간섭", () => {
    assert.equal(hasRealStrike(attr(1, 0) | 0x03), true)
    assert.equal(hasRealStrike(0x03), false)
  })
})

describe("isRealStrikeShape — HWPX strikeout shape 화이트리스트", () => {
  it("실제 선 종류 13종은 true", () => {
    for (const s of ["SOLID", "DASH", "DOT", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH",
      "CIRCLE", "DOUBLE_SLIM", "SLIM_THICK", "THICK_SLIM", "SLIM_THICK_SLIM", "WAVE", "DOUBLE_WAVE"]) {
      assert.equal(isRealStrikeShape(s), true, s)
    }
  })

  it("placeholder·미지 값은 fail-closed", () => {
    for (const s of ["NONE", "3D", "Ghost", "", "solid"]) {
      assert.equal(isRealStrikeShape(s), false, s || "(빈 문자열)")
    }
  })
})

describe("extractHwpxStyles — charPr strikeout 파싱", () => {
  const headerXml = (strikeoutAttr: string) => `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4">
  <hh:refList>
    <hh:charProperties>
      <hh:charPr id="0" height="1000"><hh:strikeout ${strikeoutAttr}/></hh:charPr>
      <hh:charPr id="1" height="1000"/>
    </hh:charProperties>
  </hh:refList>
</hh:head>`

  const makeZip = async (xml: string) => {
    const zip = new JSZip()
    zip.file("Contents/header.xml", xml)
    return zip
  }

  it('shape="SOLID"는 strike=true', async () => {
    const styles = await extractHwpxStyles(await makeZip(headerXml('shape="SOLID"')))
    assert.equal(styles.charProperties.get("0")?.strike, true)
    assert.equal(styles.charProperties.get("1")?.strike, undefined)
  })

  it('placeholder shape="3D"는 strike 미설정 (한컴 익스포터 기본값 함정)', async () => {
    const styles = await extractHwpxStyles(await makeZip(headerXml('shape="3D"')))
    assert.equal(styles.charProperties.get("0")?.strike, undefined)
  })

  it("shape 속성 없는 strikeout 요소도 strike 미설정", async () => {
    const styles = await extractHwpxStyles(await makeZip(headerXml("")))
    assert.equal(styles.charProperties.get("0")?.strike, undefined)
  })
})

describe("blocksToMarkdown — 취소선 span 방출", () => {
  it("strike span은 ~~…~~ 로 감싼다", () => {
    const blocks: IRBlock[] = [{
      type: "paragraph",
      text: "제3조 삭제",
      spans: [{ text: "제3조 " }, { text: "삭제", strike: true }],
    }]
    assert.equal(blocksToMarkdown(blocks).trim(), "제3조 ~~삭제~~")
  })

  it("strike+bold 조합은 ~~**…**~~ (닫힘 역순)", () => {
    const blocks: IRBlock[] = [{
      type: "paragraph",
      text: "중요 삭제",
      spans: [{ text: "중요 " }, { text: "삭제", strike: true, bold: true }],
    }]
    assert.equal(blocksToMarkdown(blocks).trim(), "중요 ~~**삭제**~~")
  })

  it("가장자리 공백은 마커 밖으로", () => {
    const blocks: IRBlock[] = [{
      type: "paragraph",
      text: "a b",
      spans: [{ text: "a" }, { text: " 삭제 ", strike: true }, { text: "b" }],
    }]
    assert.equal(blocksToMarkdown(blocks).trim(), "a ~~삭제~~ b")
  })
})

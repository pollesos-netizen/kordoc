/** place_seal (P6) — 도장 부유 배치: 파트/manifest 추가·float 속성·불확장·검증 통과 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { placeSealHwpx } from "../src/form/seal.js"
import { validateHwpx } from "../src/validate.js"
import { parse } from "../src/index.js"
import { KordocError } from "../src/utils.js"

/** 1×1 투명 PNG */
const PNG_1PX = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
)

const FORM_MD = `# 신청서

| 신청인 | 홍길동 (인) |
| --- | --- |

담당자 서명 또는 인
`

describe("placeSealHwpx", () => {
  it("표 셀 앵커에 부유 도장 — 파트/manifest 추가 + float 속성 + validate 통과", async () => {
    const buf = await markdownToHwpx(FORM_MD)
    const result = await placeSealHwpx(buf, [{ anchor: "(인)", image: PNG_1PX }])

    assert.equal(result.placed.length, 1)
    const p = result.placed[0]
    assert.equal(p.anchor, "(인)")
    assert.ok(p.sizeMm >= 7 && p.sizeMm <= 18, `크기 클램프: ${p.sizeMm}`)
    assert.equal(p.entry, "BinData/image1.png")

    const zip = await JSZip.loadAsync(result.buffer)
    // 이미지 파트 바이트 보존
    const img = await zip.file("BinData/image1.png")!.async("uint8array")
    assert.deepEqual([...img], [...PNG_1PX], "도장 PNG 바이트 보존")
    // manifest 등재
    const hpf = await zip.file("Contents/content.hpf")!.async("string")
    assert.match(hpf, /<opf:item id="image1" href="BinData\/image1\.png" media-type="image\/png" isEmbeded="1"\/>/)
    // 부유 개체 핵심 속성 — flowWithText="0" 아니면 한컴이 셀/페이지를 키운다
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.match(sec, /textWrap="IN_FRONT_OF_TEXT"/)
    assert.match(sec, /treatAsChar="0"[^>]*flowWithText="0"[^>]*allowOverlap="1"/)
    assert.match(sec, /binaryItemIDRef="image1"/)

    // 구조 검증 (manifest 참조·웰폼드 — 한컴독스 거부 요인)
    const v = await validateHwpx(result.buffer)
    assert.equal(v.ok, true, `validate 실패: ${JSON.stringify(v.issues)}`)

    // 재파싱 — 본문 텍스트 불변
    const reparsed = await parse(result.buffer)
    assert.equal(reparsed.success, true)
    assert.match(reparsed.markdown ?? "", /홍길동/)
    assert.match(reparsed.markdown ?? "", /서명 또는 인/)
  })

  it("본문 문단 앵커('서명 또는 인')에도 배치된다", async () => {
    const buf = await markdownToHwpx(FORM_MD)
    const result = await placeSealHwpx(buf, [{ anchor: "서명 또는 인", image: PNG_1PX }])
    assert.equal(result.placed.length, 1)
    const v = await validateHwpx(result.buffer)
    assert.equal(v.ok, true)
  })

  it("occurrence 로 N번째 앵커 선택 — 0/1이 서로 다른 위치", async () => {
    const md = `첫 결재란 (인)\n\n둘째 결재란 (인)\n`
    const buf = await markdownToHwpx(md)
    const r0 = await placeSealHwpx(buf, [{ anchor: "(인)", occurrence: 0, image: PNG_1PX }])
    const r1 = await placeSealHwpx(buf, [{ anchor: "(인)", occurrence: 1, image: PNG_1PX }])
    assert.equal(r0.placed[0].occurrence, 0)
    assert.equal(r1.placed[0].occurrence, 1)

    const sec0 = await (await JSZip.loadAsync(r0.buffer)).file("Contents/section0.xml")!.async("string")
    const sec1 = await (await JSZip.loadAsync(r1.buffer)).file("Contents/section0.xml")!.async("string")
    const picPos0 = sec0.indexOf("<hp:pic")
    const picPos1 = sec1.indexOf("<hp:pic")
    assert.ok(picPos0 !== -1 && picPos1 !== -1)
    assert.ok(picPos1 > picPos0, "둘째 앵커의 pic 이 문서 뒤쪽에 삽입")
  })

  it("overlap 은 right 보다 왼쪽에 놓인다", async () => {
    const buf = await markdownToHwpx("결재 (인) 자리 여유 많음\n")
    const ov = await placeSealHwpx(buf, [{ anchor: "(인)", mode: "overlap", image: PNG_1PX }])
    const rt = await placeSealHwpx(buf, [{ anchor: "(인)", mode: "right", image: PNG_1PX }])
    assert.ok(ov.placed[0].posXMm < rt.placed[0].posXMm)
  })

  it("도장 2개 배치 — 파트 번호 증가·manifest 2건", async () => {
    const md = `갑 (인)\n\n을 (인)\n`
    const buf = await markdownToHwpx(md)
    const result = await placeSealHwpx(buf, [
      { anchor: "(인)", occurrence: 0, image: PNG_1PX },
      { anchor: "(인)", occurrence: 1, image: PNG_1PX },
    ])
    assert.equal(result.placed.length, 2)
    assert.equal(result.placed[0].entry, "BinData/image1.png")
    assert.equal(result.placed[1].entry, "BinData/image2.png")
    const v = await validateHwpx(result.buffer)
    assert.equal(v.ok, true)
  })

  it("앵커 미발견 — 등장 횟수 안내 에러", async () => {
    const buf = await markdownToHwpx("도장 칸 없는 문서\n")
    await assert.rejects(
      placeSealHwpx(buf, [{ anchor: "(인)", image: PNG_1PX }]),
      (err: unknown) => err instanceof KordocError && /0회 등장/.test((err as Error).message),
    )
  })

  it("occurrence 초과 — 범위 안내 에러", async () => {
    const buf = await markdownToHwpx("하나뿐 (인)\n")
    await assert.rejects(
      placeSealHwpx(buf, [{ anchor: "(인)", occurrence: 3, image: PNG_1PX }]),
      (err: unknown) => err instanceof KordocError && /occurrence 0\.\.0/.test((err as Error).message),
    )
  })
})

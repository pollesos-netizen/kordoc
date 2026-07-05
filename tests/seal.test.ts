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
    // 가로 원점 COLUMN — PARA 는 셀 안에서 바깥 문단 기준이 되어 도장이 옆 셀로 밀린다 (P1 실측)
    assert.match(sec, /horzRelTo="COLUMN"/)
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

describe("도장 배치 엣지 회귀 (seal-1/4/5/8)", () => {
  it("seal-1: rowSpan 결재란에서 덮인 행 앵커가 같은 열에 정렬(열 오프셋 면역)", async () => {
    const md = `<table><tr><td rowspan="2">결재</td><td>담당 (인)</td></tr><tr><td>과장 (인)</td></tr></table>`
    const buf = await markdownToHwpx(md)
    const r = await placeSealHwpx(buf, [
      { anchor: "(인)", occurrence: 0, image: PNG_1PX },
      { anchor: "(인)", occurrence: 1, image: PNG_1PX },
    ])
    // 두 앵커는 같은 그리드 열(col1) — posXMm 이 같아야 (rowSpan 덮인 행 오프셋 0 회귀 방지)
    assert.equal(r.placed[0].posXMm, r.placed[1].posXMm, "rowSpan 덮인 행도 같은 열 오프셋")
  })
  it("seal-4: NaN·음수 sizeMm 는 기본 크기로 폴백 (hp:sz='NaN' XML 방지)", async () => {
    const buf = await markdownToHwpx("도장 (인)\n")
    const r = await placeSealHwpx(buf, [{ anchor: "(인)", sizeMm: NaN, image: PNG_1PX }])
    assert.ok(Number.isFinite(r.placed[0].sizeMm) && r.placed[0].sizeMm > 0, `NaN → 기본 크기 (실제: ${r.placed[0].sizeMm})`)
  })
  it("seal-5: 확장자와 다른 매직바이트(비-PNG)는 거부", async () => {
    const buf = await markdownToHwpx("도장 (인)\n")
    await assert.rejects(
      placeSealHwpx(buf, [{ anchor: "(인)", image: new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), ext: "png" }]),
      (err: unknown) => err instanceof KordocError && /매직바이트/.test((err as Error).message),
    )
  })
  it("seal-8: 중첩표 셀 앵커는 근사 한계 경고를 낸다", async () => {
    const md = `<table><tr><td>외곽<table><tr><td>서명 (인)</td></tr></table></td></tr></table>`
    const buf = await markdownToHwpx(md)
    const r = await placeSealHwpx(buf, [{ anchor: "(인)", image: PNG_1PX }])
    assert.ok(r.placed[0].warnings?.some(w => /중첩표/.test(w)), `중첩표 경고 기대: ${JSON.stringify(r.placed[0].warnings)}`)
  })
  it("seal-1: 가로 병합(colspan) 제목행이 아래 데이터행 열 오프셋을 밀지 않는다", async () => {
    // colspan2 헤더 + 3열 데이터행. col2 앵커 오프셋이 헤더가 3열로 분리된 동일 표와 같아야 —
    // colspan 병합폭이 한 열에 이중계상되면 도장이 한 열(≈50mm) 오른쪽=표 밖으로 밀린다.
    const merged = `<table><tr><td colspan="2">제목</td><td>C</td></tr><tr><td>가나다</td><td>라마바</td><td>사아 (인)</td></tr></table>`
    const split = `<table><tr><td>제</td><td>목</td><td>C</td></tr><tr><td>가나다</td><td>라마바</td><td>사아 (인)</td></tr></table>`
    const rM = await placeSealHwpx(await markdownToHwpx(merged), [{ anchor: "(인)", image: PNG_1PX }])
    const rS = await placeSealHwpx(await markdownToHwpx(split), [{ anchor: "(인)", image: PNG_1PX }])
    assert.ok(
      Math.abs(rM.placed[0].posXMm - rS.placed[0].posXMm) < 5,
      `colspan 헤더가 col2 오프셋을 밀면 안 됨: merged=${rM.placed[0].posXMm} split=${rS.placed[0].posXMm}`,
    )
  })
  it("seal-2: 중첩표 앵커는 바깥 셀 좌측 오프셋을 가산한다 (도장이 옆 셀로 안 밀림)", async () => {
    // 바깥 col1 안 중첩표 vs 바깥 col0 안 중첩표 — col1 쪽이 바깥 col0 폭만큼 오른쪽이어야
    // (바깥 체인 미가산이면 둘이 같아 도장이 왼쪽 셀로 밀린다 — 한컴 실측으로 확정한 원점 모델).
    const right = `<table><tr><td>왼쪽 바깥 셀 넓게 채운다</td><td><table><tr><td>서명 (인)</td></tr></table></td></tr></table>`
    const left = `<table><tr><td><table><tr><td>서명 (인)</td></tr></table></td><td>오른쪽 바깥 셀</td></tr></table>`
    const rR = await placeSealHwpx(await markdownToHwpx(right), [{ anchor: "(인)", image: PNG_1PX }])
    const rL = await placeSealHwpx(await markdownToHwpx(left), [{ anchor: "(인)", image: PNG_1PX }])
    assert.ok(
      rR.placed[0].posXMm - rL.placed[0].posXMm > 20,
      `중첩표 바깥 셀 오프셋 미가산: right=${rR.placed[0].posXMm} left=${rL.placed[0].posXMm}`,
    )
  })
})

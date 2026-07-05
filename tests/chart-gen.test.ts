/** 차트 생성 (P5) — ```chart 펜스 → chartSpace 파트 + <hp:chart>, 폴백·검증 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { parseChartFence, buildChartSpaceXml } from "../src/hwpx/chart-gen.js"
import { validateHwpx } from "../src/validate.js"
import { parse } from "../src/index.js"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"
import { precomputeGongmunList } from "../src/hwpx/gen-gongmun-fit.js"
import { resolveGongmun } from "../src/hwpx/gongmun.js"

const COLUMN_MD = `# 보고

\`\`\`chart
type: column
cat: 1분기, 2분기, 3분기
예산: 100, 120, 110
집행: 80, 95, 105
\`\`\`
`

describe("parseChartFence", () => {
  it("계열·카테고리·타입을 파싱한다", () => {
    const f = parseChartFence("type: line\ncat: a, b\n계열1: 1, 2\n계열2: 3, 4\n")
    assert.ok(f)
    assert.equal(f.spec.el, "lineChart")
    assert.deepEqual(f.cat, ["a", "b"])
    assert.equal(f.series.length, 2)
    assert.deepEqual(f.series[1].values, [3, 4])
  })

  it("cat 생략 시 항목 N 자동, 파이는 첫 계열만", () => {
    const f = parseChartFence("type: pie\n비중: 40, 30, 30\n무시됨: 1, 2, 3\n")
    assert.ok(f)
    assert.deepEqual(f.cat, ["항목 1", "항목 2", "항목 3"])
    assert.equal(f.series.length, 1)
  })

  it("size 는 mm → HWPUNIT", () => {
    const f = parseChartFence("size: 100x50\n값: 1, 2\n")
    assert.ok(f)
    assert.equal(f.widthHu, Math.round((100 * 7200) / 25.4))
    assert.equal(f.heightHu, Math.round((50 * 7200) / 25.4))
  })

  it("계열 없으면 null (코드블록 폴백 신호)", () => {
    assert.equal(parseChartFence("type: pie\ncat: a, b\n"), null)
    assert.equal(parseChartFence("그냥 텍스트\n숫자아님: a, b\n"), null)
  })

  it("colors — 막대는 계열 색, 파이는 조각 색", () => {
    const bar = parseChartFence("colors: #304D68, accent2\nA: 1, 2\nB: 3, 4\n")
    assert.equal(bar?.series[0].color, "#304D68")
    assert.equal(bar?.series[1].color, "accent2")
    const pie = parseChartFence("type: pie\ncolors: #111111, #222222\nA: 1, 2\n")
    assert.deepEqual(pie?.series[0].pointColors, ["#111111", "#222222"])
  })
})

describe("buildChartSpaceXml", () => {
  it("막대 차트 — barDir/grouping/축/캐시", () => {
    const f = parseChartFence("type: column\ncat: a, b\nS: 1, 2\n")!
    const xml = buildChartSpaceXml(f)
    assert.match(xml, /<c:barChart>/)
    assert.match(xml, /<c:barDir val="col"\/>/)
    assert.match(xml, /<c:grouping val="clustered"\/>/)
    assert.match(xml, /<c:catAx>/)
    assert.match(xml, /<c:valAx>/)
    assert.match(xml, /<c:pt idx="1"><c:v>2<\/c:v><\/c:pt>/)
  })

  it("도넛 — holeSize, 산점도 — xVal/yVal", () => {
    const dn = buildChartSpaceXml(parseChartFence("type: doughnut\nA: 1, 2\n")!)
    assert.match(dn, /<c:doughnutChart>/)
    assert.match(dn, /<c:holeSize val="50"\/>/)
    const sc = buildChartSpaceXml(parseChartFence("type: scatter\ncat: 10, 20\nA: 1, 2\n")!)
    assert.match(sc, /<c:scatterChart>/)
    assert.match(sc, /<c:xVal>/)
    assert.match(sc, /<c:yVal>/)
  })

  it("선형 계열 색은 <a:ln> 안", () => {
    const xml = buildChartSpaceXml(parseChartFence("type: line\ncolors: #FF0000\nA: 1, 2\n")!)
    assert.match(xml, /<a:ln [^>]*>.*<a:srgbClr val="FF0000"\/>/)
  })
})

describe("markdownToHwpx 차트 통합", () => {
  it("chart 펜스 → 파트/manifest/hp:chart + validate 통과", async () => {
    const buf = await markdownToHwpx(COLUMN_MD)
    const zip = await JSZip.loadAsync(buf)

    const chart1 = await zip.file("Chart/chart1.xml")?.async("string")
    assert.ok(chart1, "Chart/chart1.xml 파트 존재")
    assert.match(chart1!, /<c:barChart>/)
    assert.equal((chart1!.match(/<c:ser>/g) || []).length, 2, "계열 2개")

    const hpf = await zip.file("Contents/content.hpf")!.async("string")
    assert.match(hpf, /<opf:item id="chart1" href="Chart\/chart1\.xml" media-type="application\/xml"\/>/)

    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.match(sec, /<hp:chart [^>]*chartIDRef="Chart\/chart1\.xml"/)
    assert.match(sec, /treatAsChar="1"/, "글자처럼 취급 — 삽입 위치 고정")

    const v = await validateHwpx(buf)
    assert.equal(v.ok, true, `validate: ${JSON.stringify(v.issues)}`)
  })

  it("차트 2개 — chart1·chart2 파트, 첫 블록 차트여도 secPr 정상", async () => {
    const md = "```chart\nA: 1, 2\n```\n\n본문\n\n```chart\ntype: pie\nB: 3, 4\n```\n"
    const buf = await markdownToHwpx(md)
    const zip = await JSZip.loadAsync(buf)
    assert.ok(zip.file("Chart/chart1.xml"))
    assert.ok(zip.file("Chart/chart2.xml"))
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.equal((sec.match(/<hp:chart /g) || []).length, 2)
    assert.match(sec, /<hp:secPr /, "첫 블록이 차트여도 secPr 존재")
    const v = await validateHwpx(buf)
    assert.equal(v.ok, true, `validate: ${JSON.stringify(v.issues)}`)
  })

  it("잘못된 chart 펜스는 일반 코드블록으로 폴백", async () => {
    const md = "```chart\n계열 없음, 콜론 라인 없음\n```\n"
    const buf = await markdownToHwpx(md)
    const zip = await JSZip.loadAsync(buf)
    assert.equal(zip.file("Chart/chart1.xml"), null, "차트 파트 없음")
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.doesNotMatch(sec, /<hp:chart /)
    assert.match(sec, /계열 없음, 콜론 라인 없음/, "본문에 코드 텍스트로 보존")
    const v = await validateHwpx(buf)
    assert.equal(v.ok, true)
  })

  it("공문서 모드에서도 차트 생성 + 재파싱 무해", async () => {
    const buf = await markdownToHwpx(COLUMN_MD, { gongmun: { preset: "보고서" } })
    const v = await validateHwpx(buf)
    assert.equal(v.ok, true)
    const reparsed = await parse(buf)
    assert.equal(reparsed.success, true, "생성 문서 재파싱 성공")
  })
})

describe("차트 파서 엣지 회귀 (chart-1/4/5/8)", () => {
  it("chart-1: 천단위 콤마 흡수 + 빈 세그먼트 거부", () => {
    assert.deepEqual(parseChartFence("cat: a, b\n예산: 1,000, 2,000")?.series[0].values, [1000, 2000])
    assert.deepEqual(parseChartFence("cat: a, b\n매출: 10, 20,")?.series[0].values, [10, 20])
    assert.deepEqual(parseChartFence("합계: 1,234,567")?.series[0].values, [1234567])
  })
  it("chart-4: 비숫자 토큰은 코드블록 폴백(null), 빈 값 라인은 계열 아님", () => {
    assert.equal(parseChartFence("cat: a, b\n예산: 10, 20\n집행률: 50%, 60%"), null)
    const f = parseChartFence("합계:\n예산: 1, 2")
    assert.equal(f?.series.length, 1)
    assert.equal(f?.series[0].name, "예산")
  })
  it("chart-5: cat/values 개수 일치 — ptCount 정합(0 패딩)", () => {
    const f = parseChartFence("cat: a, b, c\nS: 1, 2")
    assert.equal(f?.cat.length, 3)
    assert.deepEqual(f?.series[0].values, [1, 2, 0])
  })
  it("chart-5: 계열이 라벨보다 길면 절단 대신 라벨 확장 — 꼬리 값 보존(무손실)", () => {
    // 명시 cat 짧음 + 계열 김 → 30 절단 금지, `항목 3` 라벨 확장 (스켑틱 chart-5 회귀)
    const f = parseChartFence("cat: 상반기, 하반기\n예산: 10, 20, 30")
    assert.equal(f?.cat.length, 3)
    assert.equal(f?.cat[2], "항목 3")
    assert.deepEqual(f?.series[0].values, [10, 20, 30])
    // cat 없이 후행 계열이 첫 계열보다 김 → 최장 기준 라벨 + 전 계열 보존/0패딩
    const g = parseChartFence("A: 1, 2\nB: 3, 4, 5")
    assert.equal(g?.cat.length, 3)
    assert.deepEqual(g?.series[1].values, [3, 4, 5])
    assert.deepEqual(g?.series[0].values, [1, 2, 0])
  })
  it("chart-8: size 0·거대 클램프 (10~500mm)", () => {
    assert.equal(parseChartFence("size: 0x0\n값: 1, 2")?.widthHu, Math.round((10 * 7200) / 25.4))
    assert.equal(parseChartFence("size: 9999x9999\n값: 1, 2")?.widthHu, Math.round((500 * 7200) / 25.4))
  })
})

describe("차트 마크다운 파싱 회귀 (chart-2/3/6/7)", () => {
  it("chart-3: CRLF 마크다운에서도 차트 생성 + DSL 원문 미인쇄", async () => {
    const md = "본문\r\n\r\n```chart\r\ncat: a, b\r\n예산: 10, 20\r\n```\r\n"
    const buf = await markdownToHwpx(md)
    const zip = await JSZip.loadAsync(buf)
    assert.ok(zip.file("Chart/chart1.xml"), "CRLF 에서도 차트 파트 생성")
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.doesNotMatch(sec, /cat: a, b/, "DSL 원문이 본문에 인쇄되지 않아야")
  })
  it("chart-6: 2칸 들여쓴 펜스(리스트 하위 차트) 인식", async () => {
    const md = "- 항목\n\n  ```chart\n  cat: a, b\n  예산: 10, 20\n  ```\n"
    const buf = await markdownToHwpx(md)
    const zip = await JSZip.loadAsync(buf)
    assert.ok(zip.file("Chart/chart1.xml"), "2칸 들여쓴 차트 펜스 인식")
  })
  it("chart-2: 기안문 항목 사이 차트가 번호 run 을 끊지 않는다", () => {
    const blocks = parseMarkdownToBlocks("1. 첫째 항목\n\n```chart\ncat: a, b\n예산: 10, 20\n```\n\n2. 둘째 항목")
    const g = resolveGongmun({ preset: "기안문" })
    const map = precomputeGongmunList(blocks, g)
    const markers = blocks.map((b, i) => (b.type === "list_item" ? map.get(i)?.marker : null)).filter((m): m is string => !!m)
    assert.equal(markers.length, 2, "두 항목 모두 번호 부여(소멸 없음)")
    assert.ok(markers[0].includes("1"), `첫째 항목 1번 (실제: ${markers[0]})`)
    assert.ok(markers[1].includes("2"), `둘째 항목 2번 — 리스타트/소멸 아님 (실제: ${markers[1]})`)
  })
  it("chart-7: PrvText 에 차트 DSL 원문 대신 [차트]", async () => {
    const buf = await markdownToHwpx(COLUMN_MD)
    const zip = await JSZip.loadAsync(buf)
    const prv = await zip.file("Preview/PrvText.txt")?.async("string")
    assert.ok(prv)
    assert.doesNotMatch(prv!, /cat:/, "DSL 원문 미노출")
    assert.match(prv!, /\[차트\]/, "차트 대체텍스트")
  })
})

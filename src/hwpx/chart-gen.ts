/**
 * 차트 생성 (P5) — ```chart 펜스 → OOXML chartSpace 파트 + <hp:chart> 참조
 *
 * HWPX 차트는 OLE가 아니라 Chart/chartN.xml(OOXML DrawingML chartSpace)을
 * manifest에 등재하고 본문에서 <hp:chart chartIDRef="…">로 참조하는 구조다.
 * chartSpace 조립·타입 테이블은 claw-hwp(DoHyun468, MIT)의 한컴독스 GT 검증
 * 구현(hwpx-edit.js buildChartSpace/opInsertChart)을 TS로 이식했다.
 *
 * 펜스 규약 (콜론 구분 라인, 순서 무관):
 *   ```chart
 *   type: column          ← column|bar|line|area|pie|doughnut|scatter|radar
 *                            (+_stacked, 3d 변형 — CHART_ALIAS), 생략 시 column
 *   cat: 1분기, 2분기, 3분기
 *   size: 120x70          ← mm (선택, 기본 113.8×66.1)
 *   colors: #304D68, accent2   ← 계열 색 (pie는 조각 색, 선택)
 *   예산: 10, 20, 30      ← 그 외 "이름: 숫자들" 라인 = 데이터 계열
 *   집행: 5, 15, 25
 *   ```
 */

const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" }
const xmlEscape = (s: string): string => s.replace(/[&<>]/g, c => XML_ESC[c])

interface ChartTypeSpec {
  el: string
  dir?: "col" | "bar"
  grp?: "clustered" | "stacked" | "standard"
  overlap?: number
  marker?: boolean
  scatter?: boolean
  pie?: boolean
  explode?: boolean
  hole?: number
  radar?: boolean
}

/** 한컴독스 차트 20종 (claw-hwp GT) */
const CHART_TYPES: Record<number, ChartTypeSpec> = {
  0: { el: "barChart", dir: "col", grp: "clustered" },
  1: { el: "barChart", dir: "col", grp: "stacked", overlap: 100 },
  2: { el: "lineChart", grp: "standard", marker: true },
  3: { el: "barChart", dir: "bar", grp: "clustered" },
  4: { el: "barChart", dir: "bar", grp: "stacked", overlap: 100 },
  5: { el: "scatterChart", scatter: true },
  6: { el: "pieChart", pie: true },
  7: { el: "pieChart", pie: true, explode: true },
  8: { el: "doughnutChart", pie: true, hole: 50 },
  9: { el: "areaChart", grp: "standard" },
  10: { el: "areaChart", grp: "stacked" },
  11: { el: "radarChart", radar: true },
  12: { el: "bar3DChart", dir: "col", grp: "clustered" },
  13: { el: "bar3DChart", dir: "col", grp: "stacked", overlap: 100 },
  14: { el: "bar3DChart", dir: "bar", grp: "clustered" },
  15: { el: "bar3DChart", dir: "bar", grp: "stacked", overlap: 100 },
  16: { el: "pie3DChart", pie: true },
  17: { el: "pie3DChart", pie: true, explode: true },
  18: { el: "area3DChart", grp: "standard" },
  19: { el: "area3DChart", grp: "stacked" },
}

const CHART_ALIAS: Record<string, number> = {
  column: 0, col: 0, 세로막대: 0, 막대: 0,
  column_stacked: 1, 세로막대_누적: 1,
  line: 2, 선: 2, 꺾은선: 2,
  bar: 3, 가로막대: 3,
  bar_stacked: 4,
  scatter: 5, 분산: 5,
  pie: 6, 원: 6, 파이: 6,
  pie_explode: 7,
  doughnut: 8, donut: 8, 도넛: 8,
  area: 9, 영역: 9,
  area_stacked: 10,
  radar: 11, 방사형: 11,
  bar3d: 12, column3d: 12,
  pie3d: 16,
}

function chartSpec(t: string | undefined): ChartTypeSpec {
  if (!t) return CHART_TYPES[0]
  const key = CHART_ALIAS[t.toLowerCase()] ?? Number(t)
  return CHART_TYPES[key] ?? CHART_TYPES[0]
}

/** 파싱된 차트 펜스 */
export interface ChartFence {
  spec: ChartTypeSpec
  cat: string[]
  series: Array<{ name: string; values: number[]; color?: string; pointColors?: string[] }>
  widthHu: number
  heightHu: number
}

const HU_PER_MM = 7200 / 25.4

/** 예약 키 — 계열 이름으로 쓸 수 없는 라인 */
const RESERVED_KEYS = new Set(["type", "cat", "size", "colors", "point_colors", "title"])

/**
 * ```chart 펜스 본문 파싱. 계열이 하나도 없으면 null (호출부가 일반 코드블록으로 폴백).
 */
export function parseChartFence(text: string): ChartFence | null {
  let type: string | undefined
  let cat: string[] | null = null
  let widthMm = 32250 / HU_PER_MM
  let heightMm = 18750 / HU_PER_MM
  let colors: string[] | null = null
  let pointColors: string[] | null = null
  const series: Array<{ name: string; values: number[] }> = []

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const colon = line.search(/[:：]/)
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    const keyLower = key.toLowerCase()

    if (keyLower === "type") {
      type = value
    } else if (keyLower === "cat") {
      cat = value.split(",").map(s => s.trim()).filter(Boolean)
    } else if (keyLower === "size") {
      const m = value.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i)
      if (m) {
        // 0·거대 치수 클램프 — 크기 0 개체·본문폭 초과 레이아웃 파괴 방지 (10~500mm)
        const clamp = (n: number): number => Math.min(500, Math.max(10, n))
        widthMm = clamp(Number(m[1]))
        heightMm = clamp(Number(m[2]))
      }
    } else if (keyLower === "colors") {
      colors = value.split(",").map(s => s.trim()).filter(Boolean)
    } else if (keyLower === "point_colors") {
      pointColors = value.split(",").map(s => s.trim()).filter(Boolean)
    } else if (keyLower === "title") {
      // 차트 제목은 본문 텍스트로 쓰는 것을 권장 — 호환 위해 무시(에러 아님)
    } else if (!RESERVED_KEYS.has(keyLower)) {
      // 천단위 콤마(1,000)를 한 숫자로 흡수(자릿수 패턴) 후 구분자 콤마로 분리, 빈 세그먼트 거부(cat 대칭)
      const segs = value.replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1").split(",").map(s => s.trim()).filter(Boolean)
      if (segs.length === 0) continue // 값 없는 라인 — Number("")===0 [0] 계열 둔갑 금지
      const nums = segs.map(Number)
      if (nums.every(n => Number.isFinite(n))) {
        series.push({ name: key, values: nums })
      } else {
        return null // 비숫자 토큰 — 부분 손실(무통보 드랍) 대신 코드블록 폴백(원문 노출로 사용자 인지)
      }
    }
  }

  if (series.length === 0) return null
  const spec = chartSpec(type)
  let finalSeries: ChartFence["series"] = spec.pie ? [series[0]] : series
  finalSeries = finalSeries.map(s => ({ ...s }))
  // cat 라벨 길이 = max(명시 cat, 최장 계열). 계열이 라벨보다 길어도 꼬리 값을
  // 절단하지 않고 `항목 N`으로 라벨을 확장해 보존한다(무음 데이터 손실 금지 — 리뷰 chart-5).
  const ptLen = Math.max(cat?.length ?? 0, ...finalSeries.map(s => s.values.length))
  const catFinal = Array.from({ length: ptLen }, (_, i) => cat?.[i] ?? `항목 ${i + 1}`)
  // cat/values 개수 일치 — strCache/numCache ptCount 불일치(OOXML 계약 위반) 방지.
  // scatter 는 xVal/yVal 독립 축이라 제외.
  if (!spec.scatter) {
    finalSeries = finalSeries.map(s => ({ ...s, values: catFinal.map((_, i) => s.values[i] ?? 0) }))
  }
  if (spec.pie) {
    const slice = colors ?? pointColors
    if (slice) finalSeries[0].pointColors = slice
  } else {
    if (colors) finalSeries.forEach((s, i) => { s.color = colors![i % colors!.length] })
    if (pointColors && finalSeries[0]) finalSeries[0].pointColors = pointColors
  }
  return {
    spec,
    cat: catFinal,
    series: finalSeries,
    widthHu: Math.round(widthMm * HU_PER_MM),
    heightHu: Math.round(heightMm * HU_PER_MM),
  }
}

// ─── chartSpace OOXML 조립 (claw-hwp buildChartSpace 이식) ───

const colLetter = (i: number): string => String.fromCharCode(66 + i) // 0→B

function strCachePts(vals: string[]): string {
  return `<c:ptCount val="${vals.length}"/>` +
    vals.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`).join("")
}

function numCachePts(vals: number[]): string {
  return `<c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` +
    vals.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join("")
}

/** 색 → solidFill. accent1~6=한컴 내장 팔레트, #RRGGBB=리터럴. 그 외 무시 */
function chartColorFill(color: string | undefined): string | null {
  if (color == null) return null
  const c = color.trim()
  if (/^accent[1-6]$/i.test(c)) return `<a:solidFill><a:schemeClr val="${c.toLowerCase()}"/></a:solidFill>`
  const hex = c.replace(/^#/, "").toUpperCase()
  if (/^[0-9A-F]{6}$/.test(hex)) return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`
  return null
}

/** 선형(line/radar) 계열 색은 <a:ln> 안에, 면형은 맨 solidFill (claw-hwp GT) */
function serSpPr(color: string | undefined, stroke: boolean): string {
  const f = chartColorFill(color)
  if (!f) return "<c:spPr/>"
  return stroke
    ? `<c:spPr><a:ln w="28575" cap="flat" cmpd="sng" algn="ctr">${f}<a:prstDash val="solid"/><a:round/></a:ln></c:spPr>`
    : `<c:spPr>${f}</c:spPr>`
}

/** 포인트(막대/조각)별 색 오버라이드 */
function dPtXml(pointColors: string[] | undefined, pie: boolean): string {
  if (!pointColors?.length) return ""
  return pointColors.map((col, i) => {
    const f = chartColorFill(col)
    if (!f) return ""
    const mid = pie
      ? '<c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:explosion val="0"/>'
      : '<c:bubble3D val="0"/>'
    return `<c:dPt><c:idx val="${i}"/>${mid}<c:spPr>${f}</c:spPr></c:dPt>`
  }).join("")
}

function stdSer(
  idx: number, name: string, cat: string[], values: number[],
  explode: boolean, color: string | undefined, pointColors: string[] | undefined,
  stroke: boolean, pie: boolean,
): string {
  const cl = colLetter(idx)
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>` +
    `<c:tx><c:strRef><c:f>Sheet1!$${cl}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    `${serSpPr(color, stroke)}<c:invertIfNegative val="0"/>` +
    (explode ? `<c:explosion val="25"/>` : "") +
    dPtXml(pointColors, pie) +
    `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${cat.length + 1}</c:f><c:strCache>${strCachePts(cat)}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>Sheet1!$${cl}$2:$${cl}$${values.length + 1}</c:f><c:numCache>${numCachePts(values)}</c:numCache></c:numRef></c:val>` +
    `</c:ser>`
}

function scatterSer(idx: number, name: string, xvals: number[], yvals: number[]): string {
  const cl = colLetter(idx)
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>` +
    `<c:tx><c:strRef><c:f>Sheet1!$${cl}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    `<c:spPr><a:ln w="28575"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/></c:marker>` +
    `<c:xVal><c:numRef><c:f>Sheet1!$A$2:$A$${xvals.length + 1}</c:f><c:numCache>${numCachePts(xvals)}</c:numCache></c:numRef></c:xVal>` +
    `<c:yVal><c:numRef><c:f>Sheet1!$${cl}$2:$${cl}$${yvals.length + 1}</c:f><c:numCache>${numCachePts(yvals)}</c:numCache></c:numRef></c:yVal>` +
    `</c:ser>`
}

function catAxXml(id: string, pos: string, cross: string): string {
  return `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${pos}"/><c:crossAx val="${cross}"/><c:delete val="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
}

function valAxXml(id: string, pos: string, cross: string): string {
  return `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${pos}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="${cross}"/><c:delete val="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
}

/** 차트 펜스 → chartSpace XML 전문 */
export function buildChartSpaceXml(fence: ChartFence): string {
  const { spec, cat, series } = fence
  const NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'
  const ax1 = "111111111"
  const ax2 = "222222222"
  let plot: string
  if (spec.scatter) {
    // X값: 숫자 카테고리면 그대로, 아니면 1-based 인덱스 (가장 긴 계열 길이에 맞춤)
    const n = Math.max(0, ...series.map(s => s.values.length))
    const xs = Array.from({ length: n }, (_, i) => {
      const c = cat[i]
      const v = Number(c)
      return c !== undefined && c !== "" && Number.isFinite(v) ? v : i + 1
    })
    const sers = series.map((s, i) => scatterSer(i, s.name, xs, s.values)).join("")
    plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}<c:axId val="${ax1}"/><c:axId val="${ax2}"/></c:scatterChart>` +
      valAxXml(ax1, "b", ax2) + valAxXml(ax2, "l", ax1)
  } else if (spec.pie) {
    const s0 = series[0]
    plot = `<c:${spec.el}><c:varyColors val="1"/>${stdSer(0, s0.name, cat, s0.values, !!spec.explode, s0.color, s0.pointColors, false, true)}<c:firstSliceAng val="0"/>` +
      (spec.hole != null ? `<c:holeSize val="${spec.hole}"/>` : "") + `</c:${spec.el}>`
  } else {
    const stroke = spec.el === "lineChart" || spec.el === "radarChart" || !!spec.radar
    const sers = series.map((s, i) => stdSer(i, s.name, cat, s.values, false, s.color, s.pointColors, stroke, false)).join("")
    const horiz = spec.dir === "bar"
    let inner = ""
    if (spec.dir) inner += `<c:barDir val="${spec.dir}"/>`
    if (spec.grp) inner += `<c:grouping val="${spec.grp}"/>`
    if (spec.radar) inner += `<c:radarStyle val="standard"/>`
    inner += `<c:varyColors val="0"/>${sers}`
    if (spec.marker) inner += `<c:marker val="1"/>`
    if (spec.el.startsWith("bar")) inner += `<c:gapWidth val="150"/><c:overlap val="${spec.overlap ?? 0}"/>`
    inner += `<c:axId val="${ax1}"/><c:axId val="${ax2}"/>`
    plot = `<c:${spec.el}>${inner}</c:${spec.el}>` + catAxXml(ax1, horiz ? "l" : "b", ax2) + valAxXml(ax2, horiz ? "b" : "l", ax1)
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
    `<c:chartSpace ${NS}><c:date1904 val="0"/><c:roundedCorners val="0"/>` +
    `<c:chart><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>` +
    `<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
}

/**
 * 본문용 <hp:chart> — 글자처럼 취급(treatAsChar=1)이라 삽입 위치에 그대로 앉고
 * 다른 페이지로 떠내려가지 않는다 (claw-hwp GT 규약).
 */
export function buildChartElementXml(partName: string, widthHu: number, heightHu: number, id: number): string {
  return `<hp:chart id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" chartIDRef="${partName}">` +
    `<hp:sz width="${widthHu}" widthRelTo="ABSOLUTE" height="${heightHu}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="709" right="709" top="709" bottom="709"/></hp:chart>`
}

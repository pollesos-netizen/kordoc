/**
 * Markdown → HWPX 역변환 (MVP)
 *
 * 지원: 단락, 헤딩, 테이블 (텍스트+구조만, 스타일 없음)
 * jszip으로 HWPX ZIP 패키징.
 */

import JSZip from "jszip"

const NS_SECTION = "http://www.hancom.co.kr/hwpml/2011/section"
const NS_PARA = "http://www.hancom.co.kr/hwpml/2011/paragraph"
const NS_HEAD = "http://www.hancom.co.kr/hwpml/2011/head"
const NS_OPF = "http://www.idpf.org/2007/opf/"
const NS_HPF = "http://www.hancom.co.kr/schema/2011/hpf"
const NS_OCF = "urn:oasis:names:tc:opendocument:xmlns:container"

/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 *
 * @example
 * ```ts
 * import { markdownToHwpx } from "kordoc"
 * const hwpxBuffer = await markdownToHwpx("# 제목\n\n본문 텍스트")
 * writeFileSync("output.hwpx", Buffer.from(hwpxBuffer))
 * ```
 */
export async function markdownToHwpx(markdown: string): Promise<ArrayBuffer> {
  const blocks = parseMarkdownToBlocks(markdown)
  const sectionXml = blocksToSectionXml(blocks)

  const zip = new JSZip()

  // mimetype (압축 없이)
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })

  // META-INF/container.xml (한글 프로그램이 루트 파일 탐색에 필요)
  zip.file("META-INF/container.xml", generateContainerXml())

  // 매니페스트 (header.xml 참조 포함)
  zip.file("Contents/content.hpf", generateManifest())

  // 헤더 (용지/폰트 최소 정의)
  zip.file("Contents/header.xml", generateHeaderXml())

  // 섹션 콘텐츠
  zip.file("Contents/section0.xml", sectionXml)

  return await zip.generateAsync({ type: "arraybuffer" })
}

// ─── 마크다운 파싱 (간이) ────────────────────────────

interface MdBlock {
  type: "paragraph" | "heading" | "table"
  text?: string
  level?: number // heading level
  rows?: string[][] // table rows
}

function parseMarkdownToBlocks(md: string): MdBlock[] {
  const lines = md.split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue }

    // 헤딩
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: "heading", text: headingMatch[2].trim(), level: headingMatch[1].length })
      i++; continue
    }

    // 테이블
    if (line.trimStart().startsWith("|")) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = lines[i]
        // 구분선(| --- | --- |) 스킵
        if (/^[\s|:\-]+$/.test(row)) {
          i++; continue
        }
        const cells = row.split("|").slice(1, -1).map(c => c.trim())
        if (cells.length > 0) tableRows.push(cells)
        i++
      }
      if (tableRows.length > 0) {
        blocks.push({ type: "table", rows: tableRows })
      }
      continue
    }

    // 일반 단락
    blocks.push({ type: "paragraph", text: line.trim() })
    i++
  }

  return blocks
}

// ─── XML 생성 헬퍼 ───────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ─── HWPX 구조 파일 생성 ─────────────────────────────

function generateContainerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="${NS_OCF}" xmlns:hpf="${NS_HPF}">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </ocf:rootfiles>
</ocf:container>`
}

function generateManifest(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="${NS_OPF}" xmlns:hpf="${NS_HPF}" xmlns:hh="${NS_HEAD}">
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="no"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`
}

function generateHeaderXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head xmlns:hh="${NS_HEAD}" xmlns:hp="${NS_PARA}" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="7">
      <hh:fontface lang="HANGUL" fontCnt="1">
        <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="LATIN" fontCnt="1">
        <hh:font id="0" face="Times New Roman" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_OLDSTYLE" weight="5" proportion="4" contrast="2" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="4"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="HANJA" fontCnt="1">
        <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="JAPANESE" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="OTHER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="SYMBOL" fontCnt="1">
        <hh:font id="0" face="Symbol" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="USER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="1">
      <hh:borderFill id="0" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="NONE" width="0.1mm" color="0"/>
        <hh:rightBorder type="NONE" width="0.1mm" color="0"/>
        <hh:topBorder type="NONE" width="0.1mm" color="0"/>
        <hh:bottomBorder type="NONE" width="0.1mm" color="0"/>
        <hh:diagonal type="NONE" width="0.1mm" color="0"/>
        <hh:fillInfo/>
      </hh:borderFill>
    </hh:borderFills>
    <hh:charProperties itemCnt="1">
      <hh:charPr id="0" height="1000" textColor="0" shadeColor="-1" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0">
        <hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>
    </hh:charProperties>
    <hh:tabProperties itemCnt="0"/>
    <hh:numberings itemCnt="0"/>
    <hh:bullets itemCnt="0"/>
    <hh:paraProperties itemCnt="1">
      <hh:paraPr id="0" tabIDRef="0" condense="0" fontLineHeight="0" snapToGrid="0" suppressOverlap="0" checked="0">
        <hh:parLineBreak lineBreak="BREAK_LINE" wordBreak="BREAK_WORD" breakLatinWord="BREAK_WORD" breakNonLatinWord="BREAK_WORD"/>
        <hh:parMargin left="0" right="0" prev="0" next="0" indent="0"/>
        <hh:parBorder borderFillIDRef="0" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
        <hh:parShade borderFillIDRef="0"/>
        <hh:parTabList/>
      </hh:paraPr>
    </hh:paraProperties>
    <hh:styles itemCnt="1">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langIDRef="1042" lockForm="0"/>
    </hh:styles>
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP2018"/>
</hh:head>`
}

// ─── HWPX 섹션 XML 생성 ──────────────────────────────

function generateParagraph(text: string): string {
  return `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
}

function generateTable(rows: string[][]): string {
  const trElements = rows.map(row => {
    const tdElements = row.map(cell =>
      `<hp:tc><hp:cellSpan colSpan="1" rowSpan="1"/>${generateParagraph(cell)}</hp:tc>`
    ).join("")
    return `<hp:tr>${tdElements}</hp:tr>`
  }).join("")
  return `<hp:tbl>${trElements}</hp:tbl>`
}

function blocksToSectionXml(blocks: MdBlock[]): string {
  const body = blocks.map(block => {
    switch (block.type) {
      case "heading":
        return generateParagraph(block.text || "")
      case "table":
        return block.rows ? generateTable(block.rows) : ""
      case "paragraph":
        return generateParagraph(block.text || "")
      default:
        return ""
    }
  }).join("\n  ")

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}">
  ${body}
</hs:sec>`
}

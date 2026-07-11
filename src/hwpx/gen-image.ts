/**
 * 이미지 placeholder 방출 (v4.0.5) — 마크다운 `![alt](url)`·HTML `<img>` 참조를
 * 텍스트로 뭉개지 않고 1×1 placeholder 바이너리 + <hp:pic>로 방출한다.
 *
 * 배경: 종전에는 이미지 참조가 alt 텍스트("image")로 각인돼 (1) 재파싱 시 이미지
 * 존재 자체가 소실되고 (2) 이미지 열이 빈 열이 되어 후행 열 트림으로 표 구조가
 * 붕괴했다(라운드트립 tableExact 최대 결손). 바이너리 원본이 없어도 참조와 위치를
 * 보존하는 것이 목적 — 실제 픽셀은 1×1 placeholder다.
 *
 * <hp:pic> 형상은 실측 한컴 저장본(corpus 10772982)을 미러 — 필수 자식 전부 포함.
 */

import { PIC_ID_BASE } from "./geometry.js"

/** 1×1 24bit 흰색 BMP (58바이트) — .bmp 참조용 */
const PLACEHOLDER_BMP = Uint8Array.from([
  0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00,
  0x28, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
  0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00,
  0x13, 0x0b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00,
])

/** 1×1 투명 PNG (68바이트) — bmp 외 확장자 참조용 */
const PLACEHOLDER_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
  0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
}

/** 등록된 이미지 파트 — ZIP·manifest 등재용 */
export interface ImagePart {
  /** ZIP 경로 (BinData/xxx.ext) */
  name: string
  /** manifest item id == binaryItemIDRef (확장자 없는 basename) */
  itemId: string
  mime: string
  data: Uint8Array
}

/**
 * 문서 단위 이미지 레지스트리 — url 기준 dedupe, 안전한 상대 파일명만 수용.
 * 수용 불가 url(스킴·경로 구분자·미지의 확장자)은 null — 호출부가 종전 alt 텍스트 폴백.
 */
export class ImageRegistry {
  private byUrl = new Map<string, ImagePart | null>()
  private ids = new Set<string>()
  readonly parts: ImagePart[] = []
  private picSeq = 0

  /** url 등록(중복 시 기존 파트) — 수용 불가면 null */
  take(url: string): ImagePart | null {
    const cached = this.byUrl.get(url)
    if (cached !== undefined) return cached
    let part: ImagePart | null = null
    // 파일명만 허용 — 경로 구분자·스킴 배제 (ZIP 경로 주입 방지)
    const m = /^([A-Za-z0-9._-]+)\.([A-Za-z0-9]+)$/.exec(url)
    const mime = m ? IMAGE_EXT_MIME[m[2].toLowerCase()] : undefined
    if (m && mime && !url.includes("..")) {
      let itemId = m[1].replace(/[^A-Za-z0-9_]/g, "_")
      // itemId 충돌(a.png vs a.bmp) 시 접미 부여
      let n = 1
      while (this.ids.has(itemId)) itemId = `${m[1].replace(/[^A-Za-z0-9_]/g, "_")}_${n++}`
      this.ids.add(itemId)
      part = {
        name: `BinData/${url}`,
        itemId,
        mime,
        data: m[2].toLowerCase() === "bmp" ? PLACEHOLDER_BMP : PLACEHOLDER_PNG,
      }
      this.parts.push(part)
    }
    this.byUrl.set(url, part)
    return part
  }

  /** manifest <opf:item> 조각들 (실측: isEmbeded="1") */
  manifestItems(): string[] {
    return this.parts.map((p) => `<opf:item id="${p.itemId}" href="${p.name}" media-type="${p.mime}" isEmbeded="1"/>`)
  }

  /** 인라인 <hp:pic> XML — 실측 저장본 미러, treatAsChar=1 (셀·문단 안 배치) */
  inlinePicXml(part: ImagePart): string {
    const id = PIC_ID_BASE + ++this.picSeq
    const s = 1130 // ≈4mm — placeholder 표기 크기
    // xmlns:hc는 pic 요소에 인라인 선언 — 섹션 루트는 hs/hp만 선언하므로(기존 산출물
    // 바이트 보존) hc: 자식(transMatrix·img 등)이 여기서 네임스페이스를 얻는다
    return `<hp:pic id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" reverse="0" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">`
      + `<hp:offset x="0" y="0"/><hp:orgSz width="${s}" height="${s}"/><hp:curSz width="${s}" height="${s}"/>`
      + `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${s / 2}" centerY="${s / 2}" rotateimage="1"/>`
      + `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
      + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${s}" y="0"/><hc:pt2 x="${s}" y="${s}"/><hc:pt3 x="0" y="${s}"/></hp:imgRect>`
      + `<hp:imgClip left="0" right="${s}" top="0" bottom="${s}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>`
      + `<hp:imgDim dimwidth="${s}" dimheight="${s}"/>`
      + `<hc:img binaryItemIDRef="${part.itemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>`
      + `<hp:sz width="${s}" widthRelTo="ABSOLUTE" height="${s}" heightRelTo="ABSOLUTE" protect="0"/>`
      + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
      + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
      + `</hp:pic>`
  }
}

/** 마크다운 이미지 참조 정규식 — `![alt](url)` */
export const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

/**
 * 텍스트에서 이미지 참조를 걷어내고 url 목록 반환 — 셀·문단 공용.
 * (레지스트리 수용 여부와 무관하게 걷는다 — 수용 실패 url은 호출부가 alt로 폴백)
 */
export function splitImageRefs(text: string): { text: string; urls: string[] } {
  const urls: string[] = []
  const out = text.replace(MD_IMAGE_RE, (_, url: string) => { urls.push(url); return "" })
  return { text: out, urls }
}

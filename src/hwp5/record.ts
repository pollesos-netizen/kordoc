/** HWP 5.x 레코드 리더, UTF-16LE 텍스트 추출, 스트림 압축해제 */

import { inflateRawSync, inflateSync } from "zlib"
import { KordocError } from "../utils.js"

// ─── 레코드 태그 상수 ────────────────────────────────

export const TAG_PARA_HEADER = 0x0042
export const TAG_PARA_TEXT = 0x0043
export const TAG_CHAR_SHAPE = 0x0044
export const TAG_PARA_SHAPE = 0x0045
export const TAG_CTRL_HEADER = 0x0047
export const TAG_LIST_HEADER = 0x0048
export const TAG_TABLE = 0x004d

// DocInfo 태그 (스타일 정보 해석용)
export const TAG_ID_MAPPINGS = 0x0032
export const TAG_FACE_NAME = 0x0033
export const TAG_DOC_CHAR_SHAPE = 0x0037
export const TAG_DOC_PARA_SHAPE = 0x0039
export const TAG_DOC_STYLE = 0x003a

// 특수 문자 코드 (UTF-16LE)
// HWP 스펙에서 0x0000은 NUL이 아닌 줄바꿈(line break)으로 정의됨
const CHAR_LINE = 0x0000
const CHAR_PARA = 0x000d
const CHAR_TAB = 0x0009
const CHAR_HYPHEN = 0x001e
const CHAR_NBSP = 0x001f
const CHAR_FIXED_NBSP = 0x0018

// FileHeader 플래그
export const FLAG_COMPRESSED = 1 << 0
export const FLAG_ENCRYPTED = 1 << 1
export const FLAG_DRM = 1 << 4

// ─── 레코드 구조 ─────────────────────────────────────

export interface HwpRecord {
  tagId: number
  level: number
  size: number
  data: Buffer
}

export interface HwpFileHeader {
  signature: string
  versionMajor: number
  flags: number
}

// ─── 레코드 리더 ─────────────────────────────────────

/** 최대 레코드 수 — 비정상 파일에 의한 메모리 폭주 방지 */
const MAX_RECORDS = 500_000

export function readRecords(data: Buffer): HwpRecord[] {
  const records: HwpRecord[] = []
  let offset = 0

  while (offset + 4 <= data.length && records.length < MAX_RECORDS) {
    const header = data.readUInt32LE(offset)
    offset += 4

    const tagId = header & 0x3ff
    const level = (header >> 10) & 0x3ff
    let size = (header >> 20) & 0xfff

    // 확장 크기
    if (size === 0xfff) {
      if (offset + 4 > data.length) break
      size = data.readUInt32LE(offset)
      offset += 4
    }

    if (offset + size > data.length) break
    records.push({ tagId, level, size, data: data.subarray(offset, offset + size) })
    offset += size
  }

  return records
}

// ─── 스트림 압축 해제 ────────────────────────────────

/** 압축 해제 최대 크기 (100MB) — decompression bomb 방지 */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024

export function decompressStream(data: Buffer): Buffer {
  const opts = { maxOutputLength: MAX_DECOMPRESS_SIZE }
  if (data.length >= 2 && data[0] === 0x78) {
    try { return inflateSync(data, opts) } catch { /* fallback to raw */ }
  }
  return inflateRawSync(data, opts)
}

// ─── FileHeader 파싱 ─────────────────────────────────

export function parseFileHeader(data: Buffer): HwpFileHeader {
  if (data.length < 40) throw new KordocError("FileHeader가 너무 짧습니다 (최소 40바이트)")
  const sig = data.subarray(0, 32).toString("utf8").replace(/\0+$/, "")
  return {
    signature: sig,
    versionMajor: data[35],
    flags: data.readUInt32LE(36),
  }
}

// ─── 스타일 정보 구조 ────────────────────────────────

/** DocInfo에서 추출한 글자 모양 (CHAR_SHAPE) */
export interface HwpCharShape {
  /** 글꼴 크기 (단위: 0.1pt, 예: 100 = 10pt) */
  fontSize: number
  /**
   * 속성 플래그 (HWP5 바이너리 스펙 1.1 기준):
   * bit 0 = italic, bit 1 = bold, bit 2 = underline, bit 3 = outline
   * 검증 완료: 공식 스펙 + pyhwp/hwp.js 등 오픈소스 파서와 일치 (v1.7)
   */
  attrFlags: number
}

/** DocInfo에서 추출한 스타일 */
export interface HwpStyle {
  name: string
  /** 한글 이름 (UTF-16LE) */
  nameKo: string
  /** 연결된 charShape 인덱스 */
  charShapeId: number
  /** 연결된 paraShape 인덱스 */
  paraShapeId: number
  /** 스타일 타입: 0=paragraph, 1=character */
  type: number
}

/** DocInfo 파싱 결과 */
export interface HwpDocInfo {
  charShapes: HwpCharShape[]
  styles: HwpStyle[]
}

/** DocInfo 레코드들에서 스타일 정보 추출 */
export function parseDocInfo(records: HwpRecord[]): HwpDocInfo {
  const charShapes: HwpCharShape[] = []
  const styles: HwpStyle[] = []

  for (const rec of records) {
    if (rec.tagId === TAG_DOC_CHAR_SHAPE && rec.data.length >= 18) {
      // HWP5 CHAR_SHAPE 구조 (바이너리 스펙 1.1 기준):
      //   faceId: 7개 언어 * u16 = 14바이트 (offset 0-13)
      //   ratio:  7개 언어 * u8  =  7바이트 (offset 14-20)
      //   spacing: 7개 언어 * s8 =  7바이트 (offset 21-27)
      //   relSize: 7개 언어 * u8 =  7바이트 (offset 28-34)
      //   charOffset: 7개 언어 * s8 = 7바이트 (offset 35-41)
      //   baseSize: u32 at offset 42 (단위: 0.1pt)
      //   attrFlags: u32 at offset 46 (bit0=italic, bit1=bold) — 공식 스펙 검증 완료
      if (rec.data.length >= 50) {
        const fontSize = rec.data.readUInt32LE(42)  // 단위: 0.1pt
        const attrFlags = rec.data.readUInt32LE(46)
        charShapes.push({ fontSize, attrFlags })
      } else {
        // 짧은 레코드 — 스타일 정보 없음
        charShapes.push({ fontSize: 0, attrFlags: 0 })
      }
    }

    if (rec.tagId === TAG_DOC_STYLE && rec.data.length >= 8) {
      try {
        // STYLE 구조: nameLen(u16) + name(UTF-16LE) + nameKoLen(u16) + nameKo(UTF-16LE)
        // + type(u8) + nextStyleId(u16) + langId(s16) + paraShapeId(u16) + charShapeId(u16)
        let offset = 0
        const nameLen = rec.data.readUInt16LE(offset); offset += 2
        const nameBytes = nameLen * 2
        const name = nameBytes > 0 && offset + nameBytes <= rec.data.length
          ? rec.data.subarray(offset, offset + nameBytes).toString("utf16le")
          : ""
        offset += nameBytes

        let nameKo = ""
        if (offset + 2 <= rec.data.length) {
          const nameKoLen = rec.data.readUInt16LE(offset); offset += 2
          const nameKoBytes = nameKoLen * 2
          if (nameKoBytes > 0 && offset + nameKoBytes <= rec.data.length) {
            nameKo = rec.data.subarray(offset, offset + nameKoBytes).toString("utf16le")
          }
          offset += nameKoBytes
        }

        // type(u8) + nextStyleId(u16) + langId(s16) + paraShapeId(u16) + charShapeId(u16)
        const type = offset < rec.data.length ? rec.data.readUInt8(offset) : 0; offset += 1
        offset += 2 // nextStyleId
        offset += 2 // langId
        const paraShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0; offset += 2
        const charShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0

        styles.push({ name, nameKo, charShapeId, paraShapeId, type })
      } catch {
        // 파싱 실패 — 스킵
      }
    }
  }

  return { charShapes, styles }
}

// ─── UTF-16LE 텍스트 추출 (21가지 제어문자 처리) ─────

export function extractText(data: Buffer): string {
  let result = ""
  let i = 0

  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i)
    i += 2

    switch (ch) {
      case CHAR_LINE: result += "\n"; break
      case CHAR_PARA: break
      case CHAR_TAB:
        result += "\t"
        // TAB(0x0009)은 인라인 컨트롤(ch 4-9)로 14바이트 확장 데이터가 뒤따름
        if (i + 14 <= data.length) i += 14
        break
      case CHAR_HYPHEN: result += "-"; break
      case CHAR_NBSP: case CHAR_FIXED_NBSP: result += " "; break
      default:
        if (ch >= 0x0001 && ch <= 0x001f) {
          const isExt = (ch >= 1 && ch <= 3) || (ch >= 10 && ch <= 18) || (ch >= 21 && ch <= 23)
          const isInline = (ch >= 4 && ch <= 9) || (ch >= 19 && ch <= 20)
          if ((isExt || isInline) && i + 14 <= data.length) i += 14
        } else if (ch >= 0x0020) {
          // UTF-16 surrogate pair 처리 (BMP 외 문자: 이모지, CJK 확장 등)
          if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < data.length) {
            const lo = data.readUInt16LE(i)
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              i += 2
              const codePoint = ((ch - 0xd800) << 10) + (lo - 0xdc00) + 0x10000
              result += String.fromCodePoint(codePoint)
              break
            }
          }
          result += String.fromCharCode(ch)
        }
        break
    }
  }

  return result
}

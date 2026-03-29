/** kordoc 공통 타입 정의 */

// ─── 중간 표현 (Intermediate Representation) ─────────

export interface CellContext {
  text: string
  colSpan: number
  rowSpan: number
}

export interface IRBlock {
  type: "paragraph" | "table"
  text?: string
  table?: IRTable
}

export interface IRTable {
  rows: number
  cols: number
  cells: IRCell[][]
  hasHeader: boolean
}

export interface IRCell {
  text: string
  colSpan: number
  rowSpan: number
}

// ─── 메타데이터 ─────────────────────────────────────

/** 문서 메타데이터 — 각 포맷에서 추출 가능한 필드만 채워짐 */
export interface DocumentMetadata {
  /** 문서 제목 */
  title?: string
  /** 작성자 */
  author?: string
  /** 작성 프로그램 (예: "한글 2020", "Adobe Acrobat") */
  creator?: string
  /** 생성일시 (ISO 8601) */
  createdAt?: string
  /** 수정일시 (ISO 8601) */
  modifiedAt?: string
  /** 페이지/섹션 수 */
  pageCount?: number
  /** 문서 포맷 버전 (예: HWP "5.1.0.1") */
  version?: string
  /** 설명 */
  description?: string
  /** 키워드 */
  keywords?: string[]
}

// ─── 파싱 옵션 ──────────────────────────────────────

/** 파싱 옵션 — parse() 함수에 전달 */
export interface ParseOptions {
  /**
   * 파싱할 페이지/섹션 범위 (1-based).
   * - 배열: [1, 2, 3]
   * - 문자열: "1-3", "1,3,5-7"
   *
   * PDF: 정확한 페이지 단위. HWP/HWPX: 섹션 단위 근사치.
   */
  pages?: number[] | string
  /** 이미지 기반 PDF용 OCR 프로바이더 (선택) */
  ocr?: OcrProvider
}

// ─── 에러 코드 ──────────────────────────────────────

/** 구조화된 에러 코드 — 프로그래밍적 에러 핸들링용 */
export type ErrorCode =
  | "EMPTY_INPUT"
  | "UNSUPPORTED_FORMAT"
  | "ENCRYPTED"
  | "DRM_PROTECTED"
  | "CORRUPTED"
  | "DECOMPRESSION_BOMB"
  | "ZIP_BOMB"
  | "IMAGE_BASED_PDF"
  | "NO_SECTIONS"
  | "PARSE_ERROR"

// ─── 파싱 결과 (discriminated union) ────────────────

export type FileType = "hwpx" | "hwp" | "pdf" | "unknown"

interface ParseResultBase {
  fileType: FileType
  /** PDF 페이지 수 */
  pageCount?: number
  /** 이미지 기반 PDF 여부 (텍스트 추출 불가) */
  isImageBased?: boolean
}

export interface ParseSuccess extends ParseResultBase {
  success: true
  /** 추출된 마크다운 텍스트 */
  markdown: string
  /** 중간 표현 블록 (구조화된 데이터 접근용) */
  blocks: IRBlock[]
  /** 문서 메타데이터 */
  metadata?: DocumentMetadata
}

export interface ParseFailure extends ParseResultBase {
  success: false
  /** 오류 메시지 */
  error: string
  /** 구조화된 에러 코드 */
  code?: ErrorCode
}

export type ParseResult = ParseSuccess | ParseFailure

// ─── 문서 비교 (Diff) ───────────────────────────────

export type DiffChangeType = "added" | "removed" | "modified" | "unchanged"

export interface BlockDiff {
  type: DiffChangeType
  /** 원본 블록 (added이면 undefined) */
  before?: IRBlock
  /** 변경 후 블록 (removed이면 undefined) */
  after?: IRBlock
  /** modified 테이블의 셀 단위 diff */
  cellDiffs?: CellDiff[][]
  /** 유사도 (0-1) */
  similarity?: number
}

export interface CellDiff {
  type: DiffChangeType
  before?: string
  after?: string
}

export interface DiffResult {
  stats: { added: number; removed: number; modified: number; unchanged: number }
  diffs: BlockDiff[]
}

// ─── 양식 인식 ──────────────────────────────────────

export interface FormField {
  label: string
  value: string
  /** 0-based 소스 행 */
  row: number
  /** 0-based 소스 열 */
  col: number
}

export interface FormResult {
  fields: FormField[]
  /** 양식 확신도 (0-1) */
  confidence: number
}

// ─── OCR 프로바이더 ─────────────────────────────────

/** 사용자 제공 OCR 함수 — 페이지 이미지를 받아 텍스트 반환 */
export type OcrProvider = (
  pageImage: Uint8Array,
  pageNumber: number,
  mimeType: "image/png"
) => Promise<string>

// ─── Watch 모드 ─────────────────────────────────────

export interface WatchOptions {
  dir: string
  outDir?: string
  webhook?: string
  format?: "markdown" | "json"
  pages?: string
  silent?: boolean
}

// ─── 내부 파서 반환 타입 ─────────────────────────────

/** HWP5/HWPX 파서가 index.ts에 반환하는 내부 타입 */
export interface InternalParseResult {
  markdown: string
  blocks: IRBlock[]
  metadata?: DocumentMetadata
}

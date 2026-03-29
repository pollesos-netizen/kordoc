/** kordoc 공용 유틸리티 */

/** 빌드 타임에 tsup define으로 주입되는 버전 */
declare const __KORDOC_VERSION__: string
export const VERSION: string = typeof __KORDOC_VERSION__ !== "undefined" ? __KORDOC_VERSION__ : "0.0.0-dev"

/**
 * Node.js Buffer → ArrayBuffer 변환
 * pool Buffer의 공유 ArrayBuffer 문제를 안전하게 처리.
 * offset=0이고 전체 ArrayBuffer를 차지하면 복사 없이 직접 반환.
 */
export function toArrayBuffer(buf: Buffer): ArrayBuffer {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return buf.buffer as ArrayBuffer
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/**
 * kordoc 내부 에러 클래스 — 사용자에게 노출해도 안전한 메시지만 포함.
 * MCP 에러 정제에서 instanceof로 판별하여 allowlist 패턴 매칭 없이 안전하게 통과.
 */
export class KordocError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KordocError"
  }
}

/**
 * 에러 메시지 정제 — KordocError는 그대로, 나머지는 일반 메시지로 대체.
 * 파일시스템 경로, 스택 트레이스 등 내부 정보 노출 방지.
 */
export function sanitizeError(err: unknown): string {
  if (err instanceof KordocError) return err.message
  return "문서 처리 중 오류가 발생했습니다"
}

/**
 * ZIP 엔트리 경로의 경로 순회 여부 판별.
 * 백슬래시 정규화, .., 절대경로, Windows 드라이브 문자 모두 차단.
 */
export function isPathTraversal(name: string): boolean {
  const normalized = name.replace(/\\/g, "/")
  return normalized.includes("..") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
}

// ─── 에러 분류 ──────────────────────────────────────

import type { ErrorCode } from "./types.js"

/** 에러를 구조화된 ErrorCode로 분류 — KordocError 메시지 패턴 매칭 */
export function classifyError(err: unknown): ErrorCode {
  if (!(err instanceof Error)) return "PARSE_ERROR"
  const msg = err.message
  if (msg.includes("암호화")) return "ENCRYPTED"
  if (msg.includes("DRM")) return "DRM_PROTECTED"
  if (msg.includes("ZIP bomb") || msg.includes("ZIP 비압축 크기 초과") || msg.includes("ZIP 엔트리 수 초과")) return "ZIP_BOMB"
  if (msg.includes("bomb") || msg.includes("크기 초과") || msg.includes("압축 해제")) return "DECOMPRESSION_BOMB"
  if (msg.includes("이미지 기반")) return "IMAGE_BASED_PDF"
  if (msg.includes("섹션") && (msg.includes("찾을 수 없") || msg.includes("없음"))) return "NO_SECTIONS"
  if (msg.includes("시그니처") || msg.includes("복구할 수 없")) return "CORRUPTED"
  return "PARSE_ERROR"
}

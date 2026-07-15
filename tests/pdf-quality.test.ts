import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { computePageQuality, summarizeDocumentQuality, stripControlChars } from "../src/pdf/quality.js"

describe("computePageQuality", () => {
  it("정상 한글 페이지: needsOcr=false, hangulRatio 높음", () => {
    const q = computePageQuality(1, "이것은 정상적인 한글 문서이고 충분히 긴 본문을 가지고 있습니다.")
    assert.equal(q.needsOcr, false)
    assert.ok(q.hangulRatio > 0.7, `hangulRatio=${q.hangulRatio}`)
    assert.equal(q.controlCharRatio, 0)
    assert.equal(q.puaRatio, 0)
  })

  it("빈 페이지: needsOcr=true, reason=low_text", () => {
    const q = computePageQuality(1, "")
    assert.equal(q.needsOcr, true)
    assert.equal(q.ocrReason, "low_text")
    assert.equal(q.textChars, 0)
  })

  it("PUA가 많은 페이지: needsOcr=true, reason=high_pua", () => {
    const pua = String.fromCharCode(0xe000).repeat(50)
    const q = computePageQuality(1, "텍스트" + pua)
    assert.equal(q.needsOcr, true)
    assert.equal(q.ocrReason, "high_pua")
    assert.ok(q.puaRatio >= 0.2)
  })

  it("NUL 등 제어문자 많은 페이지: needsOcr=true, reason=high_control", () => {
    const nul = "\x00".repeat(50)
    const q = computePageQuality(1, "본문 문장이다" + nul)
    assert.equal(q.needsOcr, true)
    assert.equal(q.ocrReason, "high_control")
    assert.ok(q.controlCharRatio >= 0.05)
  })

  it("공백/탭/개행은 분모에서 제외 (textChars에 안 잡힘)", () => {
    const q = computePageQuality(1, "   \t\n  ")
    assert.equal(q.textChars, 0)
  })
})

describe("computePageQuality — mojibake(정상 음절이지만 깨진 한글) 감지", () => {
  // 종성 인덱스로 음절 합성: 0xAC00 + cho*588 + jung*28 + jong
  const syl = (cho: number, jung: number, jong: number) =>
    String.fromCharCode(0xac00 + cho * 588 + jung * 28 + jong)
  // 희귀 종성(ㄺ=9, ㄻ=10, ㄼ=11, ㄵ=5, ㅄ=18 ...) 위주 → ToUnicode 오매핑 근사
  const RARE_JONG = [3, 5, 6, 9, 10, 11, 12, 13, 14, 15, 18, 24, 25, 26]

  it("희귀 받침이 몰린 페이지: needsOcr=true, reason=garbled_hangul", () => {
    let s = ""
    for (let i = 0; i < 40; i++) {
      const jong = RARE_JONG[i % RARE_JONG.length]
      s += syl(i % 19, (i * 7) % 21, jong)
    }
    const q = computePageQuality(1, s)
    assert.equal(q.needsOcr, true, `q=${JSON.stringify(q)}`)
    assert.equal(q.ocrReason, "garbled_hangul")
    assert.ok(q.hangulRareBatchimRatio >= 0.25)
    assert.ok(q.hangulNoBatchimRatio < 0.15)
  })

  it("자연 한국어 긴 본문(받침없음 음절 다수): garbled_hangul 아님", () => {
    const natural = "이 문서는 여러 부서가 협력하여 작성한 종합 계획으로서 각 사업의 " +
      "목표와 추진 일정 그리고 기대 효과를 상세히 기술하고 있으며 예산 배분과 성과 지표도 함께 담았다"
    const q = computePageQuality(1, natural)
    assert.equal(q.needsOcr, false, `자연 한국어 오탐: ${JSON.stringify(q)}`)
    assert.notEqual(q.ocrReason, "garbled_hangul")
    assert.ok(q.hangulNoBatchimRatio > 0.3, `받침없음 비율=${q.hangulNoBatchimRatio}`)
  })

  it("받침 없는 음절만 있는 페이지(가나다…): garbled_hangul 아님", () => {
    let s = ""
    for (let i = 0; i < 40; i++) s += syl(i % 19, (i * 3) % 21, 0)
    const q = computePageQuality(1, s)
    assert.notEqual(q.ocrReason, "garbled_hangul")
    assert.equal(q.hangulNoBatchimRatio, 1)
  })

  it("한글 음절 수 부족(30 미만)이면 판정 보류 — 오탐 방지", () => {
    let s = ""
    for (let i = 0; i < 10; i++) s += syl(i % 19, i % 21, RARE_JONG[i % RARE_JONG.length])
    const q = computePageQuality(1, s)
    assert.notEqual(q.ocrReason, "garbled_hangul", `표본 부족인데 발화: ${JSON.stringify(q)}`)
  })
})

describe("summarizeDocumentQuality", () => {
  it("빈 입력: 모든 값 0/false", () => {
    const s = summarizeDocumentQuality([])
    assert.equal(s.totalPages, 0)
    assert.equal(s.needsOcr, false)
    assert.deepEqual(s.ocrCandidatePages, [])
  })

  it("OCR 후보 페이지 비율 30% 이상이면 문서 needsOcr=true", () => {
    const pages = [
      computePageQuality(1, ""),
      computePageQuality(2, ""),
      computePageQuality(3, "정상 한국어 본문 문장입니다. 추가 본문이 더 있어서 충분한 길이를 가집니다."),
      computePageQuality(4, "정상 한국어 본문 문장입니다. 추가 본문이 더 있어서 충분한 길이를 가집니다."),
    ]
    const s = summarizeDocumentQuality(pages)
    assert.equal(s.needsOcr, true)
    assert.deepEqual(s.ocrCandidatePages, [1, 2])
  })

  it("OCR 후보가 소수면 문서 needsOcr=false", () => {
    const pages = [
      computePageQuality(1, ""),
      ...Array.from({ length: 9 }, (_, i) => computePageQuality(i + 2, "정상 한국어 본문 문장입니다. 추가 본문이 더 있어서 충분한 길이를 가집니다.")),
    ]
    const s = summarizeDocumentQuality(pages)
    assert.equal(s.needsOcr, false)
    assert.deepEqual(s.ocrCandidatePages, [1])
  })
})

describe("stripControlChars", () => {
  it("NUL/제어문자 제거, tab/lf/cr/일반문자 보존", () => {
    assert.equal(stripControlChars("a\x00b\x01c\x7fd\x9fe"), "abcde")
    assert.equal(stripControlChars("a\tb\nc\rd"), "a\tb\nc\rd")
    assert.equal(stripControlChars("한글\x00텍스트"), "한글텍스트")
  })

  it("PUA는 보존 (글꼴 매핑 신호로 사용자에게 노출)", () => {
    const pua = String.fromCharCode(0xe000)
    assert.equal(stripControlChars(`a${pua}b`), `a${pua}b`)
  })
})

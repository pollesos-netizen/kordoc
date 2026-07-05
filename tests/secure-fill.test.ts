/**
 * P4 secure-fill 이식 (claw-hwp) — 값 서식 변환 + 모호 라벨 거부 가드.
 * formatFillValue: 정준값 하나 → 서식별 모양 (도구 안 변환, 값이 대화에 안 남게).
 * fillWithUniqueGuard: 스칼라 키가 2곳+ 매칭되면 채우지 않고 rejected 보고.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { formatFillValue, fillWithUniqueGuard, normalizeValues, normalizeLabel } from "../src/form/match.js"
import { fillFormFields } from "../src/form/filler.js"
import { markdownToHwpx, fillHwpx, parse } from "../src/index.js"
import type { IRBlock, IRTable } from "../src/types.js"

function makeTable(rows: string[][]): IRTable {
  return {
    rows: rows.length,
    cols: rows[0]?.length || 0,
    cells: rows.map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 }))),
    hasHeader: rows.length > 1,
  }
}

const tableBlock = (t: IRTable): IRBlock => ({ type: "table", table: t })

function toAB(b: ArrayBuffer | Uint8Array): ArrayBuffer {
  return b instanceof ArrayBuffer ? b : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}

describe("formatFillValue — 값 서식 변환", () => {
  it("date: 토큰 치환 (yyyy/yy/mm/dd + 선행 0 제거 m/d)", () => {
    assert.equal(formatFillValue("19900315", "date:yyyy-mm-dd"), "1990-03-15")
    assert.equal(formatFillValue("19900315", "date:yy.mm.dd"), "90.03.15")
    assert.equal(formatFillValue("19900315", "yyyy년 m월 d일"), "1990년 3월 15일")
    assert.equal(formatFillValue("900315", "date:yyyy-mm-dd"), "1990-03-15") // 6자리 → 세기 추정
  })

  it("phone: 스타일별", () => {
    assert.equal(formatFillValue("01012345678", "phone:hyphen"), "010-1234-5678")
    assert.equal(formatFillValue("010-1234-5678", "phone:digits"), "01012345678")
    assert.equal(formatFillValue("01012345678", "phone:dot"), "010.1234.5678")
    assert.equal(formatFillValue("01012345678", "phone:intl"), "+82-10-1234-5678")
  })

  it("rrn: 하이픈·마스킹·앞자리", () => {
    assert.equal(formatFillValue("9003151234567", "rrn:hyphen"), "900315-1234567")
    assert.equal(formatFillValue("900315-1234567", "rrn:masked"), "900315-1******")
    assert.equal(formatFillValue("9003151234567", "rrn:front"), "900315")
  })

  it("# 숫자마스크 — 리터럴 통과, 숫자만 소비 (정확 자릿수)", () => {
    // sfill-6: # 개수와 숫자 개수가 정확히 일치할 때만 마스크한다 (초과분 무음 폐기 금지)
    assert.equal(formatFillValue("1234567890", "mask:###-##-#####"), "123-45-67890")
    assert.equal(formatFillValue("01012345678", "###-####-####"), "010-1234-5678") // 자유 패턴
  })

  it("포맷 없음·미지원 포맷은 원형 (fail-open)", () => {
    assert.equal(formatFillValue("값 그대로"), "값 그대로")
    assert.equal(formatFillValue("값", "unknown:zzz"), "값")
  })

  it("normalizeValues가 객체형(FillInput)의 format을 값에 적용한다", () => {
    const m = normalizeValues({ "생년월일": { value: "19900315", format: "date:yyyy.mm.dd" } })
    assert.equal(m.get("생년월일"), "1990.03.15")
    const arr = normalizeValues({ "연락처": { value: ["01011112222", "01033334444"], format: "phone:hyphen" } })
    assert.deepEqual(arr.get("연락처"), ["010-1111-2222", "010-3333-4444"])
  })
})

describe("fillWithUniqueGuard — 모호 라벨 거부", () => {
  it("스칼라 키가 2곳에 매칭되면 채우지 않고 rejected 보고", async () => {
    // 성명 라벨이 두 블록(대표자/참여인력)에 등장 — 스칼라 값이면 둘 다 채워질 위험
    const blocks: IRBlock[] = [
      tableBlock(makeTable([["성명", ""], ["부서", ""]])),
      tableBlock(makeTable([["성명", ""], ["직위", ""]])),
    ]
    const r = await fillWithUniqueGuard(
      { "성명": "홍길동", "부서": "기획" },
      vals => fillFormFields(blocks, vals),
    )
    assert.deepEqual(r.rejected, ["성명"])
    assert.ok(r.filled.every(f => f.key !== "성명"), "거부된 키는 채워지지 않아야")
    assert.ok(r.filled.some(f => f.key === "부서"), "유일 매칭 키는 정상 채움")
  })

  it("1곳 매칭이면 거부 없이 그대로", async () => {
    const blocks: IRBlock[] = [tableBlock(makeTable([["성명", ""], ["부서", ""]]))]
    const r = await fillWithUniqueGuard(
      { "성명": "홍길동" },
      vals => fillFormFields(blocks, vals),
    )
    assert.deepEqual(r.rejected, [])
    assert.equal(r.filled.length, 1)
    assert.equal(r.filled[0].value, "홍길동")
  })

  it("배열 값은 다중 등장 소진이 의도 — 거부하지 않는다", async () => {
    const blocks: IRBlock[] = [
      tableBlock(makeTable([["성명", ""]])),
      tableBlock(makeTable([["성명", ""]])),
    ]
    const r = await fillWithUniqueGuard(
      { "성명": ["김일번", "이이번"] },
      vals => fillFormFields(blocks, vals),
    )
    assert.deepEqual(r.rejected, [])
    assert.deepEqual(r.filled.map(f => f.value), ["김일번", "이이번"])
  })

  it("format 지정과 조합 — 거부 판정은 포맷 적용 후 채움 기준", async () => {
    const blocks: IRBlock[] = [tableBlock(makeTable([["생년월일", ""], ["부서", ""]]))]
    const r = await fillWithUniqueGuard(
      { "생년월일": { value: "19900315", format: "date:yyyy년 m월 d일" } },
      vals => fillFormFields(blocks, vals),
    )
    assert.deepEqual(r.rejected, [])
    assert.equal(r.filled[0].value, "1990년 3월 15일")
  })
})

describe("formatFillValue — 서식 엣지 회귀 (sfill-3~6)", () => {
  it("sfill-3: 미패딩 날짜(구분자 3토큰) 정상 해석 + 월/일 범위검증", () => {
    assert.equal(formatFillValue("2026.7.5", "date:yyyy-mm-dd"), "2026-07-05")
    assert.equal(formatFillValue("2026년 7월 5일", "date:yyyy-mm-dd"), "2026-07-05")
    assert.equal(formatFillValue("2026.12.5", "date:yyyy-mm-dd"), "2026-12-05")
    // 6자리 순수숫자에서 mm=26 은 범위 밖 → 쓰레기 날짜 대신 원형(fail-open)
    assert.equal(formatFillValue("202675", "date:yyyy-mm-dd"), "202675")
  })
  it("sfill-4: 대소문자 혼용(yyyy-MM-dd) 수용 + 영문 리터럴 보존", () => {
    assert.equal(formatFillValue("19900315", "yyyy-MM-dd"), "1990-03-15")
    assert.equal(formatFillValue("19900315", "date:yyyy-MM-dd"), "1990-03-15")
    assert.equal(formatFillValue("19900315", "date:yyyy-mm-dd (amended)"), "1990-03-15 (amended)")
  })
  it("sfill-5: 서울 02 는 2자리 지역번호", () => {
    assert.equal(formatFillValue("0212345678", "phone:hyphen"), "02-1234-5678")
    assert.equal(formatFillValue("021234567", "phone:hyphen"), "02-123-4567")
    assert.equal(formatFillValue("0212345678", "phone:intl"), "+82-2-1234-5678")
  })
  it("sfill-6: 자릿수 불일치·빈 결과는 원형 (무음 왜곡/삭제 금지)", () => {
    assert.equal(formatFillValue("123456789", "mask:###-##-#####"), "123456789") // 부족
    assert.equal(formatFillValue("12345678901", "mask:###-##-#####"), "12345678901") // 초과
    assert.equal(formatFillValue("500000", "#,###,###"), "500000") // 자유패턴 자릿수 불일치
    assert.equal(formatFillValue("01012345678", "mask"), "01012345678") // 스타일 없는 mask
    assert.equal(formatFillValue("홍길동", "digits"), "홍길동") // 숫자 없는 digits
  })
})

describe("fillWithUniqueGuard — hwpx 경로 & 접두사 오염 (sfill-1/2)", () => {
  it("sfill-1: hwpx-preserve 경로에서 성명 2곳 매칭 → rejected (전략 key 배선)", async () => {
    const md = "| 성명 |  |\n|---|---|\n\n중간 본문\n\n| 성명 |  |\n|---|---|\n"
    const ab = toAB(await markdownToHwpx(md))
    const r = await fillWithUniqueGuard({ 성명: "홍길동" }, (vals, blocked) => fillHwpx(ab, vals, blocked))
    assert.deepEqual(r.rejected, ["성명"])
    assert.equal(r.filled.length, 0, "거부된 성명은 어느 표에도 채워지지 않아야")
  })
  it("sfill-2: 주소지 거부 후 그 셀이 '주소' 값으로 오염되지 않는다", async () => {
    const blocks: IRBlock[] = [
      tableBlock(makeTable([["주소", ""]])),
      tableBlock(makeTable([["주소지", ""]])),
      tableBlock(makeTable([["주소지", ""]])),
    ]
    const r = await fillWithUniqueGuard(
      { 주소: "서울시 강남구 A", 주소지: "부산시 해운대 B" },
      (vals, blocked) => fillFormFields(blocks, vals, blocked),
    )
    assert.deepEqual(r.rejected, ["주소지"])
    // 거부된 주소지 셀에 남의 값(서울…)이 접두사 매칭으로 들어가면 안 됨
    assert.ok(
      !r.filled.some(f => normalizeLabel(f.label).includes("주소지")),
      "주소지 셀은 어떤 값도 채워지지 않아야 (오염 차단)",
    )
    assert.ok(r.filled.some(f => f.key === "주소" && f.value.startsWith("서울")), "주소는 정상 채움")
  })
  it("sfill-2: 전략0 인셀 패턴도 거부 라벨 접두사 폴백 오염을 차단", async () => {
    // 인셀 괄호빈칸 '주소(  )지' ×2 + 주소/주소지 키. 주소지 거부 후 전략0(fillInCellPatterns)이
    // 접두사 '주소'로 폴백해 남의 값을 채우면 안 됨 (전략 1~3만 가드됐던 구멍).
    const md = "| A | 주소(  )지 |\n|---|---|\n\n| B | 주소(  )지 |\n|---|---|\n"
    const ab = toAB(await markdownToHwpx(md))
    const r = await fillWithUniqueGuard(
      { 주소: "서울시 강남구 A", 주소지: "부산시 해운대 B" },
      (vals, blocked) => fillHwpx(ab, vals, blocked),
    )
    assert.deepEqual(r.rejected, ["주소지"])
    const reparsed = await parse(Buffer.from(r.buffer))
    assert.ok(reparsed.success)
    assert.doesNotMatch(reparsed.markdown, /서울시 강남구 A/, "거부된 주소지 셀에 주소 값 오염 없어야 (전략0)")
  })
})

describe("mask_values verify 정규화 (sfill-7)", () => {
  it("escape되는 * 포함 rrn:masked 값이 정규화 비교로 FILLED 매칭된다", async () => {
    const md = "| 주민등록번호 |  |\n|---|---|\n"
    const ab = toAB(await markdownToHwpx(md))
    const res = await fillHwpx(ab, { 주민등록번호: { value: "9003151234567", format: "rrn:masked" } })
    assert.equal(res.filled.length, 1, "주민등록번호 채워짐")
    const val = res.filled[0].value // '900315-1******'
    const reparsed = await parse(Buffer.from(res.buffer))
    assert.ok(reparsed.success)
    // mcp verify 와 동일한 정규화 (마크다운 이스케이프 해제 + 공백 접기)
    const norm = (s: string): string => s.replace(/\\([\\`*_{}[\]()#+.!|~>-])/g, "$1").replace(/\s+/g, " ")
    assert.equal(reparsed.markdown.includes(val), false, "raw 비교는 * 이스케이프로 false negative(원 결함)")
    assert.ok(norm(reparsed.markdown).includes(norm(val)), "정규화 비교는 FILLED 로 매칭(수정)")
  })
})

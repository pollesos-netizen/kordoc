/**
 * P4 secure-fill 이식 (claw-hwp) — 값 서식 변환 + 모호 라벨 거부 가드.
 * formatFillValue: 정준값 하나 → 서식별 모양 (도구 안 변환, 값이 대화에 안 남게).
 * fillWithUniqueGuard: 스칼라 키가 2곳+ 매칭되면 채우지 않고 rejected 보고.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { formatFillValue, fillWithUniqueGuard, normalizeValues } from "../src/form/match.js"
import { fillFormFields } from "../src/form/filler.js"
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

  it("# 숫자마스크 — 리터럴 통과, 숫자만 소비", () => {
    assert.equal(formatFillValue("1234567890123", "mask:###-##-#####"), "123-45-67890")
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

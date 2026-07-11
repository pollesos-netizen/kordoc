/**
 * v4.0.5 P0-1 회귀 — charPr/paraPr/borderFill id 파티션 불변식.
 *
 * id 공간은 여러 모듈(gen-ids 상수·장평 variant·프로필·docframe·표 레지스트리)이
 * 손계산으로 이어 쓴다. 카운트 상수(GJ_CHAR_COUNT류)나 base 산술이 한 칸 밀리면
 * run이 엉뚱한 서식을 가리켜도 well-formed라 조용히 렌더만 틀린다(무음 폰트오염).
 * 여기서 프리셋·옵션 조합 전수에 대해 다음을 잠근다:
 *   1. 방출 id가 중복·구멍 없이 연속 (charPr/paraPr 0부터, borderFill 1부터)
 *   2. itemCnt == 실제 방출 수
 *   3. section0.xml의 모든 IDRef가 header에 실존 (dangling 참조 0)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import type { FormatProfile } from "../src/hwpx/gen-profile.js"

async function parts(buf: ArrayBuffer): Promise<{ header: string; section: string }> {
  const zip = await JSZip.loadAsync(buf)
  return {
    header: await zip.file("Contents/header.xml")!.async("text"),
    section: await zip.file("Contents/section0.xml")!.async("text"),
  }
}

/** header에서 특정 블록의 (itemCnt, 방출 id 배열) 추출 */
function idsOf(header: string, block: "charProperties" | "paraProperties" | "borderFills", entry: string): { itemCnt: number; ids: number[] } {
  const m = header.match(new RegExp(`<hh:${block} itemCnt="(\\d+)">([\\s\\S]*?)</hh:${block}>`))
  assert.ok(m, `${block} 블록 존재`)
  const ids = [...m![2].matchAll(new RegExp(`<hh:${entry} id="(\\d+)"`, "g"))].map((x) => Number(x[1]))
  return { itemCnt: Number(m![1]), ids }
}

function assertPartition(header: string): void {
  for (const [block, entry, start] of [
    ["charProperties", "charPr", 0],
    ["paraProperties", "paraPr", 0],
    ["borderFills", "borderFill", 1],
  ] as const) {
    const { itemCnt, ids } = idsOf(header, block, entry)
    assert.equal(ids.length, itemCnt, `${block}: itemCnt(${itemCnt}) == 방출 수(${ids.length})`)
    for (let i = 0; i < ids.length; i++) {
      assert.equal(ids[i], start + i, `${block}: ${i}번째 방출 id — 중복·구멍 없이 연속`)
    }
  }
}

/** section의 모든 IDRef가 header 방출 id 집합 안에 있는지 (dangling 0) */
function assertNoDangling(header: string, section: string): void {
  const charIds = new Set(idsOf(header, "charProperties", "charPr").ids)
  const paraIds = new Set(idsOf(header, "paraProperties", "paraPr").ids)
  const bfIds = new Set(idsOf(header, "borderFills", "borderFill").ids)
  for (const [attr, set, name] of [
    ["charPrIDRef", charIds, "charPr"],
    ["paraPrIDRef", paraIds, "paraPr"],
    ["borderFillIDRef", bfIds, "borderFill"],
  ] as const) {
    for (const m of section.matchAll(new RegExp(`${attr}="(\\d+)"`, "g"))) {
      assert.ok(set.has(Number(m[1])), `${name} dangling 참조: ${attr}="${m[1]}"`)
    }
  }
}

// 프리앰블·docframe·표·리스트·인용·수식을 두루 밟는 본문
const MD = `# 문서 제목

## 대분류 하나

1. 첫째 항목 내용이 이어진다
  - 둘째 단계 항목
    - 셋째 단계 항목

> 참고 인용문

| 구분 | 내용 |
|------|------|
| 가   | 나   |

## 대분류 둘

본문 단락. **강조**와 *기울임*이 섞인다.
`

const PROFILE: FormatProfile = {
  tables: [
    {
      table_index: 0, rows: 2, cols: 2, anchor_text: "구분",
      cells: [{ row: 0, col: 0, borderFillIDRef: "10" }],
      used_border_fills: { "10": { topBorder: { type: "SOLID", width: "0.4 mm", color: "#112233" } } },
    },
  ],
}

const CASES: Array<{ name: string; opts: Parameters<typeof markdownToHwpx>[1] }> = [
  { name: "비공문서", opts: undefined },
  { name: "비공문서+profile", opts: { profile: PROFILE } },
  { name: "official", opts: { gongmun: { preset: "official" } } },
  {
    name: "official+docHead+docFoot+approval(조합)",
    opts: {
      gongmun: {
        preset: "official",
        docHead: { org: "행정안전부", docNo: "행안부-2026-1", date: "2026. 7. 11." },
        docFoot: { sender: "행정안전부장관" },
        approval: { steps: ["담당", "팀장", "국장"] },
      },
    },
  },
  { name: "official+profile", opts: { gongmun: { preset: "official" }, profile: PROFILE } },
  { name: "report", opts: { gongmun: { preset: "report" } } },
  { name: "plan", opts: { gongmun: { preset: "plan" } } },
  { name: "gaejosik(표지+목차 rich)", opts: { gongmun: { preset: "gaejosik" } } },
  { name: "gaejosik+profile", opts: { gongmun: { preset: "gaejosik" }, profile: PROFILE } },
  { name: "notice", opts: { gongmun: { preset: "notice" } } },
  { name: "press", opts: { gongmun: { preset: "press" } } },
  { name: "minutes", opts: { gongmun: { preset: "minutes" } } },
]

describe("v4.0.5 id 파티션 불변식 회귀", () => {
  for (const c of CASES) {
    it(`${c.name} — id 연속·itemCnt 일치·dangling 0`, async () => {
      const buf = await markdownToHwpx(MD, c.opts)
      const { header, section } = await parts(buf)
      assertPartition(header)
      assertNoDangling(header, section)
    })
  }

  it("긴 본문(자동장평 variant 유발)에서도 파티션 유지", async () => {
    // orphan 압축 장평 variant가 실제로 발급되도록 줄 끝에 한두 글자 넘치는 문장 다수
    const long = Array.from({ length: 12 }, (_, i) =>
      `${i + 1}. 자동 장평 계획이 발동하도록 길이를 정확히 맞춘 항목 문장이며 끝에 두 글자가 넘친다고 가정한다 확인`,
    ).join("\n")
    const buf = await markdownToHwpx(`# 제목\n\n${long}`, { gongmun: { preset: "official" } })
    const { header, section } = await parts(buf)
    assertPartition(header)
    assertNoDangling(header, section)
  })
})

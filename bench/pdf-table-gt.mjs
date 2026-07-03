#!/usr/bin/env node
// A-1: PDF 표 구조 채점 — 같은 문서 hwpx↔pdf 쌍(corpus/pairs/)에서 hwpx IR 표
// (hwpx 트랙 표 611/611·cellExact 1.0으로 신뢰 검증됨)를 GT로 pdf IR 표를 대조.
// coverage(텍스트 trigram)가 못 보는 구조 붕괴(2단 조판 사건 류)를 메우는 트랙.
//
// 주의: pdf는 페이지 단위로 표가 쪼개지고(분할표 병합 보정이 일부 흡수) 병합·머리글
// 표현이 hwpx와 다를 수 있어 만점이 목표가 아니다 — 기준선 잠금 후 무후퇴 감시.
// 게이트 편입은 개선 작업으로 수치가 자리 잡은 후 (현재 --gate 는 파싱 실패만 실패 처리).
//
// 기준선 (2026-07-03, 2회 연속 동일): ref 표 72 | 매칭 0.8194 | exact 0.5139 |
// cellF1 0.604629 | cellExact 0.651362 | contentNED 0.491512
// 미달 성격 (pair11 상세 분석): 진짜 표 12/18 exact — 잔여는 ①hwpx 25x14→pdf 24x10
// 같은 병합 열 표현 차 ②pdf 미감지 표의 DP 오매칭 연쇄 ③잉여 pdf 표(과분할).
//
// 사용법: node bench/pdf-table-gt.mjs [--gate] [--doc=부분문자열] [--verbose]

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "../dist/index.js"
import { irAnchors, scoreTables } from "./lib/table-score.mjs"

const root = new URL(".", import.meta.url).pathname
const args = process.argv.slice(2)
const gateMode = args.includes("--gate")
const verbose = args.includes("--verbose")
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null

const round = (x, d = 6) => (x === null || x === undefined ? null : +x.toFixed(d))

const t0 = performance.now()
const dir = join(root, "corpus", "pairs")
const names = await readdir(dir)
const pairs = names
  .filter(n => n.endsWith(".pdf"))
  .map(n => n.replace(/\.pdf$/, ""))
  .filter(base => names.includes(base + ".hwpx"))
  .filter(base => !docFilter || base.includes(docFilter))
  .sort()

const rows = []
let parseErrors = 0
const agg = { refTables: 0, matched: 0, exact: 0, cellTotal: 0, cellExact: 0, contentNum: 0, contentDen: 0, f1Sum: 0 }

for (const base of pairs) {
  const row = { pair: base }
  try {
    const hwpx = await parse(await readFile(join(dir, base + ".hwpx")), { filename: base + ".hwpx" })
    const pdf = await parse(await readFile(join(dir, base + ".pdf")), { filename: base + ".pdf" })
    if (!hwpx.success) throw new Error(`hwpx 파싱 실패: ${hwpx.error}`)
    if (!pdf.success) throw new Error(`pdf 파싱 실패: ${pdf.error}`)

    // 비교 모수 = 최상위 표 중 2행×2열 이상 (양쪽 동일 규칙).
    // 1×1은 래퍼/안내박스 관행이라 제외하되, 셀 안에 중첩표를 담은 래퍼(공문
    // "표 안에 표")는 중첩표를 비교 단위로 승격 (pdf는 래퍼 없이 안쪽 표를 감지).
    // N×1/1×N 스트립은 글상자·머리띠 관행으로 hwpx/pdf 표 의미가 갈리는 지점이라
    // 제외 — 구조 붕괴 신호는 2×2+ 그리드에서 나타나고, 텍스트 자체는 coverage
    // 트랙이 감시한다. 다중 셀 표의 중첩은 pdf가 부모 그리드로 평탄화하므로
    // 승격하지 않는다.
    const topGrids = blocks => {
      const out = []
      const push = (table, depth = 0) => {
        if (depth > 12) return
        const { rows, cols, cells } = table
        if (rows === 1 && cols === 1) {
          for (const b of cells[0]?.[0]?.blocks ?? []) {
            if (b.type === "table" && b.table) push(b.table, depth + 1)
          }
          return
        }
        if (rows < 2 || cols < 2) return
        out.push(irAnchors(table))
      }
      for (const b of blocks ?? []) if (b.type === "table" && b.table) push(b.table)
      return out
    }
    // ref = hwpx IR 그리드 (irAnchors의 anchors를 scoreTables ref 형태 cells로)
    const refGrids = topGrids(hwpx.blocks).map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors }))
    const irGrids = topGrids(pdf.blocks)
    const s = scoreTables(refGrids, irGrids)

    row.ok = true
    row.refTables = s.tableCount
    row.pdfTables = s.irTableCount
    row.matched = s.tableCount - s.unmatchedRef
    row.exact = s.exactCount
    row.splitMerged = s.splitTables
    row.cellF1 = round(s.cellF1)
    row.cellExactRate = round(s.cellExactRate)
    row.contentNED = round(s.contentNED)
    row.unmatchedRef = s.unmatchedRef
    row.unmatchedIr = s.unmatchedIr
    if (verbose) row.details = s.details

    agg.refTables += s.tableCount
    agg.matched += row.matched
    agg.exact += s.exactCount
    agg.cellTotal += s.cellTotal
    agg.cellExact += s.cellExact
    agg.contentNum += s.contentNum
    agg.contentDen += s.contentDen
    agg.f1Sum += s.cellF1 * s.tableCount
  } catch (err) {
    parseErrors++
    row.ok = false
    row.error = String(err?.message ?? err).slice(0, 160)
  }
  rows.push(row)
}

const summary = {
  pairs: rows.length,
  parseErrors,
  refTables: agg.refTables,
  matchedRate: round(agg.refTables ? agg.matched / agg.refTables : 1),
  exactRate: round(agg.refTables ? agg.exact / agg.refTables : 1),
  cellF1: round(agg.refTables ? agg.f1Sum / agg.refTables : 1),
  cellExactRate: round(agg.cellTotal ? agg.cellExact / agg.cellTotal : 1),
  contentNED: round(agg.contentDen ? agg.contentNum / agg.contentDen : 1),
}

const elapsed = ((performance.now() - t0) / 1000).toFixed(0)
console.log(`\n══ PDF 표 구조 GT — hwpx↔pdf ${rows.length}쌍 (${elapsed}s) ══`)
console.log(`  ref 표 ${summary.refTables} | 매칭 ${round(summary.matchedRate * 100, 2)}% | exact ${round(summary.exactRate * 100, 2)}%`)
console.log(`  cellF1 ${summary.cellF1} | cellExact ${summary.cellExactRate} | contentNED ${summary.contentNED}`)
for (const r of rows) {
  if (!r.ok) { console.log(`  ❌ ${r.pair}: ${r.error}`); continue }
  console.log(`  ${r.pair}: ref ${r.refTables} → 매칭 ${r.matched} (분할병합 ${r.splitMerged}) exact ${r.exact} | F1 ${r.cellF1} NED ${r.contentNED} | pdf잉여 ${r.unmatchedIr}`)
}

await mkdir(join(root, "out"), { recursive: true })
await writeFile(join(root, "out", "pdf-table.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 1))
console.log(`report → bench/out/pdf-table.json${gateMode ? (parseErrors ? " | FAIL ❌" : " | PASS ✅") : ""}`)
if (gateMode && parseErrors) process.exit(1)

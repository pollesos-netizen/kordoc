#!/usr/bin/env node
// 파싱 성능 벤치 — 속도/처리량/강건성/라운드트립 수치화
// 사용법: node bench/perf.mjs [corpus하위경로...]  (기본: review hwp5)
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { parse, patchHwpx, patchHwp, extractFormFields } from "../dist/index.js"

const root = new URL(".", import.meta.url).pathname
const dirs = process.argv.slice(2).filter(a => !a.startsWith("--"))
if (dirs.length === 0) dirs.push("review", "hwp5")

const files = []
for (const d of dirs) {
  const full = join(root, "corpus", d)
  try {
    for (const f of await readdir(full)) {
      if (/\.(hwpx?|pdf)$/i.test(f)) files.push(join(full, f))
    }
  } catch { /* 디렉토리 없으면 무시 */ }
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] : 0
}
const fmt = n => n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)

// ── 그룹별 집계: 확장자 → { ms[], bytes[], blocks[], fail[] } ──
const groups = new Map()
const g = ext => { if (!groups.has(ext)) groups.set(ext, { ms: [], bytes: [], blocks: [], warm: [], fails: [], noopFail: [], noopOk: 0, fields: 0, fieldFiles: 0 }); return groups.get(ext) }

for (const path of files) {
  const buf = await readFile(path)
  const ext = path.match(/\.(\w+)$/)[1].toLowerCase()
  const G = g(ext)
  const name = path.split("/").pop()

  // 콜드 1회 측정 (파일별 첫 파싱)
  let r
  const t0 = performance.now()
  try {
    r = await parse(buf)
  } catch (e) {
    G.fails.push(`${name}: 예외 ${e.message?.slice(0, 60)}`)
    continue
  }
  const cold = performance.now() - t0
  if (!r.success) { G.fails.push(`${name}: ${r.error?.slice(0, 60)}`); continue }
  G.ms.push(cold)
  G.bytes.push(buf.length)
  G.blocks.push(r.blocks?.length ?? 0)

  // 웜 3회 중앙값 (JIT 반영 정속)
  const warms = []
  for (let k = 0; k < 3; k++) {
    const w0 = performance.now()
    await parse(buf)
    warms.push(performance.now() - w0)
  }
  G.warm.push(pct(warms, 50))

  // 라운드트립 no-op 바이트 동일
  try {
    const pr = ext === "hwpx" ? await patchHwpx(new Uint8Array(buf), r.markdown)
      : ext === "hwp" ? await patchHwp(new Uint8Array(buf), r.markdown)
      : null
    if (pr) {
      if (pr.success && Buffer.from(pr.data).equals(buf)) G.noopOk++
      else G.noopFail.push(`${name}: ${pr.success ? "바이트 불일치" : pr.error?.slice(0, 50)}`)
    }
  } catch (e) {
    G.noopFail.push(`${name}: 예외 ${e.message?.slice(0, 50)}`)
  }

  // 폼 인식 필드 수
  try {
    const ff = extractFormFields(r.blocks ?? [])
    const n = Array.isArray(ff) ? ff.length : (ff?.fields?.length ?? 0)
    if (n > 0) { G.fields += n; G.fieldFiles++ }
  } catch { /* 폼 아님 */ }
}

// ── 리포트 ──
for (const [ext, G] of groups) {
  const n = G.ms.length
  console.log(`\n=== .${ext} (${n}건 성공 / ${G.fails.length}건 실패) ===`)
  if (n > 0) {
    const totalMB = G.bytes.reduce((a, b) => a + b, 0) / 1048576
    const totalSec = G.ms.reduce((a, b) => a + b, 0) / 1000
    console.log(`  콜드: median ${fmt(pct(G.ms, 50))}ms · p95 ${fmt(pct(G.ms, 95))}ms · max ${fmt(pct(G.ms, 100))}ms`)
    console.log(`  웜:   median ${fmt(pct(G.warm, 50))}ms · p95 ${fmt(pct(G.warm, 95))}ms`)
    console.log(`  처리량: ${fmt(totalMB / totalSec)} MB/s (총 ${fmt(totalMB)}MB / ${fmt(totalSec)}s)`)
    console.log(`  파일: median ${fmt(pct(G.bytes, 50) / 1024)}KB · max ${fmt(pct(G.bytes, 100) / 1024)}KB · 블록 median ${pct(G.blocks, 50)}`)
    const noopTotal = G.noopOk + G.noopFail.length
    if (noopTotal) console.log(`  no-op 라운드트립: ${G.noopOk}/${noopTotal} 바이트동일`)
    if (G.fieldFiles) console.log(`  폼 인식: ${G.fieldFiles}건에서 ${G.fields}필드`)
  }
  for (const f of G.fails) console.log(`  ❌ ${f}`)
  for (const f of G.noopFail) console.log(`  ⚠ no-op: ${f}`)
}

// ── 대형 파일 단독 측정 (big_file.hwp 있으면) ──
try {
  const big = await readFile(join(root, "corpus", "hwp5", "big_file.hwp"))
  global.gc?.()
  const m0 = process.memoryUsage().heapUsed
  const t0 = performance.now()
  const r = await parse(big)
  const ms = performance.now() - t0
  const peak = (process.memoryUsage().heapUsed - m0) / 1048576
  console.log(`\n=== 대형 파일 (big_file.hwp ${fmt(big.length / 1048576)}MB) ===`)
  console.log(`  파싱: ${fmt(ms)}ms · ${fmt(big.length / 1048576 / (ms / 1000))} MB/s · 블록 ${r.blocks?.length} · 힙증가 ~${fmt(peak)}MB (--expose-gc 없으면 근사)`)
  console.log(`  markdown 길이: ${(r.markdown?.length ?? 0).toLocaleString()}자`)
} catch { /* 없으면 생략 */ }

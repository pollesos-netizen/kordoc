/** kordoc CLI — 모두 파싱해버리겠다 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { basename, resolve } from "path"
import { Command } from "commander"
import { parse, detectFormat } from "./index.js"
import { VERSION, toArrayBuffer } from "./utils.js"

const program = new Command()

program
  .name("kordoc")
  .description("모두 파싱해버리겠다 — HWP, HWPX, PDF → Markdown")
  .version(VERSION)
  .argument("<files...>", "변환할 파일 경로 (HWP, HWPX, PDF)")
  .option("-o, --output <path>", "출력 파일 경로 (단일 파일 시)")
  .option("-d, --out-dir <dir>", "출력 디렉토리 (다중 파일 시)")
  .option("-p, --pages <range>", "페이지/섹션 범위 (예: 1-3, 1,3,5)")
  .option("--format <type>", "출력 형식: markdown (기본) 또는 json", "markdown")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (files: string[], opts) => {
    for (const filePath of files) {
      const absPath = resolve(filePath)
      const fileName = basename(absPath)

      try {
        const fileSize = statSync(absPath).size
        if (fileSize > 500 * 1024 * 1024) {
          process.stderr.write(`\n[kordoc] SKIP: ${fileName} — 파일이 너무 큽니다 (${(fileSize / 1024 / 1024).toFixed(1)}MB)\n`)
          process.exitCode = 1
          continue
        }
        const buffer = readFileSync(absPath)
        const arrayBuffer = toArrayBuffer(buffer)
        const format = detectFormat(arrayBuffer)

        if (!opts.silent) {
          process.stderr.write(`[kordoc] ${fileName} (${format}) ...`)
        }

        const parseOptions = opts.pages ? { pages: opts.pages as string } : undefined
        const result = await parse(arrayBuffer, parseOptions)

        if (!result.success) {
          process.stderr.write(` FAIL\n`)
          process.stderr.write(`  → ${result.error}\n`)
          process.exitCode = 1
          continue
        }

        if (!opts.silent) process.stderr.write(` OK\n`)

        const output = opts.format === "json"
          ? JSON.stringify(result, null, 2)
          : result.markdown

        if (opts.output && files.length === 1) {
          writeFileSync(opts.output, output, "utf-8")
          if (!opts.silent) process.stderr.write(`  → ${opts.output}\n`)
        } else if (opts.outDir) {
          mkdirSync(opts.outDir, { recursive: true })
          const outExt = opts.format === "json" ? ".json" : ".md"
          const outPath = resolve(opts.outDir, fileName.replace(/\.[^.]+$/, outExt))
          writeFileSync(outPath, output, "utf-8")
          if (!opts.silent) process.stderr.write(`  → ${outPath}\n`)
        } else {
          process.stdout.write(output + "\n")
        }
      } catch (err) {
        process.stderr.write(`\n[kordoc] ERROR: ${fileName} — ${err instanceof Error ? err.message : err}\n`)
        process.exitCode = 1
      }
    }
  })

program
  .command("watch <dir>")
  .description("디렉토리 감시 — 새 문서 자동 변환")
  .option("--webhook <url>", "결과 전송 웹훅 URL")
  .option("-d, --out-dir <dir>", "변환 결과 출력 디렉토리")
  .option("-p, --pages <range>", "페이지/섹션 범위")
  .option("--format <type>", "출력 형식: markdown 또는 json", "markdown")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (dir: string, opts) => {
    const { watchDirectory } = await import("./watch.js")
    await watchDirectory({
      dir,
      outDir: opts.outDir,
      webhook: opts.webhook,
      format: opts.format,
      pages: opts.pages,
      silent: opts.silent,
    })
  })

program.parse()

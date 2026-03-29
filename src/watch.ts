/** 디렉토리 감시 모드 — 새 문서 자동 변환 + Webhook 알림 */

import { watch, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "fs"
import { basename, resolve, extname } from "path"
import { parse, detectFormat } from "./index.js"
import { toArrayBuffer } from "./utils.js"
import type { WatchOptions } from "./types.js"

const SUPPORTED_EXTENSIONS = new Set([".hwp", ".hwpx", ".pdf"])
const DEBOUNCE_MS = 500
const MAX_FILE_SIZE = 500 * 1024 * 1024

/**
 * 디렉토리를 감시하여 새 문서 파일을 자동 변환.
 *
 * @example
 * ```bash
 * kordoc watch ./incoming -d ./output --webhook https://api.example.com/docs
 * ```
 */
export async function watchDirectory(options: WatchOptions): Promise<void> {
  const { dir, outDir, webhook, format = "markdown", pages, silent } = options

  if (!existsSync(dir)) throw new Error(`디렉토리를 찾을 수 없습니다: ${dir}`)
  if (outDir) mkdirSync(outDir, { recursive: true })

  const log = silent ? () => {} : (msg: string) => process.stderr.write(msg + "\n")
  log(`[kordoc watch] 감시 시작: ${resolve(dir)}`)
  if (outDir) log(`[kordoc watch] 출력: ${resolve(outDir)}`)
  if (webhook) log(`[kordoc watch] 웹훅: ${webhook}`)

  // 디바운스 맵
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  const processFile = async (filePath: string) => {
    const ext = extname(filePath).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) return

    const fileName = basename(filePath)
    try {
      const absPath = resolve(dir, filePath)
      if (!existsSync(absPath)) return

      const fileSize = statSync(absPath).size
      if (fileSize > MAX_FILE_SIZE || fileSize === 0) return

      log(`[kordoc watch] 변환 중: ${fileName}`)

      const buffer = readFileSync(absPath)
      const arrayBuffer = toArrayBuffer(buffer)
      const parseOptions = pages ? { pages } : undefined
      const result = await parse(arrayBuffer, parseOptions)

      if (!result.success) {
        log(`[kordoc watch] 실패: ${fileName} — ${result.error}`)
        await sendWebhook(webhook, { file: fileName, format: detectFormat(arrayBuffer), success: false, error: result.error })
        return
      }

      const output = format === "json" ? JSON.stringify(result, null, 2) : result.markdown

      if (outDir) {
        const outExt = format === "json" ? ".json" : ".md"
        const outPath = resolve(outDir, fileName.replace(/\.[^.]+$/, outExt))
        writeFileSync(outPath, output, "utf-8")
        log(`[kordoc watch] 완료: ${fileName} → ${basename(outPath)}`)
      } else {
        process.stdout.write(output + "\n")
      }

      await sendWebhook(webhook, {
        file: fileName,
        format: result.fileType,
        success: true,
        markdown: format === "markdown" ? output.substring(0, 1000) : undefined,
      })
    } catch (err) {
      log(`[kordoc watch] 에러: ${fileName} — ${err instanceof Error ? err.message : err}`)
    }
  }

  // fs.watch recursive (Node 18+ Windows/macOS, Node 19+ Linux)
  watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return
    const filePath = filename.toString()

    // 디바운스
    const existing = pending.get(filePath)
    if (existing) clearTimeout(existing)
    pending.set(filePath, setTimeout(() => {
      pending.delete(filePath)
      processFile(filePath).catch(() => {})
    }, DEBOUNCE_MS))
  })

  // 프로세스 종료 방지 (Ctrl+C로 종료)
  return new Promise(() => {})
}

async function sendWebhook(url: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!url) return
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
    })
  } catch {
    // webhook 실패는 조용히 무시
  }
}

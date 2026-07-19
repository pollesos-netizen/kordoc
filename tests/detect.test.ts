import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectFormat, isHwpxFile, isOldHwpFile, isPdfFile, isImageFile } from "../src/detect.js"

describe("detectFormat", () => {
  it("ZIP 매직바이트(PK\\x03\\x04)를 hwpx로 감지", () => {
    const buf = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).buffer
    assert.equal(detectFormat(buf), "hwpx")
    assert.equal(isHwpxFile(buf), true)
    assert.equal(isOldHwpFile(buf), false)
    assert.equal(isPdfFile(buf), false)
  })

  it("OLE2 매직바이트(\\xD0\\xCF\\x11\\xE0)를 hwp로 감지", () => {
    const buf = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]).buffer
    assert.equal(detectFormat(buf), "hwp")
    assert.equal(isOldHwpFile(buf), true)
  })

  it("%PDF 매직바이트를 pdf로 감지", () => {
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]).buffer
    assert.equal(detectFormat(buf), "pdf")
    assert.equal(isPdfFile(buf), true)
  })

  it("PNG/JPEG/WebP 매직바이트를 image로 감지", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
    for (const buf of [png, jpg, webp]) {
      assert.equal(detectFormat(buf), "image")
      assert.equal(isImageFile(buf), true)
    }
    // RIFF지만 WEBP 아닌 것(WAV 등)은 image 아님
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]).buffer
    assert.equal(isImageFile(wav), false)
  })

  it("알 수 없는 바이트는 unknown 반환", () => {
    const buf = new Uint8Array([0xff, 0xfe, 0x00, 0x00]).buffer
    assert.equal(detectFormat(buf), "unknown")
  })

  it("빈 버퍼도 unknown 반환 (크래시 없음)", () => {
    const buf = new ArrayBuffer(0)
    assert.equal(detectFormat(buf), "unknown")
  })

  it("3바이트 미만 버퍼도 안전하게 처리", () => {
    const buf = new Uint8Array([0x50, 0x4b]).buffer
    assert.equal(detectFormat(buf), "unknown")
  })
})

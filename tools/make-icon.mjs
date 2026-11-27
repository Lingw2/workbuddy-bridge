/**
 * Generate the application icon.
 *
 * The icon is drawn here instead of shipping a binary blob so the mark stays
 * editable: a rounded square with a bridge arch, in the same green the UI
 * uses. Run `node tools/make-icon.mjs` to regenerate it.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const ACCENT = [0x1f, 0x6f, 0x5c]
const LIGHT = [0xf6, 0xf7, 0xf5]

/** Write a PNG from raw RGBA pixels. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

/** Is (x, y) inside the rounded square? */
function inRoundedSquare(x, y, size, radius) {
  const min = radius
  const max = size - radius
  const cx = x < min ? min : x > max ? max : x
  const cy = y < min ? min : y > max ? max : y
  if (x >= min && x <= max) return y >= 0 && y <= size
  if (y >= min && y <= max) return x >= 0 && x <= size
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

/** Is (x, y) on the bridge arch (two piers plus a curve)? */
function inArch(x, y, size) {
  const unit = size / 32
  const deckTop = 21 * unit
  const deckBottom = 23 * unit

  // the deck
  if (y >= deckTop && y <= deckBottom && x >= 7 * unit && x <= 25 * unit) return true

  // the arch: a ring between two radii
  const cx = 16 * unit
  const cy = deckTop
  const outer = 9 * unit
  const inner = 6.4 * unit
  const dx = x - cx
  const dy = y - cy
  if (dy > 0) return false
  const r = Math.hypot(dx, dy)
  if (r < inner || r > outer) return false

  // the piers
  if (y >= deckTop && y <= 26 * unit) {
    if (x >= 7 * unit && x <= 8.6 * unit) return true
    if (x >= 23.4 * unit && x <= 25 * unit) return true
  }
  return true
}

/** Render the icon at one size. */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = 3
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0
      let mark = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples
          const py = y + (sy + 0.5) / samples
          if (inRoundedSquare(px, py, size, size * 0.22)) bg++
          if (inArch(px, py, size)) mark++
        }
      }
      const total = samples * samples
      const bgAlpha = bg / total
      const markAlpha = mark / total
      const i = (y * size + x) * 4
      for (let c = 0; c < 3; c++) {
        const base = ACCENT[c] * bgAlpha
        const over = LIGHT[c] * markAlpha
        rgba[i + c] = Math.round(base * (1 - markAlpha) + over)
      }
      rgba[i + 3] = Math.round(bgAlpha * 255)
    }
  }
  return encodePng(size, size, rgba)
}

for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  const dir = join(ROOT, 'desktop', 'icons')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `icon-${size}.png`), render(size))
  console.log(`wrote desktop/icons/icon-${size}.png`)
}

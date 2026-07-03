// Generates the desktop app icons (resources/icon.png|icns|ico) from the same
// vector data as the sidebar Logo (src/renderer/src/shell/logo.tsx) — the official
// stepped "M" mark centered on a macOS-style rounded-rect tile in the app's warm
// sidebar tone. Dependency-free: the mark is 8 axis-aligned rects, so we rasterize
// with analytic box-filter coverage and write PNGs by hand (zlib for IDAT).
//
// Run (macOS; `iconutil` builds the .icns):
//   node scripts/generate-app-icon.mjs
//
// Re-run whenever the brand mark or tile styling changes, then commit resources/.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCES = join(ROOT, 'resources')

// The mark's rects in the 191×135 viewBox (verbatim from logo.tsx paths).
const MARK_RECTS = [
  { x: 27.1531, y: 0, w: 27.169, h: 27.0892, c: '#FFD800' },
  { x: 135.815, y: 0, w: 27.169, h: 27.0892, c: '#FFD800' },
  { x: 27.1531, y: 27.0918, w: 54.3292, h: 27.0892, c: '#FFAF00' },
  { x: 108.661, y: 27.0918, w: 54.329, h: 27.0892, c: '#FFAF00' },
  { x: 27.1531, y: 54.168, w: 135.8189, h: 27.0892, c: '#FF8205' },
  { x: 27, y: 81, w: 27, h: 54, c: '#FA500F' },
  { x: 81.4917, y: 81.2598, w: 27.1693, h: 27.0892, c: '#FA500F' },
  { x: 136, y: 81, w: 27, h: 54, c: '#FA500F' },
]
// Tight bounds of the mark (the viewBox has side whitespace; the drawn mark is
// nearly square: 136×135) — we center these bounds, not the viewBox.
const MARK = { x: 27, y: 0, w: 136, h: 135 }

// Tile styling: Apple's Big Sur icon grid — an 824/1024 rounded rect on a
// transparent canvas, corner radius 185/824. Warm sidebar tone (--sidebar).
const TILE_FRACTION = 824 / 1024
const TILE_RADIUS_FRACTION = 185 / 824
const TILE_COLOR = '#F5F3EF'
const MARK_FRACTION = 0.58 // mark height relative to the tile

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

// 1D overlap of pixel [px, px+1) with span [lo, hi) — box-filter coverage.
function overlap1d(px, lo, hi) {
  return Math.max(0, Math.min(px + 1, hi) - Math.max(px, lo))
}

// Coverage of pixel (px,py) by a rounded rect (analytic corners, AA edges).
function roundRectCoverage(px, py, lo, hi, r) {
  const cx = px + 0.5
  const cy = py + 0.5
  const innerLo = lo + r
  const innerHi = hi - r
  // Signed distance to the rounded rect.
  const dx = Math.max(innerLo - cx, 0, cx - innerHi)
  const dy = Math.max(innerLo - cy, 0, cy - innerHi)
  const dist = Math.hypot(dx, dy) - r
  const edge = Math.max(overlap1d(px, lo, hi), 0.001) // straight edges: box filter
  if (dx > 0 && dy > 0) return Math.min(1, Math.max(0, 0.5 - dist)) // corner arc
  return Math.min(edge, overlap1d(py, lo, hi))
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const tileLo = ((1 - TILE_FRACTION) / 2) * size
  const tileHi = size - tileLo
  const tileR = (tileHi - tileLo) * TILE_RADIUS_FRACTION
  const [tr, tg, tb] = hexToRgb(TILE_COLOR)

  // The mark, scaled to MARK_FRACTION of the tile and centered on it.
  const scale = ((tileHi - tileLo) * MARK_FRACTION) / MARK.h
  const offX = size / 2 - (MARK.x + MARK.w / 2) * scale
  const offY = size / 2 - (MARK.y + MARK.h / 2) * scale
  const rects = MARK_RECTS.map((r) => ({
    x0: r.x * scale + offX,
    y0: r.y * scale + offY,
    x1: (r.x + r.w) * scale + offX,
    y1: (r.y + r.h) * scale + offY,
    rgb: hexToRgb(r.c),
  }))

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const tile = roundRectCoverage(x, y, tileLo, tileHi, tileR)
      if (tile <= 0) continue
      let r = tr
      let g = tg
      let b = tb
      for (const rect of rects) {
        const cov = overlap1d(x, rect.x0, rect.x1) * overlap1d(y, rect.y0, rect.y1)
        if (cov <= 0) continue
        r = r + (rect.rgb[0] - r) * cov
        g = g + (rect.rgb[1] - g) * cov
        b = b + (rect.rgb[2] - b) * cov
      }
      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round(tile * 255)
    }
  }
  return rgba
}

// --- minimal PNG writer (8-bit RGBA, no interlace) ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// --- ICO writer: PNG-compressed entries (supported since Vista) ---
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  const blobs = []
  let offset = 6 + entries.length * 16
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16)
    dir[0] = size >= 256 ? 0 : size
    dir[1] = size >= 256 ? 0 : size
    dir.writeUInt16LE(1, 4) // planes
    dir.writeUInt16LE(32, 6) // bpp
    dir.writeUInt32LE(png.length, 8)
    dir.writeUInt32LE(offset, 12)
    offset += png.length
    dirs.push(dir)
    blobs.push(png)
  }
  return Buffer.concat([header, ...dirs, ...blobs])
}

mkdirSync(RESOURCES, { recursive: true })

const png = (size) => encodePng(renderIcon(size), size)

// resources/icon.png — the runtime dock/window icon.
writeFileSync(join(RESOURCES, 'icon.png'), png(1024))
console.log('wrote resources/icon.png')

// resources/icon.ico — Windows (256 for modern shell, small sizes for lists).
writeFileSync(
  join(RESOURCES, 'icon.ico'),
  encodeIco([16, 32, 48, 256].map((size) => ({ size, png: png(size) })))
)
console.log('wrote resources/icon.ico')

// resources/icon.icns — macOS bundle icon, via iconutil (macOS only).
if (process.platform === 'darwin') {
  const iconset = join(RESOURCES, 'icon.iconset')
  mkdirSync(iconset, { recursive: true })
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), png(base))
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), png(base * 2))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(RESOURCES, 'icon.icns')])
  rmSync(iconset, { recursive: true })
  console.log('wrote resources/icon.icns')
}

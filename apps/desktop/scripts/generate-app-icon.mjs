// Generates the desktop app icons (resources/icon.png|icns|ico) from the same
// vector data as the sidebar Logo (src/renderer/src/shell/logo.tsx) — the "V"
// monogram on the flame-gradient rounded tile, inset on a transparent canvas the
// way macOS icons expect. The V has diagonals and a gradient, so the old analytic
// rect rasterizer is gone: Chromium (via @playwright/test, already a devDep)
// renders the SVG at every size with a transparent background.
//
// Run (macOS; `iconutil` builds the .icns):
//   node scripts/generate-app-icon.mjs
//
// Re-run whenever the brand mark or tile styling changes, then commit resources/.
// The dev Electron.app picks the new icns up on the next postinstall
// (scripts/patch-dev-electron.mjs); packaged builds read it via electron-builder.
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCES = join(ROOT, 'resources')

// The tile is inset ~9% per side (Apple's icon grid breathes; a full-bleed tile
// looks oversized in the Dock next to system apps). V geometry = logo.tsx's,
// scaled by the 52/64 tile ratio.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f6c445"/>
      <stop offset=".55" stop-color="#ef8a3c"/>
      <stop offset="1" stop-color="#e2452a"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="52" height="52" rx="11.5" fill="url(#g)"/>
  <path d="M21.44 21.44 L32 43.38 L42.56 21.44" stroke="#241a12" stroke-width="6.9"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`

/** All square sizes any output needs (iconset members + ico entries + icon.png). */
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]

async function renderAll() {
  const browser = await chromium.launch()
  const renders = new Map()
  for (const size of SIZES) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    })
    await page.setContent(
      `<style>*{margin:0}body{background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${ICON_SVG}`,
    )
    renders.set(size, await page.screenshot({ omitBackground: true }))
    await page.close()
  }
  await browser.close()
  return renders
}

/** Windows .ico container with PNG-encoded entries (valid since Vista). */
function buildIco(renders, sizes) {
  const entries = sizes.map((s) => renders.get(s))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((png, i) => {
    const s = sizes[i]
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16) // 0 means 256
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1)
    dir.writeUInt8(0, i * 16 + 2) // palette
    dir.writeUInt8(0, i * 16 + 3) // reserved
    dir.writeUInt16LE(1, i * 16 + 4) // planes
    dir.writeUInt16LE(32, i * 16 + 6) // bpp
    dir.writeUInt32LE(png.length, i * 16 + 8)
    dir.writeUInt32LE(offset, i * 16 + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...entries])
}

const renders = await renderAll()

// icon.png — the 1024 master.
writeFileSync(join(RESOURCES, 'icon.png'), renders.get(1024))

// icon.icns via iconutil over a temp .iconset.
const ICONSET = join(RESOURCES, 'icon.iconset')
rmSync(ICONSET, { recursive: true, force: true })
mkdirSync(ICONSET, { recursive: true })
const ICONSET_MEMBERS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]
for (const [name, size] of ICONSET_MEMBERS) {
  writeFileSync(join(ICONSET, name), renders.get(size))
}
execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(RESOURCES, 'icon.icns')])
rmSync(ICONSET, { recursive: true, force: true })

// icon.ico for a future Windows build.
writeFileSync(join(RESOURCES, 'icon.ico'), buildIco(renders, [16, 32, 48, 256]))

const bytes = readFileSync(join(RESOURCES, 'icon.icns')).length
console.log(`[generate-app-icon] wrote icon.png, icon.ico, icon.icns (${bytes} bytes)`)

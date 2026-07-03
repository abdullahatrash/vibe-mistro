// Renames the DEV Electron.app so the macOS menu bar says "Vibe Mistro (Beta)"
// instead of "Electron" during `bun run dev`. macOS takes the bold app-menu title
// (and the pre-ready Dock name) from the running bundle's Info.plist — never from
// `app.setName()` — so in dev the bundle inside node_modules must be patched.
// This is t3code's electron-launcher trick (apps/desktop/scripts/electron-launcher.mjs),
// pared down: patch in place instead of maintaining a relocated bundle copy, and
// leave CFBundleIdentifier alone so already-granted macOS permissions (TCC) stick.
// Ad-hoc-signed, non-quarantined bundles launch fine with an edited Info.plist.
//
// Runs from postinstall (so an electron reinstall re-applies it); idempotent;
// no-op off macOS or when the bundle is missing. A packaged build never needs
// this — electron-builder writes the real Info.plist.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DISPLAY_NAME = 'Vibe Mistro (Beta)'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_BUNDLE = join(ROOT, 'node_modules/electron/dist/Electron.app')
const ICNS = join(ROOT, 'resources/icon.icns')

function setPlistName(plistPath, name) {
  for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
    execFileSync('plutil', ['-replace', key, '-string', name, plistPath])
  }
}

if (process.platform !== 'darwin' || !existsSync(APP_BUNDLE)) {
  process.exit(0)
}

setPlistName(join(APP_BUNDLE, 'Contents/Info.plist'), APP_DISPLAY_NAME)

// Helper bundles only surface in Activity Monitor / crash dialogs — rename for
// coherence, skipping any variant a future Electron drops.
for (const helper of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
  const plist = join(APP_BUNDLE, `Contents/Frameworks/Electron Helper${helper}.app/Contents/Info.plist`)
  if (existsSync(plist)) setPlistName(plist, `${APP_DISPLAY_NAME} Helper${helper}`)
}

// The bundle icon (pre-ready Dock bounce, Cmd-Tab, About panel): overwrite the
// shipped electron.icns with the brand mark (scripts/generate-app-icon.mjs), then
// touch the bundle so macOS icon services drop their cached Electron icon.
if (existsSync(ICNS)) {
  copyFileSync(ICNS, join(APP_BUNDLE, 'Contents/Resources/electron.icns'))
  execFileSync('touch', [APP_BUNDLE])
}

console.log(`[patch-dev-electron] dev Electron.app renamed to "${APP_DISPLAY_NAME}"`)

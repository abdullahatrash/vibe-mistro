/**
 * The native application-menu template (t3code's DesktopApplicationMenu, in our
 * pure-module idiom): rename the app away from Electron's defaults and give the
 * menu bar real items — About, Check for Updates…, Settings… (Cmd+,) — on top of
 * the standard Edit/View/Window roles.
 *
 * PURE — electron is imported as types only, so this stays unit-testable in the
 * node test environment (app-menu.test.ts). index.ts owns the thin wrapper that
 * builds/sets the Menu, shows the updates dialog, and broadcasts "Settings…" to
 * the renderer (which owns navigation) over the typed `menu:action` channel —
 * the t3code `dispatchMenuAction` shape.
 *
 * NOTE (dev): macOS takes the BOLD app-menu title from the running bundle's
 * Info.plist (CFBundleName), not from `app.setName` — in dev that bundle is
 * node_modules' Electron.app, patched by scripts/patch-dev-electron.mjs (the
 * t3code electron-launcher trick). Everything else (About panel, Hide/Quit
 * labels, submenu content) comes from `configureAppIdentity`/here in index.ts.
 */
import type { MenuItemConstructorOptions } from 'electron'

export const APP_DISPLAY_NAME = 'Vibe Mistro (Beta)'

export interface MenuHandlers {
  onCheckForUpdates: () => void
  onOpenSettings: () => void
}

/**
 * The full menu-bar template for a platform (t3code's layout): on darwin the app
 * menu carries About / Check for Updates… / Settings… + the standard macOS roles;
 * elsewhere Settings… and Check for Updates… live under File/Help since there is
 * no app menu. Pure — returns data, touches no Electron state.
 */
export function buildMenuTemplate(
  platform: NodeJS.Platform,
  handlers: MenuHandlers
): MenuItemConstructorOptions[] {
  const darwin = platform === 'darwin'
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: handlers.onCheckForUpdates,
  }
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: handlers.onOpenSettings,
  }

  const template: MenuItemConstructorOptions[] = []

  if (darwin) {
    template.push({
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about' },
        checkForUpdatesItem,
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push(
    {
      label: 'File',
      submenu: [
        ...(darwin ? [] : [settingsItem, { type: 'separator' } as const]),
        { role: darwin ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [checkForUpdatesItem],
    }
  )

  return template
}

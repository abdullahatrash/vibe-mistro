import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { APP_DISPLAY_NAME, buildMenuTemplate, type MenuHandlers } from './app-menu'

function makeHandlers(): MenuHandlers {
  return { onCheckForUpdates: vi.fn(), onOpenSettings: vi.fn() }
}

function labels(items: MenuItemConstructorOptions[]): (string | undefined)[] {
  return items.map((item) => item.label ?? (item.role as string | undefined))
}

function findItem(
  items: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.label === label) return item
    if (Array.isArray(item.submenu)) {
      const nested = findItem(item.submenu, label)
      if (nested) return nested
    }
  }
  return undefined
}

describe('buildMenuTemplate', () => {
  it('on darwin, leads with the branded app menu carrying About / updates / settings', () => {
    const template = buildMenuTemplate('darwin', makeHandlers())

    expect(template[0].label).toBe(APP_DISPLAY_NAME)
    const submenu = template[0].submenu as MenuItemConstructorOptions[]
    expect(labels(submenu)).toContain('Check for Updates…')
    expect(labels(submenu)).toContain('Settings…')
    expect(submenu.some((item) => item.role === 'about')).toBe(true)
    expect(submenu.at(-1)?.role).toBe('quit')
  })

  it('on darwin, File closes the window (quit lives in the app menu) and no File settings duplicate', () => {
    const template = buildMenuTemplate('darwin', makeHandlers())
    const file = template.find((item) => item.label === 'File')
    const submenu = file?.submenu as MenuItemConstructorOptions[]

    expect(submenu.some((item) => item.role === 'close')).toBe(true)
    expect(labels(submenu)).not.toContain('Settings…')
  })

  it('elsewhere, there is no app menu — Settings… moves under File and File quits', () => {
    const template = buildMenuTemplate('win32', makeHandlers())

    expect(template[0].label).toBe('File')
    const submenu = template[0].submenu as MenuItemConstructorOptions[]
    expect(labels(submenu)).toContain('Settings…')
    expect(submenu.some((item) => item.role === 'quit')).toBe(true)
  })

  it('wires Settings… (with the Cmd+, accelerator) and Check for Updates… to the handlers', () => {
    const handlers = makeHandlers()
    const template = buildMenuTemplate('darwin', handlers)

    const settings = findItem(template, 'Settings…')
    expect(settings?.accelerator).toBe('CmdOrCtrl+,')
    ;(settings?.click as () => void)()
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1)

    const updates = findItem(template, 'Check for Updates…')
    ;(updates?.click as () => void)()
    expect(handlers.onCheckForUpdates).toHaveBeenCalledTimes(1)
  })

  it('always ships the standard Edit / View / Window / Help groups', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = buildMenuTemplate(platform, makeHandlers())
      const roles = template.map((item) => item.role)
      expect(roles).toContain('editMenu')
      expect(roles).toContain('windowMenu')
      expect(roles).toContain('help')
      expect(template.some((item) => item.label === 'View')).toBe(true)
    }
  })

  it('keeps Check for Updates… reachable from Help on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = buildMenuTemplate(platform, makeHandlers())
      const help = template.find((item) => item.role === 'help')
      expect(labels(help?.submenu as MenuItemConstructorOptions[])).toContain(
        'Check for Updates…'
      )
    }
  })
})

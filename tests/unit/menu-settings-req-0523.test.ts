/**
 * REQ-0523 — the menu bar's second entry is "Settings" and opens the dialog
 * directly, with no submenu to traverse.
 *
 * `Menu.buildFromTemplate` is mocked to return the template verbatim, so these
 * assertions run against the SHAPE the real Electron would receive. That is the
 * thing REQ-0523 changed; the settings dialog itself is untouched.
 *
 * §1-2 note: a top-level item with `click` and no `submenu` is not clickable on
 * every platform (on macOS a top-level NSMenu item always opens a menu). It was
 * verified 6/6 on win32 by driving the real menu bar from outside the process
 * (RES-0523 §1-2), so the direct form ships there and darwin keeps a one-item
 * submenu instead of a dead entry. Both shapes are asserted below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** Captures whatever `buildMenu` hands to Electron. */
const built: unknown[] = []

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown) => {
      built.push(template)
      return { template }
    },
    setApplicationMenu: () => {},
  },
  app: { quit: () => {} },
  shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') },
  BrowserWindow: class {},
}))

vi.mock('../../src/main/lib/logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {} },
}))

const { buildMenu } = await import('../../src/main/menu')

interface Item {
  label?: string
  type?: string
  click?: () => void
  submenu?: Item[]
}

const fakeWin = { webContents: { send: () => {} } } as unknown as Parameters<typeof buildMenu>[0]

function template(lang: 'ja' | 'en'): Item[] {
  built.length = 0
  buildMenu(fakeWin, lang)
  return built[0] as Item[]
}

const realPlatform = process.platform
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => { setPlatform('win32') })
afterEach(() => { setPlatform(realPlatform) })

describe('REQ-0523 §2 — menu order and the Settings entry', () => {
  it.each(['ja', 'en'] as const)('%s keeps File → Settings → Help, three entries', (lang) => {
    const t = template(lang)
    expect(t).toHaveLength(3)
    const expected = lang === 'ja'
      ? ['ファイル', '設定', 'ヘルプ']
      : ['File', 'Settings', 'Help']
    expect(t.map((i) => i.label)).toEqual(expected)
  })

  it.each(['ja', 'en'] as const)('%s Settings is directly clickable, with no submenu', (lang) => {
    const settings = template(lang)[1]
    expect(typeof settings.click, 'Settings has no click handler').toBe('function')
    expect(settings.submenu, 'Settings still has a submenu to traverse').toBeUndefined()
  })

  it('clicking Settings sends menu:openSettings — the REQ-0510 channel, not a new one', () => {
    const sent: string[] = []
    const win = { webContents: { send: (ch: string) => sent.push(ch) } } as unknown as Parameters<typeof buildMenu>[0]
    built.length = 0
    buildMenu(win, 'ja')
    const settings = (built[0] as Item[])[1]
    settings.click?.()
    expect(sent).toEqual(['menu:openSettings'])
  })

  it('no "Tools" menu remains in either locale', () => {
    for (const lang of ['ja', 'en'] as const) {
      const labels = template(lang).map((i) => i.label)
      expect(labels, `${lang} still has a Tools menu`).not.toContain('ツール')
      expect(labels).not.toContain('Tools')
    }
  })

  it('File and Help keep every item they had', () => {
    const t = template('ja')
    const file = t[0].submenu ?? []
    const help = t[2].submenu ?? []
    // File: open, save, separator, quit
    expect(file.filter((i) => i.type !== 'separator').map((i) => i.label))
      .toEqual(['プロジェクトを開く…', 'プロジェクトを保存…', '終了'])
    // Help: guide, feedback, download, donations, logs, about (4 separators)
    expect(help.filter((i) => i.type !== 'separator').map((i) => i.label)).toEqual([
      '使い方ガイド',
      'フィードバックを送る',
      'ダウンロードサイト',
      'プロジェクトを支援する (寄付)',
      'ログフォルダを開く',
      'このアプリについて',
    ])
    for (const item of [...file, ...help]) {
      if (item.type === 'separator') continue
      expect(typeof item.click, `${item.label} lost its handler`).toBe('function')
    }
  })

  it('darwin keeps a one-item submenu, because a top-level item cannot activate there', () => {
    setPlatform('darwin')
    const settings = template('ja')[1]
    expect(settings.label).toBe('設定')
    expect(settings.click, 'darwin must not rely on a top-level click').toBeUndefined()
    expect(settings.submenu?.map((i) => i.label)).toEqual(['設定'])
  })
})

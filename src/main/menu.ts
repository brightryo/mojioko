import { Menu, app, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'fs'
import { DOCUMENTATION_URLS, GITHUB_PAGES_URL } from '../shared/app-info'
import { getLogsDir } from './lib/paths'
import log from './lib/logger'

/**
 * Open the public GitHub Pages download landing in the user's default browser.
 * Logs (but does not crash) on failure — this is a fire-and-forget action
 * triggered by a menu click, and `shell.openExternal` rejections are usually
 * non-actionable from inside the app.
 */
function openDownloadPage(): void {
  shell.openExternal(GITHUB_PAGES_URL).catch((err) => {
    log.warn(`[menu] failed to open download page: ${String(err)}`)
  })
}

type Lang = 'ja' | 'en'

interface MenuLabels {
  file: string
  quit: string
  tools: string
  settings: string
  help: string
  about: string
  userGuide: string
  obsSetup: string
  donations: string
  openLogFolder: string
  openDownloadPage: string
}

const JA: MenuLabels = {
  file: 'ファイル',
  quit: '終了',
  tools: 'ツール',
  settings: '設定',
  help: 'ヘルプ',
  about: 'このアプリについて',
  userGuide: '使い方ガイド',
  obsSetup: 'OBS 設定ガイド',
  donations: 'プロジェクトを支援する (寄付)',
  openLogFolder: 'ログフォルダを開く',
  openDownloadPage: 'ダウンロードページを開く'
}

const EN: MenuLabels = {
  file: 'File',
  quit: 'Quit',
  tools: 'Tools',
  settings: 'Settings',
  help: 'Help',
  about: 'About',
  userGuide: 'User Guide',
  obsSetup: 'OBS Setup Guide',
  donations: 'Support this project (Donations)',
  openLogFolder: 'Open log folder',
  openDownloadPage: 'Open Download Page'
}

const LABELS: Record<Lang, MenuLabels> = { ja: JA, en: EN }

function openLogFolder(): void {
  const dir = getLogsDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    log.warn(`[menu] could not create logs dir: ${String(err)}`)
  }
  shell.openPath(dir).catch((err) => {
    log.warn(`[menu] shell.openPath(${dir}) failed: ${String(err)}`)
  })
}

export function buildMenu(win: BrowserWindow, lang: Lang = 'en'): Menu {
  const L = LABELS[lang]
  const send = (channel: string) => win.webContents.send(channel)

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: L.file,
      submenu: [
        {
          label: L.quit,
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: L.tools,
      submenu: [
        {
          label: L.settings,
          accelerator: 'CmdOrCtrl+,',
          click: () => send('menu:openSettings')
        }
      ]
    },
    {
      label: L.help,
      submenu: [
        {
          label: L.userGuide,
          click: () => shell.openExternal(DOCUMENTATION_URLS.userGuide)
        },
        {
          label: L.obsSetup,
          click: () => shell.openExternal(DOCUMENTATION_URLS.obsSetup)
        },
        { type: 'separator' },
        {
          label: L.donations,
          click: () => send('menu:openDonations')
        },
        { type: 'separator' },
        {
          label: L.openLogFolder,
          click: () => openLogFolder()
        },
        { type: 'separator' },
        {
          label: L.openDownloadPage,
          // Direct shell.openExternal — no in-app version comparison.  The
          // landing page is responsible for surfacing the latest release.
          click: () => openDownloadPage()
        },
        {
          label: L.about,
          click: () => send('menu:openAbout')
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

export function rebuildMenu(win: BrowserWindow, lang: string): void {
  const l: Lang = lang === 'en' ? 'en' : 'ja'
  const menu = buildMenu(win, l)
  Menu.setApplicationMenu(menu)
}

export function setMenuLocked(_win: BrowserWindow, _locked: boolean): void {
  // No lockable items in the current menu structure
}

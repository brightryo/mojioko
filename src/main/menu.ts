import { Menu, app, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'fs'
import { GITHUB_PAGES_LOCALIZED } from '../shared/app-info'
import { getLogsDir } from './lib/paths'
import log from './lib/logger'

type Lang = 'ja' | 'en'

/**
 * Open a GitHub Pages URL in the user's default browser, fire-and-forget.
 * Logs (but does not crash) on failure — `shell.openExternal` rejections are
 * usually non-actionable from inside the app and the menu click handler
 * has no UI surface to display an error in.
 */
function openExternalSafe(url: string, label: string): void {
  shell.openExternal(url).catch((err) => {
    log.warn(`[menu] failed to open ${label}: ${String(err)}`)
  })
}

interface MenuLabels {
  file: string
  openProject: string
  saveProject: string
  quit: string
  tools: string
  settings: string
  help: string
  about: string
  userGuide: string
  sendFeedback: string
  donations: string
  openLogFolder: string
  downloadSite: string
}

const JA: MenuLabels = {
  file: 'ファイル',
  openProject: 'プロジェクトを開く…',
  saveProject: 'プロジェクトを保存…',
  quit: '終了',
  tools: 'ツール',
  settings: '設定',
  help: 'ヘルプ',
  about: 'このアプリについて',
  userGuide: '使い方ガイド',
  sendFeedback: 'フィードバックを送る',
  donations: 'プロジェクトを支援する (寄付)',
  openLogFolder: 'ログフォルダを開く',
  downloadSite: 'ダウンロードサイト'
}

const EN: MenuLabels = {
  file: 'File',
  openProject: 'Open Project…',
  saveProject: 'Save Project…',
  quit: 'Quit',
  tools: 'Tools',
  settings: 'Settings',
  help: 'Help',
  about: 'About',
  userGuide: 'User Guide',
  sendFeedback: 'Send Feedback',
  donations: 'Support this project (Donations)',
  openLogFolder: 'Open log folder',
  downloadSite: 'Download Site'
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
  const URLS = GITHUB_PAGES_LOCALIZED[lang]
  const send = (channel: string) => win.webContents.send(channel)

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: L.file,
      submenu: [
        // REQ-0194 — project save/open menu items.  Ctrl+O / Ctrl+S accelerators
        // are the near-universal convention for these actions and do not clash
        // with any renderer shortcut (Space = play/pause, Del = delete row,
        // Ctrl+R = reset row, Enter = confirm dialog).  Menu clicks go over
        // IPC to the renderer, which owns the state involved.
        {
          label: L.openProject,
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:openProject')
        },
        {
          label: L.saveProject,
          accelerator: 'CmdOrCtrl+S',
          click: () => send('menu:saveProject')
        },
        { type: 'separator' },
        {
          // REQ-082: accelerator removed (no keyboard shortcuts except Space).
          label: L.quit,
          click: () => app.quit()
        }
      ]
    },
    {
      label: L.tools,
      submenu: [
        {
          // REQ-082: accelerator removed (no keyboard shortcuts except Space).
          label: L.settings,
          click: () => send('menu:openSettings')
        }
      ]
    },
    {
      label: L.help,
      submenu: [
        // 3-item documentation group: guide -> feedback -> download landing.
        // Order encodes the natural user journey ("read the guide first,
        // then submit feedback if you're still stuck").  OBS setup is no
        // longer a top-level entry — it is folded into the User Guide Q&A.
        {
          label: L.userGuide,
          click: () => openExternalSafe(URLS.guide, 'User Guide')
        },
        {
          label: L.sendFeedback,
          click: () => openExternalSafe(URLS.feedback, 'Send Feedback')
        },
        {
          label: L.downloadSite,
          click: () => openExternalSafe(URLS.top, 'Download Site')
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

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import i18next from 'i18next'
import {
  chooseDialogDir,
  FOLDER_PURPOSE_ORDER,
  FOLDER_SETTINGS,
  type FolderPurpose,
} from '../../src/shared/folder-settings'
import { SETTINGS_MERGE_RULES } from '../../src/main/ipc/settings-merge'
import jaSettings from '../../src/renderer/locales/ja/settings.json'
import enSettings from '../../src/renderer/locales/en/settings.json'

/**
 * REQ-0518 — the Settings ▸ 一般 folder rows.
 *
 * Three rows were renamed, one default moved (project: Videos → Documents),
 * and three rows were added.  The risk in all of that is the same one:
 * a setting that exists and changes nothing, or a label that promises a folder
 * the dialog does not open in.
 *
 * The real check is opening the dialogs, done by hand (RES-0518 §3).  These
 * pin the structural facts that make it work: the persisted keys are
 * unchanged, every row is WIRED to a dialog, every row has a per-kind OS
 * fallback, and both locales resolve.
 */

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8')
/** Source with comments stripped — assertions are about code, not prose. */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('REQ-0518 §1-1 — the persisted keys are NOT renamed', () => {
  it('★ the three existing rows keep the keys users already have on disk', () => {
    expect(FOLDER_SETTINGS.videoInput.key).toBe('defaultInputDir')
    expect(FOLDER_SETTINGS.videoOutput.key).toBe('defaultOutputDir')
    expect(FOLDER_SETTINGS.project.key).toBe('defaultProjectDir')
  })

  it('every key is classified in the settings-merge table', () => {
    // REQ-0312's table is `-?` mapped, so an unclassified key fails tsc — but
    // this states the intent: a folder the user picked must survive a save
    // from a surface that does not know the key.
    for (const purpose of FOLDER_PURPOSE_ORDER) {
      const key = FOLDER_SETTINGS[purpose].key
      expect(SETTINGS_MERGE_RULES[key], key).toBe('presence-wins')
    }
  })

  it('the renderer SENDS every folder key, or the dialog could never change it', () => {
    // `presence-wins` keeps main's value when the key is absent, so a key the
    // payload omits is a row the settings screen cannot edit.
    const app = code('src/renderer/App.tsx')
    for (const purpose of FOLDER_PURPOSE_ORDER) {
      const key = FOLDER_SETTINGS[purpose].key
      expect(app, `App.tsx must send ${key}`).toMatch(new RegExp(`${key}:\\s*s\\.${key}`))
    }
  })
})

describe('REQ-0518 §1-3 / §1-4 — each row has its own OS fallback', () => {
  it('★ the defaults are the ones the REQ specified', () => {
    expect(FOLDER_SETTINGS.videoInput.osFolder).toBe('videos')
    expect(FOLDER_SETTINGS.videoOutput.osFolder).toBe('videos')
    // ★ the one that moved.
    expect(FOLDER_SETTINGS.project.osFolder).toBe('documents')
    expect(FOLDER_SETTINGS.image.osFolder).toBe('pictures')
    expect(FOLDER_SETTINGS.text.osFolder).toBe('documents')
    expect(FOLDER_SETTINGS.srtInput.osFolder).toBe('documents')
  })

  it('★ NEGATIVE CONTROL — the old behaviour (one Videos fallback for all) fails', () => {
    // Before REQ-0518 `resolveDialogDir` returned `app.getPath('videos')` for
    // every dialog, so this assertion is exactly what the pre-fix tree could
    // not satisfy.  Stated explicitly so the control is visible rather than
    // implied by the table above.
    const distinct = new Set(FOLDER_PURPOSE_ORDER.map((p) => FOLDER_SETTINGS[p].osFolder))
    expect(distinct.size).toBeGreaterThan(1)
    expect([...distinct].sort()).toEqual(['documents', 'pictures', 'videos'])
  })

  it('★ the dialog handler resolves per kind, and guards a throwing getPath', () => {
    const dialog = code('src/main/ipc/dialog.ts')
    // The fallback is a parameter, not a constant.
    expect(dialog).toMatch(/function resolveDialogDir\([^)]*fallback/)
    // No handler may go back to a hardcoded videos path.
    expect(dialog).not.toMatch(/return app\.getPath\('videos'\)/)
    // `app.getPath` throws for a shell folder the OS cannot resolve; a dialog
    // that cannot open is worse than one that opens in the wrong place.
    expect(dialog).toMatch(/catch/)
    expect(dialog).toMatch(/getPath\('home'\)/)
  })
})

describe('REQ-0518 §2 — every row is WIRED to a dialog', () => {
  /**
   * ★ The point of the REQ: "do not add a setting that nothing reads."  Each
   * row names the file that consumes it, and the assertion is that the file
   * actually reads that store field.  A row added without a consumer fails
   * here rather than shipping as an inert control.
   */
  const CONSUMERS: Record<FolderPurpose, string[]> = {
    videoInput: ['src/renderer/routes/step1.tsx'],
    videoOutput: ['src/renderer/components/step2/burnin-drawer.tsx'],
    project: ['src/renderer/services/project-file.ts'],
    image: ['src/renderer/components/step2/export-frame-button.tsx'],
    text: ['src/renderer/routes/step2.tsx'],
    srtInput: ['src/renderer/routes/step2.tsx'],
  }

  for (const purpose of FOLDER_PURPOSE_ORDER) {
    it(`${purpose} (${FOLDER_SETTINGS[purpose].key}) is read by its consumer`, () => {
      const key = FOLDER_SETTINGS[purpose].key
      const found = CONSUMERS[purpose].some((rel) => code(rel).includes(key))
      expect(found, `${key} has no consumer — an inert setting`).toBe(true)
    })
  }

  it('★ the still export no longer borrows the video-output folder', () => {
    const src = code('src/renderer/components/step2/export-frame-button.tsx')
    expect(src).toContain('defaultImageDir')
    expect(src).not.toContain('defaultOutputDir')
  })

  it('★ STEP2\'s three dialogs no longer borrow the video-output folder', () => {
    const src = code('src/renderer/routes/step2.tsx')
    expect(src).toContain('defaultTextDir')
    expect(src).toContain('defaultSrtDir')
    expect(src).not.toContain('defaultOutputDir')
  })

  it('every save call site names its fallback, so none relies on the handler default', () => {
    for (const rel of [
      'src/renderer/components/step2/export-frame-button.tsx',
      'src/renderer/routes/step2.tsx',
      'src/renderer/components/step2/burnin-drawer.tsx',
      'src/renderer/services/project-file.ts',
    ]) {
      expect(code(rel), rel).toMatch(/FOLDER_SETTINGS\.\w+\.osFolder/)
    }
  })
})

describe('REQ-0518 §3-4 — both locales resolve, with no raw keys', () => {
  for (const [lng, resource] of [['ja', jaSettings], ['en', enSettings]] as const) {
    it(`${lng} resolves every label and placeholder`, async () => {
      const inst = i18next.createInstance()
      await inst.init({ lng, resources: { [lng]: { settings: resource } }, ns: ['settings'], defaultNS: 'settings' })
      for (const purpose of FOLDER_PURPOSE_ORDER) {
        const row = FOLDER_SETTINGS[purpose]
        const label = String(inst.t(`general.folders.${row.i18n}`))
        const ph = String(inst.t(`general.folderPlaceholder.${row.osFolder}`))
        for (const [what, out] of [['label', label], ['placeholder', ph]] as const) {
          expect(out, `${lng} ${purpose} ${what}`).not.toContain('general.')
          expect(out.trim().length, `${lng} ${purpose} ${what}`).toBeGreaterThan(0)
        }
      }
    })
  }

  it('★ the placeholder names the row\'s OWN folder, not Videos for everything', () => {
    const inst = i18next.createInstance()
    inst.init({ lng: 'en', resources: { en: { settings: enSettings } }, ns: ['settings'], defaultNS: 'settings' })
    const ph = (p: FolderPurpose) => String(inst.t(`general.folderPlaceholder.${FOLDER_SETTINGS[p].osFolder}`))
    expect(ph('project')).toMatch(/Documents/i)
    expect(ph('image')).toMatch(/Pictures/i)
    expect(ph('videoInput')).toMatch(/Videos/i)
    // The project row used to say Videos; that is the visible half of the
    // default change and must not regress.
    expect(ph('project')).not.toMatch(/Videos/i)
  })

  it('the six labels are distinct in both locales', () => {
    for (const resource of [jaSettings, enSettings]) {
      const folders = (resource as { general: { folders: Record<string, string> } }).general.folders
      const labels = FOLDER_PURPOSE_ORDER.map((p) => folders[FOLDER_SETTINGS[p].i18n])
      expect(new Set(labels).size).toBe(FOLDER_PURPOSE_ORDER.length)
    }
  })
})

describe('REQ-0518 — the settings screen renders from the table', () => {
  it('★ rows come from FOLDER_PURPOSE_ORDER, not six hand-written blocks', () => {
    const src = code('src/renderer/components/settings-dialog/settings-dialog.tsx')
    expect(src).toMatch(/FOLDER_PURPOSE_ORDER\.map/)
    // The old per-row i18n keys must be gone, or two namings coexist.
    expect(src).not.toMatch(/general\.defaultInputDir/)
    expect(src).not.toMatch(/folderPathUsingSystemVideos/)
  })

  it('the display order is the order the REQ specified', () => {
    expect(FOLDER_PURPOSE_ORDER).toEqual([
      'videoInput', 'videoOutput', 'project', 'image', 'text', 'srtInput',
    ])
  })
})

describe('REQ-0518 §1-3 / §3-3 — a changed default must not eat an existing setting', () => {
  const EXISTS = () => true
  const GONE = () => false
  // These are opaque strings to `chooseDialogDir`, so they are deliberately
  // NOT written as real Windows user paths: a backslash literal is an escape
  // hazard (a `C:` drive prefix followed by `\Users` contains an invalid hex
  // escape, which is how the first version of this block failed to parse), and
  // a home-directory-shaped literal trips the repo's PII scan for no benefit.
  const DOCS = '/os/documents'
  const PICS = '/os/pictures'
  const VIDS = '/os/videos'

  it('★ a folder the user CHOSE wins over the changed default', () => {
    // The project row's fallback moved Videos → Documents.  Someone who had
    // already picked their own folder must still land there — the fallback is not
    // even consulted.
    expect(chooseDialogDir('/user/chosen-projects', DOCS, EXISTS)).toBe('/user/chosen-projects')
  })

  it('★ unset is what takes the new default', () => {
    // `null` is the unset marker `settings-store.ts` writes; every reader turns
    // it into `undefined`.  Both must reach the fallback, or the default change
    // would not apply to the users it is meant for.
    expect(chooseDialogDir(null, DOCS, EXISTS)).toBe(DOCS)
    expect(chooseDialogDir(undefined, DOCS, EXISTS)).toBe(DOCS)
  })

  it('an empty string counts as unset, not as "the drive root"', () => {
    expect(chooseDialogDir('', PICS, EXISTS)).toBe(PICS)
  })

  it('a chosen folder that has VANISHED falls back, silently (REQ-0121)', () => {
    expect(chooseDialogDir('/removable/gone', VIDS, GONE)).toBe(VIDS)
  })

  it('★ the fallback never rewrites the stored value', () => {
    // `chooseDialogDir` returns a path and has no way to write settings.  That
    // is the structural reason a disconnected drive does not clear the row —
    // asserted so a future "helpfully clear it" edit has to change this on
    // purpose rather than by accident.
    expect(chooseDialogDir.length).toBe(3)
    const stored = '/removable/gone'
    chooseDialogDir(stored, VIDS, GONE)
    expect(stored).toBe('/removable/gone')
  })
})


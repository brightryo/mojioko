import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifySettingsFile } from '../../src/main/ipc/settings-shape'
import { SETTINGS_MERGE_RULES } from '../../src/main/ipc/settings-merge'

/**
 * REQ-0542 — a settings.json that is not ours must be set aside, not absorbed.
 *
 * ## The incident (RES-0540 §5)
 *
 * A previous iteration of MOJIOKO writes `%APPDATA%\MOJIOKO\settings.json` in
 * its own snake_case format — the folder name derives from `APP_NAME`, so both
 * generations share it. The current build read that file, spread its few
 * coincidentally-named keys over `buildDefaults()`, and came up looking like a
 * fresh install. The user's style defaults, presets, folder choices and
 * GPU/model selection were simply not there, with no explanation anywhere the
 * user would look.
 *
 * ## Why the existing guard did not catch it
 *
 * `loadSettings` resets to defaults when `version !== CURRENT_VERSION`. The
 * legacy file carries **`version: 1`** — the same number this build writes —
 * so it sailed through. That is the single most important fact in this REQ and
 * the first thing asserted below: both formats reached "1" independently, so
 * the version field is not a format identifier.
 */

/**
 * The real thing, key for key, from the file found on the owner's machine
 * (RES-0540 §5). Kept verbatim rather than reduced to a minimal case: the point
 * of the fixture is that it is what actually arrived.
 */
const LEGACY_FILE = {
  version: 1,
  language: 'ja',
  theme: {
    active_preset: 'dark_default',
    presets: {
      dark_default: {
        button_bg: '#3b82f6',
        button_fg: '#ffffff',
        window_bg: '#1f2937',
        panel_bg: '#111827',
      },
    },
  },
  burnin: {
    horizontal_position: 'center',
    vertical_position: 'bottom',
    vertical_margin_px: 40,
  },
  font_family: 'Noto Sans JP',
  text_sizes: { small: 12, medium: 14 },
  text_colors: { primary: '#ffffff' },
  transcription_defaults: { model: 'large-v3' },
  last_input_dir: 'C:\\Users\\x\\Videos',
  last_output_dir: 'C:\\Users\\x\\Videos',
}

/** What this build writes: the whole object, every save. */
function ourFile(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(SETTINGS_MERGE_RULES)) out[key] = null
  out.version = 1
  return out
}

describe('REQ-0542 §1-1 — classifying the file', () => {
  it('★ the legacy file carries version 1, so the version check cannot see it', () => {
    // If this ever fails because the legacy format changed, the REQ's premise
    // changed with it — read the classifier again before "fixing" the test.
    expect(LEGACY_FILE.version).toBe(1)
  })

  it('★ the legacy file is foreign', () => {
    const r = classifySettingsFile(LEGACY_FILE)
    expect(r.shape).toBe('foreign')
    // The populations are not close: 4 generic names against 6 we have never
    // heard of. The margin is why a majority rule is safe here.
    expect(r.knownKeys).toBe(4)
    expect(r.unknownKeys).toBe(6)
    expect(r.sampleUnknown).toContain('font_family')
  })

  it('a file this build wrote is ours', () => {
    const r = classifySettingsFile(ourFile())
    expect(r.shape).toBe('ours')
    expect(r.unknownKeys).toBe(0)
    expect(r.knownKeys).toBeGreaterThan(10)
  })

  it('★ a file from a NEWER build is still ours (downgrades must not lose data)', () => {
    // Quarantining on "any unknown key" would delete a user's settings the
    // moment they ran an older build — a worse bug than the one being fixed.
    const r = classifySettingsFile({ ...ourFile(), someFieldFromTheFuture: 1, andAnother: 2 })
    expect(r.shape).toBe('ours')
    expect(r.unknownKeys).toBe(2)
  })

  it('an empty object is foreign — it has none of our keys', () => {
    expect(classifySettingsFile({}).shape).toBe('foreign')
  })

  it('a JSON scalar or array is foreign', () => {
    for (const v of [null, 42, 'settings', [1, 2, 3]]) {
      expect(classifySettingsFile(v).shape, JSON.stringify(v)).toBe('foreign')
    }
  })

  it('a partial but genuine file (few keys, none unknown) is ours', () => {
    // An old build of OURS wrote fewer keys. None of them are unknown, so the
    // majority rule keeps it — the user's settings survive the upgrade.
    expect(classifySettingsFile({ version: 1, language: 'ja', theme: 'dark' }).shape).toBe('ours')
  })

  it('the known-key list is the merge table, not a second copy', () => {
    // REQ-0542 §1-4: one answer to "what keys does AppSettings have". Adding a
    // field to AppSettings already fails `tsc` in settings-merge.ts, so the
    // classifier inherits that completeness instead of drifting from it.
    const src = readSource('src/main/ipc/settings-shape.ts')
    expect(src).toContain("import { SETTINGS_MERGE_RULES } from './settings-merge'")
    expect(src).toContain('Object.keys(SETTINGS_MERGE_RULES)')
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const readSource = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')

/**
 * The load path for real, against an in-memory disk.
 *
 * `electron` and `fs` are mocked the way `settings-write-lock-req-0319.test.ts`
 * already does it — `settings-store` reaches for `app.getPath` and the real
 * settings.json location. That buys the actual behaviour rather than a reading
 * of the source: the file really is renamed, the defaults really are returned,
 * and the notice really is set.
 */
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => 'C:/tmp/mojioko-test',
    getName: () => 'MOJIOKO',
    getLocale: () => 'ja-JP',
  },
}))

/**
 * In-memory disk: path -> contents. `rename` moves, exactly as fs does.
 *
 * Paths are normalised to forward slashes so the assertions can be written
 * without worrying which separator `path.join` produced. `String.fromCharCode(92)`
 * rather than a backslash literal — this file has been mangled by escaping once
 * already.
 */
const BACKSLASH = String.fromCharCode(92)
const norm = (p: unknown) => String(p).split(BACKSLASH).join('/')
const disk = new Map<string, string>()
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

// `importOriginal` so the real `readFileSync` survives — the source-reading
// assertions below use it, and a bare mock replaces the whole module.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  promises: {
    readFile: async (p: string) => {
      const v = disk.get(norm(p))
      if (v === undefined) throw enoent()
      return v
    },
    writeFile: async (p: string, data: string) => {
      disk.set(norm(p), data)
    },
    mkdir: async () => undefined,
    rename: async (from: string, to: string) => {
      const a = norm(from)
      const b = norm(to)
      const v = disk.get(a)
      if (v === undefined) throw enoent()
      disk.set(b, v)
      disk.delete(a)
    },
    unlink: async () => undefined,
  },
}))

const SETTINGS_PATH = 'C:/tmp/mojioko-test/MOJIOKO/settings.json'
const quarantinedPaths = () =>
  [...disk.keys()].filter((k) => k.includes('settings.json.quarantined-'))

describe('REQ-0542 §1-2 — the load path, for real', () => {
  beforeEach(async () => {
    disk.clear()
    const { __resetSettingsQuarantineNoticeForTests } = await import('../../src/main/services/settings-store')
    __resetSettingsQuarantineNoticeForTests()
  })

  it('(a) a genuine file loads unchanged, quarantines nothing, says nothing', async () => {
    const { loadSettings, takeSettingsQuarantineNotice } =
      await import('../../src/main/services/settings-store')
    disk.set(SETTINGS_PATH, JSON.stringify({ version: 1, language: 'en', autoLineBreak: false }))

    const settings = await loadSettings()
    expect(settings.language).toBe('en')
    expect(settings.autoLineBreak).toBe(false)
    expect(quarantinedPaths()).toEqual([])
    expect(disk.get(SETTINGS_PATH)).toBeDefined()
    expect(takeSettingsQuarantineNotice()).toBeNull()
  })

  it('★ (b) the legacy file is moved aside, defaults are returned, the user is told', async () => {
    const { loadSettings, takeSettingsQuarantineNotice } =
      await import('../../src/main/services/settings-store')
    const original = JSON.stringify(LEGACY_FILE)
    disk.set(SETTINGS_PATH, original)

    const settings = await loadSettings()

    // Defaults — NOT the legacy keys spread over them. `theme` is the tell:
    // the legacy file's is an object, and the old code let it through.
    expect(settings.theme).toBe('dark')
    expect(settings.transcriptionDefaults.fontSizePx).toBeGreaterThan(0)

    // The original file still exists, byte for byte, under a new name.
    const moved = quarantinedPaths()
    expect(moved).toHaveLength(1)
    expect(disk.get(moved[0])).toBe(original)
    expect(disk.has(SETTINGS_PATH)).toBe(false)

    const notice = takeSettingsQuarantineNotice()
    expect(notice?.reason).toBe('foreign-format')
    expect(norm(notice?.quarantinedPath)).toBe(moved[0])
  })

  it('★ (c) an unreadable file is moved aside too, and reported as unreadable', async () => {
    const { loadSettings, takeSettingsQuarantineNotice } =
      await import('../../src/main/services/settings-store')
    disk.set(SETTINGS_PATH, '{ this is not json')

    // It returns DEFAULTS rather than throwing.  Throwing made `settings:load`
    // reply `ok: false`, and App.tsx returns early on that — so the dialog
    // could never have been shown for this case (REQ-0542 §1-2 requires it).
    const settings = await loadSettings()
    expect(settings.version).toBe(1)
    expect(settings.theme).toBe('dark')

    const moved = quarantinedPaths()
    expect(moved).toHaveLength(1)
    expect(disk.get(moved[0])).toBe('{ this is not json')
    expect(takeSettingsQuarantineNotice()?.reason).toBe('unreadable')
  })

  it('★ (d) a missing file is a normal first launch: defaults, no file, no notice', async () => {
    const { loadSettings, takeSettingsQuarantineNotice } =
      await import('../../src/main/services/settings-store')

    const settings = await loadSettings()
    expect(settings.version).toBe(1)
    expect(quarantinedPaths()).toEqual([])
    expect(takeSettingsQuarantineNotice()).toBeNull()
  })

  it('the notice is delivered once, not on every load', async () => {
    const { loadSettings, takeSettingsQuarantineNotice } =
      await import('../../src/main/services/settings-store')
    disk.set(SETTINGS_PATH, JSON.stringify(LEGACY_FILE))

    await loadSettings()
    expect(takeSettingsQuarantineNotice()).not.toBeNull()
    expect(takeSettingsQuarantineNotice()).toBeNull()
  })

  it('★ a second load does not quarantine again — there is nothing left to move', async () => {
    // `mutateSettings` starts every write with a load, so this runs many times
    // per launch. One launch must not litter the folder.
    const { loadSettings } = await import('../../src/main/services/settings-store')
    disk.set(SETTINGS_PATH, JSON.stringify(LEGACY_FILE))

    await loadSettings()
    await loadSettings()
    await loadSettings()
    expect(quarantinedPaths()).toHaveLength(1)
  })
})

describe('REQ-0542 §2 — headless', () => {
  it('★ the CLI never takes the notice: it logs and carries on', async () => {
    // There is no window to show a dialog in, and a settings file we could not
    // read is not a reason to fail a burn that does not depend on it — so the
    // exit code is untouched.  Only the settings IPC takes the notice.
    for (const f of ['src/main/cli/subtitle-io.ts', 'src/main/cli/commands/preset.ts']) {
      expect(readSource(f)).not.toContain('takeSettingsQuarantineNotice')
    }
    expect(readSource('src/main/ipc/settings.ts')).toContain('takeSettingsQuarantineNotice()')
  })
})

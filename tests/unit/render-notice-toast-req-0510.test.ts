import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { toast } from 'sonner'
import { showRenderNoticeToasts } from '../../src/renderer/lib/render-notice-toast'
import { useStoreUpsellStore } from '../../src/renderer/stores/store-upsell-store'
import { useUiStore } from '../../src/renderer/stores/ui-store'
import {
  applyFontPolicy,
  fontSubstitutionRenderNotices,
} from '../../src/shared/font-tier'
import { getFontMeta } from '../../src/shared/fonts'
import { fontSubstitutionDetail, type RenderNotice } from '../../src/shared/render-notice'
import { DEFAULT_FONT_ID, type FontId } from '../../src/shared/fonts'
import { detectFontSubstitutions } from '../../src/main/cli/no-op-warnings'
import type { SubtitleEntry } from '../../src/shared/types'
import jaCommon from '../../src/renderer/locales/ja/common.json'
import enCommon from '../../src/renderer/locales/en/common.json'

// The helper raises sonner toasts; stub them so the assertions can inspect what
// fired without mounting a <Toaster>. Same pattern as `entry-row-actions.test`.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}))

/**
 * REQ-0510 — the GUI substituted a font and said nothing.
 *
 * The CLI and MCP have returned `FONT_TIER_SUBSTITUTED` / `FONT_UNAVAILABLE`
 * since REQ-0508 / REQ-0509, but the GUI rendered in Noto while the inspector
 * kept showing "Anton" — and the owner's decision is that the label stays as it
 * is, so the toast is the ONLY way a user finds out before watching the output.
 */

const cue = (over: Partial<SubtitleEntry> = {}): SubtitleEntry => ({
  id: over.id ?? 'c1',
  startSec: 0,
  endSec: 1,
  text: 'hello',
  ...over,
}) as SubtitleEntry

const ALL_INSTALLED = (): boolean => true

/**
 * The action our own `toast.warning` wrapper accepts. Sonner's public type
 * widens `action` to `ReactNode | Action`, so reading `.label` off the mock's
 * recorded argument needs the narrower shape back — `lib/toast.ts` only ever
 * passes this one.
 */
type ToastAction = { label: string; onClick: () => void }
const actionOf = (callIndex: number): ToastAction =>
  vi.mocked(toast.warning).mock.calls[callIndex][1]?.action as unknown as ToastAction
const allBut = (...missing: FontId[]) => (id: FontId): boolean => !missing.includes(id)

/** A `t` that returns the key, so assertions can see which string was chosen. */
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts && 'pairs' in opts ? `${key}|${String(opts.pairs)}|${String(opts.count)}` : key) as never

// REQ-0517 §2 — the toast now takes the general `RenderNotice`, built by the
// shared converter the main process uses.  The judgement behind it
// (`applyFontPolicy` + the grouping) is unchanged, which is the point: every
// REQ-0510 assertion below still describes the same behaviour.
const notices = (opts: { isPaid: boolean; isInstalled?: (id: FontId) => boolean; entries: SubtitleEntry[] }): RenderNotice[] =>
  fontSubstitutionRenderNotices(
    applyFontPolicy({
      isPaid: opts.isPaid,
      isInstalled: opts.isInstalled ?? ALL_INSTALLED,
      defaultFontId: DEFAULT_FONT_ID,
      entries: opts.entries,
    }),
    DEFAULT_FONT_ID,
    (id) => getFontMeta(id).displayName,
  )

beforeEach(() => {
  vi.clearAllMocks()
  useStoreUpsellStore.setState({ open: false })
  useUiStore.setState({ isSettingsDialogOpen: false, settingsDialogTab: 'general' })
})

describe('REQ-0510 §2-1 — it fires when a font was actually replaced', () => {
  it('free tier + paid font → one WARNING toast, tier wording', () => {
    showRenderNoticeToasts(notices({ isPaid: false, entries: [cue({ fontId: 'anton' })] }), t)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0]
    expect(title).toBe('common:fontSubstitution.tier.title')
    // The description names the fonts and the cue count — a toast that only
    // said "a font was replaced" would send the user hunting.
    expect(opts?.description).toContain('Anton → Noto Sans JP Regular')
    expect(opts?.description).toContain('|1')
  })

  it('paid tier + missing file → one WARNING toast, missing wording', () => {
    showRenderNoticeToasts(
      notices({ isPaid: true, isInstalled: allBut('anton'), entries: [cue({ fontId: 'anton' })] }),
      t,
    )
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe('common:fontSubstitution.missing.title')
  })

  it('both causes in one render → two toasts, one per cause', () => {
    showRenderNoticeToasts(
      notices({
        isPaid: false,
        isInstalled: allBut('noto-sans-jp-black'),
        entries: [cue({ id: 'a', fontId: 'anton' }), cue({ id: 'b', fontId: 'noto-sans-jp-black' })],
      }),
      t,
    )
    expect(vi.mocked(toast.warning).mock.calls.map((c) => c[0])).toEqual([
      'common:fontSubstitution.tier.title',
      'common:fontSubstitution.missing.title',
    ])
  })

  it('uses toast.warning, not error or success — the render succeeded', () => {
    showRenderNoticeToasts(notices({ isPaid: false, entries: [cue({ fontId: 'anton' })] }), t)
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('REQ-0510 §2-2 / §3-1 — it stays silent otherwise', () => {
  it('nothing substituted → NO toast (the other side of the gate)', () => {
    showRenderNoticeToasts(notices({ isPaid: true, entries: [cue({ fontId: 'anton' })] }), t)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('free tier + a bundled font → NO toast', () => {
    showRenderNoticeToasts(notices({ isPaid: false, entries: [cue({ fontId: 'noto-sans-jp-black' })] }), t)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it.each([undefined, []])('an absent / empty notice list is silent (%s)', (value) => {
    showRenderNoticeToasts(value, t)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('REQ-0510 §2-4 / §3-2 — the two remedies are not interchangeable', () => {
  it('the tier toast opens the STORE upsell and does not touch settings', () => {
    showRenderNoticeToasts(notices({ isPaid: false, entries: [cue({ fontId: 'anton' })] }), t)
    expect(actionOf(0).label).toBe('common:fontSubstitution.tier.action')
    actionOf(0).onClick()
    expect(useStoreUpsellStore.getState().open).toBe(true)
    expect(useUiStore.getState().isSettingsDialogOpen).toBe(false)
  })

  it('the missing toast opens SETTINGS on the Fonts tab and does not upsell', () => {
    // Sending someone to the Store to fix a file that is simply not downloaded
    // would sell them something that does not fix it (RES-0509 §2-2).
    showRenderNoticeToasts(
      notices({ isPaid: true, isInstalled: allBut('anton'), entries: [cue({ fontId: 'anton' })] }),
      t,
    )
    expect(actionOf(0).label).toBe('common:fontSubstitution.missing.action')
    actionOf(0).onClick()
    expect(useUiStore.getState().isSettingsDialogOpen).toBe(true)
    expect(useUiStore.getState().settingsDialogTab).toBe('fonts')
    expect(useStoreUpsellStore.getState().open).toBe(false)
  })

  it('plain setSettingsDialogOpen(true) still lands on General (behaviour preserved)', () => {
    useUiStore.setState({ settingsDialogTab: 'fonts' })
    useUiStore.getState().setSettingsDialogOpen(true)
    expect(useUiStore.getState().settingsDialogTab).toBe('general')
  })
})

describe('REQ-0510 §1-2 — GUI and CLI read the SAME judgement', () => {
  const cases: { name: string; isPaid: boolean; isInstalled: (id: FontId) => boolean; entries: SubtitleEntry[] }[] = [
    { name: 'tier only', isPaid: false, isInstalled: ALL_INSTALLED, entries: [cue({ fontId: 'anton' })] },
    { name: 'missing only', isPaid: true, isInstalled: allBut('anton'), entries: [cue({ fontId: 'anton' })] },
    { name: 'both, different cues', isPaid: false, isInstalled: allBut('noto-sans-jp-black'), entries: [cue({ id: 'a', fontId: 'anton' }), cue({ id: 'b', fontId: 'noto-sans-jp-black' })] },
    { name: 'neither', isPaid: true, isInstalled: ALL_INSTALLED, entries: [cue({ fontId: 'anton' })] },
    { name: 'both causes on ONE font', isPaid: false, isInstalled: allBut('anton'), entries: [cue({ fontId: 'anton' })] },
  ]

  it.each(cases)('$name — the codes match, and so do the cue counts', (c) => {
    const gui = notices({ isPaid: c.isPaid, isInstalled: c.isInstalled, entries: c.entries })
    const cli = detectFontSubstitutions(
      c.entries,
      DEFAULT_FONT_ID,
      { tier: c.isPaid ? 'paid' : 'free', isPaid: c.isPaid, source: c.isPaid ? 'msix' : 'not-packaged' },
      c.isInstalled,
    )
    expect(gui.map((n) => n.code)).toEqual(cli.map((w) => w.code))
    // REQ-0517 §2 — both sides are `RenderNotice` now, so the count lives in
    // the same place on both.  That the two still agree is the REQ-0510
    // invariant: one judgement, two surfaces.
    expect(gui.map((n) => fontSubstitutionDetail(n)?.substitutedCueCount)).toEqual(
      cli.map((w) => (w.detail as Record<string, unknown>).substitutedCueCount),
    )
  })
})

describe('REQ-0510 §2-3 — the strings exist in BOTH locales', () => {
  const KEYS = ['tier.title', 'tier.action', 'missing.title', 'missing.action', 'detail'] as const
  const read = (obj: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj)

  it.each(KEYS)('ja and en both define fontSubstitution.%s', (key) => {
    const ja = read((jaCommon as Record<string, unknown>).fontSubstitution, key)
    const en = read((enCommon as Record<string, unknown>).fontSubstitution, key)
    expect(typeof ja, `ja ${key}`).toBe('string')
    expect(typeof en, `en ${key}`).toBe('string')
    expect(String(ja).length).toBeGreaterThan(0)
    expect(String(en).length).toBeGreaterThan(0)
  })

  it('en is not a copy of ja (an untranslated string is a missing translation)', () => {
    for (const key of KEYS) {
      if (key === 'detail') continue // interpolation-only differences are legitimate
      expect(read((enCommon as Record<string, unknown>).fontSubstitution, key))
        .not.toBe(read((jaCommon as Record<string, unknown>).fontSubstitution, key))
    }
  })

  /**
   * The keys existing in the JSON is not the same as the app resolving them.
   * The helper uses the NAMESPACE-QUALIFIED form (`common:…`) because its two
   * call sites bind different default namespaces; if `common` were not among
   * the initialised namespaces, i18next would hand the raw key straight to the
   * toast and users would read "common:fontSubstitution.tier.title".
   */
  it('the app i18n instance resolves the namespaced keys in both languages', async () => {
    const i18n = (await import('../../src/renderer/i18n')).default
    for (const lang of ['ja', 'en']) {
      await i18n.changeLanguage(lang)
      for (const key of KEYS) {
        const full = `common:fontSubstitution.${key}`
        expect(i18n.t(full), `${lang} ${full}`).not.toBe(full)
      }
      expect(i18n.t('common:fontSubstitution.detail', { pairs: 'A → B', count: 3 })).toContain('A → B')
    }
    await i18n.changeLanguage('ja')
  })

  it('both `detail` strings interpolate the same variables', () => {
    const vars = (s: string): string[] => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    const ja = String(read((jaCommon as Record<string, unknown>).fontSubstitution, 'detail'))
    const en = String(read((enCommon as Record<string, unknown>).fontSubstitution, 'detail'))
    expect(vars(ja)).toEqual(['count', 'pairs'])
    expect(vars(en)).toEqual(vars(ja))
  })
})

// ---------------------------------------------------------------------------
// §3-3 — the preview must NOT toast, and the two file-producing paths must.
//
// A source scan, because the alternative is mounting the whole burn drawer.
// It answers the two questions that matter: is the call wired where a file is
// produced, and is it absent everywhere else (above all the preview, which
// re-renders per frame — "a warning that always fires is not read", REQ-0502).
// ---------------------------------------------------------------------------

const TOAST_FN = 'showRenderNoticeToasts'

/** Files allowed to raise the toast, and why each one is a file-producing end. */
export const ALLOWED_CALLERS: Record<string, string> = {
  'src/renderer/components/step2/burnin-drawer.tsx': 'burn completion — the video exists now',
  'src/renderer/components/step2/export-frame-button.tsx': 'image export completion — the still exists now',
  'src/renderer/lib/render-notice-toast.ts': 'the helper itself',
}

function stripComments(text: string): string {
  const out: string[] = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) { out.push(''); continue }
      line = line.slice(end + 2)
      inBlock = false
    }
    for (;;) {
      const open = line.indexOf('/*')
      if (open === -1) break
      const close = line.indexOf('*/', open + 2)
      if (close === -1) { line = line.slice(0, open); inBlock = true; break }
      line = line.slice(0, open) + ' ' + line.slice(close + 2)
    }
    const slash = line.indexOf('//')
    if (slash !== -1) line = line.slice(0, slash)
    out.push(line)
  }
  return out.join('\n')
}

const callsToast = (code: string): boolean =>
  new RegExp(`\\b${TOAST_FN}\\s*\\(`).test(
    code.split('\n').filter((l) => !/^\s*import\b/.test(l)).join('\n'),
  )

export function findToastCallers(files: { path: string; text: string }[]): string[] {
  return files
    .map((f) => ({ path: f.path.replace(/\\/g, '/'), code: stripComments(f.text) }))
    .filter((f) => callsToast(f.code))
    .map((f) => f.path)
    .sort()
}

function collectSources(dir: string, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collectSources(full, out)
    else if (/\.tsx?$/.test(name)) out.push({ path: relative(join(__dirname, '..', '..'), full), text: readFileSync(full, 'utf-8') })
  }
  return out
}

describe('REQ-0510 §3-3 — wired at the two completions, nowhere else', () => {
  const sources = collectSources(join(__dirname, '..', '..', 'src'))

  it('exactly the allowed callers raise it', () => {
    expect(findToastCallers(sources)).toEqual(Object.keys(ALLOWED_CALLERS).sort())
  })

  it('the live preview does not', () => {
    // Named explicitly: this is the file whose re-render rate makes a toast
    // useless, and the one a future contributor is most likely to add it to.
    const preview = sources.find((f) =>
      f.path.replace(/\\/g, '/') === 'src/renderer/components/subtitle-overlay/subtitle-overlay.tsx')
    expect(preview, 'preview source not found').toBeDefined()
    expect(callsToast(stripComments(preview!.text))).toBe(false)
  })

  it('NEGATIVE CONTROL — removing the burn-completion call is detected', () => {
    const real = sources.find((f) =>
      f.path.replace(/\\/g, '/') === 'src/renderer/components/step2/burnin-drawer.tsx')
    const gutted = real!.text.replace(new RegExp(`${TOAST_FN}\\(evt\\.renderNotices, t\\)`), '/* removed */')
    expect(gutted).not.toBe(real!.text)
    const patched = sources.map((f) => (f === real ? { path: f.path, text: gutted } : f))
    expect(findToastCallers(patched)).not.toContain('src/renderer/components/step2/burnin-drawer.tsx')
  })

  it('NEGATIVE CONTROL — adding it to the preview is detected', () => {
    const preview = sources.find((f) =>
      f.path.replace(/\\/g, '/') === 'src/renderer/components/subtitle-overlay/subtitle-overlay.tsx')
    const patched = sources.map((f) =>
      f === preview ? { path: f.path, text: f.text + `\nconst x = () => ${TOAST_FN}(undefined, null as never)\n` } : f)
    expect(findToastCallers(patched)).toContain('src/renderer/components/subtitle-overlay/subtitle-overlay.tsx')
  })
})

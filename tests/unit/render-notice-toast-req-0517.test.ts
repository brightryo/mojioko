import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { toast } from 'sonner'
import i18next from 'i18next'
import {
  NOT_TOASTED,
  TOASTED_CODES,
  showRenderNoticeToasts,
} from '../../src/renderer/lib/render-notice-toast'
import type { RenderNotice } from '../../src/shared/render-notice'
import jaCommon from '../../src/renderer/locales/ja/common.json'
import enCommon from '../../src/renderer/locales/en/common.json'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}))

/**
 * REQ-0517 §2 — the GUI notice channel carries every `RenderNotice`, and shows
 * a deliberately small subset of them.
 *
 * ## What changed
 *
 * `BurninEvent.completed.fontNotices` was typed `FontSubstitutionNotice[]`,
 * whose `code` is a two-member union, so font substitution was the only thing
 * the GUI could ever be told — `SCALE_ANIM_LINE_PITCH_FIXED` had nowhere to go
 * (RES-0516 §3-5).  The field is now `renderNotices: RenderNotice[]`, the same
 * objects the CLI returns in `warnings[]`.
 *
 * ## The two halves this pins
 *
 * Widening the WIRE is not widening the DISPLAY.  Everything the render
 * produces now reaches the renderer, and a toast per notice would put
 * `BACKGROUND_BOX_NOT_DRAWN` in front of someone watching a video finish —
 * "a warning that always fires is not read" (REQ-0502).  So: the allowlist is
 * asserted from both sides, and a code with no GUI wording must produce
 * nothing rather than leaking its identifier to the user.
 *
 * REQ-0510's own assertions live in `render-notice-toast-req-0510.test.ts` and
 * are unchanged — that they still pass through the new plumbing is the proof
 * that §2-2 ("do not alter the font wording or its actions") held.
 */

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts && 'count' in opts ? `${key}|${String(opts.count)}` : key) as never

const notice = (code: string, detail?: unknown): RenderNotice =>
  ({ code, message: 'headless sentence', detail })

beforeEach(() => { vi.clearAllMocks() })

describe('REQ-0517 §2-3 — the line-pitch warning reaches the GUI', () => {
  it('★ toasts SCALE_ANIM_LINE_PITCH_FIXED, which nothing could carry before', () => {
    showRenderNoticeToasts([notice('SCALE_ANIM_LINE_PITCH_FIXED', { cueCount: 3 })], t)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0]
    expect(title).toBe('common:renderNotice.linePitch.title')
    expect(opts?.description).toBe('common:renderNotice.linePitch.detail|3')
  })

  it('survives a notice whose detail is missing or malformed (count falls to 0)', () => {
    showRenderNoticeToasts([notice('SCALE_ANIM_LINE_PITCH_FIXED')], t)
    showRenderNoticeToasts([notice('SCALE_ANIM_LINE_PITCH_FIXED', 'nonsense')], t)
    expect(toast.warning).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(toast.warning).mock.calls) {
      expect(call[1]?.description).toBe('common:renderNotice.linePitch.detail|0')
    }
  })

  it('carries no action — unlike the font toasts, there is nothing to click to', () => {
    // The fix is "make the cue one line" or "pick another animation", both of
    // which are per-cue edits; a global button would land nowhere useful.
    showRenderNoticeToasts([notice('SCALE_ANIM_LINE_PITCH_FIXED', { cueCount: 1 })], t)
    expect(vi.mocked(toast.warning).mock.calls[0][1]?.action).toBeUndefined()
  })
})

describe('REQ-0517 §2-4 — only the allowlisted codes are shown', () => {
  it('★ the allowlist is exactly the font pair plus the line-pitch warning', () => {
    expect([...TOASTED_CODES].sort()).toEqual([
      'FONT_TIER_SUBSTITUTED',
      'FONT_UNAVAILABLE',
      'SCALE_ANIM_LINE_PITCH_FIXED',
    ])
  })

  it('★ every other code the app can emit is carried but NOT toasted', () => {
    for (const code of Object.keys(NOT_TOASTED)) {
      vi.clearAllMocks()
      showRenderNoticeToasts([notice(code, { cueCount: 2 })], t)
      expect(toast.warning, `${code} must not toast`).not.toHaveBeenCalled()
    }
  })

  it('★ each withheld code records WHY, so the next reader does not re-derive it', () => {
    for (const [code, reason] of Object.entries(NOT_TOASTED)) {
      expect(reason.length, `${code} needs a reason`).toBeGreaterThan(10)
    }
  })

  it('the two lists are disjoint — a code cannot be both shown and withheld', () => {
    for (const code of TOASTED_CODES) {
      expect(Object.keys(NOT_TOASTED)).not.toContain(code)
    }
  })

  /**
   * ★ Every warning code the app can actually emit must be classified.  A new
   * warning that lands with no entry in either list would default to invisible
   * in the GUI, silently — which is the shape of hole REQ-0507 / REQ-0508 kept
   * finding in the advertised-code tables.
   */
  it('★ every emitted warning code appears in one of the two lists', () => {
    const roots = [
      'src/main/cli/no-op-warnings.ts',
      'src/main/cli/placement.ts',
      'src/main/cli/commands/transcribe.ts',
      'src/main/cli/index.ts',
      'src/main/cli/commands/burn.ts',
      'src/main/cli/commands/status.ts',
    ]
    const emitted = new Set<string>()
    for (const rel of roots) {
      const text = readFileSync(path.join(process.cwd(), rel), 'utf8')
      for (const m of text.matchAll(/code:\s*'([A-Z][A-Z0-9_]{3,})'/g)) emitted.add(m[1])
    }
    const classified = new Set<string>([...TOASTED_CODES, ...Object.keys(NOT_TOASTED)])
    const unclassified = [...emitted].filter((c) => !classified.has(c))
    expect(unclassified, 'classify these in render-notice-toast.ts').toEqual([])
  })
})

describe('REQ-0517 §2-5 — an unknown code shows nothing, never its identifier', () => {
  it('★ a code with no GUI wording produces no toast at all', () => {
    showRenderNoticeToasts([notice('SOMETHING_ADDED_NEXT_YEAR', { cueCount: 9 })], t)
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a mixed batch shows the allowlisted one and drops the rest', () => {
    showRenderNoticeToasts([
      notice('BACKGROUND_BOX_NOT_DRAWN', { cueCount: 1 }),
      notice('SCALE_ANIM_LINE_PITCH_FIXED', { cueCount: 2 }),
      notice('MYSTERY_CODE'),
    ], t)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe('common:renderNotice.linePitch.title')
  })
})

describe('REQ-0517 §2-1 — the producers actually put the notices on the wire', () => {
  /**
   * The allowlist above is only reachable if the main process SENDS the
   * notices.  Pre-REQ-0517 the burn path built `fontNotices` from
   * `groupFontSubstitutions` alone, so no cue-derived warning could travel no
   * matter what the renderer was willing to show — and a future edit that
   * dropped `detectNoOpCombinations` here would take the line-pitch toast away
   * silently, with every test above still green.
   */
  const PRODUCERS = [
    'src/main/services/ffmpeg-burnin.ts',
    'src/main/services/frame-exporter.ts',
  ]

  for (const rel of PRODUCERS) {
    it(`${rel} sends font substitutions AND the cue-derived warnings`, () => {
      const text = readFileSync(path.join(process.cwd(), rel), 'utf8')
      expect(text).toMatch(/fontSubstitutionRenderNotices\s*\(/)
      expect(text).toMatch(/detectNoOpCombinations\s*\(/)
      expect(text).toMatch(/renderNotices/)
      // The narrow field it replaced must be gone, or the two could coexist
      // and drift.
      expect(text).not.toMatch(/fontNotices/)
    })
  }
})

describe('REQ-0517 §3-2 — the new strings resolve in a real i18n instance', () => {
  // Same method as REQ-0510: assert against a real i18next, not against the
  // JSON, so a key that exists but does not RESOLVE (wrong nesting, missing
  // interpolation) is caught.
  const KEYS = ['renderNotice.linePitch.title', 'renderNotice.linePitch.detail'] as const

  for (const [lng, resource] of [['ja', jaCommon], ['en', enCommon]] as const) {
    it(`${lng} resolves every new key to real text`, async () => {
      const inst = i18next.createInstance()
      await inst.init({ lng, resources: { [lng]: { common: resource } }, ns: ['common'], defaultNS: 'common' })
      for (const key of KEYS) {
        const out = inst.t(key, { count: 2 })
        expect(out, `${lng}:${key}`).not.toBe(key)
        expect(String(out).trim().length, `${lng}:${key}`).toBeGreaterThan(0)
        // A raw code or a leftover placeholder reaching the user is the failure
        // REQ-0510's i18n check exists to prevent.
        expect(String(out)).not.toContain('{{')
        expect(String(out)).not.toMatch(/[A-Z]{4,}_[A-Z_]+/)
      }
    })
  }

  it('★ the detail string actually interpolates the cue count', () => {
    for (const [lng, resource] of [['ja', jaCommon], ['en', enCommon]] as const) {
      const inst = i18next.createInstance()
      inst.init({ lng, resources: { [lng]: { common: resource } }, ns: ['common'], defaultNS: 'common' })
      expect(String(inst.t('renderNotice.linePitch.detail', { count: 7 })), lng).toContain('7')
    }
  })
})

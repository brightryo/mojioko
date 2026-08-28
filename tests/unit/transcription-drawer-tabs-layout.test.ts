import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * REQ-0437 — regression guard for the transcription setup drawer's tab layout.
 *
 * タブ2 (文字スタイル) / タブ3 (Whisper設定) have regressed to "bottom-aligned +
 * horizontal scroll" THREE times (RES-0424 / RES-0425, then again). The durable
 * fix (REQ-0437) is a PER-TAB scroll layout: each `<TabsContent>` is its own
 * `flex-1 min-h-0 overflow-y-auto overflow-x-hidden` scroll box, so a tab's
 * content lays out from the top inside its own box and can never be
 * bottom-weighted by another tab, and horizontal scroll is clipped.
 *
 * This test greps the SOURCE (not a render) to pin that shape.  If a future
 * edit reintroduces the fragile patterns, CI fails here instead of the UI
 * silently regressing a fourth time.  If you deliberately change the layout,
 * update this test in the SAME commit and say why.
 */
/** Strip block + line comments so "do NOT use X" checks match real code, not
 *  a comment that names the retired pattern.  Good enough for these TSX files
 *  (className strings never contain `/*`, and their `/` never doubles up). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const DRAWER = readFileSync(
  resolve(__dirname, '../../src/renderer/components/step1/transcription-drawer.tsx'),
  'utf-8',
)
const DRAWER_CODE = stripComments(DRAWER)
const WHISPER_CODE = stripComments(
  readFileSync(
    resolve(__dirname, '../../src/renderer/components/whisper-advanced-controls/whisper-advanced-controls.tsx'),
    'utf-8',
  ),
)

/**
 * The className string on each `<TabsContent>` opening tag (the scroll box
 * itself, NOT any inner wrapper).  Built from the COMMENT-STRIPPED source so
 * the `<TabsContent>` mentions inside explanatory comments don't count.  The
 * lazy match stops at the first `className="…"` after each `<TabsContent`,
 * which is the TabsContent's own.
 */
const TAB_CLASSNAMES = [...DRAWER_CODE.matchAll(/<TabsContent\b[\s\S]*?className="([^"]*)"/g)].map(
  (m) => m[1],
)

describe('REQ-0437 / REQ-0442 — transcription drawer tab layout guard', () => {
  it('renders exactly three setup tabs', () => {
    const tabs = DRAWER_CODE.match(/<TabsContent\b/g) ?? []
    expect(tabs.length).toBe(3)
    expect(TAB_CLASSNAMES.length).toBe(3)
  })

  it('every tab is its own vertical scroll box (per-tab scroll)', () => {
    // Each TabsContent fills + scrolls on its own; a shared wrapper is what let
    // one tab bottom-weight another (RES-0437).
    for (const cls of TAB_CLASSNAMES) {
      expect(cls).toContain('flex-1')
      expect(cls).toContain('min-h-0')
      expect(cls).toContain('overflow-y-auto')
    }
  })

  it('every tab clips horizontal overflow (no h-scrollbar)', () => {
    for (const cls of TAB_CLASSNAMES) expect(cls).toContain('overflow-x-hidden')
  })

  it('no TabsContent sets display:flex — it overrides Radix [hidden] and stacks the tabs (REQ-0442)', () => {
    // The root cause of six "bottom-aligned" rounds: an author `.flex`/`.inline-flex`
    // (display:flex) on the TabsContent beats the UA `[hidden]{display:none}` Radix
    // uses to hide inactive tabs, so all three render stacked.  flex-col layout a tab
    // needs (タブ1's mt-auto word toggle) must live in an INNER wrapper div instead.
    for (const cls of TAB_CLASSNAMES) {
      const tokens = cls.split(/\s+/)
      expect(tokens).not.toContain('flex')
      expect(tokens).not.toContain('inline-flex')
      expect(tokens).not.toContain('flex-col')
    }
  })

  it('no TabsContent uses min-h-full on the scroll box (fragile trick; inner wrappers may)', () => {
    // RES-0437 banned min-h-full on the scroll box.  REQ-0442's tab1 inner wrapper
    // legitimately uses min-h-full for mt-auto bottom-pinning — that is NOT a
    // TabsContent className, so this scoped check still forbids the fragile location.
    for (const cls of TAB_CLASSNAMES) expect(cls).not.toContain('min-h-full')
  })

  it('does NOT reintroduce a shared scroll container with a scroll-reset ref', () => {
    expect(DRAWER_CODE).not.toContain('scrollRef')
  })

  it('the Whisper controls do NOT reintroduce the -mx-2 bleed (h-scroll source)', () => {
    expect(WHISPER_CODE).not.toContain('-mx-2')
  })
})

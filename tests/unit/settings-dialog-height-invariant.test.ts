import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { describe, it, expect } from 'vitest'

/**
 * REQ-0283 — CI-enforced source-level invariants that stop the
 * settings dialog from regressing into content-driven height (the
 * "dialog jumps when switching tabs" bug that has been fixed in
 * REQ-018 → REQ-0164 → REQ-0283, three times).
 *
 * The rules encoded here match the DO-NOT list in the settings-dialog
 * source comment; they exist because a plain visual test would need
 * a jsdom + layout shim vitest doesn't ship with, whereas a
 * source-string invariant is fast, deterministic, and directly
 * targets the recurring failure mode.
 *
 * If you legitimately need to bump the fixed pixel height, edit
 * BOTH the source constant AND this test's expected value in the
 * same commit — the test intentionally refuses to accept any
 * height number, only the one it was authored for.  If you want
 * to allow a range, the invariant has weakened and the same
 * whack-a-mole regression opens up again.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const settingsDialogPath = join(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'components',
  'settings-dialog',
  'settings-dialog.tsx',
)

const source = readFileSync(settingsDialogPath, 'utf-8')

/**
 * Grab every className string that appears inside a `<TabsContent`
 * opening tag.  Regex approach (not a real TSX parser) is fine here
 * because the file's `<TabsContent value="..." className="...">` shape
 * is stable and the alternative — spinning up ts-morph — is heavy for
 * a single style assertion.
 */
function extractTabsContentClassNames(src: string): string[] {
  const results: string[] = []
  const re = /<TabsContent\b[^>]*className="([^"]*)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    results.push(m[1])
  }
  return results
}

/**
 * Grab the className of the top-level `<DialogContent>` element (the
 * settings dialog only has one; if this ever finds multiple, the
 * component was restructured in a way that also warrants revisiting
 * the invariant).
 */
function extractDialogContentClassName(src: string): string {
  const m = src.match(/<DialogContent[\s\S]*?className="([^"]*)"/)
  expect(m, 'Expected a single <DialogContent className="..."> in settings-dialog.tsx').not.toBeNull()
  return m![1]
}

describe('REQ-0283 — settings dialog fixed-height invariant', () => {
  it('DialogContent has a FIXED h-[Xpx] (not min-h alone, not just max-h)', () => {
    const cls = extractDialogContentClassName(source)
    // Look for `h-[<number>px]` — the presence of a fixed pixel height
    // is the core guarantee.  A `min-h-[...]` on the frame would
    // reintroduce content-driven growth above the floor.
    const fixedHeight = cls.match(/(?:^|\s)h-\[(\d+)px\]/)
    expect(fixedHeight, `DialogContent className must include a fixed h-[Xpx] (got: "${cls}")`).not.toBeNull()
    // Pin the current fixed height so a future refactor that changes
    // this value has to update both the source AND this test in the
    // same commit.  Bump both intentionally if you need a different
    // frame size (and document why in the source docblock).
    //
    // History (bump entries here whenever the source value moves):
    //   REQ-0283: 640px — original REQ-0283 landing.
    //   REQ-0284: 720px — raised so Fonts tab fits without the outer
    //     wrapper also scrolling (double-scroll cleanup).  See
    //     RES-0284 §1 for the measurement breakdown.
    expect(fixedHeight![1]).toBe('720')
  })

  it('DialogContent has max-h-[85vh] cap so tiny viewports still fit', () => {
    const cls = extractDialogContentClassName(source)
    expect(cls).toContain('max-h-[85vh]')
  })

  it('DialogContent uses `flex flex-col overflow-hidden` (frame does NOT scroll itself)', () => {
    const cls = extractDialogContentClassName(source)
    expect(cls).toContain('flex flex-col')
    // `overflow-hidden` on the frame ensures the outer window never
    // grows to fit content — the inner wrapper handles scroll.  Anti-
    // pattern: `overflow-y-auto` on DialogContent (the pre-REQ-0283
    // behaviour that made the frame content-driven).
    expect(cls).toContain('overflow-hidden')
    expect(cls, 'DialogContent must not scroll itself — the inner wrapper does').not.toContain('overflow-y-auto')
  })

  it('a single scroll wrapper (`flex-1 min-h-0 overflow-y-auto`) wraps every TabsContent', () => {
    // We look for the wrapper div's className anywhere in the source.
    // The exact string must be present as-is (the invariant is that
    // ONE such wrapper exists; if a contributor splits it into
    // per-tab wrappers they've reintroduced the scattered-height
    // problem).
    expect(source).toContain('flex-1 min-h-0 overflow-y-auto')
  })

  it('NO TabsContent uses min-h-[Xpx] (per-tab height pinning is the whack-a-mole pattern)', () => {
    // The pre-REQ-0283 code had `min-h-[490px]` on every TabsContent.
    // That approach requires every new tab to remember to add the
    // class, and tall content (shortcuts) still bypassed the floor
    // and grew the frame.  Post-REQ-0283 the responsibility is on
    // the wrapper; individual tabs must not touch min-h.
    const classNames = extractTabsContentClassNames(source)
    expect(classNames.length, 'Expected at least one TabsContent — file layout drifted?').toBeGreaterThan(0)
    for (const cls of classNames) {
      expect(cls, `TabsContent className should NOT contain min-h-[...]: "${cls}"`)
        .not.toMatch(/min-h-\[/)
    }
  })

  it('NO TabsContent uses max-h-[Xpx] (per-tab ceilings are also whack-a-mole)', () => {
    // The pre-REQ-0283 `shortcuts` TabsContent had `max-h-[490px]
    // overflow-y-auto` added as a REQ-0164 §1 patch.  Post-REQ-0283
    // scrolling is on the wrapper — individual tabs must not touch
    // max-h either.
    const classNames = extractTabsContentClassNames(source)
    for (const cls of classNames) {
      expect(cls, `TabsContent className should NOT contain max-h-[...]: "${cls}"`)
        .not.toMatch(/max-h-\[/)
    }
  })

  it('NO TabsContent uses overflow-y-auto (scroll belongs on the shared wrapper)', () => {
    // Per-tab scroll defeats the "one place to fix" structure.  The
    // wrapper div's `overflow-y-auto` is the single scroll region.
    const classNames = extractTabsContentClassNames(source)
    for (const cls of classNames) {
      expect(cls, `TabsContent className should NOT contain overflow-y-auto: "${cls}"`)
        .not.toContain('overflow-y-auto')
    }
  })

  it('the Tabs wrapper uses `flex-1 min-h-0 flex flex-col` so it fills the panel area', () => {
    // The Tabs root must be a flex column that fills the remaining
    // vertical space in DialogContent.  Without `flex-1 min-h-0` the
    // scroll wrapper's `flex-1 min-h-0 overflow-y-auto` has nothing
    // to fill.
    expect(source).toMatch(/<Tabs[\s\S]*?className="[^"]*flex-1[^"]*min-h-0[^"]*flex[^"]*flex-col/)
  })
})

describe('REQ-0283 — tab count sanity (documents assumption of the fixed-height sizing)', () => {
  it('renders exactly 5 tabs (general / fonts / translation / shortcuts / cli)', () => {
    // REQ-0426 — 字幕スタイル / Whisper設定 removed, 翻訳 added: 5 → 4.
    // REQ-0447 — a CLI tab was added (spec §12): 4 → 5.
    // If a new tab is added the fixed height MAY need to bump; bumping this
    // test forces the contributor to think about it.
    const triggers = source.match(/<TabsTrigger\b/g) ?? []
    expect(triggers.length).toBe(5)
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  canUseKaraokeInTier,
  KARAOKE_DEFAULT_HIGHLIGHT_COLOR,
} from '../../src/shared/karaoke-gate'

/**
 * REQ-0286 §0 — pins the karaoke tier gate as the SINGLE decision
 * surface for whether karaoke is available in the current build.
 *
 * Every UI, ass-generator, and preview consumer MUST call this function
 * rather than inline `isMsix` checks.  If a future contributor bypasses
 * it, the "one-line flip to free" contract breaks — a search-and-
 * replace across the codebase to find every karaoke-related isMsix
 * check would be error-prone.
 *
 * The "sole decision point" pin below is a source scan asserting that no line
 * combines a karaoke token with `isMsix` WITHOUT going through
 * `canUseKaraokeInTier`.  A regression that adds such an inline check breaks
 * the test at CI time.
 *
 * REQ-0506 §1-1 — that paragraph used to describe a "Test #4" that DID NOT
 * EXIST: this file had three policy tests and two colour tests, and no source
 * scan anywhere. The contract was documented as CI-enforced while nothing
 * enforced it, which is worse than an admittedly weak gate — a reader stops
 * looking. The scan is now real, and its negative control is below it.
 */

describe('REQ-0286 §0 / REQ-0299 §1 — canUseKaraokeInTier policy', () => {
  it('returns true for MSIX (paid tier)', () => {
    expect(canUseKaraokeInTier(true)).toBe(true)
  })

  it('REQ-0299 §1 — returns TRUE for NSIS (free tier) too — karaoke now available to every tier', () => {
    // Pre-REQ-0299 (v1.3.6 initial) shipped karaoke paid-only.  REQ-0299
    // §1 reversed that decision: karaoke is a general-use feature and the
    // paid tier differentiates through additional fonts / weight
    // selection only.  Flipping this back to `false` would silently
    // suppress karaoke in the NSIS build again — this pin trips first.
    expect(canUseKaraokeInTier(false)).toBe(true)
  })

  it('REQ-0299 §1 — the isMsix arg is ignored (both values produce true)', () => {
    // Documents that karaoke policy is currently tier-agnostic.  A
    // future REQ that reintroduces tier gating for karaoke would flip
    // this and the "NSIS is TRUE" test above in the same commit.
    expect(canUseKaraokeInTier(true)).toBe(canUseKaraokeInTier(false))
  })
})

/**
 * REQ-0506 §1-1 — the "sole decision point" scan the docstring promises.
 *
 * Line-level, not file-level, on purpose. A file-level rule ("mentions
 * karaokeEnabled and isMsix but never canUseKaraokeInTier") false-positives on
 * `row-style-preview.tsx`, which merely FORWARDS `isMsix` to a helper and makes
 * no tier decision of its own. The thing actually worth forbidding is a single
 * expression that fuses a karaoke condition with the tier flag — exactly the
 * `e.karaokeEnabled === true && isMsix` shape the gate exists to prevent.
 */
export interface InlineTierCheck {
  file: string
  line: number
  text: string
}

/**
 * Blank out comments so prose cannot trip the scan.
 *
 * Necessary in practice, not theoretical: the first run flagged two lines in
 * `timeline-block-inspector.tsx` that are ordinary explanatory comments — one
 * of them a WRAPPED `canUseKaraokeInTier(isMsix)` reference whose closing
 * `(isMsix)` landed on its own line. A comment cannot decide anything, and
 * flagging prose would push contributors to stop writing it.
 *
 * Line comments and block comments only; a `//` inside a string literal would
 * over-strip, which is the safe direction here (it can hide a violation on that
 * one line, never invent one, and no such line exists today).
 */
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

/** Lines that decide karaoke by tier without routing through the gate. */
export function findInlineTierChecks(files: { path: string; text: string }[]): InlineTierCheck[] {
  const found: InlineTierCheck[] = []
  for (const { path, text } of files) {
    // The gate's own definition is the one place allowed to name both.
    if (path.replace(/\\/g, '/').endsWith('shared/karaoke-gate.ts')) continue
    stripComments(text).split('\n').forEach((raw, i) => {
      if (!/karaoke/i.test(raw)) return
      if (!/\bisMsix\b/.test(raw)) return
      if (/canUseKaraokeInTier/.test(raw)) return
      found.push({ file: path, line: i + 1, text: raw.trim() })
    })
  }
  return found
}

function collectSources(dir: string, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collectSources(full, out)
    else if (/\.tsx?$/.test(name)) out.push({ path: relative(join(__dirname, '..', '..'), full), text: readFileSync(full, 'utf-8') })
  }
  return out
}

describe('REQ-0286 §0 / REQ-0506 §1-1 — canUseKaraokeInTier is the SOLE decision point', () => {
  const sources = collectSources(join(__dirname, '..', '..', 'src'))

  it('no source line decides karaoke by tier outside the gate', () => {
    const violations = findInlineTierChecks(sources)
    expect(
      violations.map((v) => `${v.file}:${v.line}  ${v.text}`),
      'inline tier check found — route it through canUseKaraokeInTier()',
    ).toEqual([])
  })

  it('the scan is not vacuous — real gated CODE lines exist', () => {
    // Without this, renaming either token — or a comment-stripper bug that ate
    // everything — would make the check above pass by examining nothing.
    const gated = sources.flatMap(({ text }) =>
      text.split('\n').filter((l) => /karaoke/i.test(l) && /\bisMsix\b/.test(l) && /canUseKaraokeInTier\(/.test(l)),
    )
    expect(gated.length).toBeGreaterThan(3)
  })

  it('comment prose is not treated as a decision', () => {
    // Not hypothetical: the first run of this scan flagged two explanatory
    // comments in timeline-block-inspector.tsx, one of them a WRAPPED
    // `canUseKaraokeInTier(isMsix)` whose closing `(isMsix)` sat on its own line.
    const commented = [
      { path: 'src/x.tsx', text: '// karaoke row hides on free builds; useAppEnvStore.isMsix is null early\n' },
      { path: 'src/y.tsx', text: '/* karaoke\n   (isMsix)`) so no karaoke state is stored */\n' },
    ]
    expect(findInlineTierChecks(commented)).toEqual([])
  })

  /**
   * ★ Negative control. The checker runs against a synthetic tree containing
   * the exact shape the gate forbids; if it cannot see that, the test above is
   * as empty as the docstring used to be.
   */
  it('NEGATIVE CONTROL — an inline karaoke tier check is caught', () => {
    const broken = [
      { path: 'src/renderer/components/fake-panel.tsx', text: 'const show = entry.karaokeEnabled === true && isMsix\n' },
    ]
    const violations = findInlineTierChecks(broken)
    expect(violations).toHaveLength(1)
    expect(violations[0].line).toBe(1)
    expect(violations[0].file).toContain('fake-panel')
  })

  it('NEGATIVE CONTROL — a legitimate gated line is NOT caught', () => {
    const ok = [
      { path: 'src/renderer/components/fake-panel.tsx', text: 'const show = entry.karaokeEnabled === true && canUseKaraokeInTier(isMsix)\n' },
    ]
    expect(findInlineTierChecks(ok)).toEqual([])
  })

  it('the gate file itself is exempt (it necessarily names both)', () => {
    expect(findInlineTierChecks([{ path: 'src/shared/karaoke-gate.ts', text: 'return isMsix // karaoke\n' }])).toEqual([])
  })
})

describe('REQ-0286 — karaoke default highlight colour', () => {
  // REQ-0308 §5 — was '#FFFF00'.  The lime is a member of the REQ-0306
  // BASIC_COLORS palette, so the picker now shows the default as selected.
  it('highlight defaults to the lime accent (#B4FF39, a BASIC_COLORS member)', () => {
    expect(KARAOKE_DEFAULT_HIGHLIGHT_COLOR).toBe('#B4FF39')
  })

  it('is 6-hex uppercase — matches ColorPicker canonical form', () => {
    expect(KARAOKE_DEFAULT_HIGHLIGHT_COLOR).toMatch(/^#[0-9A-F]{6}$/)
  })

  // REQ-0293 §2 removed the pre-existing `KARAOKE_DEFAULT_BASE_COLOR`
  // constant — the base half of the karaoke sweep now always tracks
  // each cue's `textColorHex` at render time, so no base default is
  // needed.  See karaoke-gate.ts docstring for the full context.
})

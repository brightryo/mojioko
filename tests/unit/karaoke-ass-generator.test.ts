import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import type { SubtitleEntry, VideoInfo, BurninPosition, WordSpan } from '../../src/shared/types'

/**
 * REQ-0286 §2 / §0 — pins the end-to-end karaoke path through
 * ass-generator:
 *   - Tier gate (paid-only in current policy)
 *   - Karaoke toggle (per-cue karaokeEnabled)
 *   - Words-validity gate (Layer 2 fallback)
 *   - `\c` / `\2c` colour emission
 *   - `\k` tag emission via buildKaraokeAssText
 *   - Byte-identical fallback to plain rendering when any gate fails
 */

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 }

const validWords: WordSpan[] = [
  { startSec: 0, endSec: 0.5, text: 'hello' },
  { startSec: 0.5, endSec: 1.0, text: ' world' },
]

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base: SubtitleEntry = {
    id: 'e1',
    startSec: 0, endSec: 2,
    text: 'hello world',
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center',
    verticalPosition: 'bottom',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false,
    isEdited: false,
    original: {
      startSec: 0, endSec: 2, text: 'hello world',
      fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
      outlineThicknessPx: 3, fadeDurationSec: 0,
      horizontalPosition: 'center', verticalPosition: 'bottom',
      verticalMarginPx: 40,
      subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    },
  }
  return { ...base, ...patch }
}

const dialogueLineOf = (ass: string): string =>
  ass.split('\n').find((l) => l.startsWith('Dialogue:')) ?? ''

describe('REQ-0286 §0 — tier gate at the emit path', () => {
  it('MSIX + karaokeEnabled + valid words → karaoke tags emitted', () => {
    const entry = makeEntry({
      karaokeEnabled: true,
      karaokeHighlightColor: '#FFFF00',
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true /* isMsix */)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\k')  // karaoke tag present
    expect(line).toContain('\\2c') // secondary colour (base) emitted
  })

  it('NSIS + karaokeEnabled + valid words → NO karaoke tags (tier fallback to plain)', () => {
    // The critical tier-gate pin.  A free-tier build must produce the
    // plain rendering even when the project file requests karaoke.
    const entry = makeEntry({
      karaokeEnabled: true,
      karaokeHighlightColor: '#FFFF00',
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, false /* NSIS */)
    const line = dialogueLineOf(ass)
    expect(line).not.toContain('\\k')  // no karaoke tags
    expect(line).not.toContain('\\2c') // no secondary colour
    expect(line).toContain('hello world') // plain text
  })

  it('MSIX + karaokeEnabled=false → no karaoke tags (toggle-off path)', () => {
    const entry = makeEntry({
      karaokeEnabled: false,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).not.toContain('\\k')
    expect(line).not.toContain('\\2c')
  })

  it('MSIX + karaokeEnabled + INVALID words → equal-split FALLBACK karaoke (REQ-0289 supersedes plain-fallback)', () => {
    // REQ-0286 originally fell through to plain rendering on this
    // path; REQ-0289 pivots to an equal-split fallback so karaoke
    // stays visible when Whisper timing is unavailable.  This test
    // now pins the REQ-0289 behaviour — karaoke tags ARE emitted
    // (from the fallback units), NOT suppressed.  The precise-timing
    // path still requires words-valid; that split is pinned by the
    // "words VALID → Whisper timing preserved" test in the REQ-0289
    // describe block below.
    const entry = makeEntry({
      text: 'completely different text',
      karaokeEnabled: true,
      words: validWords, // still says "hello world" — mismatch triggers fallback
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\k')
    expect(line).toContain('\\2c')
    // Each Latin word becomes its own karaoke unit — `\k<dur>` tags
    // interleave the words so the raw text is NOT contiguous.  Pin
    // each unit's text presence individually.
    expect(line).toContain('completely')
    expect(line).toContain(' different')
    expect(line).toContain(' text')
  })

  it('MSIX + karaokeEnabled + no words → equal-split FALLBACK karaoke (REQ-0289)', () => {
    // Same REQ-0289 pivot as above: `words === undefined` used to
    // suppress karaoke entirely; now it drops into the equal-split
    // fallback so a cue with the toggle ON always shows karaoke on
    // paid tier.
    const entry = makeEntry({
      karaokeEnabled: true,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\k')
    expect(line).toContain('\\2c')
  })
})

describe('REQ-0286 §2 — karaoke emit shape', () => {
  it('emits \\c<highlight> + \\2c<textColorHex> in the styleTag (colour setup for karaoke)', () => {
    // REQ-0293 §2 — base half of the sweep is now ALWAYS textColorHex.
    // The pre-REQ-0293 per-cue `karaokeBaseColor` override was
    // removed; setting a base explicitly is no longer possible.
    const entry = makeEntry({
      textColorHex: '#00FF00',            // green (= what base picks up)
      karaokeEnabled: true,
      karaokeHighlightColor: '#FF0000',   // red highlight
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    // #FF0000 → ASS &H000000FF&; #00FF00 → &H0000FF00&
    expect(line).toContain('\\c&H000000FF&')
    expect(line).toContain('\\2c&H0000FF00&')
  })

  it('REQ-0293 §2 — base ALWAYS = textColorHex (no karaokeBaseColor override anymore)', () => {
    // With a pink `textColorHex`, the base half of the karaoke sweep
    // MUST be pink.  Highlight defaults to the yellow accent when
    // `karaokeHighlightColor` is unset.
    const entry = makeEntry({
      textColorHex: '#FF00FF', // pink — flows straight into `\2c`
      karaokeEnabled: true,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\c&H0000FFFF&')  // #FFFF00 (default highlight)
    expect(line).toContain('\\2c&H00FF00FF&') // #FF00FF (base = textColorHex, pink)
  })

  it('REQ-0293 §2 — legacy `karaokeBaseColor` on a dev save is silently ignored; base still tracks textColorHex', () => {
    // Pre-REQ-0293 the `karaokeBaseColor` override would win.  Post-
    // REQ-0293 the field is dropped and base falls back to
    // `textColorHex`.  Any legacy dev save that still carries the
    // old key hydrates cleanly (unknown key ignored) and renders as
    // if the key were absent — pinned here with `as any` because
    // `karaokeBaseColor` is no longer in the type.
    const legacyPatch = {
      textColorHex: '#FF00FF',                   // pink
      karaokeEnabled: true,
      karaokeBaseColor: '#00FF00',               // legacy green — MUST be ignored
      words: validWords,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `karaokeBaseColor` was removed from the type; test simulates a legacy dev save carrying the extra key.
    } as any
    const entry = makeEntry(legacyPatch)
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\2c&H00FF00FF&')      // pink (textColorHex) wins
    expect(line).not.toContain('\\2c&H0000FF00&')  // legacy green MUST NOT appear
  })

  it('REQ-0290 §3 — outline colour \\3c stays on `outlineColorHex` when karaoke is active', () => {
    // Karaoke swaps the fill (\c) and secondary (\2c) colours to drive
    // the sweep.  The outline (\3c) is independent and MUST still carry
    // the user-configured `outlineColorHex` — the sweep does not touch
    // the outline half of the glyph.  Pin so a future refactor cannot
    // silently reroute \3c through the karaoke colour resolution.
    const entry = makeEntry({
      textColorHex: '#FF00FF',       // pink fill
      outlineColorHex: '#123456',    // distinctive outline
      karaokeEnabled: true,
      karaokeHighlightColor: '#AABBCC',
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    // hexToAss(#123456) = &H00563412& (ASS is BGR)
    expect(line).toContain('\\3c&H00563412&')
  })

  it('per-word \\k durations reflect the words[] activation offsets (REQ-0291 brace-enclosed)', () => {
    // words[0] at [0, 0.5], words[1] at [0.5, 1.0]; cue [0, 2].
    // word[0]'s \k = 0.5 - 0 = 50cs; word[1]'s \k = 2.0 - 0.5 = 150cs.
    // REQ-0291: each `\k` MUST live in its own `{...}` block or libass
    // draws it as literal text on the burn-in.
    const entry = makeEntry({
      startSec: 0,
      endSec: 2,
      karaokeEnabled: true,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('{\\k50}hello')
    expect(line).toContain('{\\k150} world')
    // Negative pin — the pre-REQ-0291 bare-tag shape MUST NOT appear.
    expect(line).not.toMatch(/[^{]\\k50/)
    expect(line).not.toMatch(/[^{]\\k150/)
  })

  it('casing="uppercase" applies per word, karaoke tags still surround uppercased text', () => {
    const entry = makeEntry({
      karaokeEnabled: true,
      casing: 'uppercase',
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('HELLO')
    expect(line).toContain(' WORLD')
    // Casing MUST NOT bleed into the tag body (`\khello` etc.); the
    // brace-enclosed form remains intact.
    expect(line).not.toContain('\\khello')
    expect(line).not.toContain('{\\khello')
    // The lower-case text is fully consumed by the uppercase pass;
    // check both bare and braced forms are absent.
    expect(line).not.toContain('}hello')
    expect(line).not.toContain('} world')
  })
})

describe('REQ-0286 backward compat — pre-REQ-0286 entries render byte-identical', () => {
  it('entry with NO karaoke fields renders EXACTLY the same as pre-REQ-0286 (no \\c/\\2c colour changes, no \\k)', () => {
    // isMsix=true so the tier gate is not the gating factor here — this
    // is the "user hasn't opted into karaoke" path.
    const entry = makeEntry()
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).not.toContain('\\k')
    expect(line).not.toContain('\\2c')
    // Baseline check: the plain white PrimaryColour is still there
    expect(line).toContain('\\c&H00FFFFFF&')
    expect(line).toContain('hello world')
  })
})

describe('REQ-0289 — equal-split karaoke fallback', () => {
  it('words invalid → equal-split fallback emits \\k tags (NOT plain rendering)', () => {
    // Text was edited so words[].text no longer concatenates to `text`.
    // Pre-REQ-0289 this fell through to plain rendering; REQ-0289
    // pivots to an equal-split fallback so karaoke is still visible.
    const entry = makeEntry({
      text: 'edited text',        // 2 Latin units → [edited, ' text']
      karaokeEnabled: true,
      words: validWords,           // still says `hello world` — mismatch
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\k')       // fallback karaoke ACTIVE
    expect(line).toContain('\\2c')      // secondary colour also emitted
    expect(line).toContain('edited')    // the current text is what's rendered
    expect(line).toContain(' text')
  })

  it('words invalid + JA text → per-character equal split (REQ-0291 brace-enclosed)', () => {
    // 5 Japanese chars over a 2-second cue → 0.4 s each → 40 cs each.
    // `buildKaraokeAssText` calculates each \k from the NEXT unit's
    // start, so the last char also gets ~40 cs (rounded).
    const entry = makeEntry({
      text: 'こんにちは',
      startSec: 0,
      endSec: 2,
      karaokeEnabled: true,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    // Each of the 5 chars gets `{\k40}` (0.4 s = 40 cs) — brace-
    // enclosed so libass parses the tag instead of drawing it.
    expect(line).toContain('{\\k40}こ')
    expect(line).toContain('{\\k40}ん')
    expect(line).toContain('{\\k40}に')
    expect(line).toContain('{\\k40}ち')
    expect(line).toContain('{\\k40}は')
  })

  it('words invalid + EN text → per-word equal split (REQ-0291 brace-enclosed)', () => {
    // `hello world` → 2 units (`hello` + ` world`) over 2 seconds →
    // 1 s each → 100 cs each.
    const entry = makeEntry({
      text: 'hello world',
      startSec: 0,
      endSec: 2,
      karaokeEnabled: true,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('{\\k100}hello')
    expect(line).toContain('{\\k100} world')
  })

  it('words VALID → Whisper timing preserved (fallback does NOT hijack the precise path)', () => {
    // Words align with text → the existing REQ-0286 code path fires
    // and `\k` durations come from Whisper offsets (50cs / 150cs for
    // this fixture), NOT from an equal split (which would be 100/100).
    const entry = makeEntry({
      text: 'hello world',
      startSec: 0,
      endSec: 2,
      karaokeEnabled: true,
      words: validWords, // [{0,0.5,hello}, {0.5,1.0,' world'}]
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    // Whisper timing: 50cs + 150cs (word activation offsets), NOT
    // 100cs + 100cs (equal split).  Both brace-enclosed (REQ-0291).
    expect(line).toContain('{\\k50}hello')
    expect(line).toContain('{\\k150} world')
    expect(line).not.toContain('{\\k100}')
  })

  it('empty text + karaoke ON → no fallback units → plain rendering (no \\k)', () => {
    // `splitTextIntoKaraokeUnits('')` returns [] → karaokeWords.length
    // === 0 → karaokeActive false → plain path.  Guards against
    // zero-unit divide-by-zero and NaN centiseconds.
    const entry = makeEntry({
      text: '',
      karaokeEnabled: true,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).not.toContain('\\k')
    expect(line).not.toContain('\\2c')
  })

  it('free tier (NSIS) + words invalid → NO fallback emitted (tier gate wraps fallback too)', () => {
    // The equal-split fallback lives INSIDE the tier gate, not
    // outside — a free-tier build must still produce plain rendering
    // even when the toggle + fallback would otherwise apply.
    const entry = makeEntry({
      text: 'edited text',
      karaokeEnabled: true,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, false /* NSIS */)
    const line = dialogueLineOf(ass)
    expect(line).not.toContain('\\k')
    expect(line).not.toContain('\\2c')
    expect(line).toContain('edited text')
  })

  it('karaoke OFF + words invalid → plain rendering (fallback only fires with toggle ON)', () => {
    // Toggle-off short-circuits the whole karaoke branch — the
    // fallback is a rescue for "karaoke was ON but words data is
    // stale", not a way to force karaoke onto plain cues.
    const entry = makeEntry({
      text: 'edited text',
      karaokeEnabled: false,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).not.toContain('\\k')
    expect(line).not.toContain('\\2c')
  })
})

describe('REQ-0291 — ASS override-tag well-formedness (regression pin)', () => {
  // Root cause: `buildKaraokeAssText` emitted bare `\k50hello` where it
  // should have emitted `{\k50}hello`.  libass draws bare override tags
  // as literal text so the owner saw `\k50hello` printed on the burn-in
  // video.  These tests fail if any code path reintroduces a bare `\k`
  // in the final Dialogue line — both Whisper timing (REQ-0286) and
  // equal-split fallback (REQ-0289) share the same emitter so both are
  // covered by the same well-formedness assertions.

  /** Extract everything after the Effect column's trailing comma —
   *  the ASS Text field where override tags actually live.
   *  Mojioko emits the shape:
   *    `Dialogue: 0,<start>,<end>,<style>,0,0,<mv>,,<text>`
   *  That's 8 commas before the text field (Layer/Start/End/Style/
   *  MarginL/MarginR/MarginV/Effect).  Sliced from position of the
   *  8th comma + 1. */
  function textFieldOf(dialogueLine: string): string {
    const commas: number[] = []
    for (let i = 0; i < dialogueLine.length; i++) {
      if (dialogueLine[i] === ',') commas.push(i)
      if (commas.length === 8) break
    }
    return dialogueLine.slice(commas[7] + 1)
  }

  /** Assert: after stripping every well-formed `{...}` block, NO `\`
   *  (backslash) remains — meaning every override tag lived inside
   *  braces and only literal text is left. */
  function assertNoBareOverrideTags(dialogueLine: string): void {
    const textField = textFieldOf(dialogueLine)
    // Strip every `{...}` block (may repeat, may include multi-tag
    // blocks like `{\an2\fs100...}`).  Non-greedy so adjacent blocks
    // `{a}{b}` don't collapse into one.
    const literalOnly = textField.replace(/\{[^}]*\}/g, '')
    // Any `\` remaining in the literal text is either a bare override
    // tag (bug) or an escaped-backslash literal (`\\`) — the latter
    // shouldn't occur in these fixtures.
    expect(literalOnly).not.toContain('\\')
  }

  /** Assert: braces are balanced (every `{` has a matching `}`). */
  function assertBracesBalanced(dialogueLine: string): void {
    const textField = textFieldOf(dialogueLine)
    let depth = 0
    for (const ch of textField) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
      // Depth must never go negative (unmatched `}`) or exceed 1
      // (nested braces — ASS doesn't allow them).
      expect(depth).toBeGreaterThanOrEqual(0)
      expect(depth).toBeLessThanOrEqual(1)
    }
    expect(depth).toBe(0)
  }

  it('Whisper timing path — every `\\k` is inside `{...}`, braces balanced', () => {
    const entry = makeEntry({
      karaokeEnabled: true,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    assertNoBareOverrideTags(line)
    assertBracesBalanced(line)
  })

  it('equal-split fallback (JA) — every `\\k` is inside `{...}`, braces balanced', () => {
    const entry = makeEntry({
      text: 'テストです',
      karaokeEnabled: true,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    assertNoBareOverrideTags(line)
    assertBracesBalanced(line)
  })

  it('equal-split fallback (EN, 3 words) — every `\\k` is inside `{...}`, braces balanced', () => {
    const entry = makeEntry({
      text: 'hello world edited',
      karaokeEnabled: true,
      words: undefined,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    assertNoBareOverrideTags(line)
    assertBracesBalanced(line)
  })

  it('leading-offset case — the silent `{\\k<offset>}` is also brace-enclosed', () => {
    // First word starts 0.5s AFTER cue start → buildKaraokeAssText
    // emits an initial silent `{\k50}`.  Regression pin: the leading
    // offset was previously emitted as bare `\k50` too.  Text must
    // match words[].concat so the words-valid gate hits the Whisper
    // path (not the equal-split fallback, which would produce a
    // different leading-offset shape).
    const entry = makeEntry({
      startSec: 0,
      endSec: 2,
      text: 'delayed start',
      karaokeEnabled: true,
      words: [
        { startSec: 0.5, endSec: 1.0, text: 'delayed' },
        { startSec: 1.0, endSec: 1.5, text: ' start' },
      ],
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    assertNoBareOverrideTags(line)
    assertBracesBalanced(line)
    expect(line).toContain('{\\k50}{\\k50}delayed') // silent-offset + word
  })

  it('style-override block and karaoke blocks are ADJACENT `{}` groups, not merged into one', () => {
    // Pin the intended shape: `{style}{\k50}word1{\k100} word2`.
    // A future refactor might be tempted to fold the first `\k` into
    // the style block (`{style\k50}word1{\k100} word2`) — this test
    // fails in that case, protecting the two-block layout that keeps
    // buildKaraokeAssText independent of the caller's style tag.
    const entry = makeEntry({
      karaokeEnabled: true,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    const textField = textFieldOf(line)
    // The pattern `}{` marks the boundary between the style block and
    // the first karaoke block.
    expect(textField).toMatch(/\}\{\\k\d+\}/)
  })

  it('shape sanity — text field starts with an override block, not with bare text', () => {
    const entry = makeEntry({
      karaokeEnabled: true,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    const textField = textFieldOf(line)
    // First char MUST be `{` (opening the style override block).
    expect(textField.startsWith('{')).toBe(true)
  })
})

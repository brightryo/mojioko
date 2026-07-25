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
      karaokeBaseColor: '#FFFFFF',
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
      karaokeBaseColor: '#FFFFFF',
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
  it('emits \\c<highlight> + \\2c<base> in the styleTag (colour setup for karaoke)', () => {
    const entry = makeEntry({
      karaokeEnabled: true,
      karaokeHighlightColor: '#FF0000',  // red
      karaokeBaseColor: '#00FF00',       // green
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    // #FF0000 → ASS &H000000FF&; #00FF00 → &H0000FF00&
    expect(line).toContain('\\c&H000000FF&')
    expect(line).toContain('\\2c&H0000FF00&')
  })

  it('REQ-0290 §1 — base defaults to textColorHex when karaokeBaseColor unset; highlight defaults to yellow', () => {
    // With a pink `textColorHex`, enabling karaoke without an explicit
    // `karaokeBaseColor` MUST NOT drop back to white — the base half of
    // the sweep should inherit the row's own text colour so the user's
    // per-cue colour is not silently discarded.  Highlight stays on
    // KARAOKE_DEFAULT_HIGHLIGHT_COLOR (#FFFF00 yellow) because the
    // accent-colour intent is uniform (REQ-0290 §1 last bullet).
    const entry = makeEntry({
      textColorHex: '#FF00FF', // pink — the owner's example
      karaokeEnabled: true,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\c&H0000FFFF&')  // #FFFF00 (default highlight, yellow)
    expect(line).toContain('\\2c&H00FF00FF&') // #FF00FF (base = textColorHex, pink)
  })

  it('REQ-0290 §1 — explicit karaokeBaseColor overrides the textColorHex inheritance', () => {
    // After the user has picked a base colour, that value wins over the
    // textColorHex fallback.  This is the "後から未発話色を変えれば効く"
    // requirement — inheritance only fires when the field is undefined.
    const entry = makeEntry({
      textColorHex: '#FF00FF',       // pink
      karaokeEnabled: true,
      karaokeBaseColor: '#00FF00',   // user picked green
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\2c&H0000FF00&') // green wins, pink is NOT emitted for base
    expect(line).not.toContain('\\2c&H00FF00FF&')
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

  it('per-word \\k durations reflect the words[] activation offsets', () => {
    // words[0] at [0, 0.5], words[1] at [0.5, 1.0]; cue [0, 2].
    // word[0]'s \k = 0.5 - 0 = 50cs; word[1]'s \k = 2.0 - 0.5 = 150cs.
    const entry = makeEntry({
      startSec: 0,
      endSec: 2,
      karaokeEnabled: true,
      words: validWords,
    })
    const ass = generateAss([entry], video, burnin, undefined, undefined, true)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\k50hello')
    expect(line).toContain('\\k150 world')
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
    expect(line).not.toContain('\\khello')
    expect(line).not.toContain(' world')
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

  it('words invalid + JA text → per-character equal split', () => {
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
    // Each of the 5 chars gets \k40 (0.4 s = 40 cs).
    expect(line).toContain('\\k40こ')
    expect(line).toContain('\\k40ん')
    expect(line).toContain('\\k40に')
    expect(line).toContain('\\k40ち')
    expect(line).toContain('\\k40は')
  })

  it('words invalid + EN text → per-word equal split', () => {
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
    expect(line).toContain('\\k100hello')
    expect(line).toContain('\\k100 world')
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
    // 100cs + 100cs (equal split).
    expect(line).toContain('\\k50hello')
    expect(line).toContain('\\k150 world')
    expect(line).not.toContain('\\k100')
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

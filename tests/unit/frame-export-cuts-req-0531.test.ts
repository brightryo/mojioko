/**
 * REQ-0531 — the still export honours `cuts`, on the EDITED axis.
 *
 * The behavioural half (real burns, real stills, real pixels) is the
 * `export_frame == burn under cuts` block in `scripts/cli-smoke.mjs`. What is
 * pinned here is the arithmetic those pixels depend on, at the four places the
 * axis is decided:
 *
 *   1. the shared fold both renderers run (`translateEntriesToEditedAxis`);
 *   2. which SOURCE frame an edited-axis `--time` extracts;
 *   3. the `--time` ceiling (`editedDuration`, not the file's length);
 *   4. `cueVisible`, which answers a question about the edited axis.
 *
 * NEGATIVE CONTROLS (§3-4, CLAUDE.md §18 "負の対照に git checkout を使わない"):
 * every case writes the pre-REQ-0531 expression out in place and asserts it
 * gives a DIFFERENT answer. No git, no source swap, nothing to rot.
 *
 * BOTH SIDES (§3-2): each block is paired with a no-cuts assertion. A gate that
 * only proves "cuts now change the answer" stays green if the no-cuts path was
 * broken in the process, and that path is the overwhelming majority of projects.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  editedDuration,
  editedToOrig,
  origToEdited,
  translateEntriesToEditedAxis,
  type Cut,
} from '../../src/shared/cuts'
import { displayedFrameSeekSec } from '../../src/shared/frame-seek'
import type { SubtitleEntry } from '../../src/shared/types'

const NO_CUTS: Cut[] = []
const cut = (id: string, startSec: number, endSec: number): Cut => ({ id, startSec, endSec })

function cue(id: string, startSec: number, endSec: number, text = 'x'): SubtitleEntry {
  const base = {
    id, startSec, endSec, text,
    fontSizePx: 48, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 3, fadeDurationSec: 0,
    horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 60 },
    isDeleted: false, isEdited: false,
  } as unknown as SubtitleEntry
  return { ...base, original: { ...base } as SubtitleEntry['original'] }
}

/** `cueVisible`, exactly as `commands/export-frame.ts` computes it. */
const cueVisibleAt = (entries: readonly SubtitleEntry[], t: number): boolean =>
  entries.some((e) => !e.isDeleted && e.startSec <= t && t < e.endSec && e.text.trim() !== '')

describe('REQ-0531 §2-2 — one fold, shared by the burn and the still', () => {
  it('returns the input array BY REFERENCE when there are no cuts', () => {
    // Not merely "deep-equal". The §2-4 promise is that a project without
    // trimming produces byte-identical output, and the cheapest way to
    // guarantee the generated ASS is unchanged is to hand `generateAss` the
    // very same objects it received before.
    const entries = [cue('a', 0, 2), cue('b', 3, 5)]
    const out = translateEntriesToEditedAxis(entries, NO_CUTS)
    expect(out.entries).toBe(entries)
    expect(out.droppedWordsIds).toEqual([])
  })

  it('drops cues a cut fully consumed and translates the survivors', () => {
    const entries = [
      cue('before', 0, 1),      // untouched, ahead of the cut
      cue('eaten', 2.2, 3.8),   // strictly inside [2,4] → gone
      cue('after', 5, 7),       // shifts back by the 2s the cut removed
    ]
    const { entries: out } = translateEntriesToEditedAxis(entries, [cut('c0', 2, 4)])
    expect(out.map((e) => e.id)).toEqual(['before', 'after'])
    expect(out[0].startSec).toBe(0)
    expect(out[1].startSec).toBe(3)
    expect(out[1].endSec).toBe(5)

    // Negative control: the pre-REQ-0531 still did none of this — it handed
    // `generateAss` the raw list, so `eaten` was drawable and `after` sat 2s
    // later than the burn puts it.
    expect(entries.map((e) => e.id)).toContain('eaten')
    expect(entries[2].startSec).toBe(5)
  })

  it('is wired into BOTH renderers rather than copied into one', () => {
    // §2-2 is a structural requirement, so it gets a structural check: the
    // failure it guards against is someone re-inlining the flatMap in one of
    // the two files, which no behavioural test on today's inputs would catch
    // (a copy agrees on the day it is written — that is the whole problem).
    const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8')
    const burnin = src('src/main/services/ffmpeg-burnin.ts')
    const still = src('src/main/services/frame-exporter.ts')
    for (const [name, text] of [['ffmpeg-burnin', burnin], ['frame-exporter', still]] as const) {
      expect(text, `${name} must call the shared fold`).toContain('translateEntriesToEditedAxis(')
      expect(text, `${name} must not re-inline the per-entry fold`)
        .not.toContain('translateEntryToEditedAxis(')
    }
  })
})

describe('REQ-0531 §2-1 — which source frame an edited-axis --time extracts', () => {
  const FPS = 30
  const cuts = [cut('c0', 2, 4)]

  it('seeks the source at editedToOrig(timeSec), not at timeSec', () => {
    // The burn's 5s frame comes from 7s of the source (2s removed before it).
    const seek = displayedFrameSeekSec(editedToOrig(5, cuts), FPS)
    expect(editedToOrig(5, cuts)).toBe(7)

    // Negative control — the pre-REQ-0531 seek, which fed `timeSec` straight in.
    const preFix = displayedFrameSeekSec(5, FPS)
    expect(seek).not.toBe(preFix)
    expect(seek - preFix).toBeCloseTo(2, 6)
  })

  it('an edited time landing on a cut boundary resolves to a SURVIVING frame', () => {
    // §1-4: the edited axis cannot name a removed frame. t=2 is the collapse
    // point of [2,4]; the post-cut convention sends it to 4, the first frame
    // the burn kept — never into the hole.
    expect(editedToOrig(2, cuts)).toBe(4)
    expect(editedToOrig(1.9, cuts)).toBeCloseTo(1.9, 6)
    // Round-trip: every edited time in range maps to a source time that maps back.
    for (const t of [0, 0.5, 1.9, 2, 2.5, 5, 7.9]) {
      expect(origToEdited(editedToOrig(t, cuts), cuts)).toBeCloseTo(t, 6)
    }
  })

  it('is the identity without cuts (both sides)', () => {
    for (const t of [0, 1.234, 5, 9.99]) {
      expect(editedToOrig(t, NO_CUTS)).toBe(t)
      expect(displayedFrameSeekSec(editedToOrig(t, NO_CUTS), FPS)).toBe(displayedFrameSeekSec(t, FPS))
    }
  })
})

describe('REQ-0531 §2-5 — the --time ceiling is the edited duration', () => {
  const SOURCE_DUR = 10
  const cuts = [cut('c0', 2, 4)]

  it('rejects the window that used to be silently accepted', () => {
    const ceiling = editedDuration(SOURCE_DUR, cuts)
    expect(ceiling).toBe(8)

    // t=9 is inside the FILE but past the end of the burn. The old check
    // (`t >= video.durationSec`) let it through and returned a frame that
    // exists nowhere in the output.
    expect(9 >= ceiling).toBe(true)          // now rejected
    expect(9 >= SOURCE_DUR).toBe(false)      // negative control: was accepted
    // The rest of the range is unaffected — this must not become "reject more".
    expect(7.9 >= ceiling).toBe(false)
  })

  it('is the file duration, to the byte, without cuts (both sides)', () => {
    expect(editedDuration(SOURCE_DUR, NO_CUTS)).toBe(SOURCE_DUR)
    // Same value ⇒ same rejection set ⇒ same message string (it interpolates
    // `durationSec.toFixed(3)`), so REQ-0502's behaviour is untouched.
    expect(editedDuration(SOURCE_DUR, NO_CUTS).toFixed(3)).toBe(SOURCE_DUR.toFixed(3))
  })
})

describe('REQ-0531 §2-1 — cueVisible answers about the edited axis', () => {
  const cuts = [cut('c0', 2, 4)]
  const entries = [cue('eaten', 2.2, 3.8), cue('after', 5, 7)]

  it('reports the cue the burn actually shows at that instant', () => {
    const { entries: edited } = translateEntriesToEditedAxis(entries, cuts)
    // Edited t=3.5 is source t=5.5, inside `after` (edited [3,5]).
    expect(cueVisibleAt(edited, 3.5)).toBe(true)
    // Negative control: against RAW cues, edited 3.5 falls in `eaten` — a cue
    // the burn deleted. Same `true`, wrong reason; the pre-fix flag could not
    // tell these apart.
    expect(cueVisibleAt(entries, 3.5)).toBe(true)
    expect(entries[0].id).toBe('eaten')

    // The case where the two disagree outright: edited t=5.5 is past the end
    // of every surviving cue, but lands inside raw `after` [5,7].
    expect(cueVisibleAt(edited, 5.5)).toBe(false)
    expect(cueVisibleAt(entries, 5.5)).toBe(true)
  })

  it('is unchanged without cuts (both sides)', () => {
    const { entries: same } = translateEntriesToEditedAxis(entries, NO_CUTS)
    for (const t of [0, 2.5, 3.5, 5.5, 6.9, 7, 9]) {
      expect(cueVisibleAt(same, t)).toBe(cueVisibleAt(entries, t))
    }
  })
})

describe('REQ-0531 §6-2 — entrance-animation phase, not just frame selection', () => {
  /**
   * The owner's stronger check: matching the FRAME is necessary but not
   * sufficient. libass resolves `\fad` / `\t` from the gap between the cue's
   * own start and the clock, so a still can extract the right pixels and still
   * draw the caption at the wrong point in its entrance.
   *
   * The §6-2 example: cue [3,10], cut [0,5], source t=6. The cut clamps the
   * cue's head to 5, which the burn places at edited 0 — so the burn is 1.0s
   * into the entrance while the pre-fix still was 3.0s in.
   */
  const cuts = [cut('c0', 0, 5)]

  it('the still and the burn now agree on elapsed-since-cue-start', () => {
    const raw = cue('e', 3, 10)
    const { entries: [edited] } = translateEntriesToEditedAxis([raw], cuts)
    expect(edited.startSec).toBe(0)   // head clamped to 5, then 5 → edited 0

    const editedNow = origToEdited(6, cuts)
    expect(editedNow).toBe(1)
    const burnElapsed = editedNow - edited.startSec
    expect(burnElapsed).toBe(1)

    // Negative control — the pre-fix pairing (raw cue times, source clock).
    const preFixElapsed = 6 - raw.startSec
    expect(preFixElapsed).toBe(3)
    expect(preFixElapsed).not.toBe(burnElapsed)
  })

  it('phase is unchanged without cuts (both sides)', () => {
    const raw = cue('e', 3, 10)
    const { entries: [same] } = translateEntriesToEditedAxis([raw], NO_CUTS)
    expect(origToEdited(6, NO_CUTS) - same.startSec).toBe(6 - raw.startSec)
  })
})

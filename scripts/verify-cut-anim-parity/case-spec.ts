/**
 * REQ-0532 §1 — the ONE definition of a `verify:cut-anim-parity` case.
 *
 * Imported by BOTH sides: `dump-entry.ts` (bundled for node, calls the real
 * `translateEntriesToEditedAxis` + real `generateAss`) and `harness-entry.tsx`
 * (bundled for chromium, feeds the real `VideoPreviewPanel`). One builder means
 * the burn and the preview cannot be measuring two different cues.
 *
 * ## What a case is
 *
 * A cue with an entrance/exit animation, plus a cut that EATS part of that
 * animation's window. The burn clamps the cue's head (or tail) to the cut and
 * moves the result onto the edited axis, so the animation replays from the cut
 * boundary. The question the gate asks is whether the preview shows the same
 * thing at the same instant.
 */
import { DEFAULT_FONT_ID } from '../../src/shared/fonts'
import type { Cut } from '../../src/shared/cuts'
import type { SubtitleEntry } from '../../src/shared/types'

export const VIDEO_W = 1920
export const VIDEO_H = 1080
export const VIDEO_DUR = 10

export interface CaseSpec {
  /** Cue window on the ORIGINAL axis (what the project file stores). */
  cueStart: number
  cueEnd: number
  /** Cuts on the ORIGINAL axis. Empty = the no-trim control case. */
  cuts: Cut[]
  anim: 'scale' | 'pop' | 'fade' | 'blur'
  animDurationSec: number
  inEnabled: boolean
  outEnabled: boolean
  /**
   * Probes on the EDITED axis — i.e. positions in the burn. Chosen per case to
   * sit inside the ramp the cut ate, plus one on the settled plateau that
   * supplies the reference the others are normalised against.
   *
   * ★ Kept away from the very start of the ramp. Every animation type carries
   * the shared OPACITY ramp, which begins at alpha 0; below roughly p = 0.08
   * the cue is dimmer than the harness's ink threshold, and the two engines
   * cross that threshold on different frames. Measured: at p = 0.04 the
   * preview had zero ink while the burn still showed a box, and at p = 0.10
   * for `blur` it was the other way round. Neither is a phase disagreement —
   * it is the floor of what this metric can see, and `verify:scale-origin`
   * documents the same one.
   */
  probes: number[]
  /** Index into `probes` of the settled sample. */
  settledIndex: number
  /**
   * The observable THIS animation actually moves, used for the "are the probes
   * on the ramp?" check and for the negative control.
   *
   * Declared per case rather than inferred, because getting it wrong makes a
   * gate assert something the animation never does: `fade` leaves the ink box
   * alone (opacity only → `mass`), and `blur` barely moves the box either — it
   * SPREADS the same ink over more pixels (→ `ink`). Measured on the first run:
   * blur's `size` deviated 0.034, far too little to see anything with, while
   * `ink` deviated well past the floor.
   */
  channel: 'size' | 'mass' | 'ink'
}

export const VIDEO = {
  path: 'x.mp4', hasVideoStream: true, widthPx: VIDEO_W, heightPx: VIDEO_H,
  durationSec: VIDEO_DUR, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

export function cue(spec: CaseSpec): SubtitleEntry {
  const base = {
    id: 'c1', startSec: spec.cueStart, endSec: spec.cueEnd, text: 'Hello World',
    fontSizePx: 140,
    textColorHex: '#ffffff', textAlpha: 100,
    // No outline: the metric reads brightness, and a black ring around white
    // glyphs on a black field only blurs the ink/white distinction the REQ
    // explicitly asks to keep separate (§3-1).
    outlineColorHex: '#000000', outlineThicknessPx: 0, outlineAlpha: 100,
    fadeDurationSec: 0,
    fontId: DEFAULT_FONT_ID,
    horizontalPosition: 'center',
    verticalPosition: 'center',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 60 },
    lineSpacingPercent: 0,
    rotation: 0,
    animationType: spec.anim,
    animationInEnabled: spec.inEnabled,
    animationOutEnabled: spec.outEnabled,
    animationDurationSec: spec.animDurationSec,
    animationStartScalePercent: 20,
    isDeleted: false,
    isEdited: false,
  }
  return { ...base, original: { ...base } } as unknown as SubtitleEntry
}

/* ------------------------------------------------------------------------- */
/* The case matrix                                                            */
/* ------------------------------------------------------------------------- */

const CUT_HEAD: Cut[] = [{ id: 'k0', startSec: 0, endSec: 3 }]
const CUT_TAIL: Cut[] = [{ id: 'k1', startSec: 5, endSec: 9 }]

/**
 * Head-cut geometry: cue [2,6] with a cut over [0,3) clamps to [3,6], which
 * `origToEdited` puts at [0,3]. So the entrance replays over EDITED [0,1] —
 * while the pre-fix preview, measuring from the raw start of 2 against a raw
 * clock, had already spent that entrance during frames the burn removed.
 *
 * Tail-cut geometry: cue [2,6] with a cut over [5,9) clamps to [2,5]; nothing
 * is removed before the cue, so edited == original there. The exit ramp lands
 * on EDITED [4,5] instead of the raw [5,6].
 */
export const CASES: Array<{ name: string; spec: CaseSpec }> = [
  {
    name: 'scale entrance, head cut',
    spec: {
      cueStart: 2, cueEnd: 6, cuts: CUT_HEAD, anim: 'scale', animDurationSec: 1,
      inEnabled: true, outEnabled: true,
      probes: [0.15, 0.35, 0.60, 2.0], settledIndex: 3, channel: 'size',
    },
  },
  {
    name: 'scale exit, tail cut',
    spec: {
      cueStart: 2, cueEnd: 6, cuts: CUT_TAIL, anim: 'scale', animDurationSec: 1,
      inEnabled: true, outEnabled: true,
      // Exit ramp is edited [4,5]; 3.0 is the settled plateau.
      probes: [4.25, 4.5, 4.75, 3.0], settledIndex: 3, channel: 'size',
    },
  },
  {
    // `pop` rises very fast and overshoots, so it is sampled EARLY: by 0.15 of
    // its ramp it is already at 0.93 of settled, which is inside the parity
    // tolerance and therefore cannot demonstrate anything.  Not EARLIER than
    // this, though — see the note on the zero-alpha floor below.
    name: 'pop entrance, head cut',
    spec: {
      cueStart: 2, cueEnd: 6, cuts: CUT_HEAD, anim: 'pop', animDurationSec: 1,
      inEnabled: true, outEnabled: true,
      probes: [0.08, 0.15, 0.30, 2.0], settledIndex: 3, channel: 'size',
    },
  },
  {
    name: 'fade entrance, head cut',
    spec: {
      cueStart: 2, cueEnd: 6, cuts: CUT_HEAD, anim: 'fade', animDurationSec: 1,
      inEnabled: true, outEnabled: true,
      probes: [0.15, 0.35, 0.60, 2.0], settledIndex: 3, channel: 'mass',
    },
  },
  {
    name: 'blur entrance, head cut',
    spec: {
      cueStart: 2, cueEnd: 6, cuts: CUT_HEAD, anim: 'blur', animDurationSec: 1,
      inEnabled: true, outEnabled: true,
      probes: [0.25, 0.35, 0.45, 2.0], settledIndex: 3, channel: 'ink',
    },
  },
  {
    /*
     * ★ BOTH SIDES (§3-1). The no-trim case must stay in parity too. Without
     * it a gate could go green by making the preview agree with the burn only
     * where cuts exist, having broken the case that is the overwhelming
     * majority of real projects.
     */
    name: 'scale entrance, NO CUTS (control)',
    spec: {
      cueStart: 2, cueEnd: 6, cuts: [], anim: 'scale', animDurationSec: 1,
      inEnabled: true, outEnabled: true,
      probes: [2.15, 2.35, 2.60, 4.0], settledIndex: 3, channel: 'size',
    },
  },
]

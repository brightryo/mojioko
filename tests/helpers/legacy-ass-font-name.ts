import { generateAss } from '../../src/main/services/ass-generator'
import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground } from '../../src/shared/types'
import { KARAOKE_STYLE_DEFAULT, type KaraokeStyle } from '../../src/shared/karaoke-style'

/**
 * REQ-0340 §3 — the `assFontName` argument every pre-existing ASS test relied
 * on being defaulted for it.
 *
 * `generateAss` used to default that argument to `'Noto Sans JP SemiBold'`.
 * No font this app stages is called that: every bundled and downloadable TTF
 * carries a NAMESPACED family (`'MOJIOKO Noto Sans JP SemiBold'`, …) so that
 * libass' DirectWrite provider cannot silently substitute a system-installed
 * font of the upstream name (REQ-0275).  A call that fell through to the
 * default therefore asked libass for a family that is not in the `fontsdir`,
 * and libass answered with ArialMT and no diagnostic — which is exactly what
 * the RES-0333 measurement harness spent a run doing.  So the default is gone
 * and the argument is required.
 *
 * The ASS unit tests are a different matter.  They are byte-identity pins on
 * output captured when that default was live (`ass-generator-baseline-ac1fd67`
 * literally asserts `Style: Default,Noto Sans JP SemiBold,…`).  Their subject
 * is tag composition, not font resolution, and rewriting 90-odd call sites to
 * spell the historical name would add noise to the diff without adding any
 * safety: the trap was only ever reachable from code that burns a real video,
 * and there are exactly two such call sites (`ffmpeg-burnin`, `frame-exporter`)
 * — both of which pass `getFontMeta(id).assFontName` and are now required to.
 *
 * So the tests import this shim under the name `generateAss`:
 *
 *   import { generateAssLegacyFont as generateAss } from '../helpers/legacy-ass-font-name'
 *
 * The alias is deliberately visible at the import line rather than hidden
 * inside the helper's own export name, so the substitution is stated once at
 * the top of every file that makes it.
 *
 * A test that cares which family is emitted must NOT go through here — pass
 * the name explicitly (this shim forwards an explicit `assFontName` unchanged,
 * as `ass-generator.test.ts` and `karaoke-timing-req-0336.test.ts` rely on).
 */
export const LEGACY_ASS_FONT_NAME = 'Noto Sans JP SemiBold'

/**
 * REQ-0344 §2-2 — `isMsix` and `karaokeStyle` lost their production defaults
 * too, for the reason spelled out on the parameters themselves: a default
 * cannot tell "the caller means this" from "the caller forgot", and only the
 * first is ever right in the burn path.
 *
 * They are re-stated HERE, in the test shim, rather than left to the
 * production signature.  That is the correct home for them now: this file's
 * whole job is to reproduce the pre-REQ-0340 call shape for suites that are
 * byte-identity pins on output captured back then.  The earlier note here said
 * a second copy of a default is a second thing to drift — true, and the answer
 * is that there is no longer a first copy to drift from.
 *
 * Both values reproduce the old behaviour exactly: `isMsix: false` gates
 * karaoke off entirely, so `karaokeStyle` cannot reach the output of any suite
 * that does not opt in by passing `isMsix: true` explicitly.
 */
export const LEGACY_IS_MSIX = false
export const LEGACY_KARAOKE_STYLE: KaraokeStyle = KARAOKE_STYLE_DEFAULT

export function generateAssLegacyFont(
  entries: SubtitleEntry[],
  video: VideoInfo,
  burnin: BurninPosition,
  subtitleBackground?: SubtitleBackground,
  assFontName: string = LEGACY_ASS_FONT_NAME,
  isMsix: boolean = LEGACY_IS_MSIX,
  karaokeStyle: KaraokeStyle = LEGACY_KARAOKE_STYLE,
): string {
  return generateAss(entries, video, burnin, subtitleBackground, assFontName, isMsix, karaokeStyle)
}

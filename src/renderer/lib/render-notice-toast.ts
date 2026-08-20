import type { TFunction } from 'i18next'
import { toast } from './toast'
import { fontSubstitutionDetail, type RenderNotice } from '../../shared/render-notice'
import { useStoreUpsellStore } from '../stores/store-upsell-store'
import { useUiStore } from '../stores/ui-store'

/**
 * REQ-0510 / REQ-0517 §2 — tell the user, once per finished render, about the
 * things the render decided that they cannot see by looking at their project.
 *
 * ## Why the GUI needs this at all
 *
 * The row label and the inspector keep showing what the user CHOSE (owner's
 * decision: they display the stored setting, which is correct).  So the main
 * process could substitute a font, or scale a cue in a way the export cannot
 * reproduce, and say nothing — the user would first learn of it by watching
 * the burned video.  The CLI and MCP have returned these as `warnings[]` since
 * REQ-0502 / REQ-0508; this is the same information, delivered the way a GUI
 * delivers things.
 *
 * ## Why it takes notices rather than deciding for itself
 *
 * The notices arrive from the main process, built by the same functions that
 * produced the render.  A renderer-side re-derivation would be a second
 * implementation of the same judgement, which is the drift this project has
 * paid for repeatedly.  This function only chooses words and an action.
 *
 * ## ★ Why there is an allowlist (REQ-0517 §2-4)
 *
 * REQ-0517 widened the TRANSPORT to carry every `RenderNotice` the render
 * produced, which is right — one warning, written once, reaching both
 * surfaces.  It did NOT widen what gets shown.  A toast per notice would put
 * `BACKGROUND_BOX_NOT_DRAWN` and friends in front of a user who is watching a
 * video finish, and "a warning that always fires is not read" is the bar
 * REQ-0502 set when these were designed.
 *
 * So the presentation rule is separate from the wire rule and lives here, as
 * an explicit list.  A code that is not in it is carried, logged by the
 * headless surfaces, and simply not toasted.
 *
 * ## Where it is NOT called
 *
 * The live preview.  It re-renders on every edit and every frame, and a toast
 * per frame is a toast nobody reads.  Only the two points where a FILE is
 * produced call it: burn-in completion and image export.  Pinned by
 * `ALLOWED_CALLERS` in `tests/unit/render-notice-toast-req-0510.test.ts`.
 */

/**
 * The codes the GUI toasts, and why each earns the interruption.
 *
 * Everything else the render can produce is deliberately absent — see
 * `NOT_TOASTED` below for the list and the reasoning, which is recorded so the
 * next person does not have to re-derive it (or quietly add all of them).
 */
export const TOASTED_CODES = [
  'FONT_TIER_SUBSTITUTED',
  'FONT_UNAVAILABLE',
  'SCALE_ANIM_LINE_PITCH_FIXED',
] as const

/**
 * Codes carried over the wire but NOT toasted, with the reason.  Kept as data
 * rather than prose so a test can assert the two lists together cover every
 * code the app can emit — a new warning then has to be classified rather than
 * silently defaulting to invisible.
 */
export const NOT_TOASTED: Record<string, string> = {
  // REQ-0502 no-op combinations: all of them are things the user set in the
  // inspector and can see there.  The render is not doing anything surprising
  // — the setting simply has no effect — so the place to surface it is the
  // inspector, not a toast after the export.
  BACKGROUND_BOX_NOT_DRAWN: 'the outline slider is right there in the inspector',
  BACKGROUND_BOX_INVISIBLE: 'same — an opacity the user set, visible where they set it',
  SHADOW_SUPPRESSED_BY_BACKGROUND: 'same — both switches are adjacent in the inspector',
  EMPHASIS_NO_SPANS: 'same — the emphasis editor shows there are no spans',
  // Flag-keyed: unreachable from the GUI, which passes no CLI flags.
  OUTLINE_OVERRIDDEN_BY_BACKGROUND: 'CLI-flag-derived; the GUI cannot produce it',
  EMPHASIS_FLAGS_WITHOUT_EMPHASIS: 'CLI-flag-derived; the GUI cannot produce it',
  KARAOKE_FLAGS_WITHOUT_KARAOKE: 'CLI-flag-derived; the GUI cannot produce it',
  BACKGROUND_FLAGS_WITHOUT_BACKGROUND: 'CLI-flag-derived; the GUI cannot produce it',
  MARGIN_V_IGNORED: 'CLI-flag-derived; the GUI cannot produce it',
  PRESET_CLEARED_POSITION: 'CLI-flag-derived (--preset); the GUI applies presets with its own UI',
  AUDIO_TRACK_FALLBACK: 'REQ-0517 §1 — the GUI already rounds at load time and shows the picked track in STEP 1',
  // Reported through their own, richer surfaces.
  GPU_INIT_FAILED: 'the device chip in STEP 1 already shows CPU/GPU',
  SUBTITLE_OVERFLOW: 'the overflow badge marks the exact rows in STEP 2',
  // REQ-0529 §2-2 — withheld for BOTH available reasons, which is unusual
  // enough to spell out.  (a) The 時間超過 badge already marks the exact rows
  // in STEP 2, same as SUBTITLE_OVERFLOW above.  (b) It is structurally
  // unreachable here anyway: `burnin-drawer` filters these cues out with
  // `isBurninTarget` before the request is built, so a GUI burn never contains
  // one to warn about — the warning exists for the CLI/MCP, which apply no such
  // filter.  If (b) ever changes (i.e. the GUI stops dropping them), revisit —
  // (a) alone still argues for silence, but the reasoning would be weaker.
  CUE_BEYOND_VIDEO_END: 'REQ-0529 — the 時間超過 badge marks the rows, and the GUI drops these cues before the burn',
  UNKNOWN_OPTION: 'CLI dispatcher-level; unreachable from the GUI',
  STALE_MCP_BUNDLE: 'surfaced in the settings AI tab, where the fix is',
}

/** Is this code one the GUI shows? */
function isToasted(code: string): boolean {
  return (TOASTED_CODES as readonly string[]).includes(code)
}

export function showRenderNoticeToasts(
  notices: readonly RenderNotice[] | undefined,
  t: TFunction,
): void {
  if (!notices || notices.length === 0) return

  for (const notice of notices) {
    // ★ REQ-0517 §2-5 — an unknown or non-allowlisted code is carried but not
    // shown.  Never fall through to printing `notice.code` or a raw i18n key:
    // the user would get `SCALE_ANIM_LINE_PITCH_FIXED` in a dialog, which is
    // the failure REQ-0510's i18n-resolution test exists to prevent.
    if (!isToasted(notice.code)) continue

    if (notice.code === 'SCALE_ANIM_LINE_PITCH_FIXED') {
      // REQ-0516 §3 / REQ-0517 §2-3 — the burn scales each line about its own
      // anchor, so the distance BETWEEN lines does not scale while the preview
      // scales the whole block.  The user has just watched the preview, so the
      // message has to say that the two differ, not merely that something is off.
      const cueCount = readCueCount(notice)
      toast.warning(t('common:renderNotice.linePitch.title'), {
        description: t('common:renderNotice.linePitch.detail', { count: cueCount }),
      })
      continue
    }

    // Font substitution — REQ-0510's wording and actions, unchanged (§2-2).
    const detail = fontSubstitutionDetail(notice)
    if (detail === null) continue
    // "Anton → Noto Sans JP Regular" — display names, because that is what the
    // inspector shows the user.  The font ID appears in the CLI remedy instead,
    // where it is a command argument rather than a label.
    const pairs = detail.substitutions.map((s) => `${s.fromName} → ${s.toName}`).join(' / ')
    // Namespace-qualified because the two call sites bind different default
    // namespaces (`step3` for the burn drawer, `step2` for the export button)
    // and every namespace is bundled at init — so one key works from both.
    const description = t('common:fontSubstitution.detail', {
      pairs,
      count: detail.substitutedCueCount,
    })

    if (notice.code === 'FONT_TIER_SUBSTITUTED') {
      // §2-3 — the two causes must not be confusable: this one is fixed by
      // buying, the other by downloading.  Sending a user to the Store for a
      // missing file would sell them something that does not fix it.
      toast.warning(t('common:fontSubstitution.tier.title'), {
        description,
        action: {
          label: t('common:fontSubstitution.tier.action'),
          onClick: () => useStoreUpsellStore.getState().openUpsell(),
        },
      })
    } else {
      toast.warning(t('common:fontSubstitution.missing.title'), {
        description,
        action: {
          label: t('common:fontSubstitution.missing.action'),
          // REQ-0510 §2-4 — Settings, opened ON the Fonts tab: the download
          // button lives there, and dropping the user on the General tab makes
          // them hunt for the fix they were just promised.
          onClick: () => useUiStore.getState().openSettingsDialogAt('fonts'),
        },
      })
    }
  }
}

/** `detail.cueCount` when the emitter provided one, else 0. */
function readCueCount(notice: RenderNotice): number {
  const d = notice.detail
  if (typeof d !== 'object' || d === null) return 0
  const n = (d as Record<string, unknown>).cueCount
  return typeof n === 'number' ? n : 0
}

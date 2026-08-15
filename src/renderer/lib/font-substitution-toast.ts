import type { TFunction } from 'i18next'
import { toast } from './toast'
import { getFontMeta } from '../../shared/fonts'
import type { FontSubstitutionNotice } from '../../shared/font-tier'
import { useStoreUpsellStore } from '../stores/store-upsell-store'
import { useUiStore } from '../stores/ui-store'

/**
 * REQ-0510 — tell the user, once per finished render, that a font they asked
 * for was replaced.
 *
 * ## Why the GUI needs this at all
 *
 * The row label and the inspector keep showing the ORIGINAL font (owner's
 * decision: they display the stored setting, which is correct). So after
 * REQ-0508 / REQ-0509 the GUI could substitute at render time and say nothing —
 * the user would first learn of it by looking at the burned video. The CLI and
 * MCP have returned `FONT_TIER_SUBSTITUTED` / `FONT_UNAVAILABLE` since those
 * REQs; this is the same information, delivered the way a GUI delivers things.
 *
 * ## Why it takes notices rather than deciding for itself
 *
 * The notices arrive from the main process, built by the same
 * `applyFontPolicy` + `groupFontSubstitutions` that produced the render. A
 * renderer-side re-derivation would be a second implementation of the same
 * judgement, which is the drift this project has paid for repeatedly. This
 * function only chooses words and an action.
 *
 * ## Where it is NOT called
 *
 * The live preview. It re-renders on every edit and every frame, and a toast
 * per frame is a toast nobody reads — the same bar REQ-0502 set for warnings.
 * Only the two points where a FILE is produced call it: burn-in completion and
 * image export.
 */
export function showFontSubstitutionToasts(
  notices: readonly FontSubstitutionNotice[] | undefined,
  t: TFunction,
): void {
  if (!notices || notices.length === 0) return

  for (const notice of notices) {
    // "Anton → Noto Sans JP Regular" — display names, because that is what the
    // inspector shows the user. The font ID appears in the CLI remedy instead,
    // where it is a command argument rather than a label.
    const pairs = notice.substitutions
      .map((s) => `${getFontMeta(s.from).displayName} → ${getFontMeta(s.to).displayName}`)
      .join(' / ')
    // Namespace-qualified because the two call sites bind different default
    // namespaces (`step3` for the burn drawer, `step2` for the export button)
    // and every namespace is bundled at init — so one key works from both.
    const description = t('common:fontSubstitution.detail', { pairs, count: notice.cueCount })

    if (notice.code === 'FONT_TIER_SUBSTITUTED') {
      // §2-3 — the two causes must not be confusable: this one is fixed by
      // buying, the other by downloading. Sending a user to the Store for a
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

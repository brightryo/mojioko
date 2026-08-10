/**
 * REQ-0464 — pure helpers extracted from the bulk-edit bar so the Undo /
 * controlled-Switch behaviour can be unit-tested without a React DOM harness
 * (the codebase convention — see `bulk-rotation-draft.test.ts`).
 */
import type { SubtitleEntry } from '../../shared/types'

/**
 * Build the per-row `preBeforeSnapshots` for a colour-PAIR bulk edit.
 *
 * The pair click writes BOTH `textColorHex` and `outlineColorHex`.  When the
 * user dragged the saturation picker before clicking a suggested pair, the
 * preview stream already moved the store to the after-value, so `applyBulk`'s
 * own snapshot would capture the preview colour and Undo would restore THAT
 * instead of the pre-drag colour.  The individual colour pickers avoid this by
 * passing their per-row "before" map; the pair path must do the same for both
 * halves at once.
 *
 * Returns `undefined` when no preview happened (both maps null), so `applyBulk`
 * falls back to its own snapshot — which is already correct in that case.
 */
export function buildColorPairPreSnapshots(
  ids: Iterable<string>,
  textBefore: ReadonlyMap<string, string> | null,
  outlineBefore: ReadonlyMap<string, string> | null,
): Map<string, Partial<SubtitleEntry>> | undefined {
  if (!textBefore && !outlineBefore) return undefined
  const out = new Map<string, Partial<SubtitleEntry>>()
  for (const id of ids) {
    const patch: Partial<SubtitleEntry> = {}
    if (textBefore?.has(id)) patch.textColorHex = textBefore.get(id)
    if (outlineBefore?.has(id)) patch.outlineColorHex = outlineBefore.get(id)
    if (Object.keys(patch).length > 0) out.set(id, patch)
  }
  return out.size > 0 ? out : undefined
}

/** The boolean toggle state a bulk Switch should show for the current selection. */
export interface SelectedToggles {
  karaokeEnabled: boolean
  karaokeUseWordTimings: boolean
  casingUppercase: boolean
}

/**
 * Seed the bulk-edit toggle Switches (karaoke / 発話タイミング / casing) from the
 * FIRST selected row — the same "first selected row" convention the background
 * drafts use (`pickFirstSelectedLayout`).  Without this the Switches were
 * uncontrolled and always rendered OFF, never reflecting the selection's actual
 * state.  Returns `null` for an empty selection so the caller keeps its default.
 */
export function pickFirstSelectedToggles(
  selectedIds: ReadonlySet<string>,
  entries: readonly SubtitleEntry[],
): SelectedToggles | null {
  if (selectedIds.size === 0) return null
  for (const e of entries) {
    if (selectedIds.has(e.id)) {
      return {
        karaokeEnabled: e.karaokeEnabled === true,
        karaokeUseWordTimings: e.karaokeUseWordTimings === true,
        casingUppercase: e.casing === 'uppercase',
      }
    }
  }
  return null
}

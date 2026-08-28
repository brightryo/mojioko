/**
 * REQ-0555 §2 — the pure core of the three structural cue operations.
 *
 * ## Why this file exists
 *
 * "Add a row", "duplicate a row" and "reset a row" were each written once, in
 * the GUI, tangled with the things only the GUI needs: history entries, toasts,
 * selection, scroll-into-view. `add_cue` / `duplicate_cue` / `reset_cue` have to
 * mean *exactly* the same thing headlessly — REQ-0555 §2-4 — and the way to
 * guarantee that is not to write them a second time carefully. It is to have
 * one copy and let both callers reach it.
 *
 * So the decision each operation actually makes — WHERE a new cue lands, WHAT
 * fields it starts with, WHAT "reset" restores — moved here unchanged, and the
 * GUI now calls these too. If this file is wrong, it is wrong in both places at
 * once, which is the property we want: a divergence cannot hide.
 *
 * `buildDuplicateEntry` (REQ-0322) was already pure and already the single
 * source for duplication, so it stays where it is and both callers use it.
 *
 * ## Layering
 *
 * This is renderer/lib but the CLI imports it, following the path
 * `main/cli/subtitle-io.ts` already takes to `style-defaults-to-entry.ts`.
 * These modules are pure cue logic with no store, DOM or React dependency —
 * they are shared domain code that happens to live under `renderer/`. Moving
 * the whole family to `src/shared/` is worth doing, but as its own change:
 * see RES-0555 §9.
 */

import { animationFieldsForNewCue } from '../../shared/cue-animation'
import { makeEntryLayoutDefaults } from '../../shared/burnin-defaults'
import type { AnimationMemory } from '../../shared/cue-animation'
import type { SubtitleEntry, TranscriptionDefaults } from '../../shared/types'
import { styleFieldsFromDefaults } from './style-defaults-to-entry'

/** Where a new cue goes, in both the array's terms and the user's. */
export interface AddInsertion {
  /** Index into the FULL entries array (deleted rows included) — what `addEntry` wants. */
  fullIdx: number
  /** 1-indexed position the user will SEE in the table — for the toast. */
  visiblePos: number
}

/**
 * Decide where a cue starting at `newStartSec` belongs.
 *
 * Moved verbatim from `step2.tsx` (REQ-0555 §2). Deleted rows are skipped while
 * searching but keep their positions in the full array, which is why the two
 * numbers differ and why both are returned.
 */
export function computeAddInsertion(
  entries: readonly SubtitleEntry[],
  newStartSec: number,
): AddInsertion {
  const active = entries.filter((e) => !e.isDeleted)
  const afterActiveIdx = active.findIndex((e) => e.startSec > newStartSec)

  if (afterActiveIdx === -1) {
    // No active row has a later startSec — append AFTER the last active row.
    if (active.length === 0) {
      return { fullIdx: entries.length, visiblePos: 1 }
    }
    const lastActiveId = active[active.length - 1].id
    const lastActiveFullIdx = entries.findIndex((e) => e.id === lastActiveId)
    return { fullIdx: lastActiveFullIdx + 1, visiblePos: active.length + 1 }
  }

  // Place BEFORE the first active row whose startSec exceeds the new value.
  const pivotFullIdx = entries.findIndex((e) => e.id === active[afterActiveIdx].id)
  return { fullIdx: pivotFullIdx, visiblePos: afterActiveIdx + 1 }
}

/** Everything a new cue's fields are derived from. */
export interface NewCueSeed {
  startSec: number
  endSec: number
  text?: string
  /** The app-level fade default (`settings.fadeDurationSec`). */
  fadeDurationSec: number
  defaults: TranscriptionDefaults
  /** REQ-0540 — last-used animation parameters per type, if any. */
  animationMemory?: AnimationMemory
  videoWidthPx?: number
  videoHeightPx?: number
  /**
   * Injected so the caller owns id minting. The GUI passes a `crypto.randomUUID`
   * based id; the CLI passes its own. Kept out of this function so it stays
   * pure and a test can pin the id.
   */
  id: string
}

/**
 * Build a brand-new cue exactly as the GUI's 「+ 行を追加」 does.
 *
 * The field list is deliberately NOT written out here: it comes from
 * `styleFieldsFromDefaults`, the exhaustively-typed projection that STEP 1 also
 * seeds transcribed rows with. REQ-0335 §2 records what happened when this was
 * a hand-written list of four fields — an added row lost shadow, casing,
 * rotation, line spacing, opacity, emphasis and karaoke, and looked different
 * from a transcribed row under the very same settings.
 */
export function buildNewCue(seed: NewCueSeed): SubtitleEntry {
  const base = {
    startSec: seed.startSec,
    endSec: seed.endSec,
    text: seed.text ?? '',
    fadeDurationSec: seed.fadeDurationSec,
    ...animationFieldsForNewCue(seed.defaults, seed.animationMemory),
    // REQ-20260613-016 / v1.2.2 機能A: seed per-row layout + background
    // defaults at creation time.
    ...makeEntryLayoutDefaults(),
    ...styleFieldsFromDefaults(seed.defaults, {
      videoWidthPx: seed.videoWidthPx,
      videoHeightPx: seed.videoHeightPx,
    }),
  }
  return {
    id: seed.id,
    ...base,
    isDeleted: false,
    isEdited: true,
    // Deep-copy subtitleBackground so the live entry and original snapshot do
    // not share object identity.
    original: { ...base, subtitleBackground: { ...base.subtitleBackground } },
  } as SubtitleEntry
}

/**
 * What 「行のリセット」 restores: `original`, plus the optional fields a bare
 * spread would silently leave alone.
 *
 * Moved verbatim from `resetRow` (REQ-0555 §2). The explicit `fontId` / `posX` /
 * `posY` / `layer` lines are load-bearing and each was its own bug: rows created
 * through `makeEntryLayoutDefaults()` have no such keys in `original`, so
 * `{ ...entry, ...original }` keeps the LIVE value and Reset would leave the row
 * pinned, or on the wrong z-order, or in the wrong font (REQ-022 step 7,
 * REQ-20260615-018 B, REQ-0392).
 */
export function buildResetPatch(entry: SubtitleEntry): Partial<SubtitleEntry> {
  const { original } = entry
  return {
    ...original,
    fontId: original.fontId,
    posX: original.posX,
    posY: original.posY,
    layer: original.layer,
    // REQ-20260613-016: deep-copy so later edits to the live entry's background
    // don't retroactively mutate the reset target.
    subtitleBackground: { ...original.subtitleBackground },
    isEdited: false,
    isDeleted: false,
  } as Partial<SubtitleEntry>
}

/**
 * Whether `reset_cue` would actually restore anything.
 *
 * A cue whose `original` is missing has nothing to go back to; REQ-0555 §2-3
 * says that is a warning and a no-change, not an error.
 */
export function hasResetTarget(entry: SubtitleEntry): boolean {
  return entry.original !== null && typeof entry.original === 'object'
}

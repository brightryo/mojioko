import { describe, it, expect } from 'vitest'
import { selectBatchDownloadTargets } from '../../src/renderer/lib/batch-font-download'
import { FONT_REGISTRY, type FontId, type FontsState, type FontStatus } from '../../src/shared/fonts'

/**
 * REQ-0161 — pin the eligibility rules that decide which fonts get
 * pulled into a "download all" batch.  Batch runs from the FontPicker
 * header button; the pure selector is the single source of truth for
 * both the target set and the button's visibility (empty result →
 * button hides).
 */

function makeState(overrides: Partial<Record<FontId, FontStatus>>): FontsState {
  return {
    fonts: FONT_REGISTRY.map((meta) => ({
      id: meta.id,
      displayName: meta.displayName,
      status: overrides[meta.id] ?? (meta.bundled ? 'bundled' : 'not-installed'),
    })),
    activeFontId: 'noto-sans-jp-semibold',
  }
}

// Every non-default font declared in the registry — the maximum
// possible batch size on a fresh install where nothing else is on disk.
// Recomputed from the registry so a REQ that adds/removes a font
// doesn't require a hand-updated constant here.
const ALL_DOWNLOADABLE = FONT_REGISTRY.filter((m) => !m.bundled).map((m) => m.id)

describe('selectBatchDownloadTargets — REQ-0161 batch DL eligibility', () => {
  it('MSIX + everything not-installed → returns every non-default font', () => {
    const state = makeState({})
    const targets = selectBatchDownloadTargets(state, true)
    expect(targets.map((m) => m.id).sort()).toEqual(ALL_DOWNLOADABLE.slice().sort())
  })

  it('MSIX + some fonts already installed → returns only the not-installed ones', () => {
    // Simulate the mid-completion state a user might see after
    // downloading two fonts individually before hitting Batch DL —
    // the button must skip them.
    const state = makeState({
      'anton': 'installed',
      'bebas-neue': 'installed',
    })
    const targets = selectBatchDownloadTargets(state, true)
    const ids = targets.map((m) => m.id)
    expect(ids).not.toContain('anton')
    expect(ids).not.toContain('bebas-neue')
    expect(ids).toContain('montserrat')
    expect(ids).toContain('poppins')
    expect(ids.length).toBe(ALL_DOWNLOADABLE.length - 2)
  })

  it('MSIX + all fonts installed → returns empty list (button will hide)', () => {
    // Every downloadable font declared installed → nothing to do →
    // FontPicker uses this to remove the batch button entirely.
    const allInstalled: Partial<Record<FontId, FontStatus>> = {}
    for (const m of FONT_REGISTRY) {
      if (!m.bundled) allInstalled[m.id] = 'installed'
    }
    const state = makeState(allInstalled)
    const targets = selectBatchDownloadTargets(state, true)
    expect(targets).toEqual([])
  })

  it('NSIS (free tier) → returns empty list regardless of state', () => {
    // Free tier can't download any non-default font — batch button
    // must never render, and this selector proves it.
    const state = makeState({})
    const targets = selectBatchDownloadTargets(state, false)
    expect(targets).toEqual([])
  })

  it('never includes the bundled default font (Noto Sans JP)', () => {
    // Even if the state map somehow labels Noto as `not-installed`
    // (defensive against a stale IPC payload), the selector must
    // still skip it — the bundled default cannot be downloaded.
    const state = makeState({ 'noto-sans-jp-semibold': 'not-installed' })
    const targets = selectBatchDownloadTargets(state, true)
    expect(targets.map((m) => m.id)).not.toContain('noto-sans-jp-semibold')
  })

  it('null state (initial mount pre-IPC) → returns every eligible font', () => {
    // Before the first `listFonts()` IPC resolves, `state` is null.
    // The selector treats every non-default font as `not-installed`
    // in that window so the batch button appears immediately when
    // the paid tier is detected — not after two async resolutions.
    const targets = selectBatchDownloadTargets(null, true)
    expect(targets.map((m) => m.id).sort()).toEqual(ALL_DOWNLOADABLE.slice().sort())
  })

  it('preserves alphabetical order (matches the picker list)', () => {
    // Batch progress marker moves down the visible list; if this
    // ordering ever regresses the batch marker would jump around.
    const targets = selectBatchDownloadTargets(makeState({}), true)
    const displayNames = targets.map((m) => m.displayName)
    const sorted = displayNames.slice().sort((a, b) =>
      a.localeCompare(b, 'en', { sensitivity: 'base' }),
    )
    expect(displayNames).toEqual(sorted)
  })

  it('mixed tier: NSIS + partial install → still empty (tier gate wins)', () => {
    // A user who downloaded some fonts on MSIX and then somehow ended
    // up on NSIS (downgrade, machine swap) must NOT see a batch DL
    // offering — the free tier blocks it regardless of on-disk state.
    const state = makeState({ 'anton': 'installed', 'montserrat': 'installed' })
    const targets = selectBatchDownloadTargets(state, false)
    expect(targets).toEqual([])
  })
})

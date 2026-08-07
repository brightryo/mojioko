/**
 * REQ-0457 D12 — apply a user-saved subtitle style preset (REQ-0335) in the
 * headless burn/run path, so "author a preset in the GUI, mass-produce from the
 * CLI" works.  Reuses `resolveStylePresetPatch` (the same apply the GUI uses),
 * so a preset lands identically.
 */
import { resolveStylePresetPatch } from '../../renderer/lib/style-preset-apply'
import type { StylePreset } from '../../shared/style-preset'
import type { SubtitleEntry } from '../../shared/types'

/** Resolve a preset by exact name (case-insensitive) or id. */
export function findStylePreset(presets: readonly StylePreset[], nameOrId: string): StylePreset | undefined {
  const key = nameOrId.trim().toLowerCase()
  return presets.find((p) => p.id === nameOrId || p.name.trim().toLowerCase() === key)
}

/**
 * Apply a preset's style patch to every non-deleted cue.  `geometry` is the
 * SOURCE video's size (entries are in source-pixel space before any resolution
 * scaling), so the preset's stored offset resolves to the right `\pos`.
 */
export function applyStylePreset(
  entries: SubtitleEntry[],
  preset: StylePreset,
  geometry: { videoWidthPx: number; videoHeightPx: number },
): SubtitleEntry[] {
  const patch = resolveStylePresetPatch(preset, geometry)
  return entries.map((e) => (e.isDeleted ? e : { ...e, ...patch }))
}

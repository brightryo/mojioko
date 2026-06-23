import { describe, it, expect } from 'vitest'
import { migrateDeprecatedModelIds } from '../../src/main/services/migrate-model-settings'
import type { AppSettings } from '../../src/shared/types'

/**
 * REQ-20260615-065 S-4 — pre-v1.3.0 IDs `'small'` / `'medium'` were
 * dropped from the model line-up.  The settings-store hydrate pass
 * rewrites them to the new default `'large-v3-turbo'` so a returning
 * user does not land on a phantom selection.  Coverage targets:
 *
 *  - small  / medium → large-v3-turbo  (the core migration)
 *  - large-v3        → unchanged       (kept across the split)
 *  - large-v3-turbo  → unchanged       (already on the new default)
 *  - null            → unchanged       (=fresh / never-picked state)
 *  - unknown string  → null            (=ID nobody ever shipped)
 *  - whisperModel split: activeModelId vs transcriptionDefaults.whisperModel
 *    migrate independently — neither side leaks into the other.
 *  - immutability   : no mutation of the input object when the values
 *    are already current (caller compares by reference to decide
 *    whether to persist).
 */

function makeSettings(overrides: Partial<AppSettings>): AppSettings {
  // Minimal shape — only the fields the migration reads.  Spread the
  // overrides last so test-specific values win.
  const base: AppSettings = {
    version: 1,
    language: 'ja',
    theme: 'dark',
    baseColor: 'neutral',
    transcriptionDefaults: {
      fontSizePx: 100,
      textColorHex: '#FFFFFF',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      whisperModel: 'large-v3-turbo',
    },
    transcriptionAdvanced: {
      vadFilter: true,
      vadThreshold: 0.5,
      minSpeechDurationMs: 250,
      minSilenceDurationMs: 2000,
      beamSize: 5,
      language: 'auto',
    },
    autoLineBreak: true,
    burnin: {
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
      verticalMarginPx: 40,
    },
    encoder: 'auto',
    audioMode: 'simple',
    defaultAudioTrackIndex: 2,
    fadeDurationSec: 0,
    subtitleBackground: {
      enabled: false,
      color: 'black',
      opacityPercent: 50,
    },
    activeModelId: null,
    lastInputDir: null,
    lastOutputDir: null,
  }
  return {
    ...base,
    ...overrides,
    transcriptionDefaults: {
      ...base.transcriptionDefaults,
      ...(overrides.transcriptionDefaults ?? {}),
    },
  }
}

describe('REQ-065 S-4 — migrateDeprecatedModelIds (activeModelId)', () => {
  it('rewrites "small" to "large-v3-turbo"', () => {
    const before = makeSettings({ activeModelId: 'small' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3-turbo')
  })

  it('rewrites "medium" to "large-v3-turbo"', () => {
    const before = makeSettings({ activeModelId: 'medium' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3-turbo')
  })

  it('passes "large-v3" through unchanged', () => {
    const before = makeSettings({ activeModelId: 'large-v3' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3')
  })

  it('passes "large-v3-turbo" through unchanged', () => {
    const before = makeSettings({ activeModelId: 'large-v3-turbo' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3-turbo')
  })

  it('passes null through unchanged (=fresh install / never-picked)', () => {
    const before = makeSettings({ activeModelId: null })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBeNull()
  })

  it('resets an unknown ID to null (=hand-edited or future-write-from-old-version)', () => {
    const before = makeSettings({ activeModelId: 'tinkertoy-99' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBeNull()
  })
})

describe('REQ-065 S-4 — migrateDeprecatedModelIds (transcriptionDefaults.whisperModel)', () => {
  it('rewrites "small" to "large-v3-turbo"', () => {
    const before = makeSettings({
      transcriptionDefaults: { whisperModel: 'small' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3-turbo')
  })

  it('rewrites "medium" to "large-v3-turbo"', () => {
    const before = makeSettings({
      transcriptionDefaults: { whisperModel: 'medium' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3-turbo')
  })

  it('passes "large-v3" through unchanged', () => {
    const before = makeSettings({
      transcriptionDefaults: { whisperModel: 'large-v3' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3')
  })
})

describe('REQ-065 S-4 — migrateDeprecatedModelIds immutability contract', () => {
  it('returns the SAME reference when no migration is needed (caller uses === to decide whether to persist)', () => {
    const before = makeSettings({ activeModelId: 'large-v3-turbo' })
    const after = migrateDeprecatedModelIds(before)
    expect(after).toBe(before)
  })

  it('returns a NEW object when any field migrates (so the caller can persist without aliasing)', () => {
    const before = makeSettings({ activeModelId: 'small' })
    const after = migrateDeprecatedModelIds(before)
    expect(after).not.toBe(before)
    expect(after.transcriptionDefaults).not.toBe(before.transcriptionDefaults)
  })

  it('migrates activeModelId and whisperModel independently when both are deprecated', () => {
    const before = makeSettings({
      activeModelId: 'small',
      transcriptionDefaults: { whisperModel: 'medium' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3-turbo')
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3-turbo')
  })
})

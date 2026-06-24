import { describe, it, expect } from 'vitest'
import { migrateDeprecatedModelIds } from '../../src/main/services/migrate-model-settings'
import type { AppSettings } from '../../src/shared/types'

/**
 * REQ-20260615-065 S-4 + REQ-20260615-066 — pre-v1.3.0 IDs
 * `'small'` / `'medium'` were dropped from the model line-up.  The
 * settings-store hydrate pass rewrites them to **`'large-v3'`** so
 * a returning user does not land on a phantom selection.
 *
 * REQ-066 reversed the REQ-065 choice of `'large-v3-turbo'` as the
 * migration target — real-world Japanese transcription on turbo
 * produced more spurious / wrong-character errors than the Phase-0
 * benchmark suggested, so the recommendation (and therefore the
 * migration target) moves back to `'large-v3'`.  turbo stays in
 * the line-up as a selectable fast-path; users who had already
 * actively picked it before this REQ keep their selection.
 *
 * Coverage targets:
 *  - small  / medium → large-v3   (the core migration, REQ-066 target)
 *  - large-v3        → unchanged  (already on the new default)
 *  - large-v3-turbo  → unchanged  (user actively chose turbo —
 *                                  must NOT be flipped to large-v3)
 *  - null            → unchanged  (=fresh / never-picked state)
 *  - unknown string  → null       (=ID nobody ever shipped)
 *  - activeModelId vs transcriptionDefaults.whisperModel migrate
 *    independently — neither side leaks into the other.
 *  - immutability   : no mutation of the input object when the
 *    values are already current (caller compares by reference to
 *    decide whether to persist).
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
      whisperModel: 'large-v3',
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

describe('REQ-065 S-4 + REQ-066 — migrateDeprecatedModelIds (activeModelId)', () => {
  it('rewrites "small" to "large-v3" (REQ-066 target)', () => {
    const before = makeSettings({ activeModelId: 'small' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3')
  })

  it('rewrites "medium" to "large-v3" (REQ-066 target)', () => {
    const before = makeSettings({ activeModelId: 'medium' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3')
  })

  it('passes "large-v3" through unchanged', () => {
    const before = makeSettings({ activeModelId: 'large-v3' })
    const after = migrateDeprecatedModelIds(before)
    expect(after.activeModelId).toBe('large-v3')
  })

  it('passes "large-v3-turbo" through unchanged (REQ-066: user actively chose turbo — do NOT flip)', () => {
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

describe('REQ-065 S-4 + REQ-066 — migrateDeprecatedModelIds (transcriptionDefaults.whisperModel)', () => {
  it('rewrites "small" to "large-v3"', () => {
    const before = makeSettings({
      transcriptionDefaults: { whisperModel: 'small' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3')
  })

  it('rewrites "medium" to "large-v3"', () => {
    const before = makeSettings({
      transcriptionDefaults: { whisperModel: 'medium' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3')
  })

  it('passes "large-v3" through unchanged', () => {
    const before = makeSettings({
      transcriptionDefaults: { whisperModel: 'large-v3' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3')
  })

  it('passes "large-v3-turbo" through unchanged (turbo default preserved if user persisted it)', () => {
    const before = makeSettings({
      transcriptionDefaults: { whisperModel: 'large-v3-turbo' },
    } as Partial<AppSettings>)
    const after = migrateDeprecatedModelIds(before)
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3-turbo')
  })
})

describe('REQ-065 S-4 + REQ-066 — migrateDeprecatedModelIds immutability contract', () => {
  it('returns the SAME reference when no migration is needed (caller uses === to decide whether to persist)', () => {
    const before = makeSettings({ activeModelId: 'large-v3' })
    const after = migrateDeprecatedModelIds(before)
    expect(after).toBe(before)
  })

  it('returns the SAME reference when activeModelId is "large-v3-turbo" and whisperModel is current (turbo user must not get a spurious save)', () => {
    const before = makeSettings({
      activeModelId: 'large-v3-turbo',
      transcriptionDefaults: { whisperModel: 'large-v3-turbo' },
    } as Partial<AppSettings>)
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
    expect(after.activeModelId).toBe('large-v3')
    expect(after.transcriptionDefaults.whisperModel).toBe('large-v3')
  })
})

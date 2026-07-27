/**
 * REQ-0312 §1 — the settings merge is now driven by an exhaustive rule table.
 *
 * The real guard is the TYPE: `SETTINGS_MERGE_RULES` is declared as
 * `{ [K in keyof AppSettings]-?: MergeRule }`, so adding a field to
 * `AppSettings` without adding a rule fails `tsc`.  Verified by temporarily
 * adding a probe field — see RES-0312 §2 for the exact compiler output.
 *
 * These tests cover what the type cannot:
 *   1. the CLASSIFICATION of each field is pinned, so silently flipping a field
 *      from "preserve existing" to "incoming wins" — the exact shape of
 *      REQ-0157 / 0158 / 0279 — shows up as a failing test, not a lost setting;
 *   2. each rule kind actually behaves the way its name claims.
 */
import { describe, it, expect } from 'vitest'
import {
  SETTINGS_MERGE_RULES,
  TRANSCRIPTION_DEFAULTS_MERGE_RULES,
  TRANSCRIPTION_ADVANCED_MERGE_RULES,
  mergeSettingsForSave,
  type MergeRule,
} from '../../src/main/ipc/settings-merge'
import type { AppSettings } from '../../src/shared/types'

function base(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    version: 1,
    language: 'ja',
    theme: 'dark',
    baseColor: 'neutral',
    transcriptionDefaults: {
      fontSizePx: 100,
      textColorHex: '#ffffff',
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
    encoder: 'auto',
    defaultAudioTrackIndex: 1,
    fadeDurationSec: 0,
    activeModelId: null,
    lastInputDir: null,
    lastOutputDir: null,
    ...overrides,
  } as AppSettings
}

describe('REQ-0312 §1 — the rule table pins every field s classification', () => {
  // Changing any line here is a deliberate behaviour change and must be
  // justified; three shipped data-loss bugs came from these being implicit.
  const EXPECTED: Record<string, MergeRule> = {
    version: 'incoming-wins',
    language: 'incoming-wins',
    theme: 'incoming-wins',
    baseColor: 'incoming-wins',
    transcriptionDefaults: 'incoming-wins',
    transcriptionAdvanced: 'incoming-wins',
    autoLineBreak: 'incoming-wins',
    encoder: 'incoming-wins',
    defaultAudioTrackIndex: 'incoming-wins',
    fadeDurationSec: 'incoming-wins',
    activeModelId: 'incoming-else-existing',
    lastInputDir: 'incoming-else-existing',
    lastOutputDir: 'incoming-else-existing',
    activeAccelerator: 'incoming-else-existing',
    defaultInputDir: 'presence-wins',
    defaultOutputDir: 'presence-wins',
    defaultProjectDir: 'presence-wins',
    fontSetInstalledVersion: 'presence-wins',
    activeFontId: 'presence-wins',
    burnin: 'session-only',
    audioMode: 'session-only',
    subtitleBackground: 'session-only',
  }

  it('matches the expected classification exactly', () => {
    expect(SETTINGS_MERGE_RULES).toEqual(EXPECTED)
  })

  it('declares a rule for every key and no extras', () => {
    expect(Object.keys(SETTINGS_MERGE_RULES).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it('the fields that caused REQ-0157 / 0158 / 0279 are still protected', () => {
    expect(SETTINGS_MERGE_RULES.activeAccelerator).toBe('incoming-else-existing')
    expect(SETTINGS_MERGE_RULES.defaultInputDir).toBe('presence-wins')
    expect(SETTINGS_MERGE_RULES.defaultOutputDir).toBe('presence-wins')
    expect(SETTINGS_MERGE_RULES.fontSetInstalledVersion).toBe('presence-wins')
    // REQ-0315 §4 joined them.
    expect(SETTINGS_MERGE_RULES.activeFontId).toBe('presence-wins')
  })
})

describe('REQ-0312 §1 — nested tables are compile-time only and all incoming-wins', () => {
  it('transcriptionDefaults: every field is incoming-wins (whole-object merge)', () => {
    for (const [k, v] of Object.entries(TRANSCRIPTION_DEFAULTS_MERGE_RULES)) {
      expect(v, `${k} should be incoming-wins`).toBe('incoming-wins')
    }
    // Non-trivial guard: the table must actually enumerate the interface.
    expect(Object.keys(TRANSCRIPTION_DEFAULTS_MERGE_RULES).length).toBeGreaterThanOrEqual(22)
  })

  it('transcriptionAdvanced: every field is incoming-wins', () => {
    for (const [k, v] of Object.entries(TRANSCRIPTION_ADVANCED_MERGE_RULES)) {
      expect(v, `${k} should be incoming-wins`).toBe('incoming-wins')
    }
    expect(Object.keys(TRANSCRIPTION_ADVANCED_MERGE_RULES).length).toBe(6)
  })
})

describe('REQ-0312 §1 — each rule kind behaves as its name claims', () => {
  it('incoming-wins: the payload value is taken verbatim', () => {
    const merged = mergeSettingsForSave(base({ language: 'en' }), base({ language: 'ja' }))
    expect(merged.language).toBe('en')
  })

  it('incoming-wins: an omitted optional key stays ABSENT, not undefined', () => {
    // Materialising omitted keys as explicit `undefined` would change
    // `'key' in merged` and JSON round-trips — the kind of silent difference
    // this refactor must not introduce.
    const incoming = base()
    delete (incoming as Partial<AppSettings>).theme
    const merged = mergeSettingsForSave(incoming, base({ theme: 'dark' }))
    expect('theme' in merged).toBe(false)
  })

  it('incoming-else-existing: falls back only when the payload is nullish', () => {
    expect(
      mergeSettingsForSave(base({ activeModelId: null }), base({ activeModelId: 'large-v3' }))
        .activeModelId,
    ).toBe('large-v3')
    expect(
      mergeSettingsForSave(base({ activeModelId: 'small' }), base({ activeModelId: 'large-v3' }))
        .activeModelId,
    ).toBe('small')
  })

  it('presence-wins: an explicit null is a user action and survives', () => {
    // This is the REQ-0158 distinction a `?? existing` fallback would eat.
    const merged = mergeSettingsForSave(
      base({ defaultInputDir: null }),
      base({ defaultInputDir: 'C:/videos' }),
    )
    expect(merged.defaultInputDir).toBeNull()
  })

  it('presence-wins: an omitted key preserves the on-disk value', () => {
    const merged = mergeSettingsForSave(base(), base({ defaultInputDir: 'C:/videos' }))
    expect(merged.defaultInputDir).toBe('C:/videos')
  })

  it('session-only: stripped even when the payload carries a value', () => {
    const merged = mergeSettingsForSave(
      base({ audioMode: 'mix', subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 } }),
      base(),
    )
    expect(merged.audioMode).toBeUndefined()
    expect(merged.subtitleBackground).toBeUndefined()
    expect(merged.burnin).toBeUndefined()
  })
})

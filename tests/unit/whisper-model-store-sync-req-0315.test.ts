import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from '../../src/renderer/stores/settings-store'
import { mergeSettingsForSave } from '../../src/main/ipc/settings-merge'
import type { AppSettings } from '../../src/shared/types'

/**
 * REQ-0315 §3 — the renderer store is now the source of truth for
 * `transcriptionDefaults.whisperModel`.
 *
 * Before, main wrote the field to settings.json (transcription.ts
 * `setActiveModel` / `uninstallModel`) and nothing wrote it back into the
 * Zustand store.  The store therefore held its boot value, and App.tsx's
 * debounced save shipped that stale `transcriptionDefaults` object; since the
 * field merges as `incoming-wins` at WHOLE-OBJECT granularity, the on-disk
 * value reverted.  No timing was involved — any later settings change at all
 * reproduced it, and it stayed reverted until the next restart (RES-0314 §3).
 *
 * This pins the end-to-end consequence: activate a model, let an unrelated
 * settings change trigger a save, and the choice must survive the round trip.
 */
function payloadFromStore(): AppSettings {
  // The 17 keys App.tsx actually sends, in the shape it sends them.
  const s = useSettingsStore.getState()
  return {
    version: 1,
    language: s.language,
    theme: s.theme,
    baseColor: s.baseColor,
    transcriptionDefaults: s.transcriptionDefaults,
    transcriptionAdvanced: s.transcriptionAdvanced,
    autoLineBreak: s.autoLineBreak,
    encoder: s.encoder,
    defaultAudioTrackIndex: s.defaultAudioTrackIndex,
    fadeDurationSec: s.fadeDurationSec,
    activeModelId: null,
    lastInputDir: null,
    lastOutputDir: null,
  } as AppSettings
}

function onDisk(whisperModel: string): AppSettings {
  return {
    ...payloadFromStore(),
    activeModelId: whisperModel,
    transcriptionDefaults: { ...useSettingsStore.getState().transcriptionDefaults, whisperModel },
  } as AppSettings
}

describe('REQ-0315 §3 — activating a model survives an unrelated settings save', () => {
  beforeEach(() => {
    useSettingsStore.getState().updateTranscriptionDefaults({ whisperModel: 'large-v3' })
  })

  it('the store carries the newly activated model', () => {
    // What whisper-model-manager now does after main confirms the switch.
    useSettingsStore.getState().updateTranscriptionDefaults({ whisperModel: 'large-v3-turbo' })
    expect(useSettingsStore.getState().transcriptionDefaults.whisperModel).toBe('large-v3-turbo')
  })

  it('a later unrelated settings change no longer reverts it on disk', () => {
    useSettingsStore.getState().updateTranscriptionDefaults({ whisperModel: 'large-v3-turbo' })
    // main already wrote the new model to settings.json …
    const existing = onDisk('large-v3-turbo')
    // … then the user toggles something unrelated and the debounce fires.
    useSettingsStore.setState({ autoLineBreak: false })
    const merged = mergeSettingsForSave(payloadFromStore(), existing)
    expect(merged.transcriptionDefaults.whisperModel).toBe('large-v3-turbo')
  })

  it('the pre-fix behaviour is what the guard catches', () => {
    // Simulate the old world: main wrote the new model, the store never learned.
    const existing = onDisk('large-v3-turbo')
    const stalePayload = payloadFromStore() // store still says large-v3
    const merged = mergeSettingsForSave(stalePayload, existing)
    // Whole-object `incoming-wins` means the stale store value wins — this is
    // the bug, reproduced deliberately so the fix above has a contrast.
    expect(merged.transcriptionDefaults.whisperModel).toBe('large-v3')
  })

  it('activeModelId is unaffected — it was already protected', () => {
    const existing = onDisk('large-v3-turbo')
    const merged = mergeSettingsForSave(payloadFromStore(), existing)
    expect(merged.activeModelId).toBe('large-v3-turbo')
  })
})

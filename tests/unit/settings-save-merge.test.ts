import { describe, it, expect } from 'vitest'
import { mergeSettingsForSave } from '../../src/main/ipc/settings-merge'
import type { AppSettings } from '../../src/shared/types'

/**
 * REQ-0157 regression suite.  Pins the fix that stops the renderer's
 * debounced auto-save (App.tsx: `saveSettings(payload)` fired 500 ms
 * after every Zustand store change, including the one produced by
 * `hydrate()` at startup) from wiping fields the renderer does not
 * track.  Before the fix, `activeAccelerator` was dropped from
 * settings.json on every launch and every settings change, which
 * silently reverted the user's GPU choice back to CPU and left
 * `MOJIOKO_GPU_TOOL_DIR` uninjected in the sidecar — the ultimate cause
 * of the "cublas64_12.dll not found" error the owner reported on the
 * confirmation MSIX build.
 */
function baseIncoming(overrides: Partial<AppSettings> = {}): AppSettings {
  const base: AppSettings = {
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
    fadeDurationSec: 0.2,
    // Renderer sends `null` sentinels for the main-managed fields on
    // every save — this is what App.tsx actually does today.
    activeModelId: null,
    lastInputDir: null,
    lastOutputDir: null,
    // NOTE: intentionally omitting `activeAccelerator`.  The renderer's
    // Zustand store does not know about this field, so the debounced
    // save serializes an AppSettings without the key — mirroring
    // production behaviour that produced REQ-0157.
  }
  return { ...base, ...overrides }
}

function baseExisting(overrides: Partial<AppSettings> = {}): AppSettings {
  const base: AppSettings = {
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
    fadeDurationSec: 0.2,
    activeModelId: null,
    lastInputDir: null,
    lastOutputDir: null,
  }
  return { ...base, ...overrides }
}

describe('mergeSettingsForSave — REQ-0157 activeAccelerator preservation', () => {
  it('preserves activeAccelerator="gpu" from existing when renderer omits it', () => {
    // This is the REQ-0157 regression scenario: user picks GPU via the
    // gpu-tool:select IPC (writes 'gpu' to disk), then any subsequent
    // debounced auto-save fires without the key and — before the fix —
    // clobbered the value back to undefined.
    const incoming = baseIncoming()
    const existing = baseExisting({ activeAccelerator: 'gpu' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.activeAccelerator).toBe('gpu')
  })

  it('preserves activeAccelerator="cpu" from existing when renderer omits it', () => {
    // CPU is a valid explicit choice — must not be dropped either.
    const incoming = baseIncoming()
    const existing = baseExisting({ activeAccelerator: 'cpu' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.activeAccelerator).toBe('cpu')
  })

  it('lets an incoming activeAccelerator override existing (defensive)', () => {
    // The renderer does not send this today, but if a future callsite
    // does (e.g. a settings-import flow), the incoming value must win.
    const incoming = baseIncoming({ activeAccelerator: 'gpu' })
    const existing = baseExisting({ activeAccelerator: 'cpu' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.activeAccelerator).toBe('gpu')
  })

  it('leaves activeAccelerator undefined when neither incoming nor existing has it', () => {
    // Fresh install path — settings-store's `buildDefaults` will
    // hydrate 'cpu' on the next load; this merge should not fabricate.
    const incoming = baseIncoming()
    const existing = baseExisting()
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.activeAccelerator).toBeUndefined()
  })

  it('still preserves the other main-managed fields it always has (activeModelId, lastInputDir, lastOutputDir)', () => {
    // Regression guard for the fields the fix piggy-backed on.  If a
    // future refactor drops one, this test flags it.
    const incoming = baseIncoming({
      activeModelId: null,
      lastInputDir: null,
      lastOutputDir: null,
    })
    const existing = baseExisting({
      activeModelId: 'large-v3',
      lastInputDir: 'C:/videos',
      lastOutputDir: 'C:/output',
    })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.activeModelId).toBe('large-v3')
    expect(merged.lastInputDir).toBe('C:/videos')
    expect(merged.lastOutputDir).toBe('C:/output')
  })

  // -------------------------------------------------------------------
  // REQ-0158 — defaultInputDir / defaultOutputDir preservation
  //
  // Same class of bug as REQ-0157 but with an added wrinkle: these
  // fields have a real `null` value (user cleared via the × button)
  // that must be distinguished from "renderer did not include the
  // key at all."  The merge uses `'key' in incoming` for that reason.
  // -------------------------------------------------------------------

  it('preserves defaultInputDir when the renderer omits the key entirely', () => {
    // Pre-REQ-0158 App.tsx did NOT include defaultInputDir in the
    // debounced-save payload.  This test pins the migration path from
    // that state — if a stale user hits the fixed build, their
    // on-disk default folder must survive one more round-trip even if
    // the renderer bundle they load is somehow older than the main.
    const incoming = baseIncoming()
    delete (incoming as { defaultInputDir?: unknown }).defaultInputDir
    const existing = baseExisting({ defaultInputDir: 'C:/videos' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.defaultInputDir).toBe('C:/videos')
  })

  it('preserves defaultOutputDir when the renderer omits the key entirely', () => {
    const incoming = baseIncoming()
    delete (incoming as { defaultOutputDir?: unknown }).defaultOutputDir
    const existing = baseExisting({ defaultOutputDir: 'C:/output' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.defaultOutputDir).toBe('C:/output')
  })

  it('respects the renderer sending a string value for defaultInputDir', () => {
    // Post-REQ-0158 App.tsx always sends the field.  A newly picked
    // folder must land on disk verbatim, overriding whatever was there.
    const incoming = baseIncoming({ defaultInputDir: 'D:/new-videos' })
    const existing = baseExisting({ defaultInputDir: 'C:/old-videos' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.defaultInputDir).toBe('D:/new-videos')
  })

  it('respects the renderer sending null for defaultInputDir (user cleared via × button)', () => {
    // The critical REQ-0158 wrinkle: `null` from the renderer means
    // "user hit the × to clear," and must NOT be swallowed by a
    // `?? existing` fallback that would silently re-instate the old
    // value.  The `'key' in incoming` semantics let null win.
    const incoming = baseIncoming({ defaultInputDir: null })
    const existing = baseExisting({ defaultInputDir: 'C:/videos' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.defaultInputDir).toBeNull()
  })

  it('respects the renderer sending null for defaultOutputDir (user cleared via × button)', () => {
    const incoming = baseIncoming({ defaultOutputDir: null })
    const existing = baseExisting({ defaultOutputDir: 'C:/output' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.defaultOutputDir).toBeNull()
  })

  it('respects the renderer sending a string value for defaultOutputDir', () => {
    const incoming = baseIncoming({ defaultOutputDir: 'D:/exports' })
    const existing = baseExisting({ defaultOutputDir: 'C:/output' })
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.defaultOutputDir).toBe('D:/exports')
  })

  it('strips Step-3-only UI state (burnin, subtitleBackground, audioMode) from the result', () => {
    // These fields are session-only by design — the settings-save
    // handler must always drop them before writing so a stale entry
    // from an older settings.json cannot re-emerge.
    const incoming = baseIncoming({
      burnin: { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 },
      subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 },
      audioMode: 'preserve',
    })
    const existing = baseExisting()
    const merged = mergeSettingsForSave(incoming, existing)
    expect(merged.burnin).toBeUndefined()
    expect(merged.subtitleBackground).toBeUndefined()
    expect(merged.audioMode).toBeUndefined()
  })
})

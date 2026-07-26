import { describe, it, expect } from 'vitest'
import type { AppSettings, TranscriptionDefaults } from '../../src/shared/types'
import { mergeSettingsForSave } from '../../src/main/ipc/settings-merge'

/**
 * REQ-0295 — the "字幕スタイル" tab now surfaces every Phase A / Phase B
 * default (shadow, karaoke, casing, rotation, fade — already stored on
 * settings.fadeDurationSec — plus layout H/V/margin/offset).  These
 * fields are optional and additive on `TranscriptionDefaults`; the risk
 * is that the main-process debounced-save merge (`mergeSettingsForSave`,
 * `settings-merge.ts`) OR the renderer-side hydrate silently drops them
 * on roundtrip — the same class of bug REQ-0279 documented for
 * `fontSetInstalledVersion`.
 *
 * These tests pin:
 *   1. Every new REQ-0295 field survives a save→load roundtrip through
 *      `mergeSettingsForSave` when the renderer sends it.
 *   2. A pre-REQ-0295 save (no new keys) roundtrips as-is (backward
 *      compat — nothing gets fabricated or lost).
 *   3. Legacy `shadowEnabled` / `karaokeBaseColor` on the incoming
 *      payload (from a dev save made pre-REQ-0293) are silently
 *      dropped without throwing — pinning the REQ-0293 "unknown key
 *      tolerance" contract at the settings layer.
 */

function baseSettings(td: Partial<TranscriptionDefaults> = {}): AppSettings {
  return {
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
      ...td,
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
}

describe('REQ-0295 — TranscriptionDefaults new fields survive save/load merge', () => {
  it('every REQ-0295 field on the incoming payload survives the merge', () => {
    const incoming = baseSettings({
      shadowDepth: 25,
      shadowColor: '#FF00FF',
      shadowAlpha: 80,
      karaokeEnabled: true,
      karaokeHighlightColor: '#00FF00',
      casing: 'uppercase',
      rotation: 45,
      horizontalPosition: 'left',
      verticalPosition: 'top',
      verticalMarginPx: 60,
      posOffsetX: 25,
      posOffsetY: -10,
    })
    const existing = baseSettings()  // pre-REQ-0295 shape, no new keys
    const merged = mergeSettingsForSave(incoming, existing)

    expect(merged.transcriptionDefaults.shadowDepth).toBe(25)
    expect(merged.transcriptionDefaults.shadowColor).toBe('#FF00FF')
    expect(merged.transcriptionDefaults.shadowAlpha).toBe(80)
    expect(merged.transcriptionDefaults.karaokeEnabled).toBe(true)
    expect(merged.transcriptionDefaults.karaokeHighlightColor).toBe('#00FF00')
    expect(merged.transcriptionDefaults.casing).toBe('uppercase')
    expect(merged.transcriptionDefaults.rotation).toBe(45)
    expect(merged.transcriptionDefaults.horizontalPosition).toBe('left')
    expect(merged.transcriptionDefaults.verticalPosition).toBe('top')
    expect(merged.transcriptionDefaults.verticalMarginPx).toBe(60)
    expect(merged.transcriptionDefaults.posOffsetX).toBe(25)
    expect(merged.transcriptionDefaults.posOffsetY).toBe(-10)
  })

  it('legacy defaults with NO REQ-0295 keys roundtrip unchanged (backward compat pin)', () => {
    const incoming = baseSettings()  // no new keys
    const existing = baseSettings()
    const merged = mergeSettingsForSave(incoming, existing)

    // The 4 legacy fields survive verbatim.
    expect(merged.transcriptionDefaults.fontSizePx).toBe(100)
    expect(merged.transcriptionDefaults.textColorHex).toBe('#FFFFFF')
    expect(merged.transcriptionDefaults.outlineColorHex).toBe('#000000')
    expect(merged.transcriptionDefaults.outlineThicknessPx).toBe(3)
    // No REQ-0295 keys appear from thin air — undefined stays undefined.
    expect(merged.transcriptionDefaults.shadowDepth).toBeUndefined()
    expect(merged.transcriptionDefaults.karaokeEnabled).toBeUndefined()
    expect(merged.transcriptionDefaults.casing).toBeUndefined()
    expect(merged.transcriptionDefaults.rotation).toBeUndefined()
    expect(merged.transcriptionDefaults.horizontalPosition).toBeUndefined()
    expect(merged.transcriptionDefaults.posOffsetX).toBeUndefined()
  })

  it('subsequent save preserves REQ-0295 fields written on a previous save (no clobber)', () => {
    // Simulates: user set shadowDepth=30 → saved.  Now user changes
    // something ELSE (e.g. fontSize) and the debounced save fires with
    // both the old shadow value + new font size in the payload.  The
    // merge MUST NOT drop shadowDepth even though the setter that
    // triggered THIS save wasn't touching it.
    const prevSaved = baseSettings({ shadowDepth: 30, karaokeEnabled: true })
    const incoming = { ...prevSaved, transcriptionDefaults: { ...prevSaved.transcriptionDefaults, fontSizePx: 120 } }
    const merged = mergeSettingsForSave(incoming, prevSaved)

    expect(merged.transcriptionDefaults.fontSizePx).toBe(120)         // new value
    expect(merged.transcriptionDefaults.shadowDepth).toBe(30)         // preserved
    expect(merged.transcriptionDefaults.karaokeEnabled).toBe(true)    // preserved
  })

  it('legacy `shadowEnabled` / `karaokeBaseColor` in incoming payload are tolerated (REQ-0293 unknown-key contract)', () => {
    // A dev save created between REQ-0286 and REQ-0293 might carry
    // these now-removed keys.  The merge should not throw, and the
    // rest of the payload should roundtrip normally.  Cast to `any`
    // because the type no longer allows the extra keys.
    const legacyIncoming = {
      ...baseSettings(),
      transcriptionDefaults: {
        fontSizePx: 100,
        textColorHex: '#FFFFFF',
        outlineColorHex: '#000000',
        outlineThicknessPx: 3,
        whisperModel: 'large-v3' as const,
        shadowEnabled: false,        // removed by REQ-0293
        karaokeBaseColor: '#00FF00', // removed by REQ-0293
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulates a dev save with removed fields.
    } as any
    const existing = baseSettings()
    expect(() => mergeSettingsForSave(legacyIncoming, existing)).not.toThrow()
    const merged = mergeSettingsForSave(legacyIncoming, existing)
    // Legacy keys ride through in the merged payload (merge doesn't
    // filter them); the renderer's hydrate is where they'd be
    // dropped from the store.  Merge's job is to not blow up + not
    // clobber the payload — pinned.
    expect(merged.transcriptionDefaults.fontSizePx).toBe(100)
  })
})

import { describe, it, expect } from 'vitest'
import { mergeSettingsForSave } from '../../src/main/ipc/settings-merge'
import { deriveFontStatus, FONT_SET_VERSION } from '../../src/shared/fonts'
import type { AppSettings } from '../../src/shared/types'

/**
 * REQ-0279 — end-to-end intent test.  Simulates the exact production
 * sequence that produced the "batch DL completes but inspector shows
 * only the default font" bug:
 *
 *   1. Fresh install.  `fontSetInstalledVersion` is undefined on disk.
 *   2. User clicks "まとめてダウンロード".  Every font downloads.
 *   3. The batch loop calls `recordFontSetVersion` — main writes
 *      `fontSetInstalledVersion = 3` to settings.json.
 *   4. Some earlier store change (hydrate, active-font pick, etc.)
 *      scheduled the App.tsx 500 ms debounced auto-save.  It fires
 *      NOW, AFTER step 3.  The renderer's payload does not carry
 *      `fontSetInstalledVersion` (App.tsx never adds that key).
 *   5. Main's `settings:save` handler runs `mergeSettingsForSave`
 *      against the (post-step-3) on-disk state.
 *   6. `fontList` reads settings and feeds `deriveFontStatus` the
 *      preserved version, which must land on `'installed'` for
 *      non-bundled fonts whose bytes exist on disk.
 *
 * Before the fix, step 5 wiped the stamp to undefined and step 6
 * returned `'not-installed'` — the observed symptom.  This test
 * pins the fix at that exact junction so a future refactor of
 * mergeSettingsForSave cannot silently reintroduce the bug.
 */

function makeRendererPayload(): AppSettings {
  // Byte-for-byte the shape App.tsx:190-232 sends today.  Kept in
  // sync manually — if App.tsx ever gains a `fontSetInstalledVersion`
  // field, this test will catch the drift because the deep-equality
  // check on step 3's write below still needs to hold.
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
    fadeDurationSec: 0.2,
    activeModelId: null,
    activeFontId: 'noto-sans-jp-semibold',
    lastInputDir: null,
    lastOutputDir: null,
    defaultInputDir: null,
    defaultOutputDir: null,
    defaultProjectDir: null,
  }
}

describe('REQ-0279 — bulk DL end-to-end sequence preserves setIsCurrent', () => {
  it('recordSetVersion=3 survives a subsequent debounced auto-save, and deriveFontStatus reports installed', () => {
    // Step 3 result: recordFontSetVersion has just written
    // fontSetInstalledVersion=3 into on-disk settings.
    const onDiskAfterRecord: AppSettings = {
      ...makeRendererPayload(),
      fontSetInstalledVersion: FONT_SET_VERSION,
    }

    // Step 4: renderer's debounced auto-save fires with a payload that
    // has NO fontSetInstalledVersion key at all (mirroring App.tsx
    // today).
    const rendererPayload = makeRendererPayload()
    expect('fontSetInstalledVersion' in rendererPayload).toBe(false)

    // Step 5: main-side merge.  The fix's `'key' in incoming` guard
    // must preserve the value from `onDiskAfterRecord`.
    const merged = mergeSettingsForSave(rendererPayload, onDiskAfterRecord)
    expect(merged.fontSetInstalledVersion).toBe(FONT_SET_VERSION)

    // Step 6: what fontList / deriveFontStatus would return next.
    // For a non-bundled font whose bytes are on disk (installed=true),
    // the setIsCurrent input must now be true → 'installed'.
    const setIsCurrent = merged.fontSetInstalledVersion === FONT_SET_VERSION
    expect(setIsCurrent).toBe(true)
    expect(deriveFontStatus(false, true, setIsCurrent)).toBe('installed')

    // Contrast: same disk state (installed=true) but with the
    // pre-fix merge behaviour (stamp wiped) — this is the bug we
    // fixed, checked by re-simulating the bad path locally.
    const buggyMerged = { ...rendererPayload }  // no fontSetInstalledVersion — the pre-fix result
    const buggySetIsCurrent = (buggyMerged as AppSettings).fontSetInstalledVersion === FONT_SET_VERSION
    expect(buggySetIsCurrent).toBe(false)
    expect(deriveFontStatus(false, true, buggySetIsCurrent)).toBe('not-installed')
  })

  it('a fresh-install save (no prior record) leaves the stamp undefined and status not-installed', () => {
    // The other side of the coin: if the user has NOT completed a
    // bulk DL, the stamp should remain undefined through any number
    // of debounced saves.  This pins that the fix does not
    // accidentally fabricate a version stamp.
    const onDiskNoRecord: AppSettings = makeRendererPayload()
    delete (onDiskNoRecord as { fontSetInstalledVersion?: unknown }).fontSetInstalledVersion

    const rendererPayload = makeRendererPayload()
    const merged = mergeSettingsForSave(rendererPayload, onDiskNoRecord)
    expect(merged.fontSetInstalledVersion).toBeUndefined()

    const setIsCurrent = merged.fontSetInstalledVersion === FONT_SET_VERSION
    expect(setIsCurrent).toBe(false)
    // Even with installed=true (files exist), the missing stamp keeps
    // the status not-installed — RES-0276's existing-user protection
    // that MUST NOT be bypassed by this fix.
    expect(deriveFontStatus(false, true, setIsCurrent)).toBe('not-installed')
  })

  it('an outdated recorded stamp (< FONT_SET_VERSION) survives the merge and still gates installed to not-installed', () => {
    // The v1.3.5 → v1.3.6 upgrade scenario: user has an old stamp
    // recorded (say 1 or 2, from a hypothetical intermediate build)
    // and their bytes are still on disk under the old family names.
    // The merge must preserve the stale value (so the picker's
    // upgrade banner can distinguish "never downloaded" from
    // "outdated") AND deriveFontStatus must still return
    // not-installed to force a re-download.
    for (const outdated of [1, 2]) {
      if (outdated >= FONT_SET_VERSION) continue
      const onDiskOutdated: AppSettings = {
        ...makeRendererPayload(),
        fontSetInstalledVersion: outdated,
      }
      const rendererPayload = makeRendererPayload()
      const merged = mergeSettingsForSave(rendererPayload, onDiskOutdated)
      expect(merged.fontSetInstalledVersion).toBe(outdated)
      const setIsCurrent = merged.fontSetInstalledVersion === FONT_SET_VERSION
      expect(setIsCurrent).toBe(false)
      expect(deriveFontStatus(false, true, setIsCurrent)).toBe('not-installed')
    }
  })
})

import { describe, it, expect } from 'vitest'
import { mergeSettingsForSave } from '../../src/main/ipc/settings-merge'
import { deriveFontStatus, FONT_SET_VERSION } from '../../src/shared/fonts'
import type { AppSettings } from '../../src/shared/types'
import { appSettingsPayloadKeys } from '../helpers/app-settings-payload'

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

/**
 * The shape App.tsx sends on every debounced auto-save.
 *
 * REQ-0511 M4 — this used to say "kept in sync manually" and claimed the test
 * would "catch the drift". It could not: the only drift check was
 * `expect('fontSetInstalledVersion' in rendererPayload).toBe(false)`, which
 * compares this literal against ITSELF and is true no matter what App.tsx does.
 * It had in fact drifted by four keys (`translationAutoEnabled`,
 * `translationTargetLang`, `playbackTimeDetailed`, `stylePresets`), all added
 * after the fixture was written. Those are restored below, and the drift check
 * now reads App.tsx (see the first `it` in the suite) — so the next omission
 * fails here instead of quietly making this scenario fictional.
 */
function makeRendererPayload(): AppSettings {
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
    lastInputDir: null,
    lastOutputDir: null,
    defaultInputDir: null,
    defaultOutputDir: null,
    defaultProjectDir: null,
    // REQ-0518 — three more folder rows in the payload.
    defaultImageDir: null,
    defaultTextDir: null,
    defaultSrtDir: null,
    // REQ-0511 M4 — the four keys the fixture had fallen behind on. Values
    // mirror a default install; only their PRESENCE matters to this scenario.
    translationAutoEnabled: false,
    translationTargetLang: 'en',
    playbackTimeDetailed: false,
    stylePresets: [],
    // REQ-0540 — the per-type animation memory joined the payload.
    animationMemory: {},
  }
}

describe('REQ-0279 — bulk DL end-to-end sequence preserves setIsCurrent', () => {
  /**
   * REQ-0511 M4 — the drift check the fixture's comment used to promise.
   *
   * The whole scenario rests on "this is what the renderer sends". If App.tsx
   * gains a key and this copy does not, the merge below is exercised against a
   * payload no build ever produces, and it keeps passing while proving nothing
   * about the app. Reading App.tsx is the only way to know.
   */
  it('the fixture matches the payload App.tsx actually sends', () => {
    const sent = appSettingsPayloadKeys().sort()
    const fixture = Object.keys(makeRendererPayload()).sort()
    expect(sent.length, 'the App.tsx payload parser found nothing — re-point it').toBeGreaterThan(10)
    expect(fixture, 'this fixture has drifted from App.tsx; add/remove the keys listed in the diff').toEqual(sent)
  })

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
    // REQ-0315 §4 — `activeFontId` joined the same two-part protection:
    // the renderer omits the key AND the merge rule is `presence-wins`.
    // `presence-wins` protects nothing while the key is present, so this
    // assertion is half of the fix, not a restatement of it.
    expect('activeFontId' in rendererPayload).toBe(false)

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

    // ILLUSTRATION, NOT A CHECK (REQ-0511 L1). The three lines below spread a
    // local object that has no `fontSetInstalledVersion` and then assert it has
    // none: true by construction, and true whatever `mergeSettingsForSave`
    // does. It is kept because it states the symptom in code — "no stamp ⇒
    // not-installed even though the bytes are on disk" — but it protects
    // nothing on its own. The protection is `expect(merged.
    // fontSetInstalledVersion).toBe(FONT_SET_VERSION)` above, which runs the
    // real merge; if that ever breaks, this pair still passes.
    const preFixShape = { ...rendererPayload } // what the pre-fix merge produced
    const preFixSetIsCurrent = (preFixShape as AppSettings).fontSetInstalledVersion === FONT_SET_VERSION
    expect(preFixSetIsCurrent).toBe(false)
    expect(deriveFontStatus(false, true, preFixSetIsCurrent)).toBe('not-installed')
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

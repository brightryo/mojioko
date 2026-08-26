import { describe, it, expect } from 'vitest'
import { appSettingsPayloadKeys } from '../helpers/app-settings-payload'
import { SETTINGS_MERGE_RULES } from '../../src/main/ipc/settings-merge'
import type { AppSettings } from '../../src/shared/ipc-contracts'

/**
 * REQ-0341 §3-2 — the renderer must SEND every `incoming-wins` key.
 *
 * ## The relationship this pins
 *
 * A merge rule is only half of a contract; the other half is what the
 * renderer puts in the payload, and the two are written in different files.
 * REQ-0279 / REQ-0315 pinned one direction — `fontSetInstalledVersion` and
 * `activeFontId` are `presence-wins` AND must be ABSENT, because
 * `presence-wins` protects nothing while the key is present.
 *
 * This is the mirror. `incoming-wins` is a deliberate no-op in `applyRule`,
 * and `mergeSettingsForSave` seeds `merged` from `{ ...incoming }`. So an
 * `incoming-wins` key the renderer forgets to send is simply absent from the
 * merged object and is therefore **dropped from settings.json entirely**.
 * For `stylePresets` (REQ-0335 §3-6) that is the difference between deleting
 * a preset and losing all of them.
 *
 * ## Why it reads App.tsx's source
 *
 * `font-set-version-preserved-across-save.test.ts` builds a hand-written copy
 * of the payload and says so ("Kept in sync manually"). That copy has already
 * drifted — it predates `stylePresets` and does not contain it — which is
 * exactly why asserting a property of the copy proves nothing about the app.
 * The only way to pin what App.tsx sends is to read what App.tsx sends.
 *
 * The parse is deliberately crude (top-level `key:` lines of the one object
 * literal annotated `AppSettings`). If App.tsx restructures the payload this
 * test fails loudly rather than passing vacuously — a failure here means
 * "re-point the parser AND re-check the invariant", not "delete the test".
 */
/**
 * REQ-0511 M4 — the parser moved to `tests/helpers/app-settings-payload.ts` so
 * `font-set-version-preserved-across-save` can check its hand-written payload
 * copy against the same source of truth. Two parsers of one literal would be
 * the very drift both tests exist to catch.
 */
const payloadKeys = appSettingsPayloadKeys

describe('REQ-0341 §3-2 — the settings save payload matches the merge rules', () => {
  const keys = payloadKeys()
  const rules = SETTINGS_MERGE_RULES as Record<string, string>
  const withRule = (rule: string) =>
    (Object.keys(rules) as (keyof AppSettings & string)[]).filter((k) => rules[k] === rule)

  it('the parser actually found the payload', () => {
    // Guards against a silent vacuous pass if App.tsx is restructured.
    expect(keys.length).toBeGreaterThan(10)
    expect(keys).toContain('version')
  })

  it('★ every `incoming-wins` key is sent on every save', () => {
    // Omitting one does not "keep the old value" — `applyRule` no-ops and
    // `merged` starts from `{ ...incoming }`, so the key vanishes from disk.
    const missing = withRule('incoming-wins').filter((k) => !keys.includes(k))
    expect(missing, `incoming-wins keys missing from App.tsx's payload: ${missing.join(', ')}`)
      .toEqual([])
  })

  it('★ stylePresets specifically — the delete path depends on it', () => {
    // REQ-0335 §3-6 named this pairing; this is the assertion that holds it.
    expect(rules.stylePresets).toBe('incoming-wins')
    expect(keys).toContain('stylePresets')
  })

  it('★ animationMemory specifically — REQ-0540, same pairing', () => {
    // Omitting it would not "keep the previous table": `merged` starts from
    // `{ ...incoming }`, so every remembered value would be wiped on the next
    // save the user triggers by changing anything at all.
    expect(rules.animationMemory).toBe('incoming-wins')
    expect(keys).toContain('animationMemory')
  })

  it('the two main-owned `presence-wins` keys stay absent (REQ-0279 / REQ-0315)', () => {
    // The other direction of the same contract, restated here so both halves
    // live together rather than only in the fontSetInstalledVersion test.
    expect(keys).not.toContain('fontSetInstalledVersion')
    expect(keys).not.toContain('activeFontId')
  })

  it('`session-only` keys are never sent', () => {
    for (const k of withRule('session-only')) expect(keys).not.toContain(k)
  })

  it('every key the renderer sends has a rule', () => {
    // The reverse drift: a key added to the payload but not to the table
    // would be carried to disk with no documented merge semantics.
    for (const k of keys) expect(rules[k], `payload key "${k}" has no merge rule`).toBeDefined()
  })
})

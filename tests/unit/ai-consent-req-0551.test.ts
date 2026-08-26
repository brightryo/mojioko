import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  hasAiConsent,
  needsAiConsentGate,
  needsAiRetroactiveNotice,
  sanitizeAiConsent,
} from '../../src/shared/ai-consent'
import { SETTINGS_MERGE_RULES } from '../../src/main/ipc/settings-merge'

/**
 * REQ-0551 — AI integration narrows a headline promise, so the user is told
 * before they connect anything.
 *
 * "Everything happens on this PC" stays true of the PROCESSING and of the media
 * files. It is not true of what an assistant reads and writes through the tools
 * — subtitle text, file paths, video metadata, tool replies — because the
 * assistant runs on the provider's servers. The gate exists to make that line
 * visible at the moment it starts to matter.
 */

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')

describe('REQ-0551 §1-2 — the gate', () => {
  it('★ a user who has never agreed is gated', () => {
    expect(needsAiConsentGate(undefined)).toBe(true)
    expect(needsAiConsentGate({})).toBe(true)
  })

  it('★ once agreed, never gated again', () => {
    const agreed = { consentAcceptedAtMs: 1_700_000_000_000 }
    expect(hasAiConsent(agreed)).toBe(true)
    expect(needsAiConsentGate(agreed)).toBe(false)
  })

  it('having merely SEEN the notice is not agreement', () => {
    // Dismissing an informational dialog must not be recorded as consent.
    const seen = { noticeSeenAtMs: 1_700_000_000_000 }
    expect(hasAiConsent(seen)).toBe(false)
    expect(needsAiConsentGate(seen)).toBe(true)
  })
})

describe('REQ-0551 §1-4 — the one-time retroactive notice', () => {
  it('★ an already-configured user with no record is told, once', () => {
    expect(needsAiRetroactiveNotice({}, true)).toBe(true)
    // …and not again after it has been shown.
    expect(needsAiRetroactiveNotice({ noticeSeenAtMs: 1 }, true)).toBe(false)
  })

  it('a user who already agreed is not told again', () => {
    expect(needsAiRetroactiveNotice({ consentAcceptedAtMs: 1 }, true)).toBe(false)
  })

  it('★ a fresh user sees nothing merely for opening the tab', () => {
    // They will meet the gate when they act. A dialog that fires for a tab you
    // clicked reads as noise, and noise is what teaches people to dismiss.
    expect(needsAiRetroactiveNotice({}, false)).toBe(false)
    expect(needsAiRetroactiveNotice(undefined, false)).toBe(false)
  })
})

describe('REQ-0551 — reading the record off disk', () => {
  it('absent or malformed means "not agreed, not told"', () => {
    for (const bad of [undefined, null, 'yes', 42, [], {}]) {
      expect(sanitizeAiConsent(bad)).toEqual({})
      expect(needsAiConsentGate(sanitizeAiConsent(bad))).toBe(true)
    }
  })

  it('★ a non-numeric timestamp is NOT mistaken for agreement', () => {
    // The safe direction is to re-ask.
    expect(sanitizeAiConsent({ consentAcceptedAtMs: true })).toEqual({})
    expect(sanitizeAiConsent({ consentAcceptedAtMs: '2026-01-01' })).toEqual({})
    expect(sanitizeAiConsent({ consentAcceptedAtMs: NaN })).toEqual({})
  })

  it('a valid record survives', () => {
    expect(sanitizeAiConsent({ consentAcceptedAtMs: 5, noticeSeenAtMs: 6, junk: 1 }))
      .toEqual({ consentAcceptedAtMs: 5, noticeSeenAtMs: 6 })
  })
})

describe('REQ-0551 §2 — persistence follows the existing rules', () => {
  it('the key is renderer-owned and sent on every save', () => {
    // `incoming-wins` is a no-op in the merge, so an omitted key is DROPPED
    // from settings.json — which would re-prompt a user who already agreed.
    expect(SETTINGS_MERGE_RULES.aiIntegration).toBe('incoming-wins')
    expect(read('src/renderer/App.tsx')).toContain('aiIntegration: s.aiIntegration')
  })

  it('a settings.json without the key still hydrates (no migration)', () => {
    // The store sanitizes, so an old file lands on `{}` = the retroactive
    // notice path, not a crash and not silent consent.
    expect(read('src/renderer/stores/settings-store.ts'))
      .toContain('aiIntegration: sanitizeAiConsent(s.aiIntegration)')
  })
})

describe('REQ-0551 §1-2 / §1-5 — what is gated, and what is not touched', () => {
  const tab = read('src/renderer/components/settings-dialog/ai-integration-tab.tsx')

  it('★ ALL THREE connection actions go through the gate', () => {
    // The tab has no enable switch: exporting the bundle and copying either
    // config ARE the enabling acts. Gating only the export would leave two
    // unguarded routes to exactly the same place.
    // Exactly three CALL sites (the definition reads `const runGated = (`,
    // so it does not match) — one per connection action, no more, no fewer.
    const gated = tab.match(/runGated\(/g) ?? []
    expect(gated.length).toBe(3)
    for (const action of ['handleExport', 'desktopConfig(spec)', 'claudeCodeCommand(spec)']) {
      const at = tab.indexOf(action, tab.indexOf('onClick'))
      expect(at, `${action} must be reachable`).toBeGreaterThan(-1)
    }
    expect(tab).not.toMatch(/onClick=\{handleExport\}/)
  })

  it('accepting resumes the action the user was taking', () => {
    // Making them click the same button twice is how a gate becomes something
    // people learn to dismiss without reading.
    expect(tab).toContain('pending?.run?.()')
  })

  it('★ cancelling changes nothing', () => {
    // `onDismiss` records the notice as seen but never calls `acceptAiConsent`,
    // and never runs the pending action.
    const dismiss = tab.slice(tab.indexOf('onDismiss={'), tab.indexOf('onDismiss={') + 500)
    expect(dismiss).not.toContain('acceptAiConsent()')
    expect(dismiss).not.toContain('pending?.run')
  })

  it('★ the MCP server itself is untouched (§1-5)', () => {
    // Consent is the user's act; asking the AI side would mean nothing.
    for (const f of ['src/main/mcp/server.ts', 'src/main/mcp/jobs.ts']) {
      expect(read(f)).not.toContain('aiIntegration')
      expect(read(f)).not.toContain('Consent')
    }
  })

  it('the copy states both halves of the line, in both locales', () => {
    for (const loc of ['ja', 'en']) {
      const s = read(`src/renderer/locales/${loc}/settings.json`)
      for (const key of ['staysLocal', 'leaves', 'provider', 'alreadyExported', 'acceptGate']) {
        expect(s, `${loc} is missing ai.consent.${key}`).toContain(`"${key}"`)
      }
    }
  })
})

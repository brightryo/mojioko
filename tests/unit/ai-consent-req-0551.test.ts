import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasAiConsent, sanitizeAiConsent } from '../../src/shared/ai-consent'
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

describe('REQ-0559 §2 — the gate fires EVERY time', () => {
  const tab = read('src/renderer/components/settings-dialog/ai-integration-tab.tsx')

  it('★ the gate no longer consults the stored consent', () => {
    /*
     * REQ-0551 asked once and let a returning user straight through. REQ-0559
     * asks every time: these actions are rare and deliberate, so the cost is
     * one click on something nobody does often, and the boundary gets re-read
     * at the moment it applies rather than once, months ago.
     *
     * Pinned at the source because the decision IS the absence of a condition
     * — there is no predicate left to call in a unit test.
     */
    const body = tab.slice(tab.indexOf('const runGated'), tab.indexOf('const isDev'))
    expect(body).toContain('setDialog({ run: action })')
    expect(body).not.toContain('hasAiConsent')
    expect(body).not.toContain('needsAiConsentGate')
    // No early return that would skip the dialog for an already-consented user.
    expect(body).not.toMatch(/return\s*$/m)
  })

  it('★ the acceptance is still RECORDED, it just does not gate', () => {
    // "Did this user ever agree" stays answerable; it no longer decides whether
    // to ask.
    expect(tab).toContain('acceptAiConsent()')
    expect(hasAiConsent({ consentAcceptedAtMs: 1_700_000_000_000 })).toBe(true)
    expect(hasAiConsent({})).toBe(false)
    expect(hasAiConsent(undefined)).toBe(false)
  })

  it('★ the retroactive-notice path is gone, not left dormant', () => {
    /*
     * REQ-0559 §2-2: do not silently keep code that can no longer fire. With
     * every-time asking, an already-configured user meets the full dialog the
     * next time they act — same text, better moment than a popup for opening a
     * tab — so the second mode had nothing left to do.
     */
    expect(tab).not.toContain('needsAiRetroactiveNotice')
    expect(tab).not.toContain('markAiNoticeSeen')
    expect(tab).not.toContain("mode: 'notice'")
    const dialog = read('src/renderer/components/ai-consent-dialog/ai-consent-dialog.tsx')
    expect(dialog).not.toContain("'gate' | 'notice'")
    expect(read('src/shared/ai-consent.ts')).not.toContain('noticeSeenAtMs?')
    expect(read('src/renderer/stores/settings-store.ts')).not.toContain('markAiNoticeSeen')
  })

  it('an old settings.json carrying the retired key still loads', () => {
    // The key is simply dropped — not a crash, and not mistaken for consent.
    expect(sanitizeAiConsent({ consentAcceptedAtMs: 5, noticeSeenAtMs: 6 }))
      .toEqual({ consentAcceptedAtMs: 5 })
  })
})

describe('REQ-0551 — reading the record off disk', () => {
  it('absent or malformed means "not agreed, not told"', () => {
    for (const bad of [undefined, null, 'yes', 42, [], {}]) {
      expect(sanitizeAiConsent(bad)).toEqual({})
      expect(hasAiConsent(sanitizeAiConsent(bad))).toBe(false)
    }
  })

  it('★ a non-numeric timestamp is NOT mistaken for agreement', () => {
    // The safe direction is to re-ask.
    expect(sanitizeAiConsent({ consentAcceptedAtMs: true })).toEqual({})
    expect(sanitizeAiConsent({ consentAcceptedAtMs: '2026-01-01' })).toEqual({})
    expect(sanitizeAiConsent({ consentAcceptedAtMs: NaN })).toEqual({})
  })

  it('a valid record survives', () => {
    expect(sanitizeAiConsent({ consentAcceptedAtMs: 5, junk: 1 }))
      .toEqual({ consentAcceptedAtMs: 5 })
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
    // The store sanitizes, so an old file lands on `{}` — not a crash, and not
    // silent consent.
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
    // `onDismiss` never calls `acceptAiConsent` and never runs the pending
    // action — the pending action is dropped with the dialog state.
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

/**
 * ★ REQ-0559 §1 / §3-1 — the false claim must not come back.
 *
 * The AI tab shipped with 「処理はすべてこの PC の中で完結します。」 sitting a few
 * pixels from a dialog that says the opposite, and the `.mcpb` manifest carried
 * the same sentence into Claude Desktop's install screen — the one place a user
 * reads it while connecting MOJIOKO to a remote assistant. The owner found it in
 * the packaged build, not a test, which is why this guard exists.
 *
 * The claim is TRUE elsewhere (transcription, translation and burn-in really do
 * run locally), so this checks the AI-integration surfaces specifically rather
 * than banning the phrase from the product.
 */
describe('REQ-0559 §1 — no "everything stays on this PC" claim on AI surfaces', () => {
  /** Files that describe AI integration, in either language. */
  const AI_SURFACES = [
    'src/main/mcp/mcpb.ts',
    'src/renderer/components/settings-dialog/ai-integration-tab.tsx',
    'src/renderer/components/ai-consent-dialog/ai-consent-dialog.tsx',
  ]

  /*
   * Phrasings of the UNQUALIFIED claim, in both languages.
   *
   * Deliberately NOT 'すべてこの PC' on its own: the consent dialog says
   * 「MOJIOKO の処理そのものは、これまでどおりすべてこの PC で行われます。ただし…」,
   * which is accurate — the processing really is local, and the sentence goes on
   * to say what is not. Banning the fragment would ban the correct wording along
   * with the wrong one.
   */
  const CLAIMS = [
    'この PC の中で完結',
    'この PC 内で完結',
    'このPCで完結',
    'Everything runs locally',
    'everything stays on this PC',
  ]

  /*
   * Comments are stripped before source checks: this REQ's code comments QUOTE
   * the retired sentence to explain why it went, and a guard that punished
   * documenting the fix would push the next person to delete the explanation.
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const aiStrings = (file: 'ja' | 'en'): string => {
    const all = JSON.parse(read(`src/renderer/locales/${file}/settings.json`)) as Record<string, unknown>
    return JSON.stringify((all as { ai?: unknown }).ai ?? {})
  }

  it('★ the AI settings strings make no such claim (ja + en)', () => {
    for (const lang of ['ja', 'en'] as const) {
      const blob = aiStrings(lang)
      for (const claim of CLAIMS) {
        expect(blob, `${lang} ai.* must not claim "${claim}"`).not.toContain(claim)
      }
    }
  })

  it('★ the .mcpb manifest description makes no such claim', () => {
    // This one is shown by Claude Desktop at install time.
    const src = stripComments(read('src/main/mcp/mcpb.ts'))
    // The MANIFEST's description, not the `McpbToolInfo` interface field of the
    // same name — slice from the manifest literal.
    const manifest = src.slice(src.indexOf("manifest_version:"))
    const desc = manifest.slice(manifest.indexOf('description:'), manifest.indexOf('author:'))
    for (const claim of CLAIMS) {
      expect(desc, `manifest description must not claim "${claim}"`).not.toContain(claim)
    }
    // …and it must still say where the data DOES go.
    expect(desc).toContain('AI 提供者に送信されます')
  })

  it('★ no AI-integration source file carries the claim', () => {
    for (const f of AI_SURFACES) {
      const src = stripComments(read(f))
      for (const claim of CLAIMS) {
        expect(src, `${f} must not claim "${claim}"`).not.toContain(claim)
      }
    }
  })

  it('the boundary is stated PERMANENTLY on the tab, not only in the dialog', () => {
    // REQ-0559 §1-2: readable any time without triggering anything. It renders
    // the dialog's own strings, so the two cannot drift apart.
    const tab = read('src/renderer/components/settings-dialog/ai-integration-tab.tsx')
    const beforeDialog = tab.slice(0, tab.indexOf('<AiConsentDialog'))
    expect(beforeDialog).toContain("t('ai.consent.staysLocal')")
    expect(beforeDialog).toContain("t('ai.consent.leaves')")
    expect(beforeDialog).toContain("t('ai.privacyTitle')")
  })

  it('the claim IS still allowed where it is true (transcription / burn-in)', () => {
    // Whisper and the burn really do run locally with no network. Banning the
    // sentence product-wide would delete a true and useful statement.
    const step1 = JSON.parse(read('src/renderer/locales/ja/step1.json')) as { footer: { privacyNote: string } }
    expect(step1.footer.privacyNote).toContain('完結')
  })
})

/**
 * ★ REQ-0561 — exporting the bundle must not open an Explorer window.
 *
 * The auto-open dated from the drag-and-drop era. Claude Desktop's
 * 拡張機能をインストール opens its own file picker now, so Explorer is never
 * part of the flow — and the user picked the save location one dialog earlier.
 *
 * Checked at the source because the alternative is mounting the tab with a
 * mocked `window.electronAPI` and a fake save dialog, which would test the
 * harness more than the behaviour. What matters is a single line's absence,
 * and that the two real success signals are still there.
 */
describe('REQ-0561 — no Explorer window after a .mcpb export', () => {
  const tab = read('src/renderer/components/settings-dialog/ai-integration-tab.tsx')
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const code = stripComments(tab)

  it('★ the export path opens no folder', () => {
    expect(code).not.toContain('shellShowInFolder')
    expect(code).not.toContain('shellOpenPath')
  })

  it('★ …and the success feedback is still there', () => {
    // Removing the window must not quietly remove the confirmation with it:
    // the toast, and the bundle-status block's refresh.
    const handler = code.slice(code.indexOf('const handleExport'), code.indexOf('const copy'))
    expect(handler).toContain("toast.success(t('ai.exportToast'))")
    expect(handler).toContain('getMcpLaunchSpec().then(setSpec)')
    // The dev / broken-bundle warnings survive too.
    expect(handler).toContain("t('ai.devExportToast')")
    expect(handler).toContain("t('ai.proxyMissing')")
  })

  it('★ the user-initiated "open folder" buttons elsewhere are untouched', () => {
    /*
     * REQ-0561 §1-3: only the AUTOMATIC open goes. Every other call site is a
     * button the user pressed asking for exactly this, and deleting those would
     * be a different (unrequested) change.
     */
    for (const [file, needle] of [
      ['src/renderer/components/step2/burnin-drawer.tsx', 'shellShowInFolder(completedPath)'],
      ['src/renderer/components/step2/burnin-drawer.tsx', 'shellOpenPath(completedPath)'],
      ['src/renderer/components/video-preview/video-preview-panel.tsx', 'shellShowInFolder(video.path)'],
      ['src/renderer/components/audio-preview/audio-preview-panel.tsx', 'shellShowInFolder(video.path)'],
    ] as const) {
      expect(read(file), `${file} must keep ${needle}`).toContain(needle)
    }
  })
})

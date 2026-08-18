/**
 * REQ-0526 §3-2 — the DEV token editor must not reach an end-user build.
 *
 * The guarantee is a build-time one: `App.tsx` mounts the panel behind
 * `{import.meta.env.DEV && <DevTokenEditor />}`, `electron-vite build` folds
 * that constant to `false`, and Rollup drops the branch, the import, and the
 * whole module subtree behind it.
 *
 * Until now that was asserted exactly once, by hand, in RES-0414 — a grep
 * someone ran in 2026-08 and wrote down. Nothing re-ran it. REQ-0526 widens
 * the panel (a new group, a new control kind, a new export block), which is
 * precisely the kind of change that could accidentally pull it into the
 * production graph — e.g. by having a shipped module import something from
 * `lib/dev-tokens.ts`, which would defeat the tree-shake without touching
 * App.tsx at all.
 *
 * This spec lives in `tests/e2e/` rather than `tests/unit/` for one reason:
 * e2e is the only suite that runs against the PRODUCTION renderer bundle.
 * `playwright.config.ts` requires `npm run build` first and every spec loads
 * `out/renderer/index.html`, so `out/` is guaranteed to exist and to have been
 * built in production mode. A vitest unit test would have to either skip when
 * `out/` is missing (silently green — the failure mode CLAUDE.md §18 warns
 * about) or fail on a fresh clone.
 *
 * Two independent checks, because they fail in different ways:
 *   1. STATIC  — the panel's strings are absent from the built assets.
 *   2. RUNTIME — pressing Ctrl+Shift+D in the shipped app does nothing.
 * A build could pass (1) and fail (2) if the panel were re-added under a
 * different name, and pass (2) and fail (1) if it shipped but were unreachable
 * (dead weight, and still readable by anyone with devtools).
 *
 * ★ Negative controls (CLAUDE.md §18 "負の対照に git checkout を使わない"):
 * both checkers are pure functions over their input, so each is re-run against
 * a deliberately-poisoned input — a synthetic bundle string containing the
 * markers, and a live DOM with a fake panel injected. No git, no source swap.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

/**
 * Strings that exist ONLY in the dev-editor module subtree. Chosen to survive
 * minification: they are string literals / JSX text / attribute names, not
 * identifiers (Rollup renames identifiers, so `DevTokenEditor` alone would be
 * a weak marker).
 */
const MARKERS = [
  'Dev Token Editor', //                     panel header text
  'data-dev-panel', //                       the panel root's attribute
  'Developer token editor', //               its aria-label
  'Ctrl+Shift+D · live · not shipped', //    the hint line under the header
  'Show token overlay', //                   REQ-0420 overlay toggle
  'dev-token-editor export', //              the REQ-0414 export banner
  'paste into the REQ', //                   REQ-0526 export block title
  'Edited state — weights', //               REQ-0526 alpha group title
]
/*
 * The hint line is matched in FULL rather than as the bare shortcut, and that
 * is not fussiness: the first run of this spec failed on `Ctrl+Shift+D`
 * appearing in the production CSS — from a globals.css *comment* this very REQ
 * had just written, because authored CSS comments survive into the built
 * stylesheet. A marker that a doc comment can trip is a marker that will cry
 * wolf. The full rendered string cannot appear by accident.
 */

/** Which markers appear in `text`. Pure, so the negative control can reuse it. */
function markersFound(text: string): string[] {
  return MARKERS.filter((m) => text.includes(m))
}

/** Whether a document currently shows the panel. Pure over the probe result. */
function panelViolations(probe: { devPanels: number; dialogsNamed: number }): string[] {
  const v: string[] = []
  if (probe.devPanels > 0) v.push(`${probe.devPanels} [data-dev-panel] element(s) in the shipped app`)
  if (probe.dialogsNamed > 0) v.push(`${probe.dialogsNamed} element(s) labelled "Developer token editor"`)
  return v
}

test('the dev token editor is not in the shipped build — REQ-0526', async () => {
  // --- 1. STATIC: scan the built renderer assets -----------------------------
  const assetsDir = path.resolve(__dirname, '../../out/renderer/assets')
  expect(fs.existsSync(assetsDir),
    `${assetsDir} does not exist — run \`npm run build\` before the e2e suite (playwright.config.ts says so)`)
    .toBe(true)

  const files = fs.readdirSync(assetsDir).filter((f) => /\.(js|css)$/.test(f))
  // If the bundle layout ever changes so this globs nothing, the scan below
  // would trivially "pass". Refuse to be vacuous.
  expect(files.length, `no .js/.css assets found in ${assetsDir} — the scan would prove nothing`)
    .toBeGreaterThan(0)

  const hits: Record<string, string[]> = {}
  let scannedBytes = 0
  for (const f of files) {
    const text = fs.readFileSync(path.join(assetsDir, f), 'utf-8')
    scannedBytes += text.length
    const found = markersFound(text)
    if (found.length > 0) hits[f] = found
  }
  // eslint-disable-next-line no-console
  console.log(`\n[REQ-0526] scanned ${files.length} asset(s), ${scannedBytes} bytes:`, JSON.stringify(files))
  expect(hits, 'dev-editor strings found in the production bundle').toEqual({})

  // Negative control for the static half: the same scanner over a synthetic
  // "bundle" that DOES contain the panel must report it.
  const poisoned = markersFound(`function x(){}\n/* ${MARKERS[0]} */\n<div ${MARKERS[1]}="">`)
  expect(poisoned, 'the marker scanner no longer detects the panel — it has stopped proving anything')
    .toContain(MARKERS[0])
  expect(poisoned).toContain(MARKERS[1])

  // --- 2. RUNTIME: the shortcut does nothing in the shipped app -------------
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000,
  })
  const window = await electronApp.firstWindow()
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

  const PROBE = `(() => ({
    devPanels: document.querySelectorAll('[data-dev-panel]').length,
    dialogsNamed: document.querySelectorAll('[aria-label="Developer token editor"]').length,
  }))()`

  // Press it the way a curious user would, more than once (it is a toggle, so
  // a single press landing on "closed" would look like absence).
  for (let i = 0; i < 3; i++) {
    await window.keyboard.press('Control+Shift+D')
    await window.waitForTimeout(120)
  }
  const probe = (await window.evaluate(PROBE)) as { devPanels: number; dialogsNamed: number }
  // eslint-disable-next-line no-console
  console.log('[REQ-0526] after 3× Ctrl+Shift+D:', JSON.stringify(probe))
  expect(panelViolations(probe), 'the dev panel opened in a production build').toEqual([])

  // Negative control for the runtime half: inject a fake panel and prove the
  // same checker flags it. Perturbs the live DOM only.
  const injected = await window.evaluate(() => {
    const el = document.createElement('div')
    el.setAttribute('data-dev-panel', '')
    el.setAttribute('aria-label', 'Developer token editor')
    document.body.appendChild(el)
    return document.querySelectorAll('[data-dev-panel]').length
  })
  expect(injected, 'the negative control injected nothing — it has stopped perturbing the check').toBe(1)

  const poisonedProbe = (await window.evaluate(PROBE)) as { devPanels: number; dialogsNamed: number }
  const caught = panelViolations(poisonedProbe)
  // eslint-disable-next-line no-console
  console.log('[REQ-0526] negative control caught:', JSON.stringify(caught))
  expect(caught.join(' | '), 'a planted dev panel went undetected — the runtime check proves nothing')
    .toContain('[data-dev-panel]')

  await electronApp.close()
})

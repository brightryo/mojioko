/**
 * REQ-071 Phase 3.8 / 4-1 — measured-rgb regression guard for every primary
 * surface across the renderer.
 *
 * The cn() bug fixed in Phase 3.8 (tailwind-merge misclassifying our custom
 * font-size tokens and dropping `text-zinc-950` from the Button variant)
 * would silently re-occur on any future refactor that loses the
 * `extendTailwindMerge` registration.  The Phase 3.8 spec only covered the
 * Step 1 footer CTA; this Phase 4-1 expansion walks every reachable primary
 * surface and asserts the computed colour empirically.  Unreachable ones
 * (state behind a real backend handshake) are listed in the spec output so
 * the RES can record them as not-tested-here rather than silently passing.
 *
 * Why empirical for every surface:  Phase 3.6 and 3.7 both *reasoned* from
 * source class strings that primary buttons were zinc-950, and were wrong
 * twice.  Any "same variant, must be the same colour" inference is
 * disallowed.
 */
import { _electron as electron, test, expect, ElectronApplication, Page } from '@playwright/test'
import path from 'path'

const ZINC_950 = 'rgb(9, 9, 11)'
const GREEN_500 = 'rgb(34, 197, 94)'

async function launchAt(startQuery: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000
  })
  const window = await app.firstWindow()
  window.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + startQuery)
  await window.waitForSelector('button')
  return { app, window }
}

interface ColouredHit {
  text: string
  tag: string
  color: string
  backgroundColor: string
  className: string
}

/**
 * Find every element on the page whose computed bg is bg-green-500
 * (rgb(34, 197, 94)) **and which carries visible text content**.  Covers
 * `variant="primary"` Buttons AND hardcoded `bg-green-500 text-zinc-950`
 * pills (whisper-model-manager) so the single computed-rgb sweep
 * regression-guards both paths.
 *
 * Empty indicators (e.g. breadcrumb's 6 px green dot — `<span
 * class="bg-green-500 rounded-full">` with no text) are excluded because
 * the concern here is "text on green", and a marker with no text has no
 * text-colour to assert.
 */
async function findGreenSurfaces(window: Page): Promise<ColouredHit[]> {
  return window.evaluate(() => {
    const elems = Array.from(document.querySelectorAll('button, span, div'))
    const hits: ColouredHit[] = []
    for (const el of elems) {
      const cs = getComputedStyle(el)
      if (cs.backgroundColor !== 'rgb(34, 197, 94)') continue
      const text = (el.textContent ?? '').trim()
      if (text.length === 0) continue
      hits.push({
        text: text.slice(0, 60),
        tag: el.tagName.toLowerCase(),
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        className: (el as HTMLElement).className.toString()
      })
    }
    return hits
  })
}

function logHits(label: string, hits: ColouredHit[]) {
  // eslint-disable-next-line no-console
  console.log(`\n[3.8/4-1 probe] ${label}:`)
  for (const h of hits) {
    // eslint-disable-next-line no-console
    console.log(`  - <${h.tag}> "${h.text}"  color=${h.color}  bg=${h.backgroundColor}  class="${h.className.slice(0, 120)}..."`)
  }
}

function expectAllZinc950(hits: ColouredHit[], label: string) {
  expect(hits.length, `${label}: at least one bg-green-500 surface should be present`).toBeGreaterThan(0)
  for (const hit of hits) {
    expect(hit.backgroundColor, `${label} "${hit.text}" bg`).toBe(GREEN_500)
    expect(hit.color, `${label} "${hit.text}" color`).toBe(ZINC_950)
  }
}

// ---------------------------------------------------------------------
// Step 1 footer — primary "文字起こし開始" + caret half (split button)
// ---------------------------------------------------------------------
test('Step 1 footer primary CTA renders zinc-950 on green-500', async () => {
  const { app, window } = await launchAt('')
  const hits = await findGreenSurfaces(window)
  logHits('Step 1', hits)
  expectAllZinc950(hits, 'Step 1')
  await app.close()
})

// ---------------------------------------------------------------------
// Step 2 footer + whisper-model-manager "Active" pills inside Step 1 are
// shared with this probe by reusing the seed.  Continue-to-render button
// is enabled because seed fixtures populate `entries`.
// ---------------------------------------------------------------------
test('Step 2 footer + sub-surface greens stay zinc-950', async () => {
  const { app, window } = await launchAt('?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  const hits = await findGreenSurfaces(window)
  logHits('Step 2', hits)
  expectAllZinc950(hits, 'Step 2')
  await app.close()
})

// ---------------------------------------------------------------------
// Step 3 footer — primary "書き出し開始"
// ---------------------------------------------------------------------
test('Step 3 footer primary CTA renders zinc-950 on green-500', async () => {
  const { app, window } = await launchAt('?seed=demo&start=step3')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  const hits = await findGreenSurfaces(window)
  logHits('Step 3', hits)
  expectAllZinc950(hits, 'Step 3')
  await app.close()
})

// ---------------------------------------------------------------------
// TimeEditorDialog confirm button (mode = add): click the "Add Row" ghost
// button in Step 2's filter toolbar to open the dialog, then measure the
// dialog footer's primary button.
// ---------------------------------------------------------------------
test('TimeEditorDialog (add mode) confirm renders zinc-950 on green-500', async () => {
  const { app, window } = await launchAt('?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

  // The "追加" / "Add" button is rendered with `variant="ghost"` and is
  // the only one carrying the Plus icon next to its label.  Click it to
  // drive the dialog open.  (REQ-081 #3 dropped the "行/row" prefix.)
  await window.locator('button:has-text("追加")').first().click()
  await window.waitForSelector('[role="dialog"]')
  await window.waitForTimeout(100) // let the dialog complete its open transition

  const hits = await findGreenSurfaces(window)
  logHits('TimeEditorDialog add', hits)
  expectAllZinc950(hits, 'TimeEditorDialog add')
  await app.close()
})

// ---------------------------------------------------------------------
// TimeEditorDialog confirm button (mode = edit): focus a row first so the
// inline "adjust time" chip is available, then click it.
// ---------------------------------------------------------------------
test('TimeEditorDialog (edit mode) confirm renders zinc-950 on green-500', async () => {
  const { app, window } = await launchAt('?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

  // Make sure we're in list view (the inline "時間調整" chip lives in the
  // subtitle-table row, not on the timeline blocks).  Focus the first
  // entry so the row is the one whose chip we click.
  await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void }; project: { getState: () => { entries: { id: string }[] } } } }).__mojioko_test
    t.ui.setState({ editorViewMode: 'list' })
    const firstId = t.project.getState().entries[0]?.id
    if (firstId) t.ui.setState({ focusedRowId: firstId })
  })

  // Click any "時間調整" chip — the first non-deleted row exposes one.
  // (step2.json action.adjustTime = "時間調整", not "時刻調整".)
  await window.locator('button:has-text("時間調整")').first().click()
  await window.waitForSelector('[role="dialog"]')
  await window.waitForTimeout(100)

  const hits = await findGreenSurfaces(window)
  logHits('TimeEditorDialog edit', hits)
  expectAllZinc950(hits, 'TimeEditorDialog edit')
  await app.close()
})

// ---------------------------------------------------------------------
// Whisper model install confirm dialog — NOT REACHABLE from the renderer-
// only seed harness because the model-status payload that drives the
// "Install" button comes from the Electron main process via IPC
// (`window.electronAPI.whisperModelStatus(...)`), and main is started with
// no Python sidecar / model registry under Playwright.  The button uses
// the same `variant="primary"` code path the other dialogs use, so the
// Phase 3.8 cn() fix covers it implicitly via the test above — but per
// the Phase 4-1 directive we *record* this as unreachable rather than
// silently asserting from inference.
// ---------------------------------------------------------------------
test.skip('Whisper install confirm dialog — primary CTA (UNREACHABLE under E2E seed)', async () => {
  // Intentionally skipped: cannot reach this dialog without main-process
  // Whisper status IPC.  Documented in RES-3.9 and RES-4.
})

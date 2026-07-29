/**
 * REQ-071 Phase 3.8 / 4-1 — measured-rgb regression guard for every primary
 * surface across the renderer.
 *
 * ## What this actually protects
 *
 * The `cn()` bug fixed in Phase 3.8 (tailwind-merge misclassifying our custom
 * font-size tokens and dropping the foreground class from the Button variant)
 * would silently re-occur on any future refactor that loses the
 * `extendTailwindMerge` registration.  The symptom is a primary CTA that keeps
 * its accent background but loses its paired foreground — a contrast failure
 * nobody notices in a diff.
 *
 * Why empirical for every surface: Phase 3.6 and 3.7 both *reasoned* from
 * source class strings that primary buttons were correct, and were wrong
 * twice.  Any "same variant, must be the same colour" inference is disallowed
 * — every surface is measured in a real Electron window.
 *
 * ## REQ-0344 §3 — why the assertions no longer name a colour
 *
 * This spec sat red for five weeks.  It pinned two literals — `rgb(34,197,94)`
 * (green-500) for the background and `rgb(9,9,11)` (zinc-950) for the text —
 * and the design system deliberately moved off both:
 *
 *   - `706e9b4` (REQ-20260615-026, 2026-06-20) repointed `--text-inverse` at
 *     the neutral ramp, so the FOREGROUND assertion started failing.
 *   - `daf156e` (REQ-0177 Phase A, 2026-07-11) retuned `--primary` from
 *     green-500 to `152 42% 47%` (~#3EA97B) — "saturation pulled ~40 % lower
 *     so it registers as professional instead of notification popup".  From
 *     then on the finder matched ZERO elements, so the count assertion fired
 *     first and masked the older foreground failure.
 *
 * Both changes were intended and documented (REQ-0177 §92, RES-0177 §117), and
 * neither is a UI regression: the CTA is still present and still
 * `variant="primary"` (`routes/step1.tsx`, `routes/step2.tsx`).  The test was
 * asserting a palette rather than the property it was written to defend.
 * Since `2a45366` there is no hardcoded `bg-green-500` anywhere in `src/` —
 * every accent flows through `--primary` — so a literal here could only ever
 * go stale again.
 *
 * The invariant that survives a retune, and is the one Phase 3.8 cared about:
 *
 *   **every primary CTA paints the `--primary` background WITH its paired
 *   `--text-inverse` foreground, and each screen has at least one.**
 *
 * So the expected pair is read from the live stylesheet at runtime, by
 * mounting a probe carrying the same two utility classes the Button variant
 * applies and measuring IT.  Every assertion stays empirical (the rule this
 * file exists to enforce), it still fails loudly if the foreground is dropped
 * or a CTA loses its variant, and it needs no edit the next time the palette
 * is tuned.  The filename is kept for continuity with REQ-071; the colour in
 * it is no longer green.
 */
import { _electron as electron, test, expect, ElectronApplication, Page } from '@playwright/test'
import path from 'path'

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

/** The computed `bg-primary` / `text-fg-inverse` pair, as the theme resolves them now. */
interface PrimaryPair {
  bg: string
  fg: string
}

/**
 * Resolve the primary pair from the live stylesheet instead of hardcoding it.
 *
 * Mounting a probe that carries the real utility classes means the expectation
 * tracks whatever `--primary` / `--text-inverse` are today — including across
 * a light/dark toggle — without this file knowing any colour value.
 */
async function readPrimaryPair(window: Page): Promise<PrimaryPair> {
  const pair = await window.evaluate(() => {
    const probe = document.createElement('div')
    // The exact classes `buttonVariants` applies for `variant="primary"`
    // (components/ui/button.tsx).
    probe.className = 'bg-primary text-fg-inverse'
    probe.textContent = 'probe'
    document.body.appendChild(probe)
    const cs = getComputedStyle(probe)
    const resolved = { bg: cs.backgroundColor, fg: cs.color }
    probe.remove()
    return resolved
  })
  // A theme that failed to load would resolve both to transparent/black and
  // make every assertion below vacuous.
  expect(pair.bg, 'bg-primary resolved to nothing — did the stylesheet load?')
    .toMatch(/^rgb\(/)
  expect(pair.fg, 'text-fg-inverse resolved to nothing').toMatch(/^rgb\(/)
  expect(pair.bg, 'primary background and foreground must differ').not.toBe(pair.fg)
  return pair
}

/**
 * Find every element whose computed background IS the primary token **and
 * which carries visible text**.  Covers `variant="primary"` Buttons and any
 * hardcoded accent pill, so one computed-rgb sweep guards both paths.
 *
 * Empty indicators (e.g. the breadcrumb's 6 px accent dot) are excluded: the
 * concern is "text on accent", and a marker with no text has no text-colour to
 * assert.  Translucent accents (`bg-primary/10` on the active font row) compute
 * to `rgba(...)` and so never match the opaque `rgb(...)` pair.
 */
async function findPrimarySurfaces(window: Page, pair: PrimaryPair): Promise<ColouredHit[]> {
  return window.evaluate((expected) => {
    const elems = Array.from(document.querySelectorAll('button, span, div'))
    const hits: ColouredHit[] = []
    for (const el of elems) {
      const cs = getComputedStyle(el)
      if (cs.backgroundColor !== expected.bg) continue
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
  }, pair)
}

function logHits(label: string, pair: PrimaryPair, hits: ColouredHit[]) {
  // eslint-disable-next-line no-console
  console.log(`\n[REQ-071 3.8/4-1 probe] ${label} (primary bg=${pair.bg} fg=${pair.fg}):`)
  for (const h of hits) {
    // eslint-disable-next-line no-console
    console.log(`  - <${h.tag}> "${h.text}"  color=${h.color}  bg=${h.backgroundColor}  class="${h.className.slice(0, 120)}..."`)
  }
}

function expectPairedForeground(hits: ColouredHit[], pair: PrimaryPair, label: string) {
  expect(
    hits.length,
    `${label}: no primary-background surface found. Either a CTA lost ` +
    `variant="primary", or the accent token stopped resolving.`,
  ).toBeGreaterThan(0)
  for (const hit of hits) {
    expect(hit.backgroundColor, `${label} "${hit.text}" bg`).toBe(pair.bg)
    // The Phase 3.8 regression itself: background kept, paired foreground lost.
    expect(hit.color, `${label} "${hit.text}" color`).toBe(pair.fg)
  }
}

/** Launch, measure, assert — the shape every screen-level case shares. */
async function checkScreen(startQuery: string, label: string, seeded: boolean) {
  const { app, window } = await launchAt(startQuery)
  try {
    if (seeded) {
      await window.waitForFunction(() =>
        Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
    }
    const pair = await readPrimaryPair(window)
    const hits = await findPrimarySurfaces(window, pair)
    logHits(label, pair, hits)
    expectPairedForeground(hits, pair, label)
  } finally {
    await app.close()
  }
}

// ---------------------------------------------------------------------
// Step 1 footer — primary "文字起こし開始" + caret half (split button)
// ---------------------------------------------------------------------
test('Step 1 footer primary CTA pairs the accent bg with its inverse text', async () => {
  await checkScreen('', 'Step 1', false)
})

// ---------------------------------------------------------------------
// Step 2 footer + sub-surface accents.  Continue-to-render is enabled
// because the seed fixtures populate `entries`.
// ---------------------------------------------------------------------
test('Step 2 footer + sub-surface accents keep the inverse text', async () => {
  await checkScreen('?seed=demo&start=step2', 'Step 2', true)
})

// ---------------------------------------------------------------------
// Step 3 footer — primary "書き出し開始"
// ---------------------------------------------------------------------
test('Step 3 footer primary CTA pairs the accent bg with its inverse text', async () => {
  await checkScreen('?seed=demo&start=step3', 'Step 3', true)
})

// ---------------------------------------------------------------------
// TimeEditorDialog confirm button (mode = add): click the "Add Row" ghost
// button in Step 2's filter toolbar to open the dialog, then measure the
// dialog footer's primary button.
// ---------------------------------------------------------------------
test('TimeEditorDialog (add mode) confirm pairs the accent bg with its inverse text', async () => {
  const { app, window } = await launchAt('?seed=demo&start=step2')
  try {
    await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

    // REQ-129 Step 2 — locale-independent selector.  The Add-row button
    // ships with `data-testid="add-row"` so the e2e works regardless of
    // DEFAULT_LANGUAGE (the previous `:has-text("追加")` matcher broke
    // when the default switched to 'en').
    await window.locator('[data-testid="add-row"]').first().click()
    await window.waitForSelector('[role="dialog"]')
    await window.waitForTimeout(100) // let the dialog complete its open transition

    const pair = await readPrimaryPair(window)
    const hits = await findPrimarySurfaces(window, pair)
    logHits('TimeEditorDialog add', pair, hits)
    expectPairedForeground(hits, pair, 'TimeEditorDialog add')
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------------
// TimeEditorDialog confirm button (mode = edit): focus a row first so the
// inline "adjust time" chip is available, then click it.
// ---------------------------------------------------------------------
test('TimeEditorDialog (edit mode) confirm pairs the accent bg with its inverse text', async () => {
  const { app, window } = await launchAt('?seed=demo&start=step2')
  try {
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

    // REQ-129 Step 2 — locale-independent selector.  Each subtitle-table
    // row mounts the same `data-testid="adjust-time"` on its time-edit
    // chip; `.first()` clicks the first non-frozen row.  Works under
    // DEFAULT_LANGUAGE='en' where the label is "Adjust time".
    await window.locator('[data-testid="adjust-time"]').first().click()
    await window.waitForSelector('[role="dialog"]')
    await window.waitForTimeout(100)

    const pair = await readPrimaryPair(window)
    const hits = await findPrimarySurfaces(window, pair)
    logHits('TimeEditorDialog edit', pair, hits)
    expectPairedForeground(hits, pair, 'TimeEditorDialog edit')
  } finally {
    await app.close()
  }
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

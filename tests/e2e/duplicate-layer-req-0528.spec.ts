/**
 * REQ-0528 §3-1 — the two fixes, exercised through the REAL app rather than as
 * pure functions (that half is `tests/unit/duplicate-layer-and-duration-req-0528`).
 *
 * Duplication goes through the actual Ctrl+D shortcut, so this covers the whole
 * live path — shortcut handler → `duplicateRow` → free-layer search → store
 * write → toast — which is where the owner hit the bug. The unit test can only
 * prove the search is right; only this can prove the search is WIRED.
 *
 * The negative controls live in the unit file: they perturb pure expressions,
 * which is both cheaper and more precise than trying to un-fix a running app.
 * What this file adds is the wiring, and a rendered-pixel check that the ruler
 * really stops at the end of the footage.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const OUT = path.resolve(__dirname, '../../dev-docs/reports/req-0528')

interface TestHandle {
  project: {
    getState: () => { entries: Record<string, unknown>[]; video: { durationSec: number } | null }
    setState: (s: unknown) => void
  }
  ui: { setState: (s: unknown) => void; getState: () => { selectedEntryId: string | null } }
}

test('duplicating climbs to a free layer, blocks at the cap, and the ruler stops at the video end — REQ-0528', async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000,
  })
  const window = await electronApp.firstWindow()
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1600, 900)
  })

  // ---------------------------------------------------------------------------
  // §1 — three duplicates of ONE source must land on layers 1, 2, 3.
  // ---------------------------------------------------------------------------
  const sourceId = await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test
    const entries = t.project.getState().entries.map((e) => ({ ...e }))
    // One source on layer 0; everything else out of the way and deleted so the
    // only occupants of the 0-5 s span are the ones this test creates.
    entries[0] = { ...entries[0], isDeleted: false, layer: 0, startSec: 0, endSec: 5, text: 'ZZSRC' }
    for (let i = 1; i < entries.length; i++) entries[i] = { ...entries[i], isDeleted: true }
    t.project.setState({ entries })
    t.ui.setState({ editorViewMode: 'timeline', selectedEntryId: entries[0].id, timelinePixelsPerSec: 100 })
    return entries[0].id as string
  })
  expect(sourceId, 'seed produced no source entry').toBeTruthy()
  await window.waitForTimeout(500)

  const layersAfterEachDuplicate: number[] = []
  for (let i = 0; i < 3; i++) {
    // Re-select the SOURCE each time — this is exactly the owner's sequence
    // (duplicate the original again, not the copy).
    await window.evaluate((id: string) => {
      ;(window as unknown as { __mojioko_test: TestHandle }).__mojioko_test.ui.setState({ selectedEntryId: id })
    }, sourceId)
    await window.waitForTimeout(150)
    await window.keyboard.press('Control+d')
    await window.waitForTimeout(400)
    const layer = await window.evaluate((id: string) => {
      const t = (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test
      const sel = t.ui.getState().selectedEntryId
      const e = t.project.getState().entries.find((x) => x.id === sel && x.id !== id)
      return e ? ((e.layer as number) ?? 0) : -1
    }, sourceId)
    layersAfterEachDuplicate.push(layer)
  }

  // eslint-disable-next-line no-console
  console.log('\n[REQ-0528] layers of three successive duplicates:', JSON.stringify(layersAfterEachDuplicate))
  expect(
    layersAfterEachDuplicate,
    'duplicating the same cue three times must climb 1 → 2 → 3; before REQ-0528 ' +
      'every copy landed on layer 1 and stacked on its predecessor',
  ).toEqual([1, 2, 3])

  await window.screenshot({ path: path.join(OUT, 'duplicates-climb-layers.png') })

  // ---------------------------------------------------------------------------
  // §1-3 — at the cap: a toast, and NOTHING added.
  // ---------------------------------------------------------------------------
  const before = await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test
    const entries = t.project.getState().entries.map((e) => ({ ...e }))
    // Park the source at the top of the range; the search starts above it and
    // immediately runs out of room.
    const src = entries.find((e) => e.text === 'ZZSRC')!
    src.layer = 50
    t.project.setState({ entries })
    t.ui.setState({ selectedEntryId: src.id })
    return entries.filter((e) => !e.isDeleted).length
  })
  await window.waitForTimeout(300)
  await window.keyboard.press('Control+d')
  await window.waitForTimeout(600)

  const toastText = await window.evaluate(() => document.body.innerText)
  const after = await window.evaluate(
    () =>
      (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test.project
        .getState()
        .entries.filter((e) => !e.isDeleted).length,
  )

  expect(after, 'a blocked duplicate must add NOTHING — no half-applied state').toBe(before)
  expect(
    toastText,
    'the layer-cap block must tell the user why (existing rowDuplicateMaxLayer toast)',
  ).toMatch(/最大レイヤー|maximum layer/i)

  await window.screenshot({ path: path.join(OUT, 'max-layer-blocked-toast.png') })

  // ---------------------------------------------------------------------------
  // §2-3 — an over-long cue must not stretch the ruler past the footage.
  // ---------------------------------------------------------------------------
  const ruler = await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test
    const dur = t.project.getState().video?.durationSec ?? 0
    const entries = t.project.getState().entries.map((e) => ({ ...e }))
    const src = entries.find((e) => e.text === 'ZZSRC')!
    // A cue reaching well past the end — the state a legacy / relinked project
    // can still be in (REQ-0528 §2-5 deliberately does not rewrite those).
    src.layer = 0
    src.startSec = 0
    src.endSec = dur + 9
    src.isDeleted = false
    t.project.setState({ entries })
    return dur
  })
  await window.waitForTimeout(700)

  const widths = await window.evaluate(() => {
    const lane = document.querySelector('div[style*="height: 64px"]')?.parentElement as HTMLElement | null
    return lane ? { scrollWidth: lane.scrollWidth, offsetWidth: lane.offsetWidth } : null
  })
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0528] video duration', ruler, 'lane widths', JSON.stringify(widths))

  const pxPerSec = 100
  expect(widths, 'timeline clips lane not found').not.toBeNull()

  /*
   * `offsetWidth` — the lane's OWN width, which is `totalSec * pixelsPerSec`
   * and therefore the thing REQ-0528 §2-3 fixes. Deliberately not
   * `scrollWidth`: the over-long clip is a child box 881 s wide, so it
   * overflows the 872 s lane and inflates scrollWidth no matter what the ruler
   * does. Measuring scrollWidth here would report a failure that has nothing to
   * do with the ruler's length (it did, on the first run of this test).
   *
   * That overflow is the documented trade-off of §2-3: a cue past the end of
   * the footage is no longer fully reachable in the timeline. It stays visible
   * and editable in the list view, badged 時間超過, and confirming the time
   * dialog on it now pulls it into range.
   */
  const laneWidth = (widths as { offsetWidth: number }).offsetWidth
  expect(
    laneWidth,
    `the ruler must be the video's ${ruler}s (${ruler * pxPerSec}px at 100px/s), not the ` +
      `${ruler + 9}s cue; before REQ-0528 totalSec was max(duration, lastCueEnd)`,
  ).toBeLessThanOrEqual(Math.ceil((ruler + 1) * pxPerSec))
  expect(laneWidth, 'the ruler must not COLLAPSE either — it still spans the whole video')
    .toBeGreaterThanOrEqual(Math.floor((ruler - 1) * pxPerSec))

  await window.screenshot({ path: path.join(OUT, 'ruler-stops-at-video-end.png') })

  await electronApp.close()
})

/**
 * REQ-0528 §2-1 — the path that was actually leaking: the 「時間を調整」 dialog.
 *
 * The owner's exact report — a 7 s video, a cue stretched to 16 s — driven
 * through the real dialog (open from the list row's timecode button, type an
 * end time past the video, confirm) rather than by calling the clamp directly.
 * Timeline drag and right-edge resize were already clamped before this REQ
 * (both go through `computeDragPatch`); this is the one that was not.
 */
test('the time dialog cannot push a cue past the end of the video — REQ-0528 §2', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000,
  })
  const window = await electronApp.firstWindow()
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1600, 900)
  })

  // A 7 s video with a single 0–5 s cue: the owner's setup.
  const targetId = await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test
    const st = t.project.getState()
    const entries = st.entries.map((e) => ({ ...e }))
    entries[0] = { ...entries[0], isDeleted: false, layer: 0, startSec: 0, endSec: 5, text: 'ZZDUR' }
    for (let i = 1; i < entries.length; i++) entries[i] = { ...entries[i], isDeleted: true }
    t.project.setState({ entries, video: { ...(st.video as object), durationSec: 7 } })
    t.ui.setState({ editorViewMode: 'list', selectedEntryId: entries[0].id })
    return entries[0].id as string
  })
  expect(targetId).toBeTruthy()
  await window.waitForTimeout(700)

  await window.locator('[data-testid="adjust-time"]').first().click()
  await window.waitForTimeout(500)

  // The dialog's two timecode fields, in order: start, end.
  const fields = window.locator('[role="dialog"] input')
  await expect(fields).toHaveCount(2, { timeout: 5000 })
  const endField = fields.nth(1)
  await endField.click()
  await endField.fill('00:00:16.00')
  await endField.press('Enter')
  await window.waitForTimeout(300)

  /*
   * ★ The dialog must really be holding 16 s before we confirm.
   *
   * Without this the test passes for the wrong reason: the first version of it
   * clicked `button.last()`, which is Radix's X close control rather than
   * 適用, so the edit was discarded and the cue stayed at its original 5 s —
   * "endSec ≤ 7" was then true because NOTHING had happened.  A clamp gate that
   * a no-op satisfies is not a gate.
   */
  await expect(
    endField,
    'the dialog did not accept 16 s, so confirming it would prove nothing about clamping',
  ).toHaveValue('00:00:16.00')

  await window.screenshot({ path: path.join(OUT, 'time-dialog-16s-on-7s-video.png') })

  await window.locator('[data-testid="time-editor-confirm"]').click()
  await window.waitForTimeout(700)

  const result = await window.evaluate((id: string) => {
    const t = (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test
    const e = t.project.getState().entries.find((x) => x.id === id)
    return { startSec: e?.startSec as number, endSec: e?.endSec as number }
  }, targetId)
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0528] after confirming 16s on a 7s video:', JSON.stringify(result))

  expect(
    result.endSec,
    'the dialog wrote an endSec past the end of the video — this is the exact ' +
      'REQ-0528 §2 report (16 s on a 7 s video)',
  ).toBeLessThanOrEqual(7)
  // …and it must have been CLAMPED, not rejected: the confirm has to land, so
  // the cue actually moves from its original 5 s up to the 7 s ceiling.
  expect(
    result.endSec,
    'the edit was discarded rather than clamped — the user pressed 適用 and ' +
      'must get the nearest legal value, not their old one back',
  ).toBe(7)

  await window.screenshot({ path: path.join(OUT, 'time-dialog-clamped-result.png') })
  await electronApp.close()
})

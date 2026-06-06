/**
 * REQ-071 Phase 3.9 — measure timeline re-render volume during zoom
 * slider drag and during video playback (playhead ticks).
 *
 * Uses the `?seed=demo` renderer hook (see src/renderer/main.tsx) to
 * preload 12 sample subtitles + a fake video so we can drive Step 2 /
 * timeline state directly without going through the real
 * Step 1 → Whisper flow.
 *
 * The renderer instruments TimelineView / Block / Ruler with
 * `bumpRenderCount(name)` (src/renderer/lib/perf-counter.ts), exposing
 * the counts on `window.__mojioko_profile`.  This spec resets that map
 * before each measurement, drives the state change, and reports the
 * deltas — that is the ground truth for "did all 41 Blocks re-render
 * when the playhead ticked?".
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'

test('timeline render volume — zoom slider drag vs playhead tick', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000
  })

  const window = await electronApp.firstWindow()
  // The main process loads from http://localhost:5173 when !app.isPackaged
  // (no Vite dev server runs under these specs).  Drive the renderer
  // directly to the built file with seed + start=step2 so we land on
  // STEP 2 with fixtures already populated.
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  const seedUrl = 'file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2'
  await window.goto(seedUrl)
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

  // Switch to timeline view via the exposed UI store.
  await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void; getState: () => unknown }; project: { getState: () => unknown } } }).__mojioko_test
    t.ui.setState({ editorViewMode: 'timeline' })
  })

  // Wait for the TimelineView to have rendered at least once.
  await window.waitForFunction(() => {
    const p = (window as unknown as { __mojioko_profile?: Record<string, number> }).__mojioko_profile
    return Boolean(p && p.TimelineView && p.TimelineView > 0)
  }, undefined, { timeout: 10_000 })

  // -------------------------------------------------------------------
  // Scenario A: simulate a zoom slider drag — 50 rapid pps updates.
  // -------------------------------------------------------------------
  const dragResult = await window.evaluate(async () => {
    const w = window as unknown as {
      __mojioko_test: { ui: { setState: (s: unknown) => void; getState: () => { timelinePixelsPerSec: number } } }
      __mojioko_profile: Record<string, number>
      __mojioko_profile_reset: () => void
    }
    w.__mojioko_profile_reset()
    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      const pps = 60 + i * 2
      w.__mojioko_test.ui.setState({ timelinePixelsPerSec: pps })
      // Yield so React can flush each update — otherwise React batches
      // all 50 into one render and we don't measure per-tick cost.
      await new Promise((r) => requestAnimationFrame(r))
    }
    const end = performance.now()
    return { totalMs: Math.round(end - start), counters: { ...w.__mojioko_profile } }
  })

  // -------------------------------------------------------------------
  // Scenario B: simulate playhead ticks — 50 rapid videoCurrentTimeSec
  // updates.  These do NOT change block geometry; ideally Block
  // should not re-render at all here.
  // -------------------------------------------------------------------
  const playheadResult = await window.evaluate(async () => {
    const w = window as unknown as {
      __mojioko_test: { ui: { setState: (s: unknown) => void } }
      __mojioko_profile: Record<string, number>
      __mojioko_profile_reset: () => void
    }
    w.__mojioko_profile_reset()
    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      w.__mojioko_test.ui.setState({ videoCurrentTimeSec: 1 + i * 0.5 })
      await new Promise((r) => requestAnimationFrame(r))
    }
    const end = performance.now()
    return { totalMs: Math.round(end - start), counters: { ...w.__mojioko_profile } }
  })

  // -------------------------------------------------------------------
  // Scenario C (REQ-093 measurement): simulate a ruler-scrub drag —
  // 50 rapid setVideoSeekRequest ticks.  This exercises the seek
  // request → VideoPreviewPanel useEffect → setVideoCurrentTimeSec
  // chain that real pointermove events traverse.  Each tick toggles
  // the seekRequest field twice (set → cleared by the effect), so
  // subscribers of `videoSeekRequestSec` (VideoPreviewPanel,
  // AudioPreviewPanel) see roughly 2× the render volume of
  // subscribers of `videoCurrentTimeSec` (Step2Route, TimelineView).
  // This is a measurement, not a budget — no assertions on the
  // returned counters; values just get logged.
  const scrubResult = await window.evaluate(async () => {
    const w = window as unknown as {
      __mojioko_test: { ui: { setState: (s: unknown) => void; getState: () => { videoSeekRequestSec: number | null } } }
      __mojioko_profile: Record<string, number>
      __mojioko_profile_reset: () => void
    }
    w.__mojioko_profile_reset()
    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      // Push a seek request — the renderer's video-preview-panel
      // effect will fan this out to setVideoCurrentTimeSec +
      // setVideoSeekRequest(null) the same way a real pointermove
      // would.
      w.__mojioko_test.ui.setState({ videoSeekRequestSec: 1 + i * 0.5 })
      await new Promise((r) => requestAnimationFrame(r))
    }
    const end = performance.now()
    return { totalMs: Math.round(end - start), counters: { ...w.__mojioko_profile } }
  })

  // eslint-disable-next-line no-console
  console.log('\n[3.9 perf] zoom drag (50 pps ticks):',
    JSON.stringify(dragResult, null, 2))
  // eslint-disable-next-line no-console
  console.log('\n[3.9 perf] playhead (50 ticks, no geometry change):',
    JSON.stringify(playheadResult, null, 2))
  // eslint-disable-next-line no-console
  console.log('\n[REQ-093 measurement] scrub via seek-request (50 ticks):',
    JSON.stringify(scrubResult, null, 2))

  // ---- Assertions ----
  // Playhead ticks must NOT cause Block or Ruler re-renders — their props
  // (leftPx, widthPx, etc.) do not depend on videoCurrentTimeSec, so
  // React.memo should skip every Block.  If this asserts back to >0, the
  // memoisation contract has been broken (see commit history for
  // Phase 3.9 — the bug was `openEditTimeDialog` getting a fresh
  // reference on every Step 2 tick).
  expect(playheadResult.counters.Block ?? 0).toBe(0)
  expect(playheadResult.counters.Ruler ?? 0).toBe(0)

  // Zoom drag MUST re-render Blocks (block geometry depends on pps), but
  // the count should stay close to N × ticks with no doubling.  With 11
  // visible fixtures + 50 ticks we expect ~550 Block renders.  Allow a
  // generous ceiling so this doesn't flake on StrictMode toggles.
  expect(dragResult.counters.Block ?? 0).toBeLessThanOrEqual(700)

  await electronApp.close()
})

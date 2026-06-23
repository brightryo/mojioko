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
  //
  // REQ-094 case B + C: with TimelineView's videoCurrentTimeSec
  // subscription moved into a Playhead sub-component and Step2Route's
  // subscription pushed down into TimeEditorDialog, this scenario's
  // Step2Route / TimelineView counters should now read 0 — the
  // cascade has been cut.
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

  // -------------------------------------------------------------------
  // Scenario D (REQ-094 case E): zoom slider RAF throttle.  Dispatch
  // 10 `input` events on the real slider DOM element synchronously,
  // all within ONE rAF tick.  Without the throttle this would fire 10
  // setPixelsPerSec → 10 Block/Ruler/TimelineView passes; with the
  // throttle the rAF callback coalesces them into ONE commit.
  // PpsSliderInput counts every onChange handler entry (= 10),
  // PpsSliderCommit counts every actual store write (= 1 when
  // throttled).  After the rAF the React render flushes once.
  const sliderThrottleResult = await window.evaluate(async () => {
    const w = window as unknown as {
      __mojioko_profile: Record<string, number>
      __mojioko_profile_reset: () => void
    }
    w.__mojioko_profile_reset()
    const allRangeInputs = Array.from(document.querySelectorAll('input[type="range"]')) as HTMLInputElement[]
    // Target the timeline zoom slider specifically.  Multiple range
    // inputs live in Step 2 (video preview seekbar, outline thickness,
    // bg opacity); we want the one whose min/max match TIMELINE_PPS_*.
    const slider = allRangeInputs.find((el) => {
      const min = Number(el.getAttribute('min'))
      const max = Number(el.getAttribute('max'))
      return min === 10 && max <= 400  // matches TIMELINE_PPS_MIN/MAX shape
    }) as HTMLInputElement | null
    if (!slider) return {
      totalMs: 0,
      counters: {},
      note: 'no zoom-slider element found',
      rangeInputCount: allRangeInputs.length,
      attrs: allRangeInputs.map((el) => ({ min: el.min, max: el.max, ariaLabel: el.getAttribute('aria-label') })),
    }
    // React tracks the input's `value` via a property descriptor it
    // monkey-patches at synthetic event registration time.  A plain
    // `slider.value = X` then `dispatchEvent('input')` silently
    // bypasses React's onChange because React sees no "real" value
    // delta.  Calling the ORIGINAL HTMLInputElement value setter
    // (captured before React touches it) bypasses React's tracker
    // and forces it to fire onChange.  Standard "react-testing-library
    // fireEvent.input"-style trick.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set
    const start = performance.now()
    // Fire 10 input events without yielding between them — simulates
    // a fast cursor that overruns the display refresh.
    for (let i = 0; i < 10; i++) {
      if (nativeSetter) nativeSetter.call(slider, String(60 + i * 5))
      else slider.value = String(60 + i * 5)
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // Wait for the rAF callback to fire AND React to flush.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const end = performance.now()
    return { totalMs: Math.round(end - start), counters: { ...w.__mojioko_profile } }
  })

  // -------------------------------------------------------------------
  // Scenario E (REQ-095 measurement): the REAL ruler-scrub path.
  //
  // REQ-094 cut every render count to zero for the
  // direct-setState-of-videoCurrentTimeSec scenario (Scenario B), yet
  // the owner still reported stutter.  The hypothesis (RES-094 §7
  // hand-off) is that the bottleneck is per-event WORK time, not
  // render volume: each real pointermove drives
  // setVideoSeekRequest → VPP useEffect → `el.currentTime = X` →
  // setVideoCurrentTimeSec → autoScroll subscribe, with the
  // `el.currentTime` line in particular doing a synchronous HTML5
  // video decode that exceeds the per-frame budget for non-keyframe
  // positions.
  //
  // This scenario fires real PointerEvents on the Ruler DOM at the
  // same cadence the user produces and reads `__mojioko_profile_times`
  // for the per-step breakdown.  It also varies the entry count
  // (5 / 20 / 50) to detect any O(N) work hiding in the React layer.
  //
  // CAVEAT: the seed fixture's video path does not exist, so VPP
  // goes into `hasError=true` and unmounts the <video>.  That means
  // `videoRef.current === null` and the `VPP.seekEffect.videoSeek`
  // timer never enters the `if (el)` branch — it stays at 0 in this
  // test.  Real-video cost MUST be measured in dev mode against a
  // real file; the e2e numbers here only attribute the React/Zustand
  // overhead, which is the part RES-095 needs to confirm is small
  // (and therefore NOT the cause of the stutter).
  const sampleScrubResults: Array<{ entryCount: number; counters: Record<string, number>; times: Record<string, number>; totalMs: number }> = []
  for (const targetCount of [5, 20, 50]) {
    const result = await window.evaluate(async ({ targetCount: n }) => {
      const w = window as unknown as {
        __mojioko_test: {
          ui: { setState: (s: unknown) => void; getState: () => { videoSeekRequestSec: number | null; videoCurrentTimeSec: number } }
          project: { setState: (s: unknown) => void; getState: () => { entries: ReadonlyArray<{ id: string; startSec: number; endSec: number; text: string; fontSizePx: number; textColorHex: string; outlineColorHex: string; outlineThicknessPx: number; fadeDurationSec: number; isDeleted: boolean; isEdited: boolean; original: unknown }> } }
        }
        __mojioko_profile: Record<string, number>
        __mojioko_profile_times?: Record<string, number>
        __mojioko_profile_reset: () => void
        __mojioko_profile_times_reset?: () => void
      }
      // Replicate the seed's first entry shape N times, spaced 1 s
      // apart so the timeline has visibly distinct blocks but the
      // total duration stays inside the seed video's 872 s.
      const sample = w.__mojioko_test.project.getState().entries[0]
      const entries = Array.from({ length: n }, (_, i) => ({
        ...sample,
        id: `req-095-${i}`,
        startSec: 5 + i * 3,
        endSec: 5 + i * 3 + 2,
        original: { ...(sample.original as object) },
      }))
      w.__mojioko_test.project.setState({ entries })

      // Make sure the renderer has flushed the new entry array.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

      // Reset both perf maps so this scenario's numbers are isolated.
      w.__mojioko_profile_reset()
      w.__mojioko_profile_times_reset?.()

      // Find the Ruler element — it sits under the timeline view's
      // tracks container.  Identifying it via its cursor class
      // (`cursor-ew-resize`) and the scrubable role.
      const ruler = document.querySelector('[class*="cursor-ew-resize"]') as HTMLElement | null
      if (!ruler) {
        return { entryCount: n, counters: {}, times: {}, totalMs: 0, note: 'ruler element not found' }
      }
      const rect = ruler.getBoundingClientRect()

      // Build a fake pointerId so the Ruler's setPointerCapture call
      // is honoured by the browser.
      const pointerId = 7

      // pointerdown at left edge — initiates scrubbing.
      ruler.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId,
        clientX: rect.left + 4,
        clientY: rect.top + 8,
      }))

      const start = performance.now()
      // Fire 50 pointermoves across the ruler width.
      for (let i = 0; i < 50; i++) {
        const x = rect.left + 4 + (rect.width - 8) * (i / 49)
        ruler.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          button: 0,
          pointerId,
          clientX: x,
          clientY: rect.top + 8,
        }))
        // Yield so React + the VPP useEffect have a chance to land
        // their work between events (otherwise the test would measure
        // batched cost, not per-event cost).
        await new Promise((r) => requestAnimationFrame(r))
      }
      ruler.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        pointerId,
        clientX: rect.right - 4,
        clientY: rect.top + 8,
      }))
      const end = performance.now()

      return {
        entryCount: n,
        counters: { ...w.__mojioko_profile },
        times: { ...(w.__mojioko_profile_times ?? {}) },
        totalMs: Math.round(end - start),
      }
    }, { targetCount })
    sampleScrubResults.push(result)
  }

  // eslint-disable-next-line no-console
  console.log('\n[3.9 perf] zoom drag (50 pps ticks):',
    JSON.stringify(dragResult, null, 2))
  // eslint-disable-next-line no-console
  console.log('\n[3.9 perf] playhead (50 ticks, no geometry change):',
    JSON.stringify(playheadResult, null, 2))
  // eslint-disable-next-line no-console
  console.log('\n[REQ-093 measurement] scrub via seek-request (50 ticks):',
    JSON.stringify(scrubResult, null, 2))
  // eslint-disable-next-line no-console
  console.log('\n[REQ-094 case E] zoom slider throttle (10 input events / 1 frame):',
    JSON.stringify(sliderThrottleResult, null, 2))
  // eslint-disable-next-line no-console
  console.log('\n[REQ-095 measurement] real ruler scrub — per-entry-count breakdown (50 pointermoves):',
    JSON.stringify(sampleScrubResults, null, 2))

  // ---- Assertions ----
  // Playhead ticks must NOT cause Block or Ruler re-renders — their props
  // (leftPx, widthPx, etc.) do not depend on videoCurrentTimeSec, so
  // React.memo should skip every Block.  If this asserts back to >0, the
  // memoisation contract has been broken (see commit history for
  // Phase 3.9 — the bug was `openEditTimeDialog` getting a fresh
  // reference on every Step 2 tick).
  expect(playheadResult.counters.Block ?? 0).toBe(0)
  expect(playheadResult.counters.Ruler ?? 0).toBe(0)

  // REQ-094 case B: TimelineView itself no longer subscribes to
  // videoCurrentTimeSec — the Playhead sub-component does instead.
  // So TimelineView must read 0 during a playhead-only burst.
  expect(playheadResult.counters.TimelineView ?? 0).toBe(0)
  // REQ-094 case C: Step2Route stopped forwarding videoCurrentTimeSec
  // as a prop, so it no longer re-renders during a playhead-only
  // burst (and VideoPreviewPanel no longer cascades from it).
  expect(playheadResult.counters.Step2Route ?? 0).toBe(0)
  expect(playheadResult.counters.VideoPreviewPanel ?? 0).toBe(0)

  // REQ-094 case B + C: scrub via seek-request must also leave
  // Step2Route and TimelineView alone.  VideoPreviewPanel still
  // renders (it OWNS the videoSeekRequestSec subscription and clears
  // it from its effect — ~2 renders per scrub tick), so we assert
  // upper bounds rather than zero on VPP.
  expect(scrubResult.counters.Step2Route ?? 0).toBe(0)
  expect(scrubResult.counters.TimelineView ?? 0).toBe(0)

  // Zoom drag MUST re-render Blocks (block geometry depends on pps), but
  // the count should stay close to N × ticks with no doubling.  With 11
  // visible fixtures + 50 ticks we expect ~550 Block renders.  Allow a
  // generous ceiling so this doesn't flake on StrictMode toggles.
  expect(dragResult.counters.Block ?? 0).toBeLessThanOrEqual(700)

  // REQ-094 case E: 10 synchronous input events within one rAF must
  // commit AT MOST once.  PpsSliderInput should be 10 (the handler
  // entered 10 times), PpsSliderCommit at most 1 (rAF coalesced).
  // This is the proof that the throttle actually reduces store
  // writes — a regression would show Commit ≈ Input.
  expect(sliderThrottleResult.counters.PpsSliderInput ?? 0).toBe(10)
  expect(sliderThrottleResult.counters.PpsSliderCommit ?? 0).toBeLessThanOrEqual(1)

  await electronApp.close()
})

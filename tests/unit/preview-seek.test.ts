import { describe, it, expect, vi } from 'vitest'
import {
  createPreviewSeeker,
  defaultWaitSeeked,
  type SeekableMedia,
  type WaitSeekedFn,
} from '../../src/renderer/lib/preview-seek'

/**
 * REQ-0229 — preview-mix seek helper tests.
 *
 * The seeker is on the load-bearing path of every preview seek that
 * happens while a multi-track preview mix is loaded (REQ-086).  A
 * regression here would either bring back the "あありがとう"
 * double-play bug (RES-0228 symptom B) OR break single-track seek
 * latency (§4 fast-path).  These tests pin:
 *
 *  §4 Single-track fast-path is byte-identical: no pause(), no
 *     seeked wait, just a direct currentTime assignment.
 *  §5 Multi-track path pauses BOTH before assigning currentTime.
 *  §5 Multi-track path awaits `seeked` on BOTH before resuming.
 *  §5 Concurrent seeks: latest wins, superseded seeks do not resume.
 *  §5 chainWasPlaying is captured on FIRST seek of a chain and
 *     preserved across supersession (drag scrubbing invariant).
 *  Timeout: waitSeeked timeout does not hang the seek.
 *  isInFlight lifecycle: false → true during await → false again.
 */

// ---------------------------------------------------------------------------
// Fake media element — implements just enough of SeekableMedia to test.
// ---------------------------------------------------------------------------

class FakeMedia extends EventTarget implements SeekableMedia {
  currentTime = 0
  paused = true
  playCalls = 0
  pauseCalls = 0

  pause(): void {
    this.paused = true
    this.pauseCalls++
  }
  play(): Promise<void> {
    this.paused = false
    this.playCalls++
    return Promise.resolve()
  }
  /** Fire `seeked` (as the browser would, once the decode lands). */
  fireSeeked(): void {
    this.dispatchEvent(new Event('seeked'))
  }
}

/**
 * Deferred waitSeeked: each call returns a promise that only resolves
 * when the test calls `resolveNext()` (or `resolveAll()`).  Lets us
 * observe the state of the seek before the resume step runs.
 */
function makeDeferredWaiter() {
  const pending: Array<() => void> = []
  const waitSeeked: WaitSeekedFn = () =>
    new Promise<void>((resolve) => {
      pending.push(resolve)
    })
  return {
    waitSeeked,
    pendingCount: () => pending.length,
    resolveAll: () => {
      const copy = pending.slice()
      pending.length = 0
      copy.forEach((r) => r())
    },
  }
}

// ---------------------------------------------------------------------------
// §4 Single-track fast-path
// ---------------------------------------------------------------------------

describe('REQ-0229 seek: single-track fast-path (audio === null)', () => {
  it('assigns video.currentTime directly and does NOT pause', async () => {
    const video = new FakeMedia()
    video.currentTime = 5
    video.paused = false // playing

    const seeker = createPreviewSeeker()
    await seeker.seek(video, null, 10)

    expect(video.currentTime).toBe(10)
    expect(video.pauseCalls).toBe(0)
    expect(video.playCalls).toBe(0)
    expect(video.paused).toBe(false) // never touched paused state
  })

  it('does not wait for any seeked event (resolves synchronously via microtask)', async () => {
    const video = new FakeMedia()
    // If the seeker called our waiter, this test would hang forever;
    // by hitting the fast path it should never touch waitSeeked.
    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    await seeker.seek(video, null, 42)

    expect(waiter.pendingCount()).toBe(0)
    expect(video.currentTime).toBe(42)
  })

  it('does not set inFlight for single-track (isInFlight stays false)', async () => {
    const video = new FakeMedia()
    const seeker = createPreviewSeeker()

    expect(seeker.isInFlight()).toBe(false)
    await seeker.seek(video, null, 3)
    expect(seeker.isInFlight()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §5 Multi-track path — pause both, set currentTime, await seeked, resume
// ---------------------------------------------------------------------------

describe('REQ-0229 seek: multi-track path (pause → set → await → resume)', () => {
  it('pauses BOTH video and audio before setting currentTime', async () => {
    const video = new FakeMedia()
    const audio = new FakeMedia()
    video.paused = false
    audio.paused = false

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    const seekPromise = seeker.seek(video, audio, 15)

    // The pause and currentTime assignment happen synchronously before
    // the first `await`.  Assert them without waiting for the promise.
    expect(video.pauseCalls).toBe(1)
    expect(audio.pauseCalls).toBe(1)
    expect(video.currentTime).toBe(15)
    expect(audio.currentTime).toBe(15)

    waiter.resolveAll()
    await seekPromise
  })

  it('awaits seeked on BOTH before resuming playback', async () => {
    const video = new FakeMedia()
    const audio = new FakeMedia()
    video.paused = false // was playing → should resume

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    const seekPromise = seeker.seek(video, audio, 7)

    // Both waiters should be pending, and no play() should have fired.
    expect(waiter.pendingCount()).toBe(2)
    expect(video.playCalls).toBe(0)
    expect(audio.playCalls).toBe(0)

    waiter.resolveAll()
    await seekPromise

    // After both seeked resolve, playback resumes on both.
    expect(video.playCalls).toBe(1)
    expect(audio.playCalls).toBe(1)
  })

  it('does NOT resume playback if the video was paused before the seek', async () => {
    const video = new FakeMedia() // paused = true (default)
    const audio = new FakeMedia() // paused = true (default)

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    const seekPromise = seeker.seek(video, audio, 3)
    waiter.resolveAll()
    await seekPromise

    // Was paused, stays paused.
    expect(video.playCalls).toBe(0)
    expect(audio.playCalls).toBe(0)
    expect(video.currentTime).toBe(3)
    expect(audio.currentTime).toBe(3)
  })

  it('does not call pause() on an already-paused element (avoids spurious pause events)', async () => {
    const video = new FakeMedia() // paused
    const audio = new FakeMedia() // paused

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    const p = seeker.seek(video, audio, 1)
    waiter.resolveAll()
    await p

    expect(video.pauseCalls).toBe(0)
    expect(audio.pauseCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// isInFlight lifecycle
// ---------------------------------------------------------------------------

describe('REQ-0229 seek: isInFlight lifecycle', () => {
  it('reports true while awaiting seeked, false before and after', async () => {
    const video = new FakeMedia()
    const audio = new FakeMedia()
    video.paused = false

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    expect(seeker.isInFlight()).toBe(false)

    const p = seeker.seek(video, audio, 5)

    // Synchronously after the call, the seek has assigned currentTime
    // and is now awaiting — should be in flight.
    expect(seeker.isInFlight()).toBe(true)

    waiter.resolveAll()
    await p

    expect(seeker.isInFlight()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §5 Concurrent seeks — latest wins, chainWasPlaying preserved
// ---------------------------------------------------------------------------

describe('REQ-0229 seek: concurrent seeks (latest wins)', () => {
  it('superseded seek does NOT resume playback; only the latest does', async () => {
    const video = new FakeMedia()
    const audio = new FakeMedia()
    video.paused = false // was playing

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    // Start seek A.
    const pA = seeker.seek(video, audio, 10)
    // Before A's seeked lands, start seek B.
    const pB = seeker.seek(video, audio, 20)

    // Both are awaiting.  Resolve everything.
    waiter.resolveAll()
    await Promise.all([pA, pB])

    // Video/audio landed on the LATEST target.
    expect(video.currentTime).toBe(20)
    expect(audio.currentTime).toBe(20)

    // Only ONE resume happened (from B), not two (A + B).
    expect(video.playCalls).toBe(1)
    expect(audio.playCalls).toBe(1)
  })

  it('preserves chainWasPlaying across supersession (drag scrubbing invariant)', async () => {
    // Simulates: user is playing, drags the seekbar (many seeks land
    // while previous ones are still awaiting), releases.  The final
    // seek must resume playback because the CHAIN started playing —
    // even though intermediate seeks called pause() and each
    // subsequent seek observes video.paused === true at its call time.
    const video = new FakeMedia()
    const audio = new FakeMedia()
    video.paused = false // playing at start of chain

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    const p1 = seeker.seek(video, audio, 5)
    // At this point video.paused was flipped to true by seek 1's pause().
    // A naive "capture wasPlaying per call" would record false for
    // seek 2 and skip the resume.  The chain-scoped capture prevents
    // that.
    const p2 = seeker.seek(video, audio, 10)
    const p3 = seeker.seek(video, audio, 15)

    waiter.resolveAll()
    await Promise.all([p1, p2, p3])

    // Only ONE resume happened (from p3), and it DID happen.
    expect(video.playCalls).toBe(1)
    expect(audio.playCalls).toBe(1)
    expect(video.currentTime).toBe(15)
  })

  it('does NOT resume if the chain started while paused (even after many superseded seeks)', async () => {
    const video = new FakeMedia() // paused
    const audio = new FakeMedia() // paused

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    const p1 = seeker.seek(video, audio, 5)
    const p2 = seeker.seek(video, audio, 10)

    waiter.resolveAll()
    await Promise.all([p1, p2])

    expect(video.playCalls).toBe(0)
    expect(audio.playCalls).toBe(0)
    expect(video.currentTime).toBe(10)
  })

  it('a NEW chain (after previous chain settled) re-samples wasPlaying', async () => {
    const video = new FakeMedia()
    const audio = new FakeMedia()

    const waiter = makeDeferredWaiter()
    const seeker = createPreviewSeeker({ waitSeeked: waiter.waitSeeked })

    // Chain 1: paused.
    const pA = seeker.seek(video, audio, 5)
    waiter.resolveAll()
    await pA
    expect(video.playCalls).toBe(0)

    // Between chains, user hits play.
    video.paused = false

    // Chain 2: was playing → should resume.
    const pB = seeker.seek(video, audio, 10)
    waiter.resolveAll()
    await pB

    expect(video.playCalls).toBe(1)
    expect(audio.playCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Timeout behaviour
// ---------------------------------------------------------------------------

describe('REQ-0229 seek: timeout does not hang', () => {
  it('resolves the seek promise even when seeked never fires (via waitSeeked timeout)', async () => {
    vi.useFakeTimers()
    try {
      const video = new FakeMedia()
      const audio = new FakeMedia()

      // Use the REAL defaultWaitSeeded with a short timeout.  Neither
      // fake element will ever fire `seeked`, so the seek can only
      // resolve via the timer.
      const seeker = createPreviewSeeker({ timeoutMs: 100 })

      const p = seeker.seek(video, audio, 7)

      // Advance past both timers.
      await vi.advanceTimersByTimeAsync(150)
      await p // must not hang

      expect(video.currentTime).toBe(7)
      expect(audio.currentTime).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// defaultWaitSeeked — cleanup and race behaviour
// ---------------------------------------------------------------------------

describe('REQ-0229 defaultWaitSeeked', () => {
  it('resolves on seeked before timeout, and cleans up the timer', async () => {
    vi.useFakeTimers()
    try {
      const el = new EventTarget()
      const removeSpy = vi.spyOn(el, 'removeEventListener')
      const p = defaultWaitSeeked(el, 1000)

      el.dispatchEvent(new Event('seeked'))
      await p

      // Listener was removed on the seeked path.
      expect(removeSpy).toHaveBeenCalledWith('seeked', expect.any(Function))

      // Advancing past the (now-cleared) timer must not do anything harmful.
      await vi.advanceTimersByTimeAsync(2000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves on timeout when seeked never fires', async () => {
    vi.useFakeTimers()
    try {
      const el = new EventTarget()
      let resolved = false
      const p = defaultWaitSeeked(el, 500).then(() => {
        resolved = true
      })

      // Before timeout: still pending.
      await vi.advanceTimersByTimeAsync(499)
      expect(resolved).toBe(false)

      // At timeout: resolves.
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * REQ-0229 — clean seek helper for the multi-track preview mix.
 *
 * Problem being solved (see RES-0228 for full analysis):
 *   Chromium's HTMLMediaElement.currentTime setter does NOT flush the
 *   already-decoded near-future buffer.  When `<video>` is muted and a
 *   sibling `<audio>` plays the amixed preview mix (REQ-086), assigning
 *   `audio.currentTime = X` on a playing element leaves the stale
 *   buffer (~50–100 ms) audible for a moment before the new position
 *   starts — which the user hears as either
 *
 *     - "あありがとう" (symptom B: double-play on seek), or
 *     - "プスプス" (symptom A: click bursts when the rAF drift-corrector
 *       fires mid-playback with the 50 ms threshold).
 *
 * Root fix (this file): before assigning currentTime, pause both
 * elements — pause() DOES flush the buffer.  Then await `seeked` on
 * both, then resume playback if we were playing.  This eliminates the
 * stale-buffer artefact at the cost of ~50–100 ms of seek latency.
 *
 * Design decisions (documented per REQ-0229 §報告形式):
 *
 *  §4 Single-track fast-path: when `audio === null` (single-track /
 *      audio-only source, no preview mix mounted), the seeker skips
 *      the pause/wait/resume dance entirely and does the legacy
 *      `video.currentTime = X` assignment.  Rationale: the bug is
 *      specific to the second `<audio>` element carrying an
 *      independent decoded buffer.  Single-track has one element,
 *      no cross-element buffer drift, no audible artefact — so
 *      forcing pause/resume there would only add latency for zero
 *      benefit.  Byte-identical to the pre-REQ-0229 behaviour.
 *
 *  §5 Concurrent seeks (latest-wins): the seeker holds an internal
 *      sequence counter.  When a new seek starts while a previous
 *      one is still awaiting `seeked`, the previous seek's post-wait
 *      resume is dropped — only the LATEST seek restores playback.
 *      This handles seekbar drag scrubbing (many onChange events
 *      per second) cleanly: earlier seeks silently no-op their tail,
 *      and the final one resumes playback if we were playing when
 *      the drag started.  `chainWasPlaying` is captured on the first
 *      seek of a chain and preserved across supersession so the
 *      resume decision reflects the user's pre-drag state, not the
 *      "paused-by-me" state of an intermediate seek.
 *
 *  Timeout: `seeked` may never fire under pathological conditions
 *      (decode error, network stall on a remote source, etc.).  Each
 *      `waitSeeked` races the event against a timeout (default 1 s);
 *      if the timeout wins, the seek proceeds to the resume step and
 *      the caller is not left hanging.  1 s is generous — typical
 *      seeks on a preload=auto element finish in under 100 ms.
 *
 *  isInFlight(): while any seek is awaiting `seeked`, this returns
 *      true.  The component uses it to suppress the transient
 *      `pause` and `play` events fired by the video during the
 *      pause/resume dance so the ▶/⏸ button icon doesn't flicker.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Wait for one `seeked` event on `el`, or resolve when `timeoutMs`
 * elapses, whichever comes first.  Injectable so unit tests can drive
 * seeks without needing a real HTMLMediaElement.
 */
export type WaitSeekedFn = (
  el: EventTarget,
  timeoutMs: number,
) => Promise<void>

export interface PreviewSeekerOptions {
  /** Timeout for the `seeked` event race.  Default 1000 ms. */
  timeoutMs?: number
  /** Overridable `seeked` waiter for tests. */
  waitSeeked?: WaitSeekedFn
}

/**
 * Minimal shape of the video/audio elements the seeker touches.
 * Using a structural type keeps the seeker unit-testable with plain
 * `EventTarget` fakes.
 */
export interface SeekableMedia extends EventTarget {
  currentTime: number
  paused: boolean
  pause(): void
  play(): Promise<void>
}

export interface PreviewSeeker {
  /**
   * Seek `video` (and `audio` if present) to `targetSec` cleanly.
   *
   * - Single-track (audio null): direct `video.currentTime = targetSec`.
   * - Multi-track: pause both → set currentTime on both → await
   *   `seeked` on both → resume if we were playing.
   *
   * Concurrent calls: latest wins.  Only the final seek in a chain
   * restores playback.
   */
  seek(
    video: SeekableMedia,
    audio: SeekableMedia | null,
    targetSec: number,
  ): Promise<void>

  /** True while any seek is awaiting `seeked`. */
  isInFlight(): boolean
}

// ---------------------------------------------------------------------------
// Default waitSeeked — production path
// ---------------------------------------------------------------------------

/**
 * Wait for one `seeked` event OR a timeout, whichever fires first.
 * Cleans up both the listener and the timer on either exit.
 */
export const defaultWaitSeeked: WaitSeekedFn = (el, timeoutMs) =>
  new Promise<void>((resolve) => {
    let settled = false
    const onSeeked = () => finish()
    const timer = setTimeout(() => finish(), timeoutMs)
    function finish() {
      if (settled) return
      settled = true
      el.removeEventListener('seeked', onSeeked)
      clearTimeout(timer)
      resolve()
    }
    el.addEventListener('seeked', onSeeked, { once: true })
  })

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 1000

export function createPreviewSeeker(opts?: PreviewSeekerOptions): PreviewSeeker {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const waitSeeked = opts?.waitSeeked ?? defaultWaitSeeked

  // Sequence counter: 0 = idle, > 0 = latest seek's sequence number.
  let inFlightSeq = 0
  // Captured on the first seek of a chain, preserved across supersession
  // so drag scrubbing resumes on the user's pre-drag play state.
  let chainWasPlaying = false

  async function seek(
    video: SeekableMedia,
    audio: SeekableMedia | null,
    targetSec: number,
  ): Promise<void> {
    // §4 fast-path: single-track keeps byte-identical legacy behaviour.
    if (audio === null) {
      video.currentTime = targetSec
      return
    }

    // §5 chain bookkeeping.
    const isNewChain = inFlightSeq === 0
    const mySeq = inFlightSeq + 1
    inFlightSeq = mySeq
    if (isNewChain) {
      chainWasPlaying = !video.paused
    }

    // Pause both — this is what flushes Chromium's decoded audio buffer.
    if (!video.paused) video.pause()
    if (!audio.paused) audio.pause()

    // Set the target position on both.
    video.currentTime = targetSec
    audio.currentTime = targetSec

    // Race the seeked event on both against the timeout.
    await Promise.all([
      waitSeeked(video, timeoutMs),
      waitSeeked(audio, timeoutMs),
    ])

    // §5: superseded → let the newer seek handle the resume.
    if (mySeq !== inFlightSeq) return

    // I am the latest — close the chain.
    const shouldPlay = chainWasPlaying
    inFlightSeq = 0
    chainWasPlaying = false

    if (shouldPlay) {
      // Start audio first, then video — mirrors the ordering used in
      // togglePlay so the two elements come out of pause with the same
      // handshake pattern the rest of the panel expects.
      audio.play().catch((err) => {
        console.error('[preview-mix audio] play() rejected on seek resume', err)
      })
      video.play().catch(() => {})
    }
  }

  function isInFlight(): boolean {
    return inFlightSeq > 0
  }

  return { seek, isInFlight }
}

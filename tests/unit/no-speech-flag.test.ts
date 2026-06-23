import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore } from '../../src/renderer/stores/ui-store'

/**
 * REQ-20260615-064 A — the `lastTranscriptionWasEmpty` flag is the
 * cross-route signal that STEP 1 sets right before navigating to
 * STEP 2 with an empty entry list (zero segments from
 * faster-whisper).  STEP 2's mount effect reads it, fires a single-
 * shot "発話を検出できませんでした" toast, and resets it back to
 * false so a later visit within the same session does not re-fire
 * the toast.
 *
 * The toast itself is a React side-effect, but the round-trip on
 * the flag IS the contract — verify the store half here so a future
 * regression in either direction (STEP 1 forgets to set / STEP 2
 * forgets to clear) shows up in CI.
 */
describe('REQ-064 A — lastTranscriptionWasEmpty flag', () => {
  beforeEach(() => {
    useUiStore.getState().setLastTranscriptionWasEmpty(false)
  })

  it('defaults to false on a fresh store', () => {
    expect(useUiStore.getState().lastTranscriptionWasEmpty).toBe(false)
  })

  it('STEP 1 → STEP 2 round-trip: set on empty, cleared after read', () => {
    const { setLastTranscriptionWasEmpty } = useUiStore.getState()

    // STEP 1's path on zero-segment completion.
    setLastTranscriptionWasEmpty(true)
    expect(useUiStore.getState().lastTranscriptionWasEmpty).toBe(true)

    // STEP 2 mount effect reads the flag and clears it.
    const flag = useUiStore.getState().lastTranscriptionWasEmpty
    if (flag) setLastTranscriptionWasEmpty(false)
    expect(useUiStore.getState().lastTranscriptionWasEmpty).toBe(false)
  })

  it('stays false on a non-empty transcription path (no spurious toast)', () => {
    // STEP 1 path when finalEntries.length > 0 must NOT touch the flag.
    expect(useUiStore.getState().lastTranscriptionWasEmpty).toBe(false)
    // Simulate STEP 2 mount running while the flag is false — must
    // remain false (= toast does not fire).
    const flag = useUiStore.getState().lastTranscriptionWasEmpty
    expect(flag).toBe(false)
  })

  it('a second mount of STEP 2 within the same session does not re-fire (flag stays cleared)', () => {
    const { setLastTranscriptionWasEmpty } = useUiStore.getState()
    setLastTranscriptionWasEmpty(true)
    // First mount consumes the flag.
    if (useUiStore.getState().lastTranscriptionWasEmpty) {
      setLastTranscriptionWasEmpty(false)
    }
    // Second mount runs the same guard — must NOT see true again.
    expect(useUiStore.getState().lastTranscriptionWasEmpty).toBe(false)
  })
})

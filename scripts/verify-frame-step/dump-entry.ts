// REQ-0383 — the gate drives the REAL shipping frame-step function through a
// real Chromium <video> seek round-trip, so a regression to boundary-seeking
// (which dup/skips frames) fails the gate.
export { frameStepSec } from '../../src/shared/timecode'

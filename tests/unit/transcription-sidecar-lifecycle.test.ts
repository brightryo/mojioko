import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable, Writable } from 'stream'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------
//
// `transcription-sidecar.ts` imports:
//   - `electron` (via `app`) — no runtime here, stub it
//   - `../lib/child-process.spawnProcess` — controlled here so tests
//     hand out ChildProcess-like objects with observable stdin.write
//   - `./gpu-tool.getEffectiveGpuToolDir` — return value drives whether
//     the sidecar env changes between transcribes (respawn trigger)
//   - `../lib/paths.getTranscriberExePath` etc — return non-null strings
//   - `./normalize-video-path` — return ok for test paths
//
// The `child-process` mock records every spawned proc into
// `spawnedProcs[]` so a test can pull the "current" and "previous" proc
// out and drive them independently.

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
  },
}))

vi.mock('../../src/main/lib/paths', () => ({
  getPythonExecutable: () => 'python.exe',
  getPythonSidecarPath: () => 'main.py',
  getTranscriberExePath: () => null,
  getModelsDir: () => tmpdir(),
  getBinPath: () => '/fake/ffmpeg',
  getLogsDir: () => tmpdir(),
}))

// Stub the logger so `electron-log` doesn't try to open a real log
// file under Electron's userData path (which does not exist in the
// vitest process).
vi.mock('../../src/main/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../src/main/services/normalize-video-path', () => ({
  normalizeVideoPath: (p: string) => ({ ok: true, path: p }),
}))

let mockGpuDir: string | null = null
vi.mock('../../src/main/services/gpu-tool', () => ({
  getEffectiveGpuToolDir: async () => mockGpuDir,
  // These aren't called by the sidecar module directly; stub for safety.
  deleteGpuTool: vi.fn(),
  buildGpuToolState: vi.fn(),
  setActiveAccelerator: vi.fn(),
  downloadGpuTool: vi.fn(),
  GpuToolDownloadError: class extends Error {},
}))

interface FakeProc extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed: boolean
  kill: (signal?: string) => boolean
  __lastStdin: string[]
}

const spawnedProcs: FakeProc[] = []

function makeFakeProc(): FakeProc {
  const emitter = new EventEmitter() as FakeProc
  emitter.__lastStdin = []
  emitter.stdout = new Readable({ read() { /* pushed manually */ } })
  emitter.stderr = new Readable({ read() { /* pushed manually */ } })
  emitter.stdin = new Writable({
    write(chunk, _enc, cb) {
      emitter.__lastStdin.push(chunk.toString())
      cb()
    },
  })
  emitter.killed = false
  emitter.kill = (_signal?: string) => {
    if (emitter.killed) return false
    emitter.killed = true
    return true
  }
  return emitter
}

vi.mock('../../src/main/lib/child-process', () => ({
  spawnProcess: vi.fn(() => {
    const proc = makeFakeProc()
    spawnedProcs.push(proc)
    return proc
  }),
  execFileAsync: vi.fn(),
  tryCommands: vi.fn(),
}))

// Import after mocks so the module picks up the stubs.
const sidecar = await import('../../src/main/services/transcription-sidecar')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseRequest() {
  return {
    videoPath: 'C:\\test\\video.mp4',
    trackIndex: 0,
    modelId: 'large-v3-turbo' as const,
    modelsDir: 'C:\\models',
    ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
    defaults: {
      fontSizePx: 100,
      textColorHex: '#FFFFFF',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      fadeDurationSec: 0,
    },
    advanced: {
      vadFilter: true,
      vadThreshold: 0.5,
      minSpeechDurationMs: 250,
      minSilenceDurationMs: 2000,
      beamSize: 5,
      language: 'auto',
    },
  }
}

function feedEvent(proc: FakeProc, eventJson: unknown): void {
  proc.stdout.push(JSON.stringify(eventJson) + '\n')
}

/**
 * `transcribe()` awaits `ensureSidecar()` which awaits our mocked
 * `getEffectiveGpuToolDir` — two microtask hops before `spawnProcess`
 * runs.  Tests need to flush those before observing `spawnedProcs` or
 * calling `feedEvent`.  Using fake timers, `advanceTimersByTimeAsync(0)`
 * flushes both scheduled timers and the promise microtask queue.
 */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Wrap a `sidecar.transcribe(...)` promise so a late rejection (idle
 * watchdog / exit-handler `failed`) never triggers Node's unhandled-
 * rejection warning.  Returns the original promise unchanged so
 * `.rejects.toThrow` assertions still work — the `.catch` is a
 * silent observer, not a consumer.
 */
function silenceUnhandled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

function resetModuleState(): void {
  // Drain module singleton state synchronously via the public API.
  // `terminateSidecar()` sets `sidecarProcess = null`, clears
  // `pendingCallback`, and disarms the idle watchdog — no exit event
  // is emitted, so pending transcribe promises from earlier tests
  // stay in whatever state they were in and are not silently rejected.
  sidecar.terminateSidecar()
  spawnedProcs.length = 0
  mockGpuDir = null
}

beforeEach(() => {
  // clearAllTimers first — the previous test's `terminateSidecar()` /
  // watchdog schedules linger otherwise and can fire on a fresh spawn.
  vi.useFakeTimers()
  vi.clearAllTimers()
  resetModuleState()
})

afterEach(() => {
  resetModuleState()
  vi.clearAllTimers()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Fix 1 — exit handler ownership check
// ---------------------------------------------------------------------------

describe('REQ-0218 Fix 1 — respawn ownership check', () => {
  it('OLD proc exit after respawn must NOT settle the new transcribe', async () => {
    // Step 1: first transcribe under CPU (mockGpuDir = null).  Set up a
    // never-completes onEvent so we can observe whether the callback
    // survives the OLD proc's exit.  The proc will stay alive; we don't
    // emit `completed` so `pendingCallback` remains live.
    mockGpuDir = null
    const onEvent1 = vi.fn()
    const pending1 = sidecar.transcribe(baseRequest(), onEvent1)
    // Silence the unhandled-rejection warning if this promise ever
    // rejects (it shouldn't for the assertions below).
    void pending1.catch(() => {})
    await flushMicrotasks()
    expect(spawnedProcs.length).toBe(1)
    const oldProc = spawnedProcs[0]

    // Step 2: flip to GPU and start a second transcribe.  ensureSidecar
    // will kill(oldProc), spawn a new proc, and hand the caller the new
    // one.  The old proc's 'exit' has NOT fired yet at this point.
    mockGpuDir = 'C:\\fake\\gpu-tools\\cuda-v1'
    const onEvent2 = vi.fn()
    const pending2 = sidecar.transcribe(baseRequest(), onEvent2)
    void pending2.catch(() => {})
    await flushMicrotasks()
    expect(spawnedProcs.length).toBe(2)
    const newProc = spawnedProcs[1]
    expect(oldProc.killed).toBe(true)
    expect(newProc.killed).toBe(false)

    // Step 3: now the OLD proc's exit event lands (25 ms after kill on
    // real Windows; simulate immediately).  If Fix 1's ownership check
    // is missing, `pendingCallback` gets nulled here and any subsequent
    // event from newProc is silently dropped — which is exactly the
    // RES-0217 §2 bug.
    oldProc.emit('exit', null)

    // Step 4: newProc emits a `completed` event.  If the callback was
    // preserved (Fix 1 working), onEvent2 fires and pending2 resolves.
    feedEvent(newProc, {
      event: 'completed',
      segmentCount: 0,
      previewMixUrl: null,
    })
    await vi.advanceTimersByTimeAsync(0)  // flush microtasks
    await expect(pending2).resolves.toBeUndefined()
    expect(onEvent2).toHaveBeenCalledWith(expect.objectContaining({ event: 'completed' }))
  })

  it('OLD proc exit after respawn leaves sidecarProcess pointing at the new proc', async () => {
    // The module state pointer is internal; assert indirectly by
    // running a second transcribe and confirming NO new spawn occurs
    // (reuse) — proving `sidecarProcess` still points at newProc.
    mockGpuDir = null
    const p1 = sidecar.transcribe(baseRequest(), vi.fn())
    void p1.catch(() => {})
    await flushMicrotasks()
    const oldProc = spawnedProcs[0]

    mockGpuDir = 'C:\\fake\\gpu\\dir'
    const p2 = sidecar.transcribe(baseRequest(), vi.fn())
    void p2.catch(() => {})
    await flushMicrotasks()
    const newProc = spawnedProcs[1]

    // Fire old exit -- Fix 1 must swallow the state-clear.
    oldProc.emit('exit', null)

    // Third transcribe with SAME env value (mockGpuDir unchanged) —
    // ensureSidecar should reuse newProc and NOT spawn a third.
    const p3 = sidecar.transcribe(baseRequest(), vi.fn())
    void p3.catch(() => {})
    await flushMicrotasks()
    expect(spawnedProcs.length).toBe(2)  // ← still 2, not 3
    expect(spawnedProcs[1]).toBe(newProc)
  })
})

// ---------------------------------------------------------------------------
// Fix 2 — owning proc dies mid-transcribe → surface a `failed` event
// ---------------------------------------------------------------------------

describe('REQ-0218 Fix 2 — owning proc exit during transcribe', () => {
  it('emits `failed` event when the owning proc exits with pendingCallback set', async () => {
    mockGpuDir = null
    const onEvent = vi.fn()
    const pending = silenceUnhandled(sidecar.transcribe(baseRequest(), onEvent))
    await flushMicrotasks()
    const owningProc = spawnedProcs[0]

    // Owning proc dies before emitting completed/failed.
    owningProc.emit('exit', 1)

    await expect(pending).rejects.toThrow(/exited unexpectedly/i)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'failed',
        error: expect.stringMatching(/exited unexpectedly.*code=1/i),
      }),
    )
  })

  it('exit code null (the RES-0217 log signature) surfaces as failed with code=null', async () => {
    mockGpuDir = null
    const onEvent = vi.fn()
    const pending = silenceUnhandled(sidecar.transcribe(baseRequest(), onEvent))
    await flushMicrotasks()
    const owningProc = spawnedProcs[0]

    owningProc.emit('exit', null)

    await expect(pending).rejects.toThrow(/code=null/i)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'failed',
        error: expect.stringMatching(/code=null/i),
      }),
    )
  })

  it('does NOT emit a spurious `failed` when there is no in-flight transcribe', async () => {
    mockGpuDir = null
    // Spawn a proc by starting + immediately completing a transcribe.
    const onEvent = vi.fn()
    const p = silenceUnhandled(sidecar.transcribe(baseRequest(), onEvent))
    await flushMicrotasks()
    const proc = spawnedProcs[0]
    feedEvent(proc, { event: 'completed', segmentCount: 0, previewMixUrl: null })
    await flushMicrotasks()
    await p

    // Now proc dies — no in-flight work → no extra callback should fire.
    onEvent.mockClear()
    proc.emit('exit', 0)
    expect(onEvent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// REQ-0219 — cancelTranscription
// ---------------------------------------------------------------------------

describe('REQ-0219 cancelTranscription', () => {
  it('settles the in-flight transcribe promise with a Cancelled error', async () => {
    mockGpuDir = null
    const onEvent = vi.fn()
    const pending = silenceUnhandled(sidecar.transcribe(baseRequest(), onEvent))
    await flushMicrotasks()
    const proc = spawnedProcs[0]

    // User presses Cancel while transcribe is in flight.
    const cancelPromise = sidecar.cancelTranscription()
    // The callback should have fired with the `Cancelled` sentinel
    // synchronously — the renderer's `msg.includes('Cancelled')` check
    // downstream distinguishes cancel from real errors, matching the
    // shared convention in ffmpeg-burnin / preview-mix / model-downloader.
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'failed', error: 'Cancelled' }),
    )
    await expect(pending).rejects.toThrow(/Cancelled/)

    // cancelTranscription itself resolves once the sidecar has exited
    // (or the escalation deadline elapses).  Simulate the sidecar
    // exiting cleanly after the `{cmd:'shutdown'}` write; if it did
    // not exit, the timeout path in the next test proves the fallback.
    proc.emit('exit', 0)
    await expect(cancelPromise).resolves.toBeUndefined()
  })

  it('sends {cmd:"shutdown"} then escalates to SIGKILL when the sidecar ignores SIGTERM', async () => {
    mockGpuDir = null
    const p = silenceUnhandled(sidecar.transcribe(baseRequest(), vi.fn()))
    await flushMicrotasks()
    const proc = spawnedProcs[0]
    proc.__lastStdin.length = 0
    const killSpy = vi.spyOn(proc, 'kill')

    const cancelPromise = sidecar.cancelTranscription()
    // The graceful `{cmd:'shutdown'}` write happens synchronously
    // inside the Promise executor of terminateSidecarAndWait.
    expect(proc.__lastStdin.some((s) => s.includes('"shutdown"'))).toBe(true)

    // The sidecar ignores SIGTERM (never emits `exit`).  After 3 s
    // the hard deadline elapses, `kill('SIGKILL')` is called, and
    // cancelTranscription resolves anyway — the caller (IPC handler)
    // needs to proceed regardless.
    await vi.advanceTimersByTimeAsync(3001)
    await expect(cancelPromise).resolves.toBeUndefined()
    expect(killSpy.mock.calls.some((args) => args[0] === 'SIGKILL')).toBe(true)

    // The in-flight transcribe promise must have settled by now (the
    // Cancelled callback fires synchronously before the wait even
    // begins), so no leftover pending promises.
    await expect(p).rejects.toThrow(/Cancelled/)
  })

  it('module state is clean after cancel — a subsequent transcribe spawns fresh', async () => {
    mockGpuDir = null
    const p1 = silenceUnhandled(sidecar.transcribe(baseRequest(), vi.fn()))
    await flushMicrotasks()
    const proc1 = spawnedProcs[0]
    expect(spawnedProcs.length).toBe(1)

    const cancelPromise = sidecar.cancelTranscription()
    proc1.emit('exit', 0)
    await cancelPromise
    await expect(p1).rejects.toThrow(/Cancelled/)

    // Fire a fresh transcribe.  ensureSidecar sees `sidecarProcess = null`
    // (cleared by the exit handler under Fix 1's ownership branch) and
    // spawns a new proc — total spawn count must go to 2.
    silenceUnhandled(sidecar.transcribe(baseRequest(), vi.fn()))
    await flushMicrotasks()
    expect(spawnedProcs.length).toBe(2)
    expect(spawnedProcs[1]).not.toBe(proc1)
  })

  it('is a no-op when there is no live sidecar', async () => {
    // Freshly reset state — no transcribe has been called.
    await expect(sidecar.cancelTranscription()).resolves.toBeUndefined()
    expect(spawnedProcs.length).toBe(0)
  })

  it('does not emit a spurious second `failed` from the exit-handler after callback is invoked', async () => {
    // Regression guard for the Fix 2 / cancel interaction: after
    // `cancelTranscription` fires the `Cancelled` callback and nulls
    // pendingCallback, the subsequent exit event must NOT invoke a
    // second `failed` callback (Fix 2's `if (cb)` guard covers this).
    mockGpuDir = null
    const onEvent = vi.fn()
    const p = silenceUnhandled(sidecar.transcribe(baseRequest(), onEvent))
    await flushMicrotasks()
    const proc = spawnedProcs[0]

    const cancelPromise = sidecar.cancelTranscription()
    // Snapshot the call count after the Cancelled emission but before
    // the exit event.
    const callCountAfterCancel = onEvent.mock.calls.length
    expect(callCountAfterCancel).toBe(1)
    expect(onEvent).toHaveBeenCalledWith({ event: 'failed', error: 'Cancelled' })

    // Simulate the sidecar exiting AFTER the cancel — Fix 2 must not
    // re-fire because pendingCallback was nulled by cancelTranscription.
    proc.emit('exit', 0)
    await cancelPromise
    await expect(p).rejects.toThrow(/Cancelled/)

    expect(onEvent.mock.calls.length).toBe(callCountAfterCancel)
  })
})

// ---------------------------------------------------------------------------
// Fix 3 — terminateSidecarAndWait
// ---------------------------------------------------------------------------

describe('REQ-0218 Fix 3 — terminateSidecarAndWait', () => {
  it('resolves immediately when there is no live sidecar', async () => {
    // Nothing spawned yet -- should return without touching state.
    await expect(sidecar.terminateSidecarAndWait(3000)).resolves.toBeUndefined()
    expect(spawnedProcs.length).toBe(0)
  })

  it('resolves as soon as the sidecar emits `exit`', async () => {
    mockGpuDir = null
    const p1 = sidecar.transcribe(baseRequest(), vi.fn())
    void p1.catch(() => {})
    await flushMicrotasks()
    const proc = spawnedProcs[0]

    const waitPromise = sidecar.terminateSidecarAndWait(3000)
    // Simulate the sidecar dying cleanly.
    proc.emit('exit', 0)
    await expect(waitPromise).resolves.toBeUndefined()
  })

  it('force-kills and resolves on timeout when the sidecar refuses to exit', async () => {
    mockGpuDir = null
    const p1 = sidecar.transcribe(baseRequest(), vi.fn())
    void p1.catch(() => {})
    await flushMicrotasks()
    const proc = spawnedProcs[0]
    // Intentionally do not emit `exit`.
    const killSpy = vi.spyOn(proc, 'kill')

    const waitPromise = sidecar.terminateSidecarAndWait(3000)
    // Cross the graceful (~1000ms) then the hard (3000ms) boundary.
    await vi.advanceTimersByTimeAsync(3001)

    // The wait must resolve (does not throw) so callers can proceed.
    await expect(waitPromise).resolves.toBeUndefined()
    // At least one kill call — plus a SIGKILL escalation on timeout.
    expect(killSpy).toHaveBeenCalled()
    expect(killSpy.mock.calls.some((args) => args[0] === 'SIGKILL')).toBe(true)
  })

  it('sends the graceful shutdown command on stdin before killing', async () => {
    mockGpuDir = null
    const p1 = sidecar.transcribe(baseRequest(), vi.fn())
    void p1.catch(() => {})
    await flushMicrotasks()
    const proc = spawnedProcs[0]
    proc.__lastStdin.length = 0

    const waitPromise = sidecar.terminateSidecarAndWait(3000)
    // The `{cmd:'shutdown'}` write happens synchronously inside the
    // Promise executor, so it is visible before any timer advances.
    expect(proc.__lastStdin.some((s) => s.includes('"shutdown"'))).toBe(true)

    proc.emit('exit', 0)
    await expect(waitPromise).resolves.toBeUndefined()
  })
})

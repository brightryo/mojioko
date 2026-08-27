import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * REQ-0553 / REQ-0557 — a CLI launch must not crash on the way out.
 *
 * ## What was happening
 *
 * CLI invocations intermittently exited with `3221225477` (`0xC0000005`,
 * ACCESS_VIOLATION) instead of their real exit code. Measured over 200 launches
 * per case:
 *
 *   read_subtitle (fastest)   11/200  = 1 in 18
 *   --help                     4/200  = 1 in 50
 *   burn --nope                1/200  = 1 in 200
 *   tools list (slowest)       0/200
 *
 * The ordering is the diagnosis: the FASTER the command, the likelier the
 * crash. `app.exit()` is a hard exit that skips Chromium's graceful shutdown,
 * so a command that finishes while the GPU process is still starting takes the
 * browser process down with it. A slow command has already got past that.
 *
 * ## Why the switch moved (REQ-0557)
 *
 * `disableHardwareAcceleration()` alone did not prevent it — that disables GPU
 * *rasterisation* while Chromium still launches the GPU process. REQ-0553 added
 * `appendSwitch('disable-gpu')` inside `maybeRunCli` and measured 16/800 →
 * 4/800: better, but not closed, while a REAL `--disable-gpu` flag measured
 * 0/200. The gap was WHEN: `maybeRunCli` runs after every module-level import
 * in `main/index.ts`, which is all the wall-clock Chromium needs to start the
 * process the switch was meant to prevent.
 *
 * REQ-0557 moved it to `main/early-gpu.ts`, imported at the top of the entry
 * file. What this file pins is therefore no longer "the switch is in the CLI
 * dispatcher" but the two things that actually matter:
 *
 *   1. it is applied as EARLY as an import can be, and
 *   2. it is gated on the SAME `isCliInvocation()` the dispatcher uses, so a
 *      GUI launch cannot reach it.
 *
 * ## Why this is a source test
 *
 * The property is "the switch is set on the CLI path, only there, and early".
 * Proving it behaviourally means launching Electron hundreds of times, which is
 * what `scripts/verify-cli-stability` is for (opt-in, not a standard gate).
 * This keeps the wiring from being removed or quietly relocated.
 */

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')
const EARLY = read('src/main/early-gpu.ts')
const ENTRY = read('src/main/index.ts')
const CLI = read('src/main/cli/index.ts')

/** Strip comments so prose about the switch cannot satisfy a source assertion. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('REQ-0553/0557 — the CLI disables the GPU process', () => {
  it('★ the switch is appended, in the early module', () => {
    expect(stripComments(EARLY)).toContain("appendSwitch('disable-gpu')")
  })

  it('★ …gated on isCliInvocation(), so a GUI launch never reaches it', () => {
    const code = stripComments(EARLY)
    expect(code).toContain('isCliInvocation()')
    // The gate must precede the switch — an unconditional append would disable
    // the GPU for the whole app, a far worse regression than the bug it fixes.
    expect(code.indexOf('isCliInvocation()')).toBeLessThan(code.indexOf("appendSwitch('disable-gpu')"))
  })

  it('★ …and that gate is the SHARED one, not a second argv scan', () => {
    // REQ-0557 §1-2: two implementations of "is this a CLI run?" would agree
    // today and drift the first time a command is added.
    expect(stripComments(EARLY)).toContain("from './cli/launch-args'")
    expect(stripComments(read('src/main/cli/index.ts'))).toContain("from './launch-args'")
  })

  it('★ the early module is imported BEFORE the heavy main imports', () => {
    /*
     * This is the whole point of REQ-0557. If the import drifts below the ~40
     * IPC/service imports, the switch is applied late again and the crash rate
     * silently returns to REQ-0553's 4/800 — with every test still green.
     */
    const code = stripComments(ENTRY)
    const earlyAt = code.indexOf("import './early-gpu'")
    expect(earlyAt).toBeGreaterThan(-1)

    // Nothing heavier than the other early guard may precede it.
    const before = code.slice(0, earlyAt)
    const importsBefore = [...before.matchAll(/^import .*$/gm)].map((m) => m[0])
    expect(importsBefore.every((line) => line.includes('early-guard')), `imports before early-gpu: ${importsBefore.join(' | ')}`).toBe(true)

    // …and it must come before the electron import that the rest of main uses.
    const electronAt = code.indexOf("from 'electron'")
    expect(electronAt).toBeGreaterThan(earlyAt)
  })

  it('★ the CLI dispatcher no longer sets it (one place, not two)', () => {
    // REQ-0557 §1-4: the late append is redundant once the early one lands, and
    // leaving it would read like a second safeguard while doing nothing.
    expect(stripComments(CLI)).not.toContain("appendSwitch('disable-gpu')")
    // The rasterisation call is a different thing and stays.
    expect(stripComments(CLI)).toContain('disableHardwareAcceleration()')
  })

  it('the GUI entry point does not disable the GPU itself', () => {
    expect(stripComments(ENTRY)).not.toContain("appendSwitch('disable-gpu')")
  })

  it('only the measured switch is set — no untested extras rode along', () => {
    // `disable-software-rasterizer` and friends were never measured here, and
    // an unmeasured switch in a fix for a measured problem is a guess.
    const appended = [...stripComments(EARLY + CLI + ENTRY).matchAll(/appendSwitch\('([^']+)'/g)].map((m) => m[1])
    expect(appended).toEqual(['disable-gpu'])
  })
})

/**
 * ★ REQ-0557 §2-2 — the gate itself, exercised.
 *
 * The source assertions above prove the switch sits behind `isCliInvocation()`.
 * This proves what that function ANSWERS for the launch shapes a user actually
 * produces — because "the gate is wired correctly" and "the gate says no for a
 * GUI launch" are different claims, and only the second one protects rendering.
 */
describe('REQ-0557 §2-2 — a GUI launch is not classified as CLI', () => {
  const withArgv = async (argv: string[], packaged: boolean, existing: string[]) => {
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { isPackaged: packaged, getAppPath: () => String.raw`C:\app` },
    }))
    vi.doMock('fs', () => ({ existsSync: (p: string) => existing.includes(p) }))
    const original = process.argv
    process.argv = argv
    try {
      const mod = await import('../../src/main/cli/launch-args')
      return mod.isCliInvocation()
    } finally {
      process.argv = original
      vi.doUnmock('electron')
      vi.doUnmock('fs')
    }
  }

  it('★ packaged, no arguments (the normal double-click on the app) ⇒ GUI', async () => {
    expect(await withArgv([String.raw`C:\Program Files\MOJIOKO\MOJIOKO.exe`], true, [])).toBe(false)
  })

  it('★ dev `electron .` with no command ⇒ GUI', async () => {
    expect(await withArgv(['electron.exe', '.'], false, [])).toBe(false)
  })

  it('★ a .mojioko double-click ⇒ GUI, not CLI', async () => {
    // REQ-0459: the file-association launch opens a window. If this were
    // misread as CLI, REQ-0557 would disable the GPU for a real GUI session.
    expect(await withArgv(['MOJIOKO.exe', String.raw`C:\work\a.mojioko`], true, [String.raw`C:\work\a.mojioko`]))
      .toBe(false)
  })

  it('a real command ⇒ CLI (the gate is not stuck on false)', async () => {
    expect(await withArgv(['MOJIOKO.exe', 'read_subtitle', 'x.mojioko'], true, [])).toBe(true)
  })

  it('a typo ⇒ still CLI, so it reaches the USAGE error rather than opening a window', async () => {
    expect(await withArgv(['MOJIOKO.exe', 'raed_subtitle'], true, [])).toBe(true)
  })
})

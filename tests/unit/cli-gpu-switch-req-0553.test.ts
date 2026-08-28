import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * REQ-0553 / REQ-0557 / REQ-0558 — the CLI launch crash, and what is left of
 * the attempts to fix it.
 *
 * ## The fault (still open)
 *
 * CLI invocations intermittently exit with `3221225477` (`0xC0000005`,
 * ACCESS_VIOLATION) instead of their real exit code. `app.exit()` is a hard
 * exit that skips Chromium's graceful shutdown, so a command finishing while
 * the GPU process is still starting appears to take the browser process down
 * with it. The output is never wrong — stdout carries complete, valid JSON and
 * files are already written. What the crash replaces is the EXIT CODE.
 *
 * ## Why there is no `disable-gpu` switch to test any more
 *
 * REQ-0553 added `appendSwitch('disable-gpu')` inside `maybeRunCli` and read
 * 16/800 → 4/800 as an improvement. REQ-0557 moved it to the first import of
 * `main/index.ts` on the theory that the remaining crashes were a timing
 * problem, and measured:
 *
 *   early switch               2/600
 *   control, no switch at all  1/600
 *
 * — no effect. The control also showed `read_subtitle` at 0/200 without any
 * switch, where REQ-0553 had measured 11/200, so the baseline had moved by an
 * order of magnitude and that REQ's "improvement" was most likely noise read as
 * effect. At a ~0.2% rate an unfixed build passes 0/200 routinely.
 *
 * REQ-0558 therefore removed the switch entirely (owner decision, RES-0557 §6
 * option b). Keeping an unmeasured mechanism would have left something that
 * reads like a fix and does nothing — the more expensive mistake, because the
 * next person to see a 0xC0000005 would believe it was already handled.
 *
 * `disableHardwareAcceleration()` stays: it is a different thing (GPU
 * rasterisation, not the GPU process) and predates all of this.
 *
 * ## What this file still pins
 *
 * Two things worth keeping from REQ-0557:
 *
 *   1. No `appendSwitch` crept back in unmeasured.
 *   2. `isCliInvocation()` — the shared launch classifier that `launch-args.ts`
 *      now owns — answers correctly for real argv shapes. It gates whether a
 *      launch goes headless at all, so a wrong answer either opens a window
 *      during a CLI run or runs a GUI launch headless.
 */

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')
const ENTRY = read('src/main/index.ts')
const CLI = read('src/main/cli/index.ts')

/** Strip comments so prose about the switch cannot satisfy a source assertion. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('REQ-0558 §1 — the unmeasured GPU switch is gone, and stays gone', () => {
  it('★ neither the entry point nor the CLI dispatcher appends a Chromium switch', () => {
    // An unmeasured switch in a fix for a measured problem is a guess. Two
    // attempts have now been measured and neither moved the number.
    const appended = [...stripComments(ENTRY + CLI).matchAll(/appendSwitch\('([^']+)'/g)].map((m) => m[1])
    expect(appended, `unexpected switches: ${appended.join(', ')}`).toEqual([])
  })

  it('★ the early-gpu module is not reintroduced', () => {
    expect(stripComments(ENTRY)).not.toContain('early-gpu')
  })

  it('disableHardwareAcceleration() is still called on the CLI path', () => {
    // Different mechanism, never implicated, and it predates the crash work.
    expect(stripComments(CLI)).toContain('disableHardwareAcceleration()')
  })
})

/**
 * ★ REQ-0557 §2-2 / REQ-0558 §1-1 — the shared launch classifier, exercised.
 *
 * This survives the revert because it does not test the switch: it tests the
 * decision that routes a launch headless or to a window. `launch-args.ts` exists
 * so that decision has exactly one implementation (it used to be reachable only
 * through `cli/index.ts`, which imports every command).
 */
describe('REQ-0557 §2-2 — isCliInvocation() answers correctly for real argv shapes', () => {
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

  it('★ packaged, no arguments (the normal launch) ⇒ GUI', async () => {
    expect(await withArgv([String.raw`C:\Program Files\MOJIOKO\MOJIOKO.exe`], true, [])).toBe(false)
  })

  it('★ dev `electron .` with no command ⇒ GUI', async () => {
    expect(await withArgv(['electron.exe', '.'], false, [])).toBe(false)
  })

  it('★ a .mojioko double-click ⇒ GUI, not CLI', async () => {
    // REQ-0459: the file-association launch opens a window. Misreading it as a
    // CLI run would give the user a headless process instead of their project.
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

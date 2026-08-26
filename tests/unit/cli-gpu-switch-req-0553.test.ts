import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * REQ-0553 — a CLI launch must not crash on the way out.
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
 * `disableHardwareAcceleration()` was already being called and did not prevent
 * it — it disables GPU *rasterisation* but Chromium still launches the GPU
 * process. Adding the `disable-gpu` switch removed it entirely: 0/200.
 *
 * ## Why this is a source test
 *
 * The property is "the switch is set on the CLI path and only there". Proving
 * it behaviourally would mean launching Electron a few hundred times, which is
 * what `scripts/verify-cli-stability` is for (opt-in, not part of the standard
 * gates). This keeps the wiring from being removed by accident.
 */

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')
const CLI = read('src/main/cli/index.ts')

describe('REQ-0553 — the CLI disables the GPU process', () => {
  it('★ the switch is appended', () => {
    expect(CLI).toContain("appendSwitch('disable-gpu')")
  })

  it('★ …before whenReady(), or it would have no effect', () => {
    // Chromium reads command-line switches when it initialises; appending one
    // afterwards changes nothing and would fail silently.
    const switchAt = CLI.indexOf("appendSwitch('disable-gpu')")
    const readyAt = CLI.indexOf('await app.whenReady()')
    expect(switchAt).toBeGreaterThan(-1)
    expect(readyAt).toBeGreaterThan(switchAt)
  })

  it('★ …and after the "this is a CLI invocation" decision, so the GUI is untouched', () => {
    // The GUI returns `false` from `maybeRunCli` before reaching this point.
    // A GUI that lost its GPU would be a serious regression from a CLI fix.
    const guiReturnAt = CLI.indexOf('if (tokens.length === 0) return false')
    const switchAt = CLI.indexOf("appendSwitch('disable-gpu')")
    expect(guiReturnAt).toBeGreaterThan(-1)
    expect(switchAt).toBeGreaterThan(guiReturnAt)
  })

  it('the GUI entry point does not disable the GPU', () => {
    expect(read('src/main/index.ts')).not.toContain("appendSwitch('disable-gpu')")
  })

  it('only the measured switch is set — no untested extras rode along', () => {
    // `disable-software-rasterizer` and friends were never measured here, and
    // an unmeasured switch in a fix for a measured problem is a guess.
    const appended = [...CLI.matchAll(/appendSwitch\('([^']+)'/g)].map((m) => m[1])
    expect(appended).toEqual(['disable-gpu'])
  })
})

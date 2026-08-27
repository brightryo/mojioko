/**
 * ★ REQ-0557 — disable the GPU for headless launches, as the FIRST thing main does.
 *
 * ## The fault
 *
 * A CLI command ends with `app.exit()`, a hard exit that skips Chromium's
 * graceful shutdown. When the command finishes while the GPU process is still
 * coming up, the browser process faults on the way out with `0xC0000005` — and
 * the crash replaces the EXIT CODE of a run whose output was already complete
 * and correct. A script checking `$?` sees failure after a success.
 *
 * ## Why this module exists rather than the call site in `maybeRunCli`
 *
 * REQ-0553 added `app.commandLine.appendSwitch('disable-gpu')` inside
 * `maybeRunCli`, and it helped — 16/800 became 4/800 — but it did not close the
 * race, while passing a REAL `--disable-gpu` command-line flag measured 0/200.
 * The difference is WHEN: by the time `maybeRunCli` runs, main has executed
 * ~40 module-level imports (every IPC handler, the sidecars, the encoder
 * detector), and Chromium has had all of that wall-clock to start the GPU
 * process the switch was meant to prevent.
 *
 * So the switch moved to the earliest position JS can occupy: a module imported
 * at the top of `main/index.ts`, before its own `electron` import line and
 * before every heavy import below it. This is the same layer, and the same
 * reasoning, as `mcp/early-guard` — which exists because a stray byte reached
 * stdout before `maybeRunCli` could install its guard.
 *
 * ## What it must never do
 *
 * Touch a GUI launch. The condition is `isCliInvocation()` — the SAME function
 * `maybeRunCli` routes on, imported from a module light enough to load here
 * (REQ-0557 §1-2 forbids a second copy of that decision, which is how the two
 * would drift). A plain launch and a `.mojioko` double-click both answer false
 * and reach nothing in this file.
 */
import { app } from 'electron'
import { isCliInvocation } from './cli/launch-args'

if (isCliInvocation()) {
  app.commandLine.appendSwitch('disable-gpu')
}

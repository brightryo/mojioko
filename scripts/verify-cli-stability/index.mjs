/**
 * REQ-0553 — does a CLI launch ever crash on the way out?
 *
 * ## Why this exists
 *
 * CLI invocations were intermittently exiting with `3221225477` (`0xC0000005`,
 * ACCESS_VIOLATION) instead of their real exit code. `app.exit()` is a hard
 * exit that skips Chromium's graceful shutdown, so a command that finishes
 * while the GPU process is still starting took the browser process down with
 * it. Measured before the fix, 200 launches per case:
 *
 *   read_subtitle (fastest)  11/200 = 1 in 18
 *   --help                    4/200 = 1 in 50
 *   burn --nope               1/200 = 1 in 200
 *   tools list (slowest)      0/200
 *
 * The FASTER the command, the likelier the crash — a start-up/exit race, not
 * steady-state work. `app.commandLine.appendSwitch('disable-gpu')` on the CLI
 * path removed it: 0/200.
 *
 * ## Why it is NOT in the standard gates
 *
 * A useful sample is hundreds of process launches — minutes of wall clock for
 * a fault that only appears statistically. Adding that to every REQ's gate run
 * would cost more than it catches. It lives here so the next person who
 * suspects launch instability does not have to rebuild the measurement, which
 * is exactly the test CLAUDE.md §18 sets for keeping a tool: would you write it
 * again next time? Yes.
 *
 *   npm run verify:cli-stability            # 200 launches of the worst case
 *   npm run verify:cli-stability -- 500     # more samples
 *   npm run verify:cli-stability -- 200 all # every case
 *
 * Exits non-zero if ANY launch returns an unexpected code. A single crash in
 * hundreds is the whole finding, so this is deliberately not a threshold.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const NL = String.fromCharCode(10)

if (!existsSync(ELECTRON)) {
  console.error('verify:cli-stability: electron not found — run `npm install` first')
  process.exit(2)
}
if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('verify:cli-stability: out/main missing — run `npm run build` first')
  process.exit(2)
}

const iterations = Number(process.argv[2] ?? 200)
const which = process.argv[3] ?? 'worst'

const work = mkdtempSync(join(tmpdir(), 'cli-stability-'))
const srt = join(work, 'x.srt')
writeFileSync(srt, ['1', '00:00:00,100 --> 00:00:01,000', 'hello', ''].join(NL), 'utf-8')

/*
 * Cases are cheap, window-less and NON-MUTATING: they must not read or write
 * the developer's settings, models or projects. A stability harness that
 * changed machine state would be its own bug (CLAUDE.md §18).
 *
 * `read` is first because it is the fastest — and therefore the most likely to
 * lose the race. A harness that only exercised slow commands would have
 * reported this bug as fixed when it was not.
 */
const CASES = [
  { name: 'read',  argv: ['.', 'read_subtitle', srt], expect: 0 },
  { name: 'help',  argv: ['.', '--help'], expect: 0 },
  { name: 'usage', argv: ['.', 'burn', '--nope'], expect: 2 },
]
const cases = which === 'all' ? CASES : [CASES[0]]

let total = 0
let bad = 0
console.log(`verify:cli-stability — ${iterations} launch(es) per case${NL}`)

for (const c of cases) {
  const counts = new Map()
  for (let i = 0; i < iterations; i++) {
    const r = spawnSync(ELECTRON, c.argv, {
      cwd: REPO,
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    })
    const code = r.status === null ? `signal:${r.signal}` : r.status
    counts.set(code, (counts.get(code) ?? 0) + 1)
    total++
    if (code !== c.expect) {
      bad++
      console.log(`  ${c.name}[${i}] UNEXPECTED exit=${code}` +
        (code === 3221225477 ? ' (0xC0000005 ACCESS_VIOLATION)' : ''))
    }
  }
  const dist = [...counts].sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code}:${n}`).join('  ')
  console.log(`  ${c.name.padEnd(6)} expect=${c.expect}  ${dist}`)
}

try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }

console.log(NL + (bad === 0
  ? `OK — ${total} launch(es), every exit code as expected.`
  : `FAILED — ${bad}/${total} launch(es) returned an unexpected code.`))
process.exit(bad === 0 ? 0 : 1)

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickTranslateSpawn } from '../../src/main/services/translate-spawn'

/**
 * REQ-0494 / RES-0493 §3-2 proposal 3 — invariant: a **packaged** build must
 * resolve the translation sidecar to the bundled PyInstaller exe (via its
 * `translate` subcommand) and must NEVER silently depend on a raw Python
 * interpreter.  Relying on `getPythonExecutable()` alone in packaged builds is
 * exactly the `PYTHON_MISSING` bug this REQ fixes (RES-0493).
 *
 * `pickTranslateSpawn` is the pure resolver `translation-sidecar` uses; pinning
 * it here means a future refactor that drops the bundled-exe-first ordering
 * fails a test instead of shipping a broken packaged translator.
 */
describe('REQ-0494 pickTranslateSpawn (packaged prefers bundled exe)', () => {
  const PY = 'C:/repo/.venv/Scripts/python.exe'
  const EXE = 'C:/pkg/resources/bin/transcriber/mojioko-transcriber.exe'
  const SCRIPT = 'C:/pkg/resources/python-sidecar/translate.py'

  it('packaged with a bundled exe → uses the exe with the `translate` subcommand', () => {
    const r = pickTranslateSpawn({ isPackaged: true, bundledExe: EXE, pythonExe: PY, translateScript: SCRIPT })
    expect(r).toEqual({ exe: EXE, args: ['translate'], mode: 'bundled' })
  })

  it('packaged prefers the bundled exe even when a python interpreter is also present', () => {
    // The pre-REQ-0494 code took the python path unconditionally; this asserts
    // the fix — the exe wins in packaged builds.
    const r = pickTranslateSpawn({ isPackaged: true, bundledExe: EXE, pythonExe: PY, translateScript: SCRIPT })
    expect(r.mode).toBe('bundled')
    expect(r.exe).not.toBe(PY)
  })

  it('dev → uses the .venv python + translate.py (unchanged dev path)', () => {
    const r = pickTranslateSpawn({ isPackaged: false, bundledExe: null, pythonExe: PY, translateScript: SCRIPT })
    expect(r).toEqual({ exe: PY, args: [SCRIPT], mode: 'venv' })
  })

  it('packaged with the bundle missing falls back to .venv python (local packaged debug)', () => {
    const r = pickTranslateSpawn({ isPackaged: true, bundledExe: null, pythonExe: PY, translateScript: SCRIPT })
    expect(r).toEqual({ exe: PY, args: [SCRIPT], mode: 'venv' })
  })

  /**
   * REQ-0511 M3 — this test used to be titled "NEGATIVE CONTROL" and claimed to
   * reproduce "the pre-fix production reality". It did neither: it calls the
   * FIXED resolver and walks its error path, so reverting REQ-0494 would leave
   * it green. A negative control has to fail when the fix is removed; this one
   * could not, and the label made it look like the ordering above was covered
   * twice when it was covered once (RES-0505 M3).
   *
   * What it actually pins is worth keeping, so it stays — under its real name.
   */
  it('with neither a bundled exe nor an interpreter, it throws PYTHON_MISSING rather than spawning nothing', () => {
    expect(() =>
      pickTranslateSpawn({ isPackaged: true, bundledExe: null, pythonExe: null, translateScript: SCRIPT }),
    ).toThrow('PYTHON_MISSING')
  })
})

/**
 * REQ-0511 M3 — the negative control the name above was promising, placed where
 * the regression can actually happen.
 *
 * `pickTranslateSpawn` is pure and already pinned, so no realistic edit breaks
 * it silently. The REQ-0493 bug was one level up: `translation-sidecar.ts`
 * called `getPythonExecutable()` and spawned it, which is invisible to any test
 * of the resolver. This scan fails if that caller stops routing through the
 * resolver — and, unlike the old test, removing the fix is exactly what turns
 * it red (demonstrated by patching the real file, RES-0511 §1.2).
 */
describe('REQ-0511 M3 — the CALLER routes through the resolver', () => {
  const SIDECAR = 'src/main/services/translation-sidecar.ts'

  /** Blank out comments so prose about `getPythonExecutable` cannot trip it. */
  function stripComments(text: string): string {
    const out: string[] = []
    let inBlock = false
    for (const raw of text.split('\n')) {
      let line = raw
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end === -1) { out.push(''); continue }
        line = line.slice(end + 2)
        inBlock = false
      }
      for (;;) {
        const open = line.indexOf('/*')
        if (open === -1) break
        const close = line.indexOf('*/', open + 2)
        if (close === -1) { line = line.slice(0, open); inBlock = true; break }
        line = line.slice(0, open) + ' ' + line.slice(close + 2)
      }
      const slash = line.indexOf('//')
      if (slash !== -1) line = line.slice(0, slash)
      out.push(line)
    }
    return out.join('\n')
  }

  /**
   * `getPythonExecutable()` may appear ONLY as an argument to
   * `pickTranslateSpawn` — i.e. as one candidate the resolver ranks, never as
   * the spawn target itself.
   */
  function findDirectPythonSpawn(code: string): string[] {
    const lines = stripComments(code).split('\n')
    return lines
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /getPythonExecutable\s*\(/.test(line))
      .filter(({ line }) => !/^import\b/.test(line) && !/pythonExe:\s*getPythonExecutable\(\)/.test(line))
      .map(({ line, n }) => `${SIDECAR}:${n}  ${line}`)
  }

  const source = (): string => readFileSync(join(__dirname, '..', '..', SIDECAR), 'utf-8')

  it('the sidecar calls pickTranslateSpawn', () => {
    expect(/pickTranslateSpawn\s*\(/.test(stripComments(source()))).toBe(true)
  })

  it('it never resolves the interpreter itself', () => {
    expect(findDirectPythonSpawn(source()), 'getPythonExecutable() is being used outside the resolver').toEqual([])
  })

  it('NEGATIVE CONTROL — the pre-REQ-0494 shape (spawn python directly) is detected', () => {
    const preFix = source().replace(
      /return pickTranslateSpawn\(\{/,
      'const exe = getPythonExecutable()\n  return pickTranslateSpawn({',
    )
    expect(preFix, 'the resolver call site moved — update this control').not.toBe(source())
    expect(findDirectPythonSpawn(preFix)).toHaveLength(1)
  })
})

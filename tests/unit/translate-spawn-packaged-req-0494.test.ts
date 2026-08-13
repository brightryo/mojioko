import { describe, it, expect } from 'vitest'
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

  it('NEGATIVE CONTROL — packaged with neither exe nor python throws PYTHON_MISSING', () => {
    // This is the pre-fix production reality (no bundled exe path existed, and
    // packaged has no interpreter): the resolver surfaces PYTHON_MISSING.
    expect(() =>
      pickTranslateSpawn({ isPackaged: true, bundledExe: null, pythonExe: null, translateScript: SCRIPT }),
    ).toThrow('PYTHON_MISSING')
  })
})

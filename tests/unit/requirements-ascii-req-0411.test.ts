import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * REQ-0411 — pip requirements files must be ASCII-only.
 *
 * On Japanese Windows, pip 24.0 reads `requirements.txt` with the locale
 * codec (cp932), not UTF-8.  A non-ASCII byte (e.g. an em-dash `—` = 0x94 in
 * cp932's lead-byte space) raises `UnicodeDecodeError` and aborts the install
 * before any package is seen — which is exactly what blocked the REQ-0410
 * translation dependency.  Keeping these files strictly ASCII makes
 * `pip install -r ...` succeed regardless of the reader's locale.
 *
 * This test is the CI/regression gate for that invariant.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..')

/**
 * Every requirements-style file pip may be pointed at — DISCOVERED, not listed.
 *
 * REQ-0511 L3 — this was a hand-written list of three paths, so a fourth
 * requirements file would ship unchecked and the gate would still report three
 * green tests. The invariant is about the FILES THAT EXIST, so the test reads
 * the directory. `KNOWN` below is a floor, not the source of truth: it fails if
 * discovery silently stops finding the files we know are there (a renamed
 * folder, a changed glob), which is the other way this could pass vacuously.
 */
const SIDECAR_DIR = 'python-sidecar'
const KNOWN = [
  'python-sidecar/requirements.txt',
  'python-sidecar/requirements-build.txt',
  'python-sidecar/requirements.lock.txt',
]
const REQUIREMENTS_FILES = fs
  .readdirSync(path.resolve(REPO_ROOT, SIDECAR_DIR))
  .filter((name) => /^requirements.*\.txt$/i.test(name))
  .map((name) => `${SIDECAR_DIR}/${name}`)
  .sort()

describe('REQ-0411 — requirements files are ASCII-only', () => {
  it('discovery found every known requirements file (guards a vacuous pass)', () => {
    for (const known of KNOWN) expect(REQUIREMENTS_FILES, `${known} was not discovered`).toContain(known)
  })

  for (const relPath of REQUIREMENTS_FILES) {
    it(`${relPath} contains no non-ASCII bytes`, () => {
      const abs = path.resolve(REPO_ROOT, relPath)
      const bytes = fs.readFileSync(abs)

      const offenders: string[] = []
      let line = 1
      let col = 0
      for (const byte of bytes) {
        if (byte === 0x0a) {
          line += 1
          col = 0
          continue
        }
        col += 1
        if (byte > 0x7f) {
          offenders.push(`line ${line}, col ${col}: byte 0x${byte.toString(16)}`)
        }
      }

      expect(offenders, `non-ASCII bytes found:\n${offenders.join('\n')}`).toEqual([])
    })
  }
})

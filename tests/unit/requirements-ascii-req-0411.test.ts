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

// Every requirements-style file pip may be pointed at.  Add new ones here.
const REQUIREMENTS_FILES = [
  'python-sidecar/requirements.txt',
  'python-sidecar/requirements-build.txt',
  'python-sidecar/requirements.lock.txt',
]

describe('REQ-0411 — requirements files are ASCII-only', () => {
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

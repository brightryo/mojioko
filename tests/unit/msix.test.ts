import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  isPackagedAsMsix,
  getMsixPackageFamilyName,
  buildMsixVirtualizedAppDataPath,
} from '../../src/main/lib/msix'

/**
 * REQ-20260615-071 — pure MSIX detection / path-construction helpers.
 *
 * These functions back the v1.3.1 fix for "open models folder" pointing
 * at the wrong physical location under an MSIX install.  Each helper is
 * pure (no electron / fs / process-global access), so tests pass in
 * inputs directly rather than stubbing `process`.
 *
 * Coverage goals (see RES-20260615-071 §3):
 *   - isPackagedAsMsix returns the right answer for NSIS / MSIX / non-win32 /
 *     execPath-fallback / explicit-flag combinations.
 *   - getMsixPackageFamilyName parses both the standard 5-segment
 *     `Name_Version_Arch__PublisherId` layout (empty ResourceId) and the
 *     less-common 5-segment layout with a non-empty ResourceId, and
 *     returns null for shapes that don't match the WindowsApps prefix.
 *   - buildMsixVirtualizedAppDataPath wires the segments together in the
 *     exact order the OS expects, with no leading drive surprise.
 */

describe('REQ-071 — isPackagedAsMsix', () => {
  it('returns false on non-Windows platforms regardless of other signals', () => {
    expect(
      isPackagedAsMsix({
        platform: 'linux',
        execPath: '/usr/bin/mojioko',
        windowsStore: true,
      })
    ).toBe(false)
    expect(
      isPackagedAsMsix({
        platform: 'darwin',
        execPath: '/Applications/MOJIOKO.app/Contents/MacOS/MOJIOKO',
      })
    ).toBe(false)
  })

  it('returns true when process.windowsStore === true (primary signal)', () => {
    expect(
      isPackagedAsMsix({
        platform: 'win32',
        execPath: 'C:\\anything\\at\\all.exe',
        windowsStore: true,
      })
    ).toBe(true)
  })

  it('returns true when execPath contains \\WindowsApps\\ (fallback signal)', () => {
    expect(
      isPackagedAsMsix({
        platform: 'win32',
        execPath:
          'C:\\Program Files\\WindowsApps\\brightryo.MOJIOKO_1.3.0.0_x64__h12345\\app\\MOJIOKO.exe',
      })
    ).toBe(true)
  })

  it('fallback is case-insensitive (\\WindowsApps\\ may appear lowercase from some sources)', () => {
    expect(
      isPackagedAsMsix({
        platform: 'win32',
        execPath: 'c:\\program files\\windowsapps\\foo.bar_1_x64__h\\app\\foo.exe',
      })
    ).toBe(true)
  })

  it('returns false for an ordinary NSIS install on Windows', () => {
    expect(
      isPackagedAsMsix({
        platform: 'win32',
        execPath:
          'C:\\Users\\someone\\AppData\\Local\\Programs\\mojioko\\MOJIOKO.exe',
        windowsStore: undefined,
      })
    ).toBe(false)
  })

  it('returns false when windowsStore is the literal string "true" (avoid coercion bugs)', () => {
    // Defensive: Electron may regress and emit a string; only the literal
    // boolean `true` should satisfy the primary signal.  Path fallback can
    // still rescue real MSIX installs.
    expect(
      isPackagedAsMsix({
        platform: 'win32',
        execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\mojioko\\MOJIOKO.exe',
        windowsStore: 'true',
      })
    ).toBe(false)
  })
})

describe('REQ-071 — getMsixPackageFamilyName', () => {
  it('parses the standard layout (empty ResourceId → "Name__PublisherId")', () => {
    expect(
      getMsixPackageFamilyName(
        'C:\\Program Files\\WindowsApps\\brightryo.MOJIOKO_1.3.1.0_x64__h12345\\app\\MOJIOKO.exe'
      )
    ).toBe('brightryo.MOJIOKO_h12345')
  })

  it('parses a layout with a non-empty ResourceId', () => {
    expect(
      getMsixPackageFamilyName(
        'C:\\Program Files\\WindowsApps\\brightryo.MOJIOKO_1.3.1.0_x64_jp_h12345\\app\\MOJIOKO.exe'
      )
    ).toBe('brightryo.MOJIOKO_h12345')
  })

  it('handles a lowercase \\windowsapps\\ segment', () => {
    expect(
      getMsixPackageFamilyName(
        'c:\\program files\\windowsapps\\foo.bar_1.0.0.0_x64__pubhash\\app\\foo.exe'
      )
    ).toBe('foo.bar_pubhash')
  })

  it('returns null when execPath does not contain \\WindowsApps\\', () => {
    expect(
      getMsixPackageFamilyName(
        'C:\\Users\\x\\AppData\\Local\\Programs\\mojioko\\MOJIOKO.exe'
      )
    ).toBeNull()
  })

  it('returns null when the package full name lacks enough underscore segments', () => {
    expect(
      getMsixPackageFamilyName(
        'C:\\Program Files\\WindowsApps\\onlytwo_parts\\app\\foo.exe'
      )
    ).toBeNull()
    expect(
      getMsixPackageFamilyName(
        'C:\\Program Files\\WindowsApps\\one\\app\\foo.exe'
      )
    ).toBeNull()
  })

  it('returns null when the parsed Name or PublisherId is empty', () => {
    // Leading underscore → empty Name; trailing underscore → empty PublisherId.
    expect(
      getMsixPackageFamilyName(
        'C:\\Program Files\\WindowsApps\\_1.0.0.0_x64__h12345\\app\\foo.exe'
      )
    ).toBeNull()
  })
})

describe('REQ-071 — buildMsixVirtualizedAppDataPath', () => {
  it('joins home, the WindowsApps virtualization fixed segments, and the sub-segments', () => {
    expect(
      buildMsixVirtualizedAppDataPath(
        'C:\\Users\\someone',
        'brightryo.MOJIOKO_h12345',
        'MOJIOKO',
        'models'
      )
    ).toBe(
      join(
        'C:\\Users\\someone',
        'AppData',
        'Local',
        'Packages',
        'brightryo.MOJIOKO_h12345',
        'LocalCache',
        'Roaming',
        'MOJIOKO',
        'models'
      )
    )
  })

  it('accepts zero sub-segments and returns the Roaming root for the package', () => {
    expect(
      buildMsixVirtualizedAppDataPath(
        'C:\\Users\\x',
        'foo.bar_h'
      )
    ).toBe(
      join('C:\\Users\\x', 'AppData', 'Local', 'Packages', 'foo.bar_h', 'LocalCache', 'Roaming')
    )
  })
})

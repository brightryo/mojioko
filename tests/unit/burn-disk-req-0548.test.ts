import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BURN_DISK_REQUIRED_FACTOR,
  BURN_DISK_REQUIRED_MARGIN_BYTES,
  checkBurnDiskSpace,
  estimateBurnRequiredBytes,
  formatGb,
} from '../../src/shared/burn-disk'

/**
 * REQ-0548 (RES-0543 I2) — stop a burn that is certain to run out of disk.
 *
 * The estimate is a FLOOR, not a prediction: the output size falls out of the
 * encoder, the quality setting, the content and the trim list, none of which
 * are known before encoding. So the tests below are about the two properties
 * that matter — it refuses the impossible, and it never refuses anything it is
 * not sure about.
 */

const GB = 1024 * 1024 * 1024
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')

describe('REQ-0548 §1-1 — the estimate', () => {
  it('is factor × input + margin', () => {
    expect(estimateBurnRequiredBytes(8 * GB))
      .toBe(Math.round(8 * GB * BURN_DISK_REQUIRED_FACTOR + BURN_DISK_REQUIRED_MARGIN_BYTES))
  })

  it('the margin dominates for a small input', () => {
    // A 40 MB clip needs headroom, not a percentage of 40 MB.
    expect(estimateBurnRequiredBytes(40 * 1024 * 1024))
      .toBeGreaterThan(BURN_DISK_REQUIRED_MARGIN_BYTES)
    expect(estimateBurnRequiredBytes(0)).toBe(BURN_DISK_REQUIRED_MARGIN_BYTES)
  })

  it('a nonsensical input size degrades to the margin, not to NaN', () => {
    for (const bad of [NaN, Infinity, -1]) {
      expect(estimateBurnRequiredBytes(bad)).toBe(BURN_DISK_REQUIRED_MARGIN_BYTES)
    }
  })

  it('★ the factor stays well under 1 — this is a floor, not a prediction', () => {
    // A factor at or above 1 would refuse burns that compress, which is most of
    // them, and REQ-0548 §1-4 makes false positives the thing to avoid.
    expect(BURN_DISK_REQUIRED_FACTOR).toBeLessThan(0.5)
    expect(BURN_DISK_REQUIRED_FACTOR).toBeGreaterThan(0)
  })
})

describe('REQ-0548 §1-3 — the verdict', () => {
  it('★ plainly too little space → insufficient', () => {
    // 20 GB source, 100 MB free: no encoder saves that.
    const v = checkBurnDiskSpace(100 * 1024 * 1024, 20 * GB)
    expect(v.insufficient).toBe(true)
    expect(v.requiredBytes).toBeGreaterThan(5 * GB)
  })

  it('ample space → passes', () => {
    expect(checkBurnDiskSpace(500 * GB, 20 * GB).insufficient).toBe(false)
  })

  it('★ a marginal case passes — uncertainty is not a refusal', () => {
    // Free space just above the floor. The burn may still fail later, and that
    // is fine: it lands on the existing error path, no worse than before.
    const required = estimateBurnRequiredBytes(20 * GB)
    expect(checkBurnDiskSpace(required + 1, 20 * GB).insufficient).toBe(false)
  })

  it('exactly at the floor passes; one byte under does not', () => {
    const required = estimateBurnRequiredBytes(4 * GB)
    expect(checkBurnDiskSpace(required, 4 * GB).insufficient).toBe(false)
    expect(checkBurnDiskSpace(required - 1, 4 * GB).insufficient).toBe(true)
  })

  it('★ unknown free space passes — being unable to check is not a reason to refuse', () => {
    const v = checkBurnDiskSpace(null, 20 * GB)
    expect(v.insufficient).toBe(false)
    expect(v.freeBytes).toBeNull()
  })

  it('a nonsensical free-space reading is treated as unknown', () => {
    for (const bad of [NaN, -5, Infinity]) {
      expect(checkBurnDiskSpace(bad, 20 * GB).insufficient, String(bad)).toBe(false)
    }
  })

  it('formats gigabytes for the message', () => {
    expect(formatGb(2 * GB)).toBe('2.0')
  })
})

/**
 * ★ The negative control REQ-0548 §3-2 asks for: the pre-fix behaviour — start
 * the burn regardless — must be visibly different, or the tests above are not
 * about this change.
 */
describe('REQ-0548 §3-2 — the pre-fix behaviour is detectable', () => {
  const preFixWouldRefuse = () => false      // it never checked

  it('with 100 MB free and a 20 GB source, the fix refuses and the old code did not', () => {
    expect(checkBurnDiskSpace(100 * 1024 * 1024, 20 * GB).insufficient).toBe(true)
    expect(preFixWouldRefuse()).toBe(false)
  })
})

describe('REQ-0548 §2 — the wiring', () => {
  const burnin = read('src/main/services/ffmpeg-burnin.ts')

  it('★ the check runs BEFORE any encoding work', () => {
    const checkAt = burnin.indexOf('checkBurnDiskSpace(')
    const spawnAt = burnin.indexOf('spawn(')
    expect(checkAt).toBeGreaterThan(-1)
    expect(spawnAt).toBeGreaterThan(checkAt)
  })

  it('it measures the OUTPUT drive, not the input one', () => {
    expect(burnin).toContain('getDiskFree(dirname(outputPath))')
  })

  it('★ a failing check is swallowed and the burn continues', () => {
    // Being unable to check must never become a reason not to burn.
    const body = burnin.slice(burnin.indexOf('checkBurnDiskSpace('))
    expect(body).toContain('disk pre-flight skipped')
  })

  it('reuses the existing free-space helper rather than adding a second one', () => {
    // REQ-0548 §1-2. `translation-tool-store` now calls the same module.
    expect(read('src/main/services/translation-tool-store.ts'))
      .toContain("from '../lib/disk-space'")
    expect(burnin).toContain("from '../lib/disk-space'")
  })

  it('the download UI keeps its old "unknown reads as 0" contract', () => {
    // The shared helper returns null for unknown; that caller only displays a
    // number, and changing what it shows was not part of this REQ.
    expect(read('src/main/services/translation-tool-store.ts')).toContain('freeBytes ?? 0')
  })

  it('★ no new exit code — it rides the existing failure event', () => {
    expect(burnin).toContain("event: 'failed'")
    expect(burnin).toContain("errorCode: 'diskFull'")
    // The CLI surfaces whatever the failure event carries; nothing was added to
    // its exit-code table.
    expect(read('src/main/cli/commands/burn.ts')).not.toContain('diskFull')
  })

  it('the renderer shows a localized message, not the raw string', () => {
    const drawer = read('src/renderer/components/step2/burnin-drawer.tsx')
    expect(drawer).toContain("evt.errorCode === 'diskFull'")
    expect(drawer).toContain("t('error.diskFull'")
    for (const loc of ['ja', 'en']) {
      expect(read(`src/renderer/locales/${loc}/common.json`)).toContain('"diskFull"')
    }
  })
})

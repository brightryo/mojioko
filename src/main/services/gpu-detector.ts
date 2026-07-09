import { execFile } from 'child_process'
import { classifyAdapters } from './gpu-classify'
import log from '../lib/logger'
export { classifyAdapters } from './gpu-classify'
export type { GpuDetectionResult } from './gpu-classify'

/**
 * REQ-0150 — NVIDIA presence detector, updated from the REQ-0149 single-
 * adapter shape.  Now returns the full adapter roster so the renderer
 * can distinguish three cases (spec §2):
 *
 *   (1) An NVIDIA adapter is present → `nvidiaDetected: true`,
 *       `nvidiaName` carries the first NVIDIA row.  The 2-card
 *       accelerator picker opens with both CPU and GPU cards.
 *   (2) One or more adapters are present but NONE are NVIDIA (Radeon,
 *       Intel Iris, Ryzen APU iGPU, …) → the accordion stays collapsed
 *       and shows "Your GPU (X) is not supported for GPU acceleration.
 *       An NVIDIA GPU is required."  `otherAdapters[0]` is the string
 *       used inline in that copy.
 *   (3) No adapters at all (or WMI returned nothing) → collapsed
 *       accordion with the generic "no GPU detected" copy.
 *
 * The important REQ-0150 correctness contract is "iterate every row,
 * do not stop at the first adapter."  Owner's box is NVIDIA RTX 3060 +
 * Ryzen 5 5600G iGPU → WMI returns both rows and the RTX must win.
 * Before REQ-0150 we bailed on the first match, which happened to be
 * NVIDIA on this box but would have been wrong if the iGPU had been
 * enumerated first (order is documented as undefined by MSDN).
 */

import type { GpuDetectionResult } from './gpu-classify'

const DETECTION_TIMEOUT_MS = 3000

let cached: GpuDetectionResult | null = null

export async function detectGpuAdapters(force = false): Promise<GpuDetectionResult> {
  if (!force && cached !== null) return cached
  if (process.platform !== 'win32') {
    cached = { nvidiaDetected: false, nvidiaName: null, otherAdapters: [] }
    return cached
  }
  const adapters = await runPowerShellEnumeration()
  cached = classifyAdapters(adapters)
  return cached
}

function runPowerShellEnumeration(): Promise<string[]> {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // One name per line.  `Select-Object -ExpandProperty Name` flattens
      // the object stream to raw strings so we don't have to parse WMI-
      // formatted output.
      "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
    ]
    const child = execFile(
      'powershell.exe',
      args,
      { timeout: DETECTION_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log.warn(`[gpu-detector] Get-CimInstance failed: ${err.message}`)
          resolve([])
          return
        }
        const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        log.info(`[gpu-detector] enumerated ${lines.length} adapter(s): ${lines.join(' | ')}`)
        resolve(lines)
      },
    )
    child.on('error', (e) => {
      log.warn(`[gpu-detector] spawn error: ${e.message}`)
      resolve([])
    })
  })
}

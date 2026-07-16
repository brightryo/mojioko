/**
 * REQ-0150 §2 — pure classifier for the WMI-enumerated video adapter
 * list.  Kept in its own file (no `electron` / `logger` / `child_process`
 * imports) so `tests/unit/gpu-detector.test.ts` can pin the truth table
 * without spinning up an Electron test harness.  The impure
 * `runPowerShellEnumeration` and the caching wrapper live in
 * `gpu-detector.ts` and re-export from here.
 *
 * Correctness contract: every adapter row is inspected; the presence of
 * "nvidia" (case-insensitive) anywhere in a row's Name flips the whole
 * result to `nvidiaDetected: true`.  This is what guards the owner's
 * NVIDIA + iGPU box from a false-negative when WMI enumerates the iGPU
 * first (MSDN documents adapter order as undefined).
 */
export interface GpuDetectionResult {
  /** True iff at least one adapter's name contains "nvidia" (case-insensitive). */
  nvidiaDetected: boolean
  /** Display name of the first NVIDIA adapter, or null when none. */
  nvidiaName: string | null
  /** Display names of adapters whose vendor is NOT NVIDIA (empty when only NVIDIA / no adapters). */
  otherAdapters: string[]
}

export function classifyAdapters(adapters: string[]): GpuDetectionResult {
  const nvidiaRows: string[] = []
  const otherRows: string[] = []
  for (const raw of adapters) {
    const name = raw.trim()
    if (!name) continue
    if (/nvidia/i.test(name)) {
      nvidiaRows.push(name)
    } else {
      otherRows.push(name)
    }
  }
  return {
    nvidiaDetected: nvidiaRows.length > 0,
    nvidiaName: nvidiaRows[0] ?? null,
    otherAdapters: otherRows,
  }
}

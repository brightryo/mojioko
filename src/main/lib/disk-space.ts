import { existsSync, statfsSync } from 'fs'
import { parse } from 'path'

/**
 * REQ-0548 §1-2 — free space on the volume holding a path.
 *
 * Extracted from `translation-tool-store.ts`, where it already existed, so the
 * burn-in pre-check reuses it rather than adding a second way to ask the same
 * question.
 *
 * ## The one behavioural difference, and why it matters
 *
 * The original returned `freeBytes: 0` when `statfs` threw, which conflates
 * "the disk is full" with "I could not find out". The download UI could live
 * with that — it only shows the number. A burn-in gate cannot: treating "could
 * not find out" as zero would refuse to start on any machine where the syscall
 * fails, which is exactly the false positive REQ-0548 §1-4 rules out. So this
 * returns `null` for unknown, and the caller decides.
 */
export interface DiskFree {
  /** Free bytes, or `null` when the query failed. */
  freeBytes: number | null
  /** The volume root, for showing the user which drive is short. */
  drive: string
}

export function getDiskFree(dirPath: string): DiskFree {
  const { root } = parse(dirPath)
  const drive = root || 'C:\\'
  const statPath = existsSync(dirPath) ? dirPath : existsSync(drive) ? drive : '.'
  try {
    const stats = statfsSync(statPath)
    return { freeBytes: stats.bavail * stats.bsize, drive }
  } catch {
    return { freeBytes: null, drive }
  }
}

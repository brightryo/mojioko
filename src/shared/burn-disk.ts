/**
 * REQ-0548 (RES-0543 I2) — refuse a burn that is CERTAIN to run out of disk.
 *
 * ## What this is for, and what it is not for
 *
 * A long burn that dies at 95 % with a full disk currently surfaces as a tail
 * of ffmpeg stderr in a toast, which tells the user nothing they can act on.
 * The model and translation-tool downloads already check free space first; the
 * burn did not.
 *
 * The goal is **to stop the obviously impossible**, not to predict the output
 * size. Predicting it properly is not possible before encoding: the size falls
 * out of the encoder, the quality setting, the content, and the trim list.
 *
 * ## The rule
 *
 *   required = inputBytes × FACTOR + MARGIN
 *
 * with **FACTOR = 0.25** and **MARGIN = 512 MiB**.
 *
 * Both numbers are deliberately LOW, because REQ-0548 §1-4 makes false
 * positives the thing to avoid: refusing a burn that would have worked is worse
 * than the status quo, while failing to predict one that dies leaves the user
 * exactly where they are today. A burn-in re-encode of the same footage lands
 * anywhere from roughly a quarter of the source (heavy compression of simple
 * content) to several times it; a quarter is at the bottom of that range, so
 * anything below it plus half a gigabyte of headroom is not a close call.
 *
 * The margin dominates for small inputs — where a percentage would be
 * meaningless — and the factor dominates for large ones. 512 MiB covers
 * container overhead, the filesystem's own slack, and the fact that Windows
 * behaves badly well before a volume reaches literal zero.
 *
 * ## Unknown free space is not a refusal
 *
 * `freeBytes === null` means the query failed, which is not evidence of
 * anything. It passes. Being unable to check must never become a reason not to
 * burn (REQ-0548 §2).
 */
export const BURN_DISK_REQUIRED_FACTOR = 0.25
export const BURN_DISK_REQUIRED_MARGIN_BYTES = 512 * 1024 * 1024

/** The conservative floor, in bytes, below which a burn cannot succeed. */
export function estimateBurnRequiredBytes(inputBytes: number): number {
  const size = Number.isFinite(inputBytes) && inputBytes > 0 ? inputBytes : 0
  return Math.round(size * BURN_DISK_REQUIRED_FACTOR + BURN_DISK_REQUIRED_MARGIN_BYTES)
}

export interface BurnDiskVerdict {
  /** True only when there is definitely not enough room. */
  insufficient: boolean
  requiredBytes: number
  freeBytes: number | null
}

export function checkBurnDiskSpace(
  freeBytes: number | null,
  inputBytes: number,
): BurnDiskVerdict {
  const requiredBytes = estimateBurnRequiredBytes(inputBytes)
  // `null` (unknown) and a negative reading both mean "no information".
  const known = typeof freeBytes === 'number' && Number.isFinite(freeBytes) && freeBytes >= 0
  return {
    insufficient: known && freeBytes < requiredBytes,
    requiredBytes,
    freeBytes: known ? freeBytes : null,
  }
}

/** Whole gigabytes, one decimal — for the message the user reads. */
export function formatGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1)
}

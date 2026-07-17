import log from '../lib/logger'

/**
 * REQ-0244 — per-target-key download coordinator.  Supersedes the
 * REQ-0241 single-slot mutex.
 *
 * Rules (finalized by the owner in REQ-0244 §0):
 *
 *   • Different targets download in parallel.  Cross-kind (model + GPU
 *     tool + font at once) is allowed; same-kind different-target
 *     (large-v3 + large-v3-turbo) is allowed too.
 *   • Same target cannot double-start (`{kind, targetId}` is unique).
 *     A second `acquire()` for a held key returns `{ busy: true }`
 *     so the IPC layer can surface `DOWNLOAD_BUSY`.
 *   • The font-picker's "batch DL" orchestration is a *renderer-side*
 *     concern; it walks the target list and per-iteration acquires
 *     `font:<id>` slots.  The manager doesn't know or care about
 *     "batch" as a concept — that keeps the coordinator small and
 *     unaware of UI phases.
 *
 * Keys are `${kind}:${targetId}` strings.  A slot holds the
 * AbortController, the release hook, and a token-identity guard so a
 * stale `release()` from a completed download can never wipe a fresh
 * slot that later took the same key.
 */

export type DownloadKind = 'model' | 'gpu-tool' | 'font'

export interface ActiveDownloadInfo {
  kind: DownloadKind
  targetId: string
  label: string
  startedAt: number
}

export interface DownloadToken {
  kind: DownloadKind
  targetId: string
  label: string
  signal: AbortSignal
  /** Idempotent; only releases if this token still owns the slot. */
  release(): void
  /** Aborts the signal then releases.  Idempotent. */
  cancel(): void
}

export type AcquireResult =
  | DownloadToken
  | { busy: true; existing: ActiveDownloadInfo }

interface ActiveSlot extends ActiveDownloadInfo {
  controller: AbortController
  released: boolean
}

function keyOf(kind: DownloadKind, targetId: string): string {
  return `${kind}:${targetId}`
}

class DownloadManager {
  private active = new Map<string, ActiveSlot>()

  /**
   * Take the slot for `<kind, targetId>`.  Returns a token on success
   * or a busy object naming the existing holder on contention.  Only
   * same-key contention returns busy — different keys never block.
   */
  acquire(kind: DownloadKind, targetId: string, label?: string): AcquireResult {
    const key = keyOf(kind, targetId)
    const existing = this.active.get(key)
    if (existing) {
      return {
        busy: true,
        existing: this.slotSnapshot(existing),
      }
    }
    const controller = new AbortController()
    const slot: ActiveSlot = {
      kind,
      targetId,
      label: label ?? targetId,
      startedAt: Date.now(),
      controller,
      released: false,
    }
    this.active.set(key, slot)
    log.info(`[download-manager] acquired ${key} (label=${slot.label})`)

    const release = (): void => {
      if (slot.released) return
      // Identity guard: only the caller that took this exact controller
      // can release it.  Prevents a late `finally { release() }` in a
      // cancelled download from wiping a slot that a fresh call has
      // already re-acquired (same key, different token).
      const current = this.active.get(key)
      if (current?.controller !== controller) {
        slot.released = true
        return
      }
      slot.released = true
      this.active.delete(key)
      log.info(`[download-manager] released ${key}`)
    }
    const cancel = (): void => {
      if (!slot.released) {
        controller.abort()
      }
      release()
    }
    return {
      kind,
      targetId,
      label: slot.label,
      signal: controller.signal,
      release,
      cancel,
    }
  }

  /**
   * True if the given key is currently held.  Used by tests and by
   * UI code paths that want to check before invoking IPC (rare —
   * per-component local state normally suffices).
   */
  isActive(kind: DownloadKind, targetId: string): boolean {
    return this.active.has(keyOf(kind, targetId))
  }

  /**
   * Return a snapshot of every currently-active download.  Independent
   * of insertion order; callers that need stability should sort.
   */
  snapshot(): ActiveDownloadInfo[] {
    return Array.from(this.active.values(), (slot) => this.slotSnapshot(slot))
  }

  /**
   * Test-only escape hatch.  Aborts every held signal and clears the
   * map so each `it()` starts idle.  Not called by production code.
   */
  _resetForTests(): void {
    for (const slot of this.active.values()) {
      if (!slot.released) slot.controller.abort()
      slot.released = true
    }
    this.active.clear()
  }

  private slotSnapshot(slot: ActiveSlot): ActiveDownloadInfo {
    return {
      kind: slot.kind,
      targetId: slot.targetId,
      label: slot.label,
      startedAt: slot.startedAt,
    }
  }
}

export const downloadManager = new DownloadManager()

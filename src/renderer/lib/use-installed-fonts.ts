import { useState, useEffect } from 'react'
import { listFonts } from '@/services/font'
import type { FontId } from '../../shared/fonts'

/**
 * Lightweight hook that returns the set of currently-installed (bundled
 * or downloaded) font IDs.  Fires one `listFonts()` IPC call on mount;
 * does NOT subscribe to subsequent download/uninstall events because the
 * per-row picker uses this only for the dropdown enumeration — if the
 * user opens Settings, installs a font, then opens the row picker again
 * the component re-mounts inside its popover and re-fetches.
 *
 * REQ-022 step 1 — supports the STEP 2 per-row font selector.
 */
export function useInstalledFontIds(): ReadonlySet<FontId> {
  const [ids, setIds] = useState<Set<FontId>>(() => new Set())
  useEffect(() => {
    let cancelled = false
    listFonts().then((r) => {
      if (cancelled || !r.ok) return
      const next = new Set<FontId>()
      for (const f of r.data.fonts) {
        if (f.status === 'bundled' || f.status === 'installed') next.add(f.id)
      }
      setIds(next)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return ids
}

import { useState, useEffect } from 'react'
import { listFonts } from '@/services/font'
import { useUiStore } from '@/stores/ui-store'
import type { FontId } from '../../shared/fonts'

/**
 * Returns the set of currently-installed (bundled or downloaded) font IDs.
 * Refetches whenever `useUiStore.fontInventoryVersion` bumps so a popover
 * list opened in one component picks up changes made elsewhere (e.g. the
 * user removes a font from Settings while STEP 2 stays mounted).
 *
 * REQ-022 step 1 / REQ-025 (iv).
 */
export function useInstalledFontIds(): ReadonlySet<FontId> {
  const [ids, setIds] = useState<Set<FontId>>(() => new Set())
  // Subscribe to the version so the useEffect re-runs on every bump.
  // Reads at the slice level so unrelated UI store changes don't trigger
  // a re-render here.
  const version = useUiStore((s) => s.fontInventoryVersion)
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
  }, [version])
  return ids
}

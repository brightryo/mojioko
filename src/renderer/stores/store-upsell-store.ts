import { create } from 'zustand'

/**
 * REQ-091 — global open/close state for the "this font is paid-only"
 * upsell dialog.  The same dialog is triggered from at least three font
 * selection surfaces (FontPicker in the Settings ▸ Fonts tab and the
 * STEP 1 Subtitle Style dialog, RowFontSelector in the STEP 2
 * inspector, BulkFontPicker in the bulk-edit bar).  Threading
 * open/close props through every one of those would mean rendering a
 * dialog instance per surface AND coordinating which is currently open;
 * a single global slot avoids both and matches the existing pattern
 * the project already uses for cross-surface dialogs (font licenses,
 * settings, donations).
 *
 * The dialog component itself (`StoreUpsellDialog`) is mounted exactly
 * once at the App root and subscribes here.  Any trigger surface calls
 * `useStoreUpsellStore.getState().open()` and the dialog appears.
 *
 * MSIX/paid builds never trigger this (the tier policy doesn't lock
 * any fonts in MSIX; see `font-tier.ts`).  The store still exists in
 * MSIX builds — it just stays at `open: false` forever, which is
 * cheap and keeps the wiring tier-agnostic at the component level.
 */
interface StoreUpsellStore {
  open: boolean
  setOpen: (next: boolean) => void
  /** Convenience trigger from imperative call sites (no need to import setOpen). */
  openUpsell: () => void
}

export const useStoreUpsellStore = create<StoreUpsellStore>((set) => ({
  open: false,
  setOpen: (next) => set({ open: next }),
  openUpsell: () => set({ open: true }),
}))

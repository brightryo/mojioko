import { create } from 'zustand'

/**
 * REQ-086 — current preview-mix audio URL.
 *
 * Populated by `step1.tsx` on a successful transcription that produced a
 * mix (i.e. the source video had >= 2 audio tracks).  The renderer's
 * `VideoPreviewPanel` mounts a hidden `<audio src={url}>` alongside the
 * `<video muted>` element when this is non-null, and synchronises the
 * two via a rAF drift-correction loop so every track sounds at once
 * (matching the burn-in's simple-mode amix).
 *
 * Lifecycle:
 *
 *   - `setUrl(u)` — called once per successful transcription run.
 *     The URL is a `mojioko-preview-mix://current?t=<ms>` string
 *     whose query is a cache buster so `<audio>` re-fetches after a
 *     fresh generation (the file path is fixed, so without the buster
 *     Chromium would serve the stale-but-cached prior mix).
 *   - `clear()` — called from `project-store.reset` so loading a new
 *     project drops the stale URL.  Until the next transcription
 *     finishes, the preview falls back to `<video>`-only audio.
 *
 * Single source of truth for "is the multi-track preview mix
 * available right now?": components subscribe to `useUrl` and treat
 * `null` as "play the video element's own audio (single-track default)".
 */
interface PreviewMixStore {
  url: string | null
  setUrl: (url: string | null) => void
  clear: () => void
}

export const usePreviewMixStore = create<PreviewMixStore>((set) => ({
  url: null,
  setUrl: (url) => set({ url }),
  clear: () => set({ url: null }),
}))

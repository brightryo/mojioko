/**
 * REQ-0194 phase 3b — orchestrates the `.mojioko` open flow.
 *
 * Mounted once at the App level; subscribes to the native menu's
 * `menu:openProject` IPC event and drives a small state machine
 * that presents (in order):
 *
 *   1. Discard-confirm     (only if there's already a loaded project)
 *   2. OS file picker      (native, not React)
 *   3. Parse failure toast (if the file isn't a `.mojioko` JSON)
 *   4. Source-missing dialog + re-pick (if the saved input path is gone)
 *   5. Identity-mismatch dialog (if duration or resolution disagrees)
 *   6. Font-warning dialog (soft-warn, user can cancel or proceed)
 *   7. Populate project store + navigate to /step2
 *
 * Kept intentionally as a single file so the state machine is easy to
 * audit; the individual dialogs are small enough that splitting them
 * would obscure the flow.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { usePreviewMixStore } from '@/stores/preview-mix-store'
import { pickAndParseProjectFile } from '@/services/project-file'
import { openVideoDialog, fileExists } from '@/services/dialog'
import { probeVideo } from '@/services/video'
import { listFonts } from '@/services/font'
import { DEFAULT_FONT_ID, type FontInfo } from '../../../shared/fonts'
import type { VideoInfo } from '../../../shared/types'
import type { ProjectFile } from '../../../shared/project-file'
import {
  checkIdentity,
  collectUsedFontIds,
  videoInfoFromProject,
} from '../../../shared/project-file'

type FlowState =
  | { kind: 'idle' }
  | { kind: 'discard-confirm' }
  | { kind: 'loading'; message: string }
  | { kind: 'source-missing'; project: ProjectFile }
  | {
      kind: 'identity-mismatch'
      project: ProjectFile
      currentVideo: VideoInfo
    }
  | {
      kind: 'font-warning'
      project: ProjectFile
      currentVideo: VideoInfo
      unavailable: FontInfo[]
      locked: FontInfo[]
    }

function formatDurationSec(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—'
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

export function ProjectOpenController() {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const [state, setState] = useState<FlowState>({ kind: 'idle' })

  useEffect(() => {
    const unsub = window.electronAPI?.subscribeToChannel('menu:openProject', () => {
      void beginFlow()
    })
    return () => {
      unsub?.()
    }
    // Handlers are captured by ref-like closure over setState/navigate;
    // remounting the effect on locale change is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function beginFlow() {
    // Ignore re-entry while a flow is in progress — clicking the menu
    // repeatedly should not stack dialogs.
    if (state.kind !== 'idle') return

    const proj = useProjectStore.getState()
    const hasProject = proj.videoLoadingState === 'loaded' && proj.video !== null

    if (hasProject) {
      // Waiting for the discard-confirm decision.  The dialog buttons
      // drive the next step via `handleDiscardConfirm(...)`.
      setState({ kind: 'discard-confirm' })
      return
    }
    void pickAndContinue()
  }

  async function pickAndContinue() {
    setState({ kind: 'loading', message: '' })
    const picked = await pickAndParseProjectFile()
    if (!picked.ok) {
      setState({ kind: 'idle' })
      if (picked.reason === 'cancelled') return
      if (picked.reason === 'io-error') {
        toast.error(t('project.open.toastError', { error: picked.message }))
        return
      }
      // parse-failed — show a specific reason.
      const reasonKey = ({
        'invalid-json': 'project.open.reasonInvalidJson',
        'not-mojioko': 'project.open.reasonNotMojioko',
        'unsupported-version': 'project.open.reasonUnsupportedVersion',
        'missing-fields': 'project.open.reasonMissingFields',
      } as const)[picked.parseReason]
      toast.error(t('project.open.toastError', { error: t(reasonKey) }))
      return
    }

    await validateSource(picked.project)
  }

  async function validateSource(project: ProjectFile) {
    const exists = await fileExists(project.source.filePath)
    if (!exists) {
      setState({ kind: 'source-missing', project })
      return
    }
    await validateIdentity(project, project.source.filePath)
  }

  async function validateIdentity(project: ProjectFile, videoPath: string) {
    setState({ kind: 'loading', message: '' })
    const r = await probeVideo(videoPath)
    if (!r.ok) {
      setState({ kind: 'idle' })
      toast.error(t('project.open.toastError', { error: r.error.message }))
      return
    }
    const currentVideo = r.data
    const identity = checkIdentity({ saved: project.source, current: currentVideo })
    if (!identity.ok) {
      setState({ kind: 'identity-mismatch', project, currentVideo })
      return
    }
    await checkFontsAndFinalize(project, currentVideo)
  }

  async function checkFontsAndFinalize(project: ProjectFile, currentVideo: VideoInfo) {
    // Rows with `fontId: undefined` inherit the project's default font.
    // The default isn't recorded in the file (v1), so use the CURRENT
    // settings default — the same font those rows would resolve to at
    // burn-in immediately after opening.
    const settingsDefault = useSettingsStore.getState().activeFontId
    const used = collectUsedFontIds(project.editing.subtitles, settingsDefault)
    const fontsRes = await listFonts()
    const list: FontInfo[] = fontsRes.ok ? fontsRes.data.fonts : []
    const isMsix = await window.electronAPI?.isMsix()
    const unavailable: FontInfo[] = []
    const locked: FontInfo[] = []
    for (const id of used) {
      const info = list.find((f) => f.id === id)
      if (!info) continue
      const isAvailable = info.status === 'bundled' || info.status === 'installed'
      if (!isAvailable) {
        unavailable.push(info)
        continue
      }
      // Paid fonts on the free NSIS build: even if the font file made it
      // to disk (e.g. downgraded from MSIX), the picker treats non-default
      // fonts as locked, and the resulting burn-in falls back to the
      // default.  Warn so the user knows why the rendered subtitles
      // won't match the saved styling.
      const isDefaultFont = info.id === DEFAULT_FONT_ID
      if (!isMsix && !isDefaultFont) {
        locked.push(info)
      }
    }
    if (unavailable.length > 0 || locked.length > 0) {
      setState({ kind: 'font-warning', project, currentVideo, unavailable, locked })
      return
    }
    finalize(project, currentVideo)
  }

  function finalize(project: ProjectFile, currentVideo: VideoInfo) {
    // Wipe any residual state from a previous project before hydrating
    // the new one.  History is one path where a stale op could otherwise
    // rewrite the newly-loaded entries under Undo.
    const p = useProjectStore.getState()
    p.reset()
    useHistoryStore.getState().clear()
    usePreviewMixStore.getState().clear()
    // Hydrate.  `videoInfoFromProject` uses the actual (possibly
    // re-selected) path so `video.path` never disagrees with the file
    // on disk.
    const video = videoInfoFromProject(project.source, currentVideo.path)
    // Prefer the CURRENT probed dimensions/duration/fps/codec over the
    // saved snapshot in case the container was remuxed but content is
    // otherwise identical (identity check already tolerated up to
    // IDENTITY_DURATION_TOLERANCE_SEC).  This keeps burn-in aligned to
    // the live file's playhead.
    p.setVideo({
      ...video,
      durationSec: currentVideo.durationSec,
      widthPx: currentVideo.widthPx,
      heightPx: currentVideo.heightPx,
      fps: currentVideo.fps,
      videoCodec: currentVideo.videoCodec,
      container: currentVideo.container,
      audioTracks: currentVideo.audioTracks,
      fileSizeBytes: currentVideo.fileSizeBytes,
    })
    p.setSelectedTrackIndex(project.source.transcribedTrackIndex)
    p.setEntries(project.editing.subtitles)
    p.setCuts(project.editing.cuts)
    p.setDefaults(project.editing.defaults)
    p.setVideoLoadingState('loaded')
    // Reset step2 UI-side ephemerals so the freshly-loaded project
    // doesn't inherit the previous session's selection / playhead.
    const ui = useUiStore.getState()
    ui.setSelectedEntryId(null)
    ui.setVideoCurrentTimeSec(0)
    ui.setVideoSeekRequest(null)

    setState({ kind: 'idle' })
    toast.success(t('project.open.toastSuccess'))
    // REQ-0195 §1 — route by data-shape rather than by a saved "screen"
    // flag.  Non-empty subtitles means transcription has happened → the
    // user goes to step2 to keep editing.  Empty subtitles (project
    // saved from step1 pre-transcription, or every row deleted) means
    // there's nothing to edit → land on step1 with the video loaded so
    // the user can start / redo the transcription.  Data-shape wins
    // over any saved screen flag because it can't disagree with the
    // stores we just hydrated.
    const hasSubtitles = project.editing.subtitles.some((e) => !e.isDeleted)
    navigate(hasSubtitles ? '/step2' : '/step1')
  }

  // ─── Dialog handlers ──────────────────────────────────────────────

  function handleDiscardConfirm(ok: boolean) {
    if (!ok) {
      setState({ kind: 'idle' })
      return
    }
    void pickAndContinue()
  }

  async function handleReSelectSource(project: ProjectFile) {
    setState({ kind: 'loading', message: '' })
    const filePath = await openVideoDialog()
    if (!filePath) {
      setState({ kind: 'idle' })
      return
    }
    await validateIdentity(project, filePath)
  }

  function closeState() {
    setState({ kind: 'idle' })
  }

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <>
      {/* Discard-confirm */}
      <Dialog
        open={state.kind === 'discard-confirm'}
        onOpenChange={(open) => { if (!open) handleDiscardConfirm(false) }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('project.open.discardConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('project.open.discardConfirmDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => handleDiscardConfirm(false)}>
              {t('project.open.discardConfirmCancel')}
            </Button>
            <Button variant="primary" onClick={() => handleDiscardConfirm(true)}>
              {t('project.open.discardConfirmOk')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Source-missing */}
      <Dialog
        open={state.kind === 'source-missing'}
        onOpenChange={(open) => { if (!open) closeState() }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('project.open.sourceMissingTitle')}</DialogTitle>
            <DialogDescription>{t('project.open.sourceMissingDesc')}</DialogDescription>
          </DialogHeader>
          {state.kind === 'source-missing' && (
            <div className="space-y-1.5 text-body-sm text-fg-secondary">
              <div>
                <span className="text-fg-muted">{t('project.open.identityFileNameLabel')}: </span>
                <span className="text-fg-primary">{state.project.source.fileName}</span>
              </div>
              <div>
                <span className="text-fg-muted">{t('project.open.identityPathLabel')}: </span>
                <span className="font-mono text-body-sm text-fg-primary break-all">{state.project.source.filePath}</span>
              </div>
              <div>
                <span className="text-fg-muted">{t('project.open.identityResolutionLabel')}: </span>
                <span className="text-fg-primary">{state.project.source.resolution.width}×{state.project.source.resolution.height}</span>
              </div>
              <div>
                <span className="text-fg-muted">{t('project.open.identityDurationLabel')}: </span>
                <span className="text-fg-primary tabular-nums">{formatDurationSec(state.project.source.durationSec)}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeState}>
              {t('project.open.sourceMissingCancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (state.kind === 'source-missing') void handleReSelectSource(state.project)
              }}
            >
              {t('project.open.sourceMissingReselect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Identity-mismatch */}
      <Dialog
        open={state.kind === 'identity-mismatch'}
        onOpenChange={(open) => { if (!open) closeState() }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('project.open.identityMismatchTitle')}</DialogTitle>
            <DialogDescription>{t('project.open.identityMismatchDesc')}</DialogDescription>
          </DialogHeader>
          {state.kind === 'identity-mismatch' && (
            <div className="text-body-sm space-y-2 mt-2">
              <div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-1 items-baseline">
                <div />
                <div className="text-fg-muted">{t('project.open.identitySavedLabel')}</div>
                <div className="text-fg-muted">{t('project.open.identityCurrentLabel')}</div>
                <div className="text-fg-muted">{t('project.open.identityFileNameLabel')}</div>
                <div className="text-fg-primary truncate">{state.project.source.fileName}</div>
                <div className="text-fg-primary truncate">{basename(state.currentVideo.path)}</div>
                <div className="text-fg-muted">{t('project.open.identityResolutionLabel')}</div>
                <div className="text-fg-primary tabular-nums">{state.project.source.resolution.width}×{state.project.source.resolution.height}</div>
                <div className="text-fg-primary tabular-nums">{state.currentVideo.widthPx}×{state.currentVideo.heightPx}</div>
                <div className="text-fg-muted">{t('project.open.identityDurationLabel')}</div>
                <div className="text-fg-primary tabular-nums">{formatDurationSec(state.project.source.durationSec)}</div>
                <div className="text-fg-primary tabular-nums">{formatDurationSec(state.currentVideo.durationSec)}</div>
                <div className="text-fg-muted">{t('project.open.identityPathLabel')}</div>
                <div className="text-fg-primary font-mono text-body-sm break-all col-span-2">{state.project.source.filePath}</div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="primary" onClick={closeState}>
              {t('project.open.identityClose')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Font-warning */}
      <Dialog
        open={state.kind === 'font-warning'}
        onOpenChange={(open) => { if (!open) closeState() }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('project.open.fontWarningTitle')}</DialogTitle>
          </DialogHeader>
          {state.kind === 'font-warning' && (
            <div className="space-y-3 text-body-sm">
              {state.unavailable.length > 0 && (
                <div className="space-y-1">
                  <p className="text-fg-secondary">{t('project.open.fontWarningDesc')}</p>
                  <ul className="list-disc pl-5 text-fg-primary">
                    {state.unavailable.map((f) => (
                      <li key={f.id}>{f.displayName}</li>
                    ))}
                  </ul>
                </div>
              )}
              {state.locked.length > 0 && (
                <div className="space-y-1">
                  <p className="text-fg-secondary">{t('project.open.fontWarningLockedDesc')}</p>
                  <ul className="list-disc pl-5 text-fg-primary">
                    {state.locked.map((f) => (
                      <li key={f.id}>{f.displayName}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeState}>
              {t('project.open.fontWarningCancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (state.kind === 'font-warning') {
                  finalize(state.project, state.currentVideo)
                }
              }}
            >
              {t('project.open.fontWarningOpen')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Loading spinner (parse / probe / font list).  Small enough to
          share a single dialog for every intermediate step. */}
      <Dialog open={state.kind === 'loading'}>
        <DialogContent className="max-w-xs">
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="h-6 w-6 animate-spin text-fg-tertiary" />
            {state.kind === 'loading' && state.message && (
              <p className="text-body-sm text-fg-secondary">{state.message}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

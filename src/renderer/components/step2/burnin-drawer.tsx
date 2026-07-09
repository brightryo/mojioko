import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Play,
  Music,
  FileVideo,
  Heart,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  MessageSquare,
  Shield,
  X,
  Film,
  Copy,
  Check
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { formatElapsed } from '@/lib/format-elapsed'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { startBurnin } from '@/services/burnin'
import { detectEncoders, resolveEffectiveEncoder, ENCODER_LABELS } from '@/services/encoder'
import type { H264Encoder } from '@/services/encoder'
import { shellOpenPath, shellShowInFolder, shellOpenExternal, saveFileDialog, fileExists } from '@/services/dialog'
import { listFonts } from '@/services/font'
import { getFontMeta, type FontId } from '../../../shared/fonts'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { formatDuration, formatEstimatedTime } from '@/lib/time'
import { estimateOutputSizeMB, estimateRenderTimeSec } from '@/lib/format'
import { computeEntryWarnings, isBurninTarget, type EntryWarnings } from '@/lib/entry-warnings'
import type { BurninHandle } from '@/services/burnin'
import type { OutputContainer } from '../../../shared/types'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { DonationContent } from '@/components/donation-dialog/donation-content'
import { GITHUB_PAGES_LOCALIZED } from '../../../shared/app-info'

interface BurninDrawerProps {
  open: boolean
  onOpenChange: (next: boolean) => void
}

type RenderState = 'idle' | 'rendering' | 'error'

/**
 * REQ-20260615-023: STEP3 retired in favour of a right-sliding drawer
 * surfaced from STEP2.  This component owns the burn-in form, the
 * progress / cancel / error states, the overwrite confirmation, and
 * the post-success completion dialog.  Settings (output format, audio
 * mode) read directly from the existing settings store and the
 * burn-in pipeline is unchanged.
 */
export function BurninDrawer({ open, onOpenChange }: BurninDrawerProps) {
  const { t, i18n } = useTranslation(['step3', 'step2', 'common'])

  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)
  const cuts = useProjectStore((s) => s.cuts)
  const encoderSetting = useSettingsStore((s) => s.encoder)
  const audioMode = useSettingsStore((s) => s.audioMode)
  const setAudioMode = useSettingsStore((s) => s.setAudioMode)
  // REQ-20260615-050 — `fadeDurationSec` is now per-entry and rides inside
  // every SubtitleEntry, so the drawer no longer reads the global slice.
  const outputContainer = useSettingsStore((s) => s.outputContainer)
  const setOutputContainer = useSettingsStore((s) => s.setOutputContainer)
  // REQ-0121 — user-preferred fixed output folder for the burn-in save
  // dialog.  `null` = fall through to the OS Videos folder.
  const defaultOutputDir = useSettingsStore((s) => s.defaultOutputDir)
  const activeFontId = useSettingsStore((s) => s.activeFontId)

  const [renderState, setRenderState] = useState<RenderState>('idle')
  const [progress, setProgress] = useState(0)
  // REQ-0148 Part A — renderer-side elapsed timer for the burn-in run,
  // mirroring the REQ-0143 pattern already used by the transcription
  // drawer.  ffmpeg does not emit tick events, so the drawer keeps its
  // own start-time stamp and ticks a `nowTick` state every 500 ms.  The
  // `mm:ss` string replaces the old `Loader2` spinner in the top slot;
  // deleting the spinner + keeping the elapsed timer visible mirrors the
  // transcription drawer so the two drawers read as siblings.
  const [renderStartMs, setRenderStartMs] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState<number>(0)
  const [completedPath, setCompletedPath] = useState<string>('')
  const [completedSizeMB, setCompletedSizeMB] = useState<number>(0)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [overwriteCandidate, setOverwriteCandidate] = useState<string | null>(null)
  const [effectiveEncoder, setEffectiveEncoder] = useState<H264Encoder | null>(null)
  const [completionOpen, setCompletionOpen] = useState(false)
  // REQ-20260615-053 B — tracks which credit row was most recently
  // copied so the icon can flip to a check for ~1.5 s.  Cleared either
  // by the timer or by re-opening the dialog.
  const [copiedCreditKey, setCopiedCreditKey] = useState<'ja' | 'en' | null>(null)
  const burninHandleRef = useRef<BurninHandle | null>(null)

  // REQ-20260615-053 B — copy a credit string to the clipboard and
  // surface short feedback (icon flip + toast).  `key` identifies
  // which row was clicked so the icon swap is row-local.  Async
  // because the Clipboard API resolves a Promise.
  async function copyCredit(key: 'ja' | 'en', text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedCreditKey(key)
      toast.success(t('completion.creditCopied'))
      // Restore the copy icon after a beat so a repeat copy still
      // animates.
      window.setTimeout(() => {
        setCopiedCreditKey((current) => (current === key ? null : current))
      }, 1500)
    } catch {
      toast.error(t('completion.creditCopyFailed'))
    }
  }

  useEffect(() => {
    if (!open) return
    detectEncoders().then((info) => {
      const { encoder, overridden } = resolveEffectiveEncoder(encoderSetting, info)
      setEffectiveEncoder(encoder)
      if (overridden) {
        toast.warning(t('toast.encoderFallback', { requested: encoderSetting, actual: ENCODER_LABELS[encoder] }))
      }
    }).catch(() => {
      setEffectiveEncoder(null)
    })
  }, [encoderSetting, open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset transient drawer state whenever the drawer is closed so a
  // future open starts cleanly from the 'idle' settings view.
  //
  // REQ-20260615-024 B.5 fix: `completedPath` / `completedSizeMB` are
  // INTENTIONALLY left out of this reset.  On success, the drawer hands
  // off to the completion Dialog by closing itself (`onOpenChange(false)`)
  // — which fires this effect — and then opening the Dialog in the same
  // tick.  If we cleared the completed-* state here, the Dialog would
  // mount with empty values: Play would call `shellOpenPath('')`
  // (opens an arbitrary folder on Windows), Show in Folder would no-op,
  // and the size readout would render "0 MB".  Keeping them around is
  // harmless — they are only consulted when `completionOpen` is true,
  // and the next successful run overwrites them anyway.
  useEffect(() => {
    if (open) return
    setRenderState('idle')
    setProgress(0)
    setRenderStartMs(null)
    setErrorMessage('')
    setOverwriteCandidate(null)
    burninHandleRef.current = null
  }, [open])

  // REQ-0148 Part A — 500 ms tick that bumps `nowTick` while a burn-in
  // is in flight so the elapsed `mm:ss` in the top slot updates roughly
  // twice a second.  The interval is torn down as soon as `renderStartMs`
  // clears (idle / cancel / complete / error), matching REQ-0143's
  // approach in the transcription drawer.
  useEffect(() => {
    if (renderStartMs === null) return
    const id = window.setInterval(() => setNowTick(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [renderStartMs])
  const elapsedSec = renderStartMs !== null
    ? Math.max(0, Math.floor((Math.max(nowTick, Date.now()) - renderStartMs) / 1000))
    : 0

  const videoDurationSec = video?.durationSec ?? Infinity
  const warningsMap = (() => {
    const map = new Map<string, EntryWarnings>()
    let prevEnd: number | null = null
    for (const e of entries) {
      if (e.isDeleted) continue
      map.set(e.id, computeEntryWarnings(e, prevEnd, videoDurationSec, false))
      prevEnd = e.endSec
    }
    return map
  })()
  const activeEntries = entries.filter((e) => {
    const w = warningsMap.get(e.id)
    return w !== undefined && isBurninTarget(e, w)
  })

  const durationSec = video?.durationSec ?? 0
  const estTimeSec = estimateRenderTimeSec(durationSec, activeEntries.length)
  const estSizeMB = estimateOutputSizeMB(durationSec)

  const inputExtUpper = video
    ? (video.path.split(/[\\/]/).pop()?.split('.').pop()?.toUpperCase() ?? video.container.toUpperCase())
    : ''
  const displayContainer = outputContainer === 'mp4' ? 'MP4' : inputExtUpper

  async function findMissingFonts(): Promise<FontId[] | null> {
    const referenced = new Set<FontId>()
    referenced.add(activeFontId)
    for (const e of activeEntries) {
      if (e.fontId) referenced.add(e.fontId)
    }
    const r = await listFonts()
    if (!r.ok) return null
    const installed = new Set<FontId>()
    for (const f of r.data.fonts) {
      if (f.status === 'bundled' || f.status === 'installed') installed.add(f.id)
    }
    const missing = Array.from(referenced).filter((id) => !installed.has(id))
    return missing.length === 0 ? null : missing
  }

  async function handleStartRender() {
    if (!video) return
    const missing = await findMissingFonts()
    if (missing && missing.length > 0) {
      const names = missing.map((id) => getFontMeta(id).displayName).join(', ')
      toast.error(t('toast.missingFonts', { names }))
      return
    }
    const stem = video.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'output'
    const inputExt = video.path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? 'mp4'
    const outExt = outputContainer === 'mp4' ? 'mp4' : inputExt
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const defaultName = `${stem}_subtitled_${ts}.${outExt}`
    const targetPath = await saveFileDialog(defaultName, defaultOutputDir ?? undefined)
    if (!targetPath) return

    const exists = await fileExists(targetPath).catch(() => false)
    if (exists) {
      setOverwriteCandidate(targetPath)
      return
    }
    void startBurninWithPath(targetPath)
  }

  async function startBurninWithPath(targetPath: string) {
    if (!video) return
    setRenderState('rendering')
    setProgress(0)
    setRenderStartMs(Date.now())
    setErrorMessage('')

    const burninOpts = {
      inputPath: video.path,
      outputPath: targetPath,
      entries: activeEntries,
      video,
      burnin: {
        horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
        verticalPosition: BURNIN_DEFAULTS.verticalPosition,
        verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx
      },
      encoderSetting,
      audioMode,
      subtitleBackground: {
        enabled: BURNIN_DEFAULTS.subtitleBackground.enabled,
        color: BURNIN_DEFAULTS.subtitleBackground.color,
        opacityPercent: BURNIN_DEFAULTS.subtitleBackground.opacityPercent
      },
      outputContainer,
      fontId: activeFontId,
      cuts
    }

    const run = await startBurnin(burninOpts, (evt) => {
      if (evt.event === 'progress') {
        setProgress(Math.round(evt.percent))
      } else if (evt.event === 'completed') {
        setCompletedPath(evt.outputPath)
        setCompletedSizeMB(evt.sizeMB)
        setProgress(100)
        setRenderStartMs(null)
        // Hand off to the completion dialog: dismiss the drawer (it slides
        // out to the right per shadcn Sheet animation) and pop the success
        // dialog at centre.
        onOpenChange(false)
        setCompletionOpen(true)
        toast.success(t('success.title'))
      } else if (evt.event === 'failed') {
        const errMsg = evt.error
        setErrorMessage(errMsg)
        setRenderState('error')
        setRenderStartMs(null)
        // 'Cancelled' is the sentinel emitted by ffmpeg-burnin when the
        // user pressed Cancel — treat that as returning to 'idle' rather
        // than the error state (the drawer's own state already reflects
        // the cancellation).
        if (errMsg === 'Cancelled') {
          setRenderState('idle')
          setProgress(0)
        } else {
          toast.error(t('error.renderFailed', { reason: errMsg }))
        }
      }
    }).catch((err) => {
      const errMsg = String(err)
      if (errMsg.includes('Cancelled')) {
        setRenderState('idle')
        setProgress(0)
        setRenderStartMs(null)
        return null
      }
      setErrorMessage(errMsg)
      setRenderState('error')
      setRenderStartMs(null)
      toast.error(t('error.renderFailed', { reason: errMsg }))
      return null
    })

    if (run) burninHandleRef.current = run
  }

  function handleCancel() {
    burninHandleRef.current?.cancel()
    burninHandleRef.current = null
    setRenderState('idle')
    setProgress(0)
    setRenderStartMs(null)
  }

  function handleSheetOpenChange(next: boolean) {
    // While the burn-in is running, the only legitimate way to stop the
    // drawer is the in-drawer Cancel button — block backdrop click / X.
    if (!next && renderState === 'rendering') return
    onOpenChange(next)
  }

  // REQ-20260615-025: completion-dialog action buttons (Play / Open
  // folder / Send feedback) and the embedded donation cards run their
  // action WITHOUT closing the dialog so the user can chain
  // Play → Feedback → Donate in one session.  The only ways to dismiss
  // the dialog are the title-bar X (Radix DialogClose), the Close
  // button at the bottom, and clicking outside the dialog.

  return (
    <>
      <Sheet open={open} onOpenChange={handleSheetOpenChange}>
        <SheetContent
          side="right"
          // Roomier than the default max-w-xl so the form (Summary +
          // Output format + Audio mode) breathes.
          className="max-w-[640px]"
          hideClose={renderState === 'rendering'}
        >
          {/* REQ-20260615-024 A.3: description sits to the RIGHT of the
              title instead of stacking below it.  The header still uses
              SheetHeader for the X close-button offset; we just override
              the inner layout to a single flex row. */}
          <SheetHeader className="flex-row items-baseline gap-3 pr-10">
            <SheetTitle>{t('title')}</SheetTitle>
            <SheetDescription className="flex-1">{t('subtitle')}</SheetDescription>
          </SheetHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-4">
            {renderState === 'idle' && (
              <>
                {/* Summary panel — REQ-20260615-024 A.1/A.2: section header
                    'Summary' dropped, card padding tightened (p-3), and
                    SummaryRow rows shrunk to py-1 / min-h-0 so the seven
                    facts read as a compact table rather than a stretched
                    column. */}
                <div className="rounded-xl border border-line bg-surface-1 px-3 py-2">
                  <div className="flex flex-col divide-y divide-line/50">
                    <SummaryRow label={t('summary.resolution')} value={video ? `${video.widthPx}×${video.heightPx}` : '—'} />
                    <SummaryRow label={t('summary.duration')} value={video ? formatDuration(durationSec) : '—'} />
                    <SummaryRow label={t('summary.format')} value={video ? `${displayContainer} / h264` : '—'} />
                    <SummaryRow label={t('summary.subtitles')} value={String(activeEntries.length)} />
                    <SummaryRow label={t('summary.estimatedTime')} value={video ? formatEstimatedTime(estTimeSec) : '—'} />
                    <SummaryRow label={t('summary.estimatedSize')} value={video ? `${estSizeMB} MB` : '—'} />
                    <SummaryRow label={t('summary.encoder')} value={effectiveEncoder ? `${ENCODER_LABELS[effectiveEncoder]} (${effectiveEncoder})` : '…'} />
                  </div>
                </div>

                {/* Output format */}
                <OutputFormatCard
                  videoPath={video?.path ?? null}
                  outputContainer={outputContainer}
                  setOutputContainer={setOutputContainer}
                />

                {/* Audio mode */}
                <div className="rounded-xl border border-line bg-surface-1 p-4 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Music className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
                    <Label>{t('audio.label')}</Label>
                  </div>
                  <div className="flex flex-col gap-2">
                    {(['simple', 'preserve'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setAudioMode(mode)}
                        className={cn(
                          'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors duration-150',
                          audioMode === mode
                            ? 'border-primary/50 bg-primary/5'
                            : 'border-line hover:bg-surface-2/40'
                        )}
                      >
                        <span className={cn('text-body font-medium', audioMode === mode ? 'text-primary' : 'text-fg-primary')}>
                          {t(`audio.${mode}`)}
                        </span>
                        <span className="text-body-sm text-fg-muted">{t(`audio.${mode}Desc`)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <p className="flex items-center gap-1.5 text-body-sm text-fg-tertiary">
                  <Shield className="h-3.5 w-3.5" />
                  {t('footer.privacyNote')}
                </p>
              </>
            )}

            {renderState === 'rendering' && (
              <div className="flex items-center justify-center py-12">
                <div className="rounded-xl border border-line bg-surface-1 px-6 py-8 w-full max-w-md space-y-5">
                  {/* REQ-0148 Part A — matches the REQ-0143 layout in the
                      transcription drawer.  The old spinning `Loader2`
                      icon was purely decorative once the determinate
                      progress bar showed real progress, and made the two
                      drawers look visually different for no reason.
                      Elapsed `mm:ss` at title size sits in the vacated
                      top slot; the right-side `%` chip stays always
                      visible because ffmpeg emits accurate percent from
                      the first frame — there is no "preparing" region
                      here (unlike the transcription drawer's Whisper
                      pre-load phase). */}
                  <div className="flex flex-col items-center gap-1.5">
                    <span className="font-mono tabular-nums text-title text-fg-primary">
                      {formatElapsed(elapsedSec)}
                    </span>
                  </div>
                  <div className="space-y-3">
                    <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-200 rounded-full"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-body-sm text-fg-tertiary">
                      <span>{t('progress.label')}</span>
                      <span className="font-mono tabular-nums">{progress}%</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {renderState === 'error' && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-6 py-6 space-y-3">
                <div className="flex items-center gap-2 text-destructive">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <p className="text-headline font-semibold">{t('error.title')}</p>
                </div>
                {errorMessage && (
                  <p className="text-body-sm text-fg-tertiary break-all font-mono selectable">
                    {errorMessage.slice(-400)}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Drawer footer — primary "Execute video export" button +
              Cancel during a run, or Retry / Close in the error state.
              REQ-20260615-040 A introduced the Close button; REQ-20260615-041 A
              moves it to the LEFT (`justify-between`) and switches the
              variant from `secondary` (white) to `ghost` (grey) so it
              shares the neutral treatment of STEP2's Back / Text-export
              buttons.  Rendering state remains right-aligned with only
              the danger Cancel button (the "no closing while rendering"
              rule is unchanged and the X is hidden via `hideClose`). */}
          <div
            className={cn(
              'mt-auto flex items-center gap-2 px-4 py-3 border-t border-line',
              renderState === 'rendering' ? 'justify-end' : 'justify-between'
            )}
          >
            {renderState === 'rendering' ? (
              <Button variant="danger" size="md" onClick={handleCancel}>
                {t('action.cancel')}
              </Button>
            ) : renderState === 'error' ? (
              <>
                <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
                  {t('action.close')}
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleStartRender}
                  disabled={activeEntries.length === 0}
                >
                  <Play className="h-4 w-4 mr-1.5" />
                  {t('action.startRender')}
                </Button>
              </>
            ) : (
              // REQ-20260615-024 A.4: execute button mirrors the STEP2
              // footer's video-export affordance — Film icon + same label +
              // primary green — so the user reads it as "the same action,
              // now confirmed".
              <>
                <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
                  {t('action.close')}
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleStartRender}
                  disabled={activeEntries.length === 0}
                >
                  <Film className="h-4 w-4 mr-1.5" />
                  {t('step2:action.exportVideoLabel')}
                </Button>
              </>
            )}
          </div>

          {/* In-drawer overwrite confirmation.
              REQ-0138 §2.4 — `onEnterConfirm` intentionally NOT set.
              The confirm button here starts the burn-in encode with an
              overwrite, which is exactly the "heavy operation" §2.4
              wants to guard against firing on a stray Enter.  User must
              click the button. */}
          <Dialog
            open={overwriteCandidate !== null}
            onOpenChange={(o) => { if (!o) setOverwriteCandidate(null) }}
          >
            <DialogContent className="max-w-[480px]">
              <DialogHeader>
                <DialogTitle>{t('overwriteDialog.title')}</DialogTitle>
                <DialogDescription className="whitespace-pre-line break-all">
                  {t('overwriteDialog.body', { path: overwriteCandidate ?? '' })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" size="md" onClick={() => setOverwriteCandidate(null)}>
                  {t('overwriteDialog.cancel')}
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  onClick={() => {
                    const path = overwriteCandidate
                    setOverwriteCandidate(null)
                    if (path) void startBurninWithPath(path)
                  }}
                >
                  {t('overwriteDialog.confirm')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>

      {/* Post-success completion dialog. */}
      <Dialog open={completionOpen} onOpenChange={setCompletionOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary">
              <CheckCircle2 className="h-5 w-5" />
              {t('success.title')}
            </DialogTitle>
            <DialogDescription className="break-all font-mono">
              {completedPath}
            </DialogDescription>
            <DialogDescription>
              {t('success.fileSize', { size: String(completedSizeMB) })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-1">
            {/* REQ-20260615-054 A — the three workflow buttons now sit
                in an equal-width `grid-cols-3` row.  Each `<Button>`
                gets `w-full` so the grid cell's stretch propagates to
                the underlying inline-flex root, giving identical widths
                regardless of label length (Japanese "動画再生" vs
                English "Show in Folder" no longer drift apart).  REQ-053
                already centred the buttons; the grid keeps that
                horizontal centring AND adds the equal-width guarantee.
                "フィードバックを送る" was shortened to "フィードバック"
                / "Feedback" so the column doesn't dominate. */}
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={() => { void shellOpenPath(completedPath) }}
                className="w-full"
              >
                <Play className="h-4 w-4 mr-1.5" />
                {t('completion.playVideo')}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => { void shellShowInFolder(completedPath) }}
                className="w-full"
              >
                <FolderOpen className="h-4 w-4 mr-1.5" />
                {t('completion.showInFolder')}
              </Button>
              {/* REQ-20260615-024 B.3: same secondary white treatment as
                  Show in Folder so the three workflow buttons share a
                  visual rhythm. */}
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  const lang = i18n.language === 'ja' ? 'ja' : 'en'
                  void shellOpenExternal(GITHUB_PAGES_LOCALIZED[lang].feedback)
                }}
                className="w-full"
              >
                <MessageSquare className="h-4 w-4 mr-1.5" />
                {t('completion.sendFeedback')}
              </Button>
            </div>

            {/* Embedded donation section. */}
            <div className="rounded-xl border border-line bg-surface-1 p-3 space-y-2">
              <div className="flex items-center gap-1.5 px-1">
                <Heart className="h-3.5 w-3.5 text-[hsl(var(--accent-soft))]" />
                <span className="text-body-sm font-medium text-fg-secondary">
                  {t('completion.supportTitle')}
                </span>
              </div>
              <DonationContent />
            </div>

            {/* REQ-20260615-053 B / REQ-20260615-054 B — optional-credit
                copy section.  Lives between the donation card and the
                Close footer.  Order: English on top, Japanese on the
                bottom — most uploads on this app's target platforms
                (YouTube / X) reach an international audience first, so
                the English credit gets the primary slot.  Each row
                shows the copy button (Copy → Check icon flip on
                success) and the credit text in muted grey so the user
                can read what they're about to copy.  Strings live in
                step3 locale (`completion.credit*`) so the labels and
                credit bodies follow the active UI language. */}
            <div className="rounded-xl border border-line bg-surface-1 p-3 space-y-2.5">
              <p className="text-body-sm font-medium text-fg-secondary px-1">
                {t('completion.creditHeading')}
              </p>
              <CreditCopyRow
                buttonLabel={t('completion.creditCopyEn')}
                creditText={t('completion.creditTextEn')}
                copied={copiedCreditKey === 'en'}
                onCopy={() => copyCredit('en', t('completion.creditTextEn'))}
              />
              <CreditCopyRow
                buttonLabel={t('completion.creditCopyJa')}
                creditText={t('completion.creditTextJa')}
                copied={copiedCreditKey === 'ja'}
                onCopy={() => copyCredit('ja', t('completion.creditTextJa'))}
              />
            </div>
          </div>

          {/* REQ-20260615-024 B.4: override DialogFooter's default
              `justify-end` so Close sits centred. */}
          <DialogFooter className="justify-center">
            <Button
              variant="ghost"
              size="md"
              onClick={() => setCompletionOpen(false)}
            >
              <X className="h-4 w-4 mr-1.5" />
              {t('completion.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function OutputFormatCard({
  videoPath,
  outputContainer,
  setOutputContainer
}: {
  videoPath: string | null
  outputContainer: OutputContainer
  setOutputContainer: (v: OutputContainer) => void
}) {
  const { t } = useTranslation(['step3'])
  const inputExt = videoPath
    ? (videoPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '')
    : ''

  return (
    <div className="rounded-xl border border-line bg-surface-1 p-4 space-y-2">
      <div className="flex items-center gap-1.5">
        <FileVideo className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
        <Label>
          {inputExt
            ? t('outputFormat.labelWithInput', { ext: inputExt })
            : t('outputFormat.label')}
        </Label>
      </div>
      <div className="flex flex-col gap-2">
        {(['mp4', 'sameAsInput'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setOutputContainer(mode)}
            className={cn(
              'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors duration-150',
              outputContainer === mode
                ? 'border-primary/50 bg-primary/5'
                : 'border-line hover:bg-surface-2/40'
            )}
          >
            <span className={cn(
              'text-body font-medium',
              outputContainer === mode ? 'text-primary' : 'text-fg-primary'
            )}>
              {mode === 'sameAsInput' && inputExt
                ? t('outputFormat.sameAsInputWithExt', { ext: inputExt })
                : t(`outputFormat.${mode}`)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  // REQ-20260615-024 A.1: tightened from py-2 / min-h-[28px] to py-1 so the
  // 7-row summary reads as a compact reference table.
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-callout font-semibold text-fg-tertiary">{label}</span>
      <span className="text-body-sm text-fg-primary font-mono tabular-nums">{value}</span>
    </div>
  )
}

/**
 * REQ-20260615-053 B — single credit-copy block (button + preview).
 *
 * Visually a tight stack: secondary ghost button with the Copy icon
 * on top, then the credit string itself rendered in muted grey so the
 * user can see exactly what will land on the clipboard.  Icon flips
 * to a Check for ~1.5 s after a successful copy (driven by the parent's
 * `copied` prop).  The credit text is selectable; the button just
 * makes the common "copy whole line" gesture one click.
 */
function CreditCopyRow({
  buttonLabel,
  creditText,
  copied,
  onCopy,
}: {
  buttonLabel: string
  creditText: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="space-y-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={onCopy}
        className="px-2"
        aria-label={buttonLabel}
      >
        {copied
          ? <Check className="h-3.5 w-3.5 mr-1.5 text-primary" />
          : <Copy className="h-3.5 w-3.5 mr-1.5" />}
        {buttonLabel}
      </Button>
      <p className="text-body-sm text-fg-muted break-all px-2 select-text">
        {creditText}
      </p>
    </div>
  )
}

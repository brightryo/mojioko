import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Play, Shield, Music, FileVideo, Heart, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { AppShell } from '@/components/app-shell/app-shell'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { startBurnin } from '@/services/burnin'
import { detectEncoders, resolveEffectiveEncoder, ENCODER_LABELS } from '@/services/encoder'
import type { H264Encoder } from '@/services/encoder'
import { shellOpenPath, shellShowInFolder, saveFileDialog, fileExists } from '@/services/dialog'
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
import type { OutputContainer } from '../../shared/types'

interface Step3RouteProps {
  appVersion: string
}

type RenderState = 'idle' | 'rendering' | 'success' | 'error'

export default function Step3Route({ appVersion }: Step3RouteProps) {
  const { t } = useTranslation(['step3', 'common'])
  const navigate = useNavigate()

  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)
  // burnin / subtitleBackground are still consumed at render time to feed
  // startBurnin's burninOpts, but the editing UI moved to Step 2's
  // VideoPreviewPanel.  Only the read-side hooks remain here.
  const burnin = useSettingsStore((s) => s.burnin)
  const encoderSetting = useSettingsStore((s) => s.encoder)
  const audioMode = useSettingsStore((s) => s.audioMode)
  const setAudioMode = useSettingsStore((s) => s.setAudioMode)
  const fadeDurationSec = useSettingsStore((s) => s.fadeDurationSec)
  const subtitleBackground = useSettingsStore((s) => s.subtitleBackground)
  const outputContainer = useSettingsStore((s) => s.outputContainer)
  const setOutputContainer = useSettingsStore((s) => s.setOutputContainer)
  const setDonationDialogOpen = useUiStore((s) => s.setDonationDialogOpen)

  const [renderState, setRenderState] = useState<RenderState>('idle')
  const [progress, setProgress] = useState(0)
  const [completedPath, setCompletedPath] = useState<string>('')
  const [completedSizeMB, setCompletedSizeMB] = useState<number>(0)
  const [errorMessage, setErrorMessage] = useState<string>('')
  /** Path the user picked but that already exists — surfaced via the overwrite dialog. */
  const [overwriteCandidate, setOverwriteCandidate] = useState<string | null>(null)
  const [effectiveEncoder, setEffectiveEncoder] = useState<H264Encoder | null>(null)
  const burninHandleRef = useRef<BurninHandle | null>(null)

  useEffect(() => {
    detectEncoders().then((info) => {
      const { encoder, overridden } = resolveEffectiveEncoder(encoderSetting, info)
      setEffectiveEncoder(encoder)
      if (overridden) {
        toast.warning(t('toast.encoderFallback', { requested: encoderSetting, actual: ENCODER_LABELS[encoder] }))
      }
    }).catch(() => {
      setEffectiveEncoder(null)
    })
  }, [encoderSetting]) // eslint-disable-line react-hooks/exhaustive-deps

  // Burn-in eligibility: filter out rows that ffmpeg / libass cannot
  // physically render — invalid time order, out-of-duration timecodes, or
  // non-positive font size — plus the universal exclusions (deleted, empty
  // text).  Compute warnings inline here because Step 3 doesn't share
  // Step 2's warningsMap state.
  const videoDurationSec = video?.durationSec ?? Infinity
  const warningsMap = (() => {
    const map = new Map<string, EntryWarnings>()
    let prevEnd: number | null = null
    for (const e of entries) {
      if (e.isDeleted) continue
      // Overflow is not checked at burn-in time — it doesn't affect ffmpeg
      // (libass clips wide lines) and `isBurninTarget` ignores it anyway.
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

  // Container shown in the "出力情報 → フォーマット" row.  Follows the actual
  // output extension rather than the input video's ffprobe container:
  //   - 'mp4'         → always "MP4" (we force -f mp4 + faststart)
  //   - 'sameAsInput' → uppercase of the input file's extension, matching
  //                     OutputFormatCard's `(ext)` label and handleStartRender's
  //                     outExt computation so the three places stay in sync.
  // Falls back to video.container.toUpperCase() if the path has no extension.
  const inputExtUpper = video
    ? (video.path.split(/[\\/]/).pop()?.split('.').pop()?.toUpperCase() ?? video.container.toUpperCase())
    : ''
  const displayContainer = outputContainer === 'mp4' ? 'MP4' : inputExtUpper

  async function handleStartRender() {
    if (!video) return

    const stem = video.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'output'
    const inputExt = video.path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? 'mp4'
    // Output extension follows the user's container choice.  For 'mp4' we
    // force `.mp4` so the OS / SNS upload pipeline picks the right MIME and
    // the file plays in MP4-only players; for 'sameAsInput' we keep the
    // original extension.
    const outExt = outputContainer === 'mp4' ? 'mp4' : inputExt
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const defaultName = `${stem}_subtitled_${ts}.${outExt}`

    const targetPath = await saveFileDialog(defaultName)
    if (!targetPath) return

    // Explicit in-app overwrite confirmation in addition to whatever the OS
    // save dialog already showed.  Keeps behaviour deterministic across
    // platforms / Electron versions.  Probe failures default to "doesn't
    // exist" — the OS already gave the user a chance and we should not block.
    const exists = await fileExists(targetPath).catch(() => false)
    if (exists) {
      setOverwriteCandidate(targetPath)
      return
    }

    void startBurninWithPath(targetPath)
  }

  /**
   * Continuation of {@link handleStartRender} once the user has either skipped
   * the overwrite prompt (target didn't exist) or confirmed overwrite.
   */
  async function startBurninWithPath(targetPath: string) {
    if (!video) return

    setRenderState('rendering')
    setProgress(0)

    const burninOpts = {
      inputPath: video.path,
      outputPath: targetPath,
      entries: activeEntries,
      video,
      burnin,
      encoderSetting,
      audioMode,
      fadeDurationSec,
      subtitleBackground,
      outputContainer
    }

    const run = await startBurnin(burninOpts, (evt) => {
      if (evt.event === 'progress') {
        setProgress(Math.round(evt.percent))
      } else if (evt.event === 'completed') {
        setCompletedPath(evt.outputPath)
        setCompletedSizeMB(evt.sizeMB)
        setRenderState('success')
        setProgress(100)
        toast.success(t('success.title'))
      } else if (evt.event === 'failed') {
        const errMsg = evt.error
        setErrorMessage(errMsg)
        setRenderState('error')
        toast.error(t('error.renderFailed', { reason: errMsg }))
      }
    }).catch((err) => {
      const errMsg = String(err)
      setErrorMessage(errMsg)
      setRenderState('error')
      toast.error(t('error.renderFailed', { reason: errMsg }))
      return null
    })

    if (run) {
      burninHandleRef.current = run
    }
  }

  function handleCancel() {
    burninHandleRef.current?.cancel()
    burninHandleRef.current = null
    setRenderState('idle')
    setProgress(0)
  }

  function handleRenderAgain() {
    setRenderState('idle')
    setProgress(0)
    setCompletedPath('')
    setCompletedSizeMB(0)
    setErrorMessage('')
  }

  const footerLeft = (
    <Button variant="ghost" size="md" onClick={() => navigate('/step2')}>
      {t('common:nav.back')}
    </Button>
  )

  const footerCenter = (
    <span className="flex items-center gap-1.5 text-[12px] text-zinc-500">
      <Shield className="h-3.5 w-3.5" />
      {t('footer.privacyNote')}
    </span>
  )

  const footerRight = renderState === 'rendering' ? (
    <Button variant="danger" size="md" onClick={handleCancel}>
      {t('action.cancel')}
    </Button>
  ) : renderState === 'success' ? (
    // Render-success cluster.  Order is intentional:
    //   workflow actions → separator → meta (support) action.
    // The support button sits LAST (rightmost) so the user encounters it
    // after their work is done — never as the first thing in the visual
    // scan, which would read as a paywall / push.  The 1px column uses
    // --separator (CSS var) so a future light theme can dial the contrast
    // independently of the main --border.
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="md" onClick={handleRenderAgain}>
        {t('action.renderAgain')}
      </Button>
      <Button variant="secondary" size="md" onClick={() => shellOpenPath(completedPath)}>
        {t('action.openFile')}
      </Button>
      <Button variant="secondary" size="md" onClick={() => shellShowInFolder(completedPath)}>
        {t('action.showInFolder')}
      </Button>
      <div
        className="h-5 w-px mx-1 flex-shrink-0"
        style={{ backgroundColor: 'hsl(var(--separator) / var(--separator-alpha))' }}
        aria-hidden="true"
      />
      <Button
        variant="ghost"
        size="md"
        onClick={() => setDonationDialogOpen(true)}
        // Subtle outline accent — neither a solid fill (would read as a
        // primary action and pressure the user) nor unmarked ghost (would
        // disappear next to the other buttons).  Every colour reads from
        // a CSS var so a future light theme can re-tune the contrast
        // without touching component code:
        //   - default border : --separator @ 0.70 alpha (quiet zinc-700)
        //   - hover border   : --separator-strong (lifts to zinc-600)
        //   - hover bg       : --border @ 0.60 (matches surrounding card)
        // The Heart icon picks up --accent-soft as its only colour cue
        // (outline-only Heart, never filled — a filled heart reads as
        // "already liked" which is the wrong affordance for the action).
        className="border border-[hsl(var(--separator)/0.7)] hover:border-[hsl(var(--separator-strong))] hover:bg-[hsl(var(--border)/0.6)]"
      >
        <Heart className="h-3.5 w-3.5 mr-1.5 text-[hsl(var(--accent-soft))]" />
        {t('action.donate')}
      </Button>
    </div>
  ) : (
    <Button variant="primary" size="md" onClick={handleStartRender} disabled={activeEntries.length === 0}>
      <Play className="h-4 w-4 mr-1.5" />
      {t('action.startRender')}
    </Button>
  )

  return (
    <AppShell
      currentStep={3}
      appVersion={appVersion}
      footerLeft={footerLeft}
      footerCenter={footerCenter}
      footerRight={footerRight}
    >
      {/* ──────────────────────────────────────────────────────────────────
          NOTE: success-state footer (Render again / Open file / Show in
          folder / --separator / Support) lives in the AppShell footerRight
          slot above.  Its layout, button order, --separator divider and
          Donate-button contract are intentionally OUTSIDE the redesigned
          content area below and MUST NOT be touched.  See commit fedffbf
          for the full contract.
          ────────────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {/* Page header — only shown while configuring so the rendering /
            result states have full visual focus. */}
        {renderState === 'idle' && (
          <div>
            <h1 className="text-[18px] font-semibold text-foreground">{t('title')}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">{t('subtitle')}</p>
          </div>
        )}

        {/* IDLE — 2-column settings layout.
            Left: Summary (read-only, confirmation). Right: settings stack.
            Default CSS-grid `align-items: stretch` lets the left card
            grow to match the (taller) right column's height, and the
            Summary card forwards that height through to its row list
            (flex-1 on each row) so the rows distribute evenly instead
            of stacking at the top with empty space below.
            No `lg:` breakpoint needed: at the 960px minimum window the
            ratio still yields ~380 / ~530 px columns which both sides
            fit into.  Outer AppShell scroll handles vertical overflow. */}
        {renderState === 'idle' && (
        <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
          {/* Left: Summary — read-only confirmation panel.  Sits left of
              the settings stack so the user's L→R scan reads "what am I
              about to render" then "what controls am I tweaking".  Card
              is a flex column so the row list inside can flex-1 against
              the stretched grid-cell height. */}
          <div className="rounded-xl border border-border bg-card p-4 flex flex-col">
            <Label className="uppercase tracking-wider text-[10px]">{t('summary.label')}</Label>
            <div className="mt-3 flex-1 flex flex-col divide-y divide-border/50">
              <SummaryRow label={t('summary.resolution')} value={video ? `${video.widthPx}×${video.heightPx}` : '—'} />
              <SummaryRow label={t('summary.duration')} value={video ? formatDuration(durationSec) : '—'} />
              <SummaryRow label={t('summary.format')} value={video ? `${displayContainer} / h264` : '—'} />
              <SummaryRow label={t('summary.subtitles')} value={String(activeEntries.length)} />
              <SummaryRow label={t('summary.estimatedTime')} value={video ? formatEstimatedTime(estTimeSec) : '—'} />
              <SummaryRow label={t('summary.estimatedSize')} value={video ? `${estSizeMB} MB` : '—'} />
              <SummaryRow label={t('summary.encoder')} value={effectiveEncoder ? `${ENCODER_LABELS[effectiveEncoder]} (${effectiveEncoder})` : '…'} />
            </div>
          </div>

          {/* Right: settings stack.  Output format on top so the
              file-extension choice is visible without scrolling. */}
          <div className="space-y-4">
            {/* Output format */}
            <OutputFormatCard
              videoPath={video?.path ?? null}
              outputContainer={outputContainer}
              setOutputContainer={setOutputContainer}
            />

            {/* Subtitle position / background settings moved to Step 2's
                VideoPreviewPanel so the user can adjust them while
                watching the same preview that visualises them.  Step 3
                still reads burnin / subtitleBackground from the store
                (see burninOpts below) — the values are unchanged, just
                the editing UI relocated.  Step 3 layout is reduced
                accordingly (next pass; see follow-up B2). */}

            {/* Audio mode */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center gap-1.5">
                <Music className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <Label className="uppercase tracking-wider text-[10px]">{t('audio.label')}</Label>
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
                        : 'border-border hover:bg-accent/40'
                    )}
                  >
                    <span className={cn('text-[13px] font-medium', audioMode === mode ? 'text-primary' : 'text-foreground')}>
                      {t(`audio.${mode}`)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{t(`audio.${mode}Desc`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        )}

        {/* RENDERING — centred progress card.  Settings are completely
            hidden (no opacity fade) because they cannot be edited mid-run
            and the operation should claim visual focus.  Cancel sits in
            the AppShell footerRight slot. */}
        {renderState === 'rendering' && (
          <div className="flex items-center justify-center py-16">
            <div className="rounded-xl border border-border bg-card px-8 py-10 w-full max-w-md space-y-5">
              <div className="flex items-center justify-center">
                <Loader2 className="h-8 w-8 text-primary animate-spin" />
              </div>
              <div className="space-y-3">
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-200 rounded-full"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                  <span>{t('progress.label')}</span>
                  <span className="font-mono tabular-nums">{progress}%</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SUCCESS — centred completion card.  Footer (Render again / Open
            file / Show in folder / --separator / Support) provides every
            user action; this card is purely informational. */}
        {renderState === 'success' && (
          <div className="flex items-center justify-center py-16">
            <div className="rounded-xl border border-primary/30 bg-primary/5 px-8 py-8 w-full max-w-xl space-y-3">
              <div className="flex items-center gap-2 text-primary">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                <p className="text-[14px] font-medium">{t('success.title')}</p>
              </div>
              <p className="text-[12px] text-foreground break-all selectable font-mono">{completedPath}</p>
              <p className="text-[12px] text-muted-foreground">{t('success.fileSize', { size: String(completedSizeMB) })}</p>
            </div>
          </div>
        )}

        {/* ERROR — centred error card.  Footer "Start render" button lets
            the user retry from scratch (handleStartRender re-opens the
            save dialog). */}
        {renderState === 'error' && (
          <div className="flex items-center justify-center py-16">
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-8 py-8 w-full max-w-xl space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <p className="text-[14px] font-medium">{t('error.title')}</p>
              </div>
              {errorMessage && (
                <p className="text-[11px] text-muted-foreground break-all font-mono selectable">
                  {errorMessage.slice(-400)}
                </p>
              )}
            </div>
          </div>
        )}

      </div>

      {/* In-app overwrite confirmation — surfaced AFTER the OS save dialog
          when the picked path already exists.  Belt-and-braces guard against
          the OS dialog's overwrite prompt being suppressed on some configs. */}
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
    </AppShell>
  )
}

/**
 * Output format card — sits above the audio mode card in Step 3's right column.
 *
 * The header always shows the section title; when a video is loaded the input
 * extension is appended in parentheses ("出力形式 (入力動画: mkv)") so the
 * user can verify what "input-same" actually means before clicking.  When no
 * video is loaded (defensive — Step 3 shouldn't be reachable in that state)
 * the parenthetical is omitted rather than showing a placeholder.
 *
 * `'mp4'` is the default — chosen because YouTube Shorts / TikTok / Reels
 * uploads all require MP4, and a user unfamiliar with containers gets the
 * safe option without having to think about it.
 */
function OutputFormatCard({
  videoPath,
  outputContainer,
  setOutputContainer,
}: {
  videoPath: string | null
  outputContainer: OutputContainer
  setOutputContainer: (v: OutputContainer) => void
}) {
  const { t } = useTranslation(['step3'])

  // Strip directory + uppercase the extension for display.  Tolerant of
  // dotfile-less paths (returns '' which the JSX treats as "no video loaded").
  const inputExt = videoPath
    ? (videoPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '')
    : ''

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5">
        <FileVideo className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <Label className="uppercase tracking-wider text-[10px]">
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
                : 'border-border hover:bg-accent/40'
            )}
          >
            <span className={cn(
              'text-[13px] font-medium',
              outputContainer === mode ? 'text-primary' : 'text-foreground'
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
  // flex-1 makes each row claim an equal slice of the parent's height —
  // the parent is a `flex-1 flex flex-col` inside a stretched grid cell,
  // so the 7 rows distribute themselves across the cell's full height
  // and the Summary card fills the same vertical space as the right
  // column's Output format + Audio mode stack.  min-h-[28px] is the
  // floor that keeps the layout compact when the parent has no extra
  // height to share (e.g. a future surface that uses this component in
  // a tighter container).
  return (
    <div className="flex flex-1 items-center justify-between py-2 min-h-[28px]">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[12px] text-foreground font-mono tabular-nums">{value}</span>
    </div>
  )
}

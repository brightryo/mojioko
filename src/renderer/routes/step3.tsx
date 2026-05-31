import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Play, Shield, Music, PanelBottom, FileVideo, Heart } from 'lucide-react'
import { toast } from 'sonner'
import { AppShell } from '@/components/app-shell/app-shell'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { extractFrameForPreview } from '@/services/video'
import { formatDuration, formatEstimatedTime } from '@/lib/time'
import { estimateOutputSizeMB, estimateRenderTimeSec } from '@/lib/format'
import { loadSubtitleFont, getSubtitleFont, type SubtitleFont } from '@/lib/font-metrics'
import { SubtitleOverlay } from '@/components/subtitle-overlay/subtitle-overlay'
import { computeEntryWarnings, isBurninTarget, type EntryWarnings } from '@/lib/entry-warnings'
import type { BurninHandle } from '@/services/burnin'
import type { SubtitleEntry, OutputContainer } from '../../shared/types'

interface Step3RouteProps {
  appVersion: string
}

type RenderState = 'idle' | 'rendering' | 'success' | 'error'

export default function Step3Route({ appVersion }: Step3RouteProps) {
  const { t } = useTranslation(['step3', 'common'])
  const navigate = useNavigate()

  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)
  const burnin = useSettingsStore((s) => s.burnin)
  const updateBurnin = useSettingsStore((s) => s.updateBurnin)
  const encoderSetting = useSettingsStore((s) => s.encoder)
  const audioMode = useSettingsStore((s) => s.audioMode)
  const setAudioMode = useSettingsStore((s) => s.setAudioMode)
  const fadeDurationSec = useSettingsStore((s) => s.fadeDurationSec)
  const subtitleBackground = useSettingsStore((s) => s.subtitleBackground)
  const setSubtitleBackground = useSettingsStore((s) => s.setSubtitleBackground)
  const outputContainer = useSettingsStore((s) => s.outputContainer)
  const setOutputContainer = useSettingsStore((s) => s.setOutputContainer)
  const selectedPreviewEntryId = useUiStore((s) => s.selectedPreviewEntryId)
  const setSelectedPreviewEntryId = useUiStore((s) => s.setSelectedPreviewEntryId)
  const setDonationDialogOpen = useUiStore((s) => s.setDonationDialogOpen)

  const [renderState, setRenderState] = useState<RenderState>('idle')
  const [progress, setProgress] = useState(0)
  const [completedPath, setCompletedPath] = useState<string>('')
  const [completedSizeMB, setCompletedSizeMB] = useState<number>(0)
  const [errorMessage, setErrorMessage] = useState<string>('')
  /** Path the user picked but that already exists — surfaced via the overwrite dialog. */
  const [overwriteCandidate, setOverwriteCandidate] = useState<string | null>(null)
  const [effectiveEncoder, setEffectiveEncoder] = useState<H264Encoder | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const burninHandleRef = useRef<BurninHandle | null>(null)
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const [previewDims, setPreviewDims] = useState({ w: 0, h: 0 })
  // Left preview card height — measured via ResizeObserver and applied as
  // maxHeight to the right SubtitleList card so the two cards visually match.
  // CSS-only attempts (align-items:stretch + minmax(0,1fr)) proved unreliable
  // across browser/Electron versions, so we fall back to JS measurement.
  const leftCardRef = useRef<HTMLDivElement>(null)
  const [leftCardHeight, setLeftCardHeight] = useState<number>(0)
  // Load the subtitle font so that getLibassScale() returns the correct value
  // (1000 / winHeight ≈ 0.6906 for NotoSansJP-SemiBold) before the overlay renders.
  // In normal flow the font is already cached from Step 2; this covers direct navigation.
  const [subtitleFont, setSubtitleFont] = useState<SubtitleFont | null>(getSubtitleFont)
  useEffect(() => {
    if (!subtitleFont) {
      loadSubtitleFont().then(setSubtitleFont).catch(() => {})
    }
  }, [subtitleFont])

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
  const selectedEntry = activeEntries.find((e) => e.id === selectedPreviewEntryId) ?? activeEntries[0] ?? null

  useEffect(() => {
    setSelectedPreviewEntryId(activeEntries[0]?.id ?? null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!video) return
    setPreviewImage(null)
    let cancelled = false
    const atSec = selectedEntry
      ? (selectedEntry.startSec + selectedEntry.endSec) / 2
      : video.durationSec * 0.25
    extractFrameForPreview(video.path, atSec)
      .then((result) => { if (!cancelled && result.ok) setPreviewImage(result.data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [video?.path, selectedEntry?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      setPreviewDims({ w: el.clientWidth, h: el.clientHeight })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const el = leftCardRef.current
    if (!el) return
    const obs = new ResizeObserver((obsEntries) => {
      const entry = obsEntries[0]
      // Prefer border-box so the right card matches the OUTER height of the
      // left card (including its border).  Fall back to contentRect on older
      // browsers that don't populate borderBoxSize.
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
      setLeftCardHeight(h)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])


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

  const alignLabel = `${burnin.horizontalPosition}-${burnin.verticalPosition}`
  const isResult = renderState === 'success' || renderState === 'error'
  const cardLabel = isResult ? t('result.label') : t('preview.label')

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
        // disappear next to the other buttons).  The Heart icon picks up
        // the only colour cue (rose-300) so the button body stays calm.
        className="border border-zinc-700/70 hover:border-zinc-600 hover:bg-zinc-800/60"
      >
        <Heart className="h-3.5 w-3.5 mr-1.5 text-rose-300" />
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
      <div className="space-y-4">
        {/* Page header */}
        <div>
          <h1 className="text-[18px] font-semibold text-zinc-50">{t('title')}</h1>
          <p className="mt-1 text-[13px] text-zinc-400">{t('subtitle')}</p>
        </div>

        {/* Row 1: Preview + Subtitle list */}
        {/*
          items-start so cards do NOT stretch — instead the right card's height
          is explicitly capped at the left card's measured height via the
          ResizeObserver above.  This decouples us from the CSS grid stretch
          quirks that previously let the right card outgrow the left card.
        */}
        <div className="grid gap-4 items-start" style={{ gridTemplateColumns: '1.2fr 1fr' }}>
          {/* Left: Preview card */}
          <div
            ref={leftCardRef}
            className="rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-2"
          >
            <Label className="uppercase tracking-wider text-[10px]">{cardLabel}</Label>

            {/* Preview / status area — dynamic aspect ratio for portrait + landscape */}
            <div className="flex justify-center w-full">
            <div
              ref={previewContainerRef}
              className="rounded-md bg-zinc-950 border border-zinc-800 relative overflow-hidden"
              style={{
                aspectRatio: video ? `${video.widthPx} / ${video.heightPx}` : '16 / 9',
                maxHeight: '280px',
                width: video
                  ? `min(100%, ${Math.round(280 * video.widthPx / video.heightPx)}px)`
                  : '100%',
              } as React.CSSProperties}
            >
              {/* Idle: video frame + subtitle overlay */}
              {renderState === 'idle' && (
                <>
                  {previewImage ? (
                    <img
                      src={previewImage}
                      className="absolute inset-0 w-full h-full object-cover"
                      alt=""
                    />
                  ) : (
                    <div className="absolute inset-0 bg-zinc-950" />
                  )}
                  {selectedEntry && previewDims.w > 0 ? (
                    <SubtitleOverlay
                      entry={selectedEntry}
                      burnin={burnin}
                      videoWidthPx={video?.widthPx ?? 1920}
                      containerWidthPx={previewDims.w}
                      subtitleBackground={subtitleBackground}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-[12px] text-zinc-600">{t('preview.empty')}</span>
                    </div>
                  )}

                </>
              )}

              {/* Rendering: progress overlay */}
              {renderState === 'rendering' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950">
                  <div className="w-3/4 space-y-2">
                    <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-green-500 transition-all duration-200 rounded-full"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span>{t('progress.label')}</span>
                      <span className="font-mono tabular-nums">{progress}%</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Success overlay — fully opaque */}
              {renderState === 'success' && (
                <div className="absolute inset-0 bg-[#141414] flex items-center justify-center p-4">
                  <div className="rounded-md bg-green-500/10 border border-green-500/20 p-4 w-full space-y-1">
                    <p className="text-[14px] font-medium text-green-400">{t('success.title')}</p>
                    <p className="text-[12px] text-zinc-400 break-all selectable">{completedPath}</p>
                    <p className="text-[12px] text-zinc-500">{t('success.fileSize', { size: String(completedSizeMB) })}</p>
                  </div>
                </div>
              )}

              {/* Error overlay — fully opaque */}
              {renderState === 'error' && (
                <div className="absolute inset-0 bg-[#141414] flex items-center justify-center p-4">
                  <div className="rounded-md bg-red-500/10 border border-red-500/20 p-4 w-full space-y-1.5">
                    <p className="text-[14px] font-medium text-red-400">{t('error.title')}</p>
                    {errorMessage && (
                      <p className="text-[11px] text-zinc-500 break-all font-mono selectable">{errorMessage.slice(-400)}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
            </div>

            {/* Idle-only: alignment note + disclaimer */}
            {renderState === 'idle' && (
              <div className="space-y-1">
                <p className="text-[11px] text-zinc-500">
                  {t('preview.alignmentSummary', {
                    align: alignLabel,
                    margin: burnin.verticalMarginPx
                  })}
                </p>
                <p className="text-[11px] text-zinc-600">{t('preview.disclaimer')}</p>
              </div>
            )}
          </div>

          {/* Right: Subtitle list — height capped at the left card's height. */}
          <SubtitleList
            entries={activeEntries}
            selectedId={selectedPreviewEntryId}
            onSelect={setSelectedPreviewEntryId}
            maxHeight={leftCardHeight}
          />
        </div>

        {/* Row 2: Summary + [Position + Background] + Audio */}
        <div className="grid grid-cols-3 gap-4 items-start">
          {/* Summary card */}
          <div className="rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-3">
            <Label className="uppercase tracking-wider text-[10px]">{t('summary.label')}</Label>
            <div className="space-y-0 divide-y divide-zinc-800/50">
              <SummaryRow label={t('summary.resolution')} value={video ? `${video.widthPx}×${video.heightPx}` : '—'} />
              <SummaryRow label={t('summary.duration')} value={video ? formatDuration(durationSec) : '—'} />
              <SummaryRow label={t('summary.format')} value={video ? `${displayContainer} / h264` : '—'} />
              <SummaryRow label={t('summary.subtitles')} value={String(activeEntries.length)} />
              <SummaryRow
                label={t('summary.estimatedTime')}
                value={video ? formatEstimatedTime(estTimeSec) : '—'}
              />
              <SummaryRow
                label={t('summary.estimatedSize')}
                value={video ? `${estSizeMB} MB` : '—'}
              />
              <SummaryRow
                label={t('summary.encoder')}
                value={effectiveEncoder ? `${ENCODER_LABELS[effectiveEncoder]} (${effectiveEncoder})` : '…'}
              />
            </div>
          </div>

          {/* Middle column: Subtitle position + Background stacked */}
          <div className="space-y-4">
            {/* Subtitle position card */}
            <div className={cn(
              'rounded-xl border border-zinc-800 bg-[#141414] p-4 transition-opacity duration-200',
              renderState !== 'idle' && 'opacity-50 pointer-events-none'
            )}>
              <Label className="uppercase tracking-wider text-[10px] mb-3 block">{t('subtitlePosition.title')}</Label>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
                {/* Horizontal position */}
                <span className="text-[12px] text-zinc-400 whitespace-nowrap">{t('subtitlePosition.horizontal')}</span>
                <div className="flex rounded-md overflow-hidden border border-zinc-800">
                  {(['left', 'center', 'right'] as const).map((pos) => (
                    <button
                      key={pos}
                      type="button"
                      onClick={() => updateBurnin({ horizontalPosition: pos })}
                      className={cn(
                        'flex-1 py-1.5 text-[11px] transition-colors duration-150',
                        burnin.horizontalPosition === pos
                          ? 'bg-green-500/15 text-green-400 font-medium'
                          : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                      )}
                    >
                      {t(`subtitlePosition.${pos}`)}
                    </button>
                  ))}
                </div>

                {/* Vertical position */}
                <span className="text-[12px] text-zinc-400 whitespace-nowrap">{t('subtitlePosition.vertical')}</span>
                <div className="flex rounded-md overflow-hidden border border-zinc-800">
                  {(['top', 'bottom'] as const).map((pos) => (
                    <button
                      key={pos}
                      type="button"
                      onClick={() => updateBurnin({ verticalPosition: pos })}
                      className={cn(
                        'flex-1 py-1.5 text-[11px] transition-colors duration-150',
                        burnin.verticalPosition === pos
                          ? 'bg-green-500/15 text-green-400 font-medium'
                          : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                      )}
                    >
                      {t(`subtitlePosition.${pos}`)}
                    </button>
                  ))}
                </div>

                {/* Vertical margin */}
                <span className="text-[12px] text-zinc-400 whitespace-nowrap">{t('subtitlePosition.margin')}</span>
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={burnin.verticalMarginPx}
                  onChange={(e) => updateBurnin({ verticalMarginPx: parseInt(e.target.value, 10) || 0 })}
                  className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-center text-[12px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-green-500/30 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
            </div>

            {/* Subtitle background card */}
            <div className={cn(
              'rounded-xl border border-zinc-800 bg-[#141414] p-4 transition-opacity duration-200',
              renderState !== 'idle' && 'opacity-50 pointer-events-none'
            )}>
              {/* Header row: label + toggle */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <PanelBottom className="h-4 w-4 text-zinc-500 flex-shrink-0" />
                  <Label className="uppercase tracking-wider text-[10px]">{t('background.title')}</Label>
                </div>
                <Switch
                  checked={subtitleBackground.enabled}
                  onCheckedChange={(checked) =>
                    setSubtitleBackground({ ...subtitleBackground, enabled: checked })
                  }
                />
              </div>

              {/* Outline-disabled notice — shown only while background is ON */}
              {subtitleBackground.enabled && (
                <p className="mb-3 text-xs text-amber-500">
                  {t('background.outlineNote')}
                </p>
              )}

              {/* Controls — dimmed when disabled */}
              <div className={cn(
                'grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 transition-opacity duration-150',
                !subtitleBackground.enabled && 'opacity-40 pointer-events-none'
              )}>
                {/* Background color */}
                <span className="text-[12px] text-zinc-400 whitespace-nowrap">{t('background.color')}</span>
                <div className="flex rounded-md overflow-hidden border border-zinc-800">
                  {(['black', 'white'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setSubtitleBackground({ ...subtitleBackground, color: c })}
                      className={cn(
                        'flex-1 py-1.5 text-[11px] transition-colors duration-150',
                        subtitleBackground.color === c
                          ? 'bg-green-500/15 text-green-400 font-medium'
                          : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                      )}
                    >
                      {t(`background.${c}`)}
                    </button>
                  ))}
                </div>

                {/* Opacity slider */}
                <span className="text-[12px] text-zinc-400 whitespace-nowrap">{t('background.opacity')}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={10}
                    value={subtitleBackground.opacityPercent}
                    onChange={(e) =>
                      setSubtitleBackground({
                        ...subtitleBackground,
                        opacityPercent: parseInt(e.target.value, 10)
                      })
                    }
                    className={cn(
                      'flex-1 h-1.5 appearance-none rounded-full cursor-pointer',
                      'bg-zinc-800',
                      '[&::-webkit-slider-thumb]:appearance-none',
                      '[&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5',
                      '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-green-500',
                      '[&::-webkit-slider-thumb]:cursor-pointer',
                      '[&::-webkit-slider-thumb]:border-0'
                    )}
                  />
                  <span className="text-[12px] text-zinc-400 font-mono tabular-nums w-8 text-right flex-shrink-0">
                    {subtitleBackground.opacityPercent}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right column: Output format (above) + Audio mode (below).
              Output format goes ABOVE audio mode so the choice that affects
              file extension is visible without scrolling — SNS uploaders
              should see "MP4" before they pick a destination. */}
          <div className="space-y-4">
            {/* Output format card */}
            <OutputFormatCard
              videoPath={video?.path ?? null}
              outputContainer={outputContainer}
              setOutputContainer={setOutputContainer}
              renderState={renderState}
            />

            {/* Audio mode card */}
            <div className={cn(
              'rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-2 transition-opacity duration-200',
              renderState !== 'idle' && 'opacity-50 pointer-events-none'
            )}>
              <div className="flex items-center gap-1.5">
                <Music className="h-4 w-4 text-zinc-500 flex-shrink-0" />
                <Label className="uppercase tracking-wider text-[10px]">{t('audio.label')}</Label>
              </div>
              <div className="flex flex-col gap-2">
                {(['simple', 'preserve'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={renderState !== 'idle'}
                    onClick={() => setAudioMode(mode)}
                    className={cn(
                      'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors duration-150',
                      audioMode === mode
                        ? 'border-green-500/50 bg-green-500/5'
                        : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/20',
                      'disabled:pointer-events-none'
                    )}
                  >
                    <span className={cn('text-[13px] font-medium', audioMode === mode ? 'text-green-400' : 'text-zinc-200')}>
                      {t(`audio.${mode}`)}
                    </span>
                    <span className="text-[11px] text-zinc-500">{t(`audio.${mode}Desc`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

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
  renderState,
}: {
  videoPath: string | null
  outputContainer: OutputContainer
  setOutputContainer: (v: OutputContainer) => void
  renderState: RenderState
}) {
  const { t } = useTranslation(['step3'])

  // Strip directory + uppercase the extension for display.  Tolerant of
  // dotfile-less paths (returns '' which the JSX treats as "no video loaded").
  const inputExt = videoPath
    ? (videoPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '')
    : ''

  return (
    <div className={cn(
      'rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-2 transition-opacity duration-200',
      renderState !== 'idle' && 'opacity-50 pointer-events-none'
    )}>
      <div className="flex items-center gap-1.5">
        <FileVideo className="h-4 w-4 text-zinc-500 flex-shrink-0" />
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
            disabled={renderState !== 'idle'}
            onClick={() => setOutputContainer(mode)}
            className={cn(
              'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors duration-150',
              outputContainer === mode
                ? 'border-green-500/50 bg-green-500/5'
                : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/20',
              'disabled:pointer-events-none'
            )}
          >
            <span className={cn(
              'text-[13px] font-medium',
              outputContainer === mode ? 'text-green-400' : 'text-zinc-200'
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

function SubtitleList({
  entries,
  selectedId,
  onSelect,
  maxHeight,
}: {
  entries: SubtitleEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Outer max-height in CSS pixels — measured from the left preview card. */
  maxHeight: number
}) {
  const { t } = useTranslation(['step3'])

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }

  return (
    /*
     * Card uses flex column with an explicit fixed `height` measured from the
     * left card via ResizeObserver.  Switched from `maxHeight` to `height` so
     * the right card matches the left card's height even when the entry list
     * is short — short lists would otherwise leave the right card shrunken
     * and visually unbalanced against the preview.  The inner list takes
     * `flex-1 overflow-y-auto min-h-0`, so it fills the remaining space and
     * scrolls when entries overflow.  `min-h-0` is required so the flex item
     * can shrink below its content size.
     */
    <div
      className="rounded-xl border border-zinc-800 bg-[#141414] p-4 flex flex-col overflow-hidden"
      style={{ height: maxHeight > 0 ? `${maxHeight}px` : undefined }}
    >
      <Label className="uppercase tracking-wider text-[10px] mb-2 flex-shrink-0">{t('preview.list.title')}</Label>
      {entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-8 min-h-0">
          <p className="text-[12px] text-zinc-600">{t('preview.list.empty')}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0 space-y-0.5">
          {entries.map((entry, i) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelect(entry.id)}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-md transition-colors duration-150',
                selectedId === entry.id
                  ? 'bg-green-500/10 border border-green-500/30'
                  : 'hover:bg-zinc-800/40 border border-transparent'
              )}
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[11px] text-zinc-500 font-mono tabular-nums flex-shrink-0">{i + 1}</span>
                <span className={cn(
                  'text-[12px] truncate min-w-0',
                  selectedId === entry.id ? 'text-zinc-50' : 'text-zinc-300'
                )}>
                  {entry.text.replace(/\\N/g, ' ')}
                </span>
              </div>
              <p className="text-[10px] text-zinc-600 font-mono pl-5 tabular-nums mt-0.5">
                {formatTime(entry.startSec)} → {formatTime(entry.endSec)}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-[12px] text-zinc-500">{label}</span>
      <span className="text-[12px] text-zinc-100 font-mono tabular-nums">{value}</span>
    </div>
  )
}

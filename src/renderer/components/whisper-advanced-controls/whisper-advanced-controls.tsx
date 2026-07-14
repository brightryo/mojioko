import { useTranslation } from 'react-i18next'
import { HelpCircle, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { TranscriptionAdvancedParams } from '../../../shared/types'
import { TRANSCRIPTION_DEFAULTS } from '../../../shared/constants'

function AdvancedParamRow({
  label,
  help,
  changed,
  children
}: {
  label: string
  help: string
  changed: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 -mx-2 hover:bg-accent/40 transition-colors duration-150">
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className={cn(
            'text-body transition-colors duration-150',
            changed ? 'text-[hsl(var(--warning))]' : 'text-muted-foreground'
          )}
        >
          {label}
        </span>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-150">
              <HelpCircle className="h-3.5 w-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px] text-left">
            {help}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex-1 border-t border-dashed border-border min-w-[16px]" />
      <div className="shrink-0">{children}</div>
    </div>
  )
}

interface WhisperAdvancedControlsProps {
  transcriptionAdvanced: TranscriptionAdvancedParams
  /** Patch one or more fields.  Same shape as setTranscriptionAdvancedParams. */
  onUpdate: (patch: Partial<TranscriptionAdvancedParams>) => void
  /** Resets every field back to TRANSCRIPTION_DEFAULTS. */
  onReset: () => void
}

/**
 * Six Whisper engine parameters — VAD filter, VAD threshold, min speech /
 * silence duration, beam size, language — extracted from
 * `transcription-advanced-dialog.tsx` so the same form can also be rendered
 * inside the Settings dialog's "Whisper" tab (REQ-019 #1).
 *
 * Purely presentational: no store subscription.  Both call sites pass the
 * current slice + a setter, so the "single source of truth" wiring stays
 * explicit at each use site instead of baked into the component.  Identical
 * pattern to `<DefaultStyleControls>` (REQ-016).
 *
 * Visual output is byte-identical to the previous inline form in
 * `transcription-advanced-dialog.tsx:128-322` (verified by code diff).
 */
export function WhisperAdvancedControls({
  transcriptionAdvanced,
  onUpdate,
  onReset
}: WhisperAdvancedControlsProps) {
  const { t } = useTranslation(['step1'])

  const isAdvancedChanged =
    transcriptionAdvanced.vadFilter !== TRANSCRIPTION_DEFAULTS.vadFilter ||
    transcriptionAdvanced.vadThreshold !== TRANSCRIPTION_DEFAULTS.vadThreshold ||
    transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs ||
    transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs ||
    transcriptionAdvanced.beamSize !== TRANSCRIPTION_DEFAULTS.beamSize ||
    transcriptionAdvanced.language !== TRANSCRIPTION_DEFAULTS.language

  function numberInputClass(modified: boolean): string {
    return cn(
      'w-20 h-7 rounded-md border bg-input px-2 text-center text-body',
      'focus:outline-none focus-visible:ring-2 tabular-nums',
      '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
      modified
        ? 'border-[hsl(var(--warning)/0.6)] text-[hsl(var(--warning))] focus-visible:ring-[hsl(var(--warning)/0.3)]'
        : 'border-border text-foreground focus-visible:ring-ring/30'
    )
  }

  return (
    <div className="space-y-5">
      {/* ── VAD ─────────────────────────────────────────────────────── */}
      <div className="space-y-0.5">
        <p className="text-label font-medium uppercase tracking-wider text-foreground mb-2">
          {t('advanced.vad')}
        </p>
        <AdvancedParamRow
          label={t('advanced.vadFilter')}
          help={t('advanced.vadFilterHelp')}
          changed={transcriptionAdvanced.vadFilter !== TRANSCRIPTION_DEFAULTS.vadFilter}
        >
          <div className="flex items-center gap-2">
            <Switch
              checked={transcriptionAdvanced.vadFilter}
              onCheckedChange={(v) => onUpdate({ vadFilter: v })}
            />
            <span
              className={cn(
                'text-body-sm transition-colors duration-150',
                transcriptionAdvanced.vadFilter !== TRANSCRIPTION_DEFAULTS.vadFilter
                  ? 'text-[hsl(var(--warning))]'
                  : 'text-muted-foreground'
              )}
            >
              {transcriptionAdvanced.vadFilter ? t('advanced.enabled') : t('advanced.disabled')}
            </span>
          </div>
        </AdvancedParamRow>

        {transcriptionAdvanced.vadFilter && (
          <AdvancedParamRow
            label={t('advanced.vadThreshold')}
            help={t('advanced.vadThresholdHelp')}
            changed={transcriptionAdvanced.vadThreshold !== TRANSCRIPTION_DEFAULTS.vadThreshold}
          >
            <input
              key={transcriptionAdvanced.vadThreshold}
              type="number"
              min={0}
              max={1}
              step={0.05}
              defaultValue={transcriptionAdvanced.vadThreshold}
              // REQ-0128 Phase 1 — Enter commits via blur (DaVinci-style).
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
              onBlur={(e) => {
                const v = parseFloat(e.target.value)
                if (isNaN(v)) return
                onUpdate({
                  vadThreshold: Math.min(1, Math.max(0, Math.round(v * 100) / 100))
                })
              }}
              className={numberInputClass(
                transcriptionAdvanced.vadThreshold !== TRANSCRIPTION_DEFAULTS.vadThreshold
              )}
            />
          </AdvancedParamRow>
        )}

        <AdvancedParamRow
          label={t('advanced.minSpeechDuration')}
          help={t('advanced.minSpeechDurationHelp')}
          changed={transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs}
        >
          <div className="flex items-center gap-1.5">
            <input
              key={transcriptionAdvanced.minSpeechDurationMs}
              type="number"
              min={50}
              max={1000}
              step={50}
              defaultValue={transcriptionAdvanced.minSpeechDurationMs}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
              onBlur={(e) => {
                const v = parseInt(e.target.value, 10)
                if (isNaN(v)) return
                onUpdate({
                  minSpeechDurationMs: Math.min(1000, Math.max(50, v))
                })
              }}
              className={numberInputClass(
                transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs
              )}
            />
            <span className="text-caption text-muted-foreground/60">ms</span>
          </div>
        </AdvancedParamRow>

        <AdvancedParamRow
          label={t('advanced.minSilenceDuration')}
          help={t('advanced.minSilenceDurationHelp')}
          changed={transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs}
        >
          <div className="flex items-center gap-1.5">
            <input
              key={transcriptionAdvanced.minSilenceDurationMs}
              type="number"
              min={100}
              max={5000}
              step={100}
              defaultValue={transcriptionAdvanced.minSilenceDurationMs}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
              onBlur={(e) => {
                const v = parseInt(e.target.value, 10)
                if (isNaN(v)) return
                onUpdate({
                  minSilenceDurationMs: Math.min(5000, Math.max(100, v))
                })
              }}
              className={numberInputClass(
                transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs
              )}
            />
            <span className="text-caption text-muted-foreground/60">ms</span>
          </div>
        </AdvancedParamRow>
      </div>

      {/* ── Recognition ─────────────────────────────────────────────── */}
      <div className="space-y-0.5">
        <p className="text-label font-medium uppercase tracking-wider text-foreground mb-2">
          {t('advanced.recognition')}
        </p>
        <AdvancedParamRow
          label={t('advanced.beamSize')}
          help={t('advanced.beamSizeHelp')}
          changed={transcriptionAdvanced.beamSize !== TRANSCRIPTION_DEFAULTS.beamSize}
        >
          <input
            key={transcriptionAdvanced.beamSize}
            type="number"
            min={1}
            max={20}
            step={1}
            defaultValue={transcriptionAdvanced.beamSize}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
            onBlur={(e) => {
              const v = parseInt(e.target.value, 10)
              if (isNaN(v)) return
              onUpdate({ beamSize: Math.min(20, Math.max(1, v)) })
            }}
            className={numberInputClass(
              transcriptionAdvanced.beamSize !== TRANSCRIPTION_DEFAULTS.beamSize
            )}
          />
        </AdvancedParamRow>

        <AdvancedParamRow
          label={t('advanced.language')}
          help={t('advanced.languageHelp')}
          changed={transcriptionAdvanced.language !== TRANSCRIPTION_DEFAULTS.language}
        >
          <Select
            value={transcriptionAdvanced.language}
            onValueChange={(v) => onUpdate({ language: v })}
          >
            <SelectTrigger
              className={cn(
                'w-36 h-7 text-body border bg-input',
                transcriptionAdvanced.language !== TRANSCRIPTION_DEFAULTS.language
                  ? 'border-[hsl(var(--warning)/0.6)] text-[hsl(var(--warning))]'
                  : 'border-border text-foreground'
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['auto', 'ja', 'en', 'zh', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar'] as const).map(
                (code) => (
                  <SelectItem key={code} value={code}>
                    {t(`advanced.lang_${code}`)}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
        </AdvancedParamRow>
      </div>

      {/* ── Reset button ─────────────────────────────────────────────
          REQ-0225 — the "設定は自動的に保存されます" note was retired.
          MOJIOKO auto-saves every settings surface; a dedicated note
          on this one panel was redundant.  The layout now shrinks to
          just the reset button (right-aligned via `justify-end`,
          only rendered when the current values differ from
          TRANSCRIPTION_DEFAULTS). */}
      {isAdvancedChanged && (
        <div className="flex items-center justify-end pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-7 text-body-sm text-muted-foreground hover:text-foreground gap-1.5 flex-shrink-0"
          >
            <RotateCcw className="h-3 w-3" />
            {t('advanced.resetToDefaults')}
          </Button>
        </div>
      )}
    </div>
  )
}

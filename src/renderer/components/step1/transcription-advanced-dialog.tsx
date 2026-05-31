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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useSettingsStore } from '@/stores/settings-store'
import { TRANSCRIPTION_DEFAULTS } from '../../../shared/constants'

/**
 * Editable parameter row used inside the dialog.
 *
 * Layout: label (+ help tooltip) on the left, dashed leader filling the
 * gap, control on the right.  When the value differs from the
 * TRANSCRIPTION_DEFAULTS the label tints to --warning so the user can
 * see at a glance which fields they have touched.
 */
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
            'text-sm transition-colors duration-150',
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

interface TranscriptionAdvancedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Advanced transcription parameters dialog for Step 1.
 *
 * Holds the three previously-inline accordion sections — Text formatting,
 * VAD, Recognition — plus the reset-to-defaults affordance.  All data
 * flows through useSettingsStore exactly as it did before the move; the
 * dialog is purely a UI re-housing of the existing controls, so behaviour
 * (debouncing, validation clamping, persistence) is identical to the old
 * accordion.  Step 1 keeps deciding when to render this — it stays
 * mounted while open, unmounts on close (Radix handles that).
 */
export function TranscriptionAdvancedDialog({
  open,
  onOpenChange
}: TranscriptionAdvancedDialogProps) {
  const { t } = useTranslation(['step1'])

  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  const setTranscriptionAdvanced = useSettingsStore((s) => s.setTranscriptionAdvanced)
  const resetTranscriptionAdvanced = useSettingsStore((s) => s.resetTranscriptionAdvanced)

  // autoLineBreak intentionally lives outside this dialog now — it is a
  // subtitle-formatting choice (post-transcription output), not a Whisper
  // engine parameter, so it sits in Step 1's "Subtitle defaults" card next
  // to font size / colours / outline / fade.  The dialog reset below only
  // touches engine fields.
  const isAdvancedChanged =
    transcriptionAdvanced.vadFilter !== TRANSCRIPTION_DEFAULTS.vadFilter ||
    transcriptionAdvanced.vadThreshold !== TRANSCRIPTION_DEFAULTS.vadThreshold ||
    transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs ||
    transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs ||
    transcriptionAdvanced.beamSize !== TRANSCRIPTION_DEFAULTS.beamSize ||
    transcriptionAdvanced.language !== TRANSCRIPTION_DEFAULTS.language

  // Shared number-input class — `--warning` tinted while modified.
  function numberInputClass(modified: boolean): string {
    return cn(
      'w-20 h-7 rounded-md border bg-input px-2 text-center text-[13px]',
      'focus:outline-none focus:ring-2 tabular-nums',
      '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
      modified
        ? 'border-[hsl(var(--warning)/0.6)] text-[hsl(var(--warning))] focus:ring-[hsl(var(--warning)/0.3)]'
        : 'border-border text-foreground focus:ring-ring/30'
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('advanced.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          {/* ── VAD ─────────────────────────────────────────────────────── */}
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-foreground mb-2">
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
                  onCheckedChange={(v) => setTranscriptionAdvanced({ vadFilter: v })}
                />
                <span
                  className={cn(
                    'text-[12px] transition-colors duration-150',
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
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value)
                    if (isNaN(v)) return
                    setTranscriptionAdvanced({
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
                  onBlur={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (isNaN(v)) return
                    setTranscriptionAdvanced({
                      minSpeechDurationMs: Math.min(1000, Math.max(50, v))
                    })
                  }}
                  className={numberInputClass(
                    transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs
                  )}
                />
                <span className="text-[11px] text-muted-foreground/60">ms</span>
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
                  onBlur={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (isNaN(v)) return
                    setTranscriptionAdvanced({
                      minSilenceDurationMs: Math.min(5000, Math.max(100, v))
                    })
                  }}
                  className={numberInputClass(
                    transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs
                  )}
                />
                <span className="text-[11px] text-muted-foreground/60">ms</span>
              </div>
            </AdvancedParamRow>
          </div>

          {/* ── Recognition ─────────────────────────────────────────────── */}
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-foreground mb-2">
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
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (isNaN(v)) return
                  setTranscriptionAdvanced({ beamSize: Math.min(20, Math.max(1, v)) })
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
                onValueChange={(v) => setTranscriptionAdvanced({ language: v })}
              >
                <SelectTrigger
                  className={cn(
                    'w-36 h-7 text-[13px] border bg-input',
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

          {/* ── Reset + note ────────────────────────────────────────────── */}
          <div className="flex items-center justify-between pt-1">
            <p className="text-[11px] italic text-muted-foreground/60">
              {t('advanced.futureNote')}
            </p>
            {isAdvancedChanged && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Engine-only reset — autoLineBreak now lives in the
                  // Subtitle defaults card and is reset there if needed.
                  resetTranscriptionAdvanced()
                }}
                className="h-7 text-[12px] text-muted-foreground hover:text-foreground gap-1.5 flex-shrink-0"
              >
                <RotateCcw className="h-3 w-3" />
                {t('advanced.resetToDefaults')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

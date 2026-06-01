import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { HelpIcon } from '@/components/help-icon'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { cn } from '@/lib/utils'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'

interface DefaultStyleControlsProps {
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  outlineThicknessPx: number
  fadeEnabled: boolean
  autoLineBreak: boolean
  /**
   * Updates one or more of the 5 transcription-default style fields.
   * Implementations write these to whichever store owns the defaults
   * (SubtitleStyleDialog currently uses projectStore.defaults; the Settings
   * dialog uses settingsStore.transcriptionDefaults).
   */
  onUpdateDefaults: (patch: {
    fontSizePx?: number
    textColorHex?: string
    outlineColorHex?: string
    outlineThicknessPx?: number
    fadeEnabled?: boolean
  }) => void
  /** autoLineBreak lives on settingsStore directly (not inside transcriptionDefaults). */
  onSetAutoLineBreak: (v: boolean) => void
}

/**
 * Six default-style controls — font size, text colour, outline colour,
 * outline thickness, fade toggle, auto line break.  Extracted from the
 * SubtitleStyleDialog form column so the same six controls can also be
 * rendered inside the Settings dialog's "Default style" tab without
 * duplicating markup or i18n keys.
 *
 * The component is purely presentational: it does not subscribe to any
 * store.  Both call sites pass current values + setters that target
 * whichever store they want to write to.  This keeps the "single source
 * of truth" wiring (REQ-016) explicit at each use site rather than baked
 * into the component.
 *
 * Visual output is byte-identical to the previous inline form in
 * `subtitle-style-dialog.tsx:93-206` (verified by code diff).
 */
export function DefaultStyleControls({
  fontSizePx,
  textColorHex,
  outlineColorHex,
  outlineThicknessPx,
  fadeEnabled,
  autoLineBreak,
  onUpdateDefaults,
  onSetAutoLineBreak
}: DefaultStyleControlsProps) {
  const { t } = useTranslation(['step1'])
  // Tracks whether the size input currently holds an out-of-range value so
  // the field can flash --warning during typing.  Resets on blur after the
  // value is clamped and committed.
  const [fontSizeOutOfRange, setFontSizeOutOfRange] = useState(false)

  return (
    <div className="space-y-3">
      {/* Font size */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.size')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpSize')} />
        </div>
        <input
          key={fontSizePx}
          type="number"
          min={FONT_SIZE_MIN_PX}
          max={FONT_SIZE_MAX_PX}
          defaultValue={fontSizePx}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10)
            setFontSizeOutOfRange(
              !isNaN(v) && (v < FONT_SIZE_MIN_PX || v > FONT_SIZE_MAX_PX)
            )
          }}
          onBlur={(e) => {
            setFontSizeOutOfRange(false)
            const v = parseInt(e.target.value, 10)
            if (isNaN(v)) return
            onUpdateDefaults({
              fontSizePx: Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, v))
            })
          }}
          className={cn(
            'h-9 w-32 rounded-md border bg-input px-2 text-center text-[13px] text-foreground',
            'focus:outline-none focus:ring-2',
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
            fontSizeOutOfRange
              ? 'border-[hsl(var(--warning)/0.6)] focus:ring-[hsl(var(--warning)/0.3)]'
              : 'border-border focus:ring-ring/30'
          )}
        />
      </div>

      {/* Text color */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.textColor')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpTextColor')} />
        </div>
        <ColorPicker
          value={textColorHex}
          onChange={(hex) => onUpdateDefaults({ textColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </div>

      {/* Outline color */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.outlineColor')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpOutlineColor')} />
        </div>
        <ColorPicker
          value={outlineColorHex}
          onChange={(hex) => onUpdateDefaults({ outlineColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </div>

      {/* Outline thickness — shared slider component (same as Step 2
          per-row + bulk-edit, so the look and commit semantics stay
          aligned across surfaces). */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.stroke')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpStroke')} />
        </div>
        <OutlineThicknessSlider
          value={outlineThicknessPx}
          onCommit={(v) => onUpdateDefaults({ outlineThicknessPx: v })}
          ariaLabel={t('subtitleDefaults.stroke')}
        />
      </div>

      {/* Fade */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.fade')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpFade')} />
        </div>
        <div className="flex items-center gap-2 h-9">
          <Switch
            checked={fadeEnabled}
            onCheckedChange={(v) => onUpdateDefaults({ fadeEnabled: v })}
          />
          <span className="text-[12px] text-muted-foreground">
            {fadeEnabled
              ? t('subtitleDefaults.fadeOn')
              : t('subtitleDefaults.fadeOff')}
          </span>
        </div>
      </div>

      {/* Auto line break — subtitle-formatting decision (post-
          transcription), so it lives here rather than in the engine
          Advanced dialog.  Toggling immediately re-wraps the preview
          on the right. */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('advanced.autoLineBreak')}</Label>
          <HelpIcon content={t('advanced.autoLineBreakHelp')} />
        </div>
        <div className="flex items-center gap-2 h-9">
          <Switch
            checked={autoLineBreak}
            onCheckedChange={(v) => onSetAutoLineBreak(v)}
          />
          <span className="text-[12px] text-muted-foreground">
            {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
          </span>
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { HelpIcon } from '@/components/help-icon'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { StyleSamplePreview } from '@/components/step1/style-sample-preview'
import { FontPicker } from '@/components/font-picker/font-picker'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'

interface SubtitleStyleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Step 1's local thumbnail state — driven by extractThumbnail when a video
   * is loaded.  Lives outside the project store so we pass it through
   * explicitly rather than re-subscribing.
   */
  thumbnail: string | null
}

/**
 * Subtitle style dialog for Step 1.
 *
 * Step 1's first view is now reserved for the two mandatory choices: which
 * video to transcribe and which audio track inside it.  The detailed
 * subtitle seed-style controls — size, colours, outline, fade, auto line
 * break — live behind this dialog so they don't compete for vertical
 * space with the must-touch surface.
 *
 * Layout pairs the form controls (left) with a live preview (right) so the
 * user can iterate "tweak → see → tweak" without closing the dialog.  The
 * preview reuses the same StyleSamplePreview component that proved out the
 * font-load + autoLineBreak integration in commits A / F.
 *
 * Data flow: the dialog subscribes to the project store (for defaults) and
 * settings store (for autoLineBreak) directly, so step1.tsx only has to
 * forward `open` / `onOpenChange` / `thumbnail`.  `defaults` itself is NOT
 * moved out of Step 1's project-store slice — the seed-vs-bulk-vs-render
 * contract across the three steps stays exactly as before.
 */
export function SubtitleStyleDialog({
  open,
  onOpenChange,
  thumbnail
}: SubtitleStyleDialogProps) {
  const { t } = useTranslation(['step1'])

  const video = useProjectStore((s) => s.video)
  const defaults = useProjectStore((s) => s.defaults)
  const setDefaults = useProjectStore((s) => s.setDefaults)
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const setAutoLineBreak = useSettingsStore((s) => s.setAutoLineBreak)

  // Tracks whether the size input currently holds an out-of-range value so
  // the field can flash --warning during typing.  Resets on blur after the
  // value is clamped and committed.
  const [fontSizeOutOfRange, setFontSizeOutOfRange] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[900px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('subtitleStyle.dialogTitle')}</DialogTitle>
          <DialogDescription className="text-[12px] text-muted-foreground">
            {t('subtitleStyle.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        {/* Form left / preview right.  Below lg the columns stack so the
            dialog stays usable in narrow / portrait windows. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
          {/* ── Form column ─────────────────────────────────────────── */}
          <div className="space-y-3">
            {/* Font family — drives both the preview's @font-face and the
                ASS Style fontname at burn-in time.  Lives at the top of the
                form because it changes the visual identity more than the
                other knobs.  Bundled Noto + 8 OFL fonts; non-bundled fonts
                are downloaded on demand. */}
            <FontPicker />

            {/* Font size */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <Label>{t('subtitleDefaults.size')}</Label>
                <HelpIcon content={t('subtitleDefaults.helpSize')} />
              </div>
              <input
                key={defaults.fontSizePx}
                type="number"
                min={FONT_SIZE_MIN_PX}
                max={FONT_SIZE_MAX_PX}
                defaultValue={defaults.fontSizePx}
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
                  setDefaults({
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
                value={defaults.textColorHex}
                onChange={(hex) => setDefaults({ textColorHex: hex })}
              />
            </div>

            {/* Outline color */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <Label>{t('subtitleDefaults.outlineColor')}</Label>
                <HelpIcon content={t('subtitleDefaults.helpOutlineColor')} />
              </div>
              <ColorPicker
                value={defaults.outlineColorHex}
                onChange={(hex) => setDefaults({ outlineColorHex: hex })}
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
                value={defaults.outlineThicknessPx}
                onCommit={(v) => setDefaults({ outlineThicknessPx: v })}
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
                  checked={defaults.fadeEnabled}
                  onCheckedChange={(v) => setDefaults({ fadeEnabled: v })}
                />
                <span className="text-[12px] text-muted-foreground">
                  {defaults.fadeEnabled
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
                  onCheckedChange={(v) => setAutoLineBreak(v)}
                />
                <span className="text-[12px] text-muted-foreground">
                  {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
                </span>
              </div>
            </div>
          </div>

          {/* ── Preview column ──────────────────────────────────────── */}
          <StyleSamplePreview
            defaults={defaults}
            thumbnail={thumbnail}
            video={video}
            autoLineBreak={autoLineBreak}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

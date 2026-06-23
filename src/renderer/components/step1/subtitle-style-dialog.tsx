import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { StyleSamplePreview } from '@/components/step1/style-sample-preview'
import { FontPicker } from '@/components/font-picker/font-picker'
import { DefaultStyleControls } from '@/components/default-style-controls/default-style-controls'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'

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
  // Single source of truth (REQ-016): the dialog reads & writes
  // settingsStore.transcriptionDefaults.  projectStore.defaults is a
  // transcribe-start snapshot, written once by step1.tsx in
  // handleStartTranscription and never touched here.
  const defaults = useSettingsStore((s) => s.transcriptionDefaults)
  const setDefaults = useSettingsStore((s) => s.updateTranscriptionDefaults)
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const setAutoLineBreak = useSettingsStore((s) => s.setAutoLineBreak)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[900px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('subtitleStyle.dialogTitle')}</DialogTitle>
          <DialogDescription className="text-body-sm text-muted-foreground">
            {t('subtitleStyle.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        {/* "Visual" left, "Parameters" right.  Left column groups the
            two visual-identity surfaces — what the subtitle will look
            like (preview) and which font face renders it (FontPicker).
            Right column holds the numerical / colour controls that
            adjust that look.  Below lg the columns stack so the dialog
            stays usable in narrow / portrait windows.  REQ-019 #3a. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
          {/* ── Visual column ───────────────────────────────────────── */}
          <div className="space-y-3">
            <StyleSamplePreview
              defaults={defaults}
              thumbnail={thumbnail}
              video={video}
              autoLineBreak={autoLineBreak}
            />

            {/* Font family — drives both the preview's @font-face and the
                ASS Style fontname at burn-in time.  Sits under the preview
                so the choice of face and its rendered result are visually
                adjacent.  Bundled Noto + 8 OFL fonts; non-bundled fonts
                are downloaded on demand. */}
            <FontPicker />
          </div>

          {/* ── Parameters column ───────────────────────────────────── */}
          {/* Size / colors / outline / auto line break — shared with the
              Settings dialog's "Default style" tab via this component.
              REQ-20260615-050: fade default for new entries moved to the
              Settings dialog's General-tab FadeDurationSlider. */}
          <DefaultStyleControls
            fontSizePx={defaults.fontSizePx}
            textColorHex={defaults.textColorHex}
            outlineColorHex={defaults.outlineColorHex}
            outlineThicknessPx={defaults.outlineThicknessPx}
            autoLineBreak={autoLineBreak}
            onUpdateDefaults={setDefaults}
            onSetAutoLineBreak={setAutoLineBreak}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

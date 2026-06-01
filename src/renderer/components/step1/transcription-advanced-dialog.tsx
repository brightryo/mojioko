import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { WhisperAdvancedControls } from '@/components/whisper-advanced-controls/whisper-advanced-controls'
import { useSettingsStore } from '@/stores/settings-store'

interface TranscriptionAdvancedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Advanced transcription parameters dialog for Step 1.
 *
 * Form body is the shared `<WhisperAdvancedControls>` component, so this
 * dialog and the Settings dialog's "Whisper" tab (REQ-019 #1) render the
 * same controls bound to the same `useSettingsStore.transcriptionAdvanced`
 * slice — editing on either surface stays in sync.
 *
 * autoLineBreak deliberately lives outside this dialog: it is a subtitle-
 * formatting choice (post-transcription output), not a Whisper engine
 * parameter, so it sits in the Subtitle Style dialog next to font size /
 * colours / outline / fade.  The reset button below only touches engine
 * fields.
 */
export function TranscriptionAdvancedDialog({
  open,
  onOpenChange
}: TranscriptionAdvancedDialogProps) {
  const { t } = useTranslation(['step1'])

  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  const setTranscriptionAdvanced = useSettingsStore((s) => s.setTranscriptionAdvanced)
  const resetTranscriptionAdvanced = useSettingsStore((s) => s.resetTranscriptionAdvanced)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('advanced.title')}</DialogTitle>
        </DialogHeader>

        <div className="pt-1">
          <WhisperAdvancedControls
            transcriptionAdvanced={transcriptionAdvanced}
            onUpdate={setTranscriptionAdvanced}
            onReset={resetTranscriptionAdvanced}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

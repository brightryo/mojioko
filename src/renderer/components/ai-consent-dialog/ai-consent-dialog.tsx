import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

/**
 * REQ-0551 — what changes, and what does not, when an AI assistant drives
 * MOJIOKO.
 *
 * ## One mode (REQ-0559 §2)
 *
 * Shown before every action that hands connection details to an assistant.
 * Accepting proceeds; cancelling does nothing at all.
 *
 * There used to be a second `notice` mode, shown once to someone who had set
 * this up before the gate existed. REQ-0559 made the gate fire EVERY time, so
 * that user now meets the full dialog the next time they export or copy — a
 * better moment than a popup for merely opening a tab, and the same text. A
 * mode that only differed by a weaker button label was two things to maintain
 * for one fact.
 *
 * The same body is also rendered permanently on the AI tab, from these same
 * strings, so it can be re-read without triggering anything.
 *
 * ## What the copy has to get right
 *
 * Not "everything is sent" and not "nothing is sent". The line is: the
 * PROCESSING stays local and the media never leaves, but what the assistant
 * reads and writes through the tools — subtitle text, file paths, video
 * metadata, tool replies — goes to the AI provider, because that is where the
 * assistant runs. No legal register, no scare wording; the point is that the
 * user can picture what actually travels.
 */
export function AiConsentDialog({
  open,
  onAccept,
  onDismiss,
}: {
  open: boolean
  onAccept: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onDismiss() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('ai.consent.title')}</DialogTitle>
          <DialogDescription>{t('ai.consent.lead')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-line bg-surface-2 p-3">
            <p className="text-caption text-fg-secondary mb-1">{t('ai.consent.staysLocalLabel')}</p>
            <p className="text-body-sm text-fg-primary">{t('ai.consent.staysLocal')}</p>
          </div>
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="text-caption text-warning-faint mb-1">{t('ai.consent.leavesLabel')}</p>
            <p className="text-body-sm text-fg-primary">{t('ai.consent.leaves')}</p>
          </div>
          <p className="text-body-sm text-fg-secondary">{t('ai.consent.provider')}</p>
          {/* A bundle already exported keeps working; saying so avoids implying
              that cancelling here revokes an existing setup. */}
          <p className="text-body-sm text-fg-secondary">{t('ai.consent.alreadyExported')}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>{t('common:action.cancel')}</Button>
          <Button variant="primary" onClick={onAccept}>{t('ai.consent.acceptGate')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

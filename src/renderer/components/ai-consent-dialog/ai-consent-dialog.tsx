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
 * ## Two modes, one text
 *
 * - `gate`: shown before an action that hands connection details to an
 *   assistant. Accepting proceeds; cancelling does nothing at all.
 * - `notice`: shown once to someone who set this up before the gate existed.
 *   Their setup keeps working — the buttons say so — because revoking a
 *   working configuration to make a point would be its own harm.
 *
 * The body is the SAME text in both modes. A user who was told after the fact
 * deserves the same information as one asked in advance, and maintaining two
 * versions of a privacy explanation is how they drift apart.
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
  mode,
  onAccept,
  onDismiss,
}: {
  open: boolean
  mode: 'gate' | 'notice'
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
          {/* Only meaningful in `notice` mode: the bundle they already exported
              keeps working, and pretending otherwise would be misleading. */}
          {mode === 'notice' && (
            <p className="text-body-sm text-fg-secondary">{t('ai.consent.alreadyExported')}</p>
          )}
        </div>

        <DialogFooter>
          {mode === 'gate' ? (
            <>
              <Button variant="ghost" onClick={onDismiss}>{t('common:action.cancel')}</Button>
              <Button variant="primary" onClick={onAccept}>{t('ai.consent.acceptGate')}</Button>
            </>
          ) : (
            <Button variant="primary" onClick={onAccept}>{t('ai.consent.acceptNotice')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

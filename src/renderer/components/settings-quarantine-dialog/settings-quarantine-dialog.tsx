import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import type { SettingsQuarantineNotice } from '../../../main/ipc/settings-shape'

/**
 * REQ-0542 — told once, at startup: your settings file was not one of ours, so
 * it was moved aside and the app started from defaults.
 *
 * ## Why a dialog and not a toast
 *
 * The user has, from their point of view, just lost their style defaults,
 * presets and folder choices. A toast that disappears after five seconds is how
 * this went unnoticed for a day in the first place (RES-0540 §5 — the only
 * trace was a log line). It needs an acknowledgement, and it needs to show the
 * path, because the path is the thing that makes the loss recoverable.
 *
 * ## What the text must NOT promise
 *
 * This guard makes the situation VISIBLE; it does not stop the other program
 * from overwriting the file again. If an older MOJIOKO keeps running, this
 * dialog will appear on every launch — which is the honest outcome, not a bug.
 * The copy says so, so a user who sees it twice does not conclude the fix
 * failed.
 */
export function SettingsQuarantineDialog({
  notice,
  onDismiss,
}: {
  notice: SettingsQuarantineNotice | null
  onDismiss: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <Dialog open={notice !== null} onOpenChange={(open) => { if (!open) onDismiss() }}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('settings:quarantine.title')}</DialogTitle>
          <DialogDescription>
            {notice?.reason === 'unreadable'
              ? t('settings:quarantine.bodyUnreadable')
              : t('settings:quarantine.bodyForeign')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <p className="text-caption text-fg-secondary mb-1">
              {t('settings:quarantine.savedTo')}
            </p>
            {/* Selectable: the whole point is that the user can go and get it. */}
            <p className="text-body-sm font-mono break-all select-text rounded-md border border-line bg-surface-2 p-2">
              {notice?.quarantinedPath ?? ''}
            </p>
          </div>
          <p className="text-body-sm text-fg-secondary">
            {t('settings:quarantine.hint')}
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="primary" size="md" onClick={onDismiss}>
            {t('common:action.ok')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useProjectStore } from '@/stores/project-store'
import { unsavedTracker } from '@/lib/unsaved-changes'
import { saveCurrentProject } from '@/services/project-file'

/**
 * REQ-0546 (RES-0543 F2) — the confirmation that stands between the user and
 * losing their work.
 *
 * main blocks the close and asks; this component answers. When there is nothing
 * to lose it answers `discard` immediately, so the ordinary "close an untouched
 * app" path shows no dialog at all — which is also what keeps the automated
 * gates from hanging on a prompt (REQ-0546 §2).
 *
 * The dialog deliberately reuses the shape and wording family of the existing
 * discard confirmation shown when opening another project over an edited one
 * (`project-open-controller`), rather than inventing a second look for the same
 * question.
 *
 * ## The third button
 *
 * REQ-0546 §1-4 left "save and quit" to judgement. It is offered, because the
 * user's actual intent when they see this dialog is usually "oh — I meant to
 * save". It calls the ordinary `saveCurrentProject()` (dialog and all, now
 * atomic per REQ-0545) and only quits if that reports success; a cancelled or
 * failed save leaves the app open, because quitting after a save that did not
 * happen is the exact loss this dialog exists to prevent.
 */
export function QuitConfirm() {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.subscribeToChannel) return
    const unsubscribe = api.subscribeToChannel('app:closeRequested', () => {
      const hasProject = useProjectStore.getState().video !== null
      /*
       * ★ The automation escape, and why it is not an environment assumption.
       *
       * `window.__mojioko_test` exists only when the renderer was loaded with
       * `?seed=demo`, which the shipped main process never appends — it is the
       * page DECLARING that it is a harness, not this code guessing about the
       * machine. A gate drives the store directly, so it would otherwise look
       * dirty and `electronApp.close()` would wait forever on a dialog nobody
       * can click.
       */
      const isHarness = Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test)
      if (isHarness || !unsavedTracker.hasUnsavedWork(hasProject)) {
        void api.sendCloseDecision('discard')
        return
      }
      setOpen(true)
    })
    return unsubscribe
  }, [])

  const answer = (decision: 'discard' | 'cancel') => {
    setOpen(false)
    void window.electronAPI?.sendCloseDecision(decision)
  }

  async function saveThenQuit() {
    setSaving(true)
    try {
      const res = await saveCurrentProject()
      if (res.ok) {
        unsavedTracker.markSaved()
        answer('discard')
        return
      }
      // Cancelled at the OS dialog, or the write failed. Either way the work is
      // still only in memory, so the app must stay open.
      if (res.reason === 'io-error') {
        toast.error(t('project.save.toastError', { error: res.message ?? '' }))
      }
      setSaving(false)
    } catch (err) {
      toast.error(t('project.save.toastError', { error: String(err) }))
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) answer('cancel') }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('quitConfirm.title')}</DialogTitle>
          <DialogDescription>{t('quitConfirm.desc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => answer('cancel')}>
            {t('quitConfirm.cancel')}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => answer('discard')}>
            {t('quitConfirm.discard')}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => { void saveThenQuit() }}>
            {saving ? t('quitConfirm.saving') : t('quitConfirm.saveAndQuit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

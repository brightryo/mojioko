import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useSettingsStore } from '@/stores/settings-store'
import { useTranslationToolStore } from '@/stores/translation-tool-store'
import { useProjectStore } from '@/stores/project-store'
import { translateBatchCues } from '@/services/translation-tool'
import {
  TRANSLATION_TARGET_LANGS,
  coerceTranslationTarget,
  isTranslatableText,
  normalizeSourceText,
} from '../../../shared/translation'

/**
 * REQ-0430 — bulk translate the selected cues into a target language and
 * overwrite each cue's text.
 *
 * Atomicity (the hard requirement): translations are COLLECTED first (nothing
 * is applied to the store), chunk by chunk with a progress modal.  Only after
 * the whole selection is translated does `onApply` write every cue's text in
 * ONE history op — so success commits as a single Undo, and Cancel (checked
 * between chunks, before any apply) leaves the project exactly as it was.
 *
 * `onApply(textById, label)` is the caller's atomic per-row text write (see
 * bulk-edit-bar's `applyTranslations`, mirroring `applyBulk`).
 */
const CHUNK_SIZE = 8

export function BulkTranslate({
  selectedRowIds,
  onApply,
}: {
  selectedRowIds: ReadonlySet<string>
  onApply: (textById: Map<string, string>, label: string) => void
}): JSX.Element {
  const { t } = useTranslation(['step2', 'settings'])

  // Default the dropdown to the Settings 翻訳言語; local after that.
  const settingsTarget = useSettingsStore((s) => s.translationTargetLang)
  const [target, setTarget] = useState<string>(coerceTranslationTarget(settingsTarget))

  // Gate: active when ≥1 tool downloaded AND an enabled tool exists.
  const hasDownloaded = useTranslationToolStore(
    (s) => s.state?.tools.some((tool) => tool.status === 'downloaded') ?? false,
  )
  const activeReady = useTranslationToolStore((s) => s.state?.activeId != null)
  const ready = hasDownloaded && activeReady

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const cancelRef = useRef(false)

  async function handleTranslate() {
    // Snapshot the translatable selected cues (id + normalized source) up front.
    const byId = new Map(useProjectStore.getState().entries.map((e) => [e.id, e]))
    const items: { id: string; source: string }[] = []
    for (const id of selectedRowIds) {
      const e = byId.get(id)
      if (!e || e.isDeleted) continue
      const source = normalizeSourceText(e.text)
      if (!isTranslatableText(source)) continue
      items.push({ id, source })
    }
    if (items.length === 0) {
      toast.info(t('bulk.translate.nothing'))
      return
    }

    setRunning(true)
    setProgress({ done: 0, total: items.length })
    cancelRef.current = false
    const resultById = new Map<string, string>()
    try {
      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        if (cancelRef.current) return // discard — nothing applied yet
        const chunk = items.slice(i, i + CHUNK_SIZE)
        const res = await translateBatchCues(chunk.map((it) => it.source), target)
        if (!res.ok) {
          toast.error(t('bulk.translate.failed'))
          return
        }
        chunk.forEach((it, j) => resultById.set(it.id, res.data.texts[j] ?? ''))
        setProgress({ done: Math.min(i + CHUNK_SIZE, items.length), total: items.length })
      }
      if (cancelRef.current) return // discard
      // All translations collected → apply as ONE undoable op.
      onApply(resultById, t('bulk.history.translate', { count: resultById.size }))
      toast.success(t('bulk.translate.done', { count: resultById.size }))
    } finally {
      setRunning(false)
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Select value={target} onValueChange={setTarget} disabled={!ready}>
          <SelectTrigger className="h-7 flex-1 text-body-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSLATION_TARGET_LANGS.map((code) => (
              <SelectItem key={code} value={code}>
                {t(`translation.lang_${code}`, { ns: 'settings' })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="secondary"
          size="md"
          disabled={!ready || selectedRowIds.size === 0}
          onClick={handleTranslate}
        >
          <Languages className="h-3.5 w-3.5 mr-1.5" />
          {t('bulk.translate.button')}
        </Button>
      </div>
      {!ready && (
        <p className="text-caption text-fg-muted">{t('bulk.translate.needTool')}</p>
      )}

      {/* Progress modal — background non-interactive; the ONLY way out is Cancel
          (onOpenChange is a no-op so Esc / backdrop cannot dismiss it). */}
      <Dialog open={running} onOpenChange={() => { /* non-dismissable */ }}>
        <DialogContent hideClose className="max-w-[360px]">
          <div className="space-y-4 py-1">
            <p className="text-body font-medium text-fg-primary">
              {t('bulk.translate.running')}
            </p>
            <div className="space-y-1.5">
              <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="text-body-sm text-fg-tertiary tabular-nums text-right">
                {t('bulk.translate.progress', { done: progress.done, total: progress.total })}
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                variant="danger"
                size="md"
                onClick={() => {
                  cancelRef.current = true
                }}
              >
                {t('bulk.translate.cancel')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

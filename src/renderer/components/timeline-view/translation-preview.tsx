import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translateCue } from '@/services/translation-tool'
import { useSettingsStore } from '@/stores/settings-store'
import { useTranslationToolStore } from '@/stores/translation-tool-store'
import { useTranslationLoadStore } from '@/stores/translation-load-store'
import {
  TRANSLATION_TARGET_LANGS,
  coerceTranslationTarget,
  isTranslatableText,
  normalizeSourceText,
  translationCacheKey,
  type TranslateErrorCode,
} from '../../../shared/translation'

/**
 * REQ-0410 / REQ-0426 / REQ-0427 — inspector translation section (① control +
 * result row) plus a result dialog (② copy / overwrite).
 *
 * ① Header: 「翻訳（{ms}ms）」 + an 自動翻訳 ON/OFF toggle button + a 翻訳言語
 *    select, all bound to the SAME settings-store values as the Settings 「翻訳」
 *    tab (single source).  Greyed/disabled until ≥1 translation tool is
 *    downloaded (REQ-0426 §4).  Below the header a SINGLE-LINE truncated result.
 *
 * ② The result row shows the full text on mouse-over (tooltip) and opens a
 *    dialog on click — 言語名 header + コピー / 上書き / ×, and a read-only,
 *    selectable full-text body.  コピー → clipboard; 上書き → writes the
 *    translation into the cue text via the existing history-aware edit path
 *    (`onOverwrite`), so it round-trips through Undo (§21 N/A — same user
 *    text-edit flow, not a new data model).
 *
 * The translation itself stays non-persistent until 上書き is pressed.
 */

const DEBOUNCE_MS = 300

interface CacheEntry {
  text: string
  totalMs: number
  cold: boolean
}

type ViewState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'result'; entry: CacheEntry; cached: boolean }
  | { status: 'error'; code: TranslateErrorCode; message: string }

export function TranslationPreview({
  sourceText,
  onOverwrite,
}: {
  sourceText: string
  /** Write `text` into the current cue via the inspector's history-aware path. */
  onOverwrite: (text: string) => void
}): JSX.Element {
  const { t } = useTranslation(['step2', 'settings'])
  const [view, setView] = useState<ViewState>({ status: 'empty' })
  const [dialogOpen, setDialogOpen] = useState(false)

  // ① single-source settings (shared with the Settings 「翻訳」 tab).
  const autoEnabled = useSettingsStore((s) => s.translationAutoEnabled)
  const setAutoEnabled = useSettingsStore((s) => s.setTranslationAutoEnabled)
  const targetLang = useSettingsStore((s) => s.translationTargetLang)
  const setTargetLang = useSettingsStore((s) => s.setTranslationTargetLang)

  // Gates: controls enable on ≥1 DOWNLOADED tool; preview translates only when
  // an ENABLED tool exists.
  const hasDownloaded = useTranslationToolStore(
    (s) => s.state?.tools.some((tool) => tool.status === 'downloaded') ?? false,
  )
  const activeReady = useTranslationToolStore((s) => s.state?.activeId != null)
  const loadState = useTranslationLoadStore((s) => s.loadState)

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const seqRef = useRef(0)

  useEffect(() => {
    if (!autoEnabled || !activeReady || loadState === 'loading') {
      setView({ status: 'empty' })
      return
    }
    const normalized = normalizeSourceText(sourceText)
    if (!isTranslatableText(normalized)) {
      setView({ status: 'empty' })
      return
    }

    const requestSeq = ++seqRef.current
    const target = coerceTranslationTarget(targetLang)
    const key = translationCacheKey(normalized, target)

    const cached = cacheRef.current.get(key)
    if (cached) {
      setView({ status: 'result', entry: cached, cached: true })
      return
    }

    setView({ status: 'loading' })
    const timer = setTimeout(() => {
      void translateCue(normalized, target).then((res) => {
        if (requestSeq !== seqRef.current) return
        if (res.ok) {
          const entry: CacheEntry = {
            text: res.data.text,
            totalMs: res.data.loadMs + res.data.translateMs,
            cold: res.data.loadMs > 0,
          }
          cacheRef.current.set(key, entry)
          setView({ status: 'result', entry, cached: false })
        } else {
          setView({ status: 'error', code: res.error.code as TranslateErrorCode, message: res.error.message })
        }
      })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [sourceText, autoEnabled, targetLang, activeReady, loadState])

  const resultText = view.status === 'result' ? view.entry.text : null
  const targetCode = coerceTranslationTarget(targetLang)
  const langLabel = t(`translation.lang_${targetCode}`, { ns: 'settings' })

  // Header label carries the processing time when a result is present.
  const headerLabel =
    view.status === 'result'
      ? t('timeline.inspector.translate.labelWithMs', { ms: view.entry.totalMs })
      : t('timeline.inspector.translate.label')

  async function handleCopy() {
    if (!resultText) return
    try {
      await navigator.clipboard.writeText(resultText)
      toast.success(t('timeline.inspector.translate.copied'))
    } catch {
      toast.error(t('timeline.inspector.translate.copyFailed'))
    }
  }

  function handleOverwrite() {
    if (!resultText) return
    onOverwrite(resultText)
    setDialogOpen(false)
    toast.success(t('timeline.inspector.translate.overwritten'))
  }

  return (
    <div className="space-y-1">
      {/* ① Header — label(+ms) · language · 自動翻訳 toggle button. */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-caption text-fg-tertiary">{headerLabel}</span>
        <div className={cn('flex items-center gap-1.5 flex-shrink-0', !hasDownloaded && 'opacity-50')}>
          <Select value={targetLang} onValueChange={setTargetLang} disabled={!hasDownloaded}>
            <SelectTrigger className="h-6 w-24 text-caption">
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
          {/* 自動翻訳 ON/OFF button — primary fill = ON. */}
          <button
            type="button"
            aria-pressed={autoEnabled}
            disabled={!hasDownloaded}
            onClick={() => setAutoEnabled(!autoEnabled)}
            className={cn(
              'h-6 px-2 rounded-md text-caption font-medium border transition-colors duration-150',
              autoEnabled
                ? 'bg-primary text-fg-inverse border-primary'
                : 'border-line text-fg-secondary hover:bg-surface-2',
              !hasDownloaded && 'cursor-not-allowed',
            )}
          >
            {autoEnabled
              ? t('timeline.inspector.translate.autoOn')
              : t('timeline.inspector.translate.autoOff')}
          </button>
        </div>
      </div>

      {/* Result row — only while 自動翻訳 is ON and there is something to show. */}
      {autoEnabled && (!activeReady || loadState === 'loading' || view.status !== 'empty') && (
        <div
          className={cn(
            'min-h-[1.75rem] rounded-md border px-2 py-1 text-body-sm leading-snug',
            !activeReady ? 'border-dashed bg-surface-2/30 opacity-70' : 'border-line bg-surface-1',
          )}
        >
          {!activeReady ? (
            <span className="text-fg-tertiary">
              {t('timeline.inspector.translate.toolNotReady')}
            </span>
          ) : loadState === 'loading' ? (
            <span className="flex items-center gap-1.5 text-fg-tertiary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('timeline.inspector.translate.preloading')}
            </span>
          ) : view.status === 'loading' ? (
            <span className="flex items-center gap-1.5 text-fg-tertiary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('timeline.inspector.translate.loading')}
            </span>
          ) : view.status === 'result' ? (
            // ② single-line result: full text on hover, dialog on click.
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className="block w-full truncate text-left text-fg-secondary hover:text-fg-primary transition-colors"
                >
                  {view.entry.text}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[320px] whitespace-pre-wrap text-left">
                {view.entry.text}
              </TooltipContent>
            </Tooltip>
          ) : view.status === 'error' && view.code === 'SIDECAR_DEPS_MISSING' ? (
            <div className="space-y-1">
              <span className="text-destructive">
                {t('timeline.inspector.translate.depsMissing')}
              </span>
              <code className="block whitespace-pre-wrap break-all text-caption text-fg-tertiary">
                {view.message}
              </code>
            </div>
          ) : view.status === 'error' ? (
            <span className="text-destructive">
              {t('timeline.inspector.translate.error')}
            </span>
          ) : null}
        </div>
      )}

      {/* ② Result dialog. */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-[520px]">
          <DialogHeader className="flex-row items-center justify-between gap-3 pr-8">
            <DialogTitle className="min-w-0 truncate">{langLabel}</DialogTitle>
            {/* コピー / 上書き — the × close is the DialogContent default. */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={handleCopy}>
                {t('timeline.inspector.translate.copy')}
              </Button>
              <Button variant="secondary" size="sm" onClick={handleOverwrite}>
                {t('timeline.inspector.translate.overwrite')}
              </Button>
            </div>
          </DialogHeader>
          {/* Read-only, drag-selectable full text. */}
          <div className="selectable whitespace-pre-wrap break-words rounded-md border border-line bg-surface-0 px-3 py-2 text-body text-fg-primary leading-relaxed max-h-[50vh] overflow-y-auto">
            {resultText}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

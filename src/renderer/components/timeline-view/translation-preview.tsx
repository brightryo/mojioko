import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
 * REQ-0410 / REQ-0426 — inspector translation section (① inline control +
 * ② preview).
 *
 * ① Inline control: an 自動翻訳 toggle + 翻訳言語 select bound to the SAME
 *    settings-store values as the Settings 「翻訳」 tab (single source — changing
 *    one moves the other).  Both are disabled (greyed) until at least one
 *    translation tool is DOWNLOADED (REQ-0426 §4).  Always rendered so the user
 *    can turn 自動翻訳 on/off from the inspector.
 *
 * ② Preview: when 自動翻訳 is ON and an enabled tool exists, translates the cue
 *    into the target language on selection and shows the result + timing.  While
 *    the model is warming up (preload after enabling) it shows 「ロード処理中」.
 *    Non-blocking, debounced, latest-wins, cached by (text, target).  NEVER
 *    persisted / written to `SubtitleEntry` (§21 N/A).
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

export function TranslationPreview({ sourceText }: { sourceText: string }): JSX.Element {
  const { t } = useTranslation(['step2', 'settings'])
  const [view, setView] = useState<ViewState>({ status: 'empty' })

  // ① single-source settings (shared with the Settings 「翻訳」 tab).
  const autoEnabled = useSettingsStore((s) => s.translationAutoEnabled)
  const setAutoEnabled = useSettingsStore((s) => s.setTranslationAutoEnabled)
  const targetLang = useSettingsStore((s) => s.translationTargetLang)
  const setTargetLang = useSettingsStore((s) => s.setTranslationTargetLang)

  // Gates (REQ-0426 §4): controls enable on ≥1 DOWNLOADED tool; the preview
  // translates only when an ENABLED tool exists.
  const hasDownloaded = useTranslationToolStore(
    (s) => s.state?.tools.some((tool) => tool.status === 'downloaded') ?? false,
  )
  const activeReady = useTranslationToolStore((s) => s.state?.activeId != null)
  const loadState = useTranslationLoadStore((s) => s.loadState)

  // Cache + latest-wins sequence survive re-renders without re-triggering effects.
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const seqRef = useRef(0)

  useEffect(() => {
    // No translate while off, without an enabled tool, or while the model is
    // still warming up (the body shows 「ロード処理中」 in that window).
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
          const code = res.error.code as TranslateErrorCode
          setView({ status: 'error', code, message: res.error.message })
        }
      })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [sourceText, autoEnabled, targetLang, activeReady, loadState])

  const timingLabel = (entry: CacheEntry, wasCached: boolean): string => {
    if (wasCached) return t('timeline.inspector.translate.cached')
    return entry.cold
      ? t('timeline.inspector.translate.coldTime', { ms: entry.totalMs })
      : t('timeline.inspector.translate.warmTime', { ms: entry.totalMs })
  }

  return (
    <div className="space-y-1.5">
      {/* ① Inline control — single source with the Settings 「翻訳」 tab. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-fg-tertiary">
          {t('timeline.inspector.translate.label')}
        </span>
        <div className={cn('flex items-center gap-2', !hasDownloaded && 'opacity-50')}>
          <Select value={targetLang} onValueChange={setTargetLang} disabled={!hasDownloaded}>
            <SelectTrigger className="h-6 w-28 text-caption">
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
          <Switch
            checked={autoEnabled}
            onCheckedChange={setAutoEnabled}
            disabled={!hasDownloaded}
            aria-label={t('translation.autoTranslate', { ns: 'settings' })}
          />
        </div>
      </div>

      {/* ② Preview — only while 自動翻訳 is ON and there is something to show
          (guidance / loading / result / error).  An empty (non-translatable)
          cue renders no box. */}
      {autoEnabled && (!activeReady || loadState === 'loading' || view.status !== 'empty') && (
        <div
          className={cn(
            'min-h-[2rem] rounded-md border px-2 py-1.5 text-body leading-snug',
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
            <div className="flex flex-col gap-0.5">
              <span className="text-fg-secondary">{view.entry.text}</span>
              <span className="self-end text-caption tabular-nums text-fg-tertiary">
                {timingLabel(view.entry, view.cached)}
              </span>
            </div>
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
    </div>
  )
}

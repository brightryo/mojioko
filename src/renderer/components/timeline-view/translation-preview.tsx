import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translateCue } from '@/services/translation-tool'
import {
  isTranslatableText,
  normalizeSourceText,
  translationCacheKey,
  type TranslateErrorCode,
} from '../../../shared/translation'

/**
 * REQ-0410 — inspector auto-translate preview (prototype).
 *
 * On single-cue selection (i.e. whenever `sourceText` changes) this fires an
 * async English translation via the resident MADLAD sidecar and shows the
 * result in a throwaway field below the subtitle textarea.  It is:
 *   - non-blocking (async; the inspector never freezes),
 *   - non-persisted (result is never written to `SubtitleEntry`; §21 N/A),
 *   - debounced with latest-wins cancellation (rapid cue switching only
 *     translates the newest text), and
 *   - cached by (text, en) so a repeat shows instantly, labelled "cached".
 *
 * Timing is surfaced so the owner can read cold (model-load-included) vs warm
 * inference cost directly off the UI — that on-device reading is the point of
 * the prototype.
 */

const DEBOUNCE_MS = 300

interface CacheEntry {
  text: string
  /** Wall time of the request that produced this (cold includes model load). */
  totalMs: number
  /** True when the sidecar loaded the model on this request (loadMs > 0). */
  cold: boolean
}

type ViewState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'result'; entry: CacheEntry; cached: boolean }
  | { status: 'error'; code: TranslateErrorCode; message: string }

export function TranslationPreview({ sourceText }: { sourceText: string }): JSX.Element | null {
  const { t } = useTranslation(['step2'])
  const [view, setView] = useState<ViewState>({ status: 'empty' })

  // Cache + latest-wins sequence survive re-renders without re-triggering effects.
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const seqRef = useRef(0)

  useEffect(() => {
    const normalized = normalizeSourceText(sourceText)
    if (!isTranslatableText(normalized)) {
      setView({ status: 'empty' })
      return
    }

    const requestSeq = ++seqRef.current
    const key = translationCacheKey(normalized)

    // Cache hit → show instantly, no sidecar round-trip.
    const cached = cacheRef.current.get(key)
    if (cached) {
      setView({ status: 'result', entry: cached, cached: true })
      return
    }

    setView({ status: 'loading' })
    const timer = setTimeout(() => {
      void translateCue(normalized).then((res) => {
        // Latest-wins: drop the result if a newer request has since started.
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
  }, [sourceText])

  const timingLabel = (entry: CacheEntry, wasCached: boolean): string => {
    if (wasCached) return t('timeline.inspector.translate.cached')
    return entry.cold
      ? t('timeline.inspector.translate.coldTime', { ms: entry.totalMs })
      : t('timeline.inspector.translate.warmTime', { ms: entry.totalMs })
  }

  if (view.status === 'empty') return null

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-tertiary">
          {t('timeline.inspector.translate.label')}
        </span>
        {view.status === 'result' && (
          <span className="text-caption tabular-nums text-fg-tertiary">
            {timingLabel(view.entry, view.cached)}
          </span>
        )}
      </div>
      <div
        className={cn(
          'min-h-[2rem] rounded-md border border-line bg-surface-1 px-2 py-1.5',
          'text-body leading-snug',
        )}
      >
        {view.status === 'loading' && (
          <span className="flex items-center gap-1.5 text-fg-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t('timeline.inspector.translate.loading')}
          </span>
        )}
        {view.status === 'result' && (
          <span className="text-fg-secondary">{view.entry.text}</span>
        )}
        {view.status === 'error' && view.code === 'NO_ACTIVE_TOOL' && (
          <span className="text-destructive">
            {t('timeline.inspector.translate.noActiveTool')}
          </span>
        )}
        {view.status === 'error' && view.code === 'SIDECAR_DEPS_MISSING' && (
          <div className="space-y-1">
            <span className="text-destructive">
              {t('timeline.inspector.translate.depsMissing')}
            </span>
            {/* The concrete `python -m pip install …` command from main. */}
            <code className="block whitespace-pre-wrap break-all text-caption text-fg-tertiary">
              {view.message}
            </code>
          </div>
        )}
        {view.status === 'error' &&
          view.code !== 'NO_ACTIVE_TOOL' &&
          view.code !== 'SIDECAR_DEPS_MISSING' && (
            <span className="text-destructive">
              {t('timeline.inspector.translate.error')}
            </span>
          )}
      </div>
    </div>
  )
}

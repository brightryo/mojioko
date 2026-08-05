/**
 * REQ-0420 — token overlay + click-to-reassign inspector (DEV ONLY).
 *
 * Rendered by DevTokenEditor when the "Token overlay" toggle is on (which is
 * itself behind import.meta.env.DEV, so this never ships). Draws a colour-coded
 * box + label on every element that carries a type-scale token class
 * (`text-micro`…`text-display`), so the whole screen's token assignment is
 * visible without screenshots. Clicking a box opens a dropdown to reassign the
 * token live; the set of changes is exportable for baking into code.
 *
 * The overlay root is `pointer-events: none` so the app underneath still
 * scrolls; only the individual boxes and the toolbar capture clicks.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Copy, RefreshCw } from 'lucide-react'
import {
  TYPE_SCALE_TOKENS,
  TOKEN_OVERLAY_COLORS,
  detectSizeToken,
  serializeReassignments,
  type TypeScaleToken,
  type TokenReassignment,
} from '@/lib/dev-tokens'

const SIZE_SELECTOR = TYPE_SCALE_TOKENS.map((t) => `.text-${t}`).join(', ')

interface Item {
  el: HTMLElement
  token: TypeScaleToken
}

/** Internal change record — keeps the element identity for de-dup + net-noop. */
interface Change extends TokenReassignment {
  el: HTMLElement
}

/** Short DOM path (up to 3 ancestors) as a locator hint for the export. */
function describePath(el: HTMLElement): string {
  const parts: string[] = []
  let cur: HTMLElement | null = el
  for (let i = 0; i < 3 && cur; i++) {
    const tag = cur.tagName.toLowerCase()
    const cls = Array.from(cur.classList).find(
      (c) => !c.startsWith('text-') && !c.startsWith('bg-') && !c.startsWith('font-'),
    )
    parts.unshift(tag + (cls ? `.${cls}` : ''))
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

export function TokenOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [, setTick] = useState(0) // bump to recompute rects on scroll/resize
  const [selected, setSelected] = useState<number | null>(null)
  const [changes, setChanges] = useState<Change[]>([])
  const [exportOpen, setExportOpen] = useState(false)

  const scan = useCallback(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(SIZE_SELECTOR))
    const found: Item[] = []
    for (const el of nodes) {
      if (el.closest('[data-dev-overlay], [data-dev-panel]')) continue
      const token = detectSizeToken(Array.from(el.classList))
      if (!token) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      found.push({ el, token })
    }
    setItems(found)
    setSelected(null)
  }, [])

  useEffect(() => {
    scan()
    let raf = 0
    const onMove = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setTick((t) => t + 1))
    }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      cancelAnimationFrame(raf)
    }
  }, [scan])

  const reassign = useCallback(
    (index: number, to: TypeScaleToken) => {
      setSelected(null)
      setItems((prev) => {
        const it = prev[index]
        if (!it || it.token === to) return prev
        const fromNow = it.token
        it.el.classList.remove(`text-${fromNow}`)
        it.el.classList.add(`text-${to}`)
        setChanges((cs) => {
          const existing = cs.find((c) => c.el === it.el)
          const origFrom = existing ? existing.from : fromNow
          const rest = cs.filter((c) => c.el !== it.el)
          if (origFrom === to) return rest // reverted to original → drop
          return [
            ...rest,
            {
              el: it.el,
              from: origFrom,
              to,
              text: (it.el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50),
              path: describePath(it.el),
            },
          ]
        })
        const next = prev.slice()
        next[index] = { el: it.el, token: to }
        return next
      })
    },
    [],
  )

  const exportText = useMemo(
    () => serializeReassignments(changes.map(({ el: _el, ...c }) => c)),
    [changes],
  )
  const copyExport = useCallback(() => {
    void navigator.clipboard?.writeText(exportText).catch(() => {})
  }, [exportText])

  return (
    <div
      data-dev-overlay=""
      className="pointer-events-none fixed inset-0 z-[9998]"
      aria-hidden="true"
    >
      {/* Per-element boxes + labels */}
      {items.map((it, i) => {
        const r = it.el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return null
        const color = TOKEN_OVERLAY_COLORS[it.token]
        return (
          <div key={i}>
            <button
              type="button"
              onClick={() => setSelected(selected === i ? null : i)}
              className="pointer-events-auto absolute"
              style={{
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                border: `1px solid ${color}`,
                background: `${color}14`,
                cursor: 'pointer',
              }}
              title={`text-${it.token} — click to reassign`}
            />
            <span
              className="pointer-events-none absolute font-mono"
              style={{
                left: r.left,
                top: Math.max(0, r.top - 12),
                fontSize: '9px',
                lineHeight: '12px',
                padding: '0 3px',
                color: '#fff',
                background: color,
                borderRadius: '2px',
                whiteSpace: 'nowrap',
              }}
            >
              {it.token}
            </span>
            {/* Inspector dropdown */}
            {selected === i && (
              <div
                className="pointer-events-auto absolute flex flex-col gap-0.5 rounded-md border border-line bg-surface-1 p-1 shadow-2xl shadow-black/60"
                style={{ left: r.left, top: r.top + r.height + 2, zIndex: 1 }}
              >
                {TYPE_SCALE_TOKENS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => reassign(i, t)}
                    className="flex items-center gap-1.5 rounded px-2 py-0.5 text-left text-caption text-fg-secondary hover:bg-surface-2"
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: TOKEN_OVERLAY_COLORS[t] }}
                    />
                    text-{t}
                    {t === it.token && <span className="ml-auto text-fg-muted">current</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Toolbar */}
      <div
        data-dev-panel=""
        className="pointer-events-auto fixed left-1/2 top-2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line-strong bg-surface-1 px-3 py-1.5 shadow-2xl shadow-black/60"
      >
        <span className="text-caption font-semibold text-fg-primary">Token overlay</span>
        <span className="text-caption text-fg-tertiary">{items.length} elements</span>
        <span className="text-caption text-fg-tertiary">·</span>
        <span className="text-caption text-fg-tertiary">{changes.length} changed</span>
        <button
          type="button"
          onClick={scan}
          className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-fg-secondary hover:bg-surface-2"
          title="Rescan"
        >
          <RefreshCw className="h-3 w-3" /> Rescan
        </button>
        <button
          type="button"
          onClick={() => setExportOpen((o) => !o)}
          className="rounded bg-primary px-2 py-0.5 text-caption font-medium text-fg-inverse hover:bg-primary-hover"
        >
          {exportOpen ? 'Hide' : 'Export'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary"
          title="Close overlay"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Legend */}
      <div
        data-dev-panel=""
        className="pointer-events-none fixed left-2 top-2 flex flex-col gap-0.5 rounded-md border border-line bg-surface-1/90 p-1.5"
      >
        {TYPE_SCALE_TOKENS.map((t) => (
          <span key={t} className="flex items-center gap-1.5 text-caption text-fg-secondary">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: TOKEN_OVERLAY_COLORS[t] }}
            />
            {t}
          </span>
        ))}
      </div>

      {/* Export panel */}
      {exportOpen && (
        <div
          data-dev-panel=""
          className="pointer-events-auto fixed bottom-2 left-1/2 flex w-[520px] max-w-[90vw] -translate-x-1/2 flex-col gap-1 rounded-lg border border-line-strong bg-surface-1 p-2 shadow-2xl shadow-black/60"
        >
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-tertiary">Reassignments ({changes.length})</span>
            <button
              type="button"
              onClick={copyExport}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-fg-secondary hover:bg-surface-2"
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <textarea
            readOnly
            value={exportText}
            spellCheck={false}
            className="selectable h-40 w-full resize-none rounded border border-line bg-surface-0 p-2 font-mono text-caption text-fg-secondary"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </div>
  )
}

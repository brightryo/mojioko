/**
 * REQ-0414 — developer live-token editor (DEV ONLY).
 *
 * A hidden, developer-only panel for tuning the design tokens live and
 * exporting the result back into globals.css / tailwind.config.ts.  It is
 * mounted behind `import.meta.env.DEV` (see App.tsx), so it is tree-shaken
 * out of `electron-vite build` (end-user) bundles entirely.
 *
 * Open / close with  Ctrl+Shift+D.  Esc also closes it.
 *
 * Controls are auto-generated from `DEV_TOKEN_GROUPS`; colour-group membership
 * is reconciled at open time against the variables actually declared on
 * `:root`, so newly-added tokens appear without editing this file.  Font
 * family is fixed (Noto Sans JP) and shown read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Copy, RotateCcw } from 'lucide-react'
import { useRadixModalIsolation } from './use-radix-isolation'
import {
  DEV_TOKEN_GROUPS,
  EDITED_ALPHA_VARS,
  FIXED_FONT_FAMILY,
  discoverRootVarNames,
  driftFor,
  hexToHslTriplet,
  orderedColorMembers,
  serializeEditedState,
  serializeGlobalsCss,
  serializeTailwindFontSize,
  type TokenSnapshot,
} from '@/lib/dev-tokens'
import {
  applyAlpha,
  applyColorHex,
  applySize,
  readAlpha,
  readAlphaRaw,
  readColorHex,
  readColorTriplet,
  readSize,
  resetAll,
  resetAlpha,
  resetColor,
  resetSize,
} from '@/lib/dev-token-live'
import { TokenOverlay } from './token-overlay'

const SIZE_MIN_PX = 6
const SIZE_MAX_PX = 48

interface ResolvedGroup {
  id: string
  title: string
  kind: 'color' | 'size' | 'alpha'
  /** color var names, type-scale names, or alpha var names. */
  members: string[]
  /** alpha groups only: var name → human label. */
  labels?: Record<string, string>
}

export function DevTokenEditor(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  // REQ-0420 — token overlay (independent of the panel; toggled from it).
  const [overlayOn, setOverlayOn] = useState(false)

  // Ctrl+Shift+D toggles; Esc closes.  Capture phase so it beats the app's
  // global shortcut handler and the Tab/Esc suppressors.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        e.stopPropagation()
        setOpen((o) => !o)
      } else if (e.key === 'Escape' && overlayOn) {
        setOverlayOn(false)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, overlayOn])

  if (!open && !overlayOn) return null
  return (
    <>
      {open && (
        <DevTokenPanel
          onClose={() => setOpen(false)}
          overlayOn={overlayOn}
          onToggleOverlay={() => setOverlayOn((o) => !o)}
        />
      )}
      {overlayOn && <TokenOverlay onClose={() => setOverlayOn(false)} />}
    </>
  )
}

function DevTokenPanel({
  onClose,
  overlayOn,
  onToggleOverlay,
}: {
  onClose: () => void
  overlayOn: boolean
  onToggleOverlay: () => void
}): JSX.Element {
  // Resolve group membership once per open (reconcile registry vs live :root).
  const groups = useMemo<ResolvedGroup[]>(() => {
    const rootVars = discoverRootVarNames()
    return DEV_TOKEN_GROUPS.map((g) => {
      if (g.kind === 'size') {
        return { id: g.id, title: g.title, kind: 'size' as const, members: g.sizes ?? [] }
      }
      if (g.kind === 'alpha') {
        return {
          id: g.id,
          title: g.title,
          kind: 'alpha' as const,
          members: (g.alphas ?? []).map((a) => a.name),
          labels: Object.fromEntries((g.alphas ?? []).map((a) => [a.name, a.label])),
        }
      }
      const drift = driftFor(g, rootVars)
      if (drift.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[dev-token-editor] "${g.id}" registry drift — appended:`, drift)
      }
      return {
        id: g.id,
        title: g.title,
        kind: 'color' as const,
        members: orderedColorMembers(g, rootVars),
      }
    })
  }, [])

  const colorNames = useMemo(
    () => groups.filter((g) => g.kind === 'color').flatMap((g) => g.members),
    [groups],
  )
  const sizeNames = useMemo(
    () => groups.filter((g) => g.kind === 'size').flatMap((g) => g.members),
    [groups],
  )
  const alphaNames = useMemo(
    () => groups.filter((g) => g.kind === 'alpha').flatMap((g) => g.members),
    [groups],
  )

  // Live-read seed.  `version` bumps force a re-read after reset-all.
  const [version, setVersion] = useState(0)
  const initial = useMemo(() => {
    const colorHex: Record<string, string> = {}
    for (const n of colorNames) colorHex[n] = readColorHex(n)
    const size: Record<string, { px: number; lineHeight: string }> = {}
    for (const n of sizeNames) size[n] = readSize(n)
    const alpha: Record<string, number> = {}
    for (const n of alphaNames) alpha[n] = readAlpha(n)
    return { colorHex, size, alpha }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorNames, sizeNames, alphaNames, version])

  const [colorHex, setColorHex] = useState<Record<string, string>>(initial.colorHex)
  const [sizePx, setSizePx] = useState<Record<string, number>>(
    Object.fromEntries(Object.entries(initial.size).map(([k, v]) => [k, v.px])),
  )
  const [alpha, setAlpha] = useState<Record<string, number>>(initial.alpha)
  // Re-sync local state whenever the seed changes (reset-all).
  useEffect(() => {
    setColorHex(initial.colorHex)
    setSizePx(Object.fromEntries(Object.entries(initial.size).map(([k, v]) => [k, v.px])))
    setAlpha(initial.alpha)
  }, [initial])

  const onColorChange = useCallback((name: string, hex: string) => {
    applyColorHex(name, hex)
    setColorHex((s) => ({ ...s, [name]: hex }))
  }, [])

  const onColorReset = useCallback((name: string) => {
    resetColor(name)
    setColorHex((s) => ({ ...s, [name]: readColorHex(name) }))
  }, [])

  const onSizeChange = useCallback((name: string, px: number) => {
    applySize(name, px)
    setSizePx((s) => ({ ...s, [name]: px }))
  }, [])

  const onSizeReset = useCallback((name: string) => {
    resetSize(name)
    setSizePx((s) => ({ ...s, [name]: readSize(name).px }))
  }, [])

  const onAlphaChange = useCallback((name: string, value: number) => {
    applyAlpha(name, value)
    setAlpha((s) => ({ ...s, [name]: value }))
  }, [])

  const onAlphaReset = useCallback((name: string) => {
    resetAlpha(name)
    setAlpha((s) => ({ ...s, [name]: readAlpha(name) }))
  }, [])

  const onResetAll = useCallback(() => {
    resetAll(colorNames, sizeNames, alphaNames)
    setVersion((v) => v + 1)
  }, [colorNames, sizeNames, alphaNames])

  const [exportOpen, setExportOpen] = useState(false)
  const snapshot = useMemo<TokenSnapshot>(() => {
    const colors: Record<string, string> = {}
    for (const n of colorNames) colors[n] = readColorTriplet(n)
    const sizes: Record<string, { px: number; lineHeight: string }> = {}
    for (const n of sizeNames) sizes[n] = readSize(n)
    return { colors, sizes }
    // colorHex / sizePx / exportOpen are recompute TRIGGERS: the body re-reads
    // the live DOM, so the snapshot must refresh after each edit and when the
    // export panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorNames, sizeNames, colorHex, sizePx, exportOpen])

  const globalsBlock = useMemo(() => serializeGlobalsCss(snapshot), [snapshot])
  const tailwindBlock = useMemo(() => serializeTailwindFontSize(snapshot), [snapshot])
  // REQ-0526 — the edited-state decision, as one paste-able chunk.  Read live
  // from the DOM like the others, so it always reflects the current knobs.
  const editedBlock = useMemo(
    () =>
      serializeEditedState({
        triplet: readColorTriplet('row-edited'),
        hex: readColorHex('row-edited'),
        alphas: Object.fromEntries(EDITED_ALPHA_VARS.map((n) => [n, readAlphaRaw(n)])),
      }),
    // Same recompute-trigger pattern as `snapshot` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colorHex, alpha, exportOpen],
  )

  // REQ-0421 — stay operable when a Radix modal (Sheet/drawer) is open.
  const rootRef = useRef<HTMLDivElement>(null)
  useRadixModalIsolation(rootRef)

  return (
    <div
      ref={rootRef}
      data-dev-panel=""
      className="pointer-events-auto fixed right-0 top-0 z-[9999] flex h-full w-[340px] flex-col border-l border-line-strong bg-surface-1 text-fg-primary shadow-2xl shadow-black/50"
      role="dialog"
      aria-label="Developer token editor"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex flex-col">
          <span className="text-body-sm font-semibold">Dev Token Editor</span>
          <span className="text-caption text-fg-tertiary">Ctrl+Shift+D · live · not shipped</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* REQ-0420 — token overlay toggle */}
        <section className="mb-4">
          <button
            type="button"
            onClick={onToggleOverlay}
            className={
              'w-full rounded-md border px-3 py-2 text-body-sm font-medium transition-colors ' +
              (overlayOn
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-line bg-surface-0 text-fg-secondary hover:bg-surface-2')
            }
          >
            {overlayOn ? 'Hide token overlay' : 'Show token overlay'}
          </button>
          <p className="mt-1 text-caption text-fg-tertiary">
            Colour-codes every element by its type token; click a box to reassign.
          </p>
        </section>

        {/* Font family (read-only) */}
        <section className="mb-4">
          <h3 className="mb-2 text-caption font-medium uppercase text-fg-tertiary">Font family</h3>
          <div className="flex items-center justify-between rounded-md border border-line bg-surface-0 px-3 py-2">
            <span className="text-body-sm" style={{ fontFamily: FIXED_FONT_FAMILY }}>
              {FIXED_FONT_FAMILY}
            </span>
            <span className="text-caption text-fg-muted">fixed</span>
          </div>
        </section>

        {groups.map((g) => (
          <section key={g.id} className="mb-4">
            <h3 className="mb-2 text-caption font-medium uppercase text-fg-tertiary">{g.title}</h3>
            <div className="flex flex-col gap-1.5">
              {g.kind === 'color' &&
                g.members.map((name) => (
                  <ColorRow
                    key={name}
                    name={name}
                    hex={colorHex[name] ?? '#000000'}
                    onChange={onColorChange}
                    onReset={onColorReset}
                  />
                ))}
              {g.kind === 'size' &&
                g.members.map((name) => (
                  <SizeRow
                    key={name}
                    name={name}
                    px={sizePx[name] ?? 0}
                    onChange={onSizeChange}
                    onReset={onSizeReset}
                  />
                ))}
              {g.kind === 'alpha' &&
                g.members.map((name) => (
                  <AlphaRow
                    key={name}
                    name={name}
                    label={g.labels?.[name] ?? name}
                    value={alpha[name] ?? 1}
                    onChange={onAlphaChange}
                    onReset={onAlphaReset}
                  />
                ))}
            </div>
          </section>
        ))}
      </div>

      {/* Footer — export */}
      <div className="border-t border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExportOpen((o) => !o)}
            className="flex-1 rounded-md bg-primary px-3 py-1.5 text-body-sm font-medium text-fg-inverse hover:bg-primary-hover"
          >
            {exportOpen ? 'Hide export' : 'Export tokens'}
          </button>
          <button
            type="button"
            onClick={onResetAll}
            className="flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-body-sm text-fg-secondary hover:bg-surface-2"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset all
          </button>
        </div>

        {exportOpen && (
          <div className="mt-3 flex max-h-[40vh] flex-col gap-3 overflow-y-auto">
            {/* REQ-0526 first — it is the one most likely to be wanted, and
                it is small enough to read without scrolling. */}
            <ExportBlock title="edited state  →  paste into the REQ" body={editedBlock} />
            <ExportBlock title="globals.css  (:root)" body={globalsBlock} />
            <ExportBlock title="tailwind.config.ts  (fontSize)" body={tailwindBlock} />
          </div>
        )}
      </div>
    </div>
  )
}

function ColorRow({
  name,
  hex,
  onChange,
  onReset,
}: {
  name: string
  hex: string
  onChange: (name: string, hex: string) => void
  onReset: (name: string) => void
}): JSX.Element {
  const triplet = hexToHslTriplet(hex)
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(name, e.target.value)}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0"
        aria-label={`--${name}`}
      />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-caption text-fg-secondary">--{name}</span>
        <span className="truncate text-micro text-fg-muted">{triplet ?? hex}</span>
      </div>
      <button
        type="button"
        onClick={() => onReset(name)}
        className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg-secondary"
        aria-label={`Reset --${name}`}
        title="Reset"
      >
        <RotateCcw className="h-3 w-3" />
      </button>
    </div>
  )
}

function SizeRow({
  name,
  px,
  onChange,
  onReset,
}: {
  name: string
  px: number
  onChange: (name: string, px: number) => void
  onReset: (name: string) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="flex w-20 shrink-0 flex-col leading-tight">
        <span className="truncate text-caption text-fg-secondary">{name}</span>
        <span className="text-micro text-fg-muted">text-{name}</span>
      </div>
      <input
        type="range"
        min={SIZE_MIN_PX}
        max={SIZE_MAX_PX}
        step={1}
        value={px}
        onChange={(e) => onChange(name, Number(e.target.value))}
        className="min-w-0 flex-1 accent-[hsl(var(--primary))]"
        aria-label={`${name} size`}
      />
      <input
        type="number"
        min={SIZE_MIN_PX}
        max={SIZE_MAX_PX}
        value={px}
        onChange={(e) => onChange(name, Number(e.target.value))}
        className="w-12 shrink-0 rounded border border-line bg-surface-0 px-1 py-0.5 text-caption text-fg-primary"
        aria-label={`${name} size px`}
      />
      <button
        type="button"
        onClick={() => onReset(name)}
        className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg-secondary"
        aria-label={`Reset ${name}`}
        title="Reset"
      >
        <RotateCcw className="h-3 w-3" />
      </button>
    </div>
  )
}

/**
 * REQ-0526 — a 0–1 weight.  Slider for feel, number box for a value you can
 * state exactly; 0.01 steps because the differences that matter here are
 * visible well below 0.05.
 */
function AlphaRow({
  name,
  label,
  value,
  onChange,
  onReset,
}: {
  name: string
  label: string
  value: number
  onChange: (name: string, value: number) => void
  onReset: (name: string) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="flex w-24 shrink-0 flex-col leading-tight">
        <span className="truncate text-caption text-fg-secondary">{label}</span>
        <span className="truncate text-micro text-fg-muted">--{name}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(name, Number(e.target.value))}
        className="min-w-0 flex-1 accent-[hsl(var(--primary))]"
        aria-label={`${label} alpha`}
      />
      <input
        type="number"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(name, Number(e.target.value))}
        className="w-14 shrink-0 rounded border border-line bg-surface-0 px-1 py-0.5 text-caption text-fg-primary"
        aria-label={`${label} alpha value`}
      />
      <button
        type="button"
        onClick={() => onReset(name)}
        className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg-secondary"
        aria-label={`Reset --${name}`}
        title="Reset"
      >
        <RotateCcw className="h-3 w-3" />
      </button>
    </div>
  )
}

function ExportBlock({ title, body }: { title: string; body: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(body).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }, [body])
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-tertiary">{title}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-micro text-fg-secondary hover:bg-surface-2"
        >
          <Copy className="h-3 w-3" /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        readOnly
        value={body}
        spellCheck={false}
        className="selectable h-32 w-full resize-none rounded border border-line bg-surface-0 p-2 font-mono text-micro text-fg-secondary"
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  )
}

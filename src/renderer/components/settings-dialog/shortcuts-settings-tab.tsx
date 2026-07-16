import { useTranslation } from 'react-i18next'
import { SHORTCUTS } from '@/lib/shortcuts'

/**
 * REQ-0131 §5 / REQ-0132 §4.2 — read-only "keyboard shortcuts" tab in
 * the Settings dialog.  Renders the shared `SHORTCUTS` registry so
 * this UI can never drift from the hook that actually fires the
 * bindings.  Three `<dl>` groups — Editor (context B), Timeline
 * (context B'), Overlay (context A) — mirror the `context` field of
 * each ShortcutSpec.  Context C (typing in a form field) has no
 * shortcuts by design, so it isn't shown.
 *
 * REQ-0132 §4.2 also reworked the group labels so the "modal" group is
 * described as "dialogs / drawers" — the previous "モーダル" wording
 * was jargon the owner flagged as confusing.
 */
export function ShortcutsSettingsTab() {
  const { t } = useTranslation(['settings', 'common'])
  const editor = SHORTCUTS.filter((s) => s.context === 'editor')
  const timeline = SHORTCUTS.filter((s) => s.context === 'timeline')
  const overlay = SHORTCUTS.filter((s) => s.context === 'modal')

  return (
    <div className="space-y-4">
      <p className="text-body-sm text-fg-muted">{t('settings:shortcuts.hint')}</p>

      <section className="space-y-2">
        <h3 className="text-body font-semibold text-fg-primary">
          {t('settings:shortcuts.groupEditor')}
        </h3>
        <p className="text-body-sm text-fg-muted">
          {t('settings:shortcuts.groupEditorDesc')}
        </p>
        <dl className="divide-y divide-line rounded-md border border-line bg-surface-0">
          {editor.map((s) => (
            <ShortcutRow
              key={s.id}
              label={t(`common:${s.labelKey}`)}
              keys={s.keys}
            />
          ))}
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-body font-semibold text-fg-primary">
          {t('settings:shortcuts.groupTimeline')}
        </h3>
        <p className="text-body-sm text-fg-muted">
          {t('settings:shortcuts.groupTimelineDesc')}
        </p>
        <dl className="divide-y divide-line rounded-md border border-line bg-surface-0">
          {timeline.map((s) => (
            <ShortcutRow
              key={s.id}
              label={t(`common:${s.labelKey}`)}
              keys={s.keys}
            />
          ))}
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-body font-semibold text-fg-primary">
          {t('settings:shortcuts.groupOverlay')}
        </h3>
        <p className="text-body-sm text-fg-muted">
          {t('settings:shortcuts.groupOverlayDesc')}
        </p>
        <dl className="divide-y divide-line rounded-md border border-line bg-surface-0">
          {overlay.map((s) => (
            <ShortcutRow
              key={s.id}
              label={t(`common:${s.labelKey}`)}
              keys={s.keys}
            />
          ))}
        </dl>
      </section>
    </div>
  )
}

interface ShortcutRowProps {
  label: string
  keys: string[]
}

/**
 * One <dt>/<dd> row.  `keys` renders each string as a chip; multiple
 * chips (e.g. Ctrl+Shift+Z / Ctrl+Y for Redo) sit side-by-side with a
 * comma between them for screen readers.
 */
function ShortcutRow({ label, keys }: ShortcutRowProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <dt className="text-body text-fg-secondary">{label}</dt>
      <dd className="flex items-center gap-1.5" aria-label={keys.join(', ')}>
        {keys.map((k, i) => (
          <span
            key={`${k}-${i}`}
            className="rounded border border-line-strong bg-surface-1 px-2 py-0.5 font-mono text-body-sm text-fg-primary"
          >
            {k}
          </span>
        ))}
      </dd>
    </div>
  )
}

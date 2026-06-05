import { useTranslation } from 'react-i18next'
import { useUiStore } from '@/stores/ui-store'
import { SHORTCUTS, type ShortcutScope } from '@/lib/shortcuts'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

const SCOPE_LABEL: Record<ShortcutScope, string> = {
  global: 'shortcuts.scopeGlobal',
  step1: 'shortcuts.scopeStep1',
  step2: 'shortcuts.scopeStep2',
  step3: 'shortcuts.scopeStep3'
}

const SCOPE_ORDER: ShortcutScope[] = ['global', 'step1', 'step2', 'step3']

export function ShortcutsDialog() {
  const { t } = useTranslation(['common', 'commands'])
  const isOpen = useUiStore((s) => s.isShortcutsDialogOpen)
  const setOpen = useUiStore((s) => s.setShortcutsDialogOpen)

  const grouped = SCOPE_ORDER.map((scope) => ({
    scope,
    label: t(SCOPE_LABEL[scope]),
    items: SHORTCUTS.filter((s) => s.scope === scope)
  })).filter((g) => g.items.length > 0)

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('common:menu.keyboardShortcuts')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          {grouped.map(({ scope, label, items }) => (
            <div key={scope}>
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-2">{label}</p>
              <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800">
                {items.map((s) => (
                  <div key={s.id} className="flex items-center justify-between px-3 py-2">
                    <span className="text-body text-zinc-300">{t(`commands:${s.descriptionKey}`)}</span>
                    <kbd className="font-mono text-[11px] text-zinc-400 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 flex-shrink-0">
                      {s.display}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

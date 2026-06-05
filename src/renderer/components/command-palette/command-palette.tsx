import { Command } from 'cmdk'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@/stores/ui-store'
import { getCommands, type CommandGroup } from '@/lib/commands'
import { Dialog, DialogContent } from '@/components/ui/dialog'

const GROUP_ORDER: CommandGroup[] = ['navigation', 'file', 'edit', 'settings', 'help']

export function CommandPalette() {
  const { t } = useTranslation('commands')
  const isOpen = useUiStore((s) => s.isCommandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen)

  const commands = getCommands().filter((cmd) => !cmd.predicate || cmd.predicate())

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: t(`group.${group}`),
    items: commands.filter((c) => c.group === group)
  })).filter((g) => g.items.length > 0)

  function handleSelect(cmd: (typeof commands)[number]) {
    setOpen(false)
    setTimeout(() => cmd.run(), 10)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="p-0 max-w-[560px] overflow-hidden" hideClose>
        <Command
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-500"
          shouldFilter
        >
          <div className="flex items-center border-b border-zinc-800 px-3">
            <Command.Input
              placeholder={t('group.navigation')}
              className="flex h-11 w-full bg-transparent text-[14px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              autoFocus
            />
          </div>
          <Command.List className="max-h-[360px] overflow-y-auto py-2">
            {/* REQ-067 phase B: was text-zinc-500.  Empty-state notice is
                an informational status, not a hint — lift to text-zinc-300
                so it reads at the same level as the items it replaces. */}
            <Command.Empty className="py-8 text-center text-[14px] text-zinc-300">
              {t('group.navigation')}
            </Command.Empty>
            {grouped.map(({ group, label, items }) => (
              <Command.Group key={group} heading={label}>
                {items.map((cmd) => (
                  <Command.Item
                    key={cmd.id}
                    value={`${label} ${t(cmd.labelKey)}`}
                    onSelect={() => handleSelect(cmd)}
                    className="flex cursor-default items-center justify-between rounded-md mx-1 px-3 py-2 text-[14px] text-zinc-300 aria-selected:bg-zinc-800 aria-selected:text-zinc-50 transition-colors duration-100"
                  >
                    <div className="flex items-center gap-2">
                      {cmd.icon && <cmd.icon className="h-4 w-4 text-zinc-500 flex-shrink-0" />}
                      <span>{t(cmd.labelKey)}</span>
                    </div>
                    {cmd.shortcut && (
                      <kbd className="ml-4 font-mono text-[11px] text-zinc-500 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

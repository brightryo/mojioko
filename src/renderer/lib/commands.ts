/**
 * Command palette command registry.
 * All commands are registered here; command-palette.tsx reads this list.
 */
import type { LucideIcon } from 'lucide-react'

export type CommandGroup = 'navigation' | 'file' | 'edit' | 'settings' | 'help'

export interface CommandDef {
  id: string
  /** i18n key within the `commands` namespace, e.g. "navigation.goToStep1" */
  labelKey: string
  group: CommandGroup
  icon?: LucideIcon
  /** Human-readable shortcut hint */
  shortcut?: string
  /** If provided, command is hidden when predicate returns false */
  predicate?: () => boolean
  run: () => void
}

/** Mutable registry — populated at runtime by calling registerCommands(). */
let registry: CommandDef[] = []

export function registerCommands(cmds: CommandDef[]): void {
  registry = cmds
}

export function getCommands(): CommandDef[] {
  return registry
}

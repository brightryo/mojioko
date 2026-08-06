import { useTranslation } from 'react-i18next'
import { Terminal } from 'lucide-react'

/**
 * REQ-0447 / spec §12 — Settings ▸ CLI tab.
 *
 * Describes the bundled `mojioko` CLI: how to invoke it, what it does, the
 * command list, and a representative chained example. Content mirrors
 * `dev-docs/specs/mojioko-cli.md` and `mojioko -h`; all strings are i18n'd.
 */
const COMMANDS: readonly [name: string, descKey: string][] = [
  ['tools', 'cli.cmd.tools'],
  ['transcribe', 'cli.cmd.transcribe'],
  ['translate', 'cli.cmd.translate'],
  ['burn', 'cli.cmd.burn'],
  ['run', 'cli.cmd.run'],
]

export function CliSettingsTab() {
  const { t } = useTranslation(['settings'])

  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-fg-secondary flex-shrink-0" />
        <p className="text-body font-medium text-fg-primary">{t('cli.title')}</p>
      </div>
      <p className="text-body-sm text-fg-secondary leading-relaxed">{t('cli.intro')}</p>

      <div className="space-y-1.5">
        <p className="text-caption font-medium text-fg-secondary">{t('cli.invocationLabel')}</p>
        <pre className="text-caption font-mono bg-surface-2 rounded-md p-3 overflow-x-auto text-fg-primary whitespace-pre">
          {t('cli.invocation')}
        </pre>
      </div>

      <div className="space-y-1.5">
        <p className="text-caption font-medium text-fg-secondary">{t('cli.commandsLabel')}</p>
        <div className="rounded-md border border-line divide-y divide-line">
          {COMMANDS.map(([name, descKey]) => (
            <div key={name} className="flex gap-3 px-3 py-2">
              <code className="text-caption font-mono text-primary flex-shrink-0 w-24">{name}</code>
              <span className="text-caption text-fg-secondary">{t(descKey)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-caption font-medium text-fg-secondary">{t('cli.exampleLabel')}</p>
        <pre className="text-caption font-mono bg-surface-2 rounded-md p-3 overflow-x-auto text-fg-primary whitespace-pre">
          {t('cli.example')}
        </pre>
      </div>

      <p className="text-caption text-fg-muted leading-relaxed">{t('cli.seeAlso')}</p>
    </div>
  )
}

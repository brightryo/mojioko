import { SETTINGS_MERGE_RULES } from './settings-merge'

/**
 * REQ-0542 — is this settings.json OURS?
 *
 * ## Why this question needed asking
 *
 * A previous iteration of MOJIOKO used the same `%APPDATA%\MOJIOKO\` folder
 * (the path derives from `APP_NAME` — CLAUDE.md §7) and wrote a settings.json
 * in its own snake_case shape. When it runs, it overwrites ours. The current
 * build then reads a file it understands almost nothing of, spreads the few
 * coincidentally-named keys over `buildDefaults()`, and starts up looking like
 * a fresh install: style defaults, presets, folder choices and the GPU/model
 * selection all apparently gone. **Silently** — one `log.warn` at most, in a
 * file nobody reads. RES-0540 §5 is the incident.
 *
 * ## Why the existing version check does not catch it
 *
 * `loadSettings` already resets to defaults when `version !== CURRENT_VERSION`.
 * That is not this case: the legacy file carries **`version: 1`**, the same
 * number we write, so the guard passes it straight through. The version field
 * is not a format identifier — both formats reached "1" independently.
 *
 * ## The rule
 *
 *   foreign  ⟺  no known key at all,  OR  more unknown keys than known ones
 *
 * The known-key list is `SETTINGS_MERGE_RULES` — the exhaustive `-?` mapped
 * table the merge already uses, which `tsc` forces to stay complete. Reusing it
 * means "what keys does AppSettings have" has one answer in this codebase, and
 * a field added tomorrow is counted here without anyone remembering to.
 *
 * The threshold is deliberately a MAJORITY rather than "any unknown key":
 *
 *   - Our writer emits the whole object every save, so a genuine file carries
 *     ~25 known keys and no unknown ones. The legacy file carries 4 known
 *     (`version`, `language`, `theme`, `burnin` — generic words any config
 *     has) against 6 unknown (`font_family`, `text_sizes`, `text_colors`,
 *     `transcription_defaults`, `last_input_dir`, `last_output_dir`). The two
 *     populations are not close to each other.
 *   - It stays FORWARD-compatible. A file written by a newer build has a few
 *     keys this build has never heard of, and must not be quarantined for it —
 *     that would destroy a user's settings on a downgrade, which is a worse
 *     bug than the one this fixes.
 *
 * An empty object has no known keys and is therefore foreign. It carries
 * nothing, so quarantining it costs a user nothing and keeps the rule simple:
 * "essentially none of our keys" is exactly the REQ's 「既知キーが実質見つから
 * ない」.
 */
export type SettingsFileShape = 'ours' | 'foreign'

/** The counts behind the verdict, so the log line can explain itself. */
export interface SettingsShapeReport {
  shape: SettingsFileShape
  knownKeys: number
  unknownKeys: number
  /** A few unknown key names, for the log. Not exhaustive — it is a hint. */
  sampleUnknown: string[]
}

export function classifySettingsFile(parsed: unknown): SettingsShapeReport {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { shape: 'foreign', knownKeys: 0, unknownKeys: 0, sampleUnknown: [] }
  }
  const known = new Set(Object.keys(SETTINGS_MERGE_RULES))
  const unknown: string[] = []
  let knownKeys = 0
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (known.has(key)) knownKeys++
    else unknown.push(key)
  }
  const foreign = knownKeys === 0 || unknown.length > knownKeys
  return {
    shape: foreign ? 'foreign' : 'ours',
    knownKeys,
    unknownKeys: unknown.length,
    sampleUnknown: unknown.slice(0, 6),
  }
}

/** Why a settings file was moved aside. */
export type SettingsQuarantineReason = 'foreign-format' | 'unreadable'

/**
 * What the user is told, once, at startup.
 *
 * Carried on the `settings:load` reply rather than inside `AppSettings`: it
 * describes THIS LAUNCH, not a saved preference, and putting it in the settings
 * object would mean giving it a merge rule and persisting it forever.
 */
export interface SettingsQuarantineNotice {
  reason: SettingsQuarantineReason
  /** Absolute path the original file was moved to. */
  quarantinedPath: string
}

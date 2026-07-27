import type {
  AppSettings,
  TranscriptionDefaults,
  TranscriptionAdvancedParams,
} from '../../shared/types'

/**
 * Pure merge used by the `settings:save` handler.  Kept in its own file
 * (no electron / logger / fs imports) so `tests/unit/settings-save-
 * merge.test.ts` can exercise it directly without a vitest electron stub.
 *
 * # Why this file is shaped the way it is (REQ-0312 §1)
 *
 * `incoming` is the renderer's `AppSettings` payload.  It always
 * TypeScript-satisfies `AppSettings` — but only because every field main owns
 * exclusively is OPTIONAL, so omitting it is legal.  `App.tsx`'s debounced
 * auto-save builds the payload by hand and sets 17 of the 22 keys; the rest are
 * simply absent.  A plain `{ ...existing, ...incoming }` therefore drops
 * main-written state, and the SAME BUG has now shipped three times:
 *
 *   REQ-0157  `activeAccelerator`        — GPU choice silently reverted to CPU
 *   REQ-0158  `defaultInputDir` / `defaultOutputDir`
 *   REQ-0279  `fontSetInstalledVersion`  — bulk font DL appeared to do nothing
 *
 * Each was fixed by adding one more fallback line, which fixes that field and
 * nothing else: the NEXT field added to `AppSettings` re-opens the hole,
 * silently, with no compiler complaint.
 *
 * So the merge is no longer written as a spread plus ad-hoc exceptions.  Every
 * field must now declare its rule in `SETTINGS_MERGE_RULES`, whose type removes
 * optionality (`-?`) so that **adding a field to `AppSettings` without adding a
 * rule is a compile error**.  That, not the runtime behaviour, is the point of
 * this file: the failure mode moves from "ships and users lose data" to
 * "`tsc` fails".
 *
 * # Rule semantics
 *
 * - `incoming-wins`           the renderer is the source of truth; take the
 *                             payload value verbatim (what the bare spread did)
 * - `incoming-else-existing`  `incoming ?? existing`.  For fields the renderer
 *                             sends but resets to a `null` sentinel each save.
 * - `presence-wins`           `'key' in incoming ? incoming : existing`.  For
 *                             fields where `null` is a MEANINGFUL user action
 *                             ("cleared via the × button") that must be
 *                             distinguishable from "renderer omitted the key" —
 *                             a `??` fallback collapses those two and eats
 *                             legitimate clears (REQ-0158).
 * - `session-only`            stripped from the saved file entirely; the
 *                             renderer resets these on Step 1 navigation.
 *
 * # Nested objects — what this does and does not protect
 *
 * `transcriptionDefaults` and `transcriptionAdvanced` are merged as WHOLE
 * OBJECTS (`incoming-wins`), exactly as before.  The nested maps below are
 * compile-time only: they are never consulted at runtime, and exist so that
 * adding a field to either interface forces the author to classify it here
 * rather than inherit "incoming wins" by silence.
 *
 * Known consequence, unchanged by REQ-0312 and deliberately NOT fixed here
 * because REQ-0312 §1 requires identical behaviour: main writes
 * `transcriptionDefaults.whisperModel` (transcription.ts `setActiveModel` /
 * `uninstallModel`) and `activeFontId` (font.ts `fontSetActive` /
 * `fontUninstall`), and neither is protected — a debounced save scheduled
 * before one of those IPCs and firing after it will clobber them.  They work
 * today only because `App.tsx` happens to include them in the payload.  Both
 * are declared explicitly below so the exposure is visible in the rule table
 * instead of hiding in a spread; see RES-0312 §1 for the recommendation.
 */
export type MergeRule =
  | 'incoming-wins'
  | 'incoming-else-existing'
  | 'presence-wins'
  | 'session-only'

/**
 * The exhaustive rule table.  `-?` strips optionality, so every key of
 * `AppSettings` — optional ones included — MUST appear here or this object
 * literal fails to typecheck.  Do not add a catch-all.
 */
export const SETTINGS_MERGE_RULES: { readonly [K in keyof AppSettings]-?: MergeRule } = {
  // --- renderer-owned: the payload is authoritative ------------------------
  version: 'incoming-wins',
  language: 'incoming-wins',
  theme: 'incoming-wins',
  baseColor: 'incoming-wins',
  transcriptionDefaults: 'incoming-wins',
  transcriptionAdvanced: 'incoming-wins',
  autoLineBreak: 'incoming-wins',
  encoder: 'incoming-wins',
  defaultAudioTrackIndex: 'incoming-wins',
  fadeDurationSec: 'incoming-wins',

  // --- main-owned, renderer sends a null sentinel each save ----------------
  activeModelId: 'incoming-else-existing',
  lastInputDir: 'incoming-else-existing',
  lastOutputDir: 'incoming-else-existing',
  // REQ-0157: written only by the `gpu-tool:select` IPC; the renderer's store
  // does not track it at all.
  activeAccelerator: 'incoming-else-existing',

  // --- main-owned, where `null`/absent must stay distinguishable -----------
  // REQ-0158 / REQ-0194: `null` means "user cleared it with the × button".
  defaultInputDir: 'presence-wins',
  defaultOutputDir: 'presence-wins',
  defaultProjectDir: 'presence-wins',
  // REQ-0279: written only by `fontList:recordSetVersion`; the renderer has
  // never sent it, so this always resolves to `existing`.
  fontSetInstalledVersion: 'presence-wins',
  // REQ-0315 §4: written only by font.ts (`fontSetActive` / `fontUninstall` /
  // `fontUninstallAll`).  App.tsx no longer sends it — the rule and the omitted
  // key are a PAIR; `presence-wins` protects nothing while the key is present.
  activeFontId: 'presence-wins',

  // --- session-only: never persisted --------------------------------------
  burnin: 'session-only',
  audioMode: 'session-only',
  subtitleBackground: 'session-only',
}

/**
 * COMPILE-TIME ONLY, AND IT DOES NOT PROTECT VALUES.
 *
 * Read this before adding an entry: the table is never consulted at runtime.
 * `transcriptionDefaults` is merged as ONE OBJECT by the top-level rule, so
 * writing `'incoming-else-existing'` on a nested field here would have NO
 * EFFECT — the whole object is still replaced by the payload.
 *
 * If a future nested field is written by main, protecting it requires changing
 * `transcriptionDefaults`'s OWN rule to a custom per-field merge; that is a
 * behaviour change and needs its own REQ.  Better still, do what REQ-0315 §3
 * did for `whisperModel`: make the renderer store the source of truth, so no
 * merge rule is needed at all.
 *
 * Assuming otherwise is how this bug class reaches its sixth instance.
 *
 * What the table DOES buy: adding a field without classifying it here is a
 * compile error, which forces the "does main ever write this?" question at the
 * moment the field is introduced. 
 *
 * Every entry is `incoming-wins` because that is what the whole-object merge
 * does today.
 */
export const TRANSCRIPTION_DEFAULTS_MERGE_RULES: {
  readonly [K in keyof TranscriptionDefaults]-?: MergeRule
} = {
  fontSizePx: 'incoming-wins',
  textColorHex: 'incoming-wins',
  outlineColorHex: 'incoming-wins',
  outlineThicknessPx: 'incoming-wins',
  // Main writes this (transcription.ts) but the whole-object merge means the
  // renderer payload replaces it.  See the docblock's "Known consequence".
  whisperModel: 'incoming-wins',
  shadowDepth: 'incoming-wins',
  shadowColor: 'incoming-wins',
  shadowAlpha: 'incoming-wins',
  textAlpha: 'incoming-wins',
  outlineAlpha: 'incoming-wins',
  karaokeEnabled: 'incoming-wins',
  karaokeHighlightColor: 'incoming-wins',
  keywordEmphasisEnabled: 'incoming-wins',
  emphasisColorHex: 'incoming-wins',
  emphasisScalePercent: 'incoming-wins',
  casing: 'incoming-wins',
  rotation: 'incoming-wins',
  horizontalPosition: 'incoming-wins',
  verticalPosition: 'incoming-wins',
  verticalMarginPx: 'incoming-wins',
  posOffsetX: 'incoming-wins',
  posOffsetY: 'incoming-wins',
}

/** COMPILE-TIME ONLY — same contract as `TRANSCRIPTION_DEFAULTS_MERGE_RULES`. */
export const TRANSCRIPTION_ADVANCED_MERGE_RULES: {
  readonly [K in keyof TranscriptionAdvancedParams]-?: MergeRule
} = {
  vadFilter: 'incoming-wins',
  vadThreshold: 'incoming-wins',
  minSpeechDurationMs: 'incoming-wins',
  minSilenceDurationMs: 'incoming-wins',
  beamSize: 'incoming-wins',
  language: 'incoming-wins',
}

/**
 * Applies one field's rule.  Generic over the key so each branch stays
 * type-checked against that field's own type rather than going through `any`.
 *
 * `incoming-wins` is a no-op: the caller seeds the result by spreading
 * `incoming`, so the payload value (and, importantly, the ABSENCE of a key) is
 * already in place.  Re-assigning it here would materialise omitted optional
 * keys as explicit `undefined`, which changes `'key' in merged` and is exactly
 * the kind of silent difference this refactor must not introduce.
 */
function applyRule<K extends keyof AppSettings>(
  key: K,
  incoming: AppSettings,
  existing: AppSettings,
  merged: AppSettings,
): void {
  const rule = SETTINGS_MERGE_RULES[key]
  switch (rule) {
    case 'incoming-wins':
      return
    case 'incoming-else-existing':
      merged[key] = incoming[key] ?? existing[key]
      return
    case 'presence-wins':
      if (!(key in incoming)) merged[key] = existing[key]
      return
    case 'session-only':
      // `Partial` so `delete` is legal on required keys too — a field can be
      // session-only regardless of whether the interface marks it optional.
      delete (merged as Partial<AppSettings>)[key]
      return
    default: {
      // Adding a MergeRule variant without handling it fails to compile here.
      const exhaustive: never = rule
      return exhaustive
    }
  }
}

export function mergeSettingsForSave(
  incoming: AppSettings,
  existing: AppSettings,
): AppSettings {
  const merged: AppSettings = { ...incoming }
  for (const key of Object.keys(SETTINGS_MERGE_RULES) as (keyof AppSettings)[]) {
    applyRule(key, incoming, existing, merged)
  }
  return merged
}

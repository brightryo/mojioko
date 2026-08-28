/**
 * REQ-0540 — "the last values you used", remembered per animation TYPE.
 *
 * ## The problem
 *
 * REQ-0337 made picking a type re-seed every parameter from
 * `ANIMATION_TYPE_DEFAULTS`, which fixed a real inconsistency (one parameter
 * followed the type and the rest did not). But the table is a fixed constant,
 * so a user who has decided that *their* pop is 0.7 s re-types it every single
 * time they pick pop — on every cue, on every surface.
 *
 * The table stays as the answer for a type you have never tuned. Once you have
 * tuned one, YOUR value is the starting point.
 *
 * ## What is remembered, and where
 *
 * The key is the animation type; the value is the whole parameter set the
 * controls expose (timing switches, duration, strength). Stored app-wide in
 * `settings.json` under `AppSettings.animationMemory`, so it survives a restart
 * and follows the user across projects — it is a preference about how they
 * work, not a property of any one video.
 *
 * The table is `Partial`, and every read falls back. A settings file written
 * before this REQ has no `animationMemory` at all and therefore behaves exactly
 * as it did (`ANIMATION_TYPE_DEFAULTS`), which is what makes the upgrade
 * invisible rather than a surprise.
 *
 * ## ★ What must NEVER write to it
 *
 * The memory records a **direct user edit on an animation control**. It is not
 * a log of every value that has ever passed through a cue. These must not
 * touch it, and none of them can, because the only writer is
 * `AnimationControls`' own commit handlers — the component the three editing
 * surfaces render — and none of these paths render it:
 *
 *   1. **Opening a project.** Existing cues carry whatever they carry; reading
 *      a file is not the user choosing a value.
 *   2. **Applying a style preset** (REQ-0335). The preset is the user choosing
 *      a *preset*, not choosing a duration.
 *   3. **Undo / redo.** Undo rewinds the cue; it does not rewind the
 *      preference, exactly as undo does not rewind the theme.
 *   4. **Value changes that are not user edits at all** — `resolveAnimation`'s
 *      range clamping (REQ-0337 §2-5), the tier substitutions, the
 *      `fadeDurationSec` migration branch.
 *   5. **Stamping a new cue** (`animationFieldsForNewCue`) — transcription
 *      output, SRT import, add / split / duplicate. That path READS the memory
 *      and must not write it back, or every transcription would re-assert the
 *      current values as if the user had just typed them.
 *   6. **The CLI and MCP.** They are headless: no renderer, no settings store,
 *      no memory. They keep using `ANIMATION_TYPE_DEFAULTS` via the defaults
 *      already in `settings.json`.
 *
 * Structural, not disciplinary: this module exports no writer that any of those
 * paths call, and the one writer lives in a React component they never mount.
 */
import {
  ANIMATION_TYPE_DEFAULTS,
  animationFieldsForTypeChange,
  type AnimationMemory,
  type AnimationParamsMemory,
  type AnimationType,
  type AnimationUiValue,
} from './cue-animation'

/*
 * The TABLE TYPES (`AnimationMemory` / `AnimationParamsMemory`) and the
 * defaults resolution (`resolveDefaultAnimationParams`) live in
 * `cue-animation.ts`, next to the `ANIMATION_TYPE_DEFAULTS` they fall back to;
 * this module owns the memory OPERATIONS. Splitting them that way is what
 * keeps the dependency one-directional — the alternative had the two modules
 * importing each other.
 */
export type { AnimationMemory, AnimationParamsMemory }

/** The parameter half of a control value, ready to store. */
export function animationParamsFromUiValue(v: AnimationUiValue): AnimationParamsMemory {
  return {
    inEnabled: v.inEnabled,
    outEnabled: v.outEnabled,
    durationSec: v.durationSec,
    startScalePercent: v.startScalePercent,
    blurPx: v.blurPx,
  }
}

/**
 * ★ The seed a freshly PICKED type starts from: what you last used, else the
 * fixed table.
 *
 * This is the one function the three surfaces share for rule 3 of the REQ
 * ("参照タイミング = 種類を選択した時点"), so they cannot disagree about what
 * picking a type means.
 */
export function animationSeedForType(
  type: AnimationType,
  memory: AnimationMemory | undefined,
): AnimationUiValue {
  const remembered = memory?.[type]
  if (!remembered) return animationFieldsForTypeChange(type)
  return { type, ...remembered }
}

/**
 * Record the parameters now in use for `value.type`.
 *
 * Returns a NEW table (the store replaces rather than mutates). Recording under
 * `none` is allowed and inert: the controls disable every parameter row while
 * the type is `none`, so nothing can be committed there — but rejecting it here
 * would be a rule that has to stay true elsewhere, and there is nothing to gain
 * from it. Rule 3 of the REQ is the related one, and it is about not DELETING:
 * picking `none` leaves every other type's memory alone, which falls out of
 * this being a per-key write.
 */
export function rememberAnimationParams(
  memory: AnimationMemory | undefined,
  value: AnimationUiValue,
): AnimationMemory {
  return { ...(memory ?? {}), [value.type]: animationParamsFromUiValue(value) }
}

/**
 * Validate a table read off disk.
 *
 * Unknown keys are dropped rather than kept: unlike `stylePresets` (where a
 * newer build's extra style fields must survive a round-trip through an older
 * build), a memory entry is regenerated the moment the user touches the
 * control, so there is nothing to corrupt by being strict — and a malformed
 * entry would seed a control with garbage.
 */
export function sanitizeAnimationMemory(raw: unknown): AnimationMemory {
  if (!raw || typeof raw !== 'object') return {}
  const out: AnimationMemory = {}
  for (const key of Object.keys(ANIMATION_TYPE_DEFAULTS) as AnimationType[]) {
    const v = (raw as Record<string, unknown>)[key]
    if (!v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    if (
      typeof e.inEnabled !== 'boolean'
      || typeof e.outEnabled !== 'boolean'
      || typeof e.durationSec !== 'number'
      || typeof e.startScalePercent !== 'number'
      || typeof e.blurPx !== 'number'
    ) continue
    out[key] = {
      inEnabled: e.inEnabled,
      outEnabled: e.outEnabled,
      durationSec: e.durationSec,
      startScalePercent: e.startScalePercent,
      blurPx: e.blurPx,
    }
  }
  return out
}

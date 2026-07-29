import { describe, it, expect } from 'vitest'
import { animationFieldsForNewCue, resolveAnimation } from '../../src/shared/cue-animation'
import { TRANSCRIPTION_DEFAULTS_MERGE_RULES } from '../../src/main/ipc/settings-merge'

/**
 * REQ-0325 §2 — the animation default for new cues moved from
 * `settingsStore.fadeDurationSec` into `TranscriptionDefaults`.
 *
 * The risk this pins is a REGRESSION of shipped behaviour: fade has been
 * released since v1.3.5, and today a user who sets the default fade to
 * 0.3s gets new cues that fade for 0.3s.  That must keep working for
 * anyone who never touches the new animation control.
 */
describe('REQ-0325 §2 — new-cue animation defaults', () => {
  it('★ released behaviour survives: settings fade 0.3s → a new cue fades 0.3s', () => {
    // A settings file written before this REQ: no `animation*` at all.
    const defaults = {}
    const settingsFadeDurationSec = 0.3

    // What the cue-creation sites build.
    const newCue = {
      fadeDurationSec: settingsFadeDurationSec,
      ...animationFieldsForNewCue(defaults),
    }

    // No animation fields are stamped, so the cue stays on the migration
    // path — which is exactly what produces the old behaviour.
    expect('animationType' in newCue).toBe(false)

    const spec = resolveAnimation(newCue)
    expect(spec.type).toBe('fade')
    expect(spec.durationSec).toBeCloseTo(0.3, 6)
    expect(spec.inEnabled).toBe(true)
    expect(spec.outEnabled).toBe(true)
  })

  it('settings fade 0 → a new cue has no animation, as before', () => {
    const newCue = { fadeDurationSec: 0, ...animationFieldsForNewCue({}) }
    expect(resolveAnimation(newCue).type).toBe('none')
  })

  it('once the defaults carry an animation, it is stamped onto the new cue', () => {
    const defaults = {
      animationType: 'pop' as const,
      animationInEnabled: true,
      animationOutEnabled: false,
      animationDurationSec: 0.6,
    }
    // Legacy fade still present in settings; the explicit choice must win.
    const newCue = { fadeDurationSec: 0.3, ...animationFieldsForNewCue(defaults) }

    const spec = resolveAnimation(newCue)
    expect(spec.type).toBe('pop')
    expect(spec.durationSec).toBeCloseTo(0.6, 6)
    expect(spec.outEnabled).toBe(false)
  })

  it('an explicit "none" default really means none, beating the legacy fade', () => {
    // The `undefined` vs `'none'` distinction has to survive the trip
    // through the defaults, or a user could not turn the default fade off.
    const newCue = {
      fadeDurationSec: 0.5,
      ...animationFieldsForNewCue({ animationType: 'none' as const }),
    }
    expect(resolveAnimation(newCue).type).toBe('none')
  })

  it('partial defaults fill in sensibly rather than producing undefined fields', () => {
    const fields = animationFieldsForNewCue({ animationType: 'scale' as const })
    expect(fields.animationInEnabled).toBe(true)
    expect(fields.animationOutEnabled).toBe(true)
    expect(typeof fields.animationDurationSec).toBe('number')
  })

  it('the settings-merge rules cover the four new fields', () => {
    // The mapped type already forces this at compile time; asserting it at
    // runtime too catches the type and the value drifting apart.
    for (const k of [
      'animationType', 'animationInEnabled', 'animationOutEnabled', 'animationDurationSec',
    ] as const) {
      expect(TRANSCRIPTION_DEFAULTS_MERGE_RULES).toHaveProperty(k)
    }
  })
})

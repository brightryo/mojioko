import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANIMATION_TYPE_DEFAULTS,
  animationFieldsForNewCue,
  animationFieldsForTypeChange,
  defaultStartScalePercent,
  resolveDefaultAnimationParams,
  type AnimationMemory,
  type AnimationUiValue,
} from '../../src/shared/cue-animation'
import {
  animationParamsFromUiValue,
  animationSeedForType,
  rememberAnimationParams,
  sanitizeAnimationMemory,
} from '../../src/shared/animation-memory'

/**
 * REQ-0540 — "the last values you used", remembered per animation type.
 *
 * The behaviour splits cleanly in two, and this file pins both:
 *
 *   - **the rules**, as pure functions: what a picked type seeds from, what a
 *     stored default resolves to, and what happens when there is no memory
 *     (which is every existing install on its first launch).
 *   - **who is allowed to write it.** That one cannot be expressed as a pure
 *     function — it is a statement about the whole codebase — so it is checked
 *     the only way it honestly can be: by reading the source and asserting that
 *     the writer appears in exactly one place.
 */

const POP_MEMORY = {
  inEnabled: true,
  outEnabled: false,
  durationSec: 0.7,
  startScalePercent: 40,
  blurPx: 55,
}

describe('REQ-0540 §1-1 — the seed a picked type starts from', () => {
  it('with no memory at all, it is exactly the pre-REQ behaviour', () => {
    // The upgrade must be invisible: this is the assertion that says so.
    for (const type of Object.keys(ANIMATION_TYPE_DEFAULTS) as (keyof typeof ANIMATION_TYPE_DEFAULTS)[]) {
      expect(animationSeedForType(type, undefined)).toEqual(animationFieldsForTypeChange(type))
      expect(animationSeedForType(type, {})).toEqual(animationFieldsForTypeChange(type))
    }
  })

  it('with a memory for that type, it is what the user last used', () => {
    const memory: AnimationMemory = { pop: POP_MEMORY }
    expect(animationSeedForType('pop', memory)).toEqual({ type: 'pop', ...POP_MEMORY })
  })

  it('a memory for ANOTHER type does not leak into this one', () => {
    // The failure this rules out: remembering "the last values" globally rather
    // than per type, so picking pop after tuning blur hands you blur's numbers —
    // which is REQ-0331's bug (a pop that starts nearly full size) reintroduced.
    const memory: AnimationMemory = { pop: POP_MEMORY }
    expect(animationSeedForType('scale', memory)).toEqual(animationFieldsForTypeChange('scale'))
    expect(animationSeedForType('blur', memory)).toEqual(animationFieldsForTypeChange('blur'))
  })

  it('the seed round-trips: remember what you seeded, get it back', () => {
    const seeded = animationSeedForType('blur', undefined)
    const memory = rememberAnimationParams(undefined, seeded)
    expect(animationSeedForType('blur', memory)).toEqual(seeded)
  })
})

describe('REQ-0540 §1-4 — recording an edit', () => {
  const value: AnimationUiValue = { type: 'pop', ...POP_MEMORY }

  it('records the whole parameter set under the current type', () => {
    expect(rememberAnimationParams(undefined, value)).toEqual({ pop: POP_MEMORY })
    expect(animationParamsFromUiValue(value)).toEqual(POP_MEMORY)
  })

  it('★ picking 「なし」 does not erase anything (REQ §1-3)', () => {
    const memory: AnimationMemory = { pop: POP_MEMORY, blur: { ...POP_MEMORY, durationSec: 0.9 } }
    const after = rememberAnimationParams(memory, animationSeedForType('none', memory))
    expect(after.pop).toEqual(POP_MEMORY)
    expect(after.blur?.durationSec).toBe(0.9)
  })

  it('does not mutate the table it was given', () => {
    // The store replaces rather than mutates, so a mutating implementation
    // would produce a value React never re-renders for.
    const memory: AnimationMemory = { pop: POP_MEMORY }
    const after = rememberAnimationParams(memory, { type: 'blur', ...POP_MEMORY })
    expect(memory).toEqual({ pop: POP_MEMORY })
    expect(after).not.toBe(memory)
  })
})

describe('REQ-0540 §1-1 — what a stored DEFAULT resolves to', () => {
  const saved = {
    animationInEnabled: true,
    animationOutEnabled: true,
    animationDurationSec: 0.5,
    animationStartScalePercent: 60,
    animationBlurPx: 25,
  }

  it('★ no memory → the values タブ2 already had (first launch is identical)', () => {
    expect(resolveDefaultAnimationParams('blur', saved, undefined)).toEqual({
      inEnabled: true, outEnabled: true, durationSec: 0.5, startScalePercent: 60, blurPx: 25,
    })
  })

  it('memory wins over the saved default (the REQ’s 「真実は1つ」)', () => {
    expect(resolveDefaultAnimationParams('pop', saved, { pop: POP_MEMORY })).toEqual(POP_MEMORY)
  })

  it('neither → the fixed table, field by field', () => {
    expect(resolveDefaultAnimationParams('blur', {}, undefined)).toEqual({
      inEnabled: true,
      outEnabled: true,
      durationSec: ANIMATION_TYPE_DEFAULTS.blur.durationSec,
      startScalePercent: defaultStartScalePercent('blur'),
      blurPx: ANIMATION_TYPE_DEFAULTS.blur.strength,
    })
  })

  it('a new cue gets exactly what タブ2 displays', () => {
    // The two must agree or the defaults panel is lying about what it does.
    const defaults = { animationType: 'pop' as const, ...saved }
    const memory: AnimationMemory = { pop: POP_MEMORY }
    const fields = animationFieldsForNewCue(defaults, memory)
    const shown = resolveDefaultAnimationParams('pop', defaults, memory)
    expect(fields).toEqual({
      animationType: 'pop',
      animationInEnabled: shown.inEnabled,
      animationOutEnabled: shown.outEnabled,
      animationDurationSec: shown.durationSec,
      animationStartScalePercent: shown.startScalePercent,
      animationBlurPx: shown.blurPx,
    })
  })

  it('★ without a memory, animationFieldsForNewCue is unchanged from REQ-0337', () => {
    // The headless CLI passes no memory at all, so this is also the assertion
    // that the CLI keeps stamping exactly what it stamped before.
    const defaults = { animationType: 'blur' as const, animationDurationSec: 0.5 }
    expect(animationFieldsForNewCue(defaults)).toEqual({
      animationType: 'blur',
      animationInEnabled: true,
      animationOutEnabled: true,
      animationDurationSec: 0.5,
      animationStartScalePercent: defaultStartScalePercent('blur'),
      animationBlurPx: ANIMATION_TYPE_DEFAULTS.blur.strength,
    })
    expect(animationFieldsForNewCue({})).toEqual({})
  })
})

describe('REQ-0540 §1-1 — reading the table off disk', () => {
  it('absent / malformed settings hydrate as "nothing remembered"', () => {
    expect(sanitizeAnimationMemory(undefined)).toEqual({})
    expect(sanitizeAnimationMemory(null)).toEqual({})
    expect(sanitizeAnimationMemory('pop')).toEqual({})
    expect(sanitizeAnimationMemory({ pop: 'yes' })).toEqual({})
  })

  it('an entry missing a field is dropped, not half-applied', () => {
    // Half-applying would seed a control with `undefined` and the row would
    // render blank — worse than falling back to the table.
    const partial: Record<string, unknown> = { ...POP_MEMORY }
    delete partial.durationSec
    expect(sanitizeAnimationMemory({ pop: partial })).toEqual({})
  })

  it('a valid entry survives, and unknown keys do not', () => {
    expect(sanitizeAnimationMemory({ pop: POP_MEMORY, wobble: POP_MEMORY }))
      .toEqual({ pop: POP_MEMORY })
  })
})

/**
 * ★ REQ-0540 §1-2 — the paths that must NEVER write to the memory.
 *
 * The guarantee is structural: the only writer is `AnimationControls`' commit
 * handlers, and project load / preset apply / undo / tier substitution /
 * new-cue stamping / the CLI never mount that component. A unit test cannot
 * mount it either (no jsdom/RTL here), so what is checked is the property the
 * guarantee rests on — that the writer exists in exactly one place — plus the
 * absence of any call from the modules that own the excluded paths.
 */
describe('REQ-0540 §1-2 — only one thing may write the memory', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')

  it('the store action is called from exactly one component', () => {
    const hits = [
      'src/renderer/components/animation-controls/animation-controls.tsx',
      'src/renderer/components/default-style-controls/default-style-controls.tsx',
      'src/renderer/components/subtitle-table/bulk-edit-bar.tsx',
      'src/renderer/components/timeline-view/timeline-block-inspector.tsx',
      'src/renderer/routes/step1.tsx',
      'src/renderer/routes/step2.tsx',
      'src/renderer/stores/project-store.ts',
      'src/renderer/stores/history-store.ts',
    ].filter((f) => read(f).includes('rememberAnimation'))
    expect(hits).toEqual(['src/renderer/components/animation-controls/animation-controls.tsx'])
  })

  it('the excluded paths do not import the memory writer at all', () => {
    // `rememberAnimationParams` is the pure writer; anything that imported it
    // could build a second write path without touching the store action above.
    for (const f of [
      'src/renderer/stores/project-store.ts',
      'src/renderer/stores/history-store.ts',
      'src/renderer/lib/style-defaults-to-entry.ts',
      'src/main/cli/subtitle-io.ts',
      'src/main/services/ass-generator.ts',
    ]) {
      expect(read(f), `${f} must not write the animation memory`)
        .not.toContain('rememberAnimationParams')
    }
  })

  it('the headless entry points carry no memory at all', () => {
    // The CLI/MCP have no settings store; they must keep calling the one-arg
    // form so their output is unchanged by this REQ.
    expect(read('src/main/cli/subtitle-io.ts')).toContain('animationFieldsForNewCue(defaults)')
  })
})

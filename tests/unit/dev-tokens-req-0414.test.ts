/**
 * REQ-0414 — developer live-token editor: pure-helper coverage.
 *
 * These pin the parts a browser can't lend us confidence on:
 *   1. colour round-trips (hex ↔ HSL triplet) so a live edit written back as
 *      a triplet reproduces the picked colour and every `hsl(var(--x))`
 *      consumer stays correct;
 *   2. `:root` var discovery + drift reconciliation, so a newly-added token
 *      surfaces in the panel instead of going stale (REQ-0414 §1);
 *   3. export serialisation matches the paste-back shapes for globals.css and
 *      tailwind.config.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  DEV_TOKEN_GROUPS,
  discoverRootVarNames,
  driftFor,
  hexToHslTriplet,
  hexToRgb,
  hslTripletToHex,
  isHslTriplet,
  orderedColorMembers,
  rgbStringToHex,
  serializeEditedState,
  serializeGlobalsCss,
  serializeTailwindFontSize,
  TYPE_SCALE_TOKENS,
  TOKEN_OVERLAY_COLORS,
  detectSizeToken,
  serializeReassignments,
  type DevTokenGroupSpec,
  type TokenSnapshot,
} from '../../src/renderer/lib/dev-tokens'

describe('REQ-0414 colour conversions', () => {
  it('rgbStringToHex parses rgb() and rgba()', () => {
    expect(rgbStringToHex('rgb(250, 250, 250)')).toBe('#fafafa')
    expect(rgbStringToHex('rgba(0, 0, 0, 0.5)')).toBe('#000000')
    expect(rgbStringToHex('rgb(69, 170, 122)')).toBe('#45aa7a')
    expect(rgbStringToHex('not a color')).toBeNull()
  })

  it('hexToRgb handles 3- and 6-digit forms', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(hexToRgb('#45aa7a')).toEqual({ r: 69, g: 170, b: 122 })
    expect(hexToRgb('#zzz')).toBeNull()
  })

  it('hexToHslTriplet matches known authored triplets', () => {
    // neutral-12 (#fafafa) authored as 0 0% 98%
    expect(hexToHslTriplet('#fafafa')).toBe('0 0% 98%')
    // pure black / white
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%')
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%')
    // --primary #46aa7b ≈ 152 42% 47%
    const p = hexToHslTriplet('#46aa7b')
    expect(p).toMatch(/^15[12] 4[12]% 4[67]%$/)
  })

  it('hex ↔ triplet round-trips within 1 step', () => {
    for (const hex of ['#45aa7a', '#fbbf24', '#ef4444', '#212121', '#5989b9']) {
      const triplet = hexToHslTriplet(hex)!
      expect(isHslTriplet(triplet)).toBe(true)
      const back = hslTripletToHex(triplet)!
      const a = hexToRgb(hex)!
      const b = hexToRgb(back)!
      expect(Math.abs(a.r - b.r)).toBeLessThanOrEqual(2)
      expect(Math.abs(a.g - b.g)).toBeLessThanOrEqual(2)
      expect(Math.abs(a.b - b.b)).toBeLessThanOrEqual(2)
    }
  })

  it('isHslTriplet accepts triplets and rejects var()/hsl()', () => {
    expect(isHslTriplet('0 0% 98%')).toBe(true)
    expect(isHslTriplet('152 42% 47%')).toBe(true)
    expect(isHslTriplet('var(--neutral-12)')).toBe(false)
    expect(isHslTriplet('hsl(0 0% 98%)')).toBe(false)
    expect(isHslTriplet('#fff')).toBe(false)
  })
})

describe('REQ-0414 registry', () => {
  it('every group carries the payload its kind requires', () => {
    for (const g of DEV_TOKEN_GROUPS) {
      if (g.kind === 'color') {
        expect(g.members && g.members.length, `${g.id} has no members`).toBeTruthy()
      } else if (g.kind === 'size') {
        expect(g.sizes && g.sizes.length, `${g.id} has no sizes`).toBeTruthy()
      } else {
        // REQ-0526 — alpha groups.
        expect(g.alphas && g.alphas.length, `${g.id} has no alphas`).toBeTruthy()
        for (const a of g.alphas!) {
          expect(a.name, `${g.id} alpha has no name`).toBeTruthy()
          expect(a.label, `${g.id}/${a.name} has no label`).toBeTruthy()
        }
      }
    }
  })

  /*
   * REQ-0526 — `--row-edited` has to be reachable from the panel, and the
   * reason it was not is worth pinning: it is in none of the curated colour
   * lists and matches none of the discover prefixes, so the drift reconciler
   * never surfaced it either. If someone deletes the `state` group this fails.
   */
  it('the edited state colour is editable, and its four weights are too (REQ-0526)', () => {
    const colourMembers = DEV_TOKEN_GROUPS.filter((g) => g.kind === 'color').flatMap(
      (g) => g.members ?? [],
    )
    expect(colourMembers).toContain('row-edited')

    const alphaNames = DEV_TOKEN_GROUPS.filter((g) => g.kind === 'alpha').flatMap((g) =>
      (g.alphas ?? []).map((a) => a.name),
    )
    expect(alphaNames).toEqual([
      'row-edited-fill-alpha',
      'row-edited-fill-hover-alpha',
      'row-edited-frame-alpha',
      'row-edited-row-alpha',
    ])
  })

  /*
   * The `state` group deliberately has NO discoverPrefixes. `['row-']` would
   * look correct and would pull `--row-selected-alpha` — a number — into a
   * colour group, where the panel would render 0.10 in a colour input.
   */
  it('the state colour group does not auto-discover `row-` vars (REQ-0526)', () => {
    const state = DEV_TOKEN_GROUPS.find((g) => g.id === 'state')!
    expect(state.discoverPrefixes).toBeUndefined()
    expect(driftFor(state, ['row-edited', 'row-selected-alpha', 'row-brand-new'])).toEqual([])
  })

  it('font-size group lists the collapsed 6-step type scale (REQ-0416)', () => {
    const fs = DEV_TOKEN_GROUPS.find((g) => g.id === 'fontSize')!
    expect(fs.sizes).toEqual(['micro', 'caption', 'body-sm', 'body', 'title', 'display'])
  })
})

describe('REQ-0414 discovery + drift', () => {
  // Minimal fake CSSOM: one base :root rule plus decoy rules.
  function fakeDoc(rootVars: string[]): Document {
    const mkStyle = (names: string[]) => {
      const props = names.map((n) => `--${n}`)
      return {
        length: props.length,
        item: (i: number) => props[i] ?? '',
      } as CSSStyleDeclaration
    }
    const styleSheets = [
      {
        cssRules: [
          { selectorText: ':root', style: mkStyle(rootVars) },
          // decoy — must be ignored
          { selectorText: ':root.light', style: mkStyle(['text-primary']) },
          { selectorText: '.foo', style: mkStyle(['bar']) },
        ],
      },
      // decoy cross-origin sheet: accessing cssRules throws
      {
        get cssRules(): never {
          throw new Error('cross-origin')
        },
      },
    ]
    return { styleSheets } as unknown as Document
  }

  it('discoverRootVarNames collects only base :root custom props', () => {
    const doc = fakeDoc(['text-primary', 'surface-0', 'neutral-1'])
    const found = discoverRootVarNames(doc)
    expect(found.sort()).toEqual(['neutral-1', 'surface-0', 'text-primary'])
  })

  it('driftFor reports prefix matches missing from members', () => {
    const group: DevTokenGroupSpec = {
      id: 'text',
      title: 'Text',
      kind: 'color',
      members: ['text-primary'],
      discoverPrefixes: ['text-'],
    }
    expect(driftFor(group, ['text-primary', 'text-brandnew', 'surface-0'])).toEqual(['text-brandnew'])
  })

  it('orderedColorMembers appends drift after curated members', () => {
    const group: DevTokenGroupSpec = {
      id: 'text',
      title: 'Text',
      kind: 'color',
      members: ['text-primary', 'text-secondary'],
      discoverPrefixes: ['text-'],
    }
    expect(orderedColorMembers(group, ['text-secondary', 'text-primary', 'text-zzz'])).toEqual([
      'text-primary',
      'text-secondary',
      'text-zzz',
    ])
  })

  it('size group yields no drift', () => {
    const fs = DEV_TOKEN_GROUPS.find((g) => g.id === 'fontSize')!
    expect(driftFor(fs, ['fs-micro'])).toEqual([])
  })
})

describe('REQ-0414 export serialisation', () => {
  const snap: TokenSnapshot = {
    colors: { 'text-primary': '0 0% 96%', primary: '152 42% 47%' },
    sizes: {
      micro: { px: 11, lineHeight: '14px' },
      'body-sm': { px: 13, lineHeight: '18px' },
    },
  }

  it('serializeGlobalsCss emits --var lines + --fs-* overrides', () => {
    const out = serializeGlobalsCss(snap)
    expect(out).toContain('--text-primary: 0 0% 96%;')
    expect(out).toContain('--primary: 152 42% 47%;')
    expect(out).toContain('--fs-micro: 11px;')
    expect(out).toContain('--fs-body-sm: 13px;')
  })

  it('serializeTailwindFontSize emits paste-able tuples with edited fallback', () => {
    const out = serializeTailwindFontSize(snap)
    expect(out).toContain("micro: ['var(--fs-micro, 11px)', { lineHeight: '14px' }],")
    // hyphenated scale name is quoted as an object key
    expect(out).toContain("'body-sm': ['var(--fs-body-sm, 13px)', { lineHeight: '18px' }],")
  })
})

describe('REQ-0420 token overlay helpers', () => {
  it('every type-scale token has a distinct overlay colour', () => {
    const colors = TYPE_SCALE_TOKENS.map((t) => TOKEN_OVERLAY_COLORS[t])
    expect(colors.every(Boolean)).toBe(true)
    expect(new Set(colors).size).toBe(TYPE_SCALE_TOKENS.length)
  })

  it('TYPE_SCALE_TOKENS matches the fontSize group', () => {
    const fs = DEV_TOKEN_GROUPS.find((g) => g.id === 'fontSize')!
    expect([...TYPE_SCALE_TOKENS]).toEqual(fs.sizes)
  })

  it('detectSizeToken finds the type token and ignores colour/other classes', () => {
    expect(detectSizeToken(['flex', 'text-title', 'font-semibold', 'text-fg-primary'])).toBe('title')
    // body-sm is not confused with body (exact class match)
    expect(detectSizeToken(['text-body-sm'])).toBe('body-sm')
    expect(detectSizeToken(['text-body'])).toBe('body')
    expect(detectSizeToken(['text-fg-primary', 'text-center'])).toBeNull()
    expect(detectSizeToken([])).toBeNull()
  })

  it('serializeReassignments lists element / from / to, or a no-op note', () => {
    expect(serializeReassignments([])).toContain('no reassignments')
    const out = serializeReassignments([
      { text: '入力ファイル', path: 'div.flex > label', from: 'body', to: 'title' },
    ])
    expect(out).toContain('text-body → text-title')
    expect(out).toContain('入力ファイル')
    expect(out).toContain('div.flex > label')
  })
})

/*
 * REQ-0526 — the decision block. The whole point of the live editor is to end
 * with a value someone can act on, so the copy-out is the deliverable, not a
 * convenience. These pin the shape the owner will paste back.
 */
describe('REQ-0526 edited-state decision block', () => {
  const snap = {
    triplet: '236 73% 54%',
    hex: '#343fdf',
    alphas: {
      'row-edited-fill-alpha': '0.7',
      'row-edited-fill-hover-alpha': '0.85',
      'row-edited-frame-alpha': '1',
      'row-edited-row-alpha': '0.1',
    },
  }

  it('carries both notations and all four weights', () => {
    const out = serializeEditedState(snap)
    expect(out).toContain('#343fdf')
    expect(out).toContain('236 73% 54%')
    expect(out).toContain('--row-edited:  236 73% 54%;')
    expect(out).toContain('--row-edited-fill-alpha:       0.7;')
    expect(out).toContain('--row-edited-fill-hover-alpha: 0.85;')
    expect(out).toContain('--row-edited-frame-alpha:      1;')
    expect(out).toContain('--row-edited-row-alpha:        0.1;')
  })

  it('leads with a one-line summary that can be pasted into chat', () => {
    const lines = serializeEditedState(snap).split('\n')
    // Line 0 is the banner, line 1 the summary.
    expect(lines[1]).toContain('#343fdf')
    expect(lines[1]).toContain('fill 0.7')
    expect(lines[1]).toContain('hover 0.85')
    expect(lines[1]).toContain('frame 1')
    expect(lines[1]).toContain('row 0.1')
  })

  it('marks a missing weight rather than silently emitting a wrong one', () => {
    const out = serializeEditedState({ ...snap, alphas: {} })
    // A blank or a stale default here would be pasted back as fact.
    expect(out).toContain('--row-edited-fill-alpha:       ?;')
  })
})

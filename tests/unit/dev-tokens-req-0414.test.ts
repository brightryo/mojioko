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
  serializeGlobalsCss,
  serializeTailwindFontSize,
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
  it('every group is either a colour group with members or a size group with sizes', () => {
    for (const g of DEV_TOKEN_GROUPS) {
      if (g.kind === 'color') {
        expect(g.members && g.members.length).toBeTruthy()
      } else {
        expect(g.sizes && g.sizes.length).toBeTruthy()
      }
    }
  })

  it('font-size group lists the full 10-step type scale', () => {
    const fs = DEV_TOKEN_GROUPS.find((g) => g.id === 'fontSize')!
    expect(fs.sizes).toEqual([
      'micro',
      'caption',
      'label',
      'body-sm',
      'callout',
      'body',
      'headline',
      'title',
      'heading',
      'display',
    ])
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

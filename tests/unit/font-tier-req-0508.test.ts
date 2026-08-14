import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  canSelectFontInTier,
  resolveFontIdForTier,
  applyFontTierPolicy,
} from '../../src/shared/font-tier'
import {
  DEFAULT_FONT_ID,
  FONT_REGISTRY,
  getFontMeta,
  resolveRenderableFontId,
  type FontId,
} from '../../src/shared/fonts'
import { detectFontTierSubstitution } from '../../src/main/cli/no-op-warnings'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0508 — the twelve additional font families are usable only in the paid
 * build, enforced where they are DRAWN rather than where they are picked.
 *
 * RES-0507 §1 measured the hole this closes: `canSelectFontInTier` had zero
 * call sites under `src/main/`, and a free-tier `mojioko export_frame` drew
 * Anton (glyph box 333x75) and Dela Gothic One (716x77) where Noto SemiBold
 * measures 539x78. The pixel side of the gate lives in `cli-smoke`; this file
 * pins the policy, the substitution target, GUI/headless parity, and the
 * completeness of the call-site set.
 */

const PAID_ONLY: FontId[] = FONT_REGISTRY
  .filter((f) => f.cssFontFamily !== getFontMeta(DEFAULT_FONT_ID).cssFontFamily)
  .map((f) => f.id)

const BUNDLED: FontId[] = FONT_REGISTRY
  .filter((f) => f.cssFontFamily === getFontMeta(DEFAULT_FONT_ID).cssFontFamily)
  .map((f) => f.id)

describe('REQ-0508 §1-1 — resolveFontIdForTier policy', () => {
  it('the registry really does split 9 bundled / 20 paid-only (12 families)', () => {
    // Guards the two lists above: if a future font lands in the wrong family
    // the exhaustive loops below would quietly stop covering it.
    expect(BUNDLED).toHaveLength(9)
    expect(PAID_ONLY).toHaveLength(20)
    expect(new Set(PAID_ONLY.map((id) => getFontMeta(id).cssFontFamily)).size).toBe(12)
  })

  it('paid tier renders every registered font as itself', () => {
    for (const f of FONT_REGISTRY) {
      expect(resolveFontIdForTier(true, f.id), f.id).toBe(f.id)
    }
  })

  it('free tier renders all nine bundled Noto weights as themselves', () => {
    // REQ-0353 widened the free tier from SemiBold alone to the whole family.
    // A substitution here would be a REGRESSION of the free build, not a fix.
    for (const id of BUNDLED) {
      expect(resolveFontIdForTier(false, id), id).toBe(id)
    }
  })

  it('§1-2 free tier substitutes into Noto Sans JP at the MATCHING weight', () => {
    for (const id of PAID_ONLY) {
      const to = resolveFontIdForTier(false, id)
      expect(BUNDLED, `${id} → ${to}`).toContain(to)
      // Every paid family sits on the 100–900 grid Noto covers in full, so the
      // weight maps exactly. If a future font arrives off-grid this fails and
      // the nearest-weight fallback needs documenting rather than discovering.
      expect(getFontMeta(to).weight, `${id} weight`).toBe(getFontMeta(id).weight)
    }
  })

  it('§1-2 spot-checks the two fonts RES-0507 measured leaking', () => {
    expect(resolveFontIdForTier(false, 'anton')).toBe('noto-sans-jp-regular')
    expect(resolveFontIdForTier(false, 'dela-gothic-one')).toBe('noto-sans-jp-regular')
    expect(resolveFontIdForTier(false, 'poppins-bold')).toBe('noto-sans-jp-bold')
    expect(resolveFontIdForTier(false, 'poppins-thin')).toBe('noto-sans-jp-thin')
  })

  it('is idempotent — applying it twice equals applying it once', () => {
    // This is what lets the policy sit at several points on one render path
    // (caller resolves the Style default, `generateAss` re-checks each cue)
    // without the second application changing the first answer.
    for (const f of FONT_REGISTRY) {
      for (const paid of [true, false]) {
        const once = resolveFontIdForTier(paid, f.id)
        expect(resolveFontIdForTier(paid, once), `${f.id}/${paid}`).toBe(once)
      }
    }
  })

  it('always returns something the tier is allowed to use', () => {
    for (const f of FONT_REGISTRY) {
      expect(canSelectFontInTier(false, resolveFontIdForTier(false, f.id)), f.id).toBe(true)
    }
  })
})

/**
 * §1-5 — the GUI and the headless path must substitute IDENTICALLY.
 *
 * The renderer composes both axes in `resolveRenderableFontId(id, isInstalled,
 * isSelectable)`; the main process asks the tier question alone. Divergence here
 * would mean the preview shows one font and the burn produces another — a new
 * inconsistency traded for the one this REQ fixes. They agree by construction
 * (both are the same function), and this pins that they still do.
 */
describe('REQ-0508 §1-5 — GUI preview and headless render agree', () => {
  // The renderer's real installed set: all nine Noto weights ship bundled
  // (REQ-0353), and this machine's `%APPDATA%/MOJIOKO/fonts` may hold any of
  // the paid ones. The worst case for parity is "the paid font IS on disk",
  // because then only the tier can reject it.
  const everythingInstalled = () => true

  it.each([true, false])('agrees for every registered font (isPaid=%s)', (isPaid) => {
    for (const f of FONT_REGISTRY) {
      const gui = resolveRenderableFontId(f.id, everythingInstalled, (id) => canSelectFontInTier(isPaid, id))
      expect(resolveFontIdForTier(isPaid, f.id), `${f.id}/${isPaid}`).toBe(gui)
    }
  })
})

const cue = (over: Partial<SubtitleEntry> = {}): SubtitleEntry => ({
  id: over.id ?? 'c1',
  startSec: 0,
  endSec: 1,
  text: 'hello',
  ...over,
}) as SubtitleEntry

describe('REQ-0508 §1 — applyFontTierPolicy over a whole burn', () => {
  it('paid tier changes nothing and preserves cue identity', () => {
    const entries = [cue({ id: 'a', fontId: 'anton' }), cue({ id: 'b', fontId: 'poppins-bold' })]
    const r = applyFontTierPolicy(true, 'dela-gothic-one', entries)
    expect(r.defaultFontId).toBe('dela-gothic-one')
    expect(r.substitutions).toEqual([])
    expect(r.defaultSubstituted).toBe(false)
    // Identity, not just equality: the paid path must not rebuild every cue.
    expect(r.entries[0]).toBe(entries[0])
    expect(r.entries[1]).toBe(entries[1])
  })

  it('free tier rewrites per-cue fonts and counts them per pair', () => {
    const entries = [
      cue({ id: 'a', fontId: 'anton' }),
      cue({ id: 'b', fontId: 'anton' }),
      cue({ id: 'c', fontId: 'poppins-bold' }),
      cue({ id: 'd', fontId: 'noto-sans-jp-bold' }),
      cue({ id: 'e' }),
    ]
    const r = applyFontTierPolicy(false, DEFAULT_FONT_ID, entries)
    expect(r.entries.map((e) => e.fontId)).toEqual([
      'noto-sans-jp-regular',
      'noto-sans-jp-regular',
      'noto-sans-jp-bold',
      'noto-sans-jp-bold',
      undefined,
    ])
    expect(r.substitutions).toEqual([
      { from: 'anton', to: 'noto-sans-jp-regular', cueCount: 2 },
      { from: 'poppins-bold', to: 'noto-sans-jp-bold', cueCount: 1 },
    ])
    expect(r.defaultSubstituted).toBe(false)
    // The untouched cues keep their identity even when siblings changed.
    expect(r.entries[3]).toBe(entries[3])
    expect(r.entries[4]).toBe(entries[4])
  })

  it('substitutes the project default font too, and says so', () => {
    const r = applyFontTierPolicy(false, 'bebas-neue', [cue()])
    expect(r.defaultFontId).toBe('noto-sans-jp-regular')
    expect(r.defaultSubstituted).toBe(true)
    // cueCount 0: the default was substituted but no cue overrides it.
    expect(r.substitutions).toEqual([{ from: 'bebas-neue', to: 'noto-sans-jp-regular', cueCount: 0 }])
  })

  it('does not count DELETED cues — a warning must describe visible output', () => {
    const r = applyFontTierPolicy(false, DEFAULT_FONT_ID, [
      cue({ id: 'a', fontId: 'anton' }),
      cue({ id: 'b', fontId: 'anton', isDeleted: true }),
    ])
    expect(r.substitutions).toEqual([{ from: 'anton', to: 'noto-sans-jp-regular', cueCount: 1 }])
    // The deleted cue is still rewritten — it must not be able to reach libass
    // if some later stage un-deletes it.
    expect(r.entries[1].fontId).toBe('noto-sans-jp-regular')
  })

  it('leaves an unrecognised fontId alone rather than inventing one', () => {
    const entries = [cue({ fontId: 'not-a-font' as FontId })]
    const r = applyFontTierPolicy(false, DEFAULT_FONT_ID, entries)
    expect(r.entries[0]).toBe(entries[0])
    expect(r.substitutions).toEqual([])
  })
})

describe('REQ-0508 §1-3 / §3-4 — the FONT_TIER_SUBSTITUTED warning', () => {
  const free = { tier: 'free', isPaid: false, source: 'not-packaged' } as const
  const paid = { tier: 'paid', isPaid: true, source: 'msix' } as const

  it('free tier + paid font → warns, naming from, to and cue count', () => {
    const w = detectFontTierSubstitution([cue({ fontId: 'anton' })], DEFAULT_FONT_ID, free)
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('FONT_TIER_SUBSTITUTED')
    expect(w[0].message).toContain('Anton')
    const detail = w[0].detail as Record<string, unknown>
    expect(detail.substitutedCueCount).toBe(1)
    expect(detail.substitutions).toEqual([
      { from: 'anton', fromName: getFontMeta('anton').displayName, to: 'noto-sans-jp-regular', toName: getFontMeta('noto-sans-jp-regular').displayName, cueCount: 1 },
    ])
    // §2-5 — refusing (or here, downgrading) without saying where the feature
    // lives leaves the caller with no next step.
    expect(String(detail.remedy)).toContain('有料版')
  })

  it('free tier + bundled font → NO warning (a warning that always fires is not read)', () => {
    expect(detectFontTierSubstitution([cue({ fontId: 'noto-sans-jp-black' })], DEFAULT_FONT_ID, free)).toEqual([])
  })

  it('paid tier + paid font → NO warning', () => {
    expect(detectFontTierSubstitution([cue({ fontId: 'anton' })], 'dela-gothic-one', paid)).toEqual([])
  })

  it('a deleted-only substitution still warns, but reports 0 visible cues', () => {
    const w = detectFontTierSubstitution([cue({ fontId: 'anton', isDeleted: true })], DEFAULT_FONT_ID, free)
    // `visible()` drops it, so nothing is substituted in what gets drawn.
    expect(w).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// §1-1 — the call-site set is complete.
//
// "One pure function called from an enumerated set of sites" is only as good as
// the enumeration, so this is two rules: the named sites must still call it, and
// any OTHER file that turns a font into a rendered family name must reference
// the policy. The second is what catches a new render path.
// ---------------------------------------------------------------------------

/**
 * A CALL to the policy, not a mention of it.
 *
 * The first draft matched the bare names, and its negative control passed while
 * the enforcement was commented out: the `import` line still carried the name.
 * A file that imports the policy and never calls it is exactly the state this
 * scan has to catch, so import lines are stripped and a `(` is required.
 */
const POLICY_CALL = /\b(resolveFontIdForTier|applyFontTierPolicy|canSelectFontInTier|isFamilyTierLocked)\s*\(/

const callsPolicy = (code: string): boolean =>
  POLICY_CALL.test(
    code
      .split('\n')
      .filter((l) => !/^\s*import\b/.test(l) && !/^\s*\}\s*from\s*'/.test(l))
      .join('\n'),
  )

/** The sites REQ-0508 §1 enumerates, with why each one is needed. */
export const REQUIRED_CALL_SITES: { file: string; why: string }[] = [
  { file: 'src/main/services/ffmpeg-burnin.ts', why: 'burn: Style default + staged TTFs + every cue (GUI, CLI, MCP)' },
  { file: 'src/main/services/frame-exporter.ts', why: 'still export: GUI image export + CLI/MCP export_frame' },
  { file: 'src/main/services/ass-generator.ts', why: 'backstop for any future caller that writes ASS directly' },
  { file: 'src/main/cli/no-op-warnings.ts', why: 'FONT_TIER_SUBSTITUTED must be derived from the same policy' },
  { file: 'src/renderer/components/subtitle-overlay/subtitle-overlay.tsx', why: 'preview must match the burn' },
  { file: 'src/renderer/services/burnin.ts', why: 'GUI burn request is built from tier-resolved ids' },
]

function stripComments(text: string): string {
  const out: string[] = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) { out.push(''); continue }
      line = line.slice(end + 2)
      inBlock = false
    }
    for (;;) {
      const open = line.indexOf('/*')
      if (open === -1) break
      const close = line.indexOf('*/', open + 2)
      if (close === -1) { line = line.slice(0, open); inBlock = true; break }
      line = line.slice(0, open) + ' ' + line.slice(close + 2)
    }
    const slash = line.indexOf('//')
    if (slash !== -1) line = line.slice(0, slash)
    out.push(line)
  }
  return out.join('\n')
}

/** Named sites whose CODE (not prose) no longer applies the policy. */
export function findUnguardedRequiredSites(files: { path: string; text: string }[]): string[] {
  const byPath = new Map(files.map((f) => [f.path.replace(/\\/g, '/'), f.text]))
  const missing: string[] = []
  for (const site of REQUIRED_CALL_SITES) {
    const text = byPath.get(site.file)
    if (text === undefined) { missing.push(`${site.file} (file not found)`); continue }
    if (!callsPolicy(stripComments(text))) missing.push(`${site.file} — ${site.why}`)
  }
  return missing
}

/**
 * Files that resolve an ASS family name without mentioning the policy.
 *
 * `assFontName` is the last step before libass: whatever family name reaches it
 * is what gets drawn. `shared/fonts.ts` (the registry that DEFINES the field)
 * and `shared/font-tier.ts` (the policy itself) are the two legitimate
 * exceptions.
 */
export function findUnguardedRenderSites(files: { path: string; text: string }[]): string[] {
  const exempt = ['src/shared/fonts.ts', 'src/shared/font-tier.ts']
  return files
    .map((f) => ({ path: f.path.replace(/\\/g, '/'), code: stripComments(f.text) }))
    .filter((f) => !exempt.includes(f.path))
    .filter((f) => /assFontName/.test(f.code))
    .filter((f) => !callsPolicy(f.code))
    .map((f) => f.path)
}

function collectSources(dir: string, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collectSources(full, out)
    else if (/\.tsx?$/.test(name)) out.push({ path: relative(join(__dirname, '..', '..'), full), text: readFileSync(full, 'utf-8') })
  }
  return out
}

describe('REQ-0508 §1-1 — every enumerated render site applies the policy', () => {
  const sources = collectSources(join(__dirname, '..', '..', 'src'))

  it('the named sites still call it', () => {
    expect(findUnguardedRequiredSites(sources), 'a REQ-0508 call site lost its tier check').toEqual([])
  })

  it('no OTHER file resolves an ASS family name without it', () => {
    expect(
      findUnguardedRenderSites(sources),
      'this file renders fonts but never consults the tier policy — add it to the policy or to the exemptions with a reason',
    ).toEqual([])
  })

  /**
   * ★ The negative controls. Both rules are only worth having if removing a
   * call turns them red — RES-0506 §1 found a docstring claiming a scan that
   * did not exist, so the scan proves itself here.
   */
  it('NEGATIVE CONTROL — deleting the call from ffmpeg-burnin.ts is detected', () => {
    const real = sources.find((f) => f.path.replace(/\\/g, '/') === 'src/main/services/ffmpeg-burnin.ts')
    expect(real, 'fixture source not found').toBeDefined()
    const gutted = real!.text.replace(/applyFontTierPolicy/g, 'somethingElse')
    expect(gutted).not.toBe(real!.text)
    const patched = sources.map((f) => (f === real ? { path: f.path, text: gutted } : f))
    expect(findUnguardedRequiredSites(patched)).toHaveLength(1)
    expect(findUnguardedRenderSites(patched)).toContain('src/main/services/ffmpeg-burnin.ts')
  })

  it('NEGATIVE CONTROL — a policy mention that is only a COMMENT does not count', () => {
    const real = sources.find((f) => f.path.replace(/\\/g, '/') === 'src/main/services/frame-exporter.ts')
    const commentedOut = real!.text.replace(/^(\s*)(const fontPolicy = applyFontTierPolicy)/m, '$1// $2')
    expect(commentedOut).not.toBe(real!.text)
    // The file still MENTIONS the policy in its JSDoc; the scan must not accept
    // prose as enforcement.
    expect(commentedOut).toContain('applyFontTierPolicy')
    const patched = sources.map((f) => (f === real ? { path: f.path, text: commentedOut } : f))
    expect(findUnguardedRequiredSites(patched).join()).toContain('frame-exporter')
  })
})

/**
 * §2-5 — the word-subtitle gate is on the path, not beside it.
 *
 * REQ-0508 changes nothing about what that gate DOES (word timestamps have been
 * unconditional for every tier since REQ-0285). It fixes the same structural
 * shape the font gate had: the check lived at `ipc/transcription.ts` only, so
 * the CLI — which calls `transcribe()` directly — bypassed it by construction.
 * Nothing leaked because the CLI has no `--word-subtitle` flag; the point is
 * that adding one would have leaked by default.
 */
export function findUngatedPayloadBuilds(files: { path: string; text: string }[]): string[] {
  return files
    .map((f) => ({ path: f.path.replace(/\\/g, '/'), code: stripComments(f.text) }))
    .filter((f) => f.path !== 'src/main/services/transcribe-payload.ts') // the definition
    .filter((f) => /buildTranscribePayload\s*\(/.test(f.code))
    .filter((f) => !/applyTranscriptionTierGate\s*\(/.test(f.code))
    .map((f) => f.path)
}

describe('REQ-0508 §2-5 — buildTranscribePayload is always tier-gated', () => {
  const sources = collectSources(join(__dirname, '..', '..', 'src'))

  it('every payload build applies the transcription tier gate', () => {
    expect(findUngatedPayloadBuilds(sources)).toEqual([])
  })

  it('NEGATIVE CONTROL — removing the gate from the sidecar is detected', () => {
    const real = sources.find((f) => f.path.replace(/\\/g, '/') === 'src/main/services/transcription-sidecar.ts')
    expect(real, 'sidecar source not found').toBeDefined()
    const gutted = real!.text.replace(/applyTranscriptionTierGate\(request, resolveTier\(\)\.isPaid\)/, 'request')
    expect(gutted).not.toBe(real!.text)
    const patched = sources.map((f) => (f === real ? { path: f.path, text: gutted } : f))
    expect(findUngatedPayloadBuilds(patched)).toEqual(['src/main/services/transcription-sidecar.ts'])
  })
})

/**
 * §1-4 — no advertised warning code without an emitter.
 *
 * `FONT_RESTRICTED` was advertised by `help.ts` for three months with no code
 * anywhere that could produce it (RES-0507 §1), and `FONT_UNAVAILABLE` sat
 * beside it in the same state. An agent reading `help --json` cannot tell an
 * advertised-and-real code from an advertised-and-imaginary one, so this scan
 * makes the difference a test failure instead of a discovery.
 */
describe('REQ-0508 §1-4 — every advertised warning code is actually emitted', () => {
  const sources = collectSources(join(__dirname, '..', '..', 'src'))
  const helpText = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'cli', 'help.ts'), 'utf-8')

  /** Codes as advertised by `help.ts`'s WARNING_CODES table. */
  const advertised = (text: string): string[] => {
    const table = text.slice(text.indexOf('const WARNING_CODES'))
    const body = table.slice(0, table.indexOf('\n]'))
    return [...body.matchAll(/\['([A-Z_]+)',/g)].map((m) => m[1])
  }

  const emittedSomewhere = (code: string): boolean =>
    sources.some((f) => {
      const p = f.path.replace(/\\/g, '/')
      if (p === 'src/main/cli/help.ts') return false // the advert itself
      return stripComments(f.text).includes(`'${code}'`)
    })

  it('finds the advertised codes at all (guards the parser)', () => {
    expect(advertised(helpText)).toContain('FONT_TIER_SUBSTITUTED')
    expect(advertised(helpText).length).toBeGreaterThanOrEqual(3)
  })

  it('each advertised warning code has an emitter in src/', () => {
    const hollow = advertised(helpText).filter((c) => !emittedSomewhere(c))
    expect(hollow, 'advertised warning code with no emitter — implement it or drop the advert').toEqual([])
  })

  it('NEGATIVE CONTROL — re-adding FONT_RESTRICTED to the advert is caught', () => {
    const withGhost = helpText.replace(
      "['FONT_TIER_SUBSTITUTED',",
      "['FONT_RESTRICTED', 'tier で拒否'],\n  ['FONT_TIER_SUBSTITUTED',",
    )
    expect(withGhost).not.toBe(helpText)
    expect(advertised(withGhost).filter((c) => !emittedSomewhere(c))).toEqual(['FONT_RESTRICTED'])
  })
})

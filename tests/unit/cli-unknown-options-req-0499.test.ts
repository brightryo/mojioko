import { describe, it, expect } from 'vitest'
import {
  canonicalCommandName,
  detectUnknownOptions,
  knownOptionKeys,
  suggestOption,
} from '../../src/main/cli/known-opts'

/**
 * REQ-0499 §1 — unknown options must be reported, and known ones must not be.
 *
 * The second half matters as much as the first: several options are read by
 * commands but deliberately absent from `help.ts` (aliases, `--overwrite`,
 * input fallbacks). A detector built on help alone would reject working
 * invocations, so `HIDDEN_OPTION_KEYS` is pinned here — if someone deletes an
 * entry from that allowlist, a real command starts warning and this fails.
 */
describe('REQ-0499 §1 — unknown option detection', () => {
  it('accepts every option `burn` advertises', () => {
    const unknown = detectUnknownOptions('burn', {
      out: 'x.mp4', preset: 'shorts', resolution: '1080x1920', 'margin-v': '80',
      'margin-x': '10', 'margin-y': '10', overflow: 'warn', encoder: 'auto',
      crf: '20', bitrate: '16M', quality: '80', audio: 'simple', container: 'mp4',
      weight: 'Bold', 'font-size': '64', 'text-color': '#FFFFFF',
      'outline-color': '#000000', outline: '4', position: 'bottom', style: 'x',
      overwrite: true, 'dry-run': true,
    })
    expect(unknown).toEqual([])
  })

  it('flags the flags RES-0498 showed passing silently', () => {
    const unknown = detectUnknownOptions('burn', {
      karaoke: 'on', shadow: '40', rotation: '45', layer: '3',
      'line-spacing': '50', 'emphasis-color': '#FF0000',
    })
    expect(unknown.map((u) => u.key).sort()).toEqual([
      'emphasis-color', 'karaoke', 'layer', 'line-spacing', 'rotation', 'shadow',
    ])
  })

  it('accepts global flags on any command', () => {
    expect(detectUnknownOptions('probe', { json: true, quiet: true, verbose: true, 'strict-args': true })).toEqual([])
  })

  // ---- the hidden allowlist (REQ-0499 §1-4) --------------------------------
  it.each([
    ['export_frame', 'at'],
    ['export_frame', 'overwrite'],
    ['convert', 'from'],
    ['convert', 'to'],
    ['convert', 'input'],
    ['edit_subtitle', 'from'],
    ['edit_subtitle', 'to'],
    ['edit_subtitle', 'input'],
    ['edit_subtitle', 'overwrite'],
    ['read_subtitle', 'input'],
    ['probe', 'input'],
    ['transcribe', 'auto-break'],
    ['transcribe', 'overwrite'],
    ['translate', 'overwrite'],
    ['burn', 'format'],
  ])('accepts the hidden but real option: %s --%s', (command, key) => {
    expect(detectUnknownOptions(command, { [key]: 'v' })).toEqual([])
  })

  it('accepts forwarded transcribe/burn flags on `run` (the {...args.opts} spread)', () => {
    // RES-0498 verified these reach the burn stage, so warning about them would
    // be a false positive.
    expect(detectUnknownOptions('run', {
      'text-color': '#00FF00', 'font-size': '55', lang: 'ja', 'beam-size': '5',
      encoder: 'auto', 'dry-run': true,
    })).toEqual([])
  })

  it('still flags a genuinely bogus flag on `run`', () => {
    expect(detectUnknownOptions('run', { 'no-such-flag': '1' }).map((u) => u.key)).toEqual(['no-such-flag'])
  })

  it('canonicalizes dispatch aliases so alias invocations are not all-unknown', () => {
    expect(canonicalCommandName('export-frame')).toBe('export_frame')
    expect(canonicalCommandName('read-subtitle')).toBe('read_subtitle')
    expect(canonicalCommandName('edit-subtitle')).toBe('edit_subtitle')
    expect(canonicalCommandName('export_mcpb')).toBe('export-mcpb')
    expect(canonicalCommandName('burn')).toBe('burn')
    expect(detectUnknownOptions('export-frame', { time: '1.5', at: '1.5' })).toEqual([])
  })

  it('suggests a near miss so an agent can self-correct', () => {
    const [u] = detectUnknownOptions('burn', { 'text-colour': '#FFF' })
    expect(u.suggestion).toBe('text-color')
    expect(detectUnknownOptions('burn', { 'font-siz': '10' })[0].suggestion).toBe('font-size')
  })

  it('offers no suggestion when nothing is close', () => {
    expect(detectUnknownOptions('burn', { zzzzzzzzzzz: '1' })[0].suggestion).toBeUndefined()
  })

  it('knownOptionKeys never returns an empty set (globals always present)', () => {
    for (const c of ['status', 'probe', 'burn', 'run']) {
      expect(knownOptionKeys(c).has('json')).toBe(true)
    }
  })

  it('suggestOption prefers a prefix match', () => {
    expect(suggestOption('margin', ['margin-v', 'out'])).toBe('margin-v')
  })
})

import { describe, it, expect } from 'vitest'
import { parseArgs, optString, optBool } from '../../src/main/cli/args'
import { exitCodeFor, CODE_TO_EXIT } from '../../src/main/cli/output'

/**
 * REQ-0447 — pure CLI logic guards: argument parsing + the stable
 * error-code → exit-code mapping (spec §4).  The exit-code map is a public
 * contract, so this pins the numbers.
 */
describe('REQ-0447 — CLI arg parser', () => {
  it('splits positionals, --key value, --key=value, --flag, -o, -h', () => {
    const { positionals, opts } = parseArgs([
      'input.mp4',
      '-o',
      'out.mojioko',
      '--lang',
      'ja',
      '--vad=off',
      '--strict',
      '-h',
    ])
    expect(positionals).toEqual(['input.mp4'])
    expect(opts.out).toBe('out.mojioko')
    expect(opts.lang).toBe('ja')
    expect(opts.vad).toBe('off')
    expect(opts.strict).toBe(true)
    expect(opts.help).toBe(true)
  })

  it('--no-json sets json=false; bare --json is true', () => {
    expect(parseArgs(['--no-json']).opts.json).toBe(false)
    expect(parseArgs(['--json']).opts.json).toBe(true)
    expect(parseArgs([]).opts.json).toBeUndefined()
  })

  it('value options consume the next token', () => {
    const { opts } = parseArgs(['--to', 'en', '--model', '3b'])
    expect(opts.to).toBe('en')
    expect(opts.model).toBe('3b')
  })

  it('optString / optBool helpers', () => {
    const { opts } = parseArgs(['--to', 'en', '--vad=on'])
    expect(optString(opts, 'to')).toBe('en')
    expect(optString(opts, 'missing')).toBeUndefined()
    expect(optBool(opts, 'vad')).toBe(true)
    expect(optBool(opts, 'missing')).toBeUndefined()
  })
})

describe('REQ-0447 — exit-code mapping (public contract)', () => {
  it('maps stable error codes to spec §4.1 exit numbers', () => {
    expect(exitCodeFor('USAGE')).toBe(2)
    expect(exitCodeFor('INPUT_NOT_FOUND')).toBe(3)
    expect(exitCodeFor('UNSUPPORTED_FORMAT')).toBe(4)
    expect(exitCodeFor('TOOL_NOT_DOWNLOADED')).toBe(5)
    expect(exitCodeFor('MODEL_NOT_FOUND')).toBe(5)
    expect(exitCodeFor('DEPS_MISSING')).toBe(6)
    expect(exitCodeFor('GPU_INIT_FAILED')).toBe(6)
    expect(exitCodeFor('TRANSCRIBE_FAILED')).toBe(7)
    expect(exitCodeFor('TRANSLATION_FAILED')).toBe(7)
    expect(exitCodeFor('BURN_FAILED')).toBe(7)
    expect(exitCodeFor('OUTPUT_WRITE_FAILED')).toBe(8)
    expect(exitCodeFor('SUBTITLE_OVERFLOW')).toBe(9)
    expect(exitCodeFor('CANCELED')).toBe(130)
  })

  it('unknown code falls back to 1', () => {
    expect(exitCodeFor('SOMETHING_ELSE')).toBe(1)
    expect(CODE_TO_EXIT.UNEXPECTED).toBe(1)
    expect(CODE_TO_EXIT.NOT_IMPLEMENTED).toBe(1)
  })
})

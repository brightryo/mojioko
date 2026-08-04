import { describe, it, expect } from 'vitest'
import {
  buildMadladSource,
  normalizeSourceText,
  translationCacheKey,
  isLatestRequest,
  isTranslatableText,
  detectMissingPythonModule,
  isDepsMissingError,
  buildDepsMissingMessage,
} from '../../src/shared/translation'

/**
 * REQ-0410 — pure helpers for the translation prototype.  The model inference
 * itself is owner-verified on-device; these pin the token-prefix, cache key and
 * latest-wins logic that don't need a model.
 */

describe('buildMadladSource', () => {
  it('prefixes the <2en> language token onto the source', () => {
    expect(buildMadladSource('こんにちは')).toBe('<2en> こんにちは')
    expect(buildMadladSource('hola', 'en')).toBe('<2en> hola')
  })
})

describe('normalizeSourceText', () => {
  it('collapses \\N breaks + whitespace and trims', () => {
    expect(normalizeSourceText('  a\\Nb   c  ')).toBe('a b c')
    expect(normalizeSourceText('one\\Ntwo')).toBe('one two')
    expect(normalizeSourceText('  \\N  ')).toBe('')
  })
})

describe('translationCacheKey', () => {
  it('is stable across wrapping differences of the same text', () => {
    expect(translationCacheKey('a\\Nb')).toBe(translationCacheKey('a b'))
    expect(translationCacheKey('x')).toBe('en x')
  })
  it('differs by target', () => {
    // Only 'en' exists today, but the key carries the target so a future
    // language never collides.
    expect(translationCacheKey('x', 'en')).toContain('en ')
  })
})

describe('isLatestRequest', () => {
  it('applies only the newest request', () => {
    expect(isLatestRequest(5, 5)).toBe(true)
    expect(isLatestRequest(4, 5)).toBe(false) // a stale earlier request is dropped
  })
})

describe('isTranslatableText', () => {
  it('true for real text, false for empty/whitespace/\\N-only', () => {
    expect(isTranslatableText('hi')).toBe(true)
    expect(isTranslatableText('   ')).toBe(false)
    expect(isTranslatableText('\\N')).toBe(false)
    expect(isTranslatableText('')).toBe(false)
  })
})

// REQ-0411 — clearer sidecar dependency error mapping.
describe('detectMissingPythonModule', () => {
  it('extracts the module name from a "No module named" error', () => {
    expect(detectMissingPythonModule("No module named 'sentencepiece'")).toBe('sentencepiece')
    expect(
      detectMissingPythonModule("ModuleNotFoundError: No module named 'ctranslate2'"),
    ).toBe('ctranslate2')
    // Dotted submodule names are captured whole.
    expect(detectMissingPythonModule('No module named "pkg.sub"')).toBe('pkg.sub')
  })
  it('returns null when the error is unrelated', () => {
    expect(detectMissingPythonModule('CUDA out of memory')).toBeNull()
  })
})

describe('isDepsMissingError', () => {
  it('true for missing-module / import errors, false otherwise', () => {
    expect(isDepsMissingError("No module named 'sentencepiece'")).toBe(true)
    expect(isDepsMissingError('ImportError: cannot import name X')).toBe(true)
    expect(isDepsMissingError('ModuleNotFoundError: whatever')).toBe(true)
    expect(isDepsMissingError('CUDA out of memory')).toBe(false)
  })
})

describe('buildDepsMissingMessage', () => {
  it('embeds the venv python + the pip install command', () => {
    const msg = buildDepsMissingMessage('C:\\venv\\python.exe', 'sentencepiece')
    expect(msg).toContain('C:\\venv\\python.exe')
    expect(msg).toContain('-m pip install -r python-sidecar/requirements.txt')
    expect(msg).toContain('sentencepiece')
  })
  it('falls back to "python" and omits the module clause when unknown', () => {
    const msg = buildDepsMissingMessage('', null)
    expect(msg).toContain('"python" -m pip install')
    expect(msg).not.toContain('missing module')
  })
})

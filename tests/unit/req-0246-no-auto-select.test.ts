import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * REQ-0246 — regression pin for the removal of DL-completion
 * auto-select and accordion auto-close.
 *
 * The repo has no React component test infrastructure (all `tests/unit`
 * tests are pure functions).  For a REMOVAL REQ the honest guard is a
 * source-level assertion that the removed patterns are gone from the
 * `handleConfirmInstall` bodies of the two managers.  Coarse but
 * effective: it will fail loudly if a future contributor reflexively
 * reintroduces the auto-behaviour without knowing REQ-0246.
 *
 * These tests also verify the *explicit* selection paths
 * (`handleActivate` in the model manager, `handleSelectGpu` /
 * `handleSelectCpu` in the GPU-tool manager) are untouched — the REQ
 * removes automation only, not explicit user actions.
 */

const MODEL_MANAGER_PATH = join(
  __dirname,
  '../../src/renderer/components/whisper-model-manager/whisper-model-manager.tsx',
)
const GPU_TOOL_MANAGER_PATH = join(
  __dirname,
  '../../src/renderer/components/gpu-tool-manager/gpu-tool-manager.tsx',
)

/**
 * Extract the body of an `async function <name>(...) { ... }` from the
 * source.  Uses brace-counting so nested blocks don't fool a naive
 * regex.  Returns the substring between the function's opening `{` and
 * its matching closing `}`.
 */
function extractFunctionBody(src: string, name: string): string {
  const declIdx = src.indexOf(`async function ${name}(`)
  if (declIdx === -1) throw new Error(`function ${name} not found`)
  const openBrace = src.indexOf('{', declIdx)
  if (openBrace === -1) throw new Error(`no opening brace for ${name}`)
  let depth = 1
  let i = openBrace + 1
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  if (depth !== 0) throw new Error(`unbalanced braces in ${name}`)
  return src.slice(openBrace + 1, i - 1)
}

/**
 * The REQ-0246 rationale comments deliberately mention the removed
 * function names (e.g. "selectAccelerator('gpu')") to document what
 * was taken out.  A regex over the raw body would false-positive on
 * those.  Strip line comments so we match executable code only.
 */
function stripLineComments(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      // Naive but sufficient for our styled source: a `//` that isn't
      // inside a string literal starts a line comment.  We don't have
      // strings containing `//` in these files.
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

describe('REQ-0246 whisper-model-manager: handleConfirmInstall has no auto-select or auto-close', () => {
  const src = readFileSync(MODEL_MANAGER_PATH, 'utf-8')
  const rawBody = extractFunctionBody(src, 'handleConfirmInstall')
  const codeBody = stripLineComments(rawBody)

  it('does NOT call setActiveModel (auto-select removed)', () => {
    expect(codeBody).not.toMatch(/setActiveModel\(/)
  })

  it('does NOT call setIsOpen(false) (accordion auto-close removed)', () => {
    expect(codeBody).not.toMatch(/setIsOpen\s*\(\s*false\s*\)/)
  })

  it('still has the REQ-0246 rationale comment (removal is intentional)', () => {
    // The comment lives in `rawBody`; stripping line comments to
    // check the code separately (above) means we must check the
    // rationale trail here on the un-stripped version.
    expect(rawBody).toMatch(/REQ-0246/)
  })

  it('still awaits run.promise + refreshes state (core install flow intact)', () => {
    expect(codeBody).toMatch(/await run\.promise/)
    expect(codeBody).toMatch(/await refresh\(\)/)
  })
})

describe('REQ-0246 whisper-model-manager: handleActivate (explicit selection) is untouched', () => {
  const src = readFileSync(MODEL_MANAGER_PATH, 'utf-8')
  const body = extractFunctionBody(src, 'handleActivate')

  it('still calls setActiveModel(model.id)', () => {
    expect(body).toMatch(/setActiveModel\(model\.id\)/)
  })

  it('still calls setIsOpen(false) on explicit activation (this close is user-initiated, not DL-tied)', () => {
    // The REQ removes DL-completion auto-close, NOT the "collapse
    // after user explicitly switches" affordance on the Activate
    // button.  If a future refactor collapses these two paths and
    // this line disappears from handleActivate, that's a separate
    // decision to make deliberately.
    expect(body).toMatch(/setIsOpen\s*\(\s*false\s*\)/)
  })
})

describe('REQ-0246 gpu-tool-manager: handleConfirmInstall has no auto-select', () => {
  const src = readFileSync(GPU_TOOL_MANAGER_PATH, 'utf-8')
  const rawBody = extractFunctionBody(src, 'handleConfirmInstall')
  const codeBody = stripLineComments(rawBody)

  it('does NOT call selectAccelerator (auto-switch-to-GPU removed)', () => {
    expect(codeBody).not.toMatch(/selectAccelerator\(/)
  })

  it('still has the REQ-0246 rationale comment', () => {
    expect(rawBody).toMatch(/REQ-0246/)
  })

  it('still awaits run.promise + refreshes state (core install flow intact)', () => {
    expect(codeBody).toMatch(/await run\.promise/)
    expect(codeBody).toMatch(/await refresh\(\)/)
  })
})

describe('REQ-0246 gpu-tool-manager: explicit user select paths are untouched', () => {
  const src = readFileSync(GPU_TOOL_MANAGER_PATH, 'utf-8')

  it('handleSelectGpu still exists and calls selectAccelerator("gpu")', () => {
    const body = extractFunctionBody(src, 'handleSelectGpu')
    expect(body).toMatch(/selectAccelerator\(\s*['"]gpu['"]\s*\)/)
  })

  it('handleSelectCpu still exists and calls selectAccelerator("cpu")', () => {
    const body = extractFunctionBody(src, 'handleSelectCpu')
    expect(body).toMatch(/selectAccelerator\(\s*['"]cpu['"]\s*\)/)
  })
})

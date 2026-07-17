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
 * The REQ-0246/0247 rationale comments deliberately mention the
 * removed function/literal names (e.g. "selectAccelerator('gpu')",
 * "'migrated-from-whisper-model'") to document what was taken out.
 * A regex over the raw source would false-positive on those.  Strip
 * both `//` line comments and JSDoc / slash-star block comments so
 * we match executable code only.
 */
function stripLineComments(body: string): string {
  // Block comments first — do it naively but safely: greedy match
  // won't help since our sources have many `/* */` blocks; use a
  // non-greedy multi-line regex.  `[\s\S]*?` matches across newlines
  // without needing the `s` flag.
  const noBlocks = body.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlocks
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

/**
 * REQ-0247 — the auto-select survivor lived on the main side, not
 * the renderer.  These tests source-pin the removal of the
 * "migrated-from-whisper-model" branch in `resolve-active-model.ts`
 * and the paired persistence call in `buildModelsState` (which had
 * silently written `settings.activeModelId = migrated` right after
 * the DL-completion refresh, causing the just-downloaded model to
 * appear as "使用中" without user consent).
 *
 * These complement `resolve-active-model.test.ts` (which pins the
 * behavioural contract) with a structural pin so a future
 * "just re-add the shortcut" refactor doesn't sneak the branch back
 * in without the behavioural test failing loudly.
 */
const RESOLVE_MODEL_PATH = join(
  __dirname,
  '../../src/main/services/resolve-active-model.ts',
)
const TRANSCRIPTION_IPC_PATH = join(
  __dirname,
  '../../src/main/ipc/transcription.ts',
)

describe('REQ-0247 resolve-active-model.ts: whisperModel migration branch removed', () => {
  const src = readFileSync(RESOLVE_MODEL_PATH, 'utf-8')
  const codeSrc = stripLineComments(src)

  it("the source union no longer includes 'migrated-from-whisper-model'", () => {
    // The type union in the file drives caller-side branch handling.
    // If a refactor sneaks the literal back into `source: 'kept' |
    // 'corrected-null' | ...`, this test fires.
    expect(codeSrc).not.toMatch(/'migrated-from-whisper-model'/)
  })

  it("no code path returns source: 'migrated-from-whisper-model'", () => {
    // Both the union and the return statements were removed.  The
    // rationale comment (in raw source) mentions the string but with
    // line comments stripped it's gone from executable code.
    expect(codeSrc).not.toMatch(/source:\s*['"]migrated-from-whisper-model['"]/)
  })

  it('still exports resolveActiveModelId and the ResolveActiveModelIdResult shape', () => {
    // The function and type keep the same names — only branches
    // change.  Callers (`buildModelsState`) rely on this.
    expect(codeSrc).toMatch(/export function resolveActiveModelId/)
    expect(codeSrc).toMatch(/export interface ResolveActiveModelIdResult/)
  })

  it('rationale comment mentions REQ-0247 (removal is intentional, findable)', () => {
    expect(src).toMatch(/REQ-0247/)
  })
})

describe('REQ-0247 ipc/transcription.ts buildModelsState: no migration-triggered persist', () => {
  const src = readFileSync(TRANSCRIPTION_IPC_PATH, 'utf-8')
  const codeSrc = stripLineComments(src)

  it("does NOT branch on source === 'migrated-from-whisper-model'", () => {
    // The paired persist call inside buildModelsState fired only when
    // the migration branch returned.  Both are removed together.
    expect(codeSrc).not.toMatch(/migrated-from-whisper-model/)
  })

  it('rationale comment mentions REQ-0247', () => {
    // The removal reason is documented near the corrected-null branch
    // so contributors reading buildModelsState see why the migration
    // fallback was dropped.
    expect(src).toMatch(/REQ-0247/)
  })

  it('setActiveModel IPC handler is still present (explicit selection still works)', () => {
    // The handler at Channels.transcriptionSetActiveModel is what
    // handleActivate ("Use this") ultimately reaches.  Removing the
    // auto-select does NOT remove explicit selection.
    expect(codeSrc).toMatch(/transcriptionSetActiveModel/)
    expect(codeSrc).toMatch(/settings\.activeModelId = modelId/)
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { generateAss } from '../../src/main/services/ass-generator'

/**
 * REQ-0344 §2-2 — `generateAss` must not default `karaokeStyle` or `isMsix`.
 *
 * ## The bug this closes
 *
 * `frame-exporter.ts` called `generateAss` with six arguments.  The seventh,
 * `karaokeStyle`, defaulted — so a still export was written with whatever the
 * writer's own default happened to be, while the burn-in used the value it was
 * handed.  Nothing failed, because omitting an argument that has a default is
 * legal (RES-0340 §6-2).
 *
 * That is the SECOND time this exact default hid a bug.  The first was
 * REQ-0320 §1: the renderer stopped sending the value, every call still
 * compiled, and every burn-in silently rendered a karaoke style the user had
 * not chosen — for a whole release cycle.  REQ-0321 §1 closed that one at the
 * IPC layer with a mapped type over `BurninOptions`; it could not close this
 * one, because the frame exporter does not go through that payload builder.
 *
 * ## Why arity, and why this is the right layer
 *
 * `Function.prototype.length` counts parameters before the first defaulted
 * one, so it states exactly "these seven cannot be omitted" and fails the
 * moment somebody re-adds `= KARAOKE_STYLE_DEFAULT`.  Asserting on emitted
 * output would not catch it: a re-added default is only observable from a
 * caller that omits the argument, and after this REQ every caller passes it.
 *
 * `isMsix` is in the same boat by necessity — TypeScript forbids a required
 * parameter after an optional one — and by merit: defaulting it to `false`
 * means "silently render as the free tier", which is the same failure wearing
 * a different hat.
 *
 * Note this file does NOT assert that the two production call sites pass the
 * same VALUE.  They should not have to: `karaokeStyle` is only the fallback
 * for cues that carry no `entry.karaokeStyle`, and what each caller considers
 * the right fallback is its own business.  What matters is that each states
 * one.
 */
const SRC = path.resolve(__dirname, '../../src/main/services/ass-generator.ts')

describe('REQ-0344 §2-2 — karaokeStyle and isMsix have no defaults', () => {
  it('all seven parameters of generateAss are required', () => {
    expect(generateAss.length).toBe(7)
  })

  it('the source declares no default for karaokeStyle or isMsix', () => {
    // Arity alone cannot tell "required" from "someone reordered the
    // parameters", so read the declarations too.
    const src = readFileSync(SRC, 'utf8')
    expect(src).toContain('karaokeStyle: KaraokeStyle,')
    expect(src).not.toMatch(/karaokeStyle: KaraokeStyle\s*=/)
    expect(src).toContain('isMsix: boolean,')
    expect(src).not.toMatch(/isMsix: boolean\s*=/)
  })

  it('both production call sites pass a karaokeStyle argument', () => {
    // The frame exporter is the one that was missing it.  Pinning both means
    // a future call site copied from either one starts from a correct shape.
    for (const rel of [
      'src/main/services/ffmpeg-burnin.ts',
      'src/main/services/frame-exporter.ts',
    ]) {
      const src = readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
      expect(src, `${rel} calls generateAss`).toMatch(/generateAss\(/)
      expect(src, `${rel} passes karaokeStyle`).toMatch(/karaokeStyle/)
    }
  })

  it('the frame-export IPC request requires karaokeStyle, so the renderer must send one', () => {
    // `export-frame-button.tsx` builds its request as a hand-written object
    // literal — there is no `BURNIN_FIELD_DISPOSITION` equivalent guarding it,
    // so requiredness on the contract is what forces the field to be supplied.
    const contracts = readFileSync(
      path.resolve(__dirname, '../../src/shared/ipc-contracts.ts'),
      'utf8',
    )
    const block = contracts.slice(
      contracts.indexOf('export interface ExportFrameRequest'),
      contracts.indexOf('export interface ExportFrameResult'),
    )
    expect(block).toContain('karaokeStyle: KaraokeStyle')
    expect(block).not.toContain('karaokeStyle?:')
  })
})

# `tests/measure/` — measurement harnesses, NOT gates

Everything in this directory **reports numbers**. Nothing here fails a build.

## Why it exists (REQ-0506 §3)

CLAUDE.md §18 separates *tools that measure* from *gates that block*. Two files
had drifted onto the wrong side of that line: they lived in `tests/e2e/`, ran
under `npm run test:e2e`, and therefore read as gates — while proving nothing.

- `list-virtualization.measure.ts` (was `tests/e2e/list-virtualization-perf.spec.ts`)
  contained **zero `expect()` calls** — it did not even import `expect`. It could
  only fail by crashing. The invariant it appears to guard (DOM size must not
  grow with entry count) is genuinely gated by
  **`tests/e2e/list-node-budget.spec.ts`**, which remains a gate.
- `timeline-geometry.measure.ts` (was `tests/e2e/timeline-budget.spec.ts`) had
  six assertions, but against a **synthetic replica**: a hand-written
  `innerHTML` string with the block's classes copied onto it, sized by a
  hardcoded `220`. Changing the real `TIME_ROW_MIN_BLOCK_WIDTH_PX` did not
  affect it. One assertion — `rowWidthPx ≈ 220 - 16` — tested the browser's
  `box-sizing: border-box`, not the app. Two of its four sections had no
  assertions at all.

Both were **design-time measurements** (REQ-071 Phase 4-2/4-3 used them to pick
`TIME_ROW_MIN_BLOCK_WIDTH_PX = 220`, REQ-0345 to size the list budget). That is
a legitimate and useful thing to be. It was only the location that lied.

## What was NOT done, and why

They were not converted into gates. A real gate for the timecode budget would
have to measure a **rendered `Block`** against the **imported** constant — that
is a new gate, not a repair of this one, and REQ-0506 scoped this work to
relocating them. If someone writes it later, the measurement below is the right
starting point.

## Running them

They are excluded from `npm run test:e2e` twice over: `playwright.config.ts`
has `testDir: './tests/e2e'`, and the `.measure.ts` suffix does not match
Playwright's default `*.spec.ts` / `*.test.ts` pattern either.

They therefore need their own entry point (`playwright.measure.config.ts`):

```
npm run measure:timeline
npm run measure:list
```

Requires `npm run build` first, like every Playwright spec here.

> The first draft of this README told you to run them with the main config.
> That does not work — the suffix does not match — and shipping an instruction
> that fails would have been the same species of false claim this whole REQ is
> about. Verified: both commands above run.

## If you add a file here

Ask CLAUDE.md §18's question — *would I write this again next time I add a
similar feature?* If yes it belongs in `scripts/` or here. If it should **block**
a regression, it belongs in `tests/` with an assertion and a negative control.

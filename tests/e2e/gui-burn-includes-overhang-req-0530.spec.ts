/**
 * REQ-0530 §3 — the GUI burn now renders a cue that overhangs the end of the
 * video, and the pixels prove it.
 *
 * This drives the REAL GUI path end to end: the renderer's own
 * `isBurninTarget` filter in `burnin-drawer.tsx`, the real burn IPC, real
 * ffmpeg + libass, then the output frames are decoded and measured. Only ONE
 * thing is stubbed — `dialog.showSaveDialog` in the MAIN process, because a
 * native modal cannot be clicked from a test. The renderer is untouched, so the
 * decision under test (which cues get sent) is made by production code.
 *
 * The clip is solid navy and the caption is white, so "is a cue on screen at
 * time t" reduces to "are there near-white pixels" — the method REQ-0468 and
 * REQ-0529 established, and the reason a `testsrc` clip must NOT be used here
 * (its colour bars contain white; that produced a false pass in REQ-0529).
 *
 * NEGATIVE CONTROL (§3-1, CLAUDE.md §18 — no `git checkout`): the same project
 * is burned a second time with the PRE-REQ-0530 filter applied to the store
 * first, reproducing the old behaviour in place. That output must be blank at
 * 6 s. Perturbing the one decision, with everything else production code.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import { spawnSync, execFileSync } from 'child_process'
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const FFMPEG = path.join(ROOT, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')

/** Fraction of near-white pixels in the frame at `t` (= caption ink). */
function whiteFractionAt(video: string, t: number, work: string): number {
  const raw = path.join(work, `f-${String(t).replace('.', '_')}-${path.basename(video)}.rgb`)
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(t), '-i', video,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw])
  const buf = readFileSync(raw)
  let white = 0
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) white++
  }
  return white / (buf.length / 3)
}

interface TestHandle {
  project: {
    getState: () => { entries: Record<string, unknown>[]; video: Record<string, unknown> | null }
    setState: (s: unknown) => void
  }
  ui: { setState: (s: unknown) => void }
}

test('the GUI burn includes a cue that overhangs the end of the video — REQ-0530', async () => {
  test.setTimeout(300_000)
  const work = mkdtempSync(path.join(tmpdir(), 'mojioko-0530-e2e-'))
  const clip = path.join(work, 'seven.mp4')
  // 7 s, solid navy. `h264_mf` (Media Foundation), NOT libx264 — the bundled
  // ffmpeg is an LGPL build and has no libx264, so that encoder silently
  // produces no file.
  spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=640x360:rate=30:duration=7',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-c:v', 'h264_mf', '-c:a', 'aac', '-shortest', clip],
    { encoding: 'utf-8' })
  expect(existsSync(clip), 'fixture clip was not produced').toBe(true)

  // `electron .` with cwd=ROOT, not `electron out/main/index.js`: the bundled
  // ffmpeg/ffprobe are resolved relative to the app path, and the latter form
  // looks for them under out/main/ and fails with ENOENT.
  const electronApp = await electron.launch({ args: ['.'], cwd: ROOT, timeout: 30_000 })
  const window = await electronApp.firstWindow()
  const indexFile = path.join(ROOT, 'out/renderer/index.html').split(path.sep).join('/')
  await window.goto('file:///' + indexFile + '?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1600, 900)
  })

  /** Burn the current store contents through the GUI and return the output. */
  async function burnViaGui(outName: string): Promise<string> {
    const outPath = path.join(work, outName)
    // The ONLY stub: the native save modal, replaced in the main process.
    await electronApp.evaluate(async ({ dialog }, target) => {
      ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () =>
        ({ canceled: false, filePath: target })
    }, outPath)

    // Footer 動画出力 opens the drawer…
    await window.locator('button', { hasText: '動画出力' }).first().click()
    await window.waitForTimeout(1500)
    /*
     * …and the drawer's own confirm button is clicked by scoping INSIDE the
     * drawer. It cannot be found by label alone: depending on the drawer's
     * state it reads either 書き出し開始 or 動画出力 (the latter deliberately
     * mirrors the footer, REQ-20260615-024 A.4), so a global label lookup
     * either misses it or re-clicks the footer.
     */
    const drawer = window.locator('[role="dialog"]')
    await expect(drawer, 'the burn drawer did not open').toBeVisible({ timeout: 10_000 })
    const confirm = drawer.locator('button').filter({ hasText: /書き出し開始|動画出力/ }).last()
    await expect(confirm, 'the drawer has no enabled confirm button — is activeEntries empty?')
      .toBeEnabled({ timeout: 10_000 })
    await confirm.click()

    // Wait for ffmpeg to finish writing.
    for (let i = 0; i < 120; i++) {
      await window.waitForTimeout(1000)
      if (existsSync(outPath)) {
        const a = readFileSync(outPath).length
        await window.waitForTimeout(1200)
        if (existsSync(outPath) && readFileSync(outPath).length === a && a > 0) break
      }
    }
    if (!existsSync(outPath)) {
      // Diagnostics before failing: a silent no-file is usually the drawer
      // showing an error, or the save-dialog stub not intercepting.
      const diag = await window.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]') as HTMLElement | null
        return {
          drawerText: dlg ? (dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 500) : '(no dialog)',
          bodyTail: (document.body.innerText || '').replace(/\s+/g, ' ').slice(-400),
        }
      })
      // eslint-disable-next-line no-console
      console.log('\n[REQ-0530] burn diagnostics:', JSON.stringify(diag, null, 2))
    }
    expect(existsSync(outPath), `GUI burn produced no file at ${outPath}`).toBe(true)
    // Close the drawer for the next run.
    await window.keyboard.press('Escape')
    await window.waitForTimeout(600)
    return outPath
  }

  // Probe first: the mojioko-media:// protocol only serves allowlisted paths,
  // and a successful probe is what allowlists them.
  const probed = await window.evaluate(async (p: string) => {
    const r = await (window as unknown as {
      electronAPI: { videoProbe: (x: string) => Promise<{ ok: boolean; data?: Record<string, unknown> }> }
    }).electronAPI.videoProbe(p)
    if (!r?.ok || !r.data) return null
    ;(window as unknown as { __probedVideo?: unknown }).__probedVideo = r.data
    return { durationSec: r.data.durationSec as number, audioTracks: (r.data.audioTracks as unknown[]).length }
  }, clip)
  expect(probed, 'probe failed — the fixture video is unreadable').not.toBeNull()
  expect((probed as { durationSec: number }).durationSec).toBe(7)
  /*
   * ★ The fixture has exactly ONE audio track, and that is stated rather than
   * assumed (CLAUDE.md §18 "環境を仮定したアサーションを書かない"). The burn maps
   * `amix=inputs=N` from `video.audioTracks.length`, so seeding the demo
   * fixture's multi-track list over a single-track file makes ffmpeg map a
   * stream that does not exist and exit -22 — which is exactly what happened on
   * the first run of this test, and the same trap REQ-0516 documents.
   * The PROBED VideoInfo is used below instead of a hand-spliced one.
   */
  expect((probed as { audioTracks: number }).audioTracks,
    'the fixture should have exactly one audio track').toBe(1)

  /** Seed four cues covering every case this REQ touches. */
  async function seed(applyPreFixFilter: boolean) {
    await window.evaluate(({ preFix }: { preFix: boolean }) => {
      const t = (window as unknown as { __mojioko_test: TestHandle }).__mojioko_test
      let e = t.project.getState().entries.map((x) => ({ ...x }))
      const set = (i: number, patch: Record<string, unknown>) => {
        e[i] = { ...e[i], isDeleted: false, layer: 0, fontSizePx: 96, ...patch }
      }
      set(0, { startSec: 1, endSec: 3, text: 'INRANGE' })
      set(1, { startSec: 5, endSec: 16, text: 'OVERHANG' })   // straddles the 7 s end
      set(2, { startSec: 20, endSec: 25, text: 'PASTEND' })   // entirely beyond
      set(3, { startSec: 1.2, endSec: 2.8, text: 'DELETED', isDeleted: true })
      for (let i = 4; i < e.length; i++) e[i] = { ...e[i], isDeleted: true }

      if (preFix) {
        // NEGATIVE CONTROL — reproduce the pre-REQ-0530 filter by removing what
        // it removed, before the drawer ever sees the entries. Nothing is
        // checked out and no source is swapped; the one decision is perturbed.
        const dur = 7
        e = e.filter((x) => x.isDeleted || !((x.startSec as number) > dur || (x.endSec as number) > dur))
      }

      // The real probed VideoInfo — NOT the demo fixture with a new path, so
      // audioTracks / codec / container all describe the file actually on disk.
      const probedVideo = (window as unknown as { __probedVideo: Record<string, unknown> }).__probedVideo
      t.project.setState({
        entries: e,
        cuts: [],
        video: probedVideo,
        videoLoadingState: 'loaded',
      })
      t.ui.setState({ editorViewMode: 'list', selectedEntryId: null })
    }, { preFix: applyPreFixFilter })
    await window.waitForTimeout(1500)
  }

  // --- the fix ---------------------------------------------------------------
  await seed(false)
  const fixed = await burnViaGui('gui-fixed.mp4')
  const fixedAt = {
    inRange: whiteFractionAt(fixed, 2.0, work),
    overhang: whiteFractionAt(fixed, 6.0, work),
    late: whiteFractionAt(fixed, 6.8, work),
    gap: whiteFractionAt(fixed, 4.0, work),
  }
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0530] GUI burn (fixed):', JSON.stringify(fixedAt))

  expect(fixedAt.overhang,
    'the GUI burn has no caption at 6 s — the overhanging cue is still being dropped, ' +
    'which is exactly what REQ-0530 removes').toBeGreaterThan(0.001)
  expect(fixedAt.late, 'the overhanging cue must stay on screen to the end of the video').toBeGreaterThan(0.001)
  // ★ both sides: the in-range cue still burns, and a genuinely empty stretch
  // is still empty — so this is not "every frame has ink".
  expect(fixedAt.inRange, 'the ordinary in-range cue stopped burning').toBeGreaterThan(0.001)
  expect(fixedAt.gap, 'a stretch with no cue must stay blank').toBe(0)

  // --- the negative control --------------------------------------------------
  await seed(true)
  const before = await burnViaGui('gui-prefix.mp4')
  const beforeAt = {
    inRange: whiteFractionAt(before, 2.0, work),
    overhang: whiteFractionAt(before, 6.0, work),
  }
  // eslint-disable-next-line no-console
  console.log('[REQ-0530] GUI burn (pre-fix control):', JSON.stringify(beforeAt))

  expect(beforeAt.inRange, 'the control removed too much — even the in-range cue is gone').toBeGreaterThan(0.001)
  expect(beforeAt.overhang,
    'the pre-fix control still shows a caption at 6 s, so it is no longer reproducing ' +
    'the old behaviour and this gate proves nothing').toBe(0)

  await electronApp.close()
})

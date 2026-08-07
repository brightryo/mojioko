/**
 * REQ-0450 §2 — in-memory async job store for long-running MCP tools.
 *
 * transcribe / translate / burn / run / tools_download take minutes and would
 * blow past an MCP client's request timeout. They return a `job_id` immediately;
 * the work runs in the resident MCP process and the client polls
 * `get_job_status`. Jobs live for the server's lifetime (a set of a few is fine).
 *
 * REQ-0457 B5 — progress is split into `stage` + `stageProgress` (0–100 within
 * the current stage) + `overallProgress` (0–100 across the whole job, MONOTONIC
 * non-decreasing).  A multi-stage `run` used to report 0→99 for transcribe then
 * 0→99 for burn on ONE `progress` field, so an agent saw it jump backwards
 * (0→99→5→100, reproduced twice).  `overallProgress` never goes down.
 * B6 — jobs can be listed and cancelled.
 */
import type { CliResult } from '../cli/output'

export type JobStatus = 'running' | 'done' | 'failed' | 'canceled'

export interface Job {
  id: string
  tool: string
  status: JobStatus
  /** Current stage name (the tool, or a sub-step of `run`). */
  stage: string
  /** Progress within the current stage, 0–100. */
  stageProgress: number
  /** Progress across the whole job, 0–100, monotonic non-decreasing. */
  overallProgress: number
  result: CliResult | null
  startedAt: number
  endedAt: number | null
  /** REQ-0457 B6 — set when a cancel was requested; the runner aborts. */
  canceled: boolean
  cancel: (() => void) | null
}

const jobs = new Map<string, Job>()
let seq = 0

export function createJob(tool: string): Job {
  const id = `job-${++seq}`
  const job: Job = {
    id, tool, status: 'running', stage: tool, stageProgress: 0, overallProgress: 0,
    result: null, startedAt: Date.now(), endedAt: null, canceled: false, cancel: null,
  }
  jobs.set(id, job)
  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

/** REQ-0457 B6 — every job, newest first (for the `list_jobs` tool). */
export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/** Register the abort hook a running job exposes (so `cancel_job` can stop it). */
export function setJobCancel(id: string, cancel: () => void): void {
  const j = jobs.get(id)
  if (j && j.status === 'running') j.cancel = cancel
}

/**
 * REQ-0457 B5 — update the job's stage + progress.  `overallProgress` is clamped
 * to never decrease, so an agent polling never sees it move backwards.
 */
export function updateJobStage(id: string, stage: string, stageProgress: number, overallProgress: number): void {
  const j = jobs.get(id)
  if (!j || j.status !== 'running') return
  j.stage = stage
  j.stageProgress = Math.max(0, Math.min(100, Math.round(stageProgress)))
  j.overallProgress = Math.max(j.overallProgress, Math.max(0, Math.min(100, Math.round(overallProgress))))
}

export function finishJob(id: string, result: CliResult): void {
  const j = jobs.get(id)
  if (!j) return
  // A cancel that already flipped the status wins over a late result.
  if (j.status === 'canceled') return
  j.status = result.ok ? 'done' : 'failed'
  j.result = result
  if (result.ok) { j.stageProgress = 100; j.overallProgress = 100 }
  j.endedAt = Date.now()
}

/** REQ-0457 B6 — request cancellation; returns false if not cancellable. */
export function cancelJob(id: string): boolean {
  const j = jobs.get(id)
  if (!j || j.status !== 'running') return false
  j.canceled = true
  j.status = 'canceled'
  j.endedAt = Date.now()
  try { j.cancel?.() } catch { /* best-effort abort */ }
  return true
}

/** A client-facing snapshot (no internal fields beyond what's useful). */
export function jobSnapshot(job: Job): Record<string, unknown> {
  return {
    job_id: job.id,
    tool: job.tool,
    status: job.status,
    stage: job.stage,
    stageProgress: job.stageProgress,
    overallProgress: job.overallProgress,
    // Back-compat: keep `progress` as the overall value for older clients.
    progress: job.overallProgress,
    elapsedSec: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
    result: job.result,
  }
}

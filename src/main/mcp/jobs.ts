/**
 * REQ-0450 §2 — in-memory async job store for long-running MCP tools.
 *
 * transcribe / translate / burn / run / tools_download take minutes and would
 * blow past an MCP client's request timeout. They return a `job_id` immediately;
 * the work runs in the resident MCP process and the client polls
 * `get_job_status`. Jobs live for the server's lifetime (a set of a few is fine).
 */
import type { CliResult } from '../cli/output'

export type JobStatus = 'running' | 'done' | 'failed'

export interface Job {
  id: string
  tool: string
  status: JobStatus
  progress: number
  result: CliResult | null
  startedAt: number
  endedAt: number | null
}

const jobs = new Map<string, Job>()
let seq = 0

export function createJob(tool: string): Job {
  const id = `job-${++seq}`
  const job: Job = { id, tool, status: 'running', progress: 0, result: null, startedAt: Date.now(), endedAt: null }
  jobs.set(id, job)
  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function setJobProgress(id: string, percent: number): void {
  const j = jobs.get(id)
  if (j && j.status === 'running') j.progress = Math.max(0, Math.min(100, Math.round(percent)))
}

export function finishJob(id: string, result: CliResult): void {
  const j = jobs.get(id)
  if (!j) return
  j.status = result.ok ? 'done' : 'failed'
  j.result = result
  j.progress = result.ok ? 100 : j.progress
  j.endedAt = Date.now()
}

/** A client-facing snapshot (no internal fields beyond what's useful). */
export function jobSnapshot(job: Job): Record<string, unknown> {
  return {
    job_id: job.id,
    tool: job.tool,
    status: job.status,
    progress: job.progress,
    elapsedSec: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
    result: job.result,
  }
}

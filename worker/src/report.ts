// worker/src/report.ts
// Run ledger + alerting. Every scheduled run records a job_runs row so a failed
// or stuck pipeline SURFACES on the dashboard banner. On failure we also POST to
// an optional webhook so it reaches you before you open the dashboard.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from './db'

export type RunStatus = 'ok' | 'error' | 'yielded'

export async function recordRun(
  db: SupabaseClient,
  job: 'seal' | 'sweep',
  status: RunStatus,
  fields: { ran_on?: string; detail?: unknown } = {},
): Promise<void> {
  const { error } = await db.from('job_runs').insert({
    job,
    status,
    ran_on: fields.ran_on ?? null,
    detail: (fields.detail ?? null) as any,
    finished_at: new Date().toISOString(),
  })
  // Never let ledger-write failure mask the real run outcome — log and move on.
  if (error) console.error(`job_runs insert (${job}/${status}) failed:`, error.message)
}

/** Fire-and-forget alert to ALERT_WEBHOOK_URL (if configured). No-ops when unset. */
export async function sendAlert(env: Env, payload: Record<string, unknown>): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'csc-sales-dashboard-worker', ...payload }),
    })
  } catch (err) {
    console.error('alert webhook failed:', err)
  }
}

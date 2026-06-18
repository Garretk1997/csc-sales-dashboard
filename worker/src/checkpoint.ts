// worker/src/checkpoint.ts
// Cursor checkpoint for the sweep. Instead of re-walking a fixed 2h window of
// conversations every 15 min (hundreds of subrequests), fetch only since the
// last SUCCESSFUL sweep. This keeps subrequests-per-tick roughly constant with
// cadence rather than growing with history.
//
// Self-healing: if recent sweeps failed (no 'ok' row), the window naturally
// widens to cover the gap — but it is CAPPED so a long outage doesn't trigger an
// unbounded re-walk that would itself blow the subrequest limit. Gaps beyond the
// cap are the documented manual catch-up (and surface RED on the health banner).
import type { SupabaseClient } from '@supabase/supabase-js'

export interface CheckpointOpts {
  defaultMs?: number // first run / no prior success
  overlapMs?: number // re-fetch a little before the last success (clock skew, in-flight)
  capMs?: number // never look back further than this
}

export async function resolveSweepSince(
  db: SupabaseClient,
  now: number,
  opts: CheckpointOpts = {},
): Promise<{ sinceMs: number; basis: 'cursor' | 'default'; windowMin: number }> {
  const defaultMs = opts.defaultMs ?? 2 * 60 * 60 * 1000 // 2h
  const overlapMs = opts.overlapMs ?? 5 * 60 * 1000 // 5m
  // 3h cap: measured ~13 base + 3 req/min, so a 3h catch-up ≈ 550 subrequests —
  // safely under the Paid 1000 cap. A longer gap is the documented manual catch-up.
  const capMs = opts.capMs ?? 3 * 60 * 60 * 1000 // 3h

  const { data, error } = await db
    .from('job_runs')
    .select('started_at')
    .eq('job', 'sweep')
    .eq('status', 'ok')
    .order('started_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`checkpoint read: ${error.message}`)

  const lastOk = data?.[0]?.started_at ? Date.parse(data[0].started_at) : null
  let sinceMs: number
  let basis: 'cursor' | 'default'
  if (lastOk && Number.isFinite(lastOk)) {
    sinceMs = lastOk - overlapMs
    basis = 'cursor'
  } else {
    sinceMs = now - defaultMs
    basis = 'default'
  }
  // bound the lookback so a long outage can't trigger an unbounded re-walk
  sinceMs = Math.max(sinceMs, now - capMs)
  return { sinceMs, basis, windowMin: Math.round((now - sinceMs) / 60000) }
}

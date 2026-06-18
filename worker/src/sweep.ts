// worker/src/sweep.ts
import { createDb, type Env } from './db'
import { fetchCallsSince } from './ghl'
import { normalizeApiCall } from './normalize'

export async function runSweep(env: Env, sinceMs = Date.now() - 2 * 60 * 60 * 1000): Promise<{ ingested: number; late: number }> {
  const db = createDb(env)
  // sinceMs comes from the cursor checkpoint (last successful sweep − overlap), so each
  // tick only fetches messages since the last run instead of re-walking the full window.
  // Falls back to a rolling 2h window if no checkpoint is provided.
  const raw = await fetchCallsSince(env, sinceMs)
  const events = raw.map(normalizeApiCall).filter((e) => e.callSid)

  // sealed_days read happens here — as late as possible, immediately before the fresh/late
  // partition — to minimise the window of the seal/sweep race described below.
  //
  // RESIDUAL RACE (documented; not fixed here):
  // If a sweep reads sealed_days microseconds before the 3am seal job marks yesterday as sealed,
  // then upserts call_events after the seal has already read call_events, a yesterday-call can
  // land in call_events that is neither captured in daily_sealed (seal already ran) nor in
  // late_events (sweep saw it as "fresh"). The production fix is cron sequencing or a DB advisory
  // lock so the seal does not run while a sweep is in flight. That is a deploy-time task and is
  // NOT implemented here.
  //
  // Bound to recent 45 days: PostgREST has a 1000-row default cap; an unbounded select would
  // silently drop the most-recent sealed days after ~1000 sealed dates (~2.7 years), breaking
  // late-diversion. Since the sweep window is ≤2h, only very recent sealed days matter.
  const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10) // YYYY-MM-DD
  const { data: sealed, error: sealErr } = await db
    .from('sealed_days')
    .select('seal_date_et')
    .gte('seal_date_et', fortyFiveDaysAgo)
  if (sealErr) throw new Error(`sealed_days read failed: ${sealErr.message}`)
  const sealedSet = new Set((sealed ?? []).map((r: any) => r.seal_date_et))

  const fresh = events.filter((e) => !sealedSet.has(e.occurredOn))
  const late = events.filter((e) => sealedSet.has(e.occurredOn))

  if (fresh.length) {
    // API-sweep wins: upsert overwrites any prior (e.g. webhook) row on call_sid.
    const { error } = await db.from('call_events').upsert(
      fresh.map((e) => ({
        call_sid: e.callSid, ghl_message_id: e.ghlMessageId,
        occurred_at: e.occurredAt, occurred_on: e.occurredOn,
        owner_user_id: e.ownerUserId, duration_seconds: e.durationSeconds,
        status: e.status, direction: e.direction,
        source: e.source, provisional: e.provisional, updated_at: new Date().toISOString(),
      })),
      { onConflict: 'call_sid' },
    )
    if (error) throw new Error(`call_events upsert: ${error.message}`)
  }
  if (late.length) {
    const { error: lateErr } = await db.from('late_events').insert(
      late.map((e) => ({ belongs_to_date_et: e.occurredOn, payload: e as any, reason: 'post_seal_api_sweep' })),
    )
    if (lateErr) throw new Error(`late_events insert: ${lateErr.message}`)
  }
  return { ingested: fresh.length, late: late.length }
}

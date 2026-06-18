// worker/src/sweep.ts
import { createDb, type Env } from './db'
import { fetchCallsSince } from './ghl'
import { normalizeApiCall } from './normalize'

export async function runSweep(env: Env): Promise<{ ingested: number; late: number }> {
  const db = createDb(env)
  // Window: last 30h covers today + the pre-seal tail of yesterday.
  const sinceMs = Date.now() - 30 * 60 * 60 * 1000
  const raw = await fetchCallsSince(env, sinceMs)
  const events = raw.map(normalizeApiCall).filter((e) => e.callSid)

  const { data: sealed, error: sealErr } = await db.from('sealed_days').select('seal_date_et')
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

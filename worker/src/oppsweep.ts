// worker/src/oppsweep.ts
import { createDb, type Env } from './db'
import { loadRegistry } from './pipelines'
import { fetchActiveOpps } from './opps'
import { classifyClose, isOpenInRevenue } from './closes'

export async function runOppSweep(env: Env, sinceMs = Date.now() - 2 * 60 * 60 * 1000): Promise<{ snapshots: number; closes: number; late: number }> {
  const db = createDb(env)
  const reg = await loadRegistry(env)
  // sinceMs from the cursor checkpoint (shared with the call sweep). Falls back to 2h.
  const opps = await fetchActiveOpps(env, reg.revenuePipelineIds, sinceMs)

  // 1. snapshot open opps
  const open = opps.filter((o) => isOpenInRevenue(o, reg))
  if (open.length) {
    const { error } = await db.from('opp_snapshots').upsert(open.map((o) => ({
      opp_id: String(o.id), owner_user_id: o.assignedTo ?? null, pipeline_id: o.pipelineId,
      stage_id: o.pipelineStageId, monetary_value: Number(o.monetaryValue ?? 0), last_seen_open_at: new Date().toISOString(),
    })), { onConflict: 'opp_id' })
    if (error) throw new Error(`opp_snapshots upsert: ${error.message}`)
  }

  // 2. detect closes among win/loss opps not already recorded
  const terminal = opps.filter((o) => reg.winStageIds.has(o.pipelineStageId) || reg.lossStageIds.has(o.pipelineStageId))
  const ids = terminal.map((o) => String(o.id))
  const { data: existing, error: exErr } = await db.from('close_events').select('opp_id').in('opp_id', ids.length ? ids : ['__none__'])
  if (exErr) throw new Error(`close_events read: ${exErr.message}`)
  const seen = new Set((existing ?? []).map((r: any) => r.opp_id))
  const fresh = terminal.filter((o) => !seen.has(String(o.id)))

  // prior snapshots for owner-at-close
  const freshIds = fresh.map((o) => String(o.id))
  const { data: snaps, error: snErr } = await db.from('opp_snapshots').select('opp_id, owner_user_id').in('opp_id', freshIds.length ? freshIds : ['__none__'])
  if (snErr) throw new Error(`opp_snapshots read: ${snErr.message}`)
  const priorBy = new Map((snaps ?? []).map((r: any) => [r.opp_id, r]))

  const { data: sealed, error: sealErr } = await db.from('sealed_days').select('seal_date_et').gte('seal_date_et', new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString().slice(0, 10))
  if (sealErr) throw new Error(`sealed_days read: ${sealErr.message}`)
  const sealedSet = new Set((sealed ?? []).map((r: any) => r.seal_date_et))

  const events = fresh.map((o) => classifyClose(o, reg, priorBy.get(String(o.id)) ?? null)).filter(Boolean) as any[]
  const freshEv = events.filter((e) => !sealedSet.has(e.occurredOn))
  const lateEv = events.filter((e) => sealedSet.has(e.occurredOn))

  if (freshEv.length) {
    const { error } = await db.from('close_events').upsert(freshEv.map((e) => ({
      opp_id: e.oppId, occurred_at: e.occurredAt, occurred_on: e.occurredOn,
      pipeline_id: e.pipelineId, stage_id: e.stageId, stage_name: e.stageName, outcome: e.outcome,
      owner_user_id: e.ownerUserId, owner_confidence: e.ownerConfidence,
      monetary_value: e.monetaryValue, value_confidence: e.valueConfidence, source: e.source,
    })), { onConflict: 'opp_id' })
    if (error) throw new Error(`close_events upsert: ${error.message}`)
  }
  if (lateEv.length) {
    const { error } = await db.from('late_events').insert(lateEv.map((e) => ({ belongs_to_date_et: e.occurredOn, payload: e, reason: 'post_seal_close' })))
    if (error) throw new Error(`late_events insert: ${error.message}`)
  }
  return { snapshots: open.length, closes: freshEv.length, late: lateEv.length }
}

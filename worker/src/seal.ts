// worker/src/seal.ts
import { createDb, type Env } from './db'
import { easternDateString, previousEasternDate } from './time'

const ANSWERED = new Set(['completed'])

export type SealedRow = {
  seal_date_et: string; owner_user_id: string; role: string
  calls: number; answered: number; talk_time_seconds: number
}

/** Pure: roll per-rep call metrics for one sealed Eastern day. Role is 'setter'
 *  for Stream 1 (calls are setter activity); Stream 2 adds booking/close roles. */
export function aggregateDay(events: any[], sealDate: string): SealedRow[] {
  const byOwner = new Map<string, SealedRow>()
  for (const e of events) {
    const owner = e.owner_user_id
    if (!owner) continue // unattributable -> cannot enter the record
    const row = byOwner.get(owner) ?? {
      seal_date_et: sealDate, owner_user_id: owner, role: 'setter',
      calls: 0, answered: 0, talk_time_seconds: 0,
    }
    row.calls += 1
    if (ANSWERED.has(e.status)) row.answered += 1
    row.talk_time_seconds += Number(e.duration_seconds ?? 0)
    byOwner.set(owner, row)
  }
  return [...byOwner.values()]
}

/** Freeze yesterday (ET). Idempotent: refuses to re-seal an already-sealed day. */
export async function runSeal(env: Env): Promise<{ sealDate: string; rows: number }> {
  const db = createDb(env)
  const sealDate = previousEasternDate(easternDateString(new Date()))

  const { data: already } = await db.from('sealed_days').select('seal_date_et').eq('seal_date_et', sealDate)
  if (already && already.length) return { sealDate, rows: 0 } // immutable: never re-seal

  const { data: events, error } = await db.from('call_events').select('*').eq('occurred_on', sealDate)
  if (error) throw new Error(`seal read: ${error.message}`)

  const rows = aggregateDay(events ?? [], sealDate)
  if (rows.length) {
    const { error: insErr } = await db.from('daily_sealed').insert(rows)
    if (insErr) throw new Error(`daily_sealed insert: ${insErr.message}`)
  }
  // Mark the day frozen LAST: any sweep landing after this diverts to late_events.
  const { error: sdErr } = await db.from('sealed_days').insert({ seal_date_et: sealDate })
  if (sdErr) throw new Error(`sealed_days insert: ${sdErr.message}`)
  return { sealDate, rows: rows.length }
}

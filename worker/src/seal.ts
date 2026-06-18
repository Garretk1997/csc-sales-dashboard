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

export type CloserRow = {
  seal_date_et: string; owner_user_id: string; role: 'closer'
  closes_won: number; closes_lost: number; dollars_recorded: number
  closes_value_missing: number; closes_owner_inferred: number
}

export function aggregateClosesDay(events: any[], sealDate: string): CloserRow[] {
  const by = new Map<string, CloserRow>()
  for (const e of events) {
    const owner = e.owner_user_id
    if (!owner) continue
    const r = by.get(owner) ?? { seal_date_et: sealDate, owner_user_id: owner, role: 'closer',
      closes_won: 0, closes_lost: 0, dollars_recorded: 0, closes_value_missing: 0, closes_owner_inferred: 0 }
    if (e.outcome === 'won') {
      r.closes_won += 1
      if (e.value_confidence === 'recorded') r.dollars_recorded += Number(e.monetary_value ?? 0)
      else r.closes_value_missing += 1
    } else if (e.outcome === 'lost') r.closes_lost += 1
    if (e.owner_confidence === 'inferred') r.closes_owner_inferred += 1
    by.set(owner, r)
  }
  return [...by.values()]
}

/** Freeze yesterday (ET). Idempotent: refuses to re-seal an already-sealed day. */
export async function runSeal(env: Env): Promise<{ sealDate: string; rows: number }> {
  const db = createDb(env)
  const sealDate = previousEasternDate(easternDateString(new Date()))

  const { data: already, error: sealCheckErr } = await db.from('sealed_days').select('seal_date_et').eq('seal_date_et', sealDate)
  if (sealCheckErr) throw new Error(`sealed_days check: ${sealCheckErr.message}`)
  if (already && already.length) return { sealDate, rows: 0 } // immutable: never re-seal

  // PostgREST caps a single .select() at 1000 rows by default.  A busy day
  // (e.g. 1939 call_events) would produce a partial, immutable sealed record.
  // Page through all rows in batches of 1000 so the seal is always complete.
  const PAGE = 1000
  const events: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('call_events')
      .select('*')
      .eq('occurred_on', sealDate)
      .order('call_sid', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`seal read (offset ${from}): ${error.message}`)
    const batch = data ?? []
    events.push(...batch)
    if (batch.length < PAGE) break
  }

  const setterRows = aggregateDay(events, sealDate)

  // paginated read of close_events for sealDate (mirror the call_events PAGE loop)
  const closeEvents: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('close_events').select('*').eq('occurred_on', sealDate).order('opp_id', { ascending: true }).range(from, from + 999)
    if (error) throw new Error(`seal close read (offset ${from}): ${error.message}`)
    const batch = data ?? []; closeEvents.push(...batch)
    if (batch.length < 1000) break
  }
  const closerRows = aggregateClosesDay(closeEvents, sealDate)

  // Single atomic insert: both setter and closer rows together.
  // A multi-row INSERT is all-or-nothing — if it throws, daily_sealed stays
  // empty for this day and the next retry recomputes + reinserts with no PK collision.
  const allRows = [...setterRows, ...closerRows]
  if (allRows.length) {
    const { error } = await db.from('daily_sealed').insert(allRows)
    if (error) throw new Error(`daily_sealed insert: ${error.message}`)
  }

  // Mark the day frozen LAST: any sweep landing after this diverts to late_events.
  const { error: sdErr } = await db.from('sealed_days').insert({ seal_date_et: sealDate })
  if (sdErr) throw new Error(`sealed_days insert: ${sdErr.message}`)
  return { sealDate, rows: allRows.length }
}

// One-off backfill: seal a SPECIFIC past Eastern date that never sealed.
// Mirrors runSeal() exactly but takes the date as an arg (runSeal only does
// "yesterday"). Reuses the REAL aggregate functions so there is zero divergence
// from the production seal logic. Dry-run by default; pass --commit to write.
//
//   npx tsx backfill-seal.ts 2026-06-18           # dry-run, prints numbers
//   npx tsx backfill-seal.ts 2026-06-18 --commit  # writes the immutable seal
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { aggregateDay, aggregateClosesDay } from './src/seal'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

const sealDate = process.argv[2]
const commit = process.argv.includes('--commit')
if (!/^\d{4}-\d{2}-\d{2}$/.test(sealDate ?? '')) { console.error('usage: backfill-seal.ts YYYY-MM-DD [--commit]'); process.exit(1) }

async function pageAll(table: string, dateCol: string, orderCol: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select('*').eq(dateCol, sealDate).order(orderCol, { ascending: true }).range(from, from + 999)
    if (error) throw new Error(`${table} read (offset ${from}): ${error.message}`)
    const batch = data ?? []; out.push(...batch)
    if (batch.length < 1000) break
  }
  return out
}

async function main() {
  const { data: already, error: chk } = await db.from('sealed_days').select('seal_date_et').eq('seal_date_et', sealDate)
  if (chk) throw new Error(`sealed_days check: ${chk.message}`)
  if (already && already.length) { console.log(`[${sealDate}] ALREADY SEALED — refusing to re-seal (immutable). Nothing to do.`); return }

  const calls = await pageAll('call_events', 'occurred_on', 'call_sid')
  const closes = await pageAll('close_events', 'occurred_on', 'opp_id')
  const setterRows = aggregateDay(calls, sealDate)
  const closerRows = aggregateClosesDay(closes, sealDate)
  const allRows = [...setterRows, ...closerRows]

  const totals = setterRows.reduce((a, r) => ({ calls: a.calls + r.calls, answered: a.answered + r.answered, talk: a.talk + r.talk_time_seconds }), { calls: 0, answered: 0, talk: 0 })
  const cTotals = closerRows.reduce((a, r) => ({ won: a.won + r.closes_won, lost: a.lost + r.closes_lost, dollars: a.dollars + r.dollars_recorded, missing: a.missing + r.closes_value_missing }), { won: 0, lost: 0, dollars: 0, missing: 0 })

  console.log(`\n===== BACKFILL ${sealDate} (${commit ? 'COMMIT' : 'DRY-RUN'}) =====`)
  console.log(`call_events: ${calls.length} rows | close_events: ${closes.length} rows`)
  console.log(`setter rows: ${setterRows.length} reps | calls=${totals.calls} answered=${totals.answered} talk=${totals.talk}s`)
  console.log(`closer rows: ${closerRows.length} reps | won=${cTotals.won} lost=${cTotals.lost} $recorded=${cTotals.dollars} value_missing=${cTotals.missing}`)
  console.log(`total daily_sealed rows to insert: ${allRows.length}`)

  if (!commit) { console.log(`\nDRY-RUN — nothing written. Re-run with --commit to seal.`); return }
  if (allRows.length) {
    const { error } = await db.from('daily_sealed').insert(allRows)
    if (error) throw new Error(`daily_sealed insert: ${error.message}`)
  }
  const { error: sdErr } = await db.from('sealed_days').insert({ seal_date_et: sealDate })
  if (sdErr) throw new Error(`sealed_days insert: ${sdErr.message}`)
  console.log(`\nSEALED ${sealDate}: ${allRows.length} rows written + sealed_days marked.`)
}
main().catch((e) => { console.error('BACKFILL FAILED:', e.message); process.exit(1) })

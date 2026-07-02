// worker/local-catchup.ts
//
// Local (no-subrequest-cap) pipeline catch-up for dark-out recovery.
//   npx tsx local-catchup.ts <sinceIso> [--commit]
//
// Runs the same runSweep/runOppSweep/runApptSweep the worker runs, but from
// Node, where Cloudflare's per-invocation subrequest cap does not apply — the
// documented escape when the capped 3h cursor window cannot reach back across
// a long dark-out. Takes the pipeline lock via the same RPCs so live cron
// ticks yield while this runs, and records an 'ok' sweep run at the end so
// the cursor checkpoint advances and the crash loop ends.
//
// Env (names only, source them in the shell before running): GHL_PIT,
// GHL_LOCATION_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY.

import { createDb, type Env } from './src/db'
import { runSweep } from './src/sweep'
import { runOppSweep } from './src/oppsweep'
import { runApptSweep } from './src/apptsweep'
import { recordRun } from './src/report'

const sinceIso = process.argv[2]
const commit = process.argv.includes('--commit')
if (!sinceIso || !Number.isFinite(Date.parse(sinceIso))) {
  console.error('usage: npx tsx local-catchup.ts <sinceIso> [--commit]')
  process.exit(1)
}
const sinceMs = Date.parse(sinceIso)

const env: Env = {
  GHL_PIT: process.env.GHL_PIT ?? '',
  GHL_LOCATION_ID: process.env.GHL_LOCATION_ID ?? '',
  SUPABASE_URL: process.env.SUPABASE_URL ?? '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? '',
}
for (const [k, v] of Object.entries(env)) if (!v) { console.error(`missing env ${k}`); process.exit(1) }

const HOLDER = `local-catchup-${process.pid}`

async function main() {
  if (!commit) {
    console.log(`DRY RUN: would catch up from ${sinceIso} (${Math.round((Date.now() - sinceMs) / 60000)} min window). Re-run with --commit.`)
    return
  }
  const db = createDb(env)

  // Take the pipeline lock (steal only when expired — same contract as the worker).
  let got = false
  for (let i = 0; i < 60; i++) {
    const { data, error } = await db.rpc('try_acquire_lock', { p_name: 'pipeline', p_holder: HOLDER, p_ttl_sec: 1800 })
    if (error) throw new Error(`try_acquire_lock: ${error.message}`)
    if (data === true) { got = true; break }
    console.log('lock held (a live tick is in flight or hung) — retrying in 20s')
    await new Promise((r) => setTimeout(r, 20000))
  }
  if (!got) throw new Error('could not acquire pipeline lock')

  try {
    console.log(`catching up since ${sinceIso}`)
    const s = await runSweep(env, sinceMs)
    console.log('calls:', JSON.stringify(s))
    const o = await runOppSweep(env, sinceMs)
    console.log('opps:', JSON.stringify(o))
    // Drain the appointment backlog: repeated passes until nothing is deferred.
    let a
    for (let pass = 1; pass <= 20; pass++) {
      a = await runApptSweep(env)
      console.log(`appts pass ${pass}:`, JSON.stringify(a))
      if (!a.appts_deferred) break
    }
    await recordRun(db, 'sweep', 'ok', { detail: { ...s, ...o, ...a, basis: 'local_catchup', window_min: Math.round((Date.now() - sinceMs) / 60000) } })
    console.log('recorded ok run — cursor advanced, crash loop should end')
  } finally {
    await db.rpc('release_lock', { p_name: 'pipeline', p_holder: HOLDER })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })

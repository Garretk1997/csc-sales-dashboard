// worker/src/index.ts
import { createDb, type Env } from './db'
import { runSweep } from './sweep'
import { runSeal } from './seal'
import { syncUsers } from './roster'
import { runOppSweep } from './oppsweep'
import { acquireForSeal, tryAcquireLock, releaseLock, SWEEP_TTL_SEC } from './locks'
import { recordRun, sendAlert } from './report'
import { resolveSweepSince } from './checkpoint'
import { resetSubrequests, subrequestCount } from './subreq'

const SEAL_CRON = '5 7 * * *' // ~03:05 ET — roster sync then seal, ALONE
const SWEEP_CRON = '*/15 * * * *'
const MAX_FORCED_MIN = 180 // forced ?minutes window is clamped to the same 3h cap as the cursor

// Constant-time string compare so the HTTP trigger's secret check doesn't leak
// timing. Length mismatch returns false fast (the secret is high-entropy).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// One pipeline tick (sweep or seal). Shared by the Cloudflare cron AND the HTTP
// trigger below, so an EXTERNAL scheduler can drive the pipeline when Cloudflare's
// own cron stalls (it intermittently stops firing for this worker). Idempotent +
// lock-guarded, so an external ping overlapping a real cron is safe.
async function runTick(env: Env, cron: string, opts?: { sinceMs?: number }): Promise<void> {
  const db = createDb(env)
  const holder = crypto.randomUUID()

  if (cron === SEAL_CRON) {
      // SEAL: acquire the pipeline lock with priority. acquireForSeal waits out an
      // in-flight sweep (so its yesterday rows get sealed) and steals an expired
      // crashed-sweep lock — then the seal runs with NO sweep writing concurrently.
      const got = await acquireForSeal(db, holder)
      if (!got) {
        await recordRun(db, 'seal', 'error', { detail: { message: 'could not acquire pipeline lock within wait budget' } })
        await sendAlert(env, { level: 'error', job: 'seal', message: 'seal could not acquire lock — pipeline may be stuck' })
        throw new Error('seal: could not acquire pipeline lock')
      }
      try {
        // Roster refresh is non-fatal: a user-fetch hiccup must never lose a day's seal.
        try {
          await syncUsers(env)
        } catch (err) {
          console.error('syncUsers failed (non-fatal, seal continues):', err)
        }
        const res = await runSeal(env)
        await recordRun(db, 'seal', 'ok', { ran_on: res.sealDate, detail: { rows: res.rows } })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await recordRun(db, 'seal', 'error', { detail: { message } })
        await sendAlert(env, { level: 'error', job: 'seal', message })
        throw err // surface to Cloudflare logs too
      } finally {
        await releaseLock(db, holder)
      }
      return
    }

    // SWEEP: must NOT write while the seal holds the lock. Yield (record + return)
    // if the lock is held — the next sweep is 15 min away, and any yesterday-call
    // that lands during the seal is caught post-seal and diverted to late_events.
    const got = await tryAcquireLock(db, holder, SWEEP_TTL_SEC)
    if (!got) {
      await recordRun(db, 'sweep', 'yielded', { detail: { reason: 'pipeline lock held (seal or prior sweep in flight)' } })
      return
    }
    try {
      resetSubrequests()
      // cursor checkpoint: fetch only since the last successful sweep (− overlap),
      // bounded so a long outage can't trigger an unbounded re-walk. A forced
      // sinceMs (HTTP trigger ?minutes=N) overrides it — used to escape a stuck
      // catch-up that exceeds the subrequest cap after a long dark-out.
      const forced = opts?.sinceMs
      const { sinceMs, basis, windowMin } =
        forced != null
          ? { sinceMs: forced, basis: "forced", windowMin: Math.round((Date.now() - forced) / 60000) }
          : await resolveSweepSince(db, Date.now())
      const s = await runSweep(env, sinceMs)
      const o = await runOppSweep(env, sinceMs)
      await recordRun(db, 'sweep', 'ok', { detail: { ...s, ...o, requests: subrequestCount(), window_min: windowMin, basis } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await recordRun(db, 'sweep', 'error', { detail: { message, requests: subrequestCount() } })
      await sendAlert(env, { level: 'error', job: 'sweep', message })
      throw err
    } finally {
      await releaseLock(db, holder)
    }
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await runTick(env, event.cron)
  },

  // Secret-gated HTTP trigger so an external scheduler (cron-job.org / GitHub
  // Action / Vercel Cron) can run a tick when Cloudflare's cron stalls.
  //   GET /?key=<TRIGGER_SECRET>           -> sweep
  //   GET /?key=<TRIGGER_SECRET>&job=seal  -> seal
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const key = url.searchParams.get('key') ?? req.headers.get('x-trigger-key') ?? ''
    if (!env.TRIGGER_SECRET || !safeEqual(key, env.TRIGGER_SECRET)) {
      return new Response('forbidden\n', { status: 403 })
    }
    const cron = url.searchParams.get('job') === 'seal' ? SEAL_CRON : SWEEP_CRON
    const raw = Number(url.searchParams.get('minutes'))
    // clamp the manual catch-up window so a fat-fingered ?minutes can't blow the
    // subrequest cap and crash mid-sweep (the orphaned-lock scenario).
    const minutes = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_FORCED_MIN) : 0
    const opts = minutes > 0 ? { sinceMs: Date.now() - minutes * 60000 } : undefined
    try {
      await runTick(env, cron, opts)
      return new Response('ok\n')
    } catch (err) {
      return new Response(`error: ${err instanceof Error ? err.message : String(err)}\n`, { status: 500 })
    }
  },
}

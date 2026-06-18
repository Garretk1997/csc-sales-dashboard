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

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const db = createDb(env)
    const holder = crypto.randomUUID()

    if (event.cron === SEAL_CRON) {
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
      // bounded so a long outage can't trigger an unbounded re-walk.
      const { sinceMs, basis, windowMin } = await resolveSweepSince(db, Date.now())
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
  },
}

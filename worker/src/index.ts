// worker/src/index.ts
import type { Env } from './db'
import { runSweep } from './sweep'
import { runSeal } from './seal'
import { syncUsers } from './roster'

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // "5 7 * * *" (UTC) ~= 03:05 ET -> roster sync then seal. Everything else -> sweep.
    if (event.cron === '5 7 * * *') {
      // Refresh the owner-validation roster before sealing. A roster-sync failure must NOT
      // block the seal — log and continue so daily stats are never lost over a user-fetch hiccup.
      try {
        await syncUsers(env)
      } catch (err) {
        console.error('syncUsers failed (non-fatal, seal continues):', err)
      }
      await runSeal(env)
    } else {
      await runSweep(env)
    }
  },
}

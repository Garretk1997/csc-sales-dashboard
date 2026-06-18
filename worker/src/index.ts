// worker/src/index.ts
import type { Env } from './db'
import { runSweep } from './sweep'
import { runSeal } from './seal'

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // "5 7 * * *" (UTC) ~= 03:05 ET -> seal. Everything else -> sweep.
    if (event.cron === '5 7 * * *') await runSeal(env)
    else await runSweep(env)
  },
}

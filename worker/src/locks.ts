// worker/src/locks.ts
// TTL mutex so the seal runs ALONE. Backed by job_locks + the try_acquire_lock /
// release_lock RPCs (migration 0003). A dead holder auto-releases on TTL expiry,
// so a crashed seal can never freeze the pipeline permanently.
import type { SupabaseClient } from '@supabase/supabase-js'

export const LOCK_NAME = 'pipeline'
// Real sweeps finish in ~2-3 min; 5 min TTL covers a crashed sweep auto-releasing.
export const SWEEP_TTL_SEC = 300
// Seal finishes in <1 min and releases via finally; 30 min TTL is the hard backstop
// if it crashes without releasing.
export const SEAL_TTL_SEC = 1800
// Seal waits this long to acquire: outlasts a live sweep (~3 min) and steals an
// expired crashed-sweep lock (TTL 5 min) — both inside this window.
export const SEAL_ACQUIRE_MAX_WAIT_MS = 360_000
const SEAL_ACQUIRE_STEP_MS = 8_000

export async function tryAcquireLock(db: SupabaseClient, holder: string, ttlSec: number): Promise<boolean> {
  const { data, error } = await db.rpc('try_acquire_lock', { p_name: LOCK_NAME, p_holder: holder, p_ttl_sec: ttlSec })
  if (error) throw new Error(`try_acquire_lock: ${error.message}`)
  return data === true
}

export async function releaseLock(db: SupabaseClient, holder: string): Promise<void> {
  const { error } = await db.rpc('release_lock', { p_name: LOCK_NAME, p_holder: holder })
  if (error) console.error('release_lock failed (will auto-expire on TTL):', error.message)
}

/** Seal-priority acquire: retry until acquired or the wait budget runs out. */
export async function acquireForSeal(db: SupabaseClient, holder: string): Promise<boolean> {
  const deadline = Date.now() + SEAL_ACQUIRE_MAX_WAIT_MS
  for (;;) {
    if (await tryAcquireLock(db, holder, SEAL_TTL_SEC)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, SEAL_ACQUIRE_STEP_MS))
  }
}

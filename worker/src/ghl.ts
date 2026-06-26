// worker/src/ghl.ts
import type { Env } from './db'
import { bumpSubrequest } from './subreq'

const BASE = 'https://services.leadconnectorhq.com'
const VERSION = '2021-07-28'

function headers(pit: string) {
  return { Authorization: `Bearer ${pit}`, Version: VERSION, Accept: 'application/json' }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Parse a Retry-After header value (seconds string or HTTP-date) into a
 * positive finite number of seconds. Returns `fallback` if the value is
 * absent, non-finite, zero, or negative — so the caller always sleeps at
 * least `fallback` seconds after a 429.
 */
export function parseRetryAfter(raw: string | null, fallback = 11): number {
  if (raw === null) return fallback
  // Capped at 60s: honor reasonable server guidance but never park a tick long
  // enough to overrun the next cron or let the sweep lock TTL expire mid-flight.
  const CAP = 60
  // Try numeric first (most common: "30", "0")
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(numeric, CAP)
  // Try HTTP-date (e.g. "Wed, 18 Jun 2026 12:00:00 GMT")
  const date = Date.parse(raw)
  if (Number.isFinite(date)) {
    const seconds = (date - Date.now()) / 1000
    if (seconds > 0) return Math.min(seconds, CAP)
  }
  return fallback
}

async function getJson(env: Env, path: string, params: Record<string, string>): Promise<any> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(130) // ~8 rps ceiling, shared 100/10s window
    bumpSubrequest()
    const res = await fetch(url, { headers: headers(env.GHL_PIT) })
    if (res.status === 200) return res.json()
    if (res.status === 429) {
      await sleep(parseRetryAfter(res.headers.get('retry-after')) * 1000)
      continue
    }
    if ([500, 502, 503, 504].includes(res.status)) { await sleep(600 + 500 * attempt); continue }
    // GHL intermittently returns 401 on a VALID token — a transient auth check
    // under load that succeeds on immediate retry (proven: conversations that 401
    // return 200 on the very next call). Treat 401/403 as retryable. Without this,
    // a single transient 401 thrown mid-sweep aborts the ENTIRE fetchCallsSince and
    // the whole 15-min tick ingests 0 calls — the root cause of the post-2026-06-17
    // call under-capture (sealed 28/14/1/77 vs the real thousands). A genuinely
    // revoked token still exhausts all attempts and throws.
    if (res.status === 401 || res.status === 403) { await sleep(500 + 400 * attempt); continue }
    throw new Error(`GET ${path} -> ${res.status}`)
  }
  throw new Error(`GET ${path} exhausted retries`)
}

/**
 * Yields every TYPE_CALL message in a conversation.
 *
 * Response shape (proven from Python etl/catalog.py `iter_call_messages`):
 *   resp.messages            → outer object
 *   resp.messages.messages[] → array of individual message objects
 *   resp.messages.nextPage   → boolean, true when more pages exist
 *   resp.messages.lastMessageId → cursor for the next page fetch
 *
 * The array branch (`Array.isArray(block)`) has been removed. The GHL API
 * returns the object shape consistently; keeping a dead array branch caused
 * silent single-paging because `nextPage`/`lastMessageId` would be undefined.
 */
async function* iterCallMessages(env: Env, conversationId: string): AsyncGenerator<any> {
  let lastMessageId: string | undefined
  for (let guard = 0; guard < 50; guard++) {
    const params: Record<string, string> = { limit: '100' }
    if (lastMessageId) params.lastMessageId = lastMessageId
    const resp = await getJson(env, `/conversations/${conversationId}/messages`, params)
    // Proven shape: resp.messages is the envelope object
    const block = resp?.messages ?? {}
    const arr: any[] = block.messages ?? []
    if (arr.length === 0) break
    for (const m of arr) if (m?.messageType === 'TYPE_CALL') yield m
    const next = block?.nextPage, newLast = block?.lastMessageId
    if (!next || !newLast || newLast === lastMessageId) break
    lastMessageId = newLast
  }
}

/** All TYPE_CALL messages with dateAdded >= sinceMs. Walks recent conversations,
 *  short-circuiting once a conversation's lastMessageDate falls before the window. */
export async function fetchCallsSince(env: Env, sinceMs: number): Promise<any[]> {
  const out: any[] = []
  let cursor: string | undefined
  for (let page = 0; page < 1000; page++) {
    const params: Record<string, string> = { locationId: env.GHL_LOCATION_ID, limit: '100' }
    if (cursor) params.startAfterDate = cursor
    const prevCursor = cursor
    const resp = await getJson(env, '/conversations/search', params)
    const convs: any[] = resp?.conversations ?? []
    if (convs.length === 0) break // 200 + empty list = true end
    let allBeforeWindow = true
    for (const c of convs) {
      // Advance cursor only when sort[0] is a usable string value.
      // If sort is absent or empty, leave cursor unchanged — we detect
      // non-progress below and break rather than loop infinitely.
      const sortVal = (c?.sort ?? [])[0]
      if (sortVal !== undefined && sortVal !== null) cursor = String(sortVal)
      if ((c?.lastMessageDate ?? 0) < sinceMs) continue
      allBeforeWindow = false
      try {
        for await (const m of iterCallMessages(env, c.id)) {
          const ts = Date.parse(m?.dateAdded ?? '')
          if (Number.isFinite(ts) && ts >= sinceMs) out.push(m)
        }
      } catch (err) {
        // Safety net: with 401/403 now retried in getJson, an exception here means a
        // conversation is genuinely stuck (exhausted retries / non-retryable status).
        // Skipping it (and logging) is better than letting one bad conversation throw
        // and abort the whole sweep — which would drop EVERY other conversation's
        // calls this tick and (on repeated failure) freeze ingestion entirely.
        console.error(`fetchCallsSince: skipping conversation ${c.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Cursor stall guard: if the cursor did not advance after a full page,
    // we cannot paginate further — break rather than re-fetch the same page
    // and drain the shared PIT quota.
    if (cursor === prevCursor) break
    // NOTE: confirm in Task 1 whether /conversations/search returns recent-first.
    // If it does, this early-stop is safe; if not, remove it and filter the full page set.
    if (allBeforeWindow && page > 0) break
  }
  return out
}

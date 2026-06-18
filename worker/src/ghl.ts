// worker/src/ghl.ts
import type { Env } from './db'

const BASE = 'https://services.leadconnectorhq.com'
const VERSION = '2021-07-28'

function headers(pit: string) {
  return { Authorization: `Bearer ${pit}`, Version: VERSION, Accept: 'application/json' }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getJson(env: Env, path: string, params: Record<string, string>): Promise<any> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(130) // ~8 rps ceiling, shared 100/10s window
    const res = await fetch(url, { headers: headers(env.GHL_PIT) })
    if (res.status === 200) return res.json()
    if (res.status === 429) { await sleep(Number(res.headers.get('retry-after') ?? 11) * 1000); continue }
    if ([500, 502, 503, 504].includes(res.status)) { await sleep(600 + 500 * attempt); continue }
    throw new Error(`GET ${path} -> ${res.status}`)
  }
  throw new Error(`GET ${path} exhausted retries`)
}

async function* iterCallMessages(env: Env, conversationId: string): AsyncGenerator<any> {
  let lastMessageId: string | undefined
  for (let guard = 0; guard < 50; guard++) {
    const params: Record<string, string> = { limit: '100' }
    if (lastMessageId) params.lastMessageId = lastMessageId
    const resp = await getJson(env, `/conversations/${conversationId}/messages`, params)
    const block = resp?.messages ?? {}
    const arr: any[] = Array.isArray(block) ? block : (block.messages ?? [])
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
    const resp = await getJson(env, '/conversations/search', params)
    const convs: any[] = resp?.conversations ?? []
    if (convs.length === 0) break // 200 + empty list = true end
    let allBeforeWindow = true
    for (const c of convs) {
      cursor = (c?.sort ?? [cursor])[0]
      if ((c?.lastMessageDate ?? 0) < sinceMs) continue
      allBeforeWindow = false
      for await (const m of iterCallMessages(env, c.id)) {
        const ts = Date.parse(m?.dateAdded ?? '')
        if (Number.isFinite(ts) && ts >= sinceMs) out.push(m)
      }
    }
    // NOTE: confirm in Task 1 whether /conversations/search returns recent-first.
    // If it does, this early-stop is safe; if not, remove it and filter the full page set.
    if (allBeforeWindow && page > 0) break
  }
  return out
}

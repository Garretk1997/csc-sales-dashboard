// worker/src/roster.ts
import { createDb, type Env } from './db'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function syncUsers(env: Env): Promise<number> {
  // GHL intermittently 401/403s a valid token and 429/5xxs under load — retry,
  // so a single transient blip on seal night doesn't stale the roster (and with
  // it the owner/role attribution for that day's seal). Same discipline as ghl.ts.
  const url = `https://services.leadconnectorhq.com/users/?locationId=${env.GHL_LOCATION_ID}`
  const headers = { Authorization: `Bearer ${env.GHL_PIT}`, Version: '2021-07-28', Accept: 'application/json' }
  let res: Response | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, { headers })
    if (res.status === 200) break
    if ([401, 403, 429, 500, 502, 503, 504].includes(res.status)) { await sleep(500 + 400 * attempt); continue }
    throw new Error(`users fetch -> ${res.status}`)
  }
  if (!res || res.status !== 200) throw new Error(`users fetch -> ${res?.status ?? 'no response'} (exhausted retries)`)
  const users: any[] = (await res.json() as { users?: any[] })?.users ?? []
  // Pagination guard: the endpoint is not paginated in normal use (~32 users), but if a future
  // location grows and the API silently truncates at a page boundary this will surface it.
  if (users.length >= 100) {
    console.warn(`syncUsers: received ${users.length} users — /users/ may be paginated and silently truncated; verify roster completeness`)
  }
  const db = createDb(env)
  const rows = users.map((u) => ({
    ghl_user_id: String(u.id),
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || null,
    email: u.email ?? null,
    active: true, // present in the live location = active; offboarded users 404 and won't appear
    updated_at: new Date().toISOString(),
  }))
  const { error } = await db.from('users').upsert(rows, { onConflict: 'ghl_user_id' })
  if (error) throw new Error(`users upsert: ${error.message}`)
  return rows.length
}

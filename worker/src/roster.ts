// worker/src/roster.ts
import { createDb, type Env } from './db'

export async function syncUsers(env: Env): Promise<number> {
  const res = await fetch(
    `https://services.leadconnectorhq.com/users/?locationId=${env.GHL_LOCATION_ID}`,
    { headers: { Authorization: `Bearer ${env.GHL_PIT}`, Version: '2021-07-28', Accept: 'application/json' } },
  )
  if (!res.ok) throw new Error(`users fetch -> ${res.status}`)
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

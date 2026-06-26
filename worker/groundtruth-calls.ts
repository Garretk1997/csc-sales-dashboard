// One-off ground-truth: pull ALL calls from GHL for a bounded window and count
// distinct calls per Eastern day, to compare GHL reality vs what we sealed.
// Read-only. Wraps global fetch with a network-error retry so a transient blip
// mid-walk doesn't abort the whole thing (getJson only retries on HTTP status).
import { readFileSync } from 'node:fs'

// --- install resilient fetch BEFORE importing the worker client ---
const realFetch = globalThis.fetch
globalThis.fetch = (async (...args: any[]) => {
  for (let i = 1; ; i++) {
    try { return await (realFetch as any)(...args) }
    catch (e: any) {
      if (i >= 6) throw e
      await new Promise((r) => setTimeout(r, 500 * i))
    }
  }
}) as any

const { fetchCallsSince } = await import('./src/ghl')
const { normalizeApiCall } = await import('./src/normalize')

const env: any = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

// start of 2026-06-22 ET (EDT = UTC-4) = 2026-06-22T04:00:00Z (one Monday + after)
const sinceMs = Date.UTC(2026, 5, 22, 4, 0, 0)

const raw = await fetchCallsSince(env, sinceMs)
const seen = new Set<string>()
const byDay = new Map<string, number>()
for (const r of raw) {
  const c = normalizeApiCall(r)
  if (!c.callSid || seen.has(c.callSid)) continue
  seen.add(c.callSid)
  byDay.set(c.occurredOn, (byDay.get(c.occurredOn) ?? 0) + 1)
}
console.log(`\nGHL distinct calls fetched since 2026-06-22 ET: ${seen.size}`)
console.log('=== GHL actual calls per Eastern day ===')
for (const day of [...byDay.keys()].sort()) console.log(`${day} : ${byDay.get(day)}`)

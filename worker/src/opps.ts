// worker/src/opps.ts
import type { Env } from './db'
const BASE = 'https://services.leadconnectorhq.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getJson(env: Env, params: Record<string,string>): Promise<any> {
  const url = `${BASE}/opportunities/search?${new URLSearchParams(params)}`
  for (let a = 0; a < 6; a++) {
    await sleep(130)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.GHL_PIT}`, Version: '2021-07-28', Accept: 'application/json' } })
    if (res.status === 200) return res.json()
    if (res.status === 429) { await sleep(Number(res.headers.get('retry-after') ?? 11) * 1000); continue }
    if ([500,502,503,504].includes(res.status)) { await sleep(600 + 500*a); continue }
    throw new Error(`opp search -> ${res.status}`)
  }
  throw new Error('opp search exhausted retries')
}

function oppActivityMs(o: any): number {
  return Math.max(Date.parse(o?.lastStageChangeAt ?? '') || 0, Date.parse(o?.updatedAt ?? '') || 0)
}

export async function fetchActiveOpps(env: Env, pipelineIds: Set<string>, sinceMs: number): Promise<any[]> {
  const out: any[] = []
  for (const pid of pipelineIds) {
    let startAfter: string | undefined, startAfterId: string | undefined
    for (let page = 0; page < 2000; page++) {
      const params: Record<string,string> = { location_id: env.GHL_LOCATION_ID, pipeline_id: pid, limit: '100' }
      if (startAfter && startAfterId) { params.startAfter = startAfter; params.startAfterId = startAfterId }
      const resp = await getJson(env, params)
      const arr: any[] = resp?.opportunities ?? []
      if (arr.length === 0) break // 200 + empty = true end
      let allBefore = true
      for (const o of arr) { if (oppActivityMs(o) >= sinceMs) { allBefore = false; out.push(o) } }
      const meta = resp?.meta ?? {}
      startAfter = meta.startAfter ? String(meta.startAfter) : undefined
      startAfterId = meta.startAfterId
      if (!meta.nextPage || !startAfter || !startAfterId) break
      if (allBefore && page > 0) break // recent-first: past the window
    }
  }
  return out
}

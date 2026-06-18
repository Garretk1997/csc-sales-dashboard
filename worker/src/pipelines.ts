// worker/src/pipelines.ts
import type { Env } from './db'
import { WIN_STAGE_NAMES, LOSS_STAGE_NAMES } from './config'

export type StageRegistry = {
  winStageIds: Set<string>
  lossStageIds: Set<string>
  stageName: Map<string, string>
  revenuePipelineIds: Set<string>
}

export function buildRegistry(pipelines: any[]): StageRegistry {
  const win = new Set(WIN_STAGE_NAMES), loss = new Set(LOSS_STAGE_NAMES)
  const winStageIds = new Set<string>(), lossStageIds = new Set<string>()
  const stageName = new Map<string, string>(), revenuePipelineIds = new Set<string>()
  for (const p of pipelines ?? []) {
    let isRevenue = false
    for (const s of p?.stages ?? []) {
      stageName.set(s.id, s.name)
      if (win.has(s.name)) { winStageIds.add(s.id); isRevenue = true }
      else if (loss.has(s.name)) { lossStageIds.add(s.id); isRevenue = true }
    }
    if (isRevenue) revenuePipelineIds.add(p.id)
  }
  return { winStageIds, lossStageIds, stageName, revenuePipelineIds }
}

export async function loadRegistry(env: Env): Promise<StageRegistry> {
  const res = await fetch(
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`,
    { headers: { Authorization: `Bearer ${env.GHL_PIT}`, Version: '2021-07-28', Accept: 'application/json' } },
  )
  if (!res.ok) throw new Error(`pipelines fetch -> ${res.status}`)
  const data: any = await res.json()
  return buildRegistry(data?.pipelines ?? [])
}

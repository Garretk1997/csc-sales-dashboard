// worker/src/closes.ts
import { easternDateString } from './time'
import type { StageRegistry } from './pipelines'

export type CloseEvent = {
  oppId: string; occurredAt: string; occurredOn: string
  pipelineId: string; stageId: string; stageName: string
  outcome: 'won' | 'lost'
  ownerUserId: string | null; ownerConfidence: 'confirmed' | 'inferred'
  monetaryValue: number; valueConfidence: 'recorded' | 'missing'
  source: 'api_sweep'
}
export type OppSnapshotRow = { owner_user_id: string | null }

export function isTerminal(opp: any, reg: StageRegistry): boolean {
  const s = opp?.pipelineStageId
  return reg.winStageIds.has(s) || reg.lossStageIds.has(s)
}
export function isOpenInRevenue(opp: any, reg: StageRegistry): boolean {
  return reg.revenuePipelineIds.has(opp?.pipelineId) && !isTerminal(opp, reg)
}

export function classifyClose(opp: any, reg: StageRegistry, prior: OppSnapshotRow | null): CloseEvent | null {
  const sid = opp?.pipelineStageId
  const outcome: 'won' | 'lost' | null = reg.winStageIds.has(sid) ? 'won' : reg.lossStageIds.has(sid) ? 'lost' : null
  if (!outcome) return null
  const occurredAt = String(opp?.lastStageChangeAt ?? '')
  const mv = Number(opp?.monetaryValue ?? 0)
  return {
    oppId: String(opp?.id),
    occurredAt, occurredOn: easternDateString(new Date(occurredAt)),
    pipelineId: String(opp?.pipelineId ?? ''), stageId: String(sid ?? ''), stageName: reg.stageName.get(sid) ?? '',
    outcome,
    ownerUserId: prior ? prior.owner_user_id : (opp?.assignedTo ? String(opp.assignedTo) : null),
    ownerConfidence: prior ? 'confirmed' : 'inferred',
    monetaryValue: mv,
    valueConfidence: outcome === 'won' && mv > 0 ? 'recorded' : 'missing',
    source: 'api_sweep',
  }
}

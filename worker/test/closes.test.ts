import { describe, it, expect } from 'vitest'
import { classifyClose, isOpenInRevenue } from '../src/closes'

const reg = { winStageIds: new Set(['s_won']), lossStageIds: new Set(['s_lost']),
  stageName: new Map([['s_won','Closed Won'],['s_lost','Lost Deal / Not interested'],['s_open','Proposal Sent']]),
  revenuePipelineIds: new Set(['p1']) } as any
const opp = (over: any) => ({ id: 'o1', pipelineId: 'p1', pipelineStageId: 's_won', assignedTo: 'U_now',
  monetaryValue: 20000, lastStageChangeAt: '2026-06-18T02:00:00.000Z', ...over })

describe('classifyClose', () => {
  it('confirmed owner from prior open snapshot; recorded value', () => {
    const ev = classifyClose(opp({}), reg, { owner_user_id: 'U_open' })!
    expect(ev.outcome).toBe('won'); expect(ev.ownerUserId).toBe('U_open'); expect(ev.ownerConfidence).toBe('confirmed')
    expect(ev.monetaryValue).toBe(20000); expect(ev.valueConfidence).toBe('recorded')
    expect(ev.occurredOn).toBe('2026-06-17') // 02:00Z = 22:00 EDT on the 17th
  })
  it('inferred owner (no prior snapshot) falls back to current assignedTo', () => {
    const ev = classifyClose(opp({}), reg, null)!
    expect(ev.ownerUserId).toBe('U_now'); expect(ev.ownerConfidence).toBe('inferred')
  })
  it('won with $0 -> value missing (the hand-moved-card hole)', () => {
    const ev = classifyClose(opp({ monetaryValue: 0 }), reg, { owner_user_id: 'U_open' })!
    expect(ev.valueConfidence).toBe('missing'); expect(ev.monetaryValue).toBe(0)
  })
  it('loss stage -> outcome lost', () => {
    const ev = classifyClose(opp({ pipelineStageId: 's_lost' }), reg, { owner_user_id: 'U_open' })!
    expect(ev.outcome).toBe('lost')
  })
  it('non-terminal stage -> null (not a close)', () => {
    expect(classifyClose(opp({ pipelineStageId: 's_open' }), reg, null)).toBeNull()
  })
  it('isOpenInRevenue: in revenue pipeline, non-terminal stage', () => {
    expect(isOpenInRevenue(opp({ pipelineStageId: 's_open' }), reg)).toBe(true)
    expect(isOpenInRevenue(opp({ pipelineStageId: 's_won' }), reg)).toBe(false)
  })
})

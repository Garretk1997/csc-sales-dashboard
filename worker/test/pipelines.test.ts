import { describe, it, expect } from 'vitest'
import { buildRegistry } from '../src/pipelines'

const PIPELINES = [
  { id: 'p_booked', name: 'Booked Appointments', stages: [
    { id: 's_booked', name: 'Booked Appointment' }, { id: 's_closed', name: 'Closed' },
    { id: 's_lost', name: 'Lost Deal / Not interested' }, { id: 's_broke', name: 'Broke Boi' } ] },
  { id: 'p_webapp', name: 'Webinar Applications', stages: [
    { id: 's_won', name: 'Closed Won' }, { id: 's_cl', name: 'Closed Lost' } ] },
  { id: 'p_sms', name: 'SMS Reactivation', stages: [ { id: 's_imp', name: 'Imported' } ] },
]

describe('buildRegistry', () => {
  it('resolves win/loss names to stage ids across pipelines', () => {
    const r = buildRegistry(PIPELINES)
    expect(r.winStageIds.has('s_closed')).toBe(true)
    expect(r.winStageIds.has('s_won')).toBe(true)
    expect(r.lossStageIds.has('s_lost')).toBe(true)
    expect(r.lossStageIds.has('s_broke')).toBe(true)
    expect(r.lossStageIds.has('s_cl')).toBe(true)
  })
  it('marks only pipelines containing a win/loss stage as revenue pipelines', () => {
    const r = buildRegistry(PIPELINES)
    expect(r.revenuePipelineIds.has('p_booked')).toBe(true)
    expect(r.revenuePipelineIds.has('p_webapp')).toBe(true)
    expect(r.revenuePipelineIds.has('p_sms')).toBe(false) // no win/loss stage
  })
  it('does not confuse "Closed" with "Closed Won"/"Closed Lost" (exact match)', () => {
    const r = buildRegistry(PIPELINES)
    expect(r.winStageIds.has('s_won')).toBe(true)   // Closed Won is win
    expect(r.winStageIds.has('s_cl')).toBe(false)   // Closed Lost is NOT win
    expect(r.stageName.get('s_closed')).toBe('Closed')
  })
})

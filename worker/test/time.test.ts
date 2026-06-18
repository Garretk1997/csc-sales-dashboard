import { describe, it, expect } from 'vitest'
import { easternDateString, previousEasternDate } from '../src/time'

describe('eastern day helpers', () => {
  it('stamps a UTC instant to its Eastern calendar date', () => {
    // 2026-06-17T03:30:00Z is 2026-06-16 23:30 EDT -> still the 16th in ET
    expect(easternDateString(new Date('2026-06-17T03:30:00Z'))).toBe('2026-06-16')
  })
  it('handles the EDT/EST boundary via IANA, not a fixed offset', () => {
    // 2026-01-17T04:30:00Z is 2026-01-16 23:30 EST -> the 16th
    expect(easternDateString(new Date('2026-01-17T04:30:00Z'))).toBe('2026-01-16')
  })
  it('returns the previous calendar date', () => {
    expect(previousEasternDate('2026-06-17')).toBe('2026-06-16')
    expect(previousEasternDate('2026-03-01')).toBe('2026-02-28')
  })
})

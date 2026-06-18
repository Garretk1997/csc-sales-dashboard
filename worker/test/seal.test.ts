import { describe, it, expect } from 'vitest'
import { aggregateDay } from '../src/seal'

const ev = (owner: string, dur: number, status: string) => ({
  owner_user_id: owner, duration_seconds: dur, status, occurred_on: '2026-06-16',
})

describe('aggregateDay', () => {
  it('rolls calls/answered/talk-time per rep for the sealed day', () => {
    const rows = aggregateDay(
      [ev('A', 91, 'completed'), ev('A', 0, 'no-answer'), ev('B', 40, 'completed')],
      '2026-06-16',
    )
    const a = rows.find((r) => r.owner_user_id === 'A')!
    expect(a).toMatchObject({ seal_date_et: '2026-06-16', role: 'setter', calls: 2, answered: 1, talk_time_seconds: 91 })
    expect(rows.find((r) => r.owner_user_id === 'B')!.calls).toBe(1)
  })
  it('drops events with no owner (cannot attribute to the record)', () => {
    const rows = aggregateDay([{ owner_user_id: null, duration_seconds: 10, status: 'completed', occurred_on: '2026-06-16' }], '2026-06-16')
    expect(rows).toHaveLength(0)
  })
})

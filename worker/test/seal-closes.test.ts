import { describe, it, expect } from 'vitest'
import { aggregateClosesDay } from '../src/seal'

const ev = (over: any) => ({ owner_user_id: 'A', outcome: 'won', monetary_value: 0,
  owner_confidence: 'confirmed', value_confidence: 'missing', occurred_on: '2026-06-17', ...over })

describe('aggregateClosesDay', () => {
  it('rolls wins/losses/$ and the confidence holes per rep', () => {
    const rows = aggregateClosesDay([
      ev({ owner_user_id: 'A', outcome: 'won', monetary_value: 20000, value_confidence: 'recorded' }),
      ev({ owner_user_id: 'A', outcome: 'won', monetary_value: 0, value_confidence: 'missing' }),
      ev({ owner_user_id: 'A', outcome: 'lost' }),
      ev({ owner_user_id: 'B', outcome: 'won', monetary_value: 10000, value_confidence: 'recorded', owner_confidence: 'inferred' }),
    ], '2026-06-17')
    const a = rows.find((r) => r.owner_user_id === 'A')!
    expect(a).toMatchObject({ role: 'closer', closes_won: 2, closes_lost: 1, dollars_recorded: 20000, closes_value_missing: 1, closes_owner_inferred: 0 })
    const b = rows.find((r) => r.owner_user_id === 'B')!
    expect(b).toMatchObject({ closes_won: 1, dollars_recorded: 10000, closes_owner_inferred: 1 })
  })
  it('drops null-owner closes (unattributable)', () => {
    expect(aggregateClosesDay([ev({ owner_user_id: null })], '2026-06-17')).toHaveLength(0)
  })
})

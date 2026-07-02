import { describe, it, expect } from 'vitest'
import { mergeApptsBooked, mergeApptsHeld, type SealedRow, type CloserRow } from '../src/seal'

const DAY = '2026-06-30'

const setterRow = (owner: string, calls = 5): SealedRow => ({
  seal_date_et: DAY, owner_user_id: owner, role: 'setter', calls, answered: 2, talk_time_seconds: 300,
})
const closerRow = (owner: string): CloserRow => ({
  seal_date_et: DAY, owner_user_id: owner, role: 'closer',
  calls: 0, answered: 0, talk_time_seconds: 0,
  closes_won: 1, closes_lost: 0, dollars_recorded: 1000, closes_value_missing: 0, closes_owner_inferred: 0,
})
const appt = (over: Record<string, unknown> = {}) => ({
  appt_id: 'a1', booked_on: DAY, start_on: DAY, booked_by_user_id: 's1', held_by_user_id: 'c1',
  appointment_status: 'confirmed', ...over,
})

describe('mergeApptsBooked', () => {
  it('adds meetings_booked to an existing setter row without a duplicate PK row', () => {
    const rows = mergeApptsBooked([setterRow('s1')], [appt(), appt({ appt_id: 'a2' })], DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ owner_user_id: 's1', calls: 5, meetings_booked: 2 })
  })

  it('creates a zeroed setter row for a booker with no calls that day', () => {
    const rows = mergeApptsBooked([setterRow('s1')], [appt({ booked_by_user_id: 's2' })], DAY)
    const s2 = rows.find((r) => r.owner_user_id === 's2')!
    expect(s2).toMatchObject({ calls: 0, answered: 0, talk_time_seconds: 0, meetings_booked: 1, role: 'setter' })
  })

  it('every row carries meetings_booked (column-union safety) and off-day/unattributed appts are excluded', () => {
    const rows = mergeApptsBooked([setterRow('s1')], [
      appt({ booked_on: '2026-06-29' }), // wrong day
      appt({ appt_id: 'a3', booked_by_user_id: null }), // unattributed
    ], DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.meetings_booked).toBe(0)
  })
})

describe('mergeApptsHeld', () => {
  it('counts held/showed/noshow by held_by over start_on, excluding cancelled', () => {
    const rows = mergeApptsHeld([closerRow('c1')], [
      appt({ appointment_status: 'showed' }),
      appt({ appt_id: 'a2', appointment_status: 'noshow' }),
      appt({ appt_id: 'a3', appointment_status: 'confirmed' }),
      appt({ appt_id: 'a4', appointment_status: 'cancelled' }),
    ], DAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ meetings_held: 3, meetings_showed: 1, meetings_noshow: 1, closes_won: 1 })
  })

  it('creates a zeroed closer row (explicit 0s for NOT NULL call columns) for a holder with no closes', () => {
    const rows = mergeApptsHeld([], [appt({ held_by_user_id: 'c9', appointment_status: 'showed' })], DAY)
    expect(rows[0]!).toMatchObject({
      owner_user_id: 'c9', role: 'closer', calls: 0, answered: 0, talk_time_seconds: 0,
      closes_won: 0, meetings_held: 1, meetings_showed: 1, meetings_noshow: 0,
    })
  })

  it('booker and holder attribution are independent: booked-by setter, held-by closer', () => {
    const a = appt({ booked_by_user_id: 's1', held_by_user_id: 'c1', appointment_status: 'showed' })
    const booked = mergeApptsBooked([], [a], DAY)
    const held = mergeApptsHeld([], [a], DAY)
    expect(booked[0]!.owner_user_id).toBe('s1')
    expect(held[0]!.owner_user_id).toBe('c1')
  })
})

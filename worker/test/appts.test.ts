import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifyAppt, fetchApptEvents } from '../src/appts'
import { CALENDARS } from '../src/calendars'

const raw = (over: Record<string, unknown> = {}) => ({
  id: 'appt_1',
  calendarId: 'cal_1',
  contactId: 'c_1',
  assignedUserId: 'closer_1',
  appointmentStatus: 'confirmed',
  appoinmentStatus: 'WRONG', // misspelled twin must be ignored
  dateAdded: '2026-06-30T18:00:00.000Z',
  startTime: '2026-07-03T23:30:00.000Z',
  createdBy: { source: 'contactdetails_page', userId: 'setter_1' },
  deleted: false,
  ...over,
})

describe('classifyAppt', () => {
  it('captures booked-by from createdBy.userId with created_by confidence', () => {
    const e = classifyAppt(raw(), 'closer')!
    expect(e.apptId).toBe('appt_1')
    expect(e.bookedByUserId).toBe('setter_1')
    expect(e.bookedByConfidence).toBe('created_by')
    expect(e.heldByUserId).toBe('closer_1')
    expect(e.status).toBe('confirmed') // correctly-spelled field wins
    expect(e.calendarRole).toBe('closer')
  })

  it('day-attributes booking to Eastern day of dateAdded and start to Eastern day of startTime', () => {
    const e = classifyAppt(raw(), 'setter')!
    expect(e.bookedOn).toBe('2026-06-30') // 18:00Z = 14:00 ET
    expect(e.startOn).toBe('2026-07-03') // 23:30Z = 19:30 ET
  })

  it('crossing-midnight ET: a late-UTC booking lands on the prior Eastern day', () => {
    const e = classifyAppt(raw({ dateAdded: '2026-07-01T03:30:00.000Z' }), 'setter')!
    expect(e.bookedOn).toBe('2026-06-30') // 03:30Z = 23:30 ET previous day
  })

  it('widget booking without createdBy.userId is unattributed pending the setter-field fallback', () => {
    const e = classifyAppt(raw({ createdBy: { source: 'booking_widget' } }), 'closer')!
    expect(e.bookedByUserId).toBeNull()
    expect(e.bookedByConfidence).toBe('unattributed')
    expect(e.createdSource).toBe('booking_widget')
  })

  it('held-by can be null at first sight (round-robin assigns later)', () => {
    const e = classifyAppt(raw({ assignedUserId: undefined }), 'closer')!
    expect(e.heldByUserId).toBeNull()
  })

  it('drops deleted events, events without id, and events without a booking moment', () => {
    expect(classifyAppt(raw({ deleted: true }), 'closer')).toBeNull()
    expect(classifyAppt(raw({ id: undefined }), 'closer')).toBeNull()
    expect(classifyAppt(raw({ dateAdded: undefined }), 'closer')).toBeNull()
  })
})

describe('fetchApptEvents resilience', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  // Regression for the 2026-07-21 mirror freeze: when two setters left, GHL deleted
  // their calendars and /calendars/events returned 400 "The calendar is deleted." for
  // those ids. One 400 threw out of the per-calendar loop and aborted the WHOLE sweep,
  // freezing appt_events for days. A dead calendar must be skipped, not fatal.
  it('skips a calendar that 400s "calendar is deleted" and still returns the others', async () => {
    const deadId = CALENDARS[1].id
    const liveId = CALENDARS[0].id
    const liveEvent = {
      id: 'appt_live', calendarId: liveId, contactId: 'c_1', assignedUserId: 'closer_1',
      appointmentStatus: 'confirmed', dateAdded: '2026-07-24T18:00:00.000Z',
      startTime: '2026-07-25T15:00:00.000Z', createdBy: { userId: 'setter_1' }, deleted: false,
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const calId = new URL(url).searchParams.get('calendarId')
      if (calId === deadId) {
        return new Response(JSON.stringify({ message: 'The calendar is deleted.', statusCode: 400 }), { status: 400 })
      }
      return new Response(JSON.stringify({ events: calId === liveId ? [liveEvent] : [] }), { status: 200 })
    }))

    const env = { GHL_PIT: 'x', GHL_LOCATION_ID: 'loc' } as any
    const out = await fetchApptEvents(env)
    // The sweep did NOT throw, and the live calendar's event still made it through.
    expect(out.map((e) => e.apptId)).toContain('appt_live')
    // It attempted every calendar (including the dead one) — none aborted the loop.
    expect((globalThis.fetch as any).mock.calls.length).toBe(CALENDARS.length)
  })
})

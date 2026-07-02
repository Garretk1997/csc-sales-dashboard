// worker/src/appts.ts
//
// Stream 3 fetch + classify: GHL calendar events -> appointment events with
// booked-by (setter) vs held-by (closer) attribution captured AT SWEEP TIME.
// The hourly credit-sweep rewrites opp owners, so attribution read later from
// "current owner" is wrong by design — it must be frozen here.
//
// Endpoint (proven in SPIKE-stream3-appointments.md + re-verified 2026-07-01):
//   GET /calendars/events?locationId=&calendarId=&startTime=&endTime=  (epoch ms)
// No pagination cursor: it returns every event whose startTime is in the window,
// so the sweep uses a rolling window (past 14d .. future 45d) per calendar and
// diffs against the DB — the same snapshot-diff CDC shape as Stream 2.

import type { Env } from './db'
import { parseRetryAfter } from './ghl'
import { bumpSubrequest } from './subreq'
import { easternDateString } from './time'
import { CALENDARS, type CalendarRole } from './calendars'

const BASE = 'https://services.leadconnectorhq.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const WINDOW_PAST_DAYS = 14
export const WINDOW_FUTURE_DAYS = 45

// The setter-as-follower system stamps the booking setter into this contact
// custom field BEFORE the calendar flips the contact owner to the closer.
// It is the attribution fallback for widget self-bookings (no createdBy.userId).
export const SETTER_FIELD_ID = 'rT5RESd0alph0k9PSJE5'

async function getJson(env: Env, path: string, params: Record<string, string>): Promise<any> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`
  for (let a = 0; a < 6; a++) {
    await sleep(130)
    bumpSubrequest()
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.GHL_PIT}`, Version: '2021-07-28', Accept: 'application/json' } })
    if (res.status === 200) return res.json()
    if (res.status === 429) { await sleep(parseRetryAfter(res.headers.get('retry-after'), 11) * 1000); continue }
    if ([500, 502, 503, 504].includes(res.status)) { await sleep(600 + 500 * a); continue }
    if (res.status === 401 || res.status === 403) { await sleep(500 + 400 * a); continue } // transient GHL auth blips (see ghl.ts)
    throw new Error(`GET ${path} -> ${res.status}`)
  }
  throw new Error(`GET ${path} exhausted retries`)
}

export type ApptEvent = {
  apptId: string
  calendarId: string
  calendarRole: CalendarRole
  contactId: string | null
  bookedByUserId: string | null
  bookedByConfidence: 'created_by' | 'setter_field' | 'unattributed'
  heldByUserId: string | null
  status: string
  createdSource: string | null
  bookedAt: string // ISO
  bookedOn: string // YYYY-MM-DD ET
  startAt: string | null
  startOn: string | null
}

/** Pure: raw GHL calendar event -> ApptEvent (before the setter-field fallback). */
export function classifyAppt(raw: any, calendarRole: CalendarRole): ApptEvent | null {
  const apptId = raw?.id ? String(raw.id) : null
  if (!apptId) return null
  if (raw?.deleted === true) return null
  const bookedAtMs = Date.parse(raw?.dateAdded ?? '')
  if (!Number.isFinite(bookedAtMs)) return null // no booking moment -> cannot day-attribute
  const startMs = Date.parse(raw?.startTime ?? '')
  const createdBy = raw?.createdBy ?? {}
  const bookedBy = createdBy?.userId ? String(createdBy.userId) : null
  return {
    apptId,
    calendarId: String(raw?.calendarId ?? ''),
    calendarRole,
    contactId: raw?.contactId ? String(raw.contactId) : null,
    bookedByUserId: bookedBy,
    bookedByConfidence: bookedBy ? 'created_by' : 'unattributed', // sweep may upgrade via setter field
    heldByUserId: raw?.assignedUserId ? String(raw.assignedUserId) : null,
    // use the correctly-spelled field; GHL also ships a misspelled 'appoinmentStatus' twin
    status: String(raw?.appointmentStatus ?? 'unknown'),
    createdSource: createdBy?.source ? String(createdBy.source) : null,
    bookedAt: new Date(bookedAtMs).toISOString(),
    bookedOn: easternDateString(new Date(bookedAtMs)),
    startAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    startOn: Number.isFinite(startMs) ? easternDateString(new Date(startMs)) : null,
  }
}

/** All events on the configured calendars within the rolling window. */
export async function fetchApptEvents(env: Env, now = Date.now()): Promise<ApptEvent[]> {
  const startTime = String(now - WINDOW_PAST_DAYS * 24 * 3600 * 1000)
  const endTime = String(now + WINDOW_FUTURE_DAYS * 24 * 3600 * 1000)
  const out: ApptEvent[] = []
  for (const cal of CALENDARS) {
    const resp = await getJson(env, '/calendars/events', {
      locationId: env.GHL_LOCATION_ID, calendarId: cal.id, startTime, endTime,
    })
    for (const raw of resp?.events ?? []) {
      const ev = classifyAppt(raw, cal.role)
      if (ev) out.push(ev)
    }
  }
  return out
}

/** Fallback booked-by for widget self-bookings: the setter stamped on the contact. */
export async function fetchContactSetterField(env: Env, contactId: string): Promise<string | null> {
  try {
    const resp = await getJson(env, `/contacts/${contactId}`, {})
    const fields: any[] = resp?.contact?.customFields ?? []
    const hit = fields.find((f) => f?.id === SETTER_FIELD_ID)
    const v = hit?.value ?? hit?.fieldValue ?? null
    return v && String(v).trim() && !String(v).includes('{{') ? String(v).trim() : null
  } catch (err) {
    // Attribution fallback must never abort the sweep — an unresolved contact
    // just leaves the appointment 'unattributed'.
    console.error(`fetchContactSetterField ${contactId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

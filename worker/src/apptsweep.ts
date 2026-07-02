// worker/src/apptsweep.ts
//
// Stream 3 sweep: rolling-window pull of calendar events -> appt_events.
//
// Contract (DESIGN-stream3-appointments.md):
// - INSERT new appointments with attribution resolved AT SWEEP TIME
//   (booked_by chain: createdBy.userId -> contact setter_user_id field -> unattributed).
// - UPDATE existing rows ONLY for: appointment_status changes, and null->value
//   fills of held_by. The update path never touches booked_by_* / booked_at /
//   booked_on — first-write-wins, so later owner rewrites (hourly credit-sweep)
//   can never rewrite who booked.
// - A status flip whose start_on day is already sealed also logs to late_events
//   (reason 'post_seal_appt') so the immutable record's divergence is auditable;
//   the raw appt_events mirror still updates to current GHL truth.

import { createDb, type Env } from './db'
import { fetchApptEvents, fetchContactSetterField, type ApptEvent } from './appts'
import { HISTORICAL_NAMES } from './calendars'

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export async function runApptSweep(env: Env): Promise<{ appts_seen: number; appts_new: number; appts_updated: number; appts_late: number; appts_deferred: number }> {
  const db = createDb(env)
  const events = await fetchApptEvents(env)
  if (!events.length) return { appts_seen: 0, appts_new: 0, appts_updated: 0, appts_late: 0, appts_deferred: 0 }

  // Existing rows for the incoming ids (chunked: PostgREST .in has URL limits).
  const existingById = new Map<string, any>()
  for (const ids of chunk(events.map((e) => e.apptId), 150)) {
    const { data, error } = await db
      .from('appt_events')
      .select('appt_id, appointment_status, held_by_user_id')
      .in('appt_id', ids)
    if (error) throw new Error(`appt_events read: ${error.message}`)
    for (const r of data ?? []) existingById.set(r.appt_id, r)
  }

  let fresh = events.filter((e) => !existingById.has(e.apptId))
  const known = events.filter((e) => existingById.has(e.apptId))

  // Name resolution at sweep time: roster-synced users table (retains users
  // seen since sync began) + static historical fallbacks for pre-sync deletes.
  const { data: userRows, error: uErr } = await db.from('users').select('ghl_user_id, name')
  if (uErr) throw new Error(`users read: ${uErr.message}`)
  const names = new Map<string, string>((userRows ?? []).map((u: any) => [u.ghl_user_id, u.name ?? u.ghl_user_id]))
  const nameFor = (id: string | null): string | null =>
    id ? (names.get(id) ?? HISTORICAL_NAMES[id] ?? null) : null

  // Attribution fallback for NEW widget/self bookings only (bounded GHL quota:
  // one contact GET per new unattributed appt, cached per contact this sweep).
  //
  // Subrequest budget: a Worker invocation has a hard subrequest cap, and this
  // sweep runs AFTER the call+opp sweeps in the same tick. Cap the fallback
  // lookups per sweep; appointments still awaiting a lookup are DEFERRED (not
  // inserted) so the next sweep sees them as new and works through the backlog
  // in bounded slices. Attribution stays first-write-wins: a row is only ever
  // inserted after its fallback chance.
  const MAX_FALLBACK_LOOKUPS = 40
  const setterCache = new Map<string, string | null>()
  let lookups = 0
  const deferred = new Set<string>()
  for (const e of fresh) {
    if (e.bookedByUserId || !e.contactId) continue
    if (!setterCache.has(e.contactId)) {
      if (lookups >= MAX_FALLBACK_LOOKUPS) { deferred.add(e.apptId); continue }
      lookups += 1
      setterCache.set(e.contactId, await fetchContactSetterField(env, e.contactId))
    }
    const setter = setterCache.get(e.contactId) ?? null
    if (setter) {
      e.bookedByUserId = setter
      e.bookedByConfidence = 'setter_field'
    }
  }
  fresh = fresh.filter((e) => !deferred.has(e.apptId))

  // Sealed days (bounded), to flag post-seal status flips.
  const { data: sealed, error: sErr } = await db
    .from('sealed_days')
    .select('seal_date_et')
    .gte('seal_date_et', new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10))
  if (sErr) throw new Error(`sealed_days read: ${sErr.message}`)
  const sealedSet = new Set((sealed ?? []).map((r: any) => r.seal_date_et))

  // INSERT new appointments (attribution frozen from here on).
  if (fresh.length) {
    const rows = fresh.map((e: ApptEvent) => ({
      appt_id: e.apptId,
      calendar_id: e.calendarId,
      calendar_role: e.calendarRole,
      contact_id: e.contactId,
      booked_by_user_id: e.bookedByUserId,
      booked_by_name: nameFor(e.bookedByUserId),
      booked_by_confidence: e.bookedByConfidence,
      held_by_user_id: e.heldByUserId,
      held_by_name: nameFor(e.heldByUserId),
      appointment_status: e.status,
      created_source: e.createdSource,
      booked_at: e.bookedAt,
      booked_on: e.bookedOn,
      start_at: e.startAt,
      start_on: e.startOn,
    }))
    // ignoreDuplicates: a concurrent tick racing this insert must not overwrite
    // the first writer's frozen attribution.
    const { error } = await db.from('appt_events').upsert(rows, { onConflict: 'appt_id', ignoreDuplicates: true })
    if (error) throw new Error(`appt_events insert: ${error.message}`)
  }

  // UPDATE path: status flips + held_by null-fills only.
  let updated = 0
  let late = 0
  for (const e of known) {
    const prev = existingById.get(e.apptId)
    const patch: Record<string, unknown> = {}
    if (prev.appointment_status !== e.status) patch.appointment_status = e.status
    if (!prev.held_by_user_id && e.heldByUserId) {
      patch.held_by_user_id = e.heldByUserId
      patch.held_by_name = nameFor(e.heldByUserId)
    }
    if (!Object.keys(patch).length) continue
    patch.updated_at = new Date().toISOString()
    const { error } = await db.from('appt_events').update(patch).eq('appt_id', e.apptId)
    if (error) throw new Error(`appt_events update ${e.apptId}: ${error.message}`)
    updated += 1
    // Post-seal status flip: the sealed show/no-show record for that day is
    // immutable — log the divergence.
    if (patch.appointment_status && e.startOn && sealedSet.has(e.startOn)) {
      const { error: lErr } = await db.from('late_events').insert({
        belongs_to_date_et: e.startOn,
        payload: { appt_id: e.apptId, from: prev.appointment_status, to: e.status },
        reason: 'post_seal_appt',
      })
      if (lErr) throw new Error(`late_events insert: ${lErr.message}`)
      late += 1
    }
  }

  return { appts_seen: events.length, appts_new: fresh.length, appts_updated: updated, appts_late: late, appts_deferred: deferred.size }
}

# DESIGN — Stream 3: Appointments (meetings booked + who-booked attribution)

Date: 2026-07-01. Read-only GHL investigation this run + SPIKE-stream3-appointments.md (2026-06-24).
Goal: dashboard shows calls dialed AND meetings booked, with per-person attribution of
WHO BOOKED each meeting (setter) distinct from WHO HOLDS it (closer).

## Live findings (2026-07-01 sample, 60-day window, read-only)

| Calendar | Events | createdBy.userId present | assignedUserId present | booker != holder |
|---|---|---|---|---|
| d2HDmtzG0wCiqWMeFrds Book 1-on-1 (Setters) | 15 | 15/15 | 7/15 | 6 |
| UCLiMliOC031tBNCIwoM Capital Stack 1-on-1 | 344 | 106/344 | 285/344 | 42 |
| SEBOg7dYcjuTcddeHXea CS Strategy Call | 25 | 2/25 | 18/25 | 0 |

- `createdBy.userId` is the staff member who created the appointment. Present on ALL
  staff-created events (contactdetails_page / opportunity_page / calendar_page / mobile_app).
  Absent on booking_widget self-bookings and google_calendar imports.
- `assignedUserId` is the holder (closer). Can be null at booking and filled later by round-robin.
- Spot-checked names against live GHL users: e.g. appt 4aM1G9C0t8bJ booked by Jinnie Do,
  held by Ashley Clark. Several historical bookers are DELETED users (June consolidation) whose
  IDs no longer resolve in /users/ — proving attribution must be captured and named AT SWEEP TIME.
- The hourly credit-sweep Action rewrites opp owners, so "current opp owner" read later is NOT
  who booked. Same conclusion.

## Attribution rules (per appointment, captured at sweep time, first-write wins)

BOOKED BY (setter credit), resolution chain:
1. `createdBy.userId` when present -> confidence `created_by`.
2. Else the contact's `setter_user_id` custom field (id rT5RESd0alph0k9PSJE5, stamped by the
   setter-as-follower system before the booking flips owner) via GET /contacts/{id} ->
   confidence `setter_field`. One lookup per new widget-booked appt, cached per contact.
3. Else confidence `unattributed` (booked_by null).

HELD BY (closer credit): `assignedUserId`. May be null at first sight; fill-once-when-appears
(null -> value allowed; value -> value never overwritten).

Names: resolved at sweep time from the Supabase `users` table (retains historically synced
users) with live /users/ fallback, stored as strings on the row so deleted users stay named.

Immutability: `booked_by_*`, `booked_at`, `calendar_id` are written once and never updated.
`appointment_status` and null->value `held_by_*` fills are the only mutations (status flips
confirmed -> showed/noshow/cancelled are real data, per spike section 3).

## Sweep shape

- New `worker/src/appts.ts`: GET /calendars/events per configured calendar,
  rolling window `now - 14d .. now + 45d` (no cursor exists on this endpoint; the window
  re-pulls upcoming + just-passed appts so status flips are captured). Same 130ms pacing,
  429/5xx/401-403 retry, bumpSubrequest as ghl.ts.
- Calendar roster (config, mirrors config.ts stage names): the sales-relevant calendars from
  the spike with roles; BLOCK excluded. Roster lives in `worker/src/calendars.ts`.
- New `worker/src/apptsweep.ts` `runApptSweep(env)`: fetch -> classify (pure) -> diff against
  existing `appt_events` rows -> insert new rows / update only {status, held_by null-fill} on
  changed rows. Registered in `index.ts` after `runOppSweep`, counts folded into recordRun.
- Metric day: `booked_on` = Eastern day of `dateAdded` (booking time) — this is the
  "meetings booked" day. `start_on` = Eastern day of startTime for show-rate denominators.

## Storage — migration db/migrations/0004_appointments.sql

`appt_events` (PK appt_id): calendar_id, calendar_role, contact_id, booked_by_user_id,
booked_by_name, booked_by_confidence, held_by_user_id, held_by_name, appointment_status,
booked_at timestamptz, booked_on date, start_at timestamptz, start_on date, created_source,
first_seen_at, updated_at. Indexes on booked_on and start_on.
No immutability trigger on the table (status mutates); attribution immutability is enforced by
the sweep's insert/update split (update statements never touch booked_by columns).

`daily_sealed` gains nullable columns:
- setter-side (keyed by booked_by, sealed by booked_on): `meetings_booked int`
- closer-side (keyed by held_by, sealed by start_on): `meetings_held int`, `meetings_showed int`,
  `meetings_noshow int`

## Seal

`aggregateApptsBookedDay` (by booked_by over booked_on = sealDate) merges `meetings_booked`
into the setter rows; `aggregateApptsHeldDay` (by held_by over start_on = sealDate) merges
meetings_held/showed/noshow into the closer rows. Merge = same (seal_date_et, owner, role) PK
rows as calls/closes aggregation — owners with bookings but no calls get a new setter row with
explicit zeros. Single atomic insert unchanged. Post-seal status flips: appt whose start_on is
already sealed diverts to late_events (reason 'post_seal_appt'), never mutates the record.

## Dashboard

- daily_sealed drives the durable record; because sealed days are INSERT-only, history before
  this deploy cannot gain the new columns. For immediate real numbers the front end ALSO does a
  live read of `appt_events` (same accepted pattern as the planned Stream 4 live reads of
  whop_payments) and aggregates booked_on/start_on client-side with the existing window filter.
- Tiles flipped wired: `meetingsSet` (team + per-day), `bookedCalls` (per-rep booked-by),
  `showRate` (showed / dispositioned past, with dispositioned-coverage % per spike section 3 —
  shown as coverage so the understatement is visible).
- Setter view + leaderboard gain Meetings Booked; closer view gains Held / Showed / No-show.

## Show rate caveat (from spike, still true in this sample)

Past appointments are rarely advanced from `confirmed` (191+225 past-confirmed vs 16+12 showed
in the spike). Show rate is computed over DISPOSITIONED past appts (showed / (showed+noshow))
and displayed with a coverage % = dispositioned / past. Do not treat it as ground truth until
the team adopts a disposition SOP.

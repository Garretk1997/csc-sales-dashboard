-- db/migrations/0004_appointments.sql
--
-- Stream 3: Appointments (meetings booked + who-booked attribution).
-- See DESIGN-stream3-appointments.md.
--
-- appt_events is the raw mirror of GHL calendar events. It is MUTABLE for
-- appointment_status (confirmed -> showed/noshow/cancelled is real data) and
-- for null->value fills of held_by (round-robin can assign after booking).
-- The ATTRIBUTION columns (booked_by_*, booked_at, booked_on, calendar_id)
-- are first-write-wins: the sweep's update path never touches them, so the
-- hourly credit-sweep rewriting opp owners can never rewrite who booked.

create table appt_events (
  appt_id              text primary key,          -- GHL calendar event id (dedup key)
  calendar_id          text not null,
  calendar_role        text not null,             -- setter | closer | discovery | other (from worker roster)
  contact_id           text,
  booked_by_user_id    text,                      -- WHO BOOKED (setter credit); null = unattributed
  booked_by_name       text,                      -- resolved AT SWEEP TIME (deleted users stay named)
  booked_by_confidence text not null,             -- created_by | setter_field | unattributed
  held_by_user_id      text,                      -- WHO HOLDS (closer credit); null until assigned
  held_by_name         text,
  appointment_status   text not null,             -- confirmed | showed | noshow | cancelled | new | invalid
  created_source       text,                      -- booking_widget | calendar_page | mobile_app | ...
  booked_at            timestamptz not null,      -- dateAdded (booking moment)
  booked_on            date not null,             -- Eastern day of booked_at: the "meetings booked" day
  start_at             timestamptz,               -- appointment time
  start_on             date,                      -- Eastern day of start_at: show-rate day
  first_seen_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index appt_events_booked_on on appt_events (booked_on);
create index appt_events_start_on on appt_events (start_on);

-- Sealed-record columns (nullable; rows from before this stream keep null).
-- setter-side, keyed by booked_by over booked_on:
alter table daily_sealed add column if not exists meetings_booked integer;
-- closer-side, keyed by held_by over start_on:
alter table daily_sealed add column if not exists meetings_held integer;
alter table daily_sealed add column if not exists meetings_showed integer;
alter table daily_sealed add column if not exists meetings_noshow integer;

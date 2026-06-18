-- db/migrations/0001_init.sql

-- Roster dimension + owner-validation source of truth.
create table users (
  ghl_user_id text primary key,
  name        text,
  email       text,
  active      boolean not null default true,
  roles       text[]  not null default '{}',
  updated_at  timestamptz not null default now()
);

-- Raw, immutable call rows. Deduped on the Twilio CallSid.
create table call_events (
  call_sid         text primary key,
  ghl_message_id   text,
  occurred_at      timestamptz not null,
  occurred_on      date not null,            -- Eastern calendar day
  owner_user_id    text,                     -- from the event's userId, never the contact
  duration_seconds integer not null default 0,
  status           text not null,
  direction        text,
  source           text not null,            -- 'webhook' | 'api_sweep'
  provisional      boolean not null default false,
  updated_at       timestamptz not null default now()
);
create index call_events_day_owner on call_events (occurred_on, owner_user_id);

-- THE RECORD. INSERT-only by trigger (see below). One row per (day, rep, role).
create table daily_sealed (
  seal_date_et     date not null,
  owner_user_id    text not null,
  role             text not null,
  calls            integer not null default 0,
  answered         integer not null default 0,
  talk_time_seconds integer not null default 0,
  bookings         integer not null default 0,  -- Stream 2 fills
  closes           integer not null default 0,  -- Stream 2 fills
  dollars_collected numeric not null default 0,  -- Stream 2 fills
  sealed_at        timestamptz not null default now(),
  seal_version     integer not null default 1,
  primary key (seal_date_et, owner_user_id, role)
);

-- Seal-state ledger: a day appears here once it is frozen.
create table sealed_days (
  seal_date_et date primary key,
  sealed_at    timestamptz not null default now(),
  seal_version integer not null default 1
);

-- Append-only ledger for post-seal truth (late webhook / correction / deletion).
create table late_events (
  id               bigserial primary key,
  belongs_to_date_et date not null,
  payload          jsonb not null,
  reason           text not null,
  arrived_at       timestamptz not null default now()
);

-- Immutability guard: block UPDATE/DELETE on the record + seal ledger.
create or replace function assert_immutable() returns trigger as $$
begin
  raise exception 'immutable table %: % blocked (sealed record never changes)', TG_TABLE_NAME, TG_OP;
end;
$$ language plpgsql;

create trigger daily_sealed_immutable before update or delete on daily_sealed
  for each row execute function assert_immutable();
create trigger sealed_days_immutable before update or delete on sealed_days
  for each row execute function assert_immutable();

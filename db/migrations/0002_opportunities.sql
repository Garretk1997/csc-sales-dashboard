-- db/migrations/0002_opportunities.sql

-- Memory of who owned an opp while it was OPEN (makes owner-at-close provable).
create table opp_snapshots (
  opp_id            text primary key,
  owner_user_id     text,
  pipeline_id       text,
  stage_id          text,
  monetary_value    numeric not null default 0,
  last_seen_open_at timestamptz not null default now()
);

-- Immutable close records (one per opp in v1). Raw event feed for the seal.
create table close_events (
  opp_id            text primary key,
  occurred_at       timestamptz not null,
  occurred_on       date not null,                 -- Eastern day of lastStageChangeAt
  pipeline_id       text,
  stage_id          text,
  stage_name        text,
  outcome           text not null,                 -- 'won' | 'lost'
  owner_user_id     text,
  owner_confidence  text not null,                 -- 'confirmed' | 'inferred'
  monetary_value    numeric not null default 0,
  value_confidence  text not null,                 -- 'recorded' | 'missing'
  source            text not null default 'api_sweep',
  recorded_at       timestamptz not null default now()
);
create index close_events_day on close_events (occurred_on);

-- Extend the sealed record for the closer role (nullable; setter rows leave these null).
alter table daily_sealed add column if not exists closes_won integer;
alter table daily_sealed add column if not exists closes_lost integer;
alter table daily_sealed add column if not exists dollars_recorded numeric;
alter table daily_sealed add column if not exists closes_value_missing integer;
alter table daily_sealed add column if not exists closes_owner_inferred integer;

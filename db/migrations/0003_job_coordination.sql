-- db/migrations/0003_job_coordination.sql
--
-- Job coordination for the unattended scheduled runs:
--   (1) job_locks  — a TTL mutex so the ~3am seal runs ALONE (no sweep writes the
--                    day being sealed) without risk of a crashed holder freezing
--                    the pipeline forever.
--   (2) job_runs   — a run ledger so a failed/stuck seal or sweep SURFACES (the
--                    dashboard health banner reads this) instead of silently
--                    showing a stale day as if it were fresh.
--
-- BOTH are deliberately MUTABLE — they are operational state, NOT the sealed
-- record, so they must NOT carry the assert_immutable() triggers.

create table if not exists job_locks (
  name        text primary key,        -- 'pipeline'
  holder      text not null,           -- crypto.randomUUID() of the holding invocation
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null     -- TTL: a dead holder auto-releases here
);

-- Atomic acquire: take the lock iff it is FREE or its TTL has EXPIRED.
-- Returns true only to the caller that now holds it. Concurrent callers serialize
-- on the primary-key conflict, so exactly one wins.
create or replace function try_acquire_lock(p_name text, p_holder text, p_ttl_sec int)
returns boolean
language plpgsql
as $$
declare
  ok boolean;
begin
  insert into job_locks (name, holder, acquired_at, expires_at)
    values (p_name, p_holder, now(), now() + make_interval(secs => p_ttl_sec))
  on conflict (name) do update
    set holder = excluded.holder, acquired_at = now(), expires_at = excluded.expires_at
    where job_locks.expires_at < now()      -- only steal an EXPIRED lock
  returning true into ok;
  return coalesce(ok, false);
end;
$$;

-- Release only MY lock (holder match) so a slow invocation whose lock was already
-- stolen on expiry cannot release the new holder's lock.
create or replace function release_lock(p_name text, p_holder text)
returns void
language sql
as $$
  delete from job_locks where name = p_name and holder = p_holder;
$$;

create table if not exists job_runs (
  id          bigserial primary key,
  job         text not null,           -- 'seal' | 'sweep'
  status      text not null,           -- 'ok' | 'error' | 'yielded'
  ran_on      date,                    -- target/sealed Eastern day where relevant
  detail      jsonb,                   -- counts on success / message on error
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists job_runs_recent on job_runs (job, started_at desc);

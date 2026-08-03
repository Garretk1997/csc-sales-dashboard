#!/usr/bin/env python3
"""
CREDIT SWEEP (scheduled) — keep ownership=credit correct as leads cross pipelines.
Hourly GitHub Action. PIT-based (no 1h token). Idempotent: each run only touches
opps that are currently UNASSIGNED or owned by a DELETED user, and assigns:
  - Booked Appointments pipeline  -> a closer (booked = closer credit)
  - everything else               -> the setter who owns that contact's dial lead,
                                     else round-robin to the ACTIVE setters.
This is the durable fix for webinar opps being born unassigned (create_opportunity
has no owner field). Reads GHL_PIT (+ optional GHL_LOCATION_ID) from env.

QUOTA GUARDRAILS (added 2026-08-03 after the sweep exhausted the location-wide
200k/day GHL quota and 429'd every consumer incl. the live funnels):
  - GHL's daily limit is SHARED across all PITs on the location. This job must
    never spend more than a small slice of it.
  - Aborts up front if x-ratelimit-daily-remaining < MIN_DAILY_BUDGET.
  - Writes at most MAX_WRITES fixes per run (backlog drains across runs).
  - Single-writer, throttled under the 100-req/10s burst limit.
  - Fails fast if the users/pipelines fetches come back empty (an empty ACTIVE
    set must never be read as "every owner was deleted").
  - Only assigns to CURRENTLY ACTIVE users; a stale hardcoded id must never be
    written (it would look "deleted" next run and loop forever).
USAGE (CI): python3 .github/scripts/credit_sweep.py --execute
"""
import os,sys,json,time,subprocess

def env(k, default=None):
    if os.environ.get(k): return os.environ[k]
    try: return subprocess.check_output(f"grep -m1 '^{k}=' ~/.claude/.env | cut -d= -f2-",shell=True,executable='/bin/bash').decode().strip() or default
    except Exception: return default

PIT=env('GHL_PIT'); LOC=env('GHL_LOCATION_ID','VAG1ZlpvIsGZD369uq8d')
if not PIT: sys.exit("GHL_PIT not set")
PH=['-H',f'Authorization: Bearer {PIT}','-H','Version: 2021-07-28']
SVC="https://services.leadconnectorhq.com"
DIAL={'QOHgAAI6Bh4A0osVZ2nO','6TxaIttZKQdr7GxNCDu7','q1tw7GnazQcFPVs1XlYd'}
SET_LIST=['5dz02Ixj5UJQA9rekEro','NgUE4c5Fahb7ufbPxd2U','97TmQktsF4wpUzCZ3XS2','28A1MXkLapMxmrPXT31e','cxygnYMsU2nRZweBb5EK','RsJ1O1N75b3RbIr7pE4v','5ilBLelExHZpbcT8p5NF','3WXE915c6ab7MBTecCl3','UuQM0jbFS7PeBsy6uagx','2xfEavZ87FOtzxrRSRnc','slQd7Eb4lh4i0P2JruBO','5jAOHyyilmVJAYamp9DA','bRTkWlMTYousLq5V57na','up2NUCfncbmsDoOD4t2l']

MAX_WRITES=int(env('SWEEP_MAX_WRITES','500'))        # per-run write cap
MIN_DAILY_BUDGET=int(env('SWEEP_MIN_DAILY','30000')) # abort if location budget below this
WRITE_SLEEP=0.15                                     # ~6 req/s, under the 100/10s burst
FAIL_ABORT=15                                        # consecutive write failures -> abort

def curl(extra,retries=4):
    for i in range(retries):
        try:
            out=subprocess.check_output(['curl','-s','-w','\n%{http_code}']+extra,timeout=50).decode()
            b,_,c=out.rpartition('\n')
            if c=='429': time.sleep(1.5*(i+1)); continue
            return c,b
        except Exception: time.sleep(1.0*(i+1))
    return '000',''
def jget(u):
    c,b=curl([u]+PH)
    try: return json.loads(b)
    except: return {}

def daily_remaining():
    """Read x-ratelimit-daily-remaining off a cheap GET. None if unreadable."""
    try:
        out=subprocess.check_output(['curl','-s','-o','/dev/null','-D','-',
            f"{SVC}/opportunities/pipelines?locationId={LOC}"]+PH,timeout=50).decode()
        for line in out.splitlines():
            if line.lower().startswith('x-ratelimit-daily-remaining:'):
                return int(line.split(':',1)[1].strip())
    except Exception: pass
    return None

def main():
    execute='--execute' in sys.argv
    rem=daily_remaining()
    print(f"[credit-sweep] daily-remaining={rem}", flush=True)
    if rem is not None and rem < MIN_DAILY_BUDGET:
        sys.exit(f"[credit-sweep] ABORT: location daily budget {rem} < {MIN_DAILY_BUDGET} — leaving quota for live traffic")
    users=jget(f"{SVC}/users/?locationId={LOC}").get('users',[])
    if not users: sys.exit("[credit-sweep] ABORT: users fetch empty/failed — refusing to treat everyone as deleted")
    ACTIVE={u['id'] for u in users}
    cals=jget(f"{SVC}/calendars/?locationId={LOC}").get('calendars',[])
    c=next((x for x in cals if x['id']=='UCLiMliOC031tBNCIwoM'),{}); CLOSERS={(t.get('userId') or t.get('id')) for t in (c.get('teamMembers') or [])}
    # Never write a target that is not currently active (a stale id would read
    # as "deleted owner" next run and the sweep would loop on it forever).
    CLOSERS&=ACTIVE
    ACTIVE_SETTERS=[s for s in SET_LIST if s in ACTIVE]
    if not ACTIVE_SETTERS: sys.exit("[credit-sweep] ABORT: no active setters from SET_LIST — roster changed, update SET_LIST")
    CLOSER_LIST=sorted(CLOSERS); SC=set(ACTIVE_SETTERS)|CLOSERS
    pls=jget(f"{SVC}/opportunities/pipelines?locationId={LOC}").get('pipelines',[])
    if not pls: sys.exit("[credit-sweep] ABORT: pipelines fetch empty/failed")
    BOOKED_PIPE=next((p['id'] for p in pls if 'BOOKED APPOINTMENT' in p['name'].upper()),None)
    opps=[]
    for p in pls:
        url=f"{SVC}/opportunities/search?location_id={LOC}&pipeline_id={p['id']}&status=open&limit=100"
        while url:
            d=jget(url)
            for o in d.get('opportunities',[]):
                opps.append({'id':o.get('id'),'contact':(o.get('contact') or {}).get('id') or o.get('contactId'),
                             'owner':o.get('assignedTo'),'pid':o.get('pipelineId')})
            url=(d.get('meta') or {}).get('nextPageUrl'); time.sleep(0.1)
    contact_owner={}
    for o in opps:
        if o['pid'] in DIAL and o['owner'] in SC and o['contact']: contact_owner[o['contact']]=o['owner']
    for o in opps:
        if o['contact'] and o['contact'] not in contact_owner and o['owner'] in SC: contact_owner[o['contact']]=o['owner']
    contact_closer={}
    for o in opps:
        if o['owner'] in CLOSERS and o['contact'] and o['contact'] not in contact_closer: contact_closer[o['contact']]=o['owner']
    fixes=[]; rr=[0]; rc=[0]
    for o in opps:
        if o['owner'] and o['owner'] in ACTIVE: continue   # already credited to a live user
        if BOOKED_PIPE and o['pid']==BOOKED_PIPE:
            tgt=contact_closer.get(o['contact'])
            if not tgt and CLOSER_LIST: tgt=CLOSER_LIST[rc[0]%len(CLOSER_LIST)]; rc[0]+=1
        else:
            tgt=contact_owner.get(o['contact'])
            if not tgt: tgt=ACTIVE_SETTERS[rr[0]%len(ACTIVE_SETTERS)]; rr[0]+=1
        if tgt and tgt in ACTIVE: fixes.append({'opp':o['id'],'new':tgt})
    backlog=len(fixes)
    fixes=fixes[:MAX_WRITES]
    print(f"[credit-sweep] open opps={len(opps)} fixes_needed={backlog} writing={len(fixes)} execute={execute}", flush=True)
    if not fixes or not execute:
        print("[credit-sweep] nothing to write" if not fixes else "[credit-sweep] DRY (pass --execute)"); return
    ok=0; done=0; streak=0
    for f in fixes:
        oc=curl(PH+['-H','Content-Type: application/json','-X','PUT','-d',json.dumps({'assignedTo':f['new']}),f"{SVC}/opportunities/{f['opp']}"])[0]
        done+=1
        if oc.startswith('2'): ok+=1; streak=0
        else:
            streak+=1
            if streak>=FAIL_ABORT:
                print(f"[credit-sweep] ABORT: {FAIL_ABORT} consecutive write failures (last={oc}) after {done} writes", flush=True); break
        if done%200==0:
            rem=daily_remaining()
            if rem is not None and rem < MIN_DAILY_BUDGET:
                print(f"[credit-sweep] STOP: daily budget {rem} < {MIN_DAILY_BUDGET} mid-run", flush=True); break
        time.sleep(WRITE_SLEEP)
    print(f"[credit-sweep] wrote {ok}/{done} opp-owner assignments (backlog {backlog})", flush=True)

if __name__=='__main__': main()

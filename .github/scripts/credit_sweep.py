#!/usr/bin/env python3
"""
CREDIT SWEEP (scheduled) — keep ownership=credit correct as leads cross pipelines.
Hourly GitHub Action. PIT-based (no 1h token). Idempotent: each run only touches
opps that are currently UNASSIGNED or owned by a DELETED user, and assigns:
  - Booked Appointments pipeline  -> a closer (booked = closer credit)
  - everything else               -> the setter who owns that contact's dial lead,
                                     else round-robin to the 14 setters.
This is the durable fix for webinar opps being born unassigned (create_opportunity
has no owner field). Reads GHL_PIT (+ optional GHL_LOCATION_ID) from env.
USAGE (CI): python3 .github/scripts/credit_sweep.py --execute
"""
import os,sys,json,time,subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import threading

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
SETTERS=set(SET_LIST)

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

def main():
    execute='--execute' in sys.argv
    users=jget(f"{SVC}/users/?locationId={LOC}").get('users',[])
    ACTIVE={u['id'] for u in users}
    cals=jget(f"{SVC}/calendars/?locationId={LOC}").get('calendars',[])
    c=next((x for x in cals if x['id']=='UCLiMliOC031tBNCIwoM'),{}); CLOSERS={(t.get('userId') or t.get('id')) for t in (c.get('teamMembers') or [])}
    CLOSER_LIST=sorted(CLOSERS); SC=SETTERS|CLOSERS
    pls=jget(f"{SVC}/opportunities/pipelines?locationId={LOC}").get('pipelines',[])
    BOOKED_PIPE=next((p['id'] for p in pls if 'BOOKED APPOINTMENT' in p['name'].upper()),None)
    opps=[]
    for p in pls:
        url=f"{SVC}/opportunities/search?location_id={LOC}&pipeline_id={p['id']}&status=open&limit=100"
        while url:
            d=jget(url)
            for o in d.get('opportunities',[]):
                opps.append({'id':o.get('id'),'contact':(o.get('contact') or {}).get('id') or o.get('contactId'),
                             'owner':o.get('assignedTo'),'pid':o.get('pipelineId')})
            url=(d.get('meta') or {}).get('nextPageUrl'); time.sleep(0.03)
    contact_owner={}
    for o in opps:
        if o['pid'] in DIAL and o['owner'] in SETTERS and o['contact']: contact_owner[o['contact']]=o['owner']
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
            if not tgt: tgt=SET_LIST[rr[0]%len(SET_LIST)]; rr[0]+=1
        if tgt: fixes.append({'opp':o['id'],'new':tgt})
    print(f"[credit-sweep] open opps={len(opps)} fixes_needed={len(fixes)} execute={execute}", flush=True)
    if not fixes or not execute:
        print("[credit-sweep] nothing to write" if not fixes else "[credit-sweep] DRY (pass --execute)"); return
    lock=threading.Lock(); cnt=[0,0]
    def do(f):
        oc=curl(PH+['-H','Content-Type: application/json','-X','PUT','-d',json.dumps({'assignedTo':f['new']}),f"{SVC}/opportunities/{f['opp']}"])[0]
        with lock: cnt[0]+=oc.startswith('2'); cnt[1]+=1
        time.sleep(0.03)
    with ThreadPoolExecutor(max_workers=5) as ex: list(ex.map(do,fixes))
    print(f"[credit-sweep] wrote {cnt[0]}/{cnt[1]} opp-owner assignments", flush=True)

if __name__=='__main__': main()

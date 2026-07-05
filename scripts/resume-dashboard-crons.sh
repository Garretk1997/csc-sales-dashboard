#!/usr/bin/env bash
# Resume the csc-sales-dashboard-worker pipeline after the 2026-07-05 pause
# (GHL rate-limit cutover test with Michael's bot).
#
# Restores BOTH pause levers:
#   1. Cloudflare cron triggers ("*/15 * * * *" sweep + "5 7 * * *" seal)
#   2. The pipeline-keepalive GitHub Action (was disabled because its ping
#      RUNS a sweep tick, so leaving it on would have defeated the pause)
#
# Reads CF_API_TOKEN / CF_ACCOUNT_ID from ~/.claude/.env. Never prints values.
# GitHub re-enable uses your stored git credentials (osxkeychain).
#
# AFTER RESUMING: any Eastern days that went unsealed during the pause need
#   cd worker && npx tsx backfill-seal.ts YYYY-MM-DD --commit
# per missed day (the nightly seal only ever seals "yesterday").

set -euo pipefail

# shellcheck disable=SC1090
source ~/.claude/.env
: "${CF_API_TOKEN:?CF_API_TOKEN missing from ~/.claude/.env}"
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID missing from ~/.claude/.env}"

WORKER="csc-sales-dashboard-worker"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER}/schedules"
CRONS='[{"cron":"*/15 * * * *"},{"cron":"5 7 * * *"}]'

echo "Restoring cron triggers on ${WORKER}..."
put=$(curl -s -m 30 -X PUT "$API" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$CRONS")
echo "$put" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['success'], d; print('PUT ok')"

echo "Verifying with re-GET (never trust the PUT response)..."
curl -s -m 30 "$API" -H "Authorization: Bearer ${CF_API_TOKEN}" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
crons = sorted(s['cron'] for s in d['result']['schedules'])
print('Restored schedule:', crons)
assert crons == ['*/15 * * * *', '5 7 * * *'], 'UNEXPECTED SCHEDULE: %r' % crons
print('VERIFIED')
"

echo "Re-enabling the pipeline-keepalive GitHub Action..."
GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | grep '^password=' | cut -d= -f2)
code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  "https://api.github.com/repos/Garretk1997/csc-sales-dashboard/actions/workflows/keepalive.yml/enable")
if [ "$code" = "204" ]; then
  echo "keepalive re-enabled"
else
  echo "WARN: keepalive enable returned HTTP $code — re-enable manually:"
  echo "  https://github.com/Garretk1997/csc-sales-dashboard/actions/workflows/keepalive.yml"
fi

echo
echo "Pipeline resumed. First cron fires within 15 minutes."
echo "Remember: backfill-seal any Eastern days left unsealed by the pause."

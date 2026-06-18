# GHL Conversations API Reconfirmation — Task 6 Smoke Test

**Date:** 2026-06-17
**Window tested:** Last 6 hours (since 2026-06-17T21:14:51Z)
**Location:** VAG1ZlpvIsGZD369uq8d (Sold It)

## Results

| Metric | Value |
|---|---|
| Total TYPE_CALL messages returned | 725 |
| Messages with non-null altId | 725 / 725 (100%) |
| Messages with non-null duration | 330 / 725 (45%) |

Duration is null for `no-answer` and `voicemail` calls — this is correct GHL behavior.
Connected/completed calls carry a numeric `meta.call.duration` in seconds.

## Sample shapes (redacted — no names/phones)

```
Sample 1: dateAdded=2026-06-18T00:36:12.007Z  direction=outbound  status=no-answer   duration=null  altId=true
Sample 2: dateAdded=2026-06-18T01:45:28.497Z  direction=inbound   status=voicemail   duration=null  altId=true
Sample 3: dateAdded=2026-06-18T00:08:54.007Z  direction=outbound  status=no-answer   duration=null  altId=true
```

## Pagination behavior confirmed

- `/conversations/search` returns conversations in recent-first order (confirmed: lastMessageDate
  descends as cursor advances).
- 200 + empty `conversations` array is the correct end-of-pagination signal.
- Early-stop when `allBeforeWindow && page > 0` is safe given recency ordering.

## Headers verified

- `Authorization: Bearer <GHL_PIT>` — accepted, no 401s.
- `Version: 2021-07-28` — accepted.
- 130ms inter-request sleep respected the 100 req/10s shared limit with no 429s observed.

## Notes for Task 8

- `normalizeApiCall` in `normalize.ts` handles `null` duration gracefully (`Number(null ?? 0) = 0`).
- `altId` is 100% populated for calls in the last 6h; use it as `callSid`.
- `direction` is always present (inbound/outbound) on TYPE_CALL messages.

// worker/src/subreq.ts
// Per-invocation subrequest counter. Cloudflare caps subrequests per Worker
// invocation (Free 50 / Paid 1000); every outbound fetch counts. We bump this
// on each GHL request so each sweep can record how close it ran to the cap —
// that number is the early-warning for the "one growth spurt from the wall"
// problem the cursor checkpoint is meant to keep flat.
let count = 0
export const bumpSubrequest = () => { count++ }
export const resetSubrequests = () => { count = 0 }
export const subrequestCount = () => count

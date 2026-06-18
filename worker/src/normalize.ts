// worker/src/normalize.ts
import { easternDateString } from './time'

export type CallEvent = {
  callSid: string
  ghlMessageId: string
  occurredAt: string
  occurredOn: string
  ownerUserId: string | null
  durationSeconds: number
  status: string
  direction: string | null
  source: 'webhook' | 'api_sweep'
  provisional: boolean
}

const PRECEDENCE: Record<CallEvent['source'], number> = { webhook: 1, api_sweep: 2 }

/** Map a raw GHL TYPE_CALL message to a CallEvent (the authoritative sweep shape). */
export function normalizeApiCall(raw: any): CallEvent {
  const call = (raw?.meta?.call ?? {}) as { duration?: number; status?: string }
  const occurredAt = String(raw?.dateAdded ?? '')
  return {
    callSid: raw?.altId ? String(raw.altId) : `ghl:${raw?.id}`,
    ghlMessageId: String(raw?.id ?? ''),
    occurredAt,
    occurredOn: easternDateString(new Date(occurredAt)),
    ownerUserId: raw?.userId ? String(raw.userId) : null,
    durationSeconds: Number(call.duration ?? 0),
    status: String(call.status ?? 'unknown'),
    direction: raw?.direction ? String(raw.direction) : null,
    source: 'api_sweep',
    provisional: false,
  }
}

/** Resolve two rows for the same callSid. Higher precedence (api_sweep) wins outright. */
export function mergeCallEvent(existing: CallEvent | null, incoming: CallEvent): CallEvent {
  if (!existing) return incoming
  return PRECEDENCE[incoming.source] >= PRECEDENCE[existing.source] ? incoming : existing
}

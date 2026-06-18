import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeApiCall, mergeCallEvent, type CallEvent } from '../src/normalize'

// Cast via unknown to reconcile the global URL declared by @cloudflare/workers-types with
// the node:url URL expected by fileURLToPath — both are structurally URL at runtime.
const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/api-call.sample.json', import.meta.url) as unknown as import('node:url').URL), 'utf8'))

describe('normalizeApiCall', () => {
  it('keys on the Twilio CallSid (altId), not the GHL message id', () => {
    const ev = normalizeApiCall(raw)
    expect(ev.callSid).toBe('CA0123456789abcdef0123456789abcdef')
    expect(ev.ghlMessageId).toBe('msg_abc123')
  })
  it('sources owner from the event userId and stamps the Eastern day', () => {
    const ev = normalizeApiCall(raw)
    expect(ev.ownerUserId).toBe('UuQM0jbFS7PeBsy6uagx')
    expect(ev.occurredOn).toBe('2026-06-16') // 03:55Z = 23:55 EDT on the 16th
    expect(ev.durationSeconds).toBe(91)
    expect(ev.status).toBe('completed')
    expect(ev.source).toBe('api_sweep')
    expect(ev.provisional).toBe(false)
  })
  it('falls back to a ghl: prefixed sid when altId is missing', () => {
    const ev = normalizeApiCall({ ...raw, altId: undefined })
    expect(ev.callSid).toBe('ghl:msg_abc123')
  })
})

describe('mergeCallEvent (API-sweep wins)', () => {
  const base = normalizeApiCall(raw)
  it('api_sweep overwrites a prior webhook row', () => {
    const webhookRow: CallEvent = { ...base, source: 'webhook', provisional: true, durationSeconds: 0 }
    const merged = mergeCallEvent(webhookRow, base)
    expect(merged.durationSeconds).toBe(91)
    expect(merged.source).toBe('api_sweep')
    expect(merged.provisional).toBe(false)
  })
  it('a late webhook does NOT overwrite an existing api_sweep row', () => {
    const lateWebhook: CallEvent = { ...base, source: 'webhook', provisional: true, durationSeconds: 5 }
    const merged = mergeCallEvent(base, lateWebhook)
    expect(merged.durationSeconds).toBe(91)
    expect(merged.source).toBe('api_sweep')
  })
})

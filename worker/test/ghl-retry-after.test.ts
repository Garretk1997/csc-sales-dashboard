import { describe, it, expect } from 'vitest'
import { parseRetryAfter } from '../src/ghl'

describe('parseRetryAfter', () => {
  it('returns fallback when header is absent (null)', () => {
    expect(parseRetryAfter(null)).toBe(11)
  })

  it('returns fallback when header is "0" (zero — no sleep is wrong)', () => {
    expect(parseRetryAfter('0')).toBe(11)
  })

  it('returns fallback when header is negative', () => {
    expect(parseRetryAfter('-5')).toBe(11)
  })

  it('returns fallback when header is NaN (non-numeric, non-date string)', () => {
    expect(parseRetryAfter('banana')).toBe(11)
  })

  it('returns the numeric value when header is a valid positive number', () => {
    expect(parseRetryAfter('30')).toBe(30)
    expect(parseRetryAfter('1')).toBe(1)
  })

  it('respects a custom fallback', () => {
    expect(parseRetryAfter(null, 5)).toBe(5)
    expect(parseRetryAfter('0', 20)).toBe(20)
  })

  it('parses a future HTTP-date and returns positive seconds', () => {
    // Build a date 60 seconds in the future
    const future = new Date(Date.now() + 60_000).toUTCString()
    const result = parseRetryAfter(future)
    // Allow ±2 s for test execution time
    expect(result).toBeGreaterThan(55)
    expect(result).toBeLessThan(65)
  })

  it('returns fallback for a past HTTP-date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(parseRetryAfter(past)).toBe(11)
  })
})

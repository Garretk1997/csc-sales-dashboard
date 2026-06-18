// worker/src/time.ts
const ET = 'America/New_York'

/** YYYY-MM-DD for the given instant in America/New_York (DST-safe via IANA). */
export function easternDateString(d: Date): string {
  // en-CA renders ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/** The calendar date string immediately before the given YYYY-MM-DD. */
export function previousEasternDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  // Anchor at noon UTC to avoid any TZ/DST edge when subtracting a day.
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  anchor.setUTCDate(anchor.getUTCDate() - 1)
  return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}-${String(anchor.getUTCDate()).padStart(2, '0')}`
}

/** A YYYY-MM-DD date → an ISO-8601 instant at UTC midnight; non-date strings pass through. */
export function isoMidnight(yyyymmdd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd) ? `${yyyymmdd}T00:00:00.000Z` : yyyymmdd;
}

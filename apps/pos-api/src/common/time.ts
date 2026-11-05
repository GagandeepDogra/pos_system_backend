/** ISO 8601 timestamp in India Standard Time, e.g. 2026-11-05T13:20:00.000+05:30. */
export function nowIst(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 330 * 60_000);
  return shifted.toISOString().replace('Z', '+05:30');
}

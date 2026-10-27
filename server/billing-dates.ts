/** Classroom bill dates follow America/New_York, including daylight saving time. */
export function schoolDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function monthlyDate(date: string, offset: number, day: number) {
  const d = new Date(`${date.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + offset);
  return `${d.toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}`;
}
export function nextMonthlyDate(now: Date, day: number) {
  const date = schoolDate(now); return monthlyDate(date, Number(date.slice(8)) > day ? 1 : 0, day);
}
export function billDueAt(date: string) {
  const utc = new Date(`${date}T23:59:59.999Z`);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(utc));
  return new Date(utc.getTime() + (23 - hour) * 3600000).toISOString();
}
export function statementReady(dueDate: string, now: Date) {
  const cutoff = new Date(`${schoolDate(now)}T12:00:00Z`); cutoff.setUTCDate(cutoff.getUTCDate() + 7);
  return dueDate <= cutoff.toISOString().slice(0, 10);
}

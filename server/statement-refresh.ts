import { schoolDate } from './billing-dates.js';

/** The statement window changes on a school-calendar date, not every minute.
 * A failed sweep remains retryable; concurrent ticks share one sweep. Direct
 * per-student issuance on account reads/choices remains independent of this. */
export function dailyStatementRefresh(sweep: (now: Date) => Promise<void>) {
  let completedDay = '';
  let pending: Promise<boolean> | null = null;
  return (now = new Date()): Promise<boolean> => {
    if (pending) return pending;
    const day = schoolDate(now);
    if (day === completedDay) return Promise.resolve(false);
    const operation = Promise.resolve().then(() => sweep(now)).then(() => {
      completedDay = day;
      return true;
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation;
  };
}

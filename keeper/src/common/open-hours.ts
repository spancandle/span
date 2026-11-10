import { hourAt } from "./event-hours.js";

/* NYSE full-day holidays, 2026-10-30 through 2027-12-31, read from
   https://www.nyse.com/markets/hours-calendars on 2026-10-29. Early closes still open at 09:30. */
const NYSE_HOLIDAYS = new Set([
  "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const hours: bigint[] = [];
for (let day = Date.parse("2026-10-30T00:00:00Z"); day <= Date.parse("2027-12-31T00:00:00Z"); day += 86400000) {
  const date = new Date(day).toISOString().slice(0, 10), weekday = new Date(day).getUTCDay();
  if (weekday === 0 || weekday === 6 || NYSE_HOLIDAYS.has(date)) continue;
  const t = hourAt(date, "09:30");
  if (t === null) throw Error("Invalid NYSE opening minute");
  hours.push(BigInt(t) - 60n);
}
/** SOL 60-minute candle starts; neither asset nor duration expansion applies. */
export const OPEN_HOURS: readonly bigint[] = Object.freeze(hours);

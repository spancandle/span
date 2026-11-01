import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cleanText } from "../../../program/client/reason.js";
import { ROOT } from "./env.js";
import { log, type Logger } from "./log.js";
import { RELEASE_HOURS } from "./release-hours.js";
/** An hour listed for news: `t` is the named minute and its candle opens at `t - 60`, as for a release. */
export type ListedHour = {
  date: string;
  et: string;
  t: number;
  name: string;
  why: string;
  source: string;
};
export type EventHours = { hours: ListedHour[]; hide: number[] };
export type Skipped = { t: unknown; cause: string };
/** The named minutes of the release schedule; a listed hour may not take one. */
export const RELEASE_TS: readonly number[] = RELEASE_HOURS.map((t0) => Number(t0) + 60);
/** The listed-hours file, or null when the feature is off. */
export function eventHoursPath(env: NodeJS.ProcessEnv = process.env) {
  const value = env.SPAN_EVENT_HOURS?.trim();
  return value ? resolve(ROOT, value) : null;
}
const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
export function ny(t: number) {
  const p = Object.fromEntries(
    NY.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hm: `${p.hour}:${p.minute}`,
    hms: `${p.hour}:${p.minute}:${p.second}`,
  };
}
/** The one instant a New York wall minute names; null for a malformed one, the spring gap and the repeated autumn hour. */
export function hourAt(date: string, hm: string): number | null {
  if (
    typeof date !== "string" ||
    typeof hm !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hm)
  )
    return null;
  const day = Date.parse(date + "T12:00:00Z") / 1000;
  if (
    !Number.isFinite(day) ||
    new Date(day * 1000).toISOString().slice(0, 10) !== date
  )
    return null;
  const offsets = [
    ...new Set(
      [-86400, 0, 86400].map((d) => {
        const t = day + d,
          w = ny(t);
        return Date.parse(w.date + "T" + w.hms + "Z") / 1000 - t;
      }),
    ),
  ];
  const wall = Date.parse(date + "T" + hm + ":00Z") / 1000;
  const ts = offsets
    .map((o) => wall - o)
    .filter((t) => {
      const w = ny(t);
      return w.date === date && w.hm === hm;
    });
  return ts.length === 1 ? ts[0] : null;
}
/** Why one listed row cannot be used, or null when it can. */
export function hourFault(
  row: any,
  releaseTs: readonly number[],
): string | null {
  if (!row || typeof row !== "object") return "row";
  if (!Number.isSafeInteger(row.t) || row.t % 60 !== 0) return "t";
  if (hourAt(row.date, row.et) !== row.t) return "wall";
  if (row.et === "09:30") return "open";
  if (releaseTs.includes(row.t)) return "release";
  if (typeof row.name !== "string" || cleanText(row.name, 24) === null)
    return "name";
  if (typeof row.why !== "string" || cleanText(row.why, 100) === null)
    return "why";
  if (typeof row.source !== "string" || row.source.length > 300)
    return "source";
  try {
    if (new URL(row.source).protocol !== "https:") return "source";
  } catch {
    return "source";
  }
  return null;
}
/** The usable rows of a listed-hours file and the rows dropped with their cause. Throws when the file is not one. */
export function parseHours(
  text: string,
  releaseTs: readonly number[] = RELEASE_TS,
): EventHours & { skipped: Skipped[] } {
  const doc = JSON.parse(text);
  if (!doc || doc.v !== 1 || !Array.isArray(doc.hours))
    throw Error("Invalid listed hours");
  const hours: ListedHour[] = [],
    skipped: Skipped[] = [];
  for (const row of doc.hours) {
    const cause =
      hourFault(row, releaseTs) ??
      (hours.some((h) => h.t === row.t) ? "duplicate" : null);
    if (cause) {
      skipped.push({ t: row?.t ?? null, cause });
      continue;
    }
    hours.push({
      date: row.date,
      et: row.et,
      t: row.t,
      name: cleanText(row.name, 24)!,
      why: cleanText(row.why, 100)!,
      source: row.source,
    });
  }
  const hide = (Array.isArray(doc.hide) ? doc.hide : []).filter(
    (t: unknown) => Number.isSafeInteger(t) && (t as number) % 60 === 0,
  );
  return { hours: hours.sort((a, b) => a.t - b.t), hide, skipped };
}
/** The listed-hours file as the running processes see it: the last good read stays when the file cannot be read. */
export class EventHoursFile {
  hours: ListedHour[] = [];
  hide: number[] = [];
  private seen: number | null | undefined;
  constructor(
    readonly path: string,
    readonly releaseTs: readonly number[] = RELEASE_TS,
    readonly logger: Logger = log,
  ) {}
  /** Reads the file when its mtime moved; true when the list or the hidden hours changed. */
  read(): boolean {
    let mtime: number | null;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      mtime = null;
    }
    if (mtime === this.seen) return false;
    this.seen = mtime;
    let parsed: ReturnType<typeof parseHours>;
    try {
      if (mtime === null) throw Error("Listed hours unavailable");
      parsed = parseHours(readFileSync(this.path, "utf8"), this.releaseTs);
    } catch {
      this.logger({ event: "hours-unreadable" });
      return false;
    }
    for (const x of parsed.skipped)
      this.logger({ event: "hours-skipped", t: x.t, cause: x.cause });
    const before = JSON.stringify([this.hours, this.hide]);
    this.hours = parsed.hours;
    this.hide = parsed.hide;
    return JSON.stringify([this.hours, this.hide]) !== before;
  }
  /** Candle t0s of the listed hours. */
  t0s() {
    return this.hours.map((h) => BigInt(h.t) - 60n);
  }
  /** Looks again every ten seconds; `changed` runs when the list moved. */
  watch(changed: () => void, ms = 10000) {
    const timer = setInterval(() => {
      if (this.read()) changed();
    }, ms);
    return () => clearInterval(timer);
  }
}

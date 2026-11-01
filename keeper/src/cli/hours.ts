import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanText } from "../../../program/client/reason.js";
import {
  eventHoursPath,
  hourAt,
  hourFault,
  parseHours,
  RELEASE_TS,
} from "../common/event-hours.js";
const utc = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
function flags(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw Error(`Unexpected argument ${args[i]}`);
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}
function minute(value: string | undefined) {
  const t = Number(value);
  if (!Number.isSafeInteger(t) || t % 60 !== 0) throw Error("--t takes a named minute in unix seconds");
  return t;
}
function describe(row: any, now: number) {
  const t0 = row.t - 60;
  return [
    `${row.date} ${row.et} ET · ${row.name} · ${row.why} · ${row.source}`,
    `t ${row.t} · candle t0 ${t0} (${utc(t0)})`,
    `the keeper opens it at ${utc(Math.max(t0 - 86400, now))}`,
  ];
}
/** One command on the listed-hours file. The file changes only when the command succeeds, through a renamed temporary file. */
export function hoursCommand(argv: string[], path: string, now = Math.floor(Date.now() / 1000)) {
  const [command, ...rest] = argv, f = flags(rest), out: string[] = [];
  const exists = existsSync(path);
  if (!exists && command !== "add") throw Error("No listed hours file yet; add writes it");
  const doc = exists ? JSON.parse(readFileSync(path, "utf8")) : { v: 1, hours: [], hide: [] };
  if (!doc || doc.v !== 1 || !Array.isArray(doc.hours)) throw Error("Not a listed hours file");
  if (!Array.isArray(doc.hide)) doc.hide = [];
  const write = () => {
    doc.hours.sort((a: any, b: any) => (Number(a?.t) || 0) - (Number(b?.t) || 0));
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    renameSync(tmp, path);
  };
  if (command === "list") {
    const parsed = parseHours(readFileSync(path, "utf8"));
    for (const row of parsed.hours) out.push(...describe(row, now), "");
    for (const x of parsed.skipped) out.push(`skipped t ${x.t}: ${x.cause}`);
    out.push(`hidden seller reasons: ${parsed.hide.length ? parsed.hide.join(", ") : "none"}`);
    return out;
  }
  if (command === "add") {
    const t = hourAt(f.date, f.et);
    if (t === null) throw Error("--date and --et must name one New York minute");
    const name = cleanText(f.name ?? "", 24), why = cleanText(f.why ?? "", 100);
    if (name === null) throw Error("--name takes up to 24 plain characters, no links");
    if (why === null) throw Error("--why takes up to 100 plain characters, no links");
    const row = { date: f.date, et: f.et, t, name, why, source: f.source };
    const fault = hourFault(row, RELEASE_TS);
    if (fault) throw Error(`Rejected: ${fault}`);
    if (doc.hours.some((x: any) => x?.t === t)) throw Error("Rejected: that hour is already listed");
    if (t - 60 < now + 300) throw Error("Rejected: the candle would open within five minutes or has passed");
    doc.hours.push(row);
    if (!parseHours(JSON.stringify(doc)).hours.some((x) => x.t === t)) throw Error("Rejected");
    write();
    return ["added", ...describe(row, now)];
  }
  if (command === "remove") {
    const t = minute(f.t), i = doc.hours.findIndex((x: any) => x?.t === t);
    if (i < 0) throw Error("No listed hour at that t");
    const [row] = doc.hours.splice(i, 1);
    write();
    return [`removed t ${t} · ${row.name ?? ""}`, "a candle already opened stays; without a ticket it is not read further"];
  }
  if (command === "hide" || command === "unhide") {
    const t = minute(f.t), has = doc.hide.includes(t);
    if (command === "hide" ? has : !has) throw Error(command === "hide" ? "Already hidden" : "Not hidden");
    doc.hide = command === "hide" ? [...doc.hide, t].sort((a: number, b: number) => a - b) : doc.hide.filter((x: number) => x !== t);
    write();
    return [`${command === "hide" ? "hid" : "unhid"} the seller's reason at t ${t} (candle t0 ${t - 60})`];
  }
  throw Error("Commands: list, add, remove, hide, unhide");
}
if (process.argv[1]?.endsWith("/cli/hours.ts")) {
  try {
    const path = eventHoursPath();
    if (!path) throw Error("Set SPAN_EVENT_HOURS to the listed hours file");
    for (const line of hoursCommand(process.argv.slice(2), path)) console.log(line);
  } catch (e) {
    console.error(`hours: ${e instanceof Error ? e.message : "failed"}`);
    process.exitCode = 1;
  }
}

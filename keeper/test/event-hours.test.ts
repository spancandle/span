import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase58Decoder, type Instruction } from "@solana/kit";
import { Harness, accountData } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { cleanText } from "../../program/client/reason.js";
import { RELEASE_HOURS } from "../src/common/release-hours.js";
import { EventHoursFile, eventHoursPath, hourAt, parseHours, RELEASE_TS } from "../src/common/event-hours.js";
import { hoursCommand } from "../src/cli/hours.js";
import { Engine, type EnginePort } from "../src/keeper/engine.js";
import { createPrepare } from "../src/keeper/main.js";
import { CreationBudget } from "../src/keeper/budget.js";
import type { Chain } from "../src/keeper/chain.js";
import type { Prepared } from "../src/keeper/sender.js";
import { Store } from "../src/common/sqlite.js";
import { History, MEMO, hourReason } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
import { httpServer, atomicFile } from "../src/tape/http.js";
import { validateDocument } from "./schemas.js";

/* a listed hour two hours after a release, and the file rows that name one */
const L = RELEASE_HOURS[1] + 7200n;
const wall = (t: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, et: `${p.hour}:${p.minute}` };
};
const row = (t: number, x: Record<string, unknown> = {}) => ({ ...wall(t), t, name: "Exchange reopens", why: "Withdrawals resume after the halt", source: "https://example.org/notice", ...x });
const file = (hours: unknown[], hide: unknown[] = []) => JSON.stringify({ v: 1, hours, hide });

describe("E1 a reason as span keeps it", () => {
  it("keeps plain one-line text and refuses links, other characters and length", () => {
    const table: [string, string | null][] = [
      ["ETF decision due at 4pm", "ETF decision due at 4pm"],
      ["  U.S. CPI   revision, 3.5% expected ", "U.S. CPI revision, 3.5% expected"],
      ["S&P 500 rebalance: is SOL in?", "S&P 500 rebalance: is SOL in?"],
      ["see https://example.org", null],
      ["span.press", null],
      ["ask @spancandle", null],
      ["café reopens", null],
      ["halt\tlifted", "halt lifted"],
      ["\u0007bell", null],
      ["a".repeat(101), null],
      ["", null],
      ["   ", null],
    ];
    for (const [text, out] of table) expect(cleanText(text, 100), JSON.stringify(text)).toBe(out);
    expect(cleanText("a".repeat(100), 100)).toBe("a".repeat(100));
  });
});

describe("E2 the listed-hours file", () => {
  const A = Number(L) + 60, B = A + 3600;
  it("drops only the row at fault and keeps the rest", () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ t: A + 1 }, "t"], [{ et: "11:00" }, "wall"], [{ name: "x".repeat(25) }, "name"], [{ name: "see span.press" }, "name"],
      [{ why: "naïve" }, "why"], [{ why: "" }, "why"], [{ source: "http://example.org/" }, "source"], [{ source: "not a url" }, "source"],
      [{ source: "https://example.org/" + "x".repeat(300) }, "source"],
    ];
    for (const [edit, cause] of bad) {
      const p = parseHours(file([row(B), row(A, edit)]));
      expect(p.hours.map((h) => h.t), cause).toEqual([B]);
      expect(p.skipped, cause).toEqual([{ t: edit.t ?? A, cause }]);
    }
    const p = parseHours(file([row(B), row(A, { name: "  Exchange   reopens " })]));
    expect(p.hours.map((h) => [h.t, h.name])).toEqual([[A, "Exchange reopens"], [B, "Exchange reopens"]]);
  });
  it("refuses the daylight-saving edges, a release minute, the US open and a second row at one minute", () => {
    const twice = Date.parse("2026-11-01T05:30:00Z") / 1000, never = Date.parse("2027-03-14T07:30:00Z") / 1000;
    expect(hourAt("2026-11-01", "01:30")).toBeNull();
    expect(hourAt("2027-03-14", "02:30")).toBeNull();
    for (const [r, cause] of [
      [row(twice, { date: "2026-11-01", et: "01:30" }), "wall"],
      [row(twice + 3600, { date: "2026-11-01", et: "01:30" }), "wall"],
      [row(never, { date: "2027-03-14", et: "02:30" }), "wall"],
      [row(RELEASE_TS[1]), "release"],
      [row(hourAt("2026-11-04", "09:30")!), "open"],
    ] as const) expect(parseHours(file([r])).skipped.map((x) => x.cause)).toEqual([cause]);
    const p = parseHours(file([row(A), row(A, { name: "Second" })]));
    expect([p.hours.map((h) => h.name), p.skipped]).toEqual([["Exchange reopens"], [{ t: A, cause: "duplicate" }]]);
  });
  it("reads the hidden hours", () => {
    expect(parseHours(file([], [A, A + 1, "x", B])).hide).toEqual([A, B]);
    expect(parseHours(JSON.stringify({ v: 1, hours: [] })).hide).toEqual([]);
    expect(() => parseHours("{")).toThrow();
    expect(() => parseHours(JSON.stringify({ v: 2, hours: [] }))).toThrow();
  });
  it("keeps the last list through a broken file and reads again only when the mtime moves", () => {
    const dir = mkdtempSync(join(tmpdir(), "span-hours-")), path = join(dir, "hours.json"), logs: any[] = [];
    const f = new EventHoursFile(path, RELEASE_TS, (e) => logs.push(e));
    expect(f.read()).toBe(false);
    expect([f.hours, logs]).toEqual([[], [{ event: "hours-unreadable" }]]);
    const at = (ms: number) => utimesSync(path, new Date(ms), new Date(ms));
    writeFileSync(path, file([row(A), row(B, { why: "a.b.example" })], [B])); at(1800000000000);
    expect(f.read()).toBe(true);
    expect([f.hours.map((h) => h.t), f.hide, f.t0s()]).toEqual([[A], [B], [BigInt(A - 60)]]);
    expect(logs.at(-1)).toEqual({ event: "hours-skipped", t: B, cause: "why" });
    writeFileSync(path, "{ broken"); at(1800000000000);
    const n = logs.length;
    expect(f.read()).toBe(false);
    expect(logs).toHaveLength(n);
    at(1800000005000);
    expect(f.read()).toBe(false);
    expect(logs.slice(n)).toEqual([{ event: "hours-unreadable" }]);
    expect(f.hours.map((h) => h.t)).toEqual([A]);
    writeFileSync(path, file([row(B)])); at(1800000010000);
    expect(f.read()).toBe(true);
    expect(f.hours.map((h) => h.t)).toEqual([B]);
    expect(f.read()).toBe(false);
  });
  it("takes its path from SPAN_EVENT_HOURS, relative to the repository", () => {
    expect(eventHoursPath({})).toBeNull();
    expect(eventHoursPath({ SPAN_EVENT_HOURS: " " })).toBeNull();
    expect(eventHoursPath({ SPAN_EVENT_HOURS: "keeper/data/x.json" })).toMatch(/\/keeper\/data\/x\.json$/);
    expect(eventHoursPath({ SPAN_EVENT_HOURS: "/tmp/x.json" })).toBe("/tmp/x.json");
  });
});

describe("E3 npm run hours", () => {
  const now = Date.parse("2026-11-01T12:00:00Z") / 1000, T = hourAt("2026-11-04", "10:00")!;
  const add = (path: string, x: Record<string, string> = {}, at = now) => {
    const o = { date: "2026-11-04", et: "10:00", name: "Exchange reopens", why: "Withdrawals resume after the halt", source: "https://example.org/notice", ...x };
    return hoursCommand(["add", ...Object.entries(o).flatMap(([k, v]) => [`--${k}`, v])], path, at);
  };
  it("add writes the file sorted, through a renamed temporary file, and says when the keeper opens it", () => {
    const dir = mkdtempSync(join(tmpdir(), "span-hours-")), path = join(dir, "hours.json");
    expect(T).toBe(1793804400);
    expect(add(path)).toEqual(["added", "2026-11-04 10:00 ET · Exchange reopens · Withdrawals resume after the halt · https://example.org/notice",
      "t 1793804400 · candle t0 1793804340 (2026-11-04T14:59:00Z)", "the keeper opens it at 2026-11-03T14:59:00Z"]);
    const ino = statSync(path).ino;
    expect(add(path, { date: "2026-11-01", et: "23:00", name: "  Ruling   due " }).at(-1)).toBe("the keeper opens it at 2026-11-01T12:00:00Z");
    expect(statSync(path).ino).not.toBe(ino);
    expect(readdirSync(dir)).toEqual(["hours.json"]);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.hours.map((h: any) => [h.date, h.et, h.name])).toEqual([["2026-11-01", "23:00", "Ruling due"], ["2026-11-04", "10:00", "Exchange reopens"]]);
    expect(parseHours(readFileSync(path, "utf8")).skipped).toEqual([]);
    expect(hoursCommand(["list"], path, now)[0]).toBe("2026-11-01 23:00 ET · Ruling due · Withdrawals resume after the halt · https://example.org/notice");
  });
  it("refuses an hour whose candle opens within five minutes, and leaves the file byte for byte after any refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "span-hours-")), path = join(dir, "hours.json");
    expect(() => add(path, {}, T - 60 - 299)).toThrow(/five minutes/);
    expect(existsSync(path)).toBe(false);
    add(path, {}, T - 360);
    const before = readFileSync(path);
    for (const x of [{ et: "10:00" }, { date: "2026-11-01", et: "01:30" }, { date: "2027-03-14", et: "02:30" }, { et: "09:30" }, { name: "x".repeat(25) },
      { why: "see www.example.org" }, { source: "http://example.org/" }, { date: "2026-11-06", et: "08:30" }] as Record<string, string>[])
      expect(() => add(path, x, now), JSON.stringify(x)).toThrow();
    for (const argv of [["remove", "--t", String(T + 60)], ["unhide", "--t", String(T)], ["hide", "--t", "17"], ["drop"], ["add", "--date"]])
      expect(() => hoursCommand(argv, path, now), argv.join(" ")).toThrow();
    expect(readFileSync(path)).toEqual(before);
    writeFileSync(path, "{ broken");
    expect(() => add(path, { date: "2026-11-05" }, now)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });
  it("remove, hide and unhide", () => {
    const dir = mkdtempSync(join(tmpdir(), "span-hours-")), path = join(dir, "hours.json");
    expect(() => hoursCommand(["hide", "--t", String(T)], path, now)).toThrow(/add writes it/);
    add(path);
    hoursCommand(["hide", "--t", String(T + 3600)], path, now);
    hoursCommand(["hide", "--t", String(T + 60)], path, now);
    expect(JSON.parse(readFileSync(path, "utf8")).hide).toEqual([T + 60, T + 3600]);
    expect(() => hoursCommand(["hide", "--t", String(T + 60)], path, now)).toThrow(/Already/);
    hoursCommand(["unhide", "--t", String(T + 3600)], path, now);
    expect(parseHours(readFileSync(path, "utf8")).hide).toEqual([T + 60]);
    hoursCommand(["remove", "--t", String(T)], path, now);
    expect(parseHours(readFileSync(path, "utf8")).hours).toEqual([]);
  });
});

/* the keeper as release-hours.test drives it, on the LiteSVM program */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setTimeout(r, 5)); };
async function keeper(t0 = L) {
  const h = await Harness.create(), ref = await h.ref(t0);
  let now = t0 - 86401n;
  const chain = { configKey: h.config, config: s.getConfigDecoder().decode(accountData(h.svm, h.config)), candles: new Map(), tickets: new Map(), now: () => now } as unknown as Chain;
  const budget = new CreationBudget({ call: vi.fn() } as any, h.marker.address, 50000000n, 0n); budget.ready = true;
  const sent: Prepared[] = [], logs: any[] = [], ixs = new Map<string, readonly Instruction[]>();
  const prepare = await createPrepare({ cluster: "mainnet", call: vi.fn(async () => 1905000) } as any, h.marker, chain, { register: (key, list) => { ixs.set(key, list); } },
    () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n }));
  const port: EnginePort = { blockhash: () => "11111111111111111111111111111111", price: () => 10000n, prepare, send: (p) => { sent.push(p); }, cancel: vi.fn() };
  const engine = new Engine(chain, h.marker.address, port, budget, (e) => logs.push(e));
  const setNow = (n: bigint) => { now = n; h.clock(n); };
  const sync = () => chain.candles.set(ref.candle, { value: h.candleState(ref), slot: 1, data: "" });
  return { h, ref, chain, budget, sent, logs, ixs, port, engine, setNow, sync };
}
describe("E4 the keeper opens and reads listed hours", () => {
  it("a listed hour opens a day ahead, as a release hour does", async () => {
    const x = await keeper();
    x.engine.listHours([L]);
    x.engine.update(); await flush();
    expect(x.sent).toHaveLength(0);
    x.setNow(L - 86400n); x.engine.update(); await flush();
    expect(x.sent.map((p) => [p.action.kind, p.action.t0])).toEqual([["open", L]]);
    expect(x.sent[0].rent).toBe(1905000n);
    await x.h.send("open listed", x.ixs.get(x.sent[0].action.key)!, x.h.marker); x.sync(); x.engine.update();
    expect(x.logs.filter((e) => e.event === "recorded" && e.kind === "open")).toEqual([expect.objectContaining({ t0: L })]);
    x.engine.close();
  });
  it("an open still waiting for an hour taken off the list is dropped", async () => {
    const x = await keeper();
    x.engine.listHours([L]); x.budget.used = 49000000n; x.setNow(L - 86400n); x.engine.update(); await flush();
    expect(x.budget.waiting.has(`open:${L}`)).toBe(true);
    x.engine.listHours([]);
    expect([x.budget.waiting.size, x.engine.prepared.size]).toEqual([0, 0]);
    x.budget.used = 0n; x.engine.update(); await flush();
    expect(x.sent).toHaveLength(0);
    x.engine.close();
    const y = await keeper();
    y.engine.listHours([L]); y.setNow(L - 86400n); y.engine.update(); await flush();
    expect([y.sent.length, y.engine.pending.has(`open:${L}`)]).toEqual([1, true]);
    y.engine.listHours([L + 3600n]);
    expect(y.engine.pending.size).toBe(0);
    expect(y.port.cancel).toHaveBeenCalledWith(`open:${L}`);
    y.engine.close();
  });
  it("reads a listed candle without a ticket thirteen times, and stops once it leaves the list", async () => {
    const x = await keeper();
    x.engine.listHours([L]); x.setNow(L - 100n);
    await x.h.send("listed open", x.h.openCandleIx(x.ref)); x.sync();
    const read = async (j: number) => {
      x.setNow(L + BigInt(j * 300)); const price = 10000000000n + BigInt(j) * 1000000n; x.h.price(price, L + BigInt(j * 300));
      x.chain.feed = { price, publishTs: L + BigInt(j * 300), source: "poll", recvMs: Date.now(), slot: j + 1 };
      x.engine.update(); await flush();
    };
    for (let j = 0; j < 13; j++) {
      await read(j);
      const p = x.sent.at(-1)!;
      expect([p.action.kind, p.action.j, p.action.t0]).toEqual(["read", j, L]);
      await x.h.send(`read ${j}`, x.ixs.get(p.action.key)!, x.h.marker); x.sync(); x.engine.update();
    }
    expect(x.h.candleState(x.ref).reads.every((r) => r.price > 0n)).toBe(true);
    x.engine.close();
    const y = await keeper();
    y.engine.listHours([L]); y.setNow(L - 100n);
    await y.h.send("listed open", y.h.openCandleIx(y.ref)); y.sync();
    y.setNow(L); y.h.price(10000000000n, L); y.chain.feed = { price: 10000000000n, publishTs: L, source: "poll", recvMs: Date.now(), slot: 1 };
    y.engine.update(); await flush();
    await y.h.send("read 0", y.ixs.get(y.sent.at(-1)!.action.key)!, y.h.marker); y.sync();
    y.engine.listHours([]);
    y.setNow(L + 300n); y.h.price(10001000000n, L + 300n); y.chain.feed = { price: 10001000000n, publishTs: L + 300n, source: "poll", recvMs: Date.now(), slot: 2 };
    y.engine.update(); await flush();
    expect(y.sent.map((p) => p.action.kind)).toEqual(["read"]);
    y.engine.close();
  });
});

/* a confirmed transaction as getTransaction returns it: top-level instructions, and the program's events as inner ones */
const EVENT = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
const b58 = (b: Uint8Array) => getBase58Decoder().decode(b);
const PAYER = "HLZLpfZAaDryMACHyrc4RuCRWohow8HbEvQA6cGdN79S";
/* sale: the hour of the ticket the transaction opens, by default the candle's own as a sale on Sell sends it; null for none */
function tx(o: { t0?: bigint; memo?: Uint8Array | string; slot?: number; err?: unknown; sale?: bigint | null }) {
  const memo = typeof o.memo === "string" ? new TextEncoder().encode(o.memo) : o.memo, sale = o.sale === undefined ? o.t0 : o.sale;
  const event = (bytes: ReturnType<ReturnType<typeof s.getCandleOpenedEventEncoder>["encode"]>) => ({ programIdIndex: 1, data: b58(Buffer.concat([EVENT, Buffer.from(bytes)])) });
  const events = [
    ...(o.t0 === undefined ? [] : [event(s.getCandleOpenedEventEncoder().encode({ candle: PAYER as any, t0: o.t0, readWindow: 20, ageLimit: 20, buyCutoff: 5 }))]),
    ...(sale == null ? [] : [event(s.getTicketOpenedEventEncoder().encode({ ticket: PAYER as any, id: 1n, t0: sale, seller: PAYER as any, premium: 100000n, strikeBps: 500, deposit: 39900000n }))]),
  ];
  return {
    slot: o.slot ?? 1, blockTime: 1000,
    transaction: { message: { accountKeys: [PAYER, s.SPAN_PROGRAM_ADDRESS, MEMO], instructions: [
      { programIdIndex: 1, accounts: [], data: b58(new Uint8Array([1, 2, 3])) },
      ...(memo ? [{ programIdIndex: 2, accounts: [], data: b58(memo) }] : []),
    ] } },
    meta: { err: o.err ?? null, innerInstructions: events.length ? [{ index: 0, instructions: events }] : [] },
  };
}
const reasons = (store: Store) => store.db.prepare("SELECT * FROM hour_reason ORDER BY t0").all().map((r) => ({ ...r }));
describe("E5 the tape publishes listed hours and sellers' reasons", () => {
  it("a candle opened with a memo makes one reason; nothing else does", () => {
    const store = new Store(":memory:"), history = new History(store, { cluster: "devnet" } as any, () => {});
    history.ingest("S1", tx({ t0: L, memo: "  Ruling   due at noon " }));
    history.ingest("S2", tx({ memo: "a memo with no candle opened" }));
    history.ingest("S3", tx({ t0: L + 60n, memo: "café reopens" }));
    history.ingest("S4", tx({ t0: L + 120n, memo: "read span.press" }));
    history.ingest("S5", tx({ t0: L + 180n, memo: new Uint8Array([0xff, 0xfe, 0x41]) }));
    history.ingest("S6", tx({ t0: L + 240n }));
    history.ingest("S7", tx({ t0: L + 300n, memo: "failed", err: { InstructionError: [1, { Custom: 6018 }] } }));
    history.ingest("S8", tx({ t0: L, memo: "a second opening cannot replace it" }));
    expect(reasons(store)).toEqual([{ t0: String(L), why: "Ruling due at noon", opener: PAYER, sig: "S1" }]);
    expect(hourReason(tx({ t0: L, memo: "x".repeat(101) }))).toBeNull();
    store.close();
  });
  it("a memo is a seller's reason only in the sale that opened the candle", () => {
    const store = new Store(":memory:"), history = new History(store, { cluster: "devnet" } as any, () => {});
    history.ingest("O1", tx({ t0: L, memo: "An opening without a ticket", sale: null }));
    history.ingest("O2", tx({ t0: L + 60n, memo: "A ticket for another hour", sale: L + 120n }));
    history.ingest("O3", tx({ memo: "A sale on a candle already open", sale: L + 180n }));
    expect(reasons(store)).toEqual([]);
    history.ingest("O4", tx({ t0: L + 240n, memo: "The sale that opened it" }));
    expect(reasons(store).map((r: any) => [r.t0, r.sig])).toEqual([[String(L + 240n), "O4"]]);
    store.close();
  });
  it("rebuilds the reasons at start from the stored transactions", () => {
    const store = new Store(":memory:"), history = new History(store, { cluster: "devnet" } as any, () => {});
    history.ingest("S1", tx({ t0: L, memo: "Ruling due at noon" }));
    history.ingest("S2", tx({ t0: L + 60n, memo: "Exchange reopens" }));
    store.db.exec("DELETE FROM hour_reason");
    const again = new History(store, { cluster: "devnet" } as any, () => {});
    again.refillReasons(); again.refillReasons();
    expect(reasons(store).map((r: any) => [r.t0, r.why, r.sig])).toEqual([[String(L), "Ruling due at noon", "S1"], [String(L + 60n), "Exchange reopens", "S2"]]);
    store.close();
  });
  function publisher(list: () => { hours: any[]; hide: number[] }) {
    const store = new Store(":memory:"), rpc = { cluster: "devnet" } as any, dir = mkdtempSync(join(tmpdir(), "span-hours-tape-"));
    const chain = { rpc, candles: new Map(), tickets: new Map(), now: () => L, lastReadMs: 0 } as unknown as Chain;
    const pub = new Publisher(store, chain, new History(store, rpc, () => {}), new DovesRecorder(store, rpc), dir, undefined, RELEASE_HOURS, list);
    const read = () => JSON.parse(readFileSync(join(dir, "hours.json"), "utf8"));
    return { store, dir, pub, read };
  }
  it("hours.json: the list wins over a seller at one hour, hide hides a seller, ascending, the latest 500 sellers", () => {
    const A = Number(L) + 60, list = { hours: [parseHours(file([row(A)])).hours[0]], hide: [A + 120] };
    const x = publisher(() => list);
    const put = x.store.db.prepare("INSERT INTO hour_reason VALUES(?,?,?,?)");
    for (let i = 0; i < 505; i++) put.run(String(Number(L) - 60 * (i + 1)), `reason ${i}`, PAYER, `S${i}`);
    put.run(String(L), "a seller at the listed hour", PAYER, "SL");
    put.run(String(L + 120n), "hidden", PAYER, "SH");
    put.run(String(L + 60n), "kept", PAYER, "SK");
    x.store.change();
    x.pub.publish(10000);
    const doc = x.read();
    validateDocument("hours", doc);
    const t0s = doc.hours.map((h: any) => Number(h.t0));
    expect(t0s).toEqual([...t0s].sort((a, b) => a - b));
    expect(doc.hours.filter((h: any) => h.by === "seller")).toHaveLength(500);
    expect(doc.hours.at(-2)).toEqual({ asset: "SOL", t0: String(L), name: "Exchange reopens", why: "Withdrawals resume after the halt", source: "https://example.org/notice", by: "list", sig: null });
    expect(doc.hours.at(-1)).toEqual({ asset: "SOL", t0: String(L + 60n), name: null, why: "kept", source: null, by: "seller", sig: "SK" });
    expect(doc.hours.some((h: any) => h.sig === "SH" || h.sig === "SL")).toBe(false);
    expect(doc.hours[0].why).toBe("reason 498");
    const before = readFileSync(join(x.dir, "hours.json"), "utf8");
    x.store.change(); x.pub.publish(20000);
    expect(readFileSync(join(x.dir, "hours.json"), "utf8")).toBe(before);
    list.hide = [];
    x.pub.publish(30000);
    expect(x.read().hours.some((h: any) => h.sig === "SH")).toBe(true);
    x.store.close();
  });
  it("without listed hours the file holds the sellers' reasons only", () => {
    const x = publisher(() => ({ hours: [], hide: [] }));
    x.pub.publish(10000);
    expect(x.read().hours).toEqual([]);
    x.store.db.prepare("INSERT INTO hour_reason VALUES(?,?,?,?)").run(String(L), "Ruling due at noon", PAYER, "S1"); x.store.change();
    x.pub.publish(20000);
    expect(x.read().hours.map((h: any) => [h.by, h.why])).toEqual([["seller", "Ruling due at noon"]]);
    x.store.close();
  });
  it("history keeps a closed listed hour without a ticket", async () => {
    const h = await Harness.create(), ref = await h.ref(L);
    let now = L - 100n, hours: bigint[] = [];
    h.clock(now); await h.send("listed open", h.openCandleIx(ref));
    const chain = { rpc: { cluster: "devnet" }, configKey: h.config, config: s.getConfigDecoder().decode(accountData(h.svm, h.config)), lastReadMs: 0,
      candles: new Map([[ref.candle, { value: h.candleState(ref), slot: 1, data: "" }]]), tickets: new Map(), now: () => now } as unknown as Chain;
    const store = new Store(":memory:"), rpc = { cluster: "devnet" } as any, dir = mkdtempSync(join(tmpdir(), "span-hours-history-"));
    const pub = new Publisher(store, chain, new History(store, rpc, () => {}), new DovesRecorder(store, rpc), dir, undefined, () => [...RELEASE_HOURS, ...hours]);
    const candles = () => JSON.parse(readFileSync(join(dir, "history.json"), "utf8")).candles.map((c: any) => c.t0);
    now = s.settleAfter(h.candleState(ref)); pub.publish(10000);
    expect(candles()).toEqual([]);
    hours = [L]; pub.publish(12500);
    expect(candles()).toEqual([String(L)]);
    store.close();
  });
  it("serves /hours.json like history.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "span-hours-http-"));
    atomicFile(dir, "hours.json", { v: 1, generated: 1, hours: [] });
    const server = httpServer(dir);
    await new Promise<void>((r, no) => { server.once("error", no); server.listen(0, "127.0.0.1", r); });
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/hours.json`);
      expect([res.status, res.headers.get("cache-control"), res.headers.get("access-control-allow-origin")]).toEqual([200, "public, max-age=2", "*"]);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(readFileSync(join(dir, "hours.json")));
    } finally { server.closeAllConnections(); server.close(); }
  });
});

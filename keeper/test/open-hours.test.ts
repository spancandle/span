import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction } from "@solana/kit";
import { Harness, accountData } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { releaseHours, RELEASE_HOURS } from "../src/common/release-hours.js";
import schedule from "../src/common/release-hours.json" with { type: "json" };
import { OPEN_HOURS } from "../src/common/open-hours.js";
import { ny } from "../src/common/event-hours.js";
import { readerOptions } from "../src/keeper/reader-policy.js";
import { Engine, type EnginePort } from "../src/keeper/engine.js";
import { createPrepare } from "../src/keeper/main.js";
import { CreationBudget } from "../src/keeper/budget.js";
import type { Chain } from "../src/keeper/chain.js";
import type { Prepared } from "../src/keeper/sender.js";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
const T = OPEN_HOURS.find(t => ny(Number(t + 60n)).date === "2026-11-10")!;
const flush = async () => { const deadline = performance.now() + 5000; do { await new Promise<void>(r=>setTimeout(r,2)); if (!active.some(x => (x.engine as any).preparing.size)) return; } while (performance.now() < deadline); throw Error("Local preparation timeout"); };
const active: {engine:Engine}[] = [];
async function fixture(hours: readonly bigint[] = [], t0 = T) {
  const h=await Harness.create(), ref=await h.ref(t0);
  let now=t0-86401n;
  const chain={ configKey:h.config, config:s.getConfigDecoder().decode(accountData(h.svm,h.config)), candles:new Map(), tickets:new Map(), now:()=>now } as unknown as Chain;
  const budget=new CreationBudget({call:vi.fn()} as any,h.marker.address,50000000n,0n); budget.ready=true;
  const sent:Prepared[]=[], logs:any[]=[], ixs=new Map<string,readonly Instruction[]>();
  const rpc={cluster:'mainnet',call:vi.fn(async()=>1905000)} as any;
  const prepare=await createPrepare(rpc,h.marker,chain,{register:(key,list)=>{ixs.set(key,list);}},()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}));
  const port:EnginePort={blockhash:()=> '11111111111111111111111111111111',price:()=>10000n,prepare,send:p=>{sent.push(p);},cancel:vi.fn()};
  const engine=new Engine(chain,h.marker.address,port,budget,e=>logs.push(e),hours);
  const setNow=(n:bigint)=>{now=n;h.clock(n);};
  const sync=()=>chain.candles.set(ref.candle,{value:h.candleState(ref),slot:1,data:''});
  const x = {h,ref,chain,budget,sent,logs,ixs,rpc,prepare,port,engine,setNow,sync}; active.push(x); return x;
}

it("NYSE opening starts exclude weekends and full holidays, retaining early closes and exact DST boundaries", () => {
  const dates = OPEN_HOURS.map(t => ny(Number(t + 60n)).date);
  expect(dates[0]).toBe("2026-10-30"); expect(dates.at(-1)).toBe("2027-12-31");
  expect(new Set(OPEN_HOURS).size).toBe(OPEN_HOURS.length);
  for (const t of OPEN_HOURS) {
    const day = ny(Number(t + 60n)); expect(day.hm).toBe("09:30"); expect(t % 60n).toBe(0n);
    expect([0, 6]).not.toContain(new Date(day.date + "T12:00:00Z").getUTCDay());
  }
  for (const date of ["2026-11-26", "2026-12-25"]) expect(dates).not.toContain(date);
  expect(dates).toContain("2026-11-27");
  for (const [date, utc] of [["2027-03-12", "14:29"], ["2027-03-15", "13:29"],
    ["2027-11-05", "13:29"], ["2027-11-08", "14:29"]])
    expect(OPEN_HOURS[dates.indexOf(date!)]).toBe(BigInt(Date.parse(`${date}T${utc}:00Z`) / 1000));
});
it("opens a configured NYSE hour only inside the existing day-ahead and cutoff guards and creation budget", async () => {
  const x = await fixture(OPEN_HOURS);
  try {
    x.setNow(T - 86401n); x.engine.update(); await flush(); expect(x.sent).toHaveLength(0);
    x.budget.used = 49000000n; x.setNow(T - 86400n); x.engine.update(); await flush();
    expect(x.sent).toHaveLength(0); expect(x.budget.waiting.has(`open:${T}`)).toBe(true);
    x.budget.used = 0n; x.engine.update(); expect(x.sent.map(p => [p.action.kind, p.action.t0])).toEqual([["open", T]]);
    expect(x.sent[0]!.rent).toBe(1905000n); expect(x.budget.reserved()).toBe(1905000n);
    await x.h.send("opening candle", x.ixs.get(x.sent[0]!.action.key)!, x.h.marker); x.sync();
    x.engine.update(); expect(x.engine.pending.size).toBe(0); expect(x.engine.prepared.size).toBe(0);
  } finally { x.engine.close(); }
  for (const delta of [-1n, 0n, 1n]) {
    const y = await fixture([T]);
    try { y.setNow(T - BigInt(y.chain.config!.buyCutoff) - 30n + delta); y.engine.update(); await flush(); expect(y.sent).toHaveLength(delta < 0n ? 1 : 0); }
    finally { y.engine.close(); }
  }
});
it("with opening disabled reads all thirteen actual SOL hourly reads without tickets, excluding other assets, lengths and minutes", async () => {
  const x = await fixture(), refs = [x.ref];
  const prepared = vi.spyOn(x.port, "prepare");
  try {
    x.setNow(T - 100n); x.engine.update(); await flush(); expect(x.sent).toHaveLength(0);
    for (const delta of [0n, 1n, 2n, 3n, 4n, 5n, 60n]) {
      const ref = delta === 0n ? x.ref : await x.h.ref(T + delta); if (delta) refs.push(ref);
      await x.h.send("ticketless candle", x.h.openCandleIx(ref));
      x.chain.candles.set(ref.candle, { value: x.h.candleState(ref), slot: 1, data: "" });
    }
    for (let j = 0; j < 13; j++) {
      const ts = T + BigInt(j * 300), price = 10000000000n + BigInt(j) * 1000000n;
      x.setNow(ts); x.h.price(price, ts); x.chain.feed = { price, publishTs: ts, source: "poll", recvMs: Date.now(), slot: j + 1 };
      x.engine.update(); await flush(); const p = x.sent.at(-1)!;
      expect([p.action.kind, p.action.t0, p.action.j]).toEqual(["read", T, j]);
      await x.h.send("read open", x.ixs.get(p.action.key)!, x.h.marker); x.sync(); x.engine.update();
    }
    expect(x.sent).toHaveLength(13); expect(x.h.candleState(x.ref).reads.every(r => r.price > 0n)).toBe(true);
    expect(prepared.mock.calls.every(([a]) => a.kind === "read" && a.t0 === T)).toBe(true);
    for (const ref of refs.slice(1)) expect(x.h.candleState(ref).reads.every(r => r.price === 0n)).toBe(true);
    expect(x.chain.tickets.size).toBe(0);
  } finally { x.engine.close(); }
});
it("does not prepare missed windows of an old opening candle", async () => {
  const x = await fixture();
  try {
    x.setNow(T - 100n); await x.h.send("old open", x.h.openCandleIx(x.ref)); x.sync();
    x.setNow(T + 4000n); x.chain.feed = { price: 10000000000n, publishTs: T + 4000n, source: "poll", recvMs: Date.now(), slot: 1 };
    const prepare = vi.spyOn(x.port, "prepare"); x.engine.update(); await flush(); expect(prepare).not.toHaveBeenCalled(); expect(x.sent).toHaveLength(0);
  } finally { x.engine.close(); }
});
it("publishes a receipt-free opening candle only after settlement time", async () => {
  const x = await fixture(); x.setNow(T - 100n); await x.h.send("open", x.h.openCandleIx(x.ref)); x.sync();
  const store = new Store(":memory:"), rpc = {cluster:"mainnet"} as any, history = new History(store, rpc, () => {}), recorder = new DovesRecorder(store, rpc),
    dir = mkdtempSync(join(tmpdir(), "span-open-history-")), publisher = new Publisher(store, x.chain, history, recorder, dir, undefined, [...RELEASE_HOURS, ...OPEN_HOURS]);
  try {
    const end = s.settleAfter(x.h.candleState(x.ref)); x.setNow(end - 1n); expect(publisher.historyDocument().candles).toEqual([]);
    x.setNow(end); const doc = publisher.historyDocument(); expect(doc.candles.map(c => c.t0)).toEqual([String(T)]); expect(doc.receipts).toEqual([]);
    expect(doc.candles[0]!.reads).toHaveLength(13); expect(publisher.versioned().historyDocument().candles.map(c => c.t0)).toEqual([String(T)]);
  } finally { store.close(); x.engine.close(); }
});

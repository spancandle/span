import { it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { Harness, accountData, type Ref } from "../../program/tests/harness.js";
import {
  getConfigDecoder,
  settleAfter,
  TicketState,
} from "../../program/client/index.js";
import { Engine, type EnginePort } from "../src/keeper/engine.js";
import type { Action, Prepared } from "../src/keeper/sender.js";
import type { Chain } from "../src/keeper/chain.js";
const flush = async () => {
  for (let i = 0; i < 12; i++)
    await new Promise<void>((r) => queueMicrotask(r));
};
async function setup(loaded = true) {
  const h = await Harness.create({ setSpan: true }),
    t = await h.open({ loaded, sold: true });
  const chain = {
    candles: new Map(),
    tickets: new Map(),
    config: getConfigDecoder().decode(accountData(h.svm, h.config)),
    feed: undefined,
    now: () => h.svm.getClock().unixTimestamp,
  } as unknown as Chain;
  const sync = () => {
    chain.candles.set(t.candle, { value: h.candleState(t), slot: 0, data: "" });
    if (h.svm.getAccount(t.ticket).exists)
      chain.tickets.set(t.ticket, {
        value: h.ticketState(t),
        slot: 0,
        data: "",
      });
    else chain.tickets.delete(t.ticket);
  };
  sync();
  const sent: { p: Prepared; at: number }[] = [],
    logs: any[] = [],
    cancelled: string[] = [];
  let hash = "B0",
    fee = 10001n;
  const port: EnginePort = {
    blockhash: () => hash,
    price: () => fee,
    prepare: async (action, price) => ({
      action,
      price,
      signature: `${action.key}:${hash}:${price}`,
      wire: `${action.key}:${hash}:${price}`,
      blockhash: hash,
      lastValidBlockHeight: 100151n,
      rent: 0n,
    }),
    send: (p) => {
      sent.push({ p, at: performance.now() });
    },
    cancel: (k) => cancelled.push(k),
  };
  const budget = {
    available: (_rent: bigint) => true,
    reserve: () => true,
    waiting: new Set<string>(),
  };
  const engine = new Engine(chain, h.marker.address, port, budget, (e) =>
    logs.push(e),
  );
  const feed = async (
    ts: bigint,
    price = 10_000_000_000n,
    source: "ws" | "poll" = "ws",
  ) => {
    chain.feed = { publishTs: ts, price, source, recvMs: Date.now(), slot: 0 };
    h.price(price, ts);
    engine.update();
    await flush();
  };
  return {
    h,
    t,
    chain,
    sync,
    sent,
    logs,
    engine,
    feed,
    port,
    budget,
    setHash: (x: string) => (hash = x),
    setFee: (x: bigint) => (fee = x),
  };
}
for (const source of ["ws", "poll"] as const)
  it(`S1(a,b,e,f) pre-signs and sends first eligible ${source} value within 50ms; only the send port runs`, async () => {
    const x = await setup();
    x.h.clock(x.t.t0 - 10n);
    x.engine.update();
    await flush();
    expect(x.engine.prepared.size).toBe(1);
    expect(x.sent).toHaveLength(0);
    const at = performance.now();
    await x.feed(x.t.t0, 10_000_000_000n, source);
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0].at - at).toBeLessThan(50);
    expect(x.sent[0].p.action.j).toBe(0);
    await x.feed(x.t.t0 + 1n);
    expect(x.sent).toHaveLength(1);
    x.chain.tickets.clear();
    x.engine.close();
    const y = new Engine(
      x.chain,
      x.h.marker.address,
      x.port,
      x.budget,
      () => {},
    );
    y.update();
    await flush();
    expect(x.sent).toHaveLength(1);
  });
it("S1(d,f,g) abandons only after the exact timestamp/clock limits; distinguishes doves and keeper; no reads after missing open", async () => {
  const x = await setup();
  x.h.clock(x.t.t0 - 10n);
  x.engine.update();
  await flush();
  await x.feed(x.t.t0);
  x.h.clock(x.t.t0 + 42n);
  x.engine.update();
  expect(x.logs.some((e) => e.event === "missed-read")).toBe(false);
  x.h.clock(x.t.t0 + 43n);
  x.engine.update();
  expect(x.logs.find((e) => e.event === "missed-read").cause).toBe("keeper");
  x.h.clock(x.t.t0 + 300n);
  await x.feed(x.t.t0 + 300n);
  expect(x.sent).toHaveLength(1);
  const y = await setup();
  y.h.clock(y.t.t0 + 20n);
  await y.feed(y.t.t0 + 20n);
  expect(y.logs.some((e) => e.event === "missed-read")).toBe(false);
  await y.feed(y.t.t0 + 21n);
  expect(y.logs.find((e) => e.event === "missed-read").cause).toBe("keeper");
  const z = await setup();
  z.h.clock(z.t.t0 + 43n);
  z.engine.update();
  expect(z.logs.find((e) => e.event === "missed-read").cause).toBe("doves");
  const p = y.sent[0]?.p;
  if (p) y.engine.result(p, "ReadFilled", "signature");
  expect(y.logs.some((e) => e.error === "ReadFilled")).toBe(false);
});
it("S1(h) restarts immediately with missing/present height record and stale blockhash; overlapping preflight makes a distinct immediate attempt", async () => {
  for (const record of [undefined, 10151n]) {
    const x = await setup();
    x.h.clock(x.t.t0 - 10n);
    x.setHash("B0");
    x.engine.update();
    await flush();
    const start = performance.now();
    await x.feed(x.t.t0);
    expect(x.sent[0].at - start).toBeLessThan(50);
    const first = x.sent[0].p;
    x.engine.result(first, "AlreadyProcessed", "preflight");
    await flush();
    expect(x.sent).toHaveLength(2);
    expect(x.sent[1].p.signature).not.toBe(first.signature);
    x.setHash("B1");
    expect(record === undefined || record > 0n).toBe(true);
  }
});
it("S2(a,b,c,d,e,f) gives pending reads precedence, re-evaluates latest value after confirmation, deduplicates and respects marker/cap/shortness", async () => {
  const x = await setup();
  x.h.clock(x.t.t0);
  x.h.price(10_000_000_000n, x.t.t0);
  await x.h.send("open", x.h.readIx(x.t, 0));
  x.sync();
  x.h.clock(x.t.t0 + 290n);
  x.engine.update();
  await flush();
  await x.feed(x.t.t0 + 300n, 10_100_000_000n);
  expect(x.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(0);
  await x.feed(x.t.t0 + 301n, 10_200_000_000n);
  expect(x.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(0);
  x.h.clock(x.t.t0 + 301n);
  await x.h.send("read", x.h.readIx(x.t, 1));
  x.sync();
  x.engine.update();
  await flush();
  await x.feed(x.t.t0 + 302n, 10_300_000_000n);
  expect(x.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(1);
  const p = x.sent.at(-1)!.p;
  await x.feed(x.t.t0 + 303n, 10_400_000_000n);
  expect(x.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(1);
  x.engine.result(p, "NotExtension", "signature");
  x.engine.update();
  await flush();
  expect(x.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(2);
  const next = x.sent.at(-1)!.p;
  x.engine.result(next, "SpanShort", "signature");
  await x.feed(x.t.t0 + 304n, 10_500_000_000n);
  expect(x.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(2);
  const y = await setup();
  y.chain.tickets.get(y.t.ticket)!.value.marker = y.h.stranger.address;
  y.h.clock(y.t.t0);
  y.h.price(10_000_000_000n, y.t.t0);
  await y.h.send("open", y.h.readIx(y.t, 0));
  y.sync();
  y.chain.tickets.get(y.t.ticket)!.value.marker = y.h.stranger.address;
  await y.feed(y.t.t0 + 30n, 11_000_000_000n);
  expect(y.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(0);
});
it("S2(b) LiteSVM BeforeBoundary keeps read priority; next slot read records value without burning", async () => {
  const x = await setup();
  x.h.clock(x.t.t0);
  x.h.price(10_000_000_000n, x.t.t0);
  await x.h.send("open", x.h.readIx(x.t, 0));
  x.sync();
  x.h.clock(x.t.t0 + 299n);
  x.engine.update();
  await flush();
  await x.feed(x.t.t0 + 300n, 10_100_000_000n);
  await x.h.send("before", x.h.readIx(x.t, 1), x.h.stranger, "BeforeBoundary");
  expect(x.sent.filter((s) => s.p.action.kind === "mark")).toHaveLength(0);
  x.h.clock(x.t.t0 + 300n);
  await x.h.send("on_boundary", x.h.readIx(x.t, 1));
  x.sync();
  x.engine.update();
  await flush();
  expect(x.h.ticketState(x.t).burned).toBe(0n);
  expect(x.h.candleState(x.t).reads[1].price).toBe(10_100_000_000n);
});
it("removes budget-waiting settlement when another wallet closes the ticket", async () => {
  const x = await setup(false);
  const prepare = x.port.prepare;
  x.port.prepare = async (a, price) => ({
    ...(await prepare(a, price)),
    rent: a.kind === "settle" ? 1n : 0n,
  });
  x.budget.available = (rent: bigint) => rent === 0n;
  x.h.clock(settleAfter(x.h.candleState(x.t)));
  x.engine.update();
  await flush();
  const key = `settle:${x.t.ticket}`;
  expect(x.budget.waiting.has(key)).toBe(true);
  expect(x.engine.pending.has(key)).toBe(false);
  x.chain.tickets.delete(x.t.ticket);
  x.engine.update();
  expect(x.budget.waiting.has(key)).toBe(false);
  expect(x.engine.prepared.has(key)).toBe(false);
  x.engine.close();
});
it("S3(a,c) settles Open and Sold only at settleAfter; budget blocks only creations and releases waiting work", async () => {
  const x = await setup(false);
  x.chain.tickets.get(x.t.ticket)!.value.state = TicketState.Open;
  const original = x.port.prepare;
  x.port.prepare = async (a, p) => ({
    ...(await original(a, p)),
    rent: 2039280n,
  });
  let allow = false;
  x.budget.available = () => allow;
  x.budget.reserve = () => allow;
  const end = settleAfter(x.h.candleState(x.t));
  x.h.clock(end - 30n);
  x.engine.update();
  await flush();
  expect(x.sent).toHaveLength(0);
  x.h.clock(end - 1n);
  x.engine.update();
  expect(x.sent).toHaveLength(0);
  x.h.clock(end);
  x.engine.update();
  expect(x.sent).toHaveLength(0);
  expect(x.budget.waiting.size).toBe(1);
  allow = true;
  x.engine.update();
  expect(x.sent.at(-1)!.p.action.kind).toBe("settle");
});
it("S1(h) S2(g) prior successful signature with unchanged memory immediately re-evaluates using a distinct attempt", async () => {
  const x = await setup();
  x.h.clock(x.t.t0);
  x.h.price(10000000000n, x.t.t0);
  await x.h.send("open", x.h.readIx(x.t, 0));
  x.sync();
  x.h.clock(x.t.t0 + 30n);
  x.engine.update();
  await flush();
  await x.feed(x.t.t0 + 30n, 10010000000n);
  const first = x.sent.at(-1)!.p;
  expect(first.action.kind).toBe("mark");
  x.engine.result(first, null, "signature");
  await flush();
  const next = x.sent.at(-1)!.p;
  expect(next.signature).not.toBe(first.signature);
  expect(next.price).toBe(first.price + 1n);
  await x.h.send("actual_mark", x.h.markIx(x.t), x.h.marker);
  x.sync();
  x.engine.update();
  const count = x.sent.length;
  await x.feed(x.t.t0 + 30n, 10010000000n);
  expect(x.sent).toHaveLength(count);
});
it("settlement preparation thirty seconds early keeps accepting an eligible last candle publication", async () => {
  const x = await setup();
  x.h.clock(x.t.t0);
  x.h.price(10000000000n, x.t.t0);
  await x.h.send("open", x.h.readIx(x.t, 0));
  x.sync();
  x.h.clock(x.t.t0 + 3612n);
  x.engine.update();
  await flush();
  await x.feed(x.t.t0 + 3599n, 10010000000n);
  expect(x.sent.some((x) => x.p.action.kind === "mark")).toBe(true);
  expect(x.sent.some((x) => x.p.action.kind === "settle")).toBe(false);
  await x.h.send("late_valid_mark", x.h.markIx(x.t), x.h.marker);
  expect(x.h.ticketState(x.t).marks).toBe(1);
});

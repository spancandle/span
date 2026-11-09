import { expect, it, vi } from "vitest";
import { getBase58Decoder, type Address } from "@solana/kit";
import * as s from "../../program/client/index.js";
import { Harness, amount, type Ref } from "../../program/tests/harness.js";
import { bidFixture, sendBid } from "../../program/tests/bid-fixture.js";
import { requestFixture } from "../../program/tests/request-fixture.js";
import { Chain, pairedSpanBalance, type SpanHoldRead } from "../src/keeper/chain.js";
import { Engine } from "../src/keeper/engine.js";
import { createPrepare } from "../src/keeper/main.js";
import { readerOptions } from "../src/keeper/reader-policy.js";
import type { Prepared } from "../src/keeper/sender.js";
import { capture } from "./resale-support.js";
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
async function observe(h: Harness, t: Ref) {
  h.svm.withBlockhashCheck(false);
  const raw = (key: Address) => {
    const a = h.svm.getAccount(key);
    return a.exists ? { owner: a.programAddress, lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"] } : null;
  };
  const rpc = { cluster: "mainnet", call: vi.fn(async (method: string, args: any[]) => {
    const context = { slot: Number(h.svm.getClock().slot) };
    if (method === "getMultipleAccounts") return { context, value: args[0].map(raw) };
    if (method === "getProgramAccounts") return { context, value: h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS)
      .filter(a => getBase58Decoder().decode(a.data.subarray(0, 8)) === args[1].filters[0].memcmp.bytes)
      .map(a => ({ pubkey: a.address, account: raw(a.address) })) };
    throw Error(method);
  }) };
  const chain = new Chain(rpc as any, { subscribe: () => () => {}, close: () => {} } as any, () => {}, h.marker.address);
  chain.config = h.configState(); chain.configKey = h.config; chain.now = () => h.svm.getClock().unixTimestamp;
  const sync = async (pair = true) => { await chain.pollPrograms(); if (pair) await chain.pollSpanHolds("keeper"); };
  await sync();
  const sent: Prepared[] = [], logs: any[] = [], prepare = await createPrepare(rpc as any, h.marker, chain, { register: () => {} },
    () => ({ blockhash: h.svm.latestBlockhash(), lastValidBlockHeight: 10000000000n }));
  const engine = new Engine(chain, h.marker.address, { blockhash: () => h.svm.latestBlockhash(), price: () => 10000n, prepare,
    send: p => sent.push(p), cancel: () => {} }, { available: () => true, reserve: () => true, waiting: new Set() }, e => logs.push(e), [], readerOptions("marks", "paced-v1"));
  const feed = (price: bigint) => { const ts = h.svm.getClock().unixTimestamp; h.price(price, ts);
    chain.feed = { price, publishTs: ts, slot: Number(h.svm.getClock().slot), source: "poll", recvMs: Date.now() }; };
  const update = async () => {
    engine.update(); const end = performance.now() + 3000;
    while ((engine as any).preparing.size) {
      if (performance.now() > end) throw Error("Local signing timeout");
      await new Promise(r => setTimeout(r, 2));
    }
    await flush();
  };
  const land = async (p: Prepared) => {
    const row = capture(h, p.wire); expect(row.tx.meta.err, row.tx.meta.logMessages.join("\n")).toBe(null);
    await sync(false); engine.result(p, null, "signature"); return row;
  };
  return { chain, rpc, raw, sync, engine, sent, logs, feed, update, land };
}
it("a free signature waits through ticket-only observations and elapsed time until its coherent pair", async () => {
  const h = await Harness.create({ setSpan: true }), t = await h.open({ loaded: true, strikeBps: 100 });
  h.clock(t.t0); h.price(10000000000n, t.t0); await h.send("first_read", h.readIx(t, 0));
  h.clock(t.t0 + 60n);
  const o = await observe(h, t);
  try {
    o.feed(10010000000n); await o.update(); expect(o.sent).toHaveLength(1);
    const landed = capture(h, o.sent[0].wire); expect(landed.tx.meta.err).toBe(null);
    expect(h.ticketState(t).marks).toBe(1); expect(h.ticketState(t).burned).toBe(0n);
    o.engine.result(o.sent[0], null, "signature");
    const prepare = vi.spyOn(o.engine.port, "prepare");
    h.clock(t.t0 + 70n); o.feed(10020000000n); await o.update();
    await o.sync(false); await o.update(); // ticket marks increased; the paired marks did not
    expect(o.chain.tickets.get(t.ticket)!.value.marks).toBe(1);
    expect(o.chain.spanHolds.get(t.ticket)!.marks).toBe(0);
    expect(pairedSpanBalance(o.chain.tickets.get(t.ticket)!, o.chain.spanHolds.get(t.ticket))).toBeUndefined();
    h.clock(t.t0 + 2500n); o.feed(10030000000n); await o.update();
    expect(prepare).not.toHaveBeenCalled(); expect(o.sent).toHaveLength(1);
    await o.chain.pollSpanHolds("keeper"); await o.update();
    expect(o.chain.spanHolds.get(t.ticket)!.marks).toBe(1); expect(o.sent).toHaveLength(2);
  } finally { o.engine.close(); }
});
for (const via of ["resale", "bid", "request"] as const) it(`coherent pairs resume after ${via} gives a new owner a smaller load than lifetime burned`, async () => {
  const x = via === "request" ? await requestFixture({ loaded: true, strikeBps: 100 }) : await bidFixture({ loaded: true, strikeBps: 100 }), { h, t, actors } = x;
  // Ten actual paid marks leave lifetime burned larger than the next owner's initial load.
  for (let i = 1; i <= 10; i++) { h.clock(t.t0 + 30n + BigInt(i)); h.price(10100000000n + BigInt(i) * 10000000n, h.svm.getClock().unixTimestamp); await h.send("old_paid", h.markIx(t)); }
  expect(h.ticketState(t).burned).toBe(1000n);
  const o = await observe(h, t), old = o.chain.spanHolds.get(t.ticket)!;
  try {
    h.clock(t.t0 + 60n); h.price(10200000000n, t.t0 + 60n);
    if (via === "resale") {
      await sendBid(h, x.list(), h.buyer); await sendBid(h, x.buyResale(actors[1]), actors[1].signer);
      await h.send("new_load", h.loadIx(t, { buyer: actors[1].signer, spanSource: actors[1].span, amount: 500n }), actors[1].signer);
    } else if (via === "bid") {
      const b = x as Awaited<ReturnType<typeof bidFixture>>;
      await sendBid(h, [await b.place(), await b.bidSpan(actors[1], { amount: 500n })], actors[1].signer);
      await sendBid(h, await b.accept(), h.buyer);
    } else {
      const r = x as Awaited<ReturnType<typeof requestFixture>>;
      await sendBid(h, [await r.place(), await r.requestSpan(actors[1], { amount: 500n })], actors[1].signer);
      await sendBid(h, await r.accept(), h.buyer);
    }
    const actual = h.ticketState(t); expect(actual.spanLoaded).toBe(500n); expect(actual.burned).toBe(1000n);
    await o.sync(false); o.feed(10220000000n); await o.update();
    expect(o.sent).toHaveLength(0); expect(pairedSpanBalance(o.chain.tickets.get(t.ticket)!, old)).toBeUndefined();
    expect(o.logs.some(e => e.event === "mark-balance-wait")).toBe(true);
    await o.sync(); await o.update(); expect(o.sent).toHaveLength(1);
    await o.land(o.sent[0]); expect(h.ticketState(t).burned).toBe(1100n); expect(amount(h.svm, t.spanHold)).toBe(400n);
    h.clock(t.t0 + 70n); o.feed(10240000000n); await o.update(); expect(o.sent).toHaveLength(1);
    await o.sync(); await o.update(); expect(o.sent).toHaveLength(1); // matching current R still reserves four units
    expect(o.chain.spanHolds.get(t.ticket)?.buyer).toBe(actors[1].signer.address);
  } finally { o.engine.close(); }
});
it("ignores reversed/stale RPC pairs, preserves balance on failure and compares decoded Option addresses", async () => {
  const h = await Harness.create({ setSpan: true }), t = await h.open({ loaded: true }); h.clock(t.t0 + 60n);
  const o = await observe(h, t);
  try {
    const live = o.chain.tickets.get(t.ticket)!, pair = o.chain.spanHolds.get(t.ticket)!;
    expect(pairedSpanBalance({ ...live, value: { ...live.value, buyer: structuredClone(live.value.buyer) } }, pair)).toBe(pair.amount);
    for (const change of [{ buyer: h.stranger.address }, { marker: h.stranger.address }, { spanLoaded: pair.spanLoaded! + 1n },
      { burned: pair.burned + 100n }, { stepBps: pair.stepBps! + 1 }, { marks: pair.marks! + 1 }, { slot: live.slot - 1 }])
      expect(pairedSpanBalance(live, { ...pair, ...change })).toBeUndefined();
    expect(pairedSpanBalance(live, { amount: pair.amount, burned: pair.burned, slot: pair.slot, read: pair.read })).toBeUndefined();
    const responses: ((v: any) => void)[] = [];
    o.rpc.call.mockImplementation(async method => {
      expect(method).toBe("getMultipleAccounts"); return new Promise<any>(r => responses.push(r));
    });
    const earlier = o.chain.pollSpanHolds("keeper"); await flush();
    const later = o.chain.pollSpanHolds("keeper"); await flush();
    const ticket = o.raw(t.ticket), raw = o.raw(t.spanHold)!;
    const data = Buffer.from(raw.data[0], "base64"); data.writeBigUInt64LE(500n, 64);
    responses[1]({ context: { slot: live.slot + 10 }, value: [ticket, { ...raw, data: [data.toString("base64"), "base64"] }] }); await later;
    responses[0]({ context: { slot: live.slot + 5 }, value: [ticket, raw] }); await earlier;
    expect(o.chain.spanHolds.get(t.ticket)?.amount).toBe(500n);
    const accepted = o.chain.spanHolds.get(t.ticket);
    o.rpc.call.mockRejectedValueOnce(Error("Local RPC failure")); await o.chain.pollSpanHolds("keeper");
    expect(o.chain.spanHolds.get(t.ticket)).toBe(accepted);
    o.rpc.call.mockResolvedValueOnce({ context: { slot: live.slot + 20 }, value: [{ ...ticket, owner: h.buyer.address }, raw] });
    await o.chain.pollSpanHolds("keeper"); expect(o.chain.spanHolds.get(t.ticket)).toBe(accepted);
  } finally { o.engine.close(); }
});
it("an expected free mark may burn at landing; SpanShort waits for a newer matching pair before resuming", async () => {
  const h = await Harness.create({ setSpan: true }), t = await h.open({ sold: true, strikeBps: 100 });
  await h.send("load", h.loadIx(t, { amount: 149n }), h.buyer); h.clock(t.t0); h.price(10000000000n, t.t0); await h.send("opening", h.readIx(t, 0)); h.clock(t.t0 + 60n);
  const o = await observe(h, t);
  try {
    o.feed(10010000000n); await o.update(); expect(o.sent).toHaveLength(1);
    h.price(10200000000n, t.t0 + 60n); await o.land(o.sent[0]); expect(amount(h.svm, t.spanHold)).toBe(49n);
    o.engine.result(o.sent[0], "SpanShort", "preflight"); // stale result cannot alter the now completed flight
    h.clock(t.t0 + 61n); o.feed(10300000000n); await o.sync(); await o.update(); expect(o.sent).toHaveLength(1);
    const token = await import("@solana-program/token"); await h.send("topup", token.getTransferInstruction({ source: h.buyerSpan, destination: t.spanHold, authority: h.buyer, amount: 100n }), h.buyer);
    await o.sync(); await o.update(); expect(o.sent).toHaveLength(2);
    o.engine.result(o.sent[1], "SpanShort", "preflight");
    await o.update(); expect(o.sent).toHaveLength(2);
    await o.sync(); await o.update(); expect(o.sent).toHaveLength(3);
    h.price(10300000000n, t.t0 + 61n); await o.land(o.sent[2]); expect(amount(h.svm, t.spanHold)).toBe(49n);
  } finally { o.engine.close(); }
});
it("a paid prediction can land as a valid free extension without replacing the signed packet", async () => {
  const h = await Harness.create({ setSpan: true }), t = await h.open({ sold: true, strikeBps: 200 });
  await h.send("load", h.loadIx(t, { amount: 500n }), h.buyer); h.clock(t.t0); h.price(10000000000n, t.t0); await h.send("opening", h.readIx(t, 0)); h.clock(t.t0 + 60n);
  const o = await observe(h, t);
  try {
    o.feed(10300000000n); await o.update(); expect(o.sent).toHaveLength(1);
    const wire = o.sent[0].wire; h.price(10010000000n, t.t0 + 60n); await o.land(o.sent[0]);
    expect(o.sent[0].wire).toBe(wire); expect(h.ticketState(t).marks).toBe(1); expect(amount(h.svm, t.spanHold)).toBe(500n);
  } finally { o.engine.close(); }
});
it("a first load inside the candle uses elapsed time from its original start", async () => {
  const h = await Harness.create({ setSpan: true }), t = await h.open({ sold: true, strikeBps: 100 });
  h.clock(t.t0); h.price(10000000000n, t.t0); await h.send("opening", h.readIx(t, 0));
  h.clock(t.t0 + 1830n); await h.send("late_load", h.loadIx(t, { amount: 500n }), h.buyer);
  const o = await observe(h, t);
  try {
    for (let i = 0; i < 3; i++) {
      h.clock(t.t0 + 1830n + BigInt(i)); o.feed(10120000000n + BigInt(i) * 20000000n);
      await o.sync(); await o.update(); expect(o.sent).toHaveLength(i + 1); await o.land(o.sent[i]);
    }
    h.clock(t.t0 + 1833n); o.feed(10200000000n); await o.sync(); await o.update();
    expect(o.sent).toHaveLength(3); expect(amount(h.svm, t.spanHold)).toBe(200n);
  } finally { o.engine.close(); }
});

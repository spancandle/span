import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Address } from "@solana/kit";
import { Harness, amount } from "../../program/tests/harness.js";
import { Engine } from "../src/keeper/engine.js";
import { Chain } from "../src/keeper/chain.js";
import { createPrepare } from "../src/keeper/main.js";
import { readerOptions } from "../src/keeper/reader-policy.js";
import { capture } from "./resale-support.js";
import { transactionEvents } from "../src/tape/history.js";

// Optional external replay fixtures are not required by the public test suite.
it.skipIf(!process.env.SPAN_READER_REPLAY_MODULE || !process.env.SPAN_READER_REPLAY_FIXTURE)(
  "paced Engine and current program bytes match the accepted replay on representative gains/losses at 0/8 slots", async () => {
    const model = await import(pathToFileURL(process.env.SPAN_READER_REPLAY_MODULE!).href),
      fixture = JSON.parse(readFileSync(process.env.SPAN_READER_REPLAY_FIXTURE!, "utf8")),
      settings = { ...fixture.settings, burnPerMark: BigInt(fixture.settings.burnPerMark) }, summaries: any[] = [];
    for (const test of fixture.cases) {
      const input = { ...test.input, t0: BigInt(test.input.t0), writes: test.input.writes.map((w: any) =>
        ({ ...w, price: BigInt(w.price), publishTs: BigInt(w.publishTs) })) }, params = test.params,
        reference = model.runModel(input, params, settings, undefined, true), state = model.initialState(input, params, settings),
        replay = new model.Replay(input, params, settings, undefined, state, true),
        h = await Harness.create({ asset: input.asset, spanProgram: settings.spanTokenProgram });
      h.svm.withBlockhashCheck(false);
      await h.send("params", h.ix("setParams", { admin: h.admin, readWindow: settings.readWindow, ageLimit: settings.ageLimit, buyCutoff: settings.buyCutoff }), h.admin);
      await h.send("span", h.ix("setSpan", { admin: h.admin, burnPerMark: settings.burnPerMark }), h.admin);
      h.clock(input.t0 - 1000n, 1n); const t = await h.open({ t0: input.t0, sold: true, strikeBps: params.strikeBps });
      await h.send("load", h.loadIx(t, { amount: state.initial, stepBps: params.stepBps }), h.buyer);
      const raw = (key: Address) => {
        const a = h.svm.getAccount(key);
        return a.exists ? { owner: a.programAddress, lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"] } : null;
      };
      const rpc: any = { cluster: "mainnet", call: async (method: string, args: any[]) => {
        if (method === "getAccountInfo") return { value: raw(args[0]) };
        if (method === "getMultipleAccounts") return { value: args[0].map(raw) };
        if (method === "getMinimumBalanceForRentExemption") return Number(h.svm.minimumBalanceForRentExemption(BigInt(args[0])));
        throw Error(method);
      } };
      const chain = new Chain(rpc, {} as any, () => {}, h.marker.address);
      chain.config = h.configState(); chain.configKey = h.config; chain.now = () => BigInt(replay.now);
      const sync = () => {
        state.c = h.candleState(t); chain.candles.set(t.candle, { value: state.c, slot: replay.slot, data: "" });
        if (h.svm.getAccount(t.ticket).exists) {
          const actual = h.ticketState(t); state.t = { strikeBps: actual.strikeBps, stepBps: actual.stepBps, tailHigh: actual.tailHigh,
            tailLow: actual.tailLow, marks: actual.marks, burned: actual.burned };
          state.remaining = amount(h.svm, t.spanHold); chain.tickets.set(t.ticket, { value: actual, slot: replay.slot, data: "" });
          chain.spanHolds.set(t.ticket, { amount: state.remaining, burned: actual.burned, slot: replay.slot, read: ++chain.spanRead,
            buyer: h.buyer.address, marker: actual.marker, spanLoaded: actual.spanLoaded, stepBps: actual.stepBps });
        } else { state.settled = true; state.remaining = state.initial - state.t.burned; chain.tickets.delete(t.ticket); }
      };
      sync();
      const engines: Engine[] = [];
      for (const paced of [false, true]) {
        const signer = paced ? h.marker : h.stranger, prepare = await createPrepare(rpc, signer, chain, { register: () => {} },
          () => ({ blockhash: h.svm.latestBlockhash(), lastValidBlockHeight: 999999999999n }), readerOptions(paced ? "marks" : "full", paced ? "paced-v1" : "greedy"));
        const engine = new Engine(chain, signer.address, { blockhash: () => h.svm.latestBlockhash(), price: () => 10000n, prepare,
          send: p => { replay.send({ kind: p.action.kind, key: p.action.kind === "read" ? `read:${p.action.j}` : p.action.kind,
            j: p.action.j, end: p.action.end === undefined ? undefined : Number(p.action.end) }, { engine, p }); }, cancel: () => {} },
          { available: () => true, reserve: () => true, waiting: new Set() }, () => {}, [], readerOptions(paced ? "marks" : "full", paced ? "paced-v1" : "greedy"));
        engines.push(engine);
      }
      const update = async () => {
        h.clock(BigInt(replay.now), BigInt(replay.slot));
        // Equivalent observation condition: the coherent pair is available at the same slot as the ticket.
        sync(); engines.forEach(e => e.update());
        const end = performance.now() + 10000;
        while (engines.some(e => (e as any).preparing.size)) {
          if (performance.now() > end) throw Error("Replay signing timeout");
          await new Promise(r => setImmediate(r));
        }
      };
      try {
        let executions = 0;
        while (replay.nextFrame()) {
          while (replay.write()) {
            h.price(replay.feed.price, replay.feed.publishTs);
            chain.feeds.set(input.asset, { price: replay.feed.price, publishTs: replay.feed.publishTs,
              slot: replay.slot, recvMs: Date.now(), source: "ws" }); await update();
          }
          await update(); let entry: any;
          while ((entry = replay.due())) {
            if (++executions > 10000) throw Error("Replay did not converge");
            const before = state.t.burned, row = capture(h, entry.opaque.p.wire),
              error = row.tx.meta.err ? /Error Code: (\w+)/.exec(row.tx.meta.logMessages.join("\n"))?.[1] ?? row.tx.meta.err : null;
            if (entry.action.kind === "settle" && !error) {
              const settled = transactionEvents(row.tx).find(e => e.name === "Settled");
              expect(settled?.data.payout).toBe(BigInt(test.payout));
              expect(settled?.data.spanReturned).toBe(state.initial - before);
            }
            sync(); const result = { error, burn: error || entry.action.kind !== "mark" ? 0n : state.t.burned - before };
            replay.record(entry, result);
            if (error === "BeforeBoundary") {
              if (entry.opaque.engine.pending.get(entry.opaque.p.action.key) === entry.opaque.p) replay.queue.push({ ...entry, due: replay.slot + 1 });
            } else {
              if (entry.action.kind === "read" && error) replay.lastReadErrorSlot = replay.slot;
              entry.opaque.engine.result(entry.opaque.p, error, "signature");
            }
            await update();
          }
        }
        expect(state.settled).toBe(true);
        expect(replay.output(), test.name).toEqual(reference.output());
        expect(replay.trace, test.name).toEqual(reference.trace);
        expect(replay.output().payout).toBe(test.payout);
        summaries.push({ name: test.name, delay: params.delay, actions: executions, marks: state.t.marks, payout: test.payout });
      } finally { engines.forEach(e => e.close()); }
    }
    expect(summaries).toHaveLength(4); console.log("READER_REPLAY", JSON.stringify(summaries));
  }, 120000);

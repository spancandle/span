import { it, expect } from "vitest";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { getBase58Decoder, getTransactionDecoder } from "@solana/kit";
import { Harness, accountData } from "../../program/tests/harness.js";
import { getConfigDecoder } from "../../program/client/index.js";
import { Engine } from "../src/keeper/engine.js";
import { CreationBudget, HeightRecord } from "../src/keeper/budget.js";
import { prepareTransaction, type Prepared } from "../src/keeper/sender.js";
import type { Chain } from "../src/keeper/chain.js";
const { FailedTransactionMetadata } = createRequire(
  new URL("../../program/package.json", import.meta.url),
)("litesvm");
const flush = async () => {
  await new Promise((r) => setTimeout(r, 100));
};
for (const hasFile of [false, true])
  it(`S2(g) production engine restart with ${hasFile ? "present" : "missing"} height file sends stale B0 immediately then resolves prior B1 overlap`, async () => {
    const h = await Harness.create({ setSpan: true }),
      t = await h.open({ loaded: true });
    h.clock(t.t0);
    h.price(10000000000n, t.t0);
    await h.send("open", h.readIx(t, 0));
    h.svm.withTransactionHistory(1000n).withBlockhashCheck(false);
    const b0 = getBase58Decoder().decode(new Uint8Array(32).fill(11)),
      b1 = getBase58Decoder().decode(new Uint8Array(32).fill(12));
    const chain = {
      candles: new Map(),
      tickets: new Map(),
      config: getConfigDecoder().decode(accountData(h.svm, h.config)),
      feed: undefined,
      now: () => h.svm.getClock().unixTimestamp,
    } as unknown as Chain;
    const sync = () => {
      chain.candles.set(t.candle, {
        value: h.candleState(t),
        slot: 0,
        data: "",
      });
      chain.tickets.set(t.ticket, {
        value: h.ticketState(t),
        slot: 0,
        data: "",
      });
    };
    sync();
    const path = join(
      mkdtempSync(join(tmpdir(), "span-restart-")),
      "devnet-keeper.json",
    );
    if (hasFile) new HeightRecord(path).save(10151n);
    let height = new HeightRecord(path);
    let budget = new CreationBudget(
      {
        call: async () => {
          throw Error("Hot path must not query RPC");
        },
      },
      h.marker.address,
      0n,
      height.loaded,
    );
    let latest = { blockhash: b1, lastValidBlockHeight: 10151n },
      fee = 10001n,
      engine: Engine;
    const attempts: any[] = [];
    const make = () =>
      new Engine(
        chain,
        h.marker.address,
        {
          blockhash: () => latest.blockhash,
          price: () => fee,
          prepare: async (a, p) => {
            height.save(latest.lastValidBlockHeight);
            return prepareTransaction([h.markIx(t)], h.marker, latest, a, p);
          },
          cancel: () => {},
          send: (p) => {
            attempts.push({
              signature: p.signature,
              hash: p.blockhash,
              fee: p.price,
              at: performance.now(),
            });
            const tx = getTransactionDecoder().decode(
                Buffer.from(p.wire, "base64"),
              ),
              result = h.svm.sendTransaction(tx);
            if (result instanceof FailedTransactionMetadata) {
              attempts[attempts.length - 1].error = String(
                (result as any).err(),
              );
              engine.result(p, "AlreadyProcessed", "preflight");
            } else {
              sync();
              engine.result(p, null, "signature");
              engine.update();
            }
          },
        },
        budget,
        () => {},
      );
    engine = make();
    h.clock(t.t0 + 30n);
    chain.feed = {
      price: 10010000000n,
      publishTs: t.t0 + 30n,
      slot: 1,
      recvMs: Date.now(),
      source: "ws",
    };
    h.price(chain.feed.price, chain.feed.publishTs);
    engine.update();
    await flush();
    expect(h.ticketState(t).marks).toBe(1);
    engine.close();
    if (!hasFile) unlinkSync(path);
    height = new HeightRecord(path);
    budget = new CreationBudget(
      {
        call: async () => {
          throw Error("No hot-path query");
        },
      },
      h.marker.address,
      0n,
      height.loaded,
    );
    expect(height.loaded).toBe(hasFile ? 10151n : undefined);
    latest = { blockhash: b0, lastValidBlockHeight: 10150n };
    fee = 10000n;
    engine = make();
    h.clock(t.t0 + 31n);
    h.price(10020000000n, t.t0 + 31n);
    chain.feed = {
      price: 10020000000n,
      publishTs: t.t0 + 31n,
      slot: 2,
      recvMs: Date.now(),
      source: "ws",
    };
    const start = performance.now();
    engine.update();
    await flush();
    expect(attempts[1].at - start).toBeLessThan(50);
    expect(attempts[1].hash).toBe(b0);
    expect(h.ticketState(t).marks).toBe(2);
    latest = { blockhash: b1, lastValidBlockHeight: 10151n };
    fee = 10001n;
    h.clock(t.t0 + 32n);
    h.price(10030000000n, t.t0 + 32n);
    chain.feed = {
      price: 10030000000n,
      publishTs: t.t0 + 32n,
      slot: 3,
      recvMs: Date.now(),
      source: "ws",
    };
    engine.update();
    await flush();
    expect(attempts[2].signature).toBe(attempts[0].signature);
    console.log(
      "RESTART_ATTEMPTS " +
        JSON.stringify(attempts, (_, v) =>
          typeof v === "bigint" ? String(v) : v,
        ),
    );
    expect(attempts[2].error).toBe("6");
    expect(attempts[3].at - attempts[2].at).toBeLessThan(50);
    expect(attempts[3].fee).toBe(10002n);
    expect(attempts[3].signature).not.toBe(attempts[2].signature);
    expect(h.ticketState(t).marks).toBe(3);
    engine.close();
    console.log(
      "RESTART_ORDER " +
        JSON.stringify({
          hasFile,
          hashOrder: attempts.map((x) => x.hash),
          fees: attempts.map((x) => String(x.fee)),
          marks: 3,
        }),
    );
  });

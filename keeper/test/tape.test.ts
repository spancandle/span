import { it, expect } from "vitest";
import { validateDocument } from "./schemas.js";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { address, getBase58Decoder } from "@solana/kit";
import * as s from "../../program/client/index.js";
import { Harness, accountData } from "../../program/tests/harness.js";
import { Store } from "../src/common/sqlite.js";
import { History, transactionEvents } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { decodeDovesTransaction } from "../src/tape/doves-tx.js";
import { Publisher } from "../src/tape/publish.js";
import { liveDocuments } from "../src/tape/state.js";
import { ChainReader } from "../src/tape/chain.js";
import { httpServer, atomicFile } from "../src/tape/http.js";
import type { Chain } from "../src/keeper/chain.js";
const prefix = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
function rawTx(data: Uint8Array, slot = 1, err: any = null) {
  return {
    slot,
    blockTime: 1000 + slot,
    transaction: {
      message: { accountKeys: [s.SPAN_PROGRAM_ADDRESS], instructions: [] },
    },
    meta: {
      err,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 0,
              data: getBase58Decoder().decode(Buffer.concat([prefix, data])),
            },
          ],
        },
      ],
    },
  };
}
async function fixture() {
  const h = await Harness.create({ setSpan: true }),
    t = await h.open({ loaded: true });
  const chain = {
    rpc: { cluster: "devnet" },
    slot: 1,
    lastFullMs: Date.now(),
    lastReadMs: Date.now(),
    now: () => t.t0 + 3600n,
    candles: new Map([
      [t.candle, { value: h.candleState(t), slot: 1, data: "" }],
    ]),
    tickets: new Map([
      [t.ticket, { value: h.ticketState(t), slot: 1, data: "" }],
    ]),
    config: s.getConfigDecoder().decode(accountData(h.svm, h.config)),
  } as unknown as Chain;
  const store = new Store(":memory:"),
    rpc = { cluster: "devnet" } as any,
    recorder = new DovesRecorder(store, rpc),
    history = new History(store, rpc, (sig, v, slot) =>
      recorder.sample(sig, v.price, v.publishTs, slot),
    ),
    dir = mkdtempSync(join(tmpdir(), "span-tape-")),
    publisher = new Publisher(store, chain, history, recorder, dir);
  return { h, t, chain, store, recorder, history, dir, publisher };
}
it("S6(a) decodes SOL mainnet fixtures and devnet feed event layout", () => {
  let count = 0;
  for (const name of readdirSync(
    new URL("./fixtures/", import.meta.url),
  ).filter((x) => x.startsWith("doves-"))) {
    const raw = JSON.parse(
      readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
    );
    count += decodeDovesTransaction(raw.tx ?? raw).length;
  }
  expect(count).toBeGreaterThan(0);
  const d = Buffer.alloc(24);
  createHash("sha256").update("event:DevFeedUpdated").digest().copy(d, 0, 0, 8);
  d.writeBigUInt64LE(10_100_000_000n, 8);
  d.writeBigInt64LE(1000n, 16);
  const actual = JSON.parse(
    readFileSync(
      new URL("./fixtures/dev-feed-write.json", import.meta.url),
      "utf8",
    ),
  );
  expect(
    transactionEvents(actual).some((x) => x.name === "DevFeedUpdated"),
  ).toBe(true);
  expect(transactionEvents(rawTx(d))[0]).toMatchObject({
    name: "DevFeedUpdated",
    data: { price: 10_100_000_000n, publishTs: 1000n },
  });
});
it("S6(b,c) preserves all 2,001 Open tickets and constructs withdrawal accounts for the most expensive seller", async () => {
  const x = await fixture();
  x.chain.tickets.clear();
  for (let i = 0; i < 2001; i++) {
    const key = (await s.findTicketPda(BigInt(i)))[0];
    x.chain.tickets.set(key, {
      value: {
        ...x.h.ticketState(x.t),
        id: BigInt(i),
        premium: BigInt(i + 1),
        state: s.TicketState.Open,
      },
      slot: 1,
      data: "",
    });
  }
  const docs = liveDocuments(x.chain, x.history);
  expect(docs.tickets.tickets).toHaveLength(2001);
  const expensive = docs.tickets.tickets[2000];
  expect(expensive.premium).toBe("2001");
  expect(docs.state.candles[0].tickets.offers[0]!.id).toBe("0");
  expect((await s.findVaultPda(address(expensive.address)))[0]).toHaveLength(
    44,
  );
  const { findAssociatedTokenPda } = await import("@solana-program/token");
  expect(
    (
      await findAssociatedTokenPda({
        owner: address(expensive.seller),
        mint: x.chain.config!.usdcMint,
        tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      })
    )[0].length,
  ).toBeGreaterThanOrEqual(43);
  x.store.close();
});
it("S6(d,e,f,g) failed events never become receipts; late gap closure updates HTTP history within two seconds; settled receipts retain every mark", async () => {
  const x = await fixture(),
    t0 = x.t.t0;
  const marked = s.getMarkedEventEncoder().encode({
    ticket: x.t.ticket,
    id: x.t.id,
    t0,
    side: s.Side.High,
    price: 10_100_000_000n,
    publishTs: t0 + 30n,
    slot: 2n,
    burn: 100n, tailHigh: 10_100_000_000n,
    tailLow: 0n,
    marks: 1,
    burned: 100n,
    spanLeft: 99900n,
  });
  const settled = s.getSettledEventEncoder().encode({
    ticket: x.t.ticket,
    id: x.t.id,
    t0,
    outcome: s.Outcome.Paid,
    seller: x.h.seller.address,
    buyer: x.h.buyer.address,
    premium: 20000000n,
    p0: 10000000000n,
    readHigh: 10000000000n,
    readLow: 10000000000n,
    strikeBps: 0, tailHigh: 10100000000n,
    tailLow: 0n,
    high: 10100000000n,
    low: 10000000000n,
    payout: 10000000n,
    toBuyer: 10000000n,
    toSeller: 30000000n,
    spanReturned: 99900n,
    burned: 100n,
    marks: 1,
    reads: 1,
  });
  x.history.ingest("mark1", rawTx(new Uint8Array(marked), 2));
  x.history.ingest(
    "failed",
    rawTx(new Uint8Array(settled), 3, {
      InstructionError: [0, { Custom: s.SPAN_ERROR__NOT_CLOSED }],
    }),
  );
  expect(x.history.events("Settled")).toHaveLength(0);
  expect(x.history.recent().find((x) => x.sig === "failed").err).toBe(
    "NotClosed",
  );
  x.history.ingest("settled", rawTx(new Uint8Array(settled), 4));
  x.chain.tickets.clear();
  x.recorder.startRecording(Number(t0) - 120);
  x.recorder.cover(Number(t0) + 3720);
  x.recorder.sample("a", "10000000000", t0, 10);
  x.store.db.exec("DELETE FROM gaps");
  x.recorder.gap("late");
  x.store.db.prepare("UPDATE gaps SET a=?").run(Number(t0) + 10);
  x.publisher.publish(10000);
  const before = JSON.parse(readFileSync(join(x.dir, "history.json"), "utf8"));
  validateDocument("history", before);
  expect(before.receipts[0].markLog).toHaveLength(1);
  expect(before.candles[0].doves.complete).toBe(false);
  const server = httpServer(x.dir);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    x.recorder.sample("b", "10200000000", t0 + 3600n, 20);
    x.recorder.closeGaps();
    x.publisher.publish(12000);
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/history.json`,
    );
    const after: any = await response.json();
    expect(after.candles[0].doves).toEqual({
      high: "10200000000",
      low: "10000000000",
      complete: false,
    });
    expect(after.receipts[0].markLog[0].sig).toBe("mark1");
  } finally {
    server.closeAllConnections();
    server.close();
    x.store.close();
  }
});
it("S6(b) six snapshot schemas retain integer strings and freeze stale state/blockhash generations", async () => {
  const x = await fixture();
  x.publisher.publish();
  atomicFile(
    x.dir,
    "status.json",
    x.publisher.status({ requests1h: 0, busy1h: 0 }),
  );
  for (const name of ["state", "tickets", "feed", "history", "status"]) {
    const doc = JSON.parse(readFileSync(join(x.dir, `${name}.json`), "utf8"));
    validateDocument(name, doc);
    expect(doc.v).toBe(1);
    expect(doc.generated).toBeTypeOf("number");
  }
  const state = JSON.parse(readFileSync(join(x.dir, "state.json"), "utf8"));
  expect(state.slot).toBeTypeOf("string");
  expect(state.candles[0].reads).toHaveLength(13);
  expect(state.config.burnPerMark).toBeTypeOf("string");
  const cr = new ChainReader(x.chain.rpc as any, x.dir, x.history);
  cr.blockhash = "B0";
  cr.hashAt = Date.now();
  cr.publish();
  validateDocument(
    "chain",
    JSON.parse(readFileSync(join(x.dir, "chain.json"), "utf8")),
  );
  const first = readFileSync(join(x.dir, "chain.json"), "utf8");
  cr.hashAt -= 16000;
  cr.publish();
  expect(readFileSync(join(x.dir, "chain.json"), "utf8")).toBe(first);
  x.chain.lastReadMs = Date.now() - 13000;
  x.publisher.publish(Date.now() + 2000);
  expect(
    JSON.parse(readFileSync(join(x.dir, "state.json"), "utf8")).generated,
  ).toBe(state.generated);
  x.store.close();
});
it('publishes one cheapest offer per length with the lower id breaking ties',async()=>{
 const x=await fixture(),a=await x.h.open({strikeBps:200,premium:3000000n}),b=await x.h.open({strikeBps:25,premium:1000000n}),c=await x.h.open({strikeBps:200,premium:3000000n});
 const z=await x.h.open({strikeBps:0,premium:8000000n});for(const t of [a,b,c,z])x.chain.tickets.set(t.ticket,{value:x.h.ticketState(t),slot:1,data:''});
 const out=liveDocuments(x.chain,x.history);const offers=out.state.candles.find(c=>c.t0===String(a.t0))!.tickets.offers;expect(offers.map(o=>o.strikeBps)).toEqual([0,25,200]);expect(offers.find(o=>o.strikeBps===200)!.address).toBe(a.ticket);const cheap=await x.h.open({strikeBps:200,premium:2000000n});x.chain.tickets.set(cheap.ticket,{value:x.h.ticketState(cheap),slot:1,data:''});expect(liveDocuments(x.chain,x.history).state.candles[0]!.tickets.offers.find(o=>o.strikeBps===200)!.address).toBe(cheap.ticket);x.store.close();
});

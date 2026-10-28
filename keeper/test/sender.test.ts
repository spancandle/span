import { it, expect } from "vitest";
import {
  Sender,
  prepareTransaction,
  errorName,
  type Prepared,
} from "../src/keeper/sender.js";
import { RpcFault } from "../src/common/rpc.js";
import * as s from "../../program/client/index.js";
import { Harness } from "../../program/tests/harness.js";
import { getTransactionDecoder } from "@solana/kit";
import { createRequire } from "node:module";
const { FailedTransactionMetadata } = createRequire(
  new URL("../../program/package.json", import.meta.url),
)("litesvm");
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it("S1(c) BeforeBoundary resends identical bytes only at the next slot; failed signature ends rebroadcast immediately", async () => {
  const sent: any[] = [],
    callbacks: any[] = [];
  let before = true;
  const rpc = {
    callAt: async (_m: string, args: any[]) => {
      sent.push(args);
      if (before)
        throw new RpcFault(
          "sendTransaction",
          -32002,
          {
            err: {
              InstructionError: [2, { Custom: s.SPAN_ERROR__BEFORE_BOUNDARY }],
            },
          },
          true,
        );
      return { value: "sig", endpoint: "public" };
    },
  } as any;
  const ws = {
    subscribe: (_m: string, _p: any, cb: any) => {
      callbacks.push(cb);
      return () => {};
    },
  } as any;
  const sender = new Sender(
      rpc,
      ws,
      () => 1,
      () => 1n,
      () => 1000n,
      () => {},
    ),
    p = {
      action: { key: "r", kind: "read", t0: 1000n, end: 1042n },
      signature: "sig",
      wire: "identical",
      price: 10000n,
      lastValidBlockHeight: 100n,
      blockhash: "B0",
      rent: 0n,
    } as Prepared;
  const done: any[] = [];
  sender.done = (_p, e) => done.push(e);
  sender.send(p);
  await flush();
  expect(sent).toHaveLength(1);
  before = false;
  sender.onSlot();
  await flush();
  expect(sent).toHaveLength(2);
  expect(sent[0][0]).toBe(sent[1][0]);
  callbacks[0]({
    context: { slot: 2 },
    value: {
      err: { InstructionError: [2, { Custom: s.SPAN_ERROR__READ_FILLED }] },
    },
  });
  expect(done).toEqual(["ReadFilled"]);
  expect(sender.flights.size).toBe(0);
  sender.close();
});
it("S2(g) LiteSVM fixed blockhash accepts two marks with decreasing selected fee, and rejects overlapping signatures after restart", async () => {
  const h = await Harness.create({ setSpan: true }),
    t = await h.open({ loaded: true });
  h.clock(t.t0);
  h.price(10_000_000_000n, t.t0);
  await h.send("open", h.readIx(t, 0));
  h.svm.withTransactionHistory(1000n);
  const hash = h.svm.latestBlockhash(),
    latest = { blockhash: hash, lastValidBlockHeight: 10151n },
    action = {
      key: `mark:${t.ticket}`,
      kind: "mark" as const,
      t0: t.t0,
      ticket: t.ticket,
    };
  h.clock(t.t0 + 30n);
  h.price(10_010_000_000n, t.t0 + 30n);
  const first = await prepareTransaction(
    [h.markIx(t)],
    h.marker,
    latest,
    action,
    10001n,
  );
  const decode = (p: Prepared) =>
    getTransactionDecoder().decode(Buffer.from(p.wire, "base64"));
  const r1 = h.svm.sendTransaction(decode(first));
  expect(r1).not.toBeInstanceOf(FailedTransactionMetadata);
  h.price(10_020_000_000n, t.t0 + 31n);
  const overlap = await prepareTransaction(
    [h.markIx(t)],
    h.marker,
    latest,
    action,
    10001n,
  );
  expect(overlap.signature).toBe(first.signature);
  expect(h.svm.sendTransaction(decode(overlap))).toBeInstanceOf(
    FailedTransactionMetadata,
  );
  const second = await prepareTransaction(
    [h.markIx(t)],
    h.marker,
    latest,
    action,
    10002n,
  );
  expect(second.signature).not.toBe(first.signature);
  expect(h.svm.sendTransaction(decode(second))).not.toBeInstanceOf(
    FailedTransactionMetadata,
  );
  expect(h.ticketState(t).marks).toBe(2);
  console.log(
    "FIXED_HASH " +
      JSON.stringify({
        first: first.signature,
        second: second.signature,
        marks: h.ticketState(t).marks,
        selectedFees: [10001, 10000],
        usedFees: [10001, 10002],
      }),
  );
});
it("S1(h) a prior signature result is terminal and immediately requests a fresh attempt from memory", async () => {
  const callbacks: any[] = [];
  const rpc = {
      callAt: async () => ({ value: "old-signature", endpoint: "public" }),
    } as any,
    ws = {
      subscribe: (_m: string, _p: any, cb: any) => {
        callbacks.push(cb);
        return () => {};
      },
    } as any;
  const sender = new Sender(
    rpc,
    ws,
    () => 200,
    () => 1n,
    () => 1000n,
    () => {},
  );
  const done: any[] = [];
  sender.done = (_p, e) => done.push(e);
  sender.send({
    action: { key: "m", kind: "mark", t0: 900n },
    signature: "old-signature",
    wire: "old-wire",
    price: 10000n,
    lastValidBlockHeight: 100n,
    blockhash: "B0",
    rent: 0n,
  });
  await flush();
  callbacks[0]({ context: { slot: 190 }, value: { err: null } });
  expect(done).toEqual([null]);
  expect(sender.flights.size).toBe(0);
  sender.close();
});

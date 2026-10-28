import { it, expect } from "vitest";
import { Engine } from "../src/keeper/engine.js";
import { CreationBudget } from "../src/keeper/budget.js";
import { RpcFault } from "../src/common/rpc.js";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { TicketState } from "../../program/client/index.js";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it("a creation reserved while a finalized recount is in flight stays reserved, so the trailing limit holds", async () => {
  const rent = 2039280n,
    t0 = 1000000n,
    candle = {
      t0,
      readWindow: 20,
      ageLimit: 20,
      buyCutoff: 5,
      reads: Array.from({ length: 13 }, () => ({ price: 0n, publishTs: 0n })),
      readHigh: 0n,
      readLow: 0n,
    },
    ticket = (id: bigint) => ({
      value: {
        id,
        t0,
        state: TicketState.Open,
        marks: 0,
        spanLoaded: 0n,
        burned: 0n,
        marker: "other",
      },
      slot: 0,
      data: "",
    });
  let now = 0n,
    release: (() => void) | undefined,
    block = false;
  const chain = {
    candles: new Map([["candle", { value: candle, slot: 0, data: "" }]]),
    tickets: new Map([
      ["first", ticket(1n)],
      ["second", ticket(2n)],
    ]),
    config: undefined,
    feed: undefined,
    now: () => now,
  } as any;
  const budget = new CreationBudget(
    {
      call: async (method: string) => {
        if (method === "getEpochInfo")
          return { blockHeight: 200, absoluteSlot: 5000 };
        if (block) await new Promise<void>((r) => (release = r));
        return [];
      },
    } as any,
    "keeper",
    rent,
    100n,
  );
  const sent: string[] = [];
  const engine = new Engine(
    chain,
    "keeper" as any,
    {
      blockhash: () => "hash",
      price: () => 10000n,
      prepare: async (action, price) => ({
        action,
        price,
        signature: `sig-${action.key}`,
        wire: "",
        blockhash: "hash",
        lastValidBlockHeight: 1000n,
        rent,
      }),
      send: (p) => sent.push(p.action.ticket!),
      cancel: () => {},
    },
    budget,
    () => {},
  );
  await budget.reconcile();
  expect(budget.ready).toBe(true);
  block = true;
  const recount = budget.reconcile();
  await flush();
  now = t0 + 3641n;
  for (let i = 0; i < 2; i++) {
    engine.update();
    await flush();
  }
  expect(sent).toEqual(["first"]);
  release!();
  await recount;
  expect(budget.reserved()).toBe(rent);
  for (let i = 0; i < 2; i++) {
    engine.update();
    await flush();
  }
  expect(sent).toEqual(["first"]);
  expect(budget.waiting.has("settle:second")).toBe(true);
  engine.close();
});
const versioned = (versions: Record<string, number>) => ({
  cluster: "devnet",
  call: async (method: string, params: any[]) => {
    if (method === "getEpochInfo") return { blockHeight: 500, absoluteSlot: 900 };
    if (method === "getSignaturesForAddress")
      return Object.keys(versions)
        .reverse()
        .map((signature) => ({
          signature,
          slot: 10,
          blockTime: Math.floor(Date.now() / 1000),
          err: null,
        }));
    const signature = params[0];
    if (versions[signature] > params[1].maxSupportedTransactionVersion)
      throw new RpcFault("getTransaction", -32015, undefined, true);
    return {
      slot: 10,
      blockTime: 1000,
      version: versions[signature],
      transaction: {
        signatures: [signature],
        message: { accountKeys: ["payer"], instructions: [] },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [10000000],
        postBalances: [9995000],
        innerInstructions: [],
        logMessages: [],
        loadedAddresses: { writable: [], readonly: [] },
      },
    };
  },
});
it("a version 1 transaction in the program list does not stop tape history", async () => {
  const store = new Store(":memory:"),
    history = new History(
      store,
      versioned({ a: 0, b: 1, c: 0 }) as any,
      () => {},
    );
  await history.poll();
  expect(
    (store.db.prepare("SELECT COUNT(*) n FROM transactions").get() as any).n,
  ).toBe(3);
  expect(store.get("program-cursor")).toBe("c");
  store.close();
});
it("a version 1 transaction naming the keeper does not block the finalized recount", async () => {
  const budget = new CreationBudget(
    versioned({ x: 0, y: 1 }) as any,
    "keeper",
    50000000n,
    100n,
  );
  await budget.reconcile();
  expect(budget.ready).toBe(true);
  expect(budget.available(2039280n)).toBe(true);
});

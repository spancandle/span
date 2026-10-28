import { it, expect } from "vitest";
import { Harness, SOL_FEED } from "../../program/tests/harness.js";
import { Chain } from "../src/keeper/chain.js";
it("newer account slots deliver changed values even when publication timestamps move backwards; stale slots and identical tuples are ignored", async () => {
  const h = await Harness.create(),
    chain = new Chain({ cluster: "mainnet" } as any, {} as any, () => {});
  chain.config = h.configState();
  const delivered: any[] = [];
  chain.onFeed = (v) => delivered.push(v);
  const raw = () => {
    const a = h.svm.getAccount(SOL_FEED);
    if (!a.exists) throw Error("Missing oracle");
    return {
      owner: a.programAddress,
      data: [Buffer.from(a.data).toString("base64"), "base64"],
    };
  };
  h.price(10000000000n, 100n);
  await chain.ingestFeed(raw(), 10, "ws");
  h.price(10010000000n, 99n);
  await chain.ingestFeed(raw(), 11, "poll");
  expect(delivered.map((x) => [x.publishTs, x.price])).toEqual([
    [100n, 10000000000n],
    [99n, 10010000000n],
  ]);
  await chain.ingestFeed(raw(), 12, "ws");
  expect(delivered).toHaveLength(2);
  h.price(10020000000n, 101n);
  await chain.ingestFeed(raw(), 9, "poll");
  expect(delivered).toHaveLength(2);
});

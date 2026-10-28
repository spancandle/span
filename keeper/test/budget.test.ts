import { it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreationBudget, HeightRecord } from "../src/keeper/budget.js";
const now = 1792810000000;
function rpc() {
  let height = 100,
    slot = 200,
    list: any[] = [];
  const txs = new Map<string, any>(),
    calls: any[] = [],
    state = { fail: false, nullBody: false };
  return {
    state,
    txs,
    calls,
    set: (h: number, s: number, rows: any[]) => {
      height = h;
      slot = s;
      list = rows;
    },
    rpc: {
      call: async (method: string, params: any[]) => {
        calls.push({ method, params });
        if (method === "getEpochInfo")
          return { blockHeight: height, absoluteSlot: slot };
        if (method === "getSignaturesForAddress") {
          if (state.fail) throw Error("minContextSlot unavailable");
          return list;
        }
        if (state.nullBody) return null;
        return txs.get(params[0]) ?? null;
      },
    },
  };
}
const tx = (cost: number) => ({
  transaction: { message: { accountKeys: ["keeper"] } },
  meta: {
    preBalances: [100000000],
    postBalances: [100000000 - cost - 5000],
    fee: 5000,
  },
});
it("S3(d,e,f) finalized height and every page minContextSlot fence restart usage; delayed/min-context failures cannot open budget", async () => {
  const x = rpc(),
    b = new CreationBudget(x.rpc, "keeper", 5000000n, 100n, now);
  x.set(100, 200, []);
  await b.reconcile(now);
  expect(b.available(1n)).toBe(false);
  x.set(101, 205, [{ signature: "old", blockTime: now / 1000, err: null }]);
  x.state.fail = true;
  await b.reconcile(now);
  expect(b.ready).toBe(false);
  x.state.fail = false;
  await b.reconcile(now);
  expect(b.ready).toBe(false);
  x.txs.set("old", tx(4900000));
  await b.reconcile(now);
  expect(b.used).toBe(4900000n);
  expect(b.available(200000n)).toBe(false);
  expect(b.available(100000n)).toBe(true);
  const lists = x.calls.filter((x) => x.method === "getSignaturesForAddress");
  expect(
    lists.every(
      (x) =>
        x.params[1].commitment === "finalized" &&
        x.params[1].minContextSlot === 205,
    ),
  ).toBe(true);
  expect(b.available(0n)).toBe(true);
});
it("S3(g) live reservation survives lagging null body; complete finalized recount replaces it with actual cost", async () => {
  const x = rpc(),
    b = new CreationBudget(x.rpc, "keeper", 5000000n, 100n, now);
  x.set(101, 205, []);
  await b.reconcile(now);
  expect(b.reserve("sent", 4900000n, 150n)).toBe(true);
  expect(b.available(200000n)).toBe(false);
  x.set(150, 300, []);
  await b.reconcile(now);
  expect(b.reservations.size).toBe(1);
  x.set(151, 302, [{ signature: "sent", blockTime: now / 1000, err: null }]);
  x.state.nullBody = true;
  await b.reconcile(now);
  expect(b.reservations.size).toBe(1);
  expect(b.available(1n)).toBe(false);
  x.state.nullBody = false;
  x.txs.set("sent", tx(3000000));
  await b.reconcile(now);
  expect(b.reservations.size).toBe(0);
  expect(b.used).toBe(3000000n);
  expect(b.available(2000000n)).toBe(true);
});
it("S3(c,d) trailing 24 hours expire only via complete recount; missing file waits ten minutes for creations only", async () => {
  const x = rpc(),
    b = new CreationBudget(x.rpc, "keeper", 1n, undefined, now);
  x.set(1000, 2000, []);
  await b.reconcile(now + 599999);
  expect(b.available(1n)).toBe(false);
  expect(b.available(0n)).toBe(true);
  await b.reconcile(now + 600000);
  expect(b.ready).toBe(false);
  x.set(1001, 2002, []);
  await b.reconcile(now + 660000);
  expect(b.available(1n)).toBe(true);
  const used = new CreationBudget(x.rpc, "keeper", 5000000n, 900n, now);
  x.set(1001, 2002, [
    { signature: "old", blockTime: now / 1000 - 86401, err: null },
  ]);
  await used.reconcile(now);
  expect(used.used).toBe(0n);
});
it("Height record atomically persists only maximum expiration and treats missing/corrupt files as untrusted", () => {
  const file = join(
      mkdtempSync(join(tmpdir(), "span-height-")),
      "devnet-keeper.json",
    ),
    x = new HeightRecord(file);
  expect(x.loaded).toBeUndefined();
  x.save(10151n);
  x.save(10150n);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    lastValidBlockHeight: "10151",
  });
  expect(new HeightRecord(file).loaded).toBe(10151n);
});

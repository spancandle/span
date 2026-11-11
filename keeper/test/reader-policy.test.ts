import { expect, it } from "vitest";
import { pacedReserve, readerMarkAccepts, readerOptions } from "../src/keeper/reader-policy.js";
import type { Candle, Ticket } from "../../program/client/index.js";

it("initial-load reserve equals spent < allowance in all 378140 original states", () => {
  let count = 0;
  for (const n of [1, 5, 20, 40]) for (const d of [1800, 3600])
    for (let e = 0; e <= d; e++) for (let spent = 0; spent <= n; spent++) {
      const allowed = Math.min(n, Math.ceil(n * Math.min(d, Math.max(0, e) + 300) / d));
      const reserve = pacedReserve(BigInt(n) * 100n, 100n, BigInt(d), BigInt(e));
      if (((BigInt(n - spent) * 100n) / 100n > reserve) !== (spent < allowed))
        throw Error(`Budget mismatch ${n}/${d}/${e}/${spent}`);
      count++;
    }
  expect(count).toBe(378140);
});

const candle = (t0 = 1200n) => ({ t0, reads: [{ price: 10000000000n }],
  readHigh: 10000000000n, readLow: 10000000000n } as Candle);
const ticket = (more = {}) => ({ bandBps:400, spanLoaded: 500n, burned: 0n, strikeBps: 100, stepBps: 5,
  tailHigh: 0n, tailLow: 0n, ...more } as Ticket & {bandBps:number});
it("uses exact BigInt arithmetic, duration boundaries, zero initial whole units and remainders", () => {
  const n = (1n << 100n) + 17n;
  for (const d of [1800n, 3600n]) {
    expect(pacedReserve(n * 97n + 96n, 97n, d, -1000n)).toBe(n - (n * 300n + d - 1n) / d);
    expect(pacedReserve(n * 97n, 97n, d, d)).toBe(0n);
    expect(pacedReserve(99n, 100n, d, 0n)).toBe(0n);
  }
  expect(() => pacedReserve(1n, 0n, 1800n, 0n)).toThrow();
  expect(() => pacedReserve(1n, 1n, 0n, 0n)).toThrow();
});
it("combines validity, paid/free prediction and whole available units without using lifetime burned", () => {
  const c = candle(), t = ticket({ burned: 1000000000000000000000000000000n });
  const decide = (price: bigint, balance: bigint, now = 1260n, value = t) =>
    readerMarkAccepts("paced-v1", c, value, price, now, balance, 100n);
  expect(decide(10000000000n, 500n).accepted).toBe(false);
  expect(decide(10010000000n, 100n)).toMatchObject({ accepted: true, burns: false });
  expect(decide(10300000000n, 400n)).toMatchObject({ accepted: false, reason: "paced-reserve" });
  expect(decide(10300000000n, 499n).accepted).toBe(false);
  expect(decide(10300000000n, 500n)).toMatchObject({ accepted: true, burns: true });
  expect(decide(10300000000n, 600n).accepted).toBe(true);
  expect(decide(10010000000n, 99n)).toMatchObject({ accepted: false, reason: "SpanShort" });
  expect(decide(10300000000n, 400n, 3001n).accepted).toBe(true);
  expect(decide(10300000000n, 100n, 1260n, ticket({ spanLoaded: 99n })).accepted).toBe(true);
  expect(readerMarkAccepts("greedy", c, t, 10300000000n, 1260n, 0n, 100n).accepted).toBe(true);
  expect(readerMarkAccepts("paced-v1", candle(1203n), t, 10300000000n, 2104n, 300n, 100n).accepted).toBe(true);
});
it("accepts only full/greedy and marks/paced-v1 including backward-compatible defaults", () => {
  expect(readerOptions()).toEqual({ mode: "full", policy: "greedy" });
  expect(readerOptions("marks", "paced-v1")).toEqual({ mode: "marks", policy: "paced-v1" });
  for (const [mode, policy] of [["full", "paced-v1"], ["marks", "greedy"], ["", "greedy"], ["full", "paced"]])
    expect(() => readerOptions(mode, policy)).toThrow();
});

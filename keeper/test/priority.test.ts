import { it, expect } from "vitest";
import { address, type Instruction } from "@solana/kit";
import { PriorityFees } from "../src/keeper/priority.js";
const payer = address("11111111111111111111111111111111"),
  candle = address("SysvarC1ock11111111111111111111111111111111"),
  ticket = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  mint = address("So11111111111111111111111111111111111111112"),
  hold = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
it("samples the actual writable locks off the send path every ten seconds and retains the previous fee on failure", async () => {
  let now = 0,
    fail = false;
  const calls: any[] = [];
  const fees = new PriorityFees(
    {
      call: async (m, p) => {
        calls.push({ m, p });
        if (fail) throw Error("Unavailable");
        return [
          { prioritizationFee: 0 },
          { prioritizationFee: 12 },
          { prioritizationFee: 20 },
          { prioritizationFee: 30 },
          { prioritizationFee: 100 },
        ] as any;
      },
    },
    10n,
    1000n,
    () => now,
  );
  const read: Instruction = {
      programAddress: ticket,
      accounts: [
        { address: candle, role: 1 },
        { address: mint, role: 0 },
      ],
    },
    mark: Instruction = {
      programAddress: ticket,
      accounts: [
        { address: ticket, role: 1 },
        { address: mint, role: 1 },
        { address: hold, role: 1 },
        { address: candle, role: 0 },
      ],
    };
  fees.register("read", [read], payer);
  fees.register("mark", [mark], payer);
  expect(calls).toHaveLength(0);
  expect(fees.price("read")).toBe(10n);
  await fees.refresh();
  expect(calls.map((x) => x.p[0])).toEqual([
    [payer, candle],
    [payer, ticket, mint, hold],
  ]);
  expect(fees.price("mark")).toBe(30n);
  await fees.refresh();
  expect(calls).toHaveLength(2);
  now = 10000;
  fees.register("mark", [mark], payer);
  fail = true;
  await fees.refresh();
  expect(fees.price("mark")).toBe(30n);
  expect(calls).toHaveLength(4);
});
it("refresh completion stays attached when a new blockhash re-registers the action while RPC is pending", async () => {
  let now = 0,
    resolve!: (value: any) => void;
  const requests: any[] = [];
  const fees = new PriorityFees(
    {
      call: async (_m, p) => {
        requests.push(p);
        return await new Promise<any>((r) => (resolve = r));
      },
    },
    10n,
    1000n,
    () => now,
  );
  fees.register(
    "action",
    [{ programAddress: ticket, accounts: [{ address: candle, role: 1 }] }],
    payer,
  );
  const first = fees.refresh();
  fees.register(
    "action",
    [{ programAddress: ticket, accounts: [{ address: mint, role: 1 }] }],
    payer,
  );
  resolve([{ prioritizationFee: 100 }]);
  await first;
  expect(fees.price("action")).toBe(100n);
  now = 10000;
  fees.register(
    "action",
    [{ programAddress: ticket, accounts: [{ address: mint, role: 1 }] }],
    payer,
  );
  const second = fees.refresh();
  expect(requests[1]).toEqual([[payer, mint]]);
  resolve([{ prioritizationFee: 200 }]);
  await second;
  expect(fees.price("action")).toBe(200n);
});

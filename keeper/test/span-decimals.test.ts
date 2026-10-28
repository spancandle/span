import { it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapOption } from "@solana/kit";
import * as s from "../../program/client/index.js";
import { TOKEN_2022 } from "../../program/client/constants.js";
import { Harness, accountData } from "../../program/tests/harness.js";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
import { SpanDecimals, liveDocuments } from "../src/tape/state.js";
import { validateDocument } from "./schemas.js";
import type { Chain } from "../src/keeper/chain.js";

function tape(h: Harness, decimals?: SpanDecimals) {
  const chain = {
      rpc: { cluster: "devnet" },
      slot: 1,
      lastFullMs: Date.now(),
      lastReadMs: Date.now(),
      now: () => 2000n,
      candles: new Map(),
      tickets: new Map(),
      config: s.getConfigDecoder().decode(accountData(h.svm, h.config)),
    } as unknown as Chain,
    store = new Store(":memory:"),
    rpc = { cluster: "devnet" } as any,
    history = new History(store, rpc, () => {}),
    dir = mkdtempSync(join(tmpdir(), "span-decimals-")),
    publisher = new Publisher(
      store,
      chain,
      history,
      new DovesRecorder(store, rpc),
      dir,
      decimals ? (m) => decimals.get(m) : undefined,
    );
  const state = (now = Date.now()) => {
    publisher.publish(now);
    const doc = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    validateDocument("state", doc);
    return doc;
  };
  return { chain, store, history, publisher, state };
}
// Answers getAccountInfo with the harness mint bytes after `failures` errors.
function mintRpc(h: Harness, failures = 0) {
  const calls: { method: string; params: any[] }[] = [];
  return {
    calls,
    rpc: {
      call: async (method: string, params: any[]) => {
        calls.push({ method, params });
        if (calls.length <= failures) throw Error("Unavailable");
        return {
          context: { slot: 1 },
          value: {
            data: [
              Buffer.from(accountData(h.svm, h.spanMint)).toString("base64"),
              "base64",
            ],
          },
        };
      },
    } as any,
  };
}

it("K1 spanDecimals is null while Config.spanMint is null and no mint is read", async () => {
  const h = await Harness.create(),
    m = mintRpc(h),
    decimals = new SpanDecimals(m.rpc),
    x = tape(h, decimals);
  expect(unwrapOption(x.chain.config!.spanMint)).toBeNull();
  await decimals.refresh(unwrapOption(x.chain.config!.spanMint) ?? null);
  expect(m.calls).toHaveLength(0);
  const doc = x.state();
  expect(doc.config.spanMint).toBeNull();
  expect(doc.config).toHaveProperty("spanDecimals", null);
  expect(liveDocuments(x.chain, x.history).state.config.spanDecimals).toBeNull();
  x.store.close();
});

it("K1 spanDecimals is byte 44 of the mint account (8 for classic and Token-2022 mints) and is read once", async () => {
  for (const spanProgram of [undefined, TOKEN_2022]) {
    const h = await Harness.create({ setSpan: true, spanProgram }),
      data = accountData(h.svm, h.spanMint);
    expect(data[44]).toBe(8);
    const m = mintRpc(h),
      decimals = new SpanDecimals(m.rpc),
      x = tape(h, decimals),
      mint = unwrapOption(x.chain.config!.spanMint)!;
    expect(mint).toBe(h.spanMint);
    await decimals.refresh(mint, 1000);
    expect(m.calls).toEqual([
      {
        method: "getAccountInfo",
        params: [mint, { encoding: "base64", commitment: "confirmed" }],
      },
    ]);
    const doc = x.state();
    expect(doc.config.spanMint).toBe(mint);
    expect(doc.config.spanDecimals).toBe(8);
    await decimals.refresh(mint, 1_000_000);
    expect(m.calls).toHaveLength(1);
    console.log(
      "SPAN_DECIMALS " +
        JSON.stringify({ program: spanProgram ?? "token", bytes: data.length, spanDecimals: doc.config.spanDecimals }),
    );
    x.store.close();
  }
});

it("K1 a failed mint read publishes null and is retried after 15 seconds", async () => {
  const h = await Harness.create({ setSpan: true }),
    m = mintRpc(h, 1),
    decimals = new SpanDecimals(m.rpc),
    x = tape(h, decimals),
    mint = unwrapOption(x.chain.config!.spanMint)!;
  await expect(decimals.refresh(mint, 1000)).rejects.toThrow("Unavailable");
  expect(x.state(10_000).config.spanDecimals).toBeNull();
  await decimals.refresh(mint, 15_999);
  expect(m.calls).toHaveLength(1);
  await decimals.refresh(mint, 16_000);
  expect(m.calls).toHaveLength(2);
  expect(x.state(11_000).config.spanDecimals).toBe(8);
  x.store.close();
});

it("K1 a missing or uninitialized mint account is a failed read", async () => {
  const h = await Harness.create({ setSpan: true }),
    mint = h.spanMint;
  for (const value of [null, { data: [Buffer.alloc(82).toString("base64"), "base64"] }]) {
    const decimals = new SpanDecimals({ call: async () => ({ value }) } as any);
    await expect(decimals.refresh(mint, 0)).rejects.toThrow("Mint unavailable");
    expect(decimals.get(mint)).toBeNull();
  }
});

import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBase58Decoder, address } from "@solana/kit";
import * as s from "../../program/client/index.js";
import { SOL_FEED } from "../../program/client/constants.js";
import { Store } from "../src/common/sqlite.js";
import { readKeeperTelemetry } from "../src/common/telemetry.js";
import { History } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
import type { Chain } from "../src/keeper/chain.js";

it("a telemetry reader that gives up before the answer is written does not end the keeper process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "span-tele-")),
    module = fileURLToPath(new URL("../src/common/telemetry.ts", import.meta.url)),
    // A busy keeper whose answer is long: the reader's 300 ms limit cuts it off mid-write.
    code = `const { keeperTelemetry } = await import(${JSON.stringify(module)});
keeperTelemetry(${JSON.stringify(dir)}, "devnet", "keeper", () => { const t = Date.now(); while (Date.now() - t < 40); return { big: "x".repeat(200000) }; });
setInterval(() => {}, 1000);`,
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { stdio: "ignore" },
    );
  let exited: number | null = null;
  child.on("exit", (c) => (exited = c ?? -1));
  try {
    for (let i = 0; i < 100 && !readdirSync(dir).some((f) => f.endsWith(".sock")); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(dir).some((f) => f.endsWith(".sock"))).toBe(true);
    for (let i = 0; i < 20; i++) await readKeeperTelemetry(dir, "devnet");
    await new Promise((r) => setTimeout(r, 500));
    expect(exited).toBe(null);
  } finally {
    child.kill();
  }
}, 30000);

const T = 1_800_000_000,
  DAY = 86400,
  NOBODY = address("11111111111111111111111111111111"),
  prefix = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
function settled(t0: number) {
  const data = s.getSettledEventEncoder().encode({
    ticket: NOBODY,
    id: 1n,
    t0: BigInt(t0),
    outcome: s.Outcome.Paid,
    seller: NOBODY,
    buyer: NOBODY,
    premium: 20000000n,
    p0: 8_246_000_000n,
    readHigh: 8_246_000_000n,
    readLow: 8_246_000_000n,
    strikeBps: 0, tailHigh: 0n,
    tailLow: 0n,
    high: 8_300_000_000n,
    low: 8_200_000_000n,
    payout: 0n,
    toBuyer: 0n,
    toSeller: 20000000n,
    spanReturned: 0n,
    burned: 0n,
    marks: 0,
    reads: 13,
  });
  return {
    slot: 500,
    blockTime: t0 + 3700,
    transaction: {
      message: { accountKeys: [s.SPAN_PROGRAM_ADDRESS], instructions: [] },
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 0,
              data: getBase58Decoder().decode(
                Buffer.concat([prefix, Buffer.from(data)]),
              ),
            },
          ],
        },
      ],
    },
  };
}
it("history.json keeps a settled candle's DOVES high and low once its first rows are pruned at eight days", () => {
  let clock = T + 3720;
  const dir = mkdtempSync(join(tmpdir(), "span-history8d-")),
    store = new Store(join(dir, "tape.sqlite")),
    rpc = { cluster: "devnet" } as any,
    recorder = new DovesRecorder(store, rpc),
    history = new History(store, rpc, () => {}),
    chain = {
      rpc,
      slot: 1,
      lastFullMs: 0,
      lastReadMs: -Infinity,
      now: () => BigInt(clock),
      candles: new Map(),
      tickets: new Map(),
      config: { feed: SOL_FEED },
    } as unknown as Chain,
    publisher = new Publisher(store, chain, history, recorder, join(dir, "public"));
  recorder.startRecording(T - 120);
  recorder.sample("open", 8_246_000_000n, T, 1010);
  // The hour's low comes early; its row is the first to be pruned.
  recorder.sample("early-low", 8_201_000_000n, T + 900, 3000);
  recorder.sample("high", 8_299_000_000n, T + 1500, 4500);
  recorder.sample("close", 8_250_000_000n, T + 3600, 10000);
  recorder.cover(T + 3720);
  recorder.closeGaps();
  history.ingest("settle", settled(T));
  const doves = () =>
    publisher.historyDocument().candles.find((c: any) => c.t0 === String(T))!
      .doves;
  const whole = doves();
  expect(whole).toEqual({ high: "8299000000", low: "8201000000", complete: true });
  clock = T + 8 * DAY + 1000;
  publisher.prune(clock);
  expect(doves()).toEqual(whole);
  clock = T + 8 * DAY + 3700;
  publisher.prune(clock);
  expect(doves()).toEqual(whole);
  expect(existsSync(dir)).toBe(true);
  store.close();
});

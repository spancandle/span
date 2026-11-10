import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, lamports, type Address } from "@solana/kit";
import { Harness, amount } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { capture } from "./resale-support.js";
import { OPEN_HOURS } from "../src/common/open-hours.js";
import { EventHoursFile, hourAt } from "../src/common/event-hours.js";
const fixture = vi.hoisted(() => ({ rpc: undefined as any, sockets: [] as any[] }));
vi.mock("../src/common/rpc.js", async () => {
  const actual = await vi.importActual<any>("../src/common/rpc.js");
  return { ...actual, RpcPool: class { constructor() { return fixture.rpc; } } };
});
vi.mock("../src/common/ws.js", () => ({ Subscriptions: class {
  ready = true; endpoint = "local-vm"; subs: any[] = []; closed = false;
  constructor() { fixture.sockets.push(this); }
  subscribe(kind: string, args: any[], cb: any) {
    const sub = { kind, args, cb }; this.subs.push(sub);
    if (kind === "signatureSubscribe") queueMicrotask(() => cb({ context: { slot: 1 }, value: { err: null } }));
    return () => { this.subs = this.subs.filter(s => s !== sub); };
  }
  on() {} start() {} close() { this.closed = true; this.subs = []; }
} }));
import { runKeeper, createPrepare } from "../src/keeper/main.js";
import { Chain, pairedSpanBalance } from "../src/keeper/chain.js";
import { Engine } from "../src/keeper/engine.js";
import { Sender, type Action, type Prepared } from "../src/keeper/sender.js";
import { readerOptions } from "../src/keeper/reader-policy.js";
import { ROOT } from "../src/common/env.js";
import { keeperLock } from "../src/keeper/lock.js";
import { RpcFault } from "../src/common/rpc.js";
import { runTape } from "../src/tape/main.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.sockets = []; });
const wait = async (fn: () => boolean) => {
  const end = performance.now() + 6000;
  while (!fn()) { if (performance.now() > end) throw Error("Local reader timeout"); await new Promise(r => setTimeout(r, 5)); }
};
async function signer(dir: string, name: string) {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const bytes = Buffer.concat([Buffer.from(key.d!, "base64url"), Buffer.from(key.x!, "base64url")]), file = join(dir, name + ".json");
  writeFileSync(file, JSON.stringify([...bytes]), { mode: 0o600 });
  return { signer: await createKeyPairSignerFromBytes(bytes), file };
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "span-reader-runtime-")), h = await Harness.create(),
    greedy = await signer(dir, "greedy"), paced = await signer(dir, "paced");
  h.marker = greedy.signer; h.stranger = paced.signer;
  for (const p of [h.marker, h.stranger]) h.svm.airdrop(p.address, lamports(100000000000n));
  h.svm.withBlockhashCheck(false);
  await h.send("burn", h.ix("setSpan", { admin: h.admin, burnPerMark: 100n }), h.admin);
  const catalog = join(dir, "readers.json");
  writeFileSync(catalog, JSON.stringify({ v: 1, readers: [
    { id: "greedy", marker: greedy.signer.address, mode: "full", policy: "greedy" },
    { id: "paced-v1", marker: paced.signer.address, mode: "marks", policy: "paced-v1" }] }));
  const raw = (key: Address) => {
    const a = h.svm.getAccount(key);
    return a.exists ? { executable: a.executable, owner: a.programAddress, lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"] } : null;
  };
  const rows: { payer: string; kind: string; wire: string; error: any }[] = [];
  let failInit = false;
  const rpc: any = { cluster: "mainnet", metrics: { snapshot: () => ({}) }, closed: false,
    initialize: async () => { if (failInit) throw Error("Local initialization failure"); }, close: () => { rpc.closed = true; },
    call: async (method: string, args: any[] = []) => {
      const context = { slot: Number(h.svm.getClock().slot) };
      if (method === "getAccountInfo") return { context, value: raw(args[0]) };
      if (method === "getMultipleAccounts") return { context, value: args[0].map(raw) };
      if (method === "getProgramAccounts") return { context, value: h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS)
        .filter(a => getBase58Decoder().decode(a.data.subarray(0, 8)) === args[1].filters[0].memcmp.bytes)
        .map(a => ({ pubkey: a.address, account: raw(a.address) })) };
      if (method === "getLatestBlockhash") return { value: { blockhash: h.svm.latestBlockhash(), lastValidBlockHeight: 10000000000 } };
      if (method === "getBlockHeight") return 1;
      if (method === "getEpochInfo") return { blockHeight: 20000000000, absoluteSlot: context.slot };
      if (method === "getSignaturesForAddress" || method === "getRecentPrioritizationFees") return [];
      if (method === "getBalance") return { value: 100000000000 };
      if (method === "getMinimumBalanceForRentExemption") return Number(h.svm.minimumBalanceForRentExemption(BigInt(args[0])));
      throw Error(`Unexpected local RPC ${method}`);
    },
    callAt: async (method: string, args: any[], _mode: any, _a: any, _b: any, onRequest: () => void) => {
      expect(method).toBe("sendTransaction"); onRequest();
      const tx = getTransactionDecoder().decode(Buffer.from(args[0], "base64")), message: any = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
        instruction = message.instructions.find((i: any) => message.staticAccounts[i.programAddressIndex] === s.SPAN_PROGRAM_ADDRESS)!;
      const discriminator = Buffer.from(instruction.data!.subarray(0, 8));
      const kind = discriminator.equals(Buffer.from(s.OPEN_CANDLE_DISCRIMINATOR)) ? "open" : discriminator.equals(Buffer.from(s.MARK_DISCRIMINATOR)) ? "mark" :
        discriminator.equals(Buffer.from(s.READ_DISCRIMINATOR)) ? "read" : discriminator.equals(Buffer.from(s.SETTLE_DISCRIMINATOR)) ? "settle" : "other";
      const result = capture(h, args[0]); rows.push({ payer: message.staticAccounts[0], kind, wire: args[0], error: result.tx.meta.err });
      if (result.tx.meta.err) {
        const code = Number(/Error Number: (\d+)/.exec(result.tx.meta.logMessages.join("\n"))?.[1]);
        throw new RpcFault("sendTransaction", -32002, { err: { InstructionError: [2, { Custom: code }] } }, true);
      }
      return { value: result.signature, endpoint: "local-vm" };
    } };
  fixture.rpc = rpc;
  vi.stubEnv("SPAN_CLUSTER", "mainnet"); vi.stubEnv("KEEPER_ALLOW_MAINNET", "1");
  vi.stubEnv("KEEPER_RELEASE_HOURS", "0"); vi.stubEnv("KEEPER_HALF_HOURS", "0"); vi.stubEnv("SPAN_READERS_FILE", catalog);
  vi.stubEnv("KEEPER_PRIORITY_FEE_MIN", "10000"); vi.stubEnv("KEEPER_ASSETS", "SOL");
  const start = async (policy: "greedy" | "paced-v1", suffix: string = policy) => {
    const data = mkdtempSync(join(dir, suffix + "-")); writeFileSync(join(data, "mainnet-keeper.json"), '{"lastValidBlockHeight":"1"}');
    vi.stubEnv("KEEPER_ACTION_MODE", policy === "greedy" ? "full" : "marks"); vi.stubEnv("KEEPER_MARK_POLICY", policy);
    vi.stubEnv("KEEPER_KEYPAIR", policy === "greedy" ? greedy.file : paced.file); vi.stubEnv("KEEPER_DATA_DIR", data);
    return runKeeper({ releaseHours: [] });
  };
  return { h, dir, greedy, paced, start, rpc, rows, failInit: (v: boolean) => { failInit = v; } };
}

const OPEN = OPEN_HOURS.find(t => t === BigInt(Date.parse("2026-11-10T14:29:00Z") / 1000))!;
const settled = async (live: Awaited<ReturnType<typeof runKeeper>>) => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await wait(() => (live.engine as any).preparing.size === 0 && (live.chain as any).busy.size === 0);
};
it("actual full runKeeper opens only SOL hourly with all assets and halves enabled, retaining it across listed-hour changes", async () => {
  const x = await setup(), { h } = x, listed = join(x.dir, "hours.json");
  writeFileSync(listed, JSON.stringify({v:1,hours:[],hide:[]}));
  vi.stubEnv("KEEPER_OPEN_HOURS", "1"); vi.stubEnv("KEEPER_ASSETS", "SOL,BTC,ETH"); vi.stubEnv("KEEPER_HALF_HOURS", "1"); vi.stubEnv("SPAN_EVENT_HOURS", listed);
  let reread = () => {};
  vi.spyOn(EventHoursFile.prototype, "watch").mockImplementation(function(this: EventHoursFile, changed) {
    reread = () => { if (this.read()) changed(); }; return () => {};
  });
  h.clock(OPEN - 86401n); const live = await x.start("greedy");
  live.chain.now = () => h.svm.getClock().unixTimestamp;
  try {
    live.engine.update(); await settled(live); expect(x.rows).toHaveLength(0);
    const date = "2026-11-12", et = "18:00";
    writeFileSync(listed, JSON.stringify({v:1,hours:[{date,et,t:hourAt(date,et),name:"Earnings",why:"A scheduled report",source:"https://example.com/report"}],hide:[]}));
    reread(); h.clock(OPEN - 86400n); await live.chain.pollClock(); live.engine.update();
    const key = (await s.findCandlePda(OPEN))[0]; await wait(() => h.svm.getAccount(key).exists);
    await live.chain.pollPrograms();
    const candles = h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS).filter(a => Buffer.from(a.data.subarray(0,8)).equals(Buffer.from(s.CANDLE_DISCRIMINATOR))).map(a => s.getCandleDecoder().decode(a.data).t0);
    expect(candles).toEqual([OPEN]); expect(x.rows.some(r => r.kind === "open" && r.payer === h.marker.address && !r.error)).toBe(true);
    expect(x.rows.every(r => r.kind === "open")).toBe(true);
  } finally { live.close(); }
});
it("actual runKeeper leaves opening disabled by default and marks mode ignores the opening flag and ticketless reads", async () => {
  for (const policy of ["greedy", "paced-v1"] as const) {
    const x = await setup(), { h } = x;
    vi.stubEnv("KEEPER_OPEN_HOURS", policy === "greedy" ? "" : "1"); vi.stubEnv("SPAN_EVENT_HOURS", "");
    h.clock(OPEN - 86400n); const live = await x.start(policy);
    live.chain.now = () => h.svm.getClock().unixTimestamp;
    try {
      await settled(live); expect(x.rows).toHaveLength(0);
      if (policy === "paced-v1") {
        const ref = await h.ref(OPEN); await h.send("existing opening", h.openCandleIx(ref));
        h.clock(OPEN); h.price(10000000000n, OPEN);
        await live.chain.pollClock(); await live.chain.pollPrograms(); await live.chain.pollFeed(); live.engine.update();
        await settled(live); expect(x.rows).toHaveLength(0);
      }
    } finally { live.close(); }
  }
});
it("actual tape adds ticketless opening candles without an opening environment switch", async () => {
  const x = await setup(), { h } = x, ref = await h.ref(OPEN);
  h.clock(OPEN - 100n); await h.send("opening", h.openCandleIx(ref));
  const end = s.settleAfter(h.candleState(ref)); h.clock(end - 1n);
  vi.stubEnv("KEEPER_OPEN_HOURS", ""); vi.stubEnv("SPAN_EVENT_HOURS", ""); vi.stubEnv("TAPE_PORT", "0"); vi.stubEnv("TAPE_HOST", "127.0.0.1"); vi.stubEnv("TAPE_DATA_DIR", join(x.dir,"tape")); vi.stubEnv("KEEPER_DATA_DIR", join(x.dir,"telemetry"));
  const live = await runTape();
  try {
    expect(live.publisher.historyDocument().candles).toEqual([]);
    h.clock(end); await live.chain.pollClock();
    expect(live.publisher.historyDocument().candles.map(c => c.t0)).toEqual([String(OPEN)]);
    expect(live.publisher.historyDocument().receipts).toEqual([]);
  } finally { live.close(); }
});

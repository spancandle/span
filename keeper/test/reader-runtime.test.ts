import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, lamports, type Address } from "@solana/kit";
import { Harness, amount } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { capture } from "./resale-support.js";
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
      const kind = discriminator.equals(Buffer.from(s.MARK_DISCRIMINATOR)) ? "mark" :
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
it("actual runKeeper pairs full/greedy and marks/paced through preparation, signing, Sender and current program settlement", async () => {
  const x = await setup(), { h } = x, a = await h.open({ sold: true, strikeBps: 100 }), b = await h.open({ sold: true, strikeBps: 100 });
  await h.send("loads", [h.loadIx(a, { amount: 500n }), h.loadIx(b, { amount: 500n, marker: h.stranger.address })], h.buyer);
  const prepared: { signer: string; action: Action }[] = [], sent: { signer: string; action: Action }[] = [];
  const warm = Engine.prototype.warm, send = Sender.prototype.send;
  vi.spyOn(Engine.prototype, "warm").mockImplementation(function(this: Engine, a) { prepared.push({ signer: this.keeper, action: a }); return warm.call(this, a); });
  vi.spyOn(Sender.prototype, "send").mockImplementation(function(this: Sender, p, v) {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(p.wire, "base64")).messageBytes);
    sent.push({ signer: message.staticAccounts[0], action: p.action }); return send.call(this, p, v);
  });
  let full: Awaited<ReturnType<typeof runKeeper>> | undefined, paced: typeof full;
  const sync = async (pairs = true) => {
    for (const live of [full, paced]) if (live) {
      await live.chain.pollClock(); await live.chain.pollPrograms(); if (pairs) await live.chain.pollSpanHolds("keeper"); await live.chain.pollFeed(); live.engine.update();
    }
  };
  const feed = async (elapsed: bigint, price: bigint, pairs = true) => { h.clock(a.t0 + elapsed); h.price(price, a.t0 + elapsed); await sync(pairs); };
  try {
    full = await x.start("greedy"); paced = await x.start("paced-v1");
    await expect(x.start("paced-v1", "different-data")).rejects.toThrow("already running");
    await feed(0n, 10000000000n); await wait(() => h.candleState(a).reads[0].price > 0n);
    await feed(60n, 10120000000n); await wait(() => h.ticketState(a).marks === 1 && h.ticketState(b).marks === 1);
    await feed(70n, 10140000000n); await wait(() => h.ticketState(a).marks === 2);
    expect(h.ticketState(b).marks).toBe(1); expect(amount(h.svm, b.spanHold)).toBe(400n);
    // Restart reconstructs the same reserve, even in another state directory.
    paced.close(); paced = await x.start("paced-v1", "restart"); await sync();
    await new Promise(r => setTimeout(r, 40)); expect(h.ticketState(b).marks).toBe(1);
    // A direct token transfer does not modify spanLoaded. It makes one more paid mark available.
    const token = await import("@solana-program/token");
    await h.send("top_up", token.getTransferInstruction({ source: h.buyerSpan, destination: b.spanHold, authority: h.buyer, amount: 199n }), h.buyer);
    expect(h.ticketState(b).spanLoaded).toBe(500n);
    await sync(); await wait(() => h.ticketState(b).marks === 2); expect(amount(h.svm, b.spanHold)).toBe(499n);
    // Slot and identity changes invalidate the old pair before the next coherent observation.
    await h.send("marker_away", h.ix("setMarker", { ...b, buyer: h.buyer, marker: h.marker.address }), h.buyer);
    await feed(80n, 10160000000n, false); await wait(() => h.ticketState(b).marks === 3);
    await h.send("marker_back", h.ix("setMarker", { ...b, buyer: h.buyer, marker: h.stranger.address }), h.buyer);
    await feed(90n, 10180000000n, false);
    expect(pairedSpanBalance(paced.chain.tickets.get(b.ticket)!, paced.chain.spanHolds.get(b.ticket))).toBeUndefined();
    expect(h.ticketState(b).marks).toBe(3);
    await sync(); expect(h.ticketState(b).marks).toBe(3); // reserve still binds; no new epoch on marker return
    await feed(2500n, 10200000000n); await wait(() => h.ticketState(b).marks === 4);
    for (let j = 9; j <= 12; j++) { await feed(BigInt(j) * 300n, 10000000000n); await wait(() => h.candleState(a).reads[j].price > 0n); }
    h.clock(s.settleAfter(h.candleState(a))); await sync(); await wait(() => !h.svm.getAccount(a.ticket).exists && !h.svm.getAccount(b.ticket).exists);
    // Signature acknowledgement can beat account observation: the unchanged full reader may
    // submit an obsolete read/extension. Both must be rejected atomically by the program.
    expect(x.rows.filter(r => r.error && !(r.kind === "read" && r.error.includes("6029")) &&
      !(r.kind === "mark" && r.payer === h.marker.address && r.error.includes("6034")))).toEqual([]);
    expect(x.rows.filter(r => r.payer === h.stranger.address).every(r => r.kind === "mark")).toBe(true);
    expect(x.rows.filter(r => r.payer === h.marker.address && r.kind === "settle")).toHaveLength(2);
    expect(x.rows.filter(r => r.payer === h.marker.address && r.kind === "read").length).toBeGreaterThan(1);
    for (const records of [prepared, sent]) {
      expect(records.filter(r => r.signer === h.stranger.address).length).toBeGreaterThan(0);
      expect(records.filter(r => r.signer === h.stranger.address && r.action.kind !== "mark")).toHaveLength(0);
      expect(records.filter(r => r.action.kind === "mark" && r.signer === h.stranger.address).every(r => r.action.ticket === b.ticket)).toBe(true);
    }
    const guarded = await createPrepare(x.rpc, h.stranger, paced.chain, { register: () => {} }, () => undefined, readerOptions("marks", "paced-v1"));
    for (const kind of ["open", "read", "settle", "closeUntil", "closeResale", "closeBid", "closeRequest"] as const)
      await expect(guarded({ kind, key: kind, t0: a.t0 }, 1n)).rejects.toThrow("Marks-only");
    console.log("READER_RUNTIME", JSON.stringify({ signed: x.rows.map(r => ({ payer: r.payer === h.marker.address ? "greedy" : "paced", kind: r.kind })),
      pacedNonMarkPrepared: 0, pacedNonMarkSent: 0, settlements: 2 }));
  } finally { full?.close(); paced?.close(); }
}, 30000);

it("runKeeper rejects invalid combinations and cleans the signer lock/RPC/sockets on initialization failure", async () => {
  const x = await setup();
  x.failInit(true); await expect(x.start("paced-v1")).rejects.toThrow("initialization failure"); expect(x.rpc.closed).toBe(true);
  let release = keeperLock(ROOT, "mainnet", x.paced.signer.address); release();
  x.failInit(false);
  const original = Chain.prototype.init;
  vi.spyOn(Chain.prototype, "init").mockRejectedValueOnce(Error("Chain init failure"));
  await expect(x.start("paced-v1")).rejects.toThrow("Chain init failure");
  expect(fixture.sockets.at(-1).closed).toBe(true); release = keeperLock(ROOT, "mainnet", x.paced.signer.address); release();
  vi.spyOn(Chain.prototype, "init").mockImplementation(original);
  vi.stubEnv("KEEPER_ACTION_MODE", "marks"); vi.stubEnv("KEEPER_MARK_POLICY", "greedy");
  await expect(runKeeper()).rejects.toThrow("Invalid keeper action mode");
  const live = await x.start("paced-v1"); live.close(); live.close();
  release = keeperLock(ROOT, "mainnet", x.paced.signer.address); release();
});
it("runTape publishes the validated catalog once, supports no configuration, and rejects an invalid configured file before RPC", async () => {
  const x = await setup();
  vi.stubEnv("TAPE_PORT", "0"); vi.stubEnv("TAPE_HOST", "127.0.0.1"); vi.stubEnv("KEEPER_DATA_DIR", join(x.dir, "telemetry"));
  for (const configured of [true, false]) {
    const data = mkdtempSync(join(x.dir, "tape-")); vi.stubEnv("TAPE_DATA_DIR", data);
    if (!configured) vi.stubEnv("SPAN_READERS_FILE", "");
    const live = await runTape();
    try {
      const document = JSON.parse(readFileSync(join(data, "public/readers.json"), "utf8"));
      expect(document).toMatchObject({ v: 1, cluster: "mainnet", program: s.SPAN_PROGRAM_ADDRESS });
      expect(document.readers).toHaveLength(configured ? 2 : 0);
      if (configured) expect(document.readers[1].marker).toBe(x.paced.signer.address);
    } finally { live.close(); }
  }
  const bad = join(x.dir, "invalid-readers.json"); writeFileSync(bad, "{}"); vi.stubEnv("SPAN_READERS_FILE", bad);
  const initialize = vi.spyOn(x.rpc, "initialize"); await expect(runTape()).rejects.toThrow("Invalid readers configuration");
  expect(initialize).not.toHaveBeenCalled();
});

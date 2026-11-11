import { afterAll, afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as realImmediate } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createKeyPairSignerFromBytes, getBase58Decoder, lamports, type Address } from "@solana/kit";
import { Harness } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { capture } from "./resale-support.js";

const fixture = vi.hoisted(() => ({ rpc: undefined as any, socket: undefined as any }));
vi.mock("../src/common/rpc.js", async () => ({ ...await vi.importActual<any>("../src/common/rpc.js"),
  RpcPool: class { constructor() { return fixture.rpc; } } }));
vi.mock("../src/common/ws.js", () => ({ Subscriptions: class {
  ready = true; endpoint = "local-vm"; subs: any[] = [];
  constructor() { fixture.socket = this; }
  subscribe(kind: string, args: any[], cb: any) {
    const entry = { kind, args, cb }; this.subs.push(entry);
    return () => { this.subs = this.subs.filter(x => x !== entry); };
  }
  on() {} start() {} close() { this.subs = []; }
  program(key: Address, account: any, slot: number) {
    const discriminator = getBase58Decoder().decode(Buffer.from(account.data[0], "base64").subarray(0, 8));
    for (const x of this.subs) if (x.kind === "programSubscribe" && x.args[1].filters[0].memcmp.bytes === discriminator)
      x.cb({ context: { slot }, value: { pubkey: key, account } });
  }
} }));
import { runKeeper } from "../src/keeper/main.js";
import { Overlay } from "../src/keeper/overlay.js";
import { CLOCK } from "../src/keeper/chain.js";
import { RpcFault } from "../src/common/rpc.js";
import type { Sender } from "../src/keeper/sender.js";

const reports: Record<string, any> = {};
afterAll(() => {
  if (process.env.SPAN_READER_POLLING_OUT) writeFileSync(process.env.SPAN_READER_POLLING_OUT, JSON.stringify(reports, null, 2) + "\n");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const T0 = 360000n, P0 = 10000000000n;
async function realUntil(ready: () => boolean, label: string) {
  const deadline = performance.now() + 5000;
  do {
    await realImmediate();
    if (ready()) return;
  } while (performance.now() < deadline);
  throw Error(`Timed out waiting for ${label}`);
}
async function signer(dir: string, name: string) {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
    bytes = Buffer.concat([Buffer.from(key.d!, "base64url"), Buffer.from(key.x!, "base64url")]), file = join(dir, name + ".json");
  writeFileSync(file, JSON.stringify([...bytes]), { mode: 0o600 });
  return { signer: await createKeyPairSignerFromBytes(bytes), file };
}
async function setup(mode: "marks" | "full", elapsed: number, own = false, flight = false) {
  const dir = mkdtempSync(join(tmpdir(), "reader-polling-")), h = await Harness.create(),
    greedy = await signer(dir, "greedy"), paced = await signer(dir, "paced");
  h.marker = greedy.signer; h.stranger = paced.signer; h.svm.withBlockhashCheck(false);
  for (const p of [h.marker, h.stranger]) h.svm.airdrop(p.address, lamports(100000000000n));
  await h.send("span", h.ix("setSpan", { admin: h.admin, burnPerMark: 100n }), h.admin);
  h.clock(T0 - 1000n); const ticket = await h.open({ t0: T0, sold: true, strikeBps: 100 });
  await h.send("load", h.loadIx(ticket, { amount: 500n, marker: own ? paced.signer.address : h.buyer.address }), h.buyer);
  if (flight) for (const j of [0, 12]) {
    h.clock(T0 + BigInt(j * 300)); h.price(P0, T0 + BigInt(j * 300));
    await h.send("read", h.readIx(ticket, j), h.marker);
  }
  h.clock(T0 + BigInt(elapsed)); h.price(flight ? 10120000000n : P0, flight ? T0 + 3600n : T0 - 1000n);
  const catalog = join(dir, "readers.json"), data = join(dir, "state");
  writeFileSync(catalog, JSON.stringify({ v: 1, readers: [
    { id: "greedy", marker: greedy.signer.address, mode: "full", policy: "greedy" },
    { id: "paced-v1", marker: paced.signer.address, mode: "marks", policy: "paced-v1" }] }));
  const calls: { method: string; at: number; account?: string }[] = [];
  const raw = (key: Address) => {
    const a = h.svm.getAccount(key);
    return a.exists ? { executable: a.executable, owner: a.programAddress, lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"] } : null;
  };
  let release: (() => void) | undefined, sender: Sender | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const time = () => { h.clock(BigInt(Math.floor(Date.now() / 1000))); };
  const count = (method: string, account?: string) => { time(); calls.push({ method, at: Date.now(), ...(account ? { account } : {}) }); };
  const rpc: any = { cluster: "mainnet", metrics: { snapshot: () => ({}) }, initialize: async () => {}, close: () => {},
    call: async (method: string, args: any[] = []) => {
      count(method, method === "getAccountInfo" ? args[0] : undefined);
      const context = { slot: Number(h.svm.getClock().slot) };
      if (method === "getAccountInfo") return { context, value: raw(args[0]) };
      if (method === "getMultipleAccounts") return { context, value: args[0].map(raw) };
      if (method === "getProgramAccounts") return { context, value: h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS)
        .filter(a => (!args[1].filters?.length || getBase58Decoder().decode(a.data.subarray(0, 8)) === args[1].filters[0].memcmp.bytes))
        .map(a => ({ pubkey: a.address, account: raw(a.address) })) };
      if (method === "getLatestBlockhash") return { value: { blockhash: h.svm.latestBlockhash(), lastValidBlockHeight: 10000000000 } };
      if (method === "getBlockHeight") return 1;
      if (method === "getEpochInfo") return { blockHeight: 20000000000, absoluteSlot: context.slot };
      if (method === "getSignaturesForAddress" || method === "getRecentPrioritizationFees") return [];
      if (method === "getBalance") return { value: 100000000000 };
      if (method === "getSignatureStatuses") return { value: [null] };
      throw Error("Unexpected local RPC " + method);
    },
    callAt: async (method: string, args: any[], _mode: any, _a: any, _b: any, onRequest: () => void) => {
      count(method); expect(method).toBe("sendTransaction"); onRequest(); await gate; time();
      const result = capture(h, args[0]);
      if (result.tx.meta.err) {
        const code = Number(/Error Number: (\d+)/.exec(result.tx.meta.logMessages.join("\n"))?.[1]);
        throw new RpcFault(method, -32002, { err: { InstructionError: [2, { Custom: code }] } }, true);
      }
      return { value: result.signature, endpoint: "local-vm" };
    } };
  fixture.rpc = rpc;
  for (const [key, value] of Object.entries({ SPAN_CLUSTER: "mainnet", KEEPER_ALLOW_MAINNET: "1", KEEPER_RELEASE_HOURS: "0",
    KEEPER_HALF_HOURS: "0", SPAN_READERS_FILE: catalog, KEEPER_ASSETS: "SOL", KEEPER_PRIORITY_FEE_MIN: "10000",
    KEEPER_ACTION_MODE: mode, KEEPER_MARK_POLICY: mode === "marks" ? "paced-v1" : "greedy",
    KEEPER_KEYPAIR: mode === "marks" ? paced.file : greedy.file, KEEPER_DATA_DIR: data })) vi.stubEnv(key, value);
  const original = Overlay.prototype.start;
  vi.spyOn(Overlay.prototype, "start").mockImplementation(function(this: Overlay) { sender = this.sender; return original.call(this); });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(Number(T0 + BigInt(elapsed)) * 1000);
  const live = await runKeeper({ releaseHours: [] });
  // Native crypto and RPC continuations must finish before the next fake clock tick.
  // The deliberately blocked Sender response is awaited separately after release.
  const settle = () => realUntil(() =>
    (live.chain as unknown as { busy: Set<string> }).busy.size === 0 &&
    (live.engine as unknown as { preparing: Set<string> }).preparing.size === 0,
    "reader polling and preparation");
  const advance = async (ms: number) => {
    const end = Date.now() + ms;
    await settle();
    while (Date.now() < end) {
      await vi.advanceTimersByTimeAsync(Math.min(50, end - Date.now()));
      await settle();
    }
  };
  const snapshot = (label: string, from: number) => {
    const rows = calls.filter(c => c.at > from), methods: Record<string, number> = {};
    for (const c of rows) methods[c.method] = (methods[c.method] ?? 0) + 1;
    const timeline = (method: string, account?: string) => rows.filter(c => c.method === method && (!account || c.account === account)).map(c => c.at - from);
    const report = { methods, programs: timeline("getProgramAccounts"), feed: timeline("getAccountInfo", h.feed),
      hash: timeline("getLatestBlockhash"), height: timeline("getBlockHeight"), clock: timeline("getAccountInfo", CLOCK) };
    reports[label] = report; console.log("READER_POLLING", JSON.stringify({ label, methods, feed: report.feed.length })); return report;
  };
  return { h, ticket, live, calls, raw, paced, sender: () => sender!, release: () => release!(), snapshot,
    advance };
}

it("marks stays idle for ten minutes of another reader's active candle", async () => {
  const x = await setup("marks", 100);
  try {
    await x.advance(1000); const from = Date.now(); await x.advance(600000);
    const r = x.snapshot("marks-other-600s", from);
    expect(r.feed).toHaveLength(0); expect(r.methods.getProgramAccounts).toBe(240);
    expect(r.hash).toHaveLength(10); expect(r.height).toHaveLength(10);
    expect(new Set(r.hash.slice(1).map((v, i) => v - r.hash[i]))).toEqual(new Set([60000]));
  } finally { x.live.close(); }
}, 60000);

it("marks starts work at the original pre-window boundary and after a marker WS notification", async () => {
  const x = await setup("marks", -181, true);
  try {
    const base = Date.now(); await x.advance(60000); const from = Date.now();
    await x.advance(999); expect(x.calls.filter(c => c.method === "getLatestBlockhash" && c.at > from)).toHaveLength(0);
    await x.advance(51); expect(x.live.chain.now()).toBe(T0 - 120n);
    const r = x.snapshot("marks-pre-window", from);
    expect(r.hash).toEqual([1050]); expect(r.feed).toEqual([1050]);
    await x.advance(2000); const active = x.snapshot("marks-pre-window-active", base + 61050);
    expect(active.methods.getProgramAccounts).toBe(6); expect(active.feed).toHaveLength(5); expect(active.hash).toHaveLength(1);
  } finally { x.live.close(); }
  vi.useRealTimers(); vi.restoreAllMocks();
  const y = await setup("marks", 100);
  try {
    await y.advance(550); const from = Date.now();
    await y.h.send("new_marker", y.h.ix("setMarker", { ...y.ticket, buyer: y.h.buyer, marker: y.paced.signer.address }), y.h.buyer);
    fixture.socket.program(y.ticket.ticket, y.raw(y.ticket.ticket), Number(y.h.svm.getClock().slot));
    await y.advance(50); const r = y.snapshot("marks-ws-entry", from);
    expect(r.hash).toEqual([50]); expect(r.feed).toEqual([50]);
    await y.advance(4000); const active = y.snapshot("marks-ws-active", from + 50);
    expect(active.methods.getProgramAccounts).toBe(12); expect(active.methods.getMultipleAccounts).toBe(2);
    expect(active.feed).toHaveLength(10); expect(active.hash).toHaveLength(2);
  } finally { y.live.close(); }
}, 60000);

it("marks keeps fast polling past its window while an actual Sender flight is unresolved, then idles", async () => {
  const x = await setup("marks", 3618, true, true);
  try {
    const from = Date.now();
    await x.advance(50);
    await realUntil(() => x.sender().flights.size === 1, "the signed flight before the window ends");
    expect(x.sender().flights.size).toBe(1);
    await x.advance(4100 - (Date.now() - from));
    expect(x.live.chain.now()).toBeGreaterThan(T0 + 3620n); expect(x.sender().flights.size).toBe(1);
    const r = x.snapshot("marks-flight-tail", from);
    expect(r.hash).toContain(4000); expect(r.feed.some(t => t >= 4000)).toBe(true);
    x.release(); await realUntil(() => x.sender().flights.size === 0, "the released Sender response");
    await x.advance(0); expect(x.sender().flights.size).toBe(0);
    const idle = Date.now(); await x.advance(6000); const stopped = x.snapshot("marks-after-flight", idle);
    expect(stopped.feed).toHaveLength(0); expect(stopped.hash).toHaveLength(0); expect(stopped.methods.getProgramAccounts ?? 0).toBe(0);
  } finally { x.live.close(); }
}, 60000);

it("full/greedy retains the same per-method calls and cadence", async () => {
  const x = await setup("full", 100);
  try {
    await x.advance(1000); const from = Date.now(); await x.advance(600000); const r = x.snapshot("full-other-600s", from);
    expect(r.methods.getProgramAccounts).toBe(1800); expect(r.feed).toHaveLength(1500);
    expect(r.hash).toHaveLength(300); expect(r.height).toHaveLength(300);
    if (process.env.SPAN_READER_POLLING_BASELINE) {
      const baseline = JSON.parse(readFileSync(process.env.SPAN_READER_POLLING_BASELINE, "utf8"));
      expect(r).toEqual(baseline["full-other-600s"]);
    }
  } finally { x.live.close(); }
}, 60000);

import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, lamports, type Address } from "@solana/kit";
import { Harness, amount } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { capture } from "./resale-support.js";
const fixture = vi.hoisted(() => ({ rpc: undefined as any, sockets: [] as any[], beforeAck: () => {}, afterAck: () => {} }));
vi.mock("../src/common/rpc.js", async () => {
  const actual = await vi.importActual<any>("../src/common/rpc.js");
  return { ...actual, RpcPool: class { constructor() { return fixture.rpc; } } };
});
vi.mock("../src/common/ws.js", () => ({ Subscriptions: class {
  acknowledgements = 0;
  ready = true; endpoint = "local-vm"; subs: any[] = []; closed = false;
  constructor() { fixture.sockets.push(this); }
  subscribe(kind: string, args: any[], cb: any) {
    const sub = { kind, args, cb }; this.subs.push(sub);
    if (kind === "signatureSubscribe" && ++this.acknowledgements === 1) queueMicrotask(() => { fixture.beforeAck(); cb({ context: { slot: 1 }, value: { err: null } }); fixture.afterAck(); });
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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.sockets = []; fixture.beforeAck = () => {}; fixture.afterAck = () => {}; });
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
  let failInit = false, held = false;
  const blocked: string[] = [], releases: (() => void)[] = [];
  const release = () => { held = false; for (const done of releases.splice(0)) done(); };
  const rpc: any = { cluster: "mainnet", metrics: { snapshot: () => ({}) }, closed: false,
    initialize: async () => { if (failInit) throw Error("Local initialization failure"); }, close: () => { rpc.closed = true; },
    call: async (method: string, args: any[] = []) => {
      if (held && ["getProgramAccounts", "getMultipleAccounts"].includes(method)) {
        blocked.push(method); await new Promise<void>(resolve => releases.push(resolve));
      }
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
  return { h, dir, greedy, paced, start, rpc, rows, blocked, release, hold: () => { held = true; }, failInit: (v: boolean) => { failInit = v; } };
}

async function scenario(policy: "greedy" | "paced-v1", free = false) {
  const x = await setup(), { h } = x, t = await h.open({ sold: true, strikeBps: 100 });
  await h.send("load", h.loadIx(t, { amount: 500n, marker: policy === "greedy" ? h.marker.address : h.stranger.address }), h.buyer);
  h.clock(t.t0); h.price(10000000000n, t.t0); await h.send("first_read", h.readIx(t, 0));
  let live: Awaited<ReturnType<typeof runKeeper>> | undefined, acknowledged = false;
  const logs: any[] = [], done: Promise<unknown>[] = [];
  const first = free ? 10010000000n : 10120000000n, next = free ? 10020000000n : 10140000000n;
  try {
    live = await x.start(policy);
    const reader = live, prepare = vi.spyOn(reader.engine.port, "prepare"), send = vi.spyOn(reader.engine.port, "send");
    // Record the real preparation/signing path, not a substitute sender.
    let preparedAtAck = 0, sentAtAck = 0;
    const logger = reader.engine.logger;
    (reader.engine as any).logger = (row: any) => { logs.push(row); logger(row); };
    fixture.beforeAck = () => { x.hold(); acknowledged = true; preparedAtAck = prepare.mock.calls.length; sentAtAck = send.mock.calls.length; };
    fixture.afterAck = () => {
      h.clock(t.t0 + 70n); h.price(next, t.t0 + 70n);
      done.push(reader.chain.pollPrograms(), reader.chain.pollSpanHolds("keeper"));
      done.push(reader.chain.pollClock().then(() => reader.chain.pollFeed()));
    };
    h.clock(t.t0 + 60n); await reader.chain.pollClock(); await reader.chain.pollSpanHolds("keeper");
    h.price(first, t.t0 + 60n); await reader.chain.pollFeed();
    await wait(() => acknowledged && x.blocked.includes("getMultipleAccounts") && x.blocked.filter(m => m === "getProgramAccounts").length >= 6);
    await new Promise(r => setTimeout(r, 100));
    reader.engine.update();
    const before = { prepared: prepare.mock.calls.length - preparedAtAck, sent: send.mock.calls.length - sentAtAck,
      attempts: x.rows.filter(r => r.kind === "mark").length - 1, rejected: x.rows.filter(r => r.kind === "mark" && r.error).length,
      marks: h.ticketState(t).marks, burned: String(h.ticketState(t).burned), remaining: String(amount(h.svm, t.spanHold)) };
    // Unblock both program snapshots and the ticket/holding pair at elapsed 70.
    x.release(); await Promise.all(done); await reader.chain.pollPrograms(); await reader.chain.pollSpanHolds("keeper");
    reader.engine.update(); await new Promise(r => setTimeout(r, 40));
    const after = { prepared: prepare.mock.calls.length - preparedAtAck, sent: send.mock.calls.length - sentAtAck,
      marks: h.ticketState(t).marks, burned: String(h.ticketState(t).burned), remaining: String(amount(h.svm, t.spanHold)) };
    const result = { policy, free, before, after, reasons: [...new Set(logs.filter(r => r.event === "mark-decision").map(r => r.reason))], blocked: x.blocked };
    if (process.env.SPAN_READER_OBSERVATION_OUT) {
      const { appendFileSync } = await import("node:fs"); appendFileSync(process.env.SPAN_READER_OBSERVATION_OUT, JSON.stringify(result) + "\n");
    }
    return result;
  } finally { live?.close(); x.release(); await Promise.all(done); }
}
it("actual runKeeper waits for a newer paired mark after paid signature success", async () => {
  const r = await scenario("paced-v1");
  expect(r.before).toEqual({ prepared: 0, sent: 0, attempts: 0, rejected: 0, marks: 1, burned: "100", remaining: "400" });
  expect(r.after).toMatchObject({ sent: 0, marks: 1, burned: "100", remaining: "400" });
  expect(r.reasons).toContain("mark-observation-pending"); expect(r.reasons).toContain("paced-reserve");
});
it("actual runKeeper also waits after a free successful mark, then resumes from the pair", async () => {
  const r = await scenario("paced-v1", true);
  expect(r.before).toEqual({ prepared: 0, sent: 0, attempts: 0, rejected: 0, marks: 1, burned: "0", remaining: "500" });
  expect(r.after.sent).toBe(1); expect(r.after.marks).toBe(2); expect(r.after.burned).toBe("0");
  expect(r.reasons).toContain("mark-observation-pending");
});
it("actual runKeeper keeps full greedy signature retry behavior", async () => {
  const r = await scenario("greedy");
  expect(r.before).toEqual({ prepared: 2, sent: 1, attempts: 1, rejected: 0, marks: 2, burned: "200", remaining: "300" });
  expect(r.after.marks).toBe(2); expect(r.after.sent).toBe(1);
  expect(r.reasons).not.toContain("mark-observation-pending");
});

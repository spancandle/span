import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import * as errors from "../../../program/client/src/generated/errors/span.js";
import type { RpcPool } from "../common/rpc.js";
import { RpcFault } from "../common/rpc.js";
import type { Subscriptions } from "../common/ws.js";
import { log, type Logger } from "../common/log.js";
import type { FeedValue } from "../common/feed.js";
export type Action = {
  key: string;
  kind: "read" | "mark" | "settle";
  t0: bigint;
  j?: number;
  ticket?: string;
  end?: bigint;
};
export type Prepared = {
  action: Action;
  signature: string;
  wire: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  price: bigint;
  rent: bigint;
};
export function errorName(value: any): string {
  const e = value instanceof RpcFault ? (value.data?.err ?? value.data) : value;
  const custom =
    e?.InstructionError?.[1]?.Custom ?? e?.err?.InstructionError?.[1]?.Custom;
  if (typeof custom === "number") {
    const pair = Object.entries(errors).find(
      ([k, v]) => k.startsWith("SPAN_ERROR__") && v === custom,
    );
    if (pair)
      return pair[0]
        .slice(12)
        .split("_")
        .map((x) => x[0] + x.slice(1).toLowerCase())
        .join("");
    return `Custom${custom}`;
  }
  const text = typeof e === "string" ? e : JSON.stringify(e ?? "");
  if (/already.?processed/i.test(text)) return "AlreadyProcessed";
  return typeof e === "string"
    ? e
    : value instanceof RpcFault
      ? `RPC${value.code ?? "Transport"}`
      : "UnknownError";
}
export async function prepareTransaction(
  ixs: readonly Instruction[],
  payer: TransactionSigner,
  latest: { blockhash: any; lastValidBlockHeight: bigint },
  action: Action,
  price: bigint,
  rent = 0n,
): Promise<Prepared> {
  const limit =
    action.kind === "read"
      ? 40000
      : action.kind === "mark"
        ? 60000
        : rent > 0n
          ? 250000
          : 80000;
  const a = Buffer.alloc(5),
    b = Buffer.alloc(9);
  a[0] = 2;
  a.writeUInt32LE(limit, 1);
  b[0] = 3;
  b.writeBigUInt64LE(price, 1);
  const cu = address("ComputeBudget111111111111111111111111111111");
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (x) => setTransactionMessageFeePayerSigner(payer, x),
      (x) => setTransactionMessageLifetimeUsingBlockhash(latest, x),
      (x) =>
        appendTransactionMessageInstructions(
          [
            { programAddress: cu, data: a },
            { programAddress: cu, data: b },
            ...ixs,
          ],
          x,
        ),
    ),
  );
  return {
    action,
    signature: getSignatureFromTransaction(tx),
    wire: getBase64EncodedWireTransaction(tx),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    price,
    rent,
  };
}
type Flight = {
  p: Prepared;
  accepted: boolean;
  retrySlot: boolean;
  ack: boolean;
  timer?: ReturnType<typeof setInterval>;
  stop?: () => void;
  busy: boolean;
  trigger?: FeedValue;
};
export class Sender {
  readonly flights = new Map<string, Flight>();
  done = (_p: Prepared, _error: string | null, _stage: string) => {};
  constructor(
    readonly rpc: RpcPool,
    readonly ws: Subscriptions,
    readonly slot: () => number,
    readonly height: () => bigint,
    readonly now: () => bigint,
    readonly logger: Logger = log,
  ) {}
  cancel(key: string) {
    const f = this.flights.get(key);
    if (!f) return;
    clearInterval(f.timer);
    f.stop?.();
    this.flights.delete(key);
  }
  finish(f: Flight, error: string | null, stage: string, slot?: number) {
    if (this.flights.get(f.p.action.key) !== f) return;
    this.cancel(f.p.action.key);
    this.logger({
      event: "action",
      ...f.p.action,
      signature: f.p.signature,
      result: error === "ReadFilled" ? "obsolete" : stage,
      error,
      landingSlot: slot,
    });
    this.done(f.p, error, stage);
  }
  send(p: Prepared, trigger?: FeedValue) {
    if (this.flights.has(p.action.key)) return;
    const f: Flight = {
      p,
      accepted: false,
      retrySlot: false,
      ack: false,
      busy: false,
      trigger,
    };
    this.flights.set(p.action.key, f);
    this.logger({
      event: "action",
      ...p.action,
      trigger,
      firstSendMs: Date.now(),
      firstSendSlot: this.slot(),
      signature: p.signature,
      result: "first-send",
      price: p.price,
      rent: p.rent,
    });
    void this.transmit(f, false);
    f.timer = setInterval(() => {
      if (this.flights.get(p.action.key) !== f) return;
      if (
        this.height() > p.lastValidBlockHeight ||
        (p.action.end !== undefined && this.now() > p.action.end)
      ) {
        this.finish(f, "Expired", "expired");
        return;
      }
      if (f.accepted && !f.ack) void this.transmit(f, true);
    }, 400);
    const audit = setTimeout(() => void this.audit(p), 20000);
    audit.unref();
  }
  private async transmit(f: Flight, skip: boolean) {
    if (f.busy || this.flights.get(f.p.action.key) !== f) return;
    f.busy = true;
    try {
      const v = await this.rpc.callAt<string>(
        "sendTransaction",
        [
          f.p.wire,
          {
            encoding: "base64",
            skipPreflight: skip,
            preflightCommitment: "processed",
            maxRetries: 0,
          },
        ],
        f.p.action.kind === "settle" ? "normal" : "window",
      );
      if (this.flights.get(f.p.action.key) !== f) return;
      if (v.value !== f.p.signature) throw Error("RPC signature mismatch");
      if (!f.accepted) {
        f.accepted = true;
        f.retrySlot = false;
        this.logger({
          event: "accepted",
          key: f.p.action.key,
          signature: f.p.signature,
          endpoint: v.endpoint,
          atMs: Date.now(),
        });
        f.stop = this.ws.subscribe(
          "signatureSubscribe",
          [f.p.signature, { commitment: "processed" }],
          (v) =>
            this.finish(
              f,
              v.value?.err ? errorName(v.value.err) : null,
              "signature",
              v.context?.slot,
            ),
        );
      }
    } catch (e) {
      if (this.flights.get(f.p.action.key) !== f) return;
      const name = errorName(e);
      if (name === "BeforeBoundary" && f.p.action.kind === "read" && !skip) {
        f.retrySlot = true;
        this.logger({
          event: "preflight",
          key: f.p.action.key,
          error: name,
          signature: f.p.signature,
        });
      } else if (!skip) this.finish(f, name, "preflight");
    } finally {
      f.busy = false;
    }
  }
  onSlot() {
    for (const f of this.flights.values())
      if (f.retrySlot) void this.transmit(f, false);
  }
  pendingSignatures() {
    return [...this.flights.values()]
      .filter((f) => f.accepted)
      .map((f) => f.p.signature);
  }
  async pollDisconnected() {
    const sigs = this.pendingSignatures();
    if (!sigs.length) return;
    const v = await this.rpc.call("getSignatureStatuses", [sigs]);
    for (let i = 0; i < sigs.length; i++) {
      const x = v.value[i];
      if (!x) continue;
      const f = [...this.flights.values()].find(
        (f) => f.p.signature === sigs[i],
      );
      if (f)
        this.finish(f, x.err ? errorName(x.err) : null, "signature", x.slot);
    }
  }
  private async audit(p: Prepared) {
    try {
      const v = await this.rpc.call("getSignatureStatuses", [
        [p.signature],
        { searchTransactionHistory: true },
      ]);
      const x = v.value[0];
      const blockTime = x
        ? await this.rpc.call("getBlockTime", [x.slot])
        : null;
      this.logger({
        event: "landing",
        ...p.action,
        signature: p.signature,
        slot: x?.slot,
        blockTime,
        error: x?.err ? errorName(x.err) : null,
      });
    } catch {
      this.logger({
        event: "landing",
        key: p.action.key,
        signature: p.signature,
        result: "unavailable",
      });
    }
  }
  close() {
    for (const key of this.flights.keys()) this.cancel(key);
  }
}

import {
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RpcPool } from "../common/rpc.js";
export class HeightRecord {
  readonly loaded?: bigint;
  private maximum = 0n;
  constructor(readonly path: string) {
    try {
      const x = JSON.parse(readFileSync(path, "utf8"));
      if (
        typeof x.lastValidBlockHeight !== "string" ||
        !/^\d+$/.test(x.lastValidBlockHeight)
      )
        throw Error();
      this.maximum = BigInt(x.lastValidBlockHeight);
      this.loaded = this.maximum;
    } catch {}
  }
  save(height: bigint) {
    if (height <= this.maximum) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({ lastValidBlockHeight: height.toString() }) + "\n",
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    const d = openSync(dirname(this.path), "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
    this.maximum = height;
  }
}
export class CreationBudget {
  used = 0n;
  ready = false;
  readonly reservations = new Map<string, { rent: bigint; height: bigint }>();
  waiting = new Set<string>();
  private busy = false;
  private anchor?: bigint;
  constructor(
    readonly rpc: Pick<RpcPool, "call">,
    readonly payer: string,
    readonly limit: bigint,
    readonly loadedHeight: bigint | undefined,
    readonly started = Date.now(),
  ) {
    this.anchor = loadedHeight;
  }
  reserved() {
    return [...this.reservations.values()].reduce((n, x) => n + x.rent, 0n);
  }
  available(rent: bigint) {
    return (
      rent === 0n ||
      (this.ready && this.used + this.reserved() + rent <= this.limit)
    );
  }
  reserve(sig: string, rent: bigint, height: bigint) {
    if (rent === 0n) return true;
    if (!this.available(rent)) return false;
    this.reservations.set(sig, { rent, height });
    return true;
  }
  async reconcile(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const epoch = await this.rpc.call("getEpochInfo", [
        { commitment: "finalized" },
      ]);
      const h = BigInt(epoch.blockHeight);
      if (this.anchor === undefined) {
        if (now - this.started < 600000) return;
        this.anchor = h;
        return;
      }
      const bound = [
        this.anchor,
        ...[...this.reservations.values()].map((x) => x.height),
      ].reduce((a, b) => (a > b ? a : b));
      if (h <= bound) return;
      const slot = epoch.absoluteSlot,
        rows: any[] = [];
      let before: string | undefined;
      for (;;) {
        const batch: any[] = await this.rpc.call("getSignaturesForAddress", [
          this.payer,
          {
            commitment: "finalized",
            minContextSlot: slot,
            limit: 1000,
            ...(before ? { before } : {}),
          },
        ]);
        rows.push(...batch);
        if (
          batch.length < 1000 ||
          batch.some(
            (x) => x.blockTime !== null && x.blockTime * 1000 < now - 86400000,
          )
        )
          break;
        const next = batch.at(-1)?.signature;
        if (!next || next === before)
          throw Error("Budget pagination incomplete");
        before = next;
      }
      let total = 0n;
      for (const row of rows) {
        if (row.blockTime !== null && row.blockTime * 1000 < now - 86400000)
          continue;
        const tx = await this.rpc.call("getTransaction", [
          row.signature,
          {
            commitment: "finalized",
            encoding: "json",
            maxSupportedTransactionVersion: 1,
          },
        ]);
        if (!tx?.meta) throw Error("Budget transaction unavailable");
        const first = tx.transaction.message.accountKeys[0],
          payer = typeof first === "string" ? first : first.pubkey;
        if (payer !== this.payer) continue;
        const cost =
          BigInt(tx.meta.preBalances[0]) -
          BigInt(tx.meta.postBalances[0]) -
          BigInt(tx.meta.fee);
        total += cost > 0n ? cost : 0n;
      }
      // Replace the entire window only after every page and body succeeded. A reservation is
      // settled by this count only when it is listed or its blockhash expired before slot S.
      const listed = new Set(rows.map((x) => x.signature));
      for (const [sig, x] of this.reservations)
        if (listed.has(sig) || x.height < h) this.reservations.delete(sig);
      this.used = total;
      this.ready = true;
    } catch {
      this.ready = false;
    } finally {
      this.busy = false;
    }
  }
}

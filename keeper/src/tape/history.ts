import { address } from "@solana/kit";
import * as s from "../../../program/client/index.js";
import { decodeDevFeedEvents } from "../common/feed.js";
import { Store } from "../common/sqlite.js";
import { json } from "../common/env.js";
import { RpcPool } from "../common/rpc.js";
import { errorName } from "../keeper/sender.js";
import { log } from "../common/log.js";
export function transactionKeys(tx: any): string[] {
  return [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ].map((k) => (typeof k === "string" ? k : k.pubkey));
}
export function transactionEvents(tx: any) {
  if (!tx?.meta || tx.meta.err !== null) return [];
  const keys = transactionKeys(tx),
    out: any[] = [];
  for (const group of tx.meta.innerInstructions ?? [])
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== s.SPAN_PROGRAM_ADDRESS) continue;
      const resolved = {
        programAddress: address(keys[ix.programIdIndex]),
        data: ix.data,
      };
      const dev = decodeDevFeedEvents([resolved]);
      out.push(...(dev.length ? dev : s.decodeEvents([resolved])));
    }
  return out;
}
export const clean = (value: any): any => {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value.__option)
    return value.__option === "Some" ? clean(value.value) : null;
  if (Array.isArray(value)) return value.map(clean);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== "discriminator")
      .map(([k, v]) => [k, clean(v)]),
  );
};
export class History {
  private busy = false;
  listedAt = 0;
  private recentCache: any[] | undefined;
  constructor(
    readonly store: Store,
    readonly rpc: RpcPool,
    readonly feedSample: (sig: string, v: any, slot: number) => void,
    readonly onGap: () => void = () => {},
  ) {}
  ingest(sig: string, tx: any) {
    const events = transactionEvents(tx);
    this.recentCache = undefined;
    this.store.db.exec("BEGIN");
    try {
      this.store.db
        .prepare("INSERT OR IGNORE INTO transactions VALUES(?,?,?,?,?)")
        .run(sig, tx.slot, tx.blockTime, Date.now(), json(tx));
      events.forEach((event, i) => {
        const data = clean(event.data);
        if (event.name === "Settled")
          data.outcome = ["Paid", "Void", "Unsold"][data.outcome];
        if (event.name === "Marked") data.side = ["High", "Low"][data.side];
        this.store.db
          .prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)")
          .run(sig, i, event.name, tx.slot, tx.blockTime, json(data));
        if (event.name === "DevFeedUpdated")
          this.feedSample(sig, event.data, tx.slot);
      });
      this.store.set("program-cursor", sig);
      this.store.set("program-slot", String(tx.slot));
      this.store.set("history-block-time", String(tx.blockTime ?? 0));
      this.store.db.exec("COMMIT");
      this.store.change();
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const last = this.store.get("program-cursor"),
        rows: any[] = [];
      let before: string | undefined;
      for (;;) {
        const batch: any[] = await this.rpc.call(
          "getSignaturesForAddress",
          [
            s.SPAN_PROGRAM_ADDRESS,
            {
              commitment: "confirmed",
              limit: 1000,
              ...(last ? { until: last } : {}),
              ...(before ? { before } : {}),
            },
          ],
          "normal",
          "history-list",
        );
        rows.push(...batch);
        if (batch.length < 1000) break;
        const next = batch.at(-1).signature;
        if (next === before) throw Error("History pagination incomplete");
        before = next;
      }
      this.listedAt = Date.now();
      for (const row of rows.reverse()) {
        if (
          this.store.db
            .prepare("SELECT 1 FROM transactions WHERE sig=?")
            .get(row.signature)
        )
          continue;
        const tx = await this.rpc.call(
          "getTransaction",
          [
            row.signature,
            {
              encoding: "json",
              commitment: "confirmed",
              maxSupportedTransactionVersion: 1,
            },
          ],
          "normal",
          "history-body",
        );
        if (!tx) throw Error("Transaction unavailable");
        this.ingest(row.signature, tx);
        // Keep backfill below provider limits while state and chain lanes remain independent.
        await new Promise((r) => setTimeout(r, 110));
      }
    } catch (error) {
      this.onGap();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  events(name: string) {
    return (
      this.store.db
        .prepare("SELECT * FROM events WHERE name=? ORDER BY slot,idx")
        .all(name) as any[]
    ).map((x) => ({
      ...JSON.parse(x.raw),
      sig: x.sig,
      slot: String(x.slot),
      blockTime: x.block_time === null ? null : String(x.block_time),
    }));
  }
  recent() {
    if (this.recentCache) return this.recentCache;
    const out: any[] = [];
    for (const row of this.store.db
      .prepare("SELECT * FROM transactions ORDER BY slot DESC,received_ms DESC")
      .iterate() as Iterable<any>) {
      const tx = JSON.parse(row.raw),
        events = this.store.db
          .prepare("SELECT name FROM events WHERE sig=? ORDER BY idx")
          .all(row.sig) as any[];
      if (events.some((x) => x.name === "DevFeedUpdated")) continue;
      // Failed development writes have no events, so also inspect their instruction discriminator.
      const keys = transactionKeys(tx);
      if (
        tx.transaction.message.instructions.some(
          (ix: any) =>
            keys[ix.programIdIndex] === s.SPAN_PROGRAM_ADDRESS &&
            /Instruction: DevFeed/.test((tx.meta.logMessages ?? []).join("\n")),
        )
      )
        continue;
      const names = events.map((x) => x.name);
      out.push({
        sig: row.sig,
        slot: String(row.slot),
        blockTime: row.block_time === null ? null : String(row.block_time),
        signer: keys[0],
        err: tx.meta.err ? errorName(tx.meta.err) : null,
        events: names,
      });
      if (out.length === 100) break;
    }
    this.recentCache = out;
    return out;
  }
}

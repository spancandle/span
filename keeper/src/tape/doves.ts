import type { Store } from "../common/sqlite.js";
import type { RpcPool } from "../common/rpc.js";
import { SOL_FEED } from "../../../program/client/constants.js";
import { decodeDovesTransaction } from "./doves-tx.js";
export class DovesRecorder {
  private busy = false;
  recording = false;
  lastPublishTs = 0;
  lastSlot = 0;
  constructor(
    readonly store: Store,
    readonly rpc: RpcPool,
  ) {
    const last = store.db
      .prepare(
        "SELECT publish_ts,slot FROM doves ORDER BY publish_ts DESC,slot DESC LIMIT 1",
      )
      .get() as any;
    this.lastPublishTs = last?.publish_ts ?? 0;
    this.lastSlot = last?.slot ?? 0;
    if (last) this.gap("process-start");
  }
  gap(reason: string) {
    if (
      !this.store.db
        .prepare("SELECT 1 FROM gaps WHERE b IS NULL AND reason=?")
        .get(reason)
    ) {
      this.store.db
        .prepare("INSERT INTO gaps(a,b,reason) VALUES(?,NULL,?)")
        .run(this.lastPublishTs, reason);
      this.store.change();
    }
  }
  sample(
    sig: string,
    price: bigint | string,
    publishTs: bigint | number,
    slot: number,
  ) {
    const ts = Number(publishTs);
    const x = this.store.db
      .prepare("INSERT OR IGNORE INTO doves VALUES(?,?,?,?,?)")
      .run(sig, ts, String(price), slot, Date.now());
    if (x.changes) this.store.change();
    if (ts >= this.lastPublishTs) {
      this.lastPublishTs = ts;
      this.lastSlot = slot;
    }
  }
  startRecording(now: number) {
    if (this.recording) return;
    this.recording = true;
    this.gap("recording-start");
    this.store.db
      .prepare("INSERT INTO coverage(start_ts,end_ts) VALUES(?,?)")
      .run(now, now);
    this.store.change();
  }
  stopRecording() {
    if (this.recording && this.rpc.cluster === "mainnet")
      this.store.db.prepare("DELETE FROM kv WHERE key='doves-cursor'").run();
    this.recording = false;
  }
  closeGaps() {
    if (this.lastPublishTs) {
      const coverage = this.rpc.cluster === "devnet"
        ? this.store.db.prepare("SELECT start_ts FROM coverage ORDER BY id DESC LIMIT 1").get() as { start_ts: number } | undefined
        : undefined;
      let changes = 0;
      if (coverage) {
        const first = this.store.db
          .prepare("SELECT publish_ts FROM doves WHERE publish_ts>=? ORDER BY publish_ts LIMIT 1")
          .get(coverage.start_ts) as { publish_ts: number } | undefined;
        // Old-window backfill cannot establish that the new window resumed.
        if (first)
          changes += Number(this.store.db
            .prepare("UPDATE gaps SET b=? WHERE b IS NULL AND a<?")
            .run(first.publish_ts, coverage.start_ts).changes);
        changes += Number(this.store.db
          .prepare("UPDATE gaps SET b=? WHERE b IS NULL AND a>=? AND a<?")
          .run(this.lastPublishTs, coverage.start_ts, this.lastPublishTs).changes);
      } else {
        changes = Number(this.store.db
          .prepare("UPDATE gaps SET b=? WHERE b IS NULL AND a<?")
          .run(this.lastPublishTs, this.lastPublishTs).changes);
      }
      if (changes) this.store.change();
    }
  }
  async poll(now = Math.floor(Date.now() / 1000)) {
    if (!this.recording || this.busy || this.rpc.cluster !== "mainnet") return;
    this.busy = true;
    try {
      const last = this.store.get("doves-cursor"),
        rows: any[] = [];
      let before: string | undefined;
      for (;;) {
        const batch: any[] = await this.rpc.call(
          "getSignaturesForAddress",
          [
            SOL_FEED,
            {
              commitment: "confirmed",
              limit: 1000,
              ...(last ? { until: last } : {}),
              ...(before ? { before } : {}),
            },
          ],
          "normal",
          "doves-list",
        );
        rows.push(...batch);
        if (batch.length < 1000 || !last) break;
        const next = batch.at(-1).signature;
        if (next === before) throw Error("Oracle pagination incomplete");
        before = next;
      }
      const relevant = last
        ? rows
        : rows.filter((x) => x.blockTime !== null && x.blockTime >= now - 15);
      const head = rows[0];
      for (const row of [...relevant].reverse()) {
        if (row.err !== null) continue;
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
          "doves-body",
        );
        if (!tx) throw Error("Oracle transaction unavailable");
        for (const v of decodeDovesTransaction(tx))
          this.sample(row.signature, v.price, v.publish_ts, v.slot);
        await new Promise((r) => setTimeout(r, 80));
      }
      if (head) this.store.set("doves-cursor", head.signature);
      this.closeGaps();
      this.cover(now);
    } catch {
      this.gap("listing-or-decode");
    } finally {
      this.busy = false;
    }
  }
  cover(now: number) {
    this.store.db
      .prepare(
        "UPDATE coverage SET end_ts=? WHERE id=(SELECT MAX(id) FROM coverage)",
      )
      .run(now);
  }
  prune(now: number) {
    this.store.db
      .prepare("DELETE FROM doves WHERE publish_ts<?")
      .run(now - 8 * 86400);
  }
}

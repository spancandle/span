import { SPAN_PROGRAM_ADDRESS } from "../../../program/client/index.js";
import type { Store } from "../common/sqlite.js";
import type { Chain } from "../keeper/chain.js";
import type { History } from "./history.js";
import type { DovesRecorder } from "./doves.js";
import { readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { atomicFile, atomicText } from "./http.js";
import { liveDocuments, markLog, candleReads } from "./state.js";
import { json } from "../common/env.js";
import { log, safeError } from "../common/log.js";
import { getCandleDecoder } from "../../../program/client/index.js";
export const delta = (xs: (string | number | bigint)[]) =>
  xs.map((x, i) => String(i ? BigInt(x) - BigInt(xs[i - 1]) : x)).join(",");
const sha1 = (x: string) => createHash("sha1").update(x).digest("hex");
const RETAIN = 8 * 86400;
export class Publisher {
  private liveAt = 0;
  private content = "";
  private historyAt = 0;
  private historyRevision = -1;
  // Receipt candles of the last history.json, and per t0 the hash of the
  // candle path body stored and of the bytes written by this process.
  private pathTs: string[] = [];
  private bodies = new Map<string, string>();
  private written = new Map<string, string>();
  // Oracle rows below this publish time may already be deleted.
  private prunedBefore = 0;
  constructor(
    readonly store: Store,
    readonly chain: Chain,
    readonly history: History,
    readonly recorder: DovesRecorder,
    readonly dir: string,
    readonly spanDecimals: (mint: string) => number | null = () => null,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS candle_path(t0 TEXT PRIMARY KEY,raw TEXT NOT NULL)",
    );
  }
  prune(now: number) {
    this.recorder.prune(now);
    this.prunedBefore = Math.max(this.prunedBefore, now - RETAIN);
  }
  values(a: number, b: number) {
    return this.store.db
      .prepare(
        "SELECT * FROM doves WHERE publish_ts>=? AND publish_ts<=? ORDER BY slot,publish_ts",
      )
      .all(a, b) as any[];
  }
  gaps() {
    return this.store.db
      .prepare("SELECT a,b,reason FROM gaps ORDER BY a")
      .all() as { a: number; b: number | null; reason: string }[];
  }
  doves(a: number, b: number) {
    const coverage = this.store.db
      .prepare("SELECT 1 FROM coverage WHERE start_ts<=? AND end_ts>=?")
      .get(b, a);
    if (!coverage) return null;
    const rows = this.values(a, b),
      prices = rows.map((x) => BigInt(x.price));
    const missing = this.gaps().some(
      (x) => x.a < b && (x.b === null || x.b > a),
    );
    return {
      high: prices.length
        ? String(prices.reduce((a, b) => (a > b ? a : b)))
        : null,
      low: prices.length
        ? String(prices.reduce((a, b) => (a < b ? a : b)))
        : null,
      complete: rows.length > 0 && !missing,
    };
  }
  feedDocument() {
    const now = Number(this.chain.now()),
      open = [...this.chain.candles.values()]
        .map((x) => Number(x.value.t0))
        .filter((t) => t <= now && now < t + 3600),
      from = open.length ? Math.min(...open) : now,
      rows = open.length ? this.values(from, now) : [];
    return {
      v: 1,
      generated: Date.now(),
      feed: this.chain.config!.feed,
      from: String(from),
      ts: delta(rows.map((x) => x.publish_ts - from)),
      p: delta(rows.map((x) => x.price)),
      slots: delta(rows.map((x) => x.slot)),
      gaps: this.gaps()
        .filter((g) => g.a <= now && (g.b === null || g.b >= from))
        .map((g) => ({
          a: String(g.a),
          b: g.b === null ? null : String(g.b),
          reason: g.reason,
        })),
      candles: open.map((t0) => {
        const rows = this.values(t0, Math.min(now, t0 + 3600)),
          last = rows.at(-1),
          d = this.doves(t0, Math.min(now, t0 + 3600));
        return {
          t0: String(t0),
          high: d?.high ?? null,
          low: d?.low ?? null,
          last: last
            ? { price: last.price, publishTs: String(last.publish_ts) }
            : null,
          complete: d?.complete ?? false,
        };
      }),
    };
  }
  historyDocument() {
    const receipts = this.history
        .events("Settled")
        .reverse()
        .slice(0, 500)
        .map((x) => ({ ...x, markLog: markLog(this.history, x.ticket) })),
      withdrawals = this.history.events("Withdrawn").reverse().slice(0, 500),
      ts = [...new Set(receipts.map((x) => x.t0))]
        .sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1))
        .slice(0, 200);
    this.pathTs = ts;
    const reads = this.history.events("Read");
    const candles = ts.map((t0) => {
      const c = [...this.chain.candles.values()].find(
        (x) => String(x.value.t0) === t0,
      )?.value;
      const old = this.store.db
        .prepare("SELECT raw FROM candle_history WHERE t0=?")
        .get(t0) as any;
      const archived = old ? JSON.parse(old.raw) : undefined;
      const events = reads.filter((x) => x.t0 === t0),
        slots = Array.from({ length: 13 }, (_, j) => {
          const e = events.find((x) => x.j === j);
          return e
            ? {
                price: e.price,
                publishTs: e.publishTs,
                slot: e.slot,
                sig: e.sig,
              }
            : null;
        });
      const prices = slots
        .filter((x) => x !== null)
        .map((x) => BigInt(x.price));
      const d =
        // Oracle rows go from the start of the hour first: once any may be
        // pruned, the record stored while it was whole is the one to keep.
        Number(t0) < Number(this.chain.now()) - 8 * 86400
          ? (archived?.doves ?? null)
          : (this.doves(Number(t0), Number(t0) + 3600) ??
            archived?.doves ??
            null);
      const value = {
        t0,
        reads: c ? candleReads(c, reads) : slots,
        readHigh: c
          ? String(c.readHigh)
          : String(
              prices.length ? prices.reduce((a, b) => (a > b ? a : b)) : 0,
            ),
        readLow: c
          ? String(c.readLow)
          : String(
              prices.length ? prices.reduce((a, b) => (a < b ? a : b)) : 0,
            ),
        doves: d,
      };
      this.store.db
        .prepare("INSERT OR REPLACE INTO candle_history VALUES(?,?)")
        .run(t0, json(value));
      return value;
    });
    return { v: 1, generated: Date.now(), receipts, withdrawals, candles };
  }
  candlePathBody(t0: number) {
    const rows = this.values(t0, t0 + 3600),
      gaps = this.gaps().filter(
        (g) => g.a < t0 + 3600 && (g.b === null || g.b > t0),
      );
    return {
      feed: this.chain.config!.feed,
      t0: String(t0),
      from: String(t0),
      ts: delta(rows.map((x) => x.publish_ts - t0)),
      p: delta(rows.map((x) => x.price)),
      slots: delta(rows.map((x) => x.slot)),
      gaps: gaps.map((g) => ({
        a: String(g.a),
        b: g.b === null ? null : String(g.b),
        reason: g.reason,
      })),
      complete: rows.length > 0 && !gaps.length,
    };
  }
  // Returns false while the path may still become available.
  private candlePath(t0: string, now: number) {
    const t = Number(t0);
    if (now < t + 3600 + 120) return false;
    const stored = this.store.db
      .prepare("SELECT raw FROM candle_path WHERE t0=?")
      .get(t0) as { raw: string } | undefined;
    let raw = stored?.raw;
    if (t >= now - RETAIN && t >= this.prunedBefore) {
      if (
        !this.chain.config ||
        !this.store.db
          .prepare(
            "SELECT 1 FROM doves WHERE publish_ts>=? AND publish_ts<=? LIMIT 1",
          )
          .get(t, t + 3600)
      )
        return false;
      const body = this.candlePathBody(t),
        key = sha1(json(body));
      let old = this.bodies.get(t0);
      if (old === undefined && raw !== undefined) {
        const { v, generated, ...rest } = JSON.parse(raw);
        old = sha1(json(rest));
      }
      if (raw === undefined || old !== key) {
        raw = json({ v: 1, generated: Date.now(), ...body });
        this.store.db
          .prepare("INSERT OR REPLACE INTO candle_path VALUES(?,?)")
          .run(t0, raw);
      }
      this.bodies.set(t0, key);
    }
    // Past retention the stored path is served unchanged; without one there
    // is nothing left to build it from.
    if (raw === undefined) return true;
    const bytes = raw + "\n",
      hash = sha1(bytes);
    if (this.written.get(t0) !== hash) {
      atomicText(resolve(this.dir, "candles"), `${t0}.json`, bytes);
      this.written.set(t0, hash);
    }
    return true;
  }
  candlePaths(all: boolean) {
    const now = Number(this.chain.now()),
      keep = new Set(this.pathTs);
    for (const t0 of this.pathTs) {
      if (!all && this.written.has(t0)) continue;
      try {
        if (this.candlePath(t0, now) && !this.written.has(t0))
          this.written.set(t0, "");
      } catch (e) {
        this.written.delete(t0);
        log({ event: "candle-path-error", t0, error: safeError(e) });
      }
    }
    if (!all) return;
    for (const t0 of [...this.written.keys()])
      if (!keep.has(t0)) {
        this.written.delete(t0);
        this.bodies.delete(t0);
      }
    let names: string[] = [];
    try {
      names = readdirSync(resolve(this.dir, "candles"));
    } catch {}
    for (const name of names) {
      const m = /^([0-9]{1,12})\.json$/.exec(name);
      if (m && !keep.has(m[1]))
        try {
          unlinkSync(resolve(this.dir, "candles", name));
        } catch (e) {
          log({ event: "candle-path-error", t0: m[1], error: safeError(e) });
        }
    }
  }
  status(http: any, keepers: any[] = []) {
    const now = Date.now(),
      recent = this.store.db
        .prepare("SELECT raw FROM transactions WHERE block_time>=?")
        .all(Math.floor(now / 1000) - 3600) as any[],
      events = this.store.db
        .prepare(
          "SELECT name,COUNT(*) n FROM events WHERE block_time>=? GROUP BY name",
        )
        .all(Math.floor(now / 1000) - 3600) as any[],
      counts = Object.fromEntries(events.map((x) => [x.name, x.n]));
    let unmatched = 0;
    for (const row of this.store.db
      .prepare(
        "SELECT raw FROM events WHERE name IN ('Read','Marked') AND block_time>=?",
      )
      .all(Math.floor(now / 1000) - 3600) as any[]) {
      const e = JSON.parse(row.raw);
      if (
        !this.gaps().some(
          (g) =>
            g.a < Number(e.publishTs) &&
            (g.b === null || g.b > Number(e.publishTs)),
        ) &&
        !this.store.db
          .prepare("SELECT 1 FROM doves WHERE publish_ts=? AND price=?")
          .get(Number(e.publishTs), e.price)
      )
        unmatched++;
    }
    return {
      v: 1,
      generated: now,
      cluster: this.chain.rpc.cluster,
      program: SPAN_PROGRAM_ADDRESS,
      state: {
        lastFullMs: this.chain.lastFullMs,
        lastSlot: String(this.chain.slot),
      },
      history: {
        lastSig: this.store.get("program-cursor") ?? null,
        lastSlot: this.store.get("program-slot") ?? null,
        lagSecs: Math.max(
          0,
          Number(this.chain.now()) -
            Number(this.store.get("history-block-time") ?? 0),
        ),
      },
      feed: {
        recording: this.recorder.recording,
        lastPublishTs: String(this.recorder.lastPublishTs),
        lastSlot: String(this.recorder.lastSlot),
        lagSecs: Math.max(
          0,
          Number(this.chain.now()) - this.recorder.lastPublishTs,
        ),
        openGaps: this.gaps().filter((g) => g.b === null).length,
        unmatchedEvents: unmatched,
      },
      counts1h: {
        txs: recent.length,
        failed: recent.filter((x) => JSON.parse(x.raw).meta.err).length,
        reads: counts.Read ?? 0,
        marks: counts.Marked ?? 0,
        settles: counts.Settled ?? 0,
      },
      rpc1h: this.chain.rpc.metrics?.snapshot().endpoints ?? {},
      http,
      creationBudget: {
        keepers,
        waiting: keepers.reduce((n, x) => n + Number(x.waiting), 0),
      },
    };
  }
  publish(now = Date.now()) {
    if (this.chain.config && now - this.chain.lastReadMs <= 12000) {
      const docs = liveDocuments(this.chain, this.history, this.spanDecimals),
        content = json({
          ...docs,
          state: { ...docs.state, generated: 0 },
          tickets: { ...docs.tickets, generated: 0 },
        });
      if (
        now - this.liveAt >= 250 &&
        (content !== this.content || now - this.liveAt >= 1000)
      ) {
        atomicFile(this.dir, "state.json", docs.state);
        atomicFile(this.dir, "tickets.json", docs.tickets);
        this.content = content;
        this.liveAt = now;
      }
    }
    if (this.chain.config)
      atomicFile(this.dir, "feed.json", this.feedDocument());
    const all =
      this.store.revision !== this.historyRevision &&
      now - this.historyAt >= 2000;
    if (all) {
      atomicFile(this.dir, "history.json", this.historyDocument());
      this.historyAt = now;
      this.historyRevision = this.store.revision;
    }
    this.candlePaths(all);
  }
}

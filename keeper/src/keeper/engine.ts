import { unwrapOption, type Address } from "@solana/kit";
import {
  boundary,
  settleAfter,
  markAccepts,
  TicketState,
  type Candle,
  type Ticket,
} from "../../../program/client/index.js";
import type { Chain } from "./chain.js";
import type { FeedValue } from "../common/feed.js";
import type { Action, Prepared } from "./sender.js";
import type { CreationBudget } from "./budget.js";
import { log, type Logger } from "../common/log.js";
export type EnginePort = {
  blockhash: () => string | undefined;
  price: (action: Action) => bigint;
  prepare: (a: Action, price: bigint) => Promise<Prepared>;
  send: (p: Prepared, v?: FeedValue) => void;
  cancel: (key: string) => void;
};
/** Deterministic decisions over observed state; preparation performs all non-send work. */
export class Engine {
  readonly pending = new Map<string, Prepared>();
  readonly prepared = new Map<string, Prepared>();
  readonly abandoned = new Set<string>();
  readonly seen = new Map<string, FeedValue[]>();
  readonly endedMarks = new Set<string>();
  private preparing = new Set<string>();
  private maximum = new Map<string, bigint>();
  private marked = new Map<string, string>();
  private next = new Map<string, number>();
  private marks = new Map<string, number>();
  private reads = new Set<string>();
  private closed = false;
  private opening = new Set<string>();
  private releaseHours: ReadonlySet<bigint>;
  private decisions = new Map<string, string>();
  constructor(
    readonly chain: Pick<
      Chain,
      "candles" | "tickets" | "config" | "feed" | "now"
    >,
    readonly keeper: Address,
    readonly port: EnginePort,
    readonly budget: Pick<CreationBudget, "available" | "reserve" | "waiting">,
    readonly logger: Logger = log,
    releaseHours: readonly bigint[] = [],
  ) { this.releaseHours = new Set(releaseHours); }
  private canOpen(t0: bigint) {
    const now = this.chain.now();
    return this.chain.config !== undefined &&
      ![...this.chain.candles.values()].some((x) => x.value.t0 === t0) &&
      now >= t0 - 86400n &&
      now < t0 - BigInt(this.chain.config.buyCutoff) - 30n;
  }
  private actions(): Action[] {
    const now = this.chain.now(),
      out: Action[] = [];
    for (const t0 of this.releaseHours) {
      const key = `open:${t0}`;
      if (this.canOpen(t0) && !this.abandoned.has(key)) {
        out.push({ key, kind: "open", t0 });
      } else {
        if (this.opening.has(key) &&
            [...this.chain.candles.values()].some((x) => x.value.t0 === t0)) {
          this.opening.delete(key);
          this.logger({ event: "recorded", kind: "open", t0 });
        }
        if (this.pending.has(key) || this.prepared.has(key) || this.budget.waiting.has(key))
          this.complete(key);
      }
    }
    for (const [key, { value: c }] of this.chain.candles) {
      if (!this.releaseHours.has(c.t0) &&
          ![...this.chain.tickets.values()].some((x) => x.value.t0 === c.t0))
        continue;
      for (let j = 0; j < 13; j++) {
        const k = `read:${key}:${j}`,
          b = boundary(c.t0, j);
        if (c.reads[j].price > 0n) {
          if (!this.reads.has(k)) {
            this.reads.add(k);
            this.logger({
              event: "recorded",
              kind: "read",
              key: k,
              t0: c.t0,
              j,
              price: c.reads[j].price,
              publishTs: c.reads[j].publishTs,
            });
          }
          this.complete(k);
          continue;
        }
        if (j > 0 && c.reads[0].price === 0n) continue;
        if (this.abandoned.has(k)) continue;
        if (
          (this.chain.feed &&
            this.chain.feed.publishTs > b + BigInt(c.readWindow)) ||
          now > b + BigInt(c.readWindow + c.ageLimit + 2)
        ) {
          this.abandoned.add(k);
          this.complete(k);
          const values = this.seen.get(k) ?? [];
          this.logger({
            event: "missed-read",
            key: k,
            t0: c.t0,
            j,
            b,
            cause: values.length ? "keeper" : "doves",
            values,
          });
          continue;
        }
        if (now >= b - 10n)
          out.push({
            key: k,
            kind: "read",
            t0: c.t0,
            j,
            end: b + BigInt(c.readWindow + c.ageLimit + 2),
          });
      }
    }
    for (const [key, { value: t }] of this.chain.tickets) {
      const c = [...this.chain.candles.values()].find(
        (x) => x.value.t0 === t.t0,
      )?.value;
      if (!c) continue;
      const old = this.marks.get(key);
      this.marks.set(key, t.marks);
      if (old !== undefined && t.marks !== old) {
        this.complete(`mark:${key}`);
        this.logger({
          event: "recorded",
          kind: "mark",
          ticket: key,
          t0: t.t0,
          marks: t.marks,
          tailHigh: t.tailHigh,
          tailLow: t.tailLow,
        });
      }
      if (now >= settleAfter(c) - 30n) {
        out.push({
          key: `settle:${key}`,
          kind: "settle",
          ticket: key,
          t0: t.t0,
        });
      }
      if (
        t.state === TicketState.Sold &&
        t.spanLoaded > 0n &&
        t.marker === this.keeper &&
        this.chain.config &&
        unwrapOption(this.chain.config.spanMint) &&
        c.reads[0].price > 0n &&
        t.spanLoaded - t.burned >= this.chain.config.burnPerMark &&
        !this.endedMarks.has(key)
      )
        out.push({
          key: `mark:${key}`,
          kind: "mark",
          ticket: key,
          t0: t.t0,
          end: c.t0 + 3600n + BigInt(c.ageLimit) + 2n,
        });
    }
    for (const [k, p] of this.pending)
      if (
        p.action.ticket &&
        !this.chain.tickets.has(p.action.ticket as Address)
      )
        this.complete(k);
    for (const key of this.budget.waiting)
      if (
        key.startsWith("settle:") &&
        !this.chain.tickets.has(key.slice("settle:".length) as Address)
      )
        this.complete(key);
    return out;
  }
  private complete(key: string) {
    this.pending.delete(key);
    this.port.cancel(key);
    this.prepared.delete(key);
    this.budget.waiting.delete(key);
  }
  private candle(a: Action): Candle {
    return [...this.chain.candles.values()].find((x) => x.value.t0 === a.t0)!
      .value;
  }
  private hold(c: Candle, v: FeedValue) {
    for (let j = 0; j < 13; j++) {
      const b = boundary(c.t0, j),
        key = `read:${[...this.chain.candles].find((x) => x[1].value.t0 === c.t0)![0]}:${j}`;
      if (
        c.reads[j].price === 0n &&
        !this.abandoned.has(key) &&
        v.publishTs >= b &&
        v.publishTs <= b + BigInt(c.readWindow) &&
        (j === 0 || c.reads[0].price > 0n)
      )
        return true;
    }
    return false;
  }
  private eligible(a: Action) {
    if (a.kind === "open") return this.canOpen(a.t0) && !this.abandoned.has(a.key);
    const c = this.candle(a),
      v = this.chain.feed;
    if (a.kind === "settle") return this.chain.now() >= settleAfter(c);
    if (!v) return false;
    if (a.kind === "read")
      return (
        v.publishTs >= boundary(c.t0, a.j!) &&
        v.publishTs <= boundary(c.t0, a.j!) + BigInt(c.readWindow)
      );
    const t = this.chain.tickets.get(a.ticket as Address)?.value;
    if (
      !t ||
      v.publishTs <= t.t0 ||
      v.publishTs > t.t0 + 3600n ||
      this.hold(c, v)
    )
      return false;
    const id = `${v.publishTs}:${v.price}`;
    return this.marked.get(a.key) !== id && markAccepts(c, t, v.price).accepted;
  }
  update() {
    if (this.closed) return;
    const actions = this.actions();
    const v = this.chain.feed;
    if (v)
      for (const a of actions) {
        if (a.kind !== "mark") continue;
        const t = this.chain.tickets.get(a.ticket as Address)!.value,
          c = this.candle(a);
        if (
          v.publishTs <= t.t0 ||
          v.publishTs > t.t0 + 3600n ||
          !markAccepts(c, t, v.price).accepted
        )
          continue;
        const reason = this.hold(c, v)
          ? "read-pending"
          : this.pending.has(a.key)
            ? "mark-pending"
            : "ready";
        const id = `${v.publishTs}:${v.price}:${reason}`;
        if (this.decisions.get(a.key) !== id) {
          this.decisions.set(a.key, id);
          this.logger({
            event: "mark-decision",
            burns: (markAccepts(c, t, v.price) as {burns: boolean}).burns,
            ticket: a.ticket,
            t0: a.t0,
            reason,
            trigger: v,
          });
        }
      }
    for (const a of actions) {
      if (a.kind === "read" && this.chain.feed) {
        const b = boundary(a.t0, a.j!),
          v = this.chain.feed,
          c = this.candle(a);
        if (v.publishTs >= b && v.publishTs <= b + BigInt(c.readWindow)) {
          const rows = this.seen.get(a.key) ?? [];
          if (
            !rows.some(
              (x) => x.publishTs === v.publishTs && x.price === v.price,
            )
          )
            rows.push(v);
          this.seen.set(a.key, rows);
        }
      }
      if (this.pending.has(a.key) || (this.next.get(a.key) ?? 0) > Date.now())
        continue;
      const p = this.prepared.get(a.key),
        hash = this.port.blockhash();
      if (!p || p.blockhash !== hash) {
        this.warm(a);
        continue;
      }
      if (!this.eligible(a)) continue;
      if (!this.budget.available(p.rent)) {
        this.budget.waiting.add(a.key);
        continue;
      }
      if (!this.budget.reserve(p.signature, p.rent, p.lastValidBlockHeight))
        continue;
      this.budget.waiting.delete(a.key);
      this.pending.set(a.key, p);
      this.prepared.delete(a.key);
      this.maximum.set(`${a.key}:${p.blockhash}`, p.price);
      if (a.kind === "mark" && this.chain.feed)
        this.marked.set(
          a.key,
          `${this.chain.feed.publishTs}:${this.chain.feed.price}`,
        );
      if (a.kind === "open") this.opening.add(a.key);
      this.port.send(p, this.chain.feed);
    }
  }
  warm(a: Action) {
    if (this.preparing.has(a.key) || !this.port.blockhash()) return;
    this.preparing.add(a.key);
    const max = this.maximum.get(`${a.key}:${this.port.blockhash()}`) ?? -1n;
    const selected = this.port.price(a),
      price = selected > max ? selected : max + 1n;
    void this.port
      .prepare(a, price)
      .then((p) => {
        if (!this.closed && (a.kind !== "open" ||
            (this.canOpen(a.t0) && !this.abandoned.has(a.key)))) {
          this.prepared.set(a.key, p);
          this.preparing.delete(a.key);
          this.update();
        }
      })
      .catch(() => {
        this.next.set(a.key, Date.now() + 2000);
      })
      .finally(() => this.preparing.delete(a.key));
  }
  result(p: Prepared, error: string | null, stage: string) {
    if (this.pending.get(p.action.key) !== p) return;
    this.pending.delete(p.action.key);
    this.prepared.delete(p.action.key);
    if (
      p.action.kind === "mark" &&
      ["CapReached", "SpanShort"].includes(error ?? "")
    )
      this.endedMarks.add(p.action.ticket!);
    if (p.action.kind === "read" && error === "ReadFilled") {
      this.abandoned.add(p.action.key);
    }
    if (p.action.kind === "open") {
      if (error === "BuyClosed") this.abandoned.add(p.action.key);
      this.next.set(p.action.key, Date.now() + 2000);
    }
    if (p.action.kind === "settle")
      this.next.set(p.action.key, Date.now() + 2000);
    if (error === "AlreadyProcessed") {
      if (p.action.kind === "mark") this.marked.delete(p.action.key);
      this.update();
    } else if (stage === "signature" && error === null) {
      if (p.action.kind === "mark") {
        const current = this.chain.tickets.get(
          p.action.ticket as Address,
        )?.value;
        if (current?.marks === this.marks.get(p.action.ticket!))
          this.marked.delete(p.action.key);
      }
      this.update();
    }
  }
  close() {
    this.closed = true;
    for (const key of this.pending.keys()) this.complete(key);
  }
}

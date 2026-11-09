import { unwrapOption, type Address } from "@solana/kit";
import {
  boundary,
  settleAfter,
  markAccepts,
  TicketState,
  type Candle,
  type Ticket,
} from "../../../program/client/index.js";
import { assetOf,secsOf,lastReadOf } from "../../../program/client/assets.js";
import { spanHeld, pairedSpanBalance, type Chain } from "./chain.js";
import { readerMarkAccepts, readerOptions, type ReaderOptions } from "./reader-policy.js";
import type { FeedValue } from "../common/feed.js";
import type { Action, Prepared } from "./sender.js";
import type { CreationBudget } from "./budget.js";
import { log, type Logger } from "../common/log.js";
export class BidderAccountUnavailable extends Error {}
type SentMark = Pick<Ticket, "t0" | "marks" | "spanLoaded" | "marker"> & { buyer: Address | null };
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
  private shortMarks = new Map<string, number>();
  private preparing = new Set<string>();
  private maximum = new Map<string, bigint>();
  private marked = new Map<string, string>();
  // Signature acknowledgement can precede account observations, including a free mark.
  private sentMarks = new WeakMap<Prepared, SentMark>();
  private awaitingMarks = new Map<string, SentMark>();
  private next = new Map<string, number>();
  private marks = new Map<string, number>();
  private reads = new Set<string>();
  private closed = false;
  private opening = new Set<string>();
  private releaseHours: ReadonlySet<bigint>;
  private decisions = new Map<string, string>();
  readonly options: ReaderOptions;
  constructor(
    readonly chain: Pick<
      Chain,
      "candles" | "tickets" | "config" | "feed" | "now"
    > & Partial<Pick<Chain, "spanHolds" | "spanRead" | "feeds" | "untils" | "resales" | "bids" | "requests">>,
    readonly keeper: Address,
    readonly port: EnginePort,
    readonly budget: Pick<CreationBudget, "available" | "reserve" | "waiting">,
    readonly logger: Logger = log,
    releaseHours: readonly bigint[] = [],
    options: ReaderOptions = readerOptions(),
  ) {
    this.options = readerOptions(options.mode, options.policy);
    this.releaseHours = new Set(this.options.mode === "full" ? releaseHours : []);
  }
  /** Replaces the hours to open and read without a ticket; an open still waiting for an hour that left is dropped. */
  listHours(t0s: readonly bigint[]) {
    if (this.options.mode === "marks") return;
    const next = new Set(t0s);
    for (const t0 of this.releaseHours)
      if (!next.has(t0)) this.complete(`open:${t0}`);
    this.releaseHours = next;
  }
  private feed(t0: bigint) {
    if(!this.chain.feeds?.size&&!this.chain.feed)return undefined;
    const asset=assetOf(t0);
    return this.chain.feeds?.get(asset) ?? (asset===0?this.chain.feed:undefined);
  }
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
    for (const key of this.awaitingMarks.keys()) this.observationPending(key);
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
      const feed = this.feed(c.t0);
      for (let j = 0; j <= lastReadOf(c.t0); j++) {
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
          (feed &&
            feed.publishTs > b + BigInt(c.readWindow)) ||
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
        if (this.options.mode === "full" && now >= b - 10n)
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
      if (this.options.mode === "full" && now >= settleAfter(c) - 30n) {
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
        (this.options.policy !== "paced-v1" || now <= c.t0 + secsOf(c.t0) + BigInt(c.ageLimit)) &&
        this.chain.config &&
        unwrapOption(this.chain.config.spanMint) &&
        c.reads[0].price > 0n &&
        this.funded(key, t) &&
        !this.endedMarks.has(key)
      )
        out.push({
          key: `mark:${key}`,
          kind: "mark",
          ticket: key,
          t0: t.t0,
          end: c.t0 + secsOf(c.t0) + BigInt(c.ageLimit) + 2n,
        });
    }
    for (const [until, {value}] of this.chain.untils ?? [])
      if (this.options.mode === "full" && !this.chain.tickets.has(value.ticket))
        out.push({key:`closeUntil:${until}`,kind:"closeUntil",until,t0:0n});
    for (const [resale,{value}] of this.chain.resales ?? [])
      if (this.options.mode === "full" && !this.chain.tickets.has(value.ticket))
        out.push({key:`closeResale:${resale}`,kind:"closeResale",resale,t0:0n});
    for (const [bid,{value}] of this.chain.bids ?? [])
      if (this.options.mode === "full" && (!this.chain.tickets.has(value.ticket) || now > value.until + 2n))
        out.push({key:`closeBid:${bid}`,kind:"closeBid",bid,t0:0n});
    for (const [request,{value}] of this.chain.requests ?? [])
      if (this.options.mode === "full" && now > value.until + 2n)
        out.push({key:`closeRequest:${request}`,kind:"closeRequest",request,t0:0n});
    for (const [key,p] of [...this.pending,...this.prepared])
      if (p.action.kind === "closeRequest") {
        const value = this.chain.requests?.get(p.action.request as Address)?.value;
        if (!value || now <= value.until + 2n) this.complete(key);
      }
    for (const [key,p] of [...this.pending,...this.prepared])
      if (p.action.kind === "closeBid") {
        const value = this.chain.bids?.get(p.action.bid as Address)?.value;
        if (!value || (this.chain.tickets.has(value.ticket) && now <= value.until + 2n)) this.complete(key);
      }
    for (const [key,p] of [...this.pending,...this.prepared])
      if (p.action.kind === "closeResale") {
        const value = this.chain.resales?.get(p.action.resale as Address)?.value;
        if (!value || this.chain.tickets.has(value.ticket)) this.complete(key);
      }
    for (const [key,p] of [...this.pending,...this.prepared])
      if (p.action.kind === "closeUntil") {
        const value = this.chain.untils?.get(p.action.until as Address)?.value;
        if (!value || this.chain.tickets.has(value.ticket)) this.complete(key);
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
  private observationPending(key: string) {
    const sent = this.awaitingMarks.get(key);
    if (!sent) return false;
    const live = this.chain.tickets.get(key as Address), t = live?.value,
      c = [...this.chain.candles.values()].find(x => x.value.t0 === sent.t0)?.value;
    if (!t || !c || t.state !== TicketState.Sold || t.marker !== this.keeper ||
        t.marker !== sent.marker || t.t0 !== sent.t0 ||
        (unwrapOption(t.buyer) ?? null) !== sent.buyer || t.spanLoaded === 0n ||
        t.spanLoaded < sent.spanLoaded || this.chain.now() > c.t0 + secsOf(c.t0) + BigInt(c.ageLimit)) {
      this.awaitingMarks.delete(key);
      return false;
    }
    const pair = this.chain.spanHolds?.get(key as Address);
    if (pair?.marks !== undefined && pair.marks > sent.marks && pairedSpanBalance(live!, pair) !== undefined) {
      this.awaitingMarks.delete(key);
      return false;
    }
    return true;
  }
  private markWaiting(a: Action) {
    return a.kind === "mark" && this.observationPending(a.ticket!);
  }
  private funded(key: string, t: Ticket) {
    const held = this.chain.spanHolds?.get(key as Address),
      balance = spanHeld(t, held),
      available = this.options.policy === "paced-v1"
        ? pairedSpanBalance(this.chain.tickets.get(key as Address)!, held)
        : held && held.amount < balance ? held.amount : balance,
      burn = this.chain.config!.burnPerMark,
      short = this.shortMarks.get(key);
    if (available === undefined) {
      if (this.decisions.get(`balance:${key}`) !== "waiting") {
        this.decisions.set(`balance:${key}`, "waiting");
        this.logger({ event: "mark-balance-wait", ticket: key });
      }
      return false;
    }
    if (this.decisions.delete(`balance:${key}`))
      this.logger({ event: "mark-balance-ready", ticket: key });
    if (short !== undefined) {
      if (!held || held.read <= short || available < burn) return false;
      this.shortMarks.delete(key);
      this.marked.delete(`mark:${key}`);
    }
    return available >= burn;
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
    for (let j = 0; j <= lastReadOf(c.t0); j++) {
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
    if (this.markWaiting(a)) return false;
    if (a.kind === "closeRequest") {
      const value=this.chain.requests?.get(a.request as Address)?.value;
      return !!value && this.chain.now() > value.until + 2n;
    }
    if (a.kind === "closeBid") {
      const value=this.chain.bids?.get(a.bid as Address)?.value;
      return !!value && (!this.chain.tickets.has(value.ticket) || this.chain.now() > value.until + 2n);
    }
    if (a.kind === "closeResale") {
      const value=this.chain.resales?.get(a.resale as Address)?.value;
      return !!value && !this.chain.tickets.has(value.ticket);
    }
    if (a.kind === "closeUntil") {
      const value = this.chain.untils?.get(a.until as Address)?.value;
      return !!value && !this.chain.tickets.has(value.ticket);
    }
    if (a.kind === "open") return this.canOpen(a.t0) && !this.abandoned.has(a.key);
    const c = this.candle(a),
      v = this.feed(a.t0);
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
      v.publishTs > t.t0 + secsOf(t.t0) ||
      this.hold(c, v)
    )
      return false;
    const id = `${v.publishTs}:${v.price}`;
    if (this.marked.get(a.key) === id) return false;
    if (this.options.policy === "greedy") return markAccepts(c, t, v.price).accepted;
    const balance = pairedSpanBalance(this.chain.tickets.get(a.ticket as Address)!, this.chain.spanHolds?.get(a.ticket as Address));
    return balance !== undefined && readerMarkAccepts(this.options.policy, c, t, v.price,
      this.chain.now(), balance, this.chain.config!.burnPerMark).accepted;
  }
  update() {
    if (this.closed) return;
    const actions = this.actions();
    for (const a of actions) {
        if (a.kind === "closeResale" || a.kind === "closeBid" || a.kind === "closeRequest") continue;
        if (a.kind === "closeUntil") continue;
        const v=this.feed(a.t0);
        if (a.kind !== "mark" || !v) continue;
        const t = this.chain.tickets.get(a.ticket as Address)!.value,
          c = this.candle(a);
        if (
          v.publishTs <= t.t0 ||
          v.publishTs > t.t0 + secsOf(t.t0) ||
          !markAccepts(c, t, v.price).accepted
        )
          continue;
        const reason = this.markWaiting(a) ? "mark-observation-pending" : this.hold(c, v)
          ? "read-pending"
          : this.pending.has(a.key)
            ? "mark-pending"
            : this.options.policy === "paced-v1" && !this.eligible(a)
              ? "paced-reserve" : "ready";
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
      const v=(a.kind === "closeResale" || a.kind === "closeBid" || a.kind === "closeRequest") ? undefined : a.kind === "closeUntil" ? undefined : this.feed(a.t0);
      if (a.kind === "read" && v) {
        const b = boundary(a.t0, a.j!),
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
      if (this.markWaiting(a) || this.pending.has(a.key) || (this.next.get(a.key) ?? 0) > Date.now())
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
      if (a.kind === "mark" && v)
        this.marked.set(
          a.key,
          `${v.publishTs}:${v.price}`,
        );
      if (a.kind === "open") this.opening.add(a.key);
      if (a.kind === "mark" && this.options.policy === "paced-v1") {
        const t = this.chain.tickets.get(a.ticket as Address)!.value;
        this.sentMarks.set(p, { t0: t.t0, marks: t.marks, spanLoaded: t.spanLoaded,
          marker: t.marker, buyer: unwrapOption(t.buyer) ?? null });
      }
      this.port.send(p, v);
    }
  }
  warm(a: Action) {
    if (this.options.mode === "marks" && a.kind !== "mark")
      throw Error("Marks-only keeper cannot prepare this action");
    if (this.markWaiting(a) || this.preparing.has(a.key) || !this.port.blockhash()) return;
    this.preparing.add(a.key);
    const max = this.maximum.get(`${a.key}:${this.port.blockhash()}`) ?? -1n;
    const selected = this.port.price(a),
      price = selected > max ? selected : max + 1n;
    void this.port
      .prepare(a, price)
      .then((p) => {
        if (!this.closed && !this.markWaiting(a) && (a.kind !== "open" ||
            (this.canOpen(a.t0) && !this.abandoned.has(a.key)))) {
          this.prepared.set(a.key, p);
          this.preparing.delete(a.key);
          this.update();
        }
      })
      .catch((error) => {
        const delay = (a.kind === "closeBid" || a.kind === "closeRequest") && error instanceof BidderAccountUnavailable
          ? 600000 : 2000;
        this.next.set(a.key, Date.now() + delay);
      })
      .finally(() => this.preparing.delete(a.key));
  }
  result(p: Prepared, error: string | null, stage: string) {
    if (this.pending.get(p.action.key) !== p) return;
    this.pending.delete(p.action.key);
    this.prepared.delete(p.action.key);
    if (p.action.kind === "mark" && error === "CapReached")
      this.endedMarks.add(p.action.ticket!);
    if (p.action.kind === "mark" && error === "SpanShort") {
      const key = p.action.ticket!;
      this.shortMarks.set(key, this.chain.spanRead ?? this.chain.spanHolds?.get(key as Address)?.read ?? 0);
    }
    if (p.action.kind === "read" && error === "ReadFilled") {
      this.abandoned.add(p.action.key);
    }
    if (p.action.kind === "open") {
      if (error === "BuyClosed") this.abandoned.add(p.action.key);
      this.next.set(p.action.key, Date.now() + 2000);
    }
    if (p.action.kind === "settle" || p.action.kind === "closeUntil" || (p.action.kind === "closeResale" || p.action.kind === "closeBid" || p.action.kind === "closeRequest"))
      this.next.set(p.action.key, Date.now() + 2000);
    if (error === "AlreadyProcessed") {
      if (p.action.kind === "mark") this.marked.delete(p.action.key);
      this.update();
    } else if (stage === "signature" && error === null) {
      if (p.action.kind === "mark") {
        if (this.options.policy === "paced-v1") {
          const sent = this.sentMarks.get(p);
          if (sent) this.awaitingMarks.set(p.action.ticket!, sent);
          this.marked.delete(p.action.key);
        } else {
          const current = this.chain.tickets.get(
            p.action.ticket as Address,
          )?.value;
          if (current?.marks === this.marks.get(p.action.ticket!))
            this.marked.delete(p.action.key);
        }
      }
      this.update();
    }
  }
  close() {
    this.closed = true;
    for (const key of this.pending.keys()) this.complete(key);
  }
}

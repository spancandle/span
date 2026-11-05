import { assetOf,nameOf,secsOf,lastReadOf } from "../../../program/client/assets.js";
import { SPAN_PROGRAM_ADDRESS } from "../../../program/client/index.js";
import { unwrapOption } from "@solana/kit";
import {
  TicketState,
  settleAfter,
  type Candle,
  type Ticket,
} from "../../../program/client/index.js";
import { spanHeld, type Chain, type SpanHoldRead } from "../keeper/chain.js";
import type { RpcPool } from "../common/rpc.js";
import type { History } from "./history.js";
import {resaleEventsOf,transfersOf} from './transfers.js';
export const legacyStart=(t0:bigint|string|number)=>((BigInt(t0)%60n+60n)%60n)<3n;
// Mint decimals never change, so one successful read is kept for the process.
export class SpanDecimals {
  private mint?: string;
  private value: number | null = null;
  private tried = -Infinity;
  private busy = false;
  constructor(
    readonly rpc: Pick<RpcPool, "call">,
    readonly retryMs = 15000,
  ) {}
  get(mint: string | null) {
    return mint !== null && mint === this.mint ? this.value : null;
  }
  async refresh(mint: string | null, now = Date.now()) {
    if (mint === null || mint === this.mint || this.busy) return;
    if (now - this.tried < this.retryMs) return;
    this.busy = true;
    this.tried = now;
    try {
      const v = await this.rpc.call(
          "getAccountInfo",
          [mint, { encoding: "base64", commitment: "confirmed" }],
          "normal",
          "span-mint",
        ),
        data = Buffer.from(v?.value?.data?.[0] ?? "", "base64");
      // Mint layout: decimals at byte 44, is_initialized at byte 45.
      if (data.length < 82 || data[45] !== 1) throw Error("Mint unavailable");
      this.value = data[44];
      this.mint = mint;
    } finally {
      this.busy = false;
    }
  }
}
export function candleReads(c: Candle, events: any[]) {
  return c.reads.slice(0,lastReadOf(c.t0)+1).map((r, j) => {
    if (r.price === 0n) return null;
    const e = events.find(
      (x) =>
        x.t0 === String(c.t0) &&
        x.j === j &&
        x.price === String(r.price) &&
        x.publishTs === String(r.publishTs),
    );
    return {
      price: String(r.price),
      publishTs: String(r.publishTs),
      slot: e?.slot ?? null,
      sig: e?.sig ?? null,
    };
  });
}
export function markLog(history: History, ticket: string) {
  return history
    .events("Marked")
    .filter((x) => x.ticket === ticket)
    .map(({ side, price, publishTs, slot, sig, burn }) => ({
      burn,
      side,
      price,
      publishTs,
      slot,
      sig,
    }));
}
/** The entry is separate from SPAN marks; its tails are already part of the ticket. */
export function entryOf(history: History, ticket: string) {
  const e = history.events("BoughtRunning").find(x=>x.ticket===ticket);
  return e ? {sig:e.sig,at:e.blockTime,publishTs:e.publishTs,price:e.price,recorded:e.recorded,paid:e.paid} : null;
}
/** Without a holding read, only burns since the last transfer belong to the current load. */
export function tapeSpanHeld(t:Pick<Ticket,'spanLoaded'|'burned'>,held:SpanHoldRead|undefined,transferBurned=0n){
  if(held)return spanHeld(t,held);
  const left=t.spanLoaded-(t.burned-transferBurned);
  return left>0n?left:0n;
}
export function liveDocuments(
  chain: Chain,
  history: History,
  decimals: (mint: string) => number | null = () => null,
  version: 1|2 = 1,
) {
  const now = chain.now(),
    events = history.events("Read"),
    tickets = [...chain.tickets].filter(([,x])=>version===2||legacyStart(x.value.t0)).sort((a, b) =>
      a[1].value.id < b[1].value.id ? -1 : 1,
    ),
    config = chain.config!,
    spanMint = unwrapOption(config.spanMint) ?? null;
  return {
    state: {
      v: version,
      generated: Date.now(),
      cluster: chain.rpc.cluster,
      genesis:
        chain.rpc.cluster === "devnet"
          ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
          : "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      program: SPAN_PROGRAM_ADDRESS,
      slot: String(chain.slot),
      clock: String(now),
      config: {
        admin: config.admin,
        usdcMint: config.usdcMint,
        feed: config.feed,
        readWindow: config.readWindow,
        ageLimit: config.ageLimit,
        buyCutoff: config.buyCutoff,
        spanMint,
        spanDecimals: spanMint === null ? null : decimals(spanMint),
        spanTokenProgram: unwrapOption(config.spanTokenProgram) ?? null,
        burnPerMark: String(config.burnPerMark),
        nextTicketId: String(config.nextTicketId),
      },
      candles: [...chain.candles]
        .filter(([,x])=>version===2||legacyStart(x.value.t0))
        .filter(
          ([, x]) =>
            x.value.t0 >= now - 604800n ||
            tickets.some(([, t]) => t.value.t0 === x.value.t0),
        )
        .sort((a, b) => (a[1].value.t0 < b[1].value.t0 ? -1 : 1))
        .map(([address, { value: c }]) => {
          const ts = tickets.filter(([, t]) => t.value.t0 === c.t0),
            open = ts
              .filter(([, t]) => t.value.state === TicketState.Open)
              .sort((a, b) =>
                a[1].value.premium === b[1].value.premium
                  ? a[1].value.id < b[1].value.id
                    ? -1
                    : 1
                  : a[1].value.premium < b[1].value.premium
                    ? -1
                    : 1,
              ),
            offers = open.filter(([, t], i) => open.findIndex(([, x]) => x.value.strikeBps === t.value.strikeBps) === i).sort((a,b) => a[1].value.strikeBps-b[1].value.strikeBps);
          return {
            address,
            asset: nameOf(assetOf(c.t0)),
            t0: String(c.t0),
            ...(version===2?{secs:Number(secsOf(c.t0))}:{}),
            readWindow: c.readWindow,
            ageLimit: c.ageLimit,
            buyCutoff: c.buyCutoff,
            settleAfter: String(settleAfter(c)),
            reads: candleReads(c, events),
            readHigh: String(c.readHigh),
            readLow: String(c.readLow),
            tickets: {
              open: open.length,
              sold: ts.length - open.length,
              offers: offers.map(([address,{value:t}]) => ({ strikeBps: t.strikeBps, address, id: String(t.id), premium: String(t.premium) })),
            },
          };
        }),
    },
    tickets: {
      v: version,
      generated: Date.now(),
      tickets: tickets.map(([address, { value: t }]) => ({
        address,
        until: (()=>{const u=[...(chain.untils?.values() ?? [])].find(x=>x.value.ticket===address);return u?String(u.value.until):null;})(),
        entry: entryOf(history,address),
        resale: (()=>{const offer=[...(chain.resales?.values()??[])].find(x=>x.value.ticket===address)?.value;return offer?{holder:offer.holder,ask:String(offer.ask),until:String(offer.until)}:null;})(),
        transfers: transfersOf(history,address),
        asset: nameOf(assetOf(t.t0)),
        id: String(t.id),
        t0: String(t.t0),
        seller: t.seller,
        buyer: unwrapOption(t.buyer) ?? null,
        premium: String(t.premium),
        strikeBps: t.strikeBps,
        state: t.state === TicketState.Open ? "Open" : "Sold",
        spanLoaded: String(t.spanLoaded),
        spanHeld: String(tapeSpanHeld(t, chain.spanHolds?.get(address),BigInt(resaleEventsOf(history,address).at(-1)?.burned??0))),
        stepBps: t.stepBps,
        marker: t.marker,
        tailHigh: String(t.tailHigh),
        tailLow: String(t.tailLow),
        marks: t.marks,
        burned: String(t.burned),
        markLog: markLog(history, address),
      })),
    },
  };
}

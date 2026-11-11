import { expect } from "vitest";
import { type LiteSVM } from "litesvm";
import { type Address, type Instruction, unwrapOption } from "@solana/kit";
import * as r from "../client/src/generated/index.js";
import { type DecodedSpanEvent } from "../client/events.js";
import { findVaultPda, findSpanHoldPda, findBandPda } from "../client/pdas.js";
import { payout, highLow } from "../client/math.js";
type Raw = ReturnType<LiteSVM["getAccount"]>;
export async function verifyEvents(
  svm: LiteSVM,
  events: DecodedSpanEvent[],
  own: Instruction[],
  prior: Map<Address, Raw>,
  payer: Address,
  fee: bigint,
) {
  const expectedNames = own.flatMap((ix) => {
    const kind = r.identifySpanInstruction(
      ix as Instruction & { data: Uint8Array },
    );
    if (kind === r.SpanInstruction.OpenCandle) {
      const old = prior.get(ix.accounts![2].address);
      if (old?.exists && old.programAddress === r.SPAN_PROGRAM_ADDRESS)
        return [];
    }
    if (kind === r.SpanInstruction.OpenRunning || kind === r.SpanInstruction.OpenTicket) {
      const band = kind === r.SpanInstruction.OpenRunning ? r.parseOpenRunningInstruction(ix as any).data.bandBps : r.parseOpenTicketInstruction(ix as any).data.bandBps;
      return ["TicketOpened", ...(kind === r.SpanInstruction.OpenRunning ? ["UntilSet"] : []), ...(band === 400 ? [] : ["BandSet"])];
    }
    const names: Record<number, string> = {
      [r.SpanInstruction.Init]: "Initialized",
      [r.SpanInstruction.SetSpan]: "SpanSet",
      [r.SpanInstruction.SetFeed]: "FeedSet",
      [r.SpanInstruction.SetParams]: "ParamsSet",
      [r.SpanInstruction.OpenCandle]: "CandleOpened",
      [r.SpanInstruction.OpenTicket]: "TicketOpened",
      [r.SpanInstruction.Withdraw]: "Withdrawn",
      [r.SpanInstruction.Buy]: "Bought",
      [r.SpanInstruction.LoadSpan]: "SpanLoaded",
      [r.SpanInstruction.SetMarker]: "MarkerSet",
      [r.SpanInstruction.Read]: "Read",
      [r.SpanInstruction.Mark]: "Marked",
      [r.SpanInstruction.Settle]: "Settled",
      [r.SpanInstruction.BuyRunning]: "BoughtRunning",
      [r.SpanInstruction.CloseUntil]: "UntilClosed",
      [r.SpanInstruction.ListResale]: "ResaleListed",
      [r.SpanInstruction.BuyResale]: "Resold",
      [r.SpanInstruction.CloseResale]: "ResaleClosed",
      [r.SpanInstruction.CloseBand]: "BandClosed",
    };
    return [names[kind]];
  });
  expect(events.map((e) => e.name)).toEqual(expectedNames);
  const bytes = (a: Address) => {
    const x = svm.getAccount(a);
    if (!x.exists) throw Error("Missing event account");
    return x.data;
  };
  const old = (a: Address) => {
    const x = prior.get(a);
    if (!x?.exists) throw Error("Missing prior event account");
    return x;
  };
  const bandBps = async (ticket: Address) => {
    const key = (await findBandPda(ticket))[0], live = svm.getAccount(key), snapshot = prior.get(key);
    const raw = live.exists ? live : snapshot;
    return raw?.exists && raw.data.length ? r.getBandDecoder().decode(raw.data).widthBps : 400;
  };
  const tokenAmount = (a: Address) => {
    const x = prior.get(a);
    return x?.exists ? Buffer.from(x.data).readBigUInt64LE(64) : 0n;
  };
  const configAddress = own[0].accounts!.find((a) => {
    const x = svm.getAccount(a.address);
    return (
      x.exists &&
      x.programAddress === r.SPAN_PROGRAM_ADDRESS &&
      x.data.length === 193
    );
  })?.address;
  const config = configAddress
    ? r.getConfigDecoder().decode(bytes(configAddress))
    : null;
  for (const event of events) {
    const d = event.data;
    switch (event.name) {
      case "BandSet": {
        const e = event.data, b = r.getBandDecoder().decode(bytes((await findBandPda(e.ticket))[0])), t = r.getTicketDecoder().decode(bytes(e.ticket));
        expect(e).toEqual({ticket:e.ticket,id:t.id,widthBps:b.widthBps}); expect(b.seller).toBe(t.seller); expect(b.ticket).toBe(e.ticket);
        break;
      }
      case "BandClosed": {
        const e = event.data, b = r.getBandDecoder().decode(old(e.band).data), recipient = svm.getAccount(b.seller);
        expect(e.ticket).toBe(b.ticket); expect(e.band).toBe((await findBandPda(e.ticket))[0]); expect(svm.getAccount(e.band).exists).toBe(false);
        if (!recipient.exists) throw Error("Missing Band rent recipient");
        expect(recipient.lamports - old(b.seller).lamports + (payer === b.seller ? fee : 0n)).toBe(old(e.band).lamports);
        break;
      }
      case "Initialized":
        expect(d).toEqual({
          admin: config!.admin,
          usdcMint: config!.usdcMint,
          feed: config!.feed,
          readWindow: config!.readWindow,
          ageLimit: config!.ageLimit,
          buyCutoff: config!.buyCutoff,
        });
        break;
      case "SpanSet":
        expect(d).toEqual({
          spanMint: unwrapOption(config!.spanMint),
          spanTokenProgram: unwrapOption(config!.spanTokenProgram),
          burnPerMark: config!.burnPerMark,
        });
        break;
      case "FeedSet":
        expect(d).toEqual({
          oldFeed: r.getConfigDecoder().decode(old(configAddress!).data).feed,
          newFeed: config!.feed,
        });
        break;
      case "ParamsSet":
        expect(d).toEqual({
          readWindow: config!.readWindow,
          ageLimit: config!.ageLimit,
          buyCutoff: config!.buyCutoff,
        });
        break;
      case "CandleOpened": {
        const c = r.getCandleDecoder().decode(bytes(event.data.candle));
        expect(d).toEqual({
          candle: event.data.candle,
          t0: c.t0,
          readWindow: c.readWindow,
          ageLimit: c.ageLimit,
          buyCutoff: c.buyCutoff,
        });
        break;
      }
      case "TicketOpened": {
        const t = r.getTicketDecoder().decode(bytes(event.data.ticket));
        expect(d).toEqual({
          ticket: event.data.ticket,
          id: t.id,
          t0: t.t0,
          seller: t.seller,
          premium: t.premium,
          strikeBps: t.strikeBps,
          deposit: 40_000_000n - t.premium,
        });
        break;
      }
      case "Bought": {
        const t = r.getTicketDecoder().decode(bytes(event.data.ticket));
        expect(d).toEqual({
          ticket: event.data.ticket,
          id: t.id,
          t0: t.t0,
          buyer: unwrapOption(t.buyer),
          premium: t.premium,
        });
        break;
      }
      case "UntilSet": {
        const ix = own.find(ix => r.identifySpanInstruction(ix as any) === r.SpanInstruction.OpenRunning)!;
        const a = r.parseOpenRunningInstruction(ix as any).accounts;
        const u = r.getUntilDecoder().decode(bytes(a.until.address));
        const t = r.getTicketDecoder().decode(bytes(event.data.ticket));
        expect(d).toEqual({ ticket: event.data.ticket, id: t.id, t0: t.t0, until: u.until });
        expect(u.ticket).toBe(event.data.ticket); expect(u.seller).toBe(t.seller);
        break;
      }
      case "BoughtRunning": {
        const e = event.data, t = r.getTicketDecoder().decode(bytes(e.ticket));
        const ix = own.find(ix => r.identifySpanInstruction(ix as any) === r.SpanInstruction.BuyRunning)!;
        const a = r.parseBuyRunningInstruction(ix as any).accounts;
        const c = r.getCandleDecoder().decode(bytes(a.candle.address)), p = r.getTicketDecoder().decode(old(e.ticket).data);
        const high = c.readHigh > p.tailHigh ? c.readHigh : p.tailHigh;
        const low = p.tailLow === 0n || c.readLow < p.tailLow ? c.readLow : p.tailLow;
        const recorded = payout(c, { ...p, bandBps: await bandBps(e.ticket), tailHigh: e.price > high ? e.price : p.tailHigh, tailLow: e.price < low ? e.price : p.tailLow });
        expect(d).toEqual({ ticket: e.ticket, id: t.id, t0: t.t0, buyer: unwrapOption(t.buyer), premium: t.premium,
          recorded, paid: recorded + t.premium, price: Buffer.from(bytes(a.feed.address)).readBigUInt64LE(168),
          publishTs: Buffer.from(bytes(a.feed.address)).readBigInt64LE(177), tailHigh: t.tailHigh, tailLow: t.tailLow, slot: svm.getClock().slot });
        expect(Buffer.from(bytes(a.vault.address)).readBigUInt64LE(64) - tokenAmount(a.vault.address)).toBe(e.paid);
        expect(t.marks).toBe(p.marks); expect(t.burned).toBe(p.burned);
        break;
      }
      case "UntilClosed": {
        const e = event.data, u = r.getUntilDecoder().decode(old(e.until).data);
        expect(e.ticket).toBe(u.ticket); expect(svm.getAccount(e.until).exists).toBe(false);
        const a = svm.getAccount(u.seller); const b = old(u.seller);
        if (!a.exists) throw Error("Missing rent recipient");
        let otherRent = 0n;
        for (const x of events) if ((x.name === "Settled" || x.name === "Withdrawn") && x.data.seller === u.seller) {
          const priorTicket = r.getTicketDecoder().decode(old(x.data.ticket).data);
          otherRent += old(x.data.ticket).lamports + old((await findVaultPda(x.data.ticket))[0]).lamports;
          if (priorTicket.spanLoaded > 0n && unwrapOption(priorTicket.buyer) === u.seller)
            otherRent += old((await findSpanHoldPda(x.data.ticket))[0]).lamports;
        }
        expect(a.lamports - b.lamports + (payer === u.seller ? fee : 0n)).toBe(old(e.until).lamports + otherRent);
        break;
      }
      case "ResaleListed": {
        const e = event.data, ix = own.find(ix => r.identifySpanInstruction(ix as any) === r.SpanInstruction.ListResale)!;
        const a = r.parseListResaleInstruction(ix as any).accounts;
        const offer = r.getResaleDecoder().decode(bytes(a.resale.address)), t = r.getTicketDecoder().decode(bytes(e.ticket));
        expect(e).toEqual({ticket:e.ticket,id:t.id,t0:t.t0,holder:offer.holder,ask:offer.ask,until:offer.until});
        expect(offer.ticket).toBe(e.ticket);expect(offer.holder).toBe(unwrapOption(t.buyer));
        break;
      }
      case "Resold": {
        const e = event.data, ix = own.find(ix => r.identifySpanInstruction(ix as any) === r.SpanInstruction.BuyResale)!;
        const a = r.parseBuyResaleInstruction(ix as any).accounts;
        const before = r.getTicketDecoder().decode(old(e.ticket).data), t = r.getTicketDecoder().decode(bytes(e.ticket));
        const c = r.getCandleDecoder().decode(bytes(a.candle.address)), offer = r.getResaleDecoder().decode(old(a.resale.address).data);
        const priced = {...before,bandBps:await bandBps(e.ticket)}, range = highLow(c,priced), recorded = payout(c,priced);
        expect(e).toEqual({ticket:e.ticket,id:before.id,t0:before.t0,from:unwrapOption(before.buyer),to:unwrapOption(t.buyer),ask:offer.ask,recorded,paid:recorded+offer.ask,...range,tailHigh:before.tailHigh,tailLow:before.tailLow,reads:c.reads.reduce((n,x,j)=>x.price?n|(1<<j):n,0),marks:before.marks,burned:before.burned,spanReturned:before.spanLoaded?tokenAmount((await findSpanHoldPda(e.ticket))[0]):0n,slot:svm.getClock().slot});
        expect(Buffer.from(bytes(a.holderUsdc.address)).readBigUInt64LE(64)-tokenAmount(a.holderUsdc.address)).toBe(e.paid);
        expect(svm.getAccount(a.resale.address).exists).toBe(false);
        const oldHold=(await findSpanHoldPda(e.ticket))[0];
        const refund=old(a.resale.address).lamports+(before.spanLoaded?old(oldHold).lamports:0n);
        const holder=svm.getAccount(e.from);if(!holder.exists)throw Error();
        expect(holder.lamports-old(e.from).lamports+(payer===e.from?fee:0n)).toBe(refund);
        for(const key of ['tailHigh','tailLow','marks','burned'] as const)expect(t[key]).toBe(before[key]);
        if(!events.some(e=>e.name==='SpanLoaded'))expect(t).toMatchObject({spanLoaded:0n,stepBps:0,spanBump:0,marker:'11111111111111111111111111111111'});
        break;
      }
      case "ResaleClosed": {
        const e=event.data, offer=r.getResaleDecoder().decode(old(e.resale).data);
        expect(e.ticket).toBe(offer.ticket);expect(e.holder).toBe(offer.holder);expect(svm.getAccount(e.resale).exists).toBe(false);
        let rent:bigint=old(e.resale).lamports;
        for(const x of events){
          if(x.name==='Settled'||x.name==='Withdrawn'){const t=r.getTicketDecoder().decode(old(x.data.ticket).data);
            if(t.seller===offer.holder)rent+=old(x.data.ticket).lamports+old((await findVaultPda(x.data.ticket))[0]).lamports;
            if(t.spanLoaded>0n&&unwrapOption(t.buyer)===offer.holder)rent+=old((await findSpanHoldPda(x.data.ticket))[0]).lamports;
          }
          if(x.name==='UntilClosed'){const u=old(x.data.until);if(r.getUntilDecoder().decode(u.data).seller===offer.holder)rent+=u.lamports;}
        }
        const holder=svm.getAccount(offer.holder);if(!holder.exists)throw Error();
        expect(holder.lamports-old(offer.holder).lamports+(payer===offer.holder?fee:0n)).toBe(rent);
        break;
      }
      case "SpanLoaded": {
        const t = r.getTicketDecoder().decode(bytes(event.data.ticket));
        expect(d).toEqual({
          ticket: event.data.ticket,
          id: t.id,
          buyer: unwrapOption(t.buyer),
          amount: t.spanLoaded,
          stepBps: t.stepBps,
          marker: t.marker,
        });
        break;
      }
      case "MarkerSet": {
        const e = event.data,
          t = r.getTicketDecoder().decode(bytes(e.ticket)),
          p = r.getTicketDecoder().decode(old(e.ticket).data);
        expect(d).toEqual({ ticket: e.ticket, id: t.id, buyer: unwrapOption(t.buyer),
          oldMarker: p.marker, newMarker: t.marker });
        expect(t).toEqual({ ...p, marker: t.marker });
        break;
      }
      case "Read": {
        const e = event.data,
          c = r.getCandleDecoder().decode(bytes(e.candle));
        expect(d).toEqual({
          candle: e.candle,
          t0: c.t0,
          j: e.j,
          price: c.reads[e.j].price,
          publishTs: c.reads[e.j].publishTs,
          slot: svm.getClock().slot,
          readHigh: c.readHigh,
          readLow: c.readLow,
        });
        break;
      }
      case "Marked": {
        const e = event.data,
          t = r.getTicketDecoder().decode(bytes(e.ticket)),
          p = r.getTicketDecoder().decode(old(e.ticket).data),
          hold = (await findSpanHoldPda(e.ticket))[0];
        expect(d).toEqual({
          ticket: e.ticket,
          id: t.id,
          t0: t.t0,
          side: e.side,
          price: e.side === r.Side.High ? t.tailHigh : t.tailLow,
          publishTs: e.publishTs,
          slot: svm.getClock().slot,
          tailHigh: t.tailHigh,
          tailLow: t.tailLow,
          marks: p.marks + 1,
          burned: t.burned,
          burn: t.burned - p.burned,
          spanLeft: tokenAmount(hold) - (t.burned-p.burned),
        });
        expect(e.publishTs).toBe(
          Buffer.from(bytes(r.parseMarkInstruction(own.find(ix =>
            r.identifySpanInstruction(ix as Instruction & {data: Uint8Array}) === r.SpanInstruction.Mark &&
            ix.accounts?.some(a => a.address === e.ticket))! as any).accounts.feed.address)).readBigInt64LE(177),
        );
        expect(e.price).toBe(
          Buffer.from(bytes(r.parseMarkInstruction(own.find(ix =>
            r.identifySpanInstruction(ix as Instruction & {data: Uint8Array}) === r.SpanInstruction.Mark &&
            ix.accounts?.some(a => a.address === e.ticket))! as any).accounts.feed.address)).readBigUInt64LE(168),
        );
        break;
      }
      case "Withdrawn":
      case "Settled": {
        const e = event.data,
          t = r.getTicketDecoder().decode(old(e.ticket).data),
          vault = (await findVaultPda(e.ticket))[0],
          hold = (await findSpanHoldPda(e.ticket))[0];
        const rent = old(e.ticket).lamports + old(vault).lamports,
          spanRent = t.spanLoaded > 0n ? old(hold).lamports : 0n,
          buyer = unwrapOption(t.buyer);
        expect(svm.getAccount(e.ticket).exists).toBe(false);
        expect(svm.getAccount(vault).exists).toBe(false);
        const sellerNow = svm.getAccount(t.seller);
        if (!sellerNow.exists) throw Error();
        expect(sellerNow.lamports - old(t.seller).lamports).toBe(
          rent + events.reduce((n, event) => {
            if (event.name === "ResaleClosed") {const account=old(event.data.resale);return n+(r.getResaleDecoder().decode(account.data).holder===t.seller?account.lamports:0n);}
            if (event.name !== "UntilClosed") return n;
            const account = old(event.data.until);
            return n + (r.getUntilDecoder().decode(account.data).seller === t.seller ? account.lamports : 0n);
          }, 0n) +
            (buyer === t.seller ? spanRent : 0n) -
            (payer === t.seller ? fee : 0n),
        );
        if (buyer && buyer !== t.seller && t.spanLoaded > 0n) {
          const b = svm.getAccount(buyer);
          if (!b.exists) throw Error();
          expect(b.lamports - old(buyer).lamports).toBe(
            spanRent + events.reduce((n,e)=>e.name==='ResaleClosed'&&e.data.holder===buyer?n+old(e.data.resale).lamports:n,0n) - (payer === buyer ? fee : 0n),
          );
        }
        if (event.name === "Withdrawn") {
          expect(event.data).toEqual({
            ticket: e.ticket,
            id: t.id,
            t0: t.t0,
            seller: t.seller,
            returned: tokenAmount(vault),
          });
          break;
        }
        const settled = event.data,
          candleAddress = own.find(
            (ix) =>
              r.identifySpanInstruction(
                ix as Instruction & { data: Uint8Array },
              ) === r.SpanInstruction.Settle,
          )!.accounts![1].address,
          c = r.getCandleDecoder().decode(bytes(candleAddress));
        const outcome =
          t.state === r.TicketState.Open
            ? r.Outcome.Unsold
            : c.reads[0].price === 0n
              ? r.Outcome.Void
              : r.Outcome.Paid;
        const extrema =
            outcome === r.Outcome.Paid ? highLow(c, {...t,bandBps:await bandBps(e.ticket)}) : { high: 0n, low: 0n },
          paid = outcome === r.Outcome.Paid ? payout(c, {...t,bandBps:await bandBps(e.ticket)}) : 0n,
          toBuyer = outcome === r.Outcome.Void ? t.premium : paid;
        expect(settled).toEqual({
          ticket: e.ticket,
          id: t.id,
          t0: t.t0,
          outcome,
          seller: t.seller,
          buyer: t.buyer,
          premium: t.premium,
          strikeBps: t.strikeBps,
          p0: c.reads[0].price,
          readHigh: c.readHigh,
          readLow: c.readLow,
          tailHigh: t.tailHigh,
          tailLow: t.tailLow,
          ...extrema,
          payout: paid,
          toBuyer,
          toSeller: tokenAmount(vault) - toBuyer,
          spanReturned: t.spanLoaded > 0n ? tokenAmount(hold) : 0n,
          burned: t.burned,
          marks: t.marks,
          reads: c.reads.reduce(
            (bits, x, j) => (x.price > 0n ? bits | (1 << j) : bits),
            0,
          ),
        });
        if (t.spanLoaded > 0n) expect(svm.getAccount(hold).exists).toBe(false);
        break;
      }
    }
  }
}

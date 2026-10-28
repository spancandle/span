import { expect } from "vitest";
import { type LiteSVM } from "litesvm";
import { type Address, type Instruction, unwrapOption } from "@solana/kit";
import * as r from "../client/src/generated/index.js";
import { type DecodedSpanEvent } from "../client/events.js";
import { findVaultPda, findSpanHoldPda } from "../client/pdas.js";
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
      [r.SpanInstruction.Read]: "Read",
      [r.SpanInstruction.Mark]: "Marked",
      [r.SpanInstruction.Settle]: "Settled",
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
          Buffer.from(bytes(config!.feed)).readBigInt64LE(177),
        );
        expect(e.price).toBe(
          Buffer.from(bytes(config!.feed)).readBigUInt64LE(168),
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
          rent +
            (buyer === t.seller ? spanRent : 0n) -
            (payer === t.seller ? fee : 0n),
        );
        if (buyer && buyer !== t.seller && t.spanLoaded > 0n) {
          const b = svm.getAccount(buyer);
          if (!b.exists) throw Error();
          expect(b.lamports - old(buyer).lamports).toBe(
            spanRent - (payer === buyer ? fee : 0n),
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
            outcome === r.Outcome.Paid ? highLow(c, t) : { high: 0n, low: 0n },
          paid = outcome === r.Outcome.Paid ? payout(c, t) : 0n,
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

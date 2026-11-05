import {secsOf,lastReadOf} from "./assets.js";
export type CandlePrices = {
  t0: bigint;
  readWindow: number;
  ageLimit: number;
  reads: readonly { price: bigint; publishTs: bigint }[];
  readHigh: bigint;
  readLow: bigint;
};
export type TicketPrices = {
  strikeBps: number;
  tailHigh: bigint;
  tailLow: bigint;
  stepBps: number;
};
export const CAP = 40_000_000n;
export function boundary(t0: bigint, j: number) {
  if (!Number.isInteger(j) || j < 0 || j > lastReadOf(t0))
    throw new RangeError("InvalidValue");
  return t0 + 300n * BigInt(j);
}
export const settleAfter = (
  c: Pick<CandlePrices, "t0" | "readWindow" | "ageLimit">,
) => c.t0 + secsOf(c.t0) + 1n + BigInt(c.readWindow + c.ageLimit);
export function highLow(c: CandlePrices, t: TicketPrices) {
  return {
    high: c.readHigh > t.tailHigh ? c.readHigh : t.tailHigh,
    low: t.tailLow === 0n || c.readLow < t.tailLow ? c.readLow : t.tailLow,
  };
}
export function payout(c: CandlePrices, t: TicketPrices) {
  const p0 = c.reads[0].price;
  if (!p0) return 0n;
  const { high, low } = highLow(c, t);
  if (high < low) throw new RangeError("InvalidValue");
  const raw = (1_000_000_000n * (high - low)) / p0;
  const net = raw - BigInt(t.strikeBps) * 100_000n;
  return net > CAP ? CAP : net > 0n ? net : 0n;
}
export function markAccepts(
  c: CandlePrices,
  t: TicketPrices,
  price: bigint,
):
  | { accepted: true; side: "High" | "Low"; burns: boolean }
  | { accepted: false; reason: "NoOpen" | "NotExtension" | "CapReached" } {
  const p0 = c.reads[0].price;
  if (!p0) return { accepted: false, reason: "NoOpen" };
  const { high, low } = highLow(c, t);
  const stride = p0 * BigInt(t.stepBps);
  const side =
    price * 10_000n >= high * 10_000n + stride
      ? "High"
      : price * 10_000n + stride <= low * 10_000n
        ? "Low"
        : null;
  if (!side) return { accepted: false, reason: "NotExtension" };
  if (payout(c, t) === CAP) return { accepted: false, reason: "CapReached" };
  const next = { ...t, tailHigh: side === "High" ? price : t.tailHigh, tailLow: side === "Low" ? price : t.tailLow };
  return { accepted: true, side, burns: payout(c, next) > payout(c, t) };
}

/** Price recorded by an entry after the opening reading, preserving any new tail. */
export function runningPrice(c: CandlePrices, t: TicketPrices, price: bigint) {
  if (!c.reads[0].price) throw new RangeError("NoOpen");
  const range = highLow(c, t);
  const tailHigh = price > range.high ? price : t.tailHigh;
  const tailLow = price < range.low ? price : t.tailLow;
  const next = { ...t, tailHigh, tailLow };
  return { recorded: payout(c, next), ...highLow(c, next), tailHigh, tailLow };
}

/** Resales price only the range already recorded by the ticket. */
export function resaleRecorded(c: CandlePrices, t: TicketPrices): bigint {
  if (!c.reads[0].price) throw new RangeError("NoOpen");
  return payout(c, t);
}

/** Whether a vacant reading can still absorb an observation already on chain. */
export function readPending(c: CandlePrices, now: bigint, feed: {price: bigint; publishTs: bigint} | null): boolean {
  const elapsed = now - c.t0, j = elapsed / 300n;
  if (elapsed >= 0n && j <= BigInt(lastReadOf(c.t0)) && !c.reads[Number(j)].price &&
      now <= boundary(c.t0, Number(j)) + BigInt(c.readWindow + c.ageLimit)) return true;
  return feed !== null && c.reads.some((r, k) => k >= 1 && k <= lastReadOf(c.t0) && !r.price &&
    feed.publishTs >= boundary(c.t0, k) && feed.publishTs <= boundary(c.t0, k) + BigInt(c.readWindow) &&
    now - feed.publishTs <= BigInt(c.ageLimit));
}

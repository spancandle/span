import { markAccepts, type Candle, type Ticket } from "../../../program/client/index.js";
import { secsOf } from "../../../program/client/assets.js";

export type ReaderOptions = { mode: "full" | "marks"; policy: "greedy" | "paced-v1" };
export function readerOptions(mode = "full", policy = "greedy"): ReaderOptions {
  if ((mode === "full" && policy === "greedy") || (mode === "marks" && policy === "paced-v1"))
    return { mode, policy };
  throw Error("Invalid keeper action mode / mark policy");
}

/** Initial-load reserve. Direct transfers above this reserve are immediately usable. */
export function pacedReserve(loaded: bigint, burn: bigint, duration: bigint, elapsed: bigint) {
  if (loaded < 0n || burn <= 0n || duration <= 0n) throw RangeError("Invalid reader budget");
  const n = loaded / burn, e = (elapsed > 0n ? elapsed : 0n) + 300n,
    time = e < duration ? e : duration,
    allowance = (n * time + duration - 1n) / duration;
  return n - allowance;
}

/** A send-time prediction: the oracle and paid/free classification can change before landing. */
export function readerMarkAccepts(
  policy: ReaderOptions["policy"], c: Candle, t: Ticket, price: bigint,
  now: bigint, balance: bigint, burn: bigint,
) {
  const mark = markAccepts(c, t, price);
  if (!mark.accepted || policy === "greedy") return mark;
  if (burn <= 0n || balance < burn) return { accepted: false, reason: "SpanShort" } as const;
  if (mark.burns && balance / burn <= pacedReserve(t.spanLoaded, burn, secsOf(c.t0), now - c.t0))
    return { accepted: false, reason: "paced-reserve" } as const;
  return mark;
}

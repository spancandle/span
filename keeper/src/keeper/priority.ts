import type { Instruction } from "@solana/kit";
export function writableAccounts(ixs: readonly Instruction[], payer: string) {
  const set = new Set([payer]);
  for (const ix of ixs)
    for (const a of ix.accounts ?? []) if (a.role & 1) set.add(a.address);
  return [...set];
}
export function selectPriorityFee(samples: unknown, min: bigint, max: bigint) {
  if (min < 0n || max < min) throw new Error("Invalid fee bounds");
  const prices = Array.isArray(samples)
    ? samples
        .map((x) => x?.prioritizationFee)
        .filter(
          (x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0,
        )
        .map(BigInt)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  const p = prices.length ? prices[Math.ceil(prices.length * 0.75) - 1] : min;
  return p < min ? min : p > max ? max : p;
}

/** Fee sampling runs on its own schedule, never from a price callback. */
export class PriorityFees {
  private entries = new Map<
    string,
    {
      accounts: string[];
      seen: number;
      at?: number;
      busy: boolean;
      price: bigint;
    }
  >();
  constructor(
    readonly rpc: {
      call<T = any>(method: string, params?: unknown[]): Promise<T>;
    },
    readonly min: bigint,
    readonly max: bigint,
    readonly now = () => Date.now(),
  ) {
    selectPriorityFee([], min, max);
  }
  register(key: string, ixs: readonly Instruction[], payer: string) {
    const accounts = writableAccounts(ixs, payer),
      old = this.entries.get(key);
    if (old) {
      old.accounts = accounts;
      old.seen = this.now();
    } else
      this.entries.set(key, {
        accounts,
        seen: this.now(),
        busy: false,
        price: this.min,
      });
  }
  price(key: string) {
    return this.entries.get(key)?.price ?? this.min;
  }
  async refresh() {
    const now = this.now();
    await Promise.all(
      [...this.entries.values()]
        .filter(
          (e) =>
            !e.busy &&
            now - e.seen <= 15000 &&
            (e.at === undefined || now - e.at >= 10000),
        )
        .slice(0, 2)
        .map(async (e) => {
          e.busy = true;
          e.at = now;
          const accounts = [...e.accounts];
          try {
            e.price = selectPriorityFee(
              await this.rpc.call("getRecentPrioritizationFees", [accounts]),
              this.min,
              this.max,
            );
          } catch {
          } finally {
            e.busy = false;
          }
        }),
    );
  }
}

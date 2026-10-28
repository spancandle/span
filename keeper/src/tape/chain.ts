import type { RpcPool } from "../common/rpc.js";
import { feeBounds } from "../common/env.js";
import { selectPriorityFee } from "../keeper/priority.js";
import { atomicFile } from "./http.js";
import type { History } from "./history.js";
export class ChainReader {
  blockhash?: string;
  lastValidBlockHeight = 0;
  blockHeight = 0;
  hashAt = 0;
  fee = feeBounds().min;
  private busy = false;
  constructor(
    readonly rpc: RpcPool,
    readonly dir: string,
    readonly history: History,
  ) {}
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const [hash, height] = await Promise.all([
        this.rpc.call(
          "getLatestBlockhash",
          [{ commitment: "confirmed" }],
          "normal",
          "chain-hash",
        ),
        this.rpc.call(
          "getBlockHeight",
          [{ commitment: "confirmed" }],
          "normal",
          "chain-height",
        ),
      ]);
      this.blockhash = hash.value.blockhash;
      this.lastValidBlockHeight = hash.value.lastValidBlockHeight;
      this.blockHeight = height;
      this.hashAt = Date.now();
    } finally {
      this.busy = false;
    }
  }
  async fees(writable: string[]) {
    const bounds = feeBounds();
    try {
      this.fee = selectPriorityFee(
        await this.rpc.call("getRecentPrioritizationFees", [
          writable.slice(0, 128),
        ]),
        bounds.min,
        bounds.max,
      );
    } catch {}
  }
  document() {
    return {
      v: 1,
      generated: Date.now(),
      cluster: this.rpc.cluster,
      blockhash: this.blockhash,
      lastValidBlockHeight: String(this.lastValidBlockHeight),
      blockHeight: String(this.blockHeight),
      hashAt: this.hashAt,
      listedAt: this.history.listedAt,
      fee: String(this.fee),
      recent: this.history.recent(),
    };
  }
  publish() {
    if (this.blockhash && Date.now() - this.hashAt <= 15000)
      atomicFile(this.dir, "chain.json", this.document());
  }
}

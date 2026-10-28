import { DOVES, SOL_FEED } from "../../../program/client/constants.js";
export type DovesUpdate = { price: string; publish_ts: number; slot: number };
/** Recover the selected SOL oracle source from successful UpdateAgPrice2 logs. */
export function decodeDovesTransaction(tx: any): DovesUpdate[] {
  if (!tx?.meta || tx.meta.err !== null) return [];
  if (!Number.isFinite(tx.slot) || !Number.isFinite(tx.blockTime))
    throw Error("Oracle transaction time unavailable");
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ].map((k) => (typeof k === "string" ? k : k.pubkey));
  const ixs = tx.transaction.message.instructions.filter(
    (ix: any) => keys[ix.programIdIndex] === DOVES && ix.data === "BFFRQh5PNJx",
  );
  const blocks: string[][] = [];
  for (const line of tx.meta.logMessages ?? []) {
    if (line === "Program log: Instruction: UpdateAgPrice2") blocks.push([]);
    else blocks.at(-1)?.push(line);
  }
  if (ixs.length !== blocks.length)
    throw Error("Oracle instruction/log count mismatch");
  return ixs.flatMap((ix: any, i: number) => {
    if (keys[ix.accounts[1]] !== SOL_FEED) return [];
    const chosen = blocks[i]
      .map((line) => /updated from (.+)$/.exec(line)?.[1]?.trim())
      .find(Boolean);
    if (!chosen) return [];
    const v = blocks[i]
      .map((line) =>
        /^Program log: (.+) price: (\d+), timestamp: (-?\d+)$/.exec(line),
      )
      .find((v) => v?.[1] === chosen);
    if (!v || BigInt(v[2]) <= 0n) throw Error("Selected oracle source missing");
    return [{ price: v[2], publish_ts: Number(v[3]), slot: tx.slot }];
  });
}

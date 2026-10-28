import { createHash } from "node:crypto";
import {
  getAddressDecoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import {
  SPAN_PROGRAM_ADDRESS,
  type EventInstruction,
} from "../../../program/client/index.js";
import { DOVES, SOL } from "../../../program/client/constants.js";
import type { Cluster } from "./env.js";
export const devFeedPda = async () =>
  (
    await getProgramDerivedAddress({
      programAddress: SPAN_PROGRAM_ADDRESS,
      seeds: ["dev_feed"],
    })
  )[0];
export type FeedValue = {
  price: bigint;
  publishTs: bigint;
  slot: number;
  recvMs: number;
  source: "ws" | "poll";
};
export async function parseFeed(
  raw: any,
  key: Address,
  cluster: Cluster,
): Promise<{ price: bigint; publishTs: bigint }> {
  if (!raw) throw Error("FeedInvalid");
  const d = Buffer.from(raw.data[0], "base64");
  if (
    raw.owner !== DOVES &&
    !(
      cluster === "devnet" &&
      raw.owner === SPAN_PROGRAM_ADDRESS &&
      key === (await devFeedPda())
    )
  )
    throw Error("FeedInvalid");
  if (
    d.length !== 394 ||
    d.subarray(0, 8).toString("hex") !== "70f98bd9d7d0f936" ||
    d[176] !== 248
  )
    throw Error("FeedInvalid");
  if (getAddressDecoder().decode(d.subarray(8, 40)) !== SOL)
    throw Error("FeedAssetMismatch");
  const price = d.readBigUInt64LE(168);
  if (price === 0n) throw Error("FeedInvalid");
  return { price, publishTs: d.readBigInt64LE(177) };
}
const prefix = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
const disc = createHash("sha256")
  .update("event:DevFeedUpdated")
  .digest()
  .subarray(0, 8);
export function decodeDevFeedEvents(ixs: readonly EventInstruction[]) {
  return ixs.flatMap((ix) => {
    if (ix.programAddress !== SPAN_PROGRAM_ADDRESS) return [];
    const d = Buffer.from(
      typeof ix.data === "string"
        ? getBase58Encoder().encode(ix.data)
        : ix.data,
    );
    if (!d.subarray(0, 8).equals(prefix) || !d.subarray(8, 16).equals(disc))
      return [];
    if (d.length !== 32) throw Error("Malformed development feed event");
    return [
      {
        name: "DevFeedUpdated" as const,
        data: { price: d.readBigUInt64LE(16), publishTs: d.readBigInt64LE(24) },
      },
    ];
  });
}

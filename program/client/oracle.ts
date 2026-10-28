import { getAddressDecoder, type Address } from "@solana/kit";
import { DOVES, SOL } from "./constants.js";
const DISC = [0x70, 0xf9, 0x8b, 0xd9, 0xd7, 0xd0, 0xf9, 0x36];
export function decodeDoves(
  data: Uint8Array,
  owner: Address,
  now: bigint,
  ageLimit: number,
) {
  if (
    owner !== DOVES ||
    data.length !== 394 ||
    !DISC.every((x, i) => data[i] === x) ||
    data[176] !== 248
  )
    throw Error("FeedInvalid");
  const assetMint = getAddressDecoder().decode(data.subarray(8, 40));
  if (assetMint !== SOL) throw Error("FeedAssetMismatch");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const price = view.getBigUint64(168, true),
    publishTs = view.getBigInt64(177, true);
  if (!price) throw Error("FeedInvalid");
  if (now - publishTs > BigInt(ageLimit)) throw Error("FeedStale");
  return { price, exponent: -8, publishTs, assetMint };
}

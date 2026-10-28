import { createHash } from "node:crypto";
import { getBase58Encoder, getAddressEncoder, getProgramDerivedAddress, address, AccountRole, type TransactionSigner, type Instruction } from "@solana/kit";
import { SPAN_PROGRAM_ADDRESS } from "../client/index.js";
import { LOADER } from "../client/constants.js";
import type { EventInstruction } from "../client/events.js";
export function decodeDevFeedEvents(instructions: readonly EventInstruction[]) {
  const prefix = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
  const discriminator = createHash("sha256")
    .update("event:DevFeedUpdated")
    .digest()
    .subarray(0, 8);
  return instructions.flatMap((ix) => {
    if (ix.programAddress !== SPAN_PROGRAM_ADDRESS) return [];
    const bytes = Buffer.from(
      typeof ix.data === "string"
        ? getBase58Encoder().encode(ix.data)
        : ix.data,
    );
    if (!bytes.subarray(0, 8).equals(prefix)) return [];
    if (bytes.length !== 32 || !bytes.subarray(8, 16).equals(discriminator))
      throw Error("Malformed development feed event");
    return [
      {
        name: "DevFeedUpdated" as const,
        data: {
          price: bytes.readBigUInt64LE(16),
          publishTs: bytes.readBigInt64LE(24),
        },
      },
    ];
  });
}

export const programData = async () =>
  (
    await getProgramDerivedAddress({
      programAddress: LOADER,
      seeds: [getAddressEncoder().encode(SPAN_PROGRAM_ADDRESS)],
    })
  )[0];
export const eventAccounts = async () => ({
  eventAuthority: (
    await getProgramDerivedAddress({
      programAddress: SPAN_PROGRAM_ADDRESS,
      seeds: ["__event_authority"],
    })
  )[0],
  program: SPAN_PROGRAM_ADDRESS,
});
export const feedPda = async () =>
  (
    await getProgramDerivedAddress({
      programAddress: SPAN_PROGRAM_ADDRESS,
      seeds: ["dev_feed"],
    })
  )[0];

export async function devFeedInstruction(
  name: "dev_feed_init" | "dev_feed_write",
  authority: TransactionSigner,
  price?: bigint,
  publishTs?: bigint,
): Promise<Instruction> {
  const bytes = Buffer.alloc(name === "dev_feed_init" ? 8 : 24);
  createHash("sha256").update(`global:${name}`).digest().copy(bytes, 0, 0, 8);
  if (price !== undefined) bytes.writeBigUInt64LE(price, 8);
  if (publishTs !== undefined) bytes.writeBigInt64LE(publishTs, 16);
  const authorityAccount = {
    address: authority.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: authority,
  };
  const ev = await eventAccounts();
  return {
    programAddress: SPAN_PROGRAM_ADDRESS,
    data: bytes,
    accounts: [
      authorityAccount,
      { address: SPAN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: await programData(), role: AccountRole.READONLY },
      { address: await feedPda(), role: AccountRole.WRITABLE },
      ...(name === "dev_feed_init"
        ? [
            {
              address: address("11111111111111111111111111111111"),
              role: AccountRole.READONLY,
            },
          ]
        : []),
      { address: ev.eventAuthority, role: AccountRole.READONLY },
      { address: SPAN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
  };
}

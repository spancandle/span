import {
  generateKeyPairSigner,
  getAddressDecoder,
  getProgramDerivedAddress,
  unwrapOption,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";
import {
  getInitializeAccount3Instruction,
  getMintDecoder,
  getTokenDecoder,
  getTokenSize,
  type ExtensionArgs,
} from "@solana-program/token-2022";
import {
  getSettleInstruction,
  SPAN_PROGRAM_ADDRESS,
  TicketState,
  type Config,
  type Candle,
  type Ticket,
} from "./src/generated/index.js";
import {
  findConfigPda,
  findCandlePda,
  findVaultPda,
  findSpanHoldPda,
} from "./pdas.js";
import { TOKEN, TOKEN_2022 } from "./constants.js";
import { payout } from "./math.js";

/** Space required by InitializeAccount3 for the mint's account extensions. */
export function tokenAccountSize(
  program: Address,
  mintData: Uint8Array,
): number {
  if (program === TOKEN) return 165;
  const mint = getMintDecoder().decode(mintData);
  const required: ExtensionArgs[] = [];
  for (const extension of unwrapOption(mint.extensions) ?? []) {
    switch (extension.__kind) {
      case "TransferFeeConfig":
        required.push({ __kind: "TransferFeeAmount", withheldAmount: 0n });
        break;
      case "NonTransferable":
        required.push(
          { __kind: "NonTransferableAccount" },
          { __kind: "ImmutableOwner" },
        );
        break;
      case "TransferHook":
        required.push({ __kind: "TransferHookAccount", transferring: false });
        break;
      case "PausableConfig":
        required.push({ __kind: "PausableAccount" });
        break;
    }
  }
  return getTokenSize(required.length ? required : undefined);
}

export async function buildSettleInstructions(input: {
  payer: TransactionSigner;
  config: Config;
  candle: Candle;
  ticket: Ticket;
  ticketAddress: Address;
  vaultBalance: bigint;
  spanBalance: bigint;
  getAccount: (
    a: Address,
  ) => Promise<{ programOwner: Address; data: Uint8Array } | null>;
  getMintData: (a: Address) => Promise<Uint8Array>;
  getRent: (bytes: number) => Promise<bigint>;
  createSigner?: typeof generateKeyPairSigner;
}): Promise<Instruction[]> {
  const { config, candle, ticket, payer, ticketAddress } = input;
  const buyer = unwrapOption(ticket.buyer);
  const toBuyer =
    ticket.state === TicketState.Open
      ? 0n
      : candle.reads[0].price === 0n
        ? ticket.premium
        : payout(candle, ticket);
  const toSeller = input.vaultBalance - toBuyer;
  if (toSeller < 0n) throw Error("DepositMismatch");
  const ixs: Instruction[] = [];
  async function recipient(
    owner: Address,
    mint: Address,
    program: Address,
    amount: bigint,
  ): Promise<Address | undefined> {
    if (amount === 0n) return undefined;
    const [associated] = await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: program,
    });
    const existing = await input.getAccount(associated);
    if (
      existing?.programOwner === program &&
      getAddressDecoder().decode(existing.data.subarray(0, 32)) === mint &&
      getAddressDecoder().decode(existing.data.subarray(32, 64)) === owner &&
      !(
        program === TOKEN_2022 &&
        (
          unwrapOption(getTokenDecoder().decode(existing.data).extensions) ?? []
        ).some(
          (extension) =>
            extension.__kind === "MemoTransfer" &&
            extension.requireIncomingTransferMemos,
        )
      )
    )
      return associated;
    if (!existing) {
      ixs.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer,
          owner,
          mint,
          tokenProgram: program,
        }),
      );
      return associated;
    }
    const account = await (input.createSigner ?? generateKeyPairSigner)();
    const size = tokenAccountSize(program, await input.getMintData(mint));
    ixs.push(
      getCreateAccountInstruction({
        payer,
        newAccount: account,
        space: BigInt(size),
        lamports: await input.getRent(size),
        programAddress: program,
      }),
      getInitializeAccount3Instruction(
        { account: account.address, mint, owner },
        { programAddress: program },
      ),
    );
    return account.address;
  }
  const sellerUsdc = await recipient(
    ticket.seller,
    config.usdcMint,
    TOKEN,
    toSeller,
  );
  const buyerUsdc = buyer
    ? await recipient(buyer, config.usdcMint, TOKEN, toBuyer)
    : undefined;
  const spanMint =
    ticket.spanLoaded > 0n ? unwrapOption(config.spanMint) : undefined;
  const spanTokenProgram =
    ticket.spanLoaded > 0n ? unwrapOption(config.spanTokenProgram) : undefined;
  if (ticket.spanLoaded > 0n && (!buyer || !spanMint || !spanTokenProgram))
    throw Error("MissingAccount");
  const buyerSpan =
    buyer && spanMint && spanTokenProgram
      ? await recipient(buyer, spanMint, spanTokenProgram, input.spanBalance)
      : undefined;
  ixs.push(
    getSettleInstruction({
      config: (await findConfigPda())[0],
      candle: (await findCandlePda(ticket.t0))[0],
      ticket: ticketAddress,
      vault: (await findVaultPda(ticketAddress))[0],
      seller: ticket.seller,
      buyer: buyer ?? undefined,
      usdcMint: config.usdcMint,
      sellerUsdc,
      buyerUsdc,
      tokenProgram: TOKEN,
      spanMint: spanMint ?? undefined,
      spanTokenProgram: spanTokenProgram ?? undefined,
      spanHold:
        ticket.spanLoaded > 0n
          ? (await findSpanHoldPda(ticketAddress))[0]
          : undefined,
      buyerSpan,
      eventAuthority: (
        await getProgramDerivedAddress({
          programAddress: SPAN_PROGRAM_ADDRESS,
          seeds: ["__event_authority"],
        })
      )[0],
      program: SPAN_PROGRAM_ADDRESS,
    }),
  );
  return ixs;
}

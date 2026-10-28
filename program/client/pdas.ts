import {
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import {
  SPAN_PROGRAM_ADDRESS,
  findCandlePda as generatedCandle,
  findTicketPda as generatedTicket,
  findVaultPda as generatedVault,
} from "./src/generated/index.js";
export { findConfigPda } from "./src/generated/index.js";
export const findCandlePda = (t0: bigint) => generatedCandle({ t0 });
export const findTicketPda = (id: bigint) => generatedTicket({ id });
export const findVaultPda = (ticket: Address) => generatedVault({ ticket });
export const findSpanHoldPda = (ticket: Address) =>
  getProgramDerivedAddress({
    programAddress: SPAN_PROGRAM_ADDRESS,
    seeds: ["span", getAddressEncoder().encode(ticket)],
  });
export const findEventAuthorityPda = () =>
  getProgramDerivedAddress({
    programAddress: SPAN_PROGRAM_ADDRESS,
    seeds: ["__event_authority"],
  });

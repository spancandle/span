import {
  getProgramDerivedAddress,
  getAddressEncoder,
  getI64Encoder,
  getU16Encoder,
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
export const findBandPda = (ticket: Address) => getProgramDerivedAddress({
  programAddress: SPAN_PROGRAM_ADDRESS, seeds: ["band", getAddressEncoder().encode(ticket)],
});
export const findEventAuthorityPda = () =>
  getProgramDerivedAddress({
    programAddress: SPAN_PROGRAM_ADDRESS,
    seeds: ["__event_authority"],
  });

export const findUntilPda = (ticket: Address) =>
  getProgramDerivedAddress({
    programAddress: SPAN_PROGRAM_ADDRESS,
    seeds: ["until", getAddressEncoder().encode(ticket)],
  });

export const findResalePda = (ticket: Address) =>
  getProgramDerivedAddress({
    programAddress: SPAN_PROGRAM_ADDRESS,
    seeds: ["resale", getAddressEncoder().encode(ticket)],
  });

export const findBidPda = (ticket: Address, bidder: Address) => getProgramDerivedAddress({
  programAddress: SPAN_PROGRAM_ADDRESS, seeds: ["bid", getAddressEncoder().encode(ticket), getAddressEncoder().encode(bidder)],
});
export const findBidUsdcPda = (bid: Address) => getProgramDerivedAddress({programAddress:SPAN_PROGRAM_ADDRESS,seeds:["bid_usdc",getAddressEncoder().encode(bid)]});
export const findBidSpanPda = (bid: Address) => getProgramDerivedAddress({programAddress:SPAN_PROGRAM_ADDRESS,seeds:["bid_span",getAddressEncoder().encode(bid)]});

export const findRequestPda = (t0:bigint, strikeBps:number, requester:Address) => getProgramDerivedAddress({programAddress:SPAN_PROGRAM_ADDRESS,seeds:["request",getI64Encoder().encode(t0),getU16Encoder().encode(strikeBps),getAddressEncoder().encode(requester)]});
export const findRequestUsdcPda = (request:Address) => getProgramDerivedAddress({programAddress:SPAN_PROGRAM_ADDRESS,seeds:["request_usdc",getAddressEncoder().encode(request)]});
export const findRequestSpanPda = (request:Address) => getProgramDerivedAddress({programAddress:SPAN_PROGRAM_ADDRESS,seeds:["request_span",getAddressEncoder().encode(request)]});

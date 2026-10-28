import { it, expect } from "vitest";
import * as token from "@solana-program/token-2022";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  Harness,
  TOKEN,
  TOKEN_2022,
  SOL_FEED,
  USDC,
  PROGRAM,
  accountData,
  amount,
  type Ref,
} from "./harness.js";
import { buildSettleInstructions, tokenAccountSize } from "../client/settle.js";
import { settleAfter } from "../client/math.js";
async function instructions(h: Harness, t: Ref) {
  return buildSettleInstructions({
    payer: h.stranger,
    config: h.configState(),
    candle: h.candleState(t),
    ticket: h.ticketState(t),
    ticketAddress: t.ticket,
    vaultBalance: amount(h.svm, t.vault),
    spanBalance: amount(h.svm, t.spanHold),
    getAccount: async (a) => {
      const x = h.svm.getAccount(a);
      if (!x.exists) return null;
      return {
        programOwner: x.programAddress,
        data: Buffer.from(x.data),
      };
    },
    getMintData: async (a) => accountData(h.svm, a),
    getRent: async (bytes) =>
      h.svm.minimumBalanceForRentExemption(BigInt(bytes)),
  });
}
async function openingRead(h: Harness, t: Ref) {
  h.clock(t.t0);
  h.price(8_246_000_000n, t.t0);
  await h.send("read", h.readIx(t, 0));
  h.clock(t.t0 + 300n);
  h.price(8_300_000_000n, t.t0 + 300n);
  await h.send("read", h.readIx(t, 1));
}
for (const program of [TOKEN, TOKEN_2022])
  for (const mode of ["closed", "reassigned"])
    it(`P9 repairs all recipient accounts atomically: ${program} ${mode}`, async () => {
      const h = await Harness.create({ spanProgram: program, setSpan: true });
      const t = await h.open({ loaded: true });
      await openingRead(h, t);
      for (const [a, mint, owner, p] of [
        [h.sellerUsdc, USDC, h.seller, TOKEN],
        [h.buyerUsdc, USDC, h.buyer, TOKEN],
        [h.buyerSpan, h.spanMint, h.buyer, program],
      ] as const) {
        if (mode === "closed") {
          const balance = amount(h.svm, a);
          await h.send(
            "burn_wallet",
            token.getBurnInstruction(
              { account: a, mint, authority: owner, amount: balance },
              { programAddress: p },
            ),
            owner,
          );
          await h.send(
            "close_wallet",
            token.getCloseAccountInstruction(
              { account: a, destination: owner.address, owner },
              { programAddress: p },
            ),
            owner,
          );
        } else if (p === TOKEN_2022)
          await h.send(
            "immutable_owner",
            token.getSetAuthorityInstruction(
              {
                owned: a,
                owner,
                authorityType: token.AuthorityType.AccountOwner,
                newAuthority: h.admin.address,
              },
              { programAddress: p },
            ),
            owner,
            "",
          );
        else
          await h.send(
            "change_owner",
            token.getSetAuthorityInstruction(
              {
                owned: a,
                owner,
                authorityType: token.AuthorityType.AccountOwner,
                newAuthority: h.admin.address,
              },
              { programAddress: p },
            ),
            owner,
          );
      }
      h.clock(settleAfter(h.candleState(t)));
      const ixs = await instructions(h, t);
      expect(ixs).toHaveLength(
        mode === "closed" ? 4 : program === TOKEN_2022 ? 5 : 7,
      );
      await h.send(
        `settle_recipients_${mode}_${program === TOKEN ? "classic" : "2022"}`,
        ixs,
      );
      expect(h.svm.getAccount(t.ticket).exists).toBe(false);
      expect(h.svm.getAccount(t.vault).exists).toBe(false);
      expect(h.svm.getAccount(t.spanHold).exists).toBe(false);
      const event = h.events[0];
      expect(event.name).toBe("Settled");
    });
it("P9 rejects wrong mint, owner and rent receiver and skips a zero transfer", async () => {
  const h = await Harness.create({ setSpan: true });
  const t = await h.open({ loaded: true });
  await openingRead(h, t);
  h.clock(settleAfter(h.candleState(t)));
  await h.send(
    "wrong_receiver",
    h.settleIx(t, { seller: h.admin.address }),
    h.stranger,
    "ReceiverMismatch",
  );
  await h.send(
    "wrong_receiver",
    h.settleIx(t, { buyer: h.admin.address }),
    h.stranger,
    "ReceiverMismatch",
  );
  await h.send(
    "wrong_owner",
    h.settleIx(t, { buyerUsdc: await h.fundToken(h.admin, USDC, TOKEN, 1n) }),
    h.stranger,
    "WrongOwner",
  );
  await h.send(
    "wrong_mint",
    h.settleIx(t, {
      buyerUsdc: await h.fundToken(h.admin, h.spanMint, TOKEN, 1n),
    }),
    h.stranger,
    "WrongMint",
  );
  await h.send(
    "missing",
    h.settleIx(t, { buyerUsdc: undefined }),
    h.stranger,
    "MissingAccount",
  );
  await h.send(
    "wrong_span_owner",
    h.settleIx(t, {
      buyerSpan: await h.fundToken(h.seller, h.spanMint, h.spanProgram, 1n),
    }),
    h.stranger,
    "WrongOwner",
  );
});
it("P10 tolerates prefunded PDAs and unsolicited token deposits", async () => {
  const h = await Harness.create({ setSpan: true });
  const t = await h.ref();
  for (const a of [t.ticket, t.vault, t.spanHold, t.candle])
    await h.send(
      "prefund",
      getTransferSolInstruction({
        source: h.stranger,
        destination: a,
        amount: h.svm.minimumBalanceForRentExemption(0n),
      }),
    );
  await h.send("open", [h.openCandleIx(t), h.openIx(t)], h.seller);
  await h.send(
    "donate_usdc",
    token.getTransferCheckedInstruction(
      {
        source: h.sellerUsdc,
        mint: USDC,
        destination: t.vault,
        authority: h.seller,
        amount: 1_000_000n,
        decimals: 6,
      },
      { programAddress: TOKEN },
    ),
    h.seller,
  );
  await h.send("buy_load", [h.buyIx(t), h.loadIx(t)], h.buyer);
  await h.send(
    "donate_span",
    token.getTransferCheckedInstruction(
      {
        source: h.buyerSpan,
        mint: h.spanMint,
        destination: t.spanHold,
        authority: h.buyer,
        amount: 123n,
        decimals: 8,
      },
      { programAddress: h.spanProgram },
    ),
    h.buyer,
  );
  await openingRead(h, t);
  h.clock(t.t0 + 301n);
  h.price(8_400_000_000n, t.t0 + 301n);
  await h.send("mark", h.markIx(t));
  const span = amount(h.svm, t.spanHold);
  h.clock(settleAfter(h.candleState(t)));
  await h.send("settle_donation", h.settleIx(t));
  const e: any = h.events[0].data;
  expect(e.toSeller + e.toBuyer).toBe(41_000_000n);
  expect(e.spanReturned).toBe(span);
});
it("P2 P10 reject substituted accounts and admin signatures without state changes", async () => {
  const h = await Harness.create({ setSpan: true });
  const a = await h.open({ loaded: true });
  const b = await h.open({ loaded: true, t0: 1260n });
  await h.send(
    "admin_withdraw",
    h.withdrawIx(a, { seller: h.admin }),
    h.stranger,
    "NotSeller",
  );
  await h.send(
    "admin_load",
    h.loadIx(a, { buyer: h.admin }),
    h.stranger,
    "NotBuyer",
  );
  await openingRead(h, a);
  await h.send(
    "admin_mark",
    h.markIx(a, { marker: h.admin }),
    h.stranger,
    "NotMarker",
  );
  await h.send(
    "wrong_hold",
    h.markIx(a, { spanHold: b.spanHold }),
    h.stranger,
    "",
  );
  await h.send(
    "wrong_candle",
    h.markIx(a, { candle: b.candle }),
    h.stranger,
    "InvalidValue",
  );
  h.clock(settleAfter(h.candleState(a)));
  await h.send(
    "wrong_vault",
    h.settleIx(a, { vault: b.vault }),
    h.stranger,
    "",
  );
  await h.send(
    "wrong_span",
    h.settleIx(a, { spanHold: b.spanHold }),
    h.stranger,
    "WrongOwner",
  );
  const noSpan = await Harness.create({ setSpan: true });
  const c = await noSpan.open({ sold: true });
  await noSpan.send(
    "not_loaded",
    noSpan.markIx(c),
    noSpan.stranger,
    "NotLoaded",
  );
});
it("P1 accepts an irreversible disabled hook, burns and returns its account extension", async () => {
  const h = await Harness.create({ spanProgram: TOKEN_2022 });
  h.spanMint = await h.createMint(TOKEN_2022, "hook-none");
  h.buyerSpan = await h.fundToken(h.buyer, h.spanMint, TOKEN_2022, 100_000n);
  await h.send(
    "set_span",
    h.ix("setSpan", { admin: h.admin, burnPerMark: 100n }),
  );
  const t = await h.open({ loaded: true });
  expect(accountData(h.svm, t.spanHold).length).toBe(
    tokenAccountSize(TOKEN_2022, accountData(h.svm, h.spanMint)),
  );
  await openingRead(h, t);
  h.clock(t.t0 + 301n);
  h.price(8_400_000_000n, t.t0 + 301n);
  await h.send("mark_disabled_hook", h.markIx(t));
  await h.send(
    "enable_no_authority",
    token.getUpdateTransferHookInstruction({
      mint: h.spanMint,
      authority: h.admin,
      programId: h.stranger.address,
    }),
    h.admin,
    "",
  );
  h.clock(settleAfter(h.candleState(t)));
  await h.send("settle_disabled_hook", h.settleIx(t));
  expect(h.svm.getAccount(t.spanHold).exists).toBe(false);
});

it("P9 replaces a memo-required Token-2022 ATA for permissionless settlement", async () => {
  const h = await Harness.create({ spanProgram: TOKEN_2022, setSpan: true });
  const t = await h.open({ loaded: true });
  await openingRead(h, t);
  await h.send(
    "require_incoming_memo",
    [
      token.getReallocateInstruction({
        token: h.buyerSpan,
        payer: h.buyer,
        owner: h.buyer,
        newExtensionTypes: [token.ExtensionType.MemoTransfer],
      }),
      token.getEnableMemoTransfersInstruction({
        token: h.buyerSpan,
        owner: h.buyer,
      }),
    ],
    h.buyer,
  );
  const recipient = token
    .getTokenDecoder()
    .decode(accountData(h.svm, h.buyerSpan));
  expect(recipient.extensions).toMatchObject({
    __option: "Some",
    value: expect.arrayContaining([
      { __kind: "MemoTransfer", requireIncomingTransferMemos: true },
    ]),
  });
  const held = amount(h.svm, t.spanHold);
  const memoBalance = amount(h.svm, h.buyerSpan);
  h.clock(settleAfter(h.candleState(t)));
  const ixs = await instructions(h, t);
  await h.send("settle_memo_recipient", ixs);
  expect(ixs).toHaveLength(3);
  expect(ixs[0].programAddress).toBe("11111111111111111111111111111111");
  expect(ixs[0].data?.[0]).toBe(0);
  expect(ixs[1].programAddress).toBe(TOKEN_2022);
  const initialized = token
    .getInitializeAccount3InstructionDataDecoder()
    .decode(ixs[1].data!);
  expect(initialized.owner).toBe(h.buyer.address);
  expect(ixs[2].programAddress).toBe(PROGRAM);
  expect(
    ixs
      .flatMap((ix) => ix.accounts ?? [])
      .some((a) => a.address === h.buyer.address && (a.role & 2) !== 0),
  ).toBe(false);
  const replacement = ixs[0].accounts![1].address;
  expect(replacement).not.toBe(h.buyerSpan);
  expect(ixs[1].accounts![0].address).toBe(replacement);
  expect(amount(h.svm, replacement)).toBe(held);
  expect(amount(h.svm, h.buyerSpan)).toBe(memoBalance);
  for (const a of [t.ticket, t.vault, t.spanHold])
    expect(h.svm.getAccount(a).exists).toBe(false);
  console.log(
    "MEMO_RECIPIENT " +
      JSON.stringify({
        instructions: ["CreateAccount", "InitializeAccount3", "settle"],
        replacement,
        returned: held.toString(),
        memoBalanceBefore: memoBalance.toString(),
        memoBalanceAfter: amount(h.svm, h.buyerSpan).toString(),
        buyerSignatureRequired: false,
        closed: [t.ticket, t.vault, t.spanHold],
      }),
  );
});

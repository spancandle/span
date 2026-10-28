import { it, expect } from "vitest";
import { address } from "@solana/kit";
import * as token from "@solana-program/token-2022";
import {
  Harness,
  amount,
  TOKEN,
  TOKEN_2022,
} from "../../program/tests/harness.js";
import { settleAfter } from "../../program/client/index.js";
import { settlement } from "../src/keeper/chain.js";
for (const mode of [
  "existing",
  "missing",
  "missing-t22",
  "missing-hook",
  "reassigned",
  "memo",
] as const)
  it(`S3(b) prepares cached raw recipient ${mode} and settles atomically`, async () => {
    const h = await Harness.create({
      setSpan: mode !== "missing-hook",
      spanProgram: ["memo", "missing-t22", "missing-hook"].includes(mode)
        ? TOKEN_2022
        : TOKEN,
    });
    if (mode === "missing-hook") {
      h.spanMint = await h.createMint(TOKEN_2022, "hook-none");
      h.buyerSpan = await h.fundToken(
        h.buyer,
        h.spanMint,
        TOKEN_2022,
        100_000n,
      );
      await h.send(
        "set_span",
        h.ix("setSpan", { admin: h.admin, burnPerMark: 100n }),
      );
    }
    const t = await h.open({ loaded: true });
    h.clock(t.t0);
    h.price(10000000000n, t.t0);
    await h.send("read0", h.readIx(t, 0));
    h.clock(t.t0 + 300n);
    h.price(10100000000n, t.t0 + 300n);
    await h.send("read1", h.readIx(t, 1));
    if (mode.startsWith("missing")) {
      await h.send(
        "burn",
        token.getBurnInstruction(
          {
            account: h.buyerSpan,
            mint: h.spanMint,
            authority: h.buyer,
            amount: amount(h.svm, h.buyerSpan),
          },
          { programAddress: h.spanProgram },
        ),
        h.buyer,
      );
      await h.send(
        "close",
        token.getCloseAccountInstruction(
          {
            account: h.buyerSpan,
            destination: h.buyer.address,
            owner: h.buyer,
          },
          { programAddress: h.spanProgram },
        ),
        h.buyer,
      );
    }
    if (mode === "reassigned")
      await h.send(
        "reassign",
        token.getSetAuthorityInstruction(
          {
            owned: h.buyerSpan,
            owner: h.buyer,
            authorityType: token.AuthorityType.AccountOwner,
            newAuthority: h.stranger.address,
          },
          { programAddress: h.spanProgram },
        ),
        h.buyer,
      );
    if (mode === "memo")
      await h.send(
        "memo",
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
    const calls: any[] = [];
    const rpc = {
      call: async (method: string, args: any[], lane: string) => {
        calls.push({ method, lane });
        expect(lane).toBe("prepare");
        if (method === "getMinimumBalanceForRentExemption")
          return h.svm.minimumBalanceForRentExemption(BigInt(args[0]));
        if (method === "getMultipleAccounts")
          return {
            value: args[0].map((key: string) => {
              const raw = h.svm.getAccount(address(key));
              return raw.exists
                ? {
                    owner: raw.programAddress,
                    data: [Buffer.from(raw.data).toString("base64"), "base64"],
                  }
                : null;
            }),
          };
        throw Error("Unexpected preparation call");
      },
    } as any;
    const built = await settlement(
      rpc,
      h.stranger,
      h.configState(),
      h.candleState(t),
      h.ticketState(t),
      t.ticket,
    );
    expect(
      calls.filter((x) => x.method === "getMultipleAccounts"),
    ).toHaveLength(1);
    expect(built.ixs).toHaveLength(
      mode === "existing" ? 1 : mode.startsWith("missing") ? 2 : 3,
    );
    expect(built.rent === 0n).toBe(mode === "existing");
    const hold = amount(h.svm, t.spanHold),
      memo = amount(h.svm, h.buyerSpan);
    h.clock(settleAfter(h.candleState(t)));
    const beforePayer = h.svm.getAccount(h.stranger.address);
    await h.send("atomic_settlement", built.ixs);
    const afterPayer = h.svm.getAccount(h.stranger.address);
    if (!beforePayer.exists || !afterPayer.exists)
      throw Error("Payer unavailable");
    const baseFee = mode === "memo" || mode === "reassigned" ? 10000n : 5000n;
    expect(beforePayer.lamports - afterPayer.lamports - baseFee).toBe(
      built.rent,
    );
    console.log(
      "SETTLEMENT_RENT " +
        JSON.stringify({
          mode,
          rent: String(built.rent),
          actual: String(beforePayer.lamports - afterPayer.lamports - baseFee),
        }),
    );
    expect(h.svm.getAccount(t.ticket).exists).toBe(false);
    expect(h.svm.getAccount(t.vault).exists).toBe(false);
    expect(h.svm.getAccount(t.spanHold).exists).toBe(false);
    if (mode === "memo") {
      expect(amount(h.svm, h.buyerSpan)).toBe(memo);
      expect(amount(h.svm, built.ixs[0].accounts![1].address)).toBe(hold);
    }
  });

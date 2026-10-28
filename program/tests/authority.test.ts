import { it, expect } from "vitest";
import { some } from "@solana/kit";
import * as token from "@solana-program/token-2022";
import {
  Harness,
  r,
  TOKEN,
  TOKEN_2022,
  accountData,
  amount,
} from "./harness.js";
import { settleAfter } from "../client/math.js";
it("P1 demonstrates why frozen, delegated, pausable and mutable-hook mints are rejected", async () => {
  for (const kind of [
    "freeze",
    "delegate",
    "pause",
    "hook-authority",
  ] as const) {
    const h = await Harness.create({
      spanProgram: kind === "freeze" ? TOKEN : TOKEN_2022,
    });
    const mint = await h.createMint(h.spanProgram, kind);
    await h.send(
      "reject_authority",
      h.ix("setSpan", { admin: h.admin, spanMint: mint, burnPerMark: 100n }),
      h.stranger,
      {
        freeze: "FreezeAuthorityMint",
        delegate: "PermanentDelegateMint",
        pause: "PausableMint",
        "hook-authority": "TransferHookActive",
      }[kind],
    );
    // Construct the counterfactual state solely to exercise the issuer's token authority.
    const config = h.svm.getAccount(h.config);
    if (!config.exists) throw Error();
    h.svm.setAccount({
      ...config,
      data: r
        .getConfigEncoder()
        .encode({
          ...h.configState(),
          spanMint: some(mint),
          spanTokenProgram: some(h.spanProgram),
          burnPerMark: 100n,
        }),
    });
    h.spanMint = mint;
    h.buyerSpan = await h.fundToken(h.buyer, mint, h.spanProgram, 100_000n);
    const t = await h.open({ loaded: true });
    h.clock(t.t0);
    h.price(8_246_000_000n, t.t0);
    await h.send("read", h.readIx(t, 0));
    h.clock(t.t0 + 1n);
    h.price(8_400_000_000n, t.t0 + 1n);
    if (kind === "delegate") {
      const supply = accountData(h.svm, mint).readBigUInt64LE(36);
      await h.send(
        "issuer_burn",
        token.getBurnInstruction({
          mint,
          account: t.spanHold,
          authority: h.admin,
          amount: 1n,
        }),
        h.admin,
      );
      expect(amount(h.svm, t.spanHold)).toBe(99_999n);
      expect(accountData(h.svm, mint).readBigUInt64LE(36)).toBe(supply - 1n);
      const dest = await h.fundToken(h.admin, mint, h.spanProgram, 1n);
      await h.send(
        "issuer_transfer",
        token.getTransferCheckedInstruction({
          mint,
          source: t.spanHold,
          destination: dest,
          authority: h.admin,
          amount: 1n,
          decimals: 8,
        }),
        h.admin,
      );
      expect(amount(h.svm, t.spanHold)).toBe(99_998n);
    } else if (kind === "freeze") {
      await h.send(
        "issuer_freeze",
        token.getFreezeAccountInstruction(
          { account: t.spanHold, mint, owner: h.admin },
          { programAddress: TOKEN },
        ),
        h.admin,
      );
      await h.send("frozen_mark", h.markIx(t), h.stranger, "");
      h.clock(settleAfter(h.candleState(t)));
      await h.send("frozen_settle", h.settleIx(t), h.stranger, "");
    } else if (kind === "pause") {
      await h.send(
        "issuer_pause",
        token.getPauseInstruction({ mint, authority: h.admin }),
        h.admin,
      );
      await h.send("paused_mark", h.markIx(t), h.stranger, "");
      h.clock(settleAfter(h.candleState(t)));
      await h.send("paused_settle", h.settleIx(t), h.stranger, "");
    } else {
      await h.send(
        "issuer_enable_hook",
        token.getUpdateTransferHookInstruction({
          mint,
          authority: h.admin,
          programId: h.stranger.address,
        }),
        h.admin,
      );
      h.clock(settleAfter(h.candleState(t)));
      await h.send("hook_settle", h.settleIx(t), h.stranger, "");
    }
  }
});

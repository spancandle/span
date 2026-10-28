import { it, expect } from "vitest";
import { Harness, amount, r, TOKEN } from "./harness.js";
import { settleAfter } from "../client/math.js";
it("P7 tests 2bp and exact 4% cap boundaries on chain", async () => {
  for (const [low, price, expected] of [
    [8_200_000_000n, 8_301_649_199n, "NotExtension"],
    [8_200_000_000n, 8_301_649_200n, null],
    [8_122_310_000n, 8_453_800_000n, "CapReached"],
    [8_122_310_001n, 8_453_799_200n, null],
  ] as const) {
    const h = await Harness.create({ setSpan: true });
    const t = await h.open({ loaded: true, step: 2 });
    const high = low < 8_200_000_000n ? 8_452_150_000n : 8_300_000_000n;
    for (const [j, p] of [8_246_000_000n, high, low].entries()) {
      const ts = t.t0 + 300n * BigInt(j);
      h.clock(ts);
      h.price(p, ts);
      await h.send("read", h.readIx(t, j));
    }
    h.clock(t.t0 + 601n);
    h.price(price, t.t0 + 601n);
    await h.send(
      "mark_boundary_2bp",
      h.markIx(t),
      h.stranger,
      expected ?? undefined,
    );
  }
});
it("P8 shows that empty final reads and marks cannot change a candle at settlement", async () => {
  const h = await Harness.create({ setSpan: true });
  const t = await h.open({ loaded: true });
  h.clock(t.t0);
  h.price(8_246_000_000n, t.t0);
  await h.send("read", h.readIx(t, 0));
  h.clock(settleAfter(h.candleState(t)));
  h.price(8_246_000_000n, t.t0 + 3620n);
  await h.send("late_read_stale", h.readIx(t, 12), h.stranger, "FeedStale");
  h.price(8_246_000_000n, settleAfter(h.candleState(t)));
  await h.send(
    "late_read_window",
    h.readIx(t, 12),
    h.stranger,
    "OutsideWindow",
  );
  h.price(8_500_000_000n, t.t0 + 3600n);
  await h.send("late_mark", h.markIx(t), h.stranger, "FeedStale");
  const before = h.candleState(t);
  await h.send("settle_paid", h.settleIx(t, { buyerUsdc: undefined }));
  expect(h.candleState(t)).toEqual(before);
});
it("P3 rejects creating a new candle exactly at the cutoff", async () => {
  const h = await Harness.create();
  const t = await h.ref();
  h.clock(t.t0 - 5n);
  await h.send("candle_cutoff", h.openCandleIx(t), h.stranger, "BuyClosed");
  expect(h.svm.getAccount(t.candle).exists).toBe(false);
});
it("P10 validates funding accounts and configured mints", async () => {
  const h = await Harness.create({ setSpan: true });
  const t = await h.ref();
  await h.send("open_candle", h.openCandleIx(t));
  await h.send(
    "source_owner",
    h.openIx(t, 20_000_000n, { sellerSource: h.buyerUsdc }),
    h.seller,
    "WrongOwner",
  );
  await h.send(
    "usdc_mint",
    h.openIx(t, 20_000_000n, { usdcMint: h.spanMint }),
    h.seller,
    "WrongMint",
  );
  await h.send("open_ticket", h.openIx(t), h.seller);
  await h.send(
    "buyer_source",
    h.buyIx(t, { buyerSource: h.sellerUsdc }),
    h.buyer,
    "WrongOwner",
  );
  await h.send("buy", h.buyIx(t), h.buyer);
  await h.send(
    "span_mint",
    h.loadIx(t, { spanMint: h.configState().usdcMint }),
    h.buyer,
    "WrongMint",
  );
  const source = await h.fundToken(h.seller, h.spanMint, TOKEN, 1000n);
  await h.send(
    "span_owner",
    h.loadIx(t, { spanSource: source }),
    h.buyer,
    "WrongOwner",
  );
});
it("a buyer who is also the seller can receive both settlement transfers", async () => {
  const h = await Harness.create();
  h.buyer = h.seller;
  h.buyerUsdc = h.sellerUsdc;
  const t = await h.open({ sold: true });
  for (const [j, p] of [8_246_000_000n, 8_400_000_000n].entries()) {
    const ts = t.t0 + BigInt(j) * 300n;
    h.clock(ts);
    h.price(p, ts);
    await h.send("read", h.readIx(t, j));
  }
  const before = amount(h.svm, h.sellerUsdc);
  h.clock(settleAfter(h.candleState(t)));
  await h.send("settle_self", h.settleIx(t));
  expect(amount(h.svm, h.sellerUsdc) - before).toBe(40_000_000n);
  expect(h.svm.getAccount(t.ticket).exists).toBe(false);
});

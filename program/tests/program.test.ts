import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import {
  generateKeyPairSigner,
  getAddressEncoder,
  getAddressDecoder,
  address,
  lamports,
} from "@solana/kit";
import * as token from "@solana-program/token-2022";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  Harness,
  r,
  TOKEN,
  TOKEN_2022,
  USDC,
  SOL_FEED,
  BTC_FEED,
  PROGRAM,
  accountData,
  amount,
  measurements,
  sizes,
  rents,
  json,
  type Ref,
} from "./harness.js";
import { markAccepts, payout, settleAfter } from "../client/math.js";

const initIx = (h: Harness, o: Record<string, any> = {}) =>
  h.ix("init", {
    authority: h.admin,
    deployment: PROGRAM,
    programData: h.programData,
    admin: h.admin.address,
    readWindow: 20,
    ageLimit: 20,
    buyCutoff: 5,
    ...o,
  });
const setSpan = (h: Harness, o: Record<string, any> = {}) =>
  h.ix("setSpan", { admin: h.admin, burnPerMark: 100n, ...o });
const params = (h: Harness, o: Record<string, any> = {}) =>
  h.ix("setParams", {
    admin: h.admin,
    readWindow: 20,
    ageLimit: 20,
    buyCutoff: 5,
    ...o,
  });
async function read(h: Harness, t: Ref, j: number, price: bigint) {
  const ts = t.t0 + 300n * BigInt(j);
  h.clock(ts);
  h.price(price, ts);
  await h.send("read", h.readIx(t, j));
}
async function mark(
  h: Harness,
  t: Ref,
  p: bigint,
  ts = t.t0 + 1n,
  failure?: string,
) {
  h.clock(ts);
  h.price(p, ts);
  return h.send(
    `mark_${h.spanProgram === TOKEN ? "classic" : "2022"}`,
    h.markIx(t),
    h.stranger,
    failure,
  );
}
async function close(h: Harness, t: Ref, overrides: Record<string, any> = {}) {
  h.clock(settleAfter(h.candleState(t)));
  return h.send("settle", h.settleIx(t, overrides));
}
function closed(h: Harness, t: Ref) {
  expect(h.svm.getAccount(t.ticket).exists).toBe(false);
  expect(h.svm.getAccount(t.vault).exists).toBe(false);
  expect(h.svm.getAccount(t.spanHold).exists).toBe(false);
}

afterAll(() => {
  writeFileSync(
    new URL("../target/checks/measurements.json", import.meta.url),
    json({ measurements, sizes, rents }) + "\n",
  );
  console.log(
    "MEASUREMENTS " +
      json({
        measurements: Object.fromEntries(
          Object.entries(measurements).map(([k, v]) => [k, [...new Set(v)]]),
        ),
        sizes,
        rents,
      }),
  );
});

describe("P1 init and administration", () => {
  it("binds initialization to the upgrade authority and validates parameters, mint and feed", async () => {
    const h = await Harness.create({ initialize: false });
    await h.send(
      "unauthorized_init",
      initIx(h, { authority: h.stranger }),
      h.stranger,
      "NotUpgradeAuthority",
    );
    for (const field of ["readWindow", "ageLimit", "buyCutoff"]) {
      const [min, max] =
        field === "readWindow"
          ? [2, 60]
          : field === "ageLimit"
            ? [2, 120]
            : [1, 600];
      for (const value of [min - 1, max + 1])
        await h.send(
          "invalid_init_params",
          initIx(h, { [field]: value }),
          h.admin,
          "InvalidValue",
        );
    }
    const invalid = await generateKeyPairSigner();
    h.clone(USDC, invalid.address, (d) => (d[44] = 9));
    await h.send(
      "usdc_decimals",
      initIx(h, { usdcMint: invalid.address }),
      h.admin,
      "UsdcMintInvalid",
    );
    const raw = h.svm.getAccount(invalid.address);
    if (!raw.exists) throw Error();
    h.svm.setAccount({ ...raw, programAddress: TOKEN_2022 });
    await h.send(
      "usdc_program",
      initIx(h, { usdcMint: invalid.address }),
      h.admin,
      "UsdcMintInvalid",
    );
    for (const edit of [
      (d: Buffer) => {
        d[0] ^= 1;
      },
      (d: Buffer) => {
        d[176] = 247;
      },
      (d: Buffer) => {
        d.writeBigUInt64LE(0n, 168);
      },
    ]) {
      const bad = await generateKeyPairSigner();
      h.clone(SOL_FEED, bad.address, edit);
      await h.send(
        "bad_feed",
        initIx(h, { feed: bad.address }),
        h.admin,
        "FeedInvalid",
      );
    }
    const bad = await generateKeyPairSigner();
    h.clone(SOL_FEED, bad.address);
    const a = h.svm.getAccount(bad.address);
    if (!a.exists) throw Error();
    h.svm.setAccount({ ...a, programAddress: TOKEN });
    await h.send(
      "bad_owner",
      initIx(h, { feed: bad.address }),
      h.admin,
      "FeedInvalid",
    );
    h.svm.setAccount({ ...a, data: a.data.subarray(0, 393), space: 393n });
    await h.send(
      "bad_length",
      initIx(h, { feed: bad.address }),
      h.admin,
      "FeedInvalid",
    );
    await h.send(
      "btc_feed",
      initIx(h, { feed: BTC_FEED }),
      h.admin,
      "FeedAssetMismatch",
    );
    h.price(1n, 979n);
    await h.send("stale_init", initIx(h), h.admin, "FeedStale");
    h.price(1n, 1000n);
    await h.send("init", initIx(h), h.admin);
    await h.send("second_init", initIx(h), h.admin, "");
    await h.send(
      "not_admin",
      params(h, { admin: h.stranger }),
      h.stranger,
      "NotAdmin",
    );
    await h.send(
      "not_admin",
      setSpan(h, { admin: h.stranger }),
      h.stranger,
      "NotAdmin",
    );
    await h.send(
      "zero_burn",
      setSpan(h, { burnPerMark: 0n }),
      h.admin,
      "InvalidValue",
    );
    for (const [field, min, max] of [
      ["readWindow", 2, 60],
      ["ageLimit", 2, 120],
      ["buyCutoff", 1, 600],
    ] as const) {
      for (const value of [min - 1, max + 1])
        await h.send(
          "invalid_params",
          params(h, { [field]: value }),
          h.admin,
          "InvalidValue",
        );
      for (const value of [min, max])
        await h.send("params", params(h, { [field]: value }));
    }
    await h.send("params", params(h));
    await h.send("set_span", setSpan(h));
    await h.send("second_span", setSpan(h), h.admin, "SpanAlreadySet");
  });
  it("rejects mutable or disruptive SPAN mint extensions", async () => {
    const h = await Harness.create();
    for (const [kind, error] of [
      ["freeze", "FreezeAuthorityMint"],
      ["delegate", "PermanentDelegateMint"],
      ["pause", "PausableMint"],
      ["paused", "PausableMint"],
      ["hook", "TransferHookActive"],
      ["hook-authority", "TransferHookActive"],
      ["fee", "TransferFeeMint"],
      ["frozen", "DefaultStateFrozen"],
    ] as const) {
      const mint = await h.createMint(
        kind === "freeze" ? TOKEN : TOKEN_2022,
        kind,
      );
      if (kind === "frozen")
        await h.send(
          "remove_freeze",
          token.getSetAuthorityInstruction({
            owned: mint,
            owner: h.admin,
            authorityType: token.AuthorityType.FreezeAccount,
            newAuthority: null,
          }),
        );
      await h.send(
        `reject_${kind}`,
        setSpan(h, { spanMint: mint }),
        h.stranger,
        error,
      );
    }
  });
  it("snapshots parameters and switches an open candle to a new SOL feed", async () => {
    const h = await Harness.create({ setSpan: true });
    const t = await h.open({ loaded: true });
    const old = h.candleState(t);
    await h.send(
      "params",
      params(h, { readWindow: 30, ageLimit: 40, buyCutoff: 6 }),
    );
    expect(h.candleState(t)).toEqual(old);
    const t2 = await h.ref(1260n);
    await h.send("open_candle", h.openCandleIx(t2));
    expect(h.candleState(t2)).toMatchObject({
      readWindow: 30,
      ageLimit: 40,
      buyCutoff: 6,
    });
    const next = (await generateKeyPairSigner()).address;
    h.clone(SOL_FEED, next);
    await h.send(
      "set_feed_btc",
      h.ix("setFeed", { admin: h.admin, feed: BTC_FEED }),
      h.stranger,
      "FeedAssetMismatch",
    );
    await h.send("set_feed", h.ix("setFeed", { admin: h.admin, feed: next }));
    h.clock(t.t0);
    h.price(8_246_000_000n, t.t0, next);
    await h.send("old_feed_read", h.readIx(t, 0), h.stranger, "FeedNotConfig");
    await h.send("read", h.readIx(t, 0, { feed: next }));
    h.clock(t.t0 + 1n);
    h.price(8_300_000_000n, t.t0 + 1n, next);
    await h.send("old_feed_mark", h.markIx(t), h.stranger, "FeedNotConfig");
    await h.send("mark", h.markIx(t, { feed: next }));
  });
});

describe("P3 P4 P5 sale and account creation", () => {
  it("handles sale cutoffs, IDs, duplicate candles, premiums and withdrawal", async () => {
    const h = await Harness.create({ setSpan: true });
    const t = await h.ref();
    await h.send(
      "bad_t0",
      h.openCandleIx({
        ...t,
        t0: 1201n,
        candle: (
          await import("../client/pdas.js").then((x) => x.findCandlePda(1201n))
        )[0],
      }),
      h.stranger,
      "InvalidValue",
    );
    h.clock(1194n);
    await h.send("open_candle", h.openCandleIx(t));
    h.measure("Config", h.config);
    h.measure("Candle", t.candle);
    const before = accountData(h.svm, t.candle),
      rent = h.svm.getAccount(t.candle);
    await h.send("duplicate_candle", h.openCandleIx(t));
    expect(h.events).toEqual([]);
    expect(accountData(h.svm, t.candle)).toEqual(before);
    expect(h.svm.getAccount(t.candle)).toEqual(rent);
    h.clock(1195n);
    await h.send("open_closed", h.openIx(t), h.seller, "BuyClosed");
    await h.send("existing_after_cutoff", h.openCandleIx(t));
    expect(h.events).toEqual([]);
    h.clock(1194n);
    const wrong = await h.ref(1200n, 1n);
    await h.send("wrong_id", h.openIx(wrong), h.seller, "IdMismatch");
    for (const p of [99_999n, 39_000_001n])
      await h.send("bad_premium", h.openIx(t, p), h.seller, "InvalidValue");
    await h.send("open_ticket", h.openIx(t, 1_000_000n), h.seller);
    expect(amount(h.svm, t.vault)).toBe(39_000_000n);
    h.measure("Ticket", t.ticket);
    h.measure("Vault", t.vault);
    await h.send("duplicate_id", h.openIx(t), h.seller, "IdMismatch");
    h.clock(1195n);
    await h.send("buy_closed", h.buyIx(t), h.buyer, "BuyClosed");
    h.clock(1194n);
    await h.send("buy", h.buyIx(t), h.buyer);
    await h.send("second_buy", h.buyIx(t), h.buyer, "NotOpen");
    await h.send("withdraw_sold", h.withdrawIx(t), h.stranger, "NotOpen");
    const t2 = await h.ref();
    await h.send("open_ticket", h.openIx(t2, 39_000_000n), h.seller);
    expect(amount(h.svm, t2.vault)).toBe(1_000_000n);
    await h.send(
      "withdraw_other",
      h.withdrawIx(t2, { seller: h.admin }),
      h.stranger,
      "NotSeller",
    );
    h.clock(1300n);
    const sellerSol = h.svm.getAccount(h.seller.address);
    await h.send("withdraw", h.withdrawIx(t2));
    closed(h, t2);
    expect(h.events[0].name).toBe("Withdrawn");
    expect(h.svm.getAccount(h.seller.address).exists).toBe(true);
    expect(sellerSol.exists).toBe(true);
  });
  for (const program of [TOKEN, TOKEN_2022])
    it(`loads and rejects invalid loads ${program}`, async () => {
      const h = await Harness.create({ spanProgram: program });
      const t = await h.open();
      await h.send("not_sold", h.loadIx(t), h.buyer, "NotSold");
      await h.send("buy", h.buyIx(t), h.buyer);
      await h.send("span_unset", h.loadIx(t), h.buyer, "SpanNotSet");
      await h.send("set_span", setSpan(h));
      await h.send(
        "not_buyer",
        h.loadIx(t, { buyer: h.admin, spanSource: h.buyerSpan }),
        h.admin,
        "NotBuyer",
      );
      await h.send(
        "step",
        h.loadIx(t, { stepBps: 3 }),
        h.buyer,
        "StepNotAllowed",
      );
      await h.send(
        "amount",
        h.loadIx(t, { amount: 99n }),
        h.buyer,
        "InvalidValue",
      );
      h.clock(1195n);
      await h.send("load_closed", h.loadIx(t), h.buyer, "BuyClosed");
      h.clock(1000n);
      await h.send("load_span", h.loadIx(t), h.buyer);
      h.measure(program === TOKEN ? "SpanClassic" : "Span2022", t.spanHold);
      await h.send("second_load", h.loadIx(t), h.buyer, "AlreadyLoaded");
    });
});

describe("P6 reads", () => {
  it("checks indices, opening read, windows, staleness and future publication", async () => {
    const h = await Harness.create();
    const t = await h.open();
    await h.send("invalid_j", h.readIx(t, 13), h.stranger, "InvalidValue");
    h.clock(2100n);
    h.price(8_246_000_000n, 2100n);
    await h.send("no_open", h.readIx(t, 3), h.stranger, "NoOpen");
    h.clock(1199n);
    h.price(8_246_000_000n, 1200n);
    await h.send(
      "before_boundary",
      h.readIx(t, 0),
      h.stranger,
      "BeforeBoundary",
    );
    h.clock(1200n);
    h.price(8_246_000_000n, 1199n);
    await h.send("before_window", h.readIx(t, 0), h.stranger, "OutsideWindow");
    h.price(8_246_000_000n, 1221n);
    await h.send("after_window", h.readIx(t, 0), h.stranger, "OutsideWindow");
    h.price(8_246_000_000n, 1200n);
    h.clock(1221n);
    await h.send("stale_read", h.readIx(t, 0), h.stranger, "FeedStale");
    h.clock(1220n);
    await h.send("read", h.readIx(t, 0));
    await h.send("read_filled", h.readIx(t, 0), h.stranger, "ReadFilled");
    h.clock(1519n);
    h.price(8_300_000_000n, 1520n);
    await h.send("read_future", h.readIx(t, 1));
    h.clock(2100n);
    h.price(8_200_000_000n, 2100n);
    await h.send("read", h.readIx(t, 3));
    const c = h.candleState(t);
    expect(c.reads[2].price).toBe(0n);
    expect(c.readHigh).toBe(8_300_000_000n);
    expect(c.readLow).toBe(8_200_000_000n);
  });
});

describe("P7 marks", () => {
  for (const program of [TOKEN, TOKEN_2022])
    it(`checks extension precision, permission, burn and cap ${program}`, async () => {
      const h = await Harness.create({ spanProgram: program, setSpan: true });
      const t = await h.open({ loaded: true });
      const short = await h.ref();
      await h.send("open", [h.openCandleIx(short), h.openIx(short)], h.seller);
      await h.send(
        "buy_load",
        [h.buyIx(short), h.loadIx(short, { amount: 199n })],
        h.buyer,
      );
      await mark(h, t, 8_300_000_000n, t.t0 + 1n, "NoOpen");
      await read(h, t, 0, 8_246_000_000n);
      for (const signer of [h.admin, h.buyer, h.seller])
        await h.send(
          "not_marker",
          h.markIx(t, { marker: signer }),
          h.stranger,
          "NotMarker",
        );
      await mark(h, t, 8_300_000_000n, t.t0, "OutsideCandle");
      const supply = accountData(h.svm, h.spanMint).readBigUInt64LE(36),
        balance = amount(h.svm, t.spanHold);
      await mark(h, t, 8_300_000_000n);
      expect(amount(h.svm, t.spanHold)).toBe(balance - 100n);
      expect(accountData(h.svm, h.spanMint).readBigUInt64LE(36)).toBe(
        supply - 100n,
      );
      await mark(h, t, 8_304_122_999n, t.t0 + 2n, "NotExtension");
      await mark(h, t, 8_304_123_000n, t.t0 + 2n);
      await mark(h, t, 8_304_123_000n, t.t0 + 2n, "NotExtension");
      await mark(h, t, 8_200_000_000n, t.t0 + 3n);
      await mark(h, t, 8_195_877_001n, t.t0 + 4n, "NotExtension");
      await mark(h, t, 8_195_877_000n, t.t0 + 4n);
      h.clock(1225n);
      h.price(8_400_000_000n, 1204n);
      await h.send("stale_mark", h.markIx(t), h.stranger, "FeedStale");
      await mark(h, t, 8_400_000_000n, t.t0 + 3601n, "OutsideCandle");
      await mark(h, short, 8_300_000_000n, t.t0 + 5n);
      expect(amount(h.svm, short.spanHold)).toBe(99n);
      await mark(h, short, 8_400_000_000n, t.t0 + 3600n, "SpanShort");
      await mark(h, t, 8_700_000_000n, t.t0 + 3600n);
      await mark(h, t, 8_800_000_000n, t.t0 + 3600n, "CapReached");
    });
  it("uses the newest read as the next extension baseline and exact integer thresholds", async () => {
    const h = await Harness.create({ setSpan: true });
    const t = await h.open({ loaded: true });
    await read(h, t, 0, 8_246_000_001n);
    await mark(h, t, 8_300_000_000n);
    await mark(h, t, 8_304_123_000n, t.t0 + 2n, "NotExtension");
    await mark(h, t, 8_304_123_001n, t.t0 + 2n);
    await read(h, t, 1, 8_350_000_000n);
    await mark(h, t, 8_354_123_000n, t.t0 + 301n, "NotExtension");
    await mark(h, t, 8_354_123_001n, t.t0 + 301n);
  });
});

describe("P8 P11 settlement, conservation and receipts", () => {
  it("settles two tickets using the same 13 reads and individual tails", async () => {
    const h = await Harness.create({ setSpan: true });
    const sellerStart = h.svm.getAccount(h.seller.address);
    const t = await h.open({ loaded: true });
    const plain = await h.open({ sold: true });
    const values = [
      8246000000n,
      8272000000n,
      8299000000n,
      8339000000n,
      8355000000n,
      8349000000n,
      8310000000n,
      8284000000n,
      8249000000n,
      8258000000n,
      8268000000n,
      8192000000n,
      8249000000n,
    ];
    await read(h, t, 0, values[0]);
    await mark(h, t, 8377000000n);
    await mark(h, t, 8184000000n, t.t0 + 2n);
    for (let j = 1; j < 13; j++) await read(h, t, j, values[j]);
    const candle = h.candleState(t);
    expect(payout(candle, h.ticketState(t))).toBe(23405287n);
    expect(payout(candle, h.ticketState(plain))).toBe(19767159n);
    h.clock(settleAfter(candle) - 1n);
    await h.send("early_settle", h.settleIx(t), h.stranger, "NotClosed");
    h.clock(settleAfter(candle));
    h.price(8249000000n, t.t0 + 3620n);
    await h.send("settle_read", h.readIx(t, 12), h.stranger, "ReadFilled");
    h.price(9000000000n, t.t0 + 3600n);
    await h.send("settle_mark", h.markIx(t), h.stranger, "FeedStale");
    const beforeBuyer = amount(h.svm, h.buyerUsdc),
      beforeSeller = amount(h.svm, h.sellerUsdc),
      span = amount(h.svm, t.spanHold);
    await close(h, t);
    const e = h.events[0];
    expect(e.name).toBe("Settled");
    if (e.name !== "Settled") throw Error();
    expect(e.data).toMatchObject({
      payout: 23405287n,
      toBuyer: 23405287n,
      toSeller: 16594713n,
      spanReturned: span,
      marks: 2,
      reads: 8191,
    });
    expect(amount(h.svm, h.buyerUsdc) - beforeBuyer).toBe(23405287n);
    expect(amount(h.svm, h.sellerUsdc) - beforeSeller).toBe(16594713n);
    closed(h, t);
    await h.send(
      "second_settle",
      h.settleIx(plain, { ticket: t.ticket, vault: t.vault }),
      h.stranger,
      "",
    );
    await close(h, plain);
    expect(h.candleState(plain)).toEqual(candle);
    closed(h, plain);
    const sellerEnd = h.svm.getAccount(h.seller.address);
    if (!sellerStart.exists || !sellerEnd.exists) throw Error();
    expect(sellerStart.lamports - sellerEnd.lamports).toBe(20_000n);
  });
  it("handles payout cap, floor rounding, zero recipients, Void and Unsold", async () => {
    for (const [p0, high, low, expected] of [
      [10000000000n, 10240000000n, 9840000000n, 40000000n],
      [10000000000n, 10240000000n, 9840000001n, 39999999n],
      [10000000000n, 10400000000n, 9700000000n, 40000000n],
      [8246000000n, 8246000000n, 8246000000n, 0n],
      [8246000000n, 8246000001n, 8246000000n, 0n],
    ]) {
      const h = await Harness.create();
      const t = await h.open({ sold: true });
      await read(h, t, 0, p0);
      await read(h, t, 1, high);
      await read(h, t, 2, low);
      await close(h, t, {
        buyerUsdc: expected === 0n ? undefined : h.buyerUsdc,
        sellerUsdc: expected === 40000000n ? undefined : h.sellerUsdc,
      });
      expect(h.events[0].name).toBe("Settled");
      expect((h.events[0].data as any).payout).toBe(expected);
      closed(h, t);
    }
    for (const sold of [false, true]) {
      const h = await Harness.create({ setSpan: true });
      const t = await h.open({ sold, loaded: sold });
      await close(h, t);
      expect((h.events[0].data as any).outcome).toBe(
        sold ? r.Outcome.Void : r.Outcome.Unsold,
      );
      closed(h, t);
    }
  });
});

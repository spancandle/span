import { resolve } from "node:path";
import { address, unwrapOption, type Address, type TransactionSigner } from "@solana/kit";
import * as s from "../../../program/client/index.js";
import { cluster, ROOT, json, feeBounds } from "../common/env.js";
import { log, safeError } from "../common/log.js";
import { RpcPool } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { Chain, signerFile, settlement } from "./chain.js";
import { HeightRecord, CreationBudget } from "./budget.js";
import { PriorityFees } from "./priority.js";
import { prepareTransaction, Sender, type Action } from "./sender.js";
import { Engine } from "./engine.js";
import { Overlay } from "./overlay.js";
import { RELEASE_HOURS } from "../common/release-hours.js";
import { keeperTelemetry } from "../common/telemetry.js";
/** The same preparation path is used by the running keeper and read-only simulations. */
export async function createPrepare(
  rpc: RpcPool,
  payer: TransactionSigner,
  chain: Chain,
  priorities: Pick<PriorityFees, "register">,
  latest: () => { blockhash: any; lastValidBlockHeight: bigint } | undefined,
) {
  const eventAuthority = (await s.findEventAuthorityPda())[0],
    config = chain.configKey;
  let candleRent: Promise<bigint> | undefined;
  return async (a: Action, fee: bigint) => {
    const hash = latest();
    if (!hash || !chain.config) throw Error("Preparation unavailable");
    if (a.kind === "open") {
      const candle = (await s.findCandlePda(a.t0))[0];
      const ix = s.getOpenCandleInstruction({ config, payer, candle,
        systemProgram: address("11111111111111111111111111111111"),
        eventAuthority, program: s.SPAN_PROGRAM_ADDRESS, t0: a.t0 });
      candleRent ??= rpc.call("getMinimumBalanceForRentExemption", [247])
        .then((v) => BigInt(v)).catch((e) => { candleRent = undefined; throw e; });
      const rent = await candleRent;
      priorities.register(a.key, [ix], payer.address);
      return prepareTransaction([ix], payer, hash, a, fee, rent);
    }
    const candle = [...chain.candles].find((x) => x[1].value.t0 === a.t0)![0];
    if (a.kind === "settle") {
      const t = chain.tickets.get(address(a.ticket!));
      if (!t) throw Error("Ticket closed");
      const built = await settlement(
        rpc,
        payer,
        chain.config,
        chain.candles.get(candle)!.value,
        t.value,
        address(a.ticket!),
      );
      priorities.register(a.key, built.ixs, payer.address);
      return prepareTransaction(built.ixs, payer, hash, a, fee, built.rent);
    }
    const accounts = {
      config,
      candle,
      feed: chain.config.feed,
      eventAuthority,
      program: s.SPAN_PROGRAM_ADDRESS,
    };
    const ix =
      a.kind === "read"
        ? s.getReadInstruction({ ...accounts, j: a.j! })
        : s.getMarkInstruction({
            ...accounts,
            marker: payer,
            ticket: address(a.ticket!),
            spanMint: unwrapOption(chain.config.spanMint)!,
            spanHold: (await s.findSpanHoldPda(address(a.ticket!)))[0],
            spanTokenProgram: unwrapOption(chain.config.spanTokenProgram)!,
          });
    priorities.register(a.key, [ix], payer.address);
    return prepareTransaction([ix], payer, hash, a, fee);
  };
}
export async function runKeeper() {
  const c = cluster();
  if (c === "mainnet" && process.env.KEEPER_ALLOW_MAINNET !== "1")
    throw Error("Mainnet keeper is disabled");
  const payer = await signerFile(
    resolve(ROOT, process.env.KEEPER_KEYPAIR || `keys/${c}-keeper.json`),
  );
  const rpc = new RpcPool(c);
  await rpc.initialize();
  const ws = new Subscriptions(rpc),
    chain = new Chain(rpc, ws);
  await chain.init();
  const record = new HeightRecord(
    resolve(
      ROOT,
      process.env.KEEPER_DATA_DIR || "keeper/data",
      `${c}-keeper.json`,
    ),
  );
  const budget = new CreationBudget(
    rpc,
    payer.address,
    BigInt(process.env.KEEPER_CREATE_BUDGET_LAMPORTS || 50000000),
    record.loaded,
  );
  const bounds = feeBounds();
  const priorities = new PriorityFees(rpc, bounds.min, bounds.max);
  let latest: { blockhash: any; lastValidBlockHeight: bigint } | undefined;
  const sender = new Sender(
    rpc,
    ws,
    () => chain.slot,
    () => chain.height,
    () => chain.now(),
  );
  const prepare = await createPrepare(rpc, payer, chain, priorities, () => latest);
  const engine = new Engine(
    chain,
    payer.address,
    {
      blockhash: () => latest?.blockhash,
      price: (a) => priorities.price(a.key),
      prepare,
      send: (p, v) => sender.send(p, v),
      cancel: (key) => sender.cancel(key),
    },
    budget,
    log,
    process.env.KEEPER_RELEASE_HOURS === "1" ? RELEASE_HOURS : [],
  );
  sender.done = (p, e, stage) => {
    engine.result(p, e, stage);
    if (
      e &&
      [
        "NotMarker",
        "NotSold",
        "NotLoaded",
        "WrongOwner",
        "WrongMint",
        "MissingAccount",
      ].includes(e)
    )
      void chain
        .pollPrograms()
        .then(() => engine.update())
        .catch(() => {});
  };
  chain.onChange = () => engine.update();
  chain.onFeed = () => engine.update();
  chain.onSlot = () => {
    sender.onSlot();
    engine.update();
  };
  const overlay = new Overlay(chain, sender);
  let busy = false;
  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      const [hash, height] = await Promise.all([
        rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]),
        rpc.call("getBlockHeight", [{ commitment: "processed" }]),
      ]);
      record.save(BigInt(hash.value.lastValidBlockHeight));
      latest = {
        blockhash: hash.value.blockhash,
        lastValidBlockHeight: BigInt(hash.value.lastValidBlockHeight),
      };
      chain.height = BigInt(height);
      engine.update();
    } catch {
      log({ event: "blockhash-unavailable" });
    } finally {
      busy = false;
    }
  };
  await refresh();
  overlay.start();
  void budget.reconcile().then(() => engine.update());
  const timers = [
    setInterval(() => void refresh(), 2000),
    setInterval(() => engine.update(), 50),
    setInterval(() => void priorities.refresh(), 100),
    setInterval(
      () => void budget.reconcile().then(() => engine.update()),
      60000,
    ),
    setInterval(
      () =>
        void rpc
          .call("getBalance", [payer.address, { commitment: "processed" }])
          .then((v) =>
            log({
              event: "minute",
              address: payer.address,
              subscription: ws.ready,
              endpoint: ws.endpoint,
              candles: [...chain.candles.values()].filter(
                ({ value: c }) =>
                  chain.now() >= c.t0 - 30n &&
                  chain.now() <= s.settleAfter(c) + 60n,
              ).length,
              tickets: [...chain.tickets.values()].filter(({ value: t }) =>
                [...chain.candles.values()].some(
                  ({ value: c }) =>
                    c.t0 === t.t0 &&
                    chain.now() >= c.t0 - 30n &&
                    chain.now() <= s.settleAfter(c) + 60n,
                ),
              ).length,
              rss: process.memoryUsage().rss,
              cpu: process.resourceUsage(),
              balance: v.value,
              lowBalance: v.value < 50000000,
              rpc: rpc.metrics.snapshot(),
              creationBudget: {
                ready: budget.ready,
                used: budget.used,
                reserved: budget.reserved(),
                waiting: budget.waiting.size,
              },
            }),
          )
          .catch(() => {}),
      60000,
    ),
  ];
  const closeTelemetry = keeperTelemetry(
    resolve(ROOT, process.env.KEEPER_DATA_DIR || "keeper/data"),
    c,
    payer.address,
    () => ({
      address: payer.address,
      ready: budget.ready,
      used: budget.used,
      reserved: budget.reserved(),
      waiting: budget.waiting.size,
      generated: Date.now(),
    }),
  );
  log({ event: "keeper-ready", cluster: c, address: payer.address });
  const close = () => {
    closeTelemetry();
    timers.forEach(clearInterval);
    engine.close();
    sender.close();
    overlay.close();
    rpc.close();
  };
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });
  return { close, engine, chain, rpc, budget };
}
if (process.argv[1]?.endsWith("/keeper/main.ts"))
  void runKeeper().catch((e) => {
    log({ event: "fatal", error: safeError(e) });
    process.exitCode = 1;
  });

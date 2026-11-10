import { findAssociatedTokenPda, getTokenDecoder, AccountState } from "@solana-program/token";
import { TOKEN } from "../../../program/client/constants.js";
import { ASSETS, assetOf, feedOf, type Asset } from "../../../program/client/assets.js";
import { resolve } from "node:path";
import { address, unwrapOption, type Address, type TransactionSigner } from "@solana/kit";
import * as s from "../../../program/client/index.js";
import { cluster, ROOT, json, feeBounds } from "../common/env.js";
import { log, safeError } from "../common/log.js";
import { RpcPool } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { Chain, signerFile, settlement, bytes, CLOCK } from "./chain.js";
import { HeightRecord, CreationBudget } from "./budget.js";
import { PriorityFees } from "./priority.js";
import { prepareTransaction, Sender, type Action } from "./sender.js";
import { Engine, BidderAccountUnavailable } from "./engine.js";
import { Overlay } from "./overlay.js";
import { RELEASE_HOURS } from "../common/release-hours.js";
import { OPEN_HOURS } from "../common/open-hours.js";
import { EventHoursFile, eventHoursPath } from "../common/event-hours.js";
import { keeperTelemetry } from "../common/telemetry.js";
import { readerOptions, type ReaderOptions } from "./reader-policy.js";
import { keeperLock } from "./lock.js";
import { loadReaders, checkReaderSigner } from "../common/readers.js";
/** The same preparation path is used by the running keeper and read-only simulations. */
export async function createPrepare(
  rpc: RpcPool,
  payer: TransactionSigner,
  chain: Chain,
  priorities: Pick<PriorityFees, "register">,
  latest: () => { blockhash: any; lastValidBlockHeight: bigint } | undefined,
  options: ReaderOptions = readerOptions(),
) {
  const mode = readerOptions(options.mode, options.policy).mode;
  const eventAuthority = (await s.findEventAuthorityPda())[0],
    config = chain.configKey;
  let candleRent: Promise<bigint> | undefined;
  return async (a: Action, fee: bigint) => {
    if (mode === "marks" && a.kind !== "mark") throw Error("Marks-only keeper cannot prepare this action");
    const hash = latest();
    if (!hash) throw Error("Preparation unavailable");
    if (a.kind === "closeRequest") {
      const request=address(a.request!),value=chain.requests.get(request)?.value,config=chain.config;
      if (!value || !config) throw Error("Request preparation unavailable");
      const clock=await rpc.call("getAccountInfo",[CLOCK,{encoding:"base64",commitment:"confirmed"}]);
      const data=bytes(clock?.value);
      if (data.length < 40 || data.readBigInt64LE(32) <= value.until) throw Error("Request still live");
      const destination=async(mint:Address,program:Address)=>{
        const ata=(await findAssociatedTokenPda({owner:value.requester,mint,tokenProgram:program}))[0];
        const row=(await rpc.call("getAccountInfo",[ata,{encoding:"base64",commitment:"confirmed"}]))?.value;
        try {
          const data=bytes(row);
          if (row?.owner !== program || data.length < 165) throw new BidderAccountUnavailable("Requester token account unavailable");
          const token=getTokenDecoder().decode(data.subarray(0,165));
          if (token.owner !== value.requester || token.mint !== mint || token.state !== AccountState.Initialized) throw new BidderAccountUnavailable("Invalid requester token account");
        } catch (error) {
          if (error instanceof BidderAccountUnavailable) throw error;
          throw new BidderAccountUnavailable("Invalid requester token account");
        }
        return ata;
      };
      const requesterUsdc=await destination(config.usdcMint,TOKEN),loaded=value.spanAmount>0n,
        spanMint=loaded?unwrapOption(config.spanMint):undefined,spanTokenProgram=loaded?unwrapOption(config.spanTokenProgram):undefined;
      if (loaded && (!spanMint || !spanTokenProgram)) throw Error("SPAN unavailable");
      const ix=s.getCloseRequestInstruction({request,requester:value.requester,closer:payer,
        requestUsdc:(await s.findRequestUsdcPda(request))[0],requesterUsdc,usdcMint:config.usdcMint,tokenProgram:TOKEN,
        requestSpan:loaded?(await s.findRequestSpanPda(request))[0]:undefined,
        requesterSpan:loaded?await destination(spanMint!,spanTokenProgram!):undefined,
        spanMint:spanMint??undefined,spanTokenProgram:spanTokenProgram??undefined,eventAuthority,program:s.SPAN_PROGRAM_ADDRESS});
      priorities.register(a.key,[ix],payer.address);
      return prepareTransaction([ix],payer,hash,a,fee);
    }
    if (a.kind === "closeBid") {
      const bid=address(a.bid!),value=chain.bids.get(bid)?.value,config=chain.config;
      if (!value || !config) throw Error("Bid preparation unavailable");
      const observed=await rpc.call("getAccountInfo",[value.ticket,{encoding:"base64",commitment:"confirmed"}]);
      if (!observed || !("value" in observed)) throw Error("Ticket unavailable");
      if (observed.value?.owner === s.SPAN_PROGRAM_ADDRESS && bytes(observed.value).length > 0) {
        const clock=await rpc.call("getAccountInfo",[CLOCK,{encoding:"base64",commitment:"confirmed"}]);
        const data=bytes(clock?.value);
        if (data.length < 40 || data.readBigInt64LE(32) <= value.until) throw Error("Bid still live");
      }
      const destination=async(mint:Address,program:Address)=>{
        const ata=(await findAssociatedTokenPda({owner:value.bidder,mint,tokenProgram:program}))[0];
        const row=(await rpc.call("getAccountInfo",[ata,{encoding:"base64",commitment:"confirmed"}]))?.value;
        try {
          const data=bytes(row);
          if (row?.owner !== program || data.length < 165) throw new BidderAccountUnavailable("Bidder token account unavailable");
          const token=getTokenDecoder().decode(data.subarray(0,165));
          if (token.owner !== value.bidder || token.mint !== mint || token.state !== AccountState.Initialized) throw new BidderAccountUnavailable("Invalid bidder token account");
        } catch (error) {
          if (error instanceof BidderAccountUnavailable) throw error;
          throw new BidderAccountUnavailable("Invalid bidder token account");
        }
        return ata;
      };
      const bidderUsdc=await destination(config.usdcMint,TOKEN),loaded=value.spanAmount>0n,
        spanMint=loaded?unwrapOption(config.spanMint):undefined,spanTokenProgram=loaded?unwrapOption(config.spanTokenProgram):undefined;
      if (loaded && (!spanMint || !spanTokenProgram)) throw Error("SPAN unavailable");
      const ix=s.getCloseBidInstruction({bid,ticket:value.ticket,bidder:value.bidder,closer:payer,
        bidUsdc:(await s.findBidUsdcPda(bid))[0],bidderUsdc,usdcMint:config.usdcMint,tokenProgram:TOKEN,
        bidSpan:loaded?(await s.findBidSpanPda(bid))[0]:undefined,
        bidderSpan:loaded?await destination(spanMint!,spanTokenProgram!):undefined,
        spanMint:spanMint??undefined,spanTokenProgram:spanTokenProgram??undefined,eventAuthority,program:s.SPAN_PROGRAM_ADDRESS});
      priorities.register(a.key,[ix],payer.address);
      return prepareTransaction([ix],payer,hash,a,fee);
    }
    if (a.kind === "closeResale") {
      const key=address(a.resale!),value=chain.resales.get(key)?.value;
      if (!value) throw Error("Resale closed");
      const observed=await rpc.call("getAccountInfo",[value.ticket,{encoding:"base64",commitment:"confirmed"}]);
      if (observed?.value !== null) throw Error("Ticket still present");
      const ix=s.getCloseResaleInstruction({resale:key,ticket:value.ticket,holder:value.holder,closer:payer,eventAuthority,program:s.SPAN_PROGRAM_ADDRESS});
      priorities.register(a.key,[ix],payer.address);
      return prepareTransaction([ix],payer,hash,a,fee);
    }
    if (a.kind === "closeUntil") {
      const key = address(a.until!), value = chain.untils.get(key)?.value;
      if (!value) throw Error("Until closed");
      const observed = await rpc.call("getAccountInfo", [value.ticket, {encoding:"base64",commitment:"confirmed"}]);
      if (observed?.value !== null) throw Error("Ticket still present");
      const ix = s.getCloseUntilInstruction({until:key,ticket:value.ticket,seller:value.seller,closer:payer,eventAuthority,program:s.SPAN_PROGRAM_ADDRESS});
      priorities.register(a.key,[ix],payer.address);
      return prepareTransaction([ix],payer,hash,a,fee);
    }
    if (!chain.config) throw Error("Preparation unavailable");
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
      feed: await feedOf(assetOf(a.t0),chain.config.feed,rpc.cluster),
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
export function keeperAssets(value=process.env.KEEPER_ASSETS??'SOL'): Asset[] {
  const names=value.split(',').map(s=>s.trim());
  if(!names.length||names.some(n=>!ASSETS.includes(n as any)))throw Error('Invalid KEEPER_ASSETS');
  return [...new Set(names.map(n=>ASSETS.indexOf(n as any) as Asset))];
}
export const halfHoursEnabled=()=>process.env.KEEPER_HALF_HOURS==='1';
export const releaseStarts=(hours:readonly bigint[],assets:readonly Asset[],half=halfHoursEnabled())=>hours.flatMap(t0=>assets.flatMap(a=>half?[t0+BigInt(a),t0+3n+BigInt(a)]:[t0+BigInt(a)]));
export const listedStarts=(hours:readonly bigint[],assets:readonly Asset[],half=halfHoursEnabled())=>[...hours,...(half?hours.flatMap(t0=>assets.map(a=>t0+3n+BigInt(a))):[])];
export async function runKeeper(options: {releaseHours?:readonly bigint[]} = {}) {
  const reader = readerOptions(process.env.KEEPER_ACTION_MODE, process.env.KEEPER_MARK_POLICY),
    readers = loadReaders(process.env.SPAN_READERS_FILE ? resolve(ROOT, process.env.SPAN_READERS_FILE) : undefined);
  let assets: Asset[];
  try { assets=keeperAssets(); }catch(error){log({event:'invalid-assets'});throw error;}
  log({event:'assets',assets:assets.map(a=>ASSETS[a])});
  const c = cluster();
  if (c === "mainnet" && process.env.KEEPER_ALLOW_MAINNET !== "1")
    throw Error("Mainnet keeper is disabled");
  const payer = await signerFile(
    resolve(ROOT, process.env.KEEPER_KEYPAIR || `keys/${c}-keeper.json`),
  );
  checkReaderSigner(readers, payer.address, reader);
  const cleanup: (() => void)[] = [keeperLock(ROOT, c, payer.address)];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const stop of cleanup.reverse()) { try { stop(); } catch { log({event:"keeper-close-error"}); } }
  };
  try {
  const rpc = new RpcPool(c);
  cleanup.push(() => rpc.close());
  await rpc.initialize();
  const ws = new Subscriptions(rpc),
    chain = new Chain(rpc, ws, log, payer.address);
  let stopChain = () => chain.close();
  cleanup.push(() => stopChain());
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
  cleanup.push(() => sender.close());
  const prepare = await createPrepare(rpc, payer, chain, priorities, () => latest, reader);
  const releases = reader.mode === "marks" ? [] : [
    ...releaseStarts(options.releaseHours ?? (process.env.KEEPER_RELEASE_HOURS === "1" ? RELEASE_HOURS : []),assets),
    ...(process.env.KEEPER_OPEN_HOURS === "1" ? OPEN_HOURS : []),
  ];
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
    releases,
    reader,
  );
  cleanup.push(() => engine.close());
  /* listed hours join the release hours on the same path, read again whenever the file changes */
  const listPath = reader.mode === "marks" ? undefined : eventHoursPath();
  let stopHours = () => {};
  cleanup.push(() => stopHours());
  if (listPath) {
    const listed = new EventHoursFile(listPath),
      apply = () => {
        engine.listHours([...releases, ...listedStarts(listed.t0s(),assets)]);
        log({ event: "hours", listed: listed.hours.length });
        engine.update();
      };
    listed.read();
    apply();
    stopHours = listed.watch(apply);
  }
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
  const activity = reader.mode === "marks" ? () => chain.ownWork() || sender.flights.size > 0 : undefined;
  const overlay = new Overlay(chain, sender, activity);
  stopChain = () => overlay.close();
  let busy = false;
  let refreshedAt = 0;
  const refresh = async () => {
    if (busy) return;
    busy = true;
    if (reader.mode === "marks") refreshedAt = Date.now();
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
  let hadOwnWork = reader.mode === "marks" && chain.ownWork(), refreshOnWork = false;
  const timers = [
    reader.mode === "marks" ? setInterval(() => {
      const own = chain.ownWork();
      refreshOnWork = own && (refreshOnWork || !hadOwnWork);
      hadOwnWork = own;
      if (!busy && (refreshOnWork || Date.now() - refreshedAt >= (own || sender.flights.size > 0 ? 2000 : 60000))) {
        refreshOnWork = false;
        void refresh();
      }
    }, 50) : setInterval(() => void refresh(), 2000),
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
              clockAgeMs: chain.clockAgeMs(),
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
  cleanup.push(() => timers.forEach(clearInterval));
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
  cleanup.push(closeTelemetry);
  log({ event: "keeper-ready", cluster: c, address: payer.address, ...reader });
  const stop = () => { close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  cleanup.push(() => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); });
  return { close, engine, chain, rpc, budget };
  } catch (error) { close(); throw error; }
}
if (process.argv[1]?.endsWith("/keeper/main.ts"))
  void runKeeper().catch((e) => {
    log({ event: "fatal", error: safeError(e) });
    process.exitCode = 1;
  });

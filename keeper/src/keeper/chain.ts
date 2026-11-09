import { readFileSync } from "node:fs";
import {
  address,
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  unwrapOption,
  type Address,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, getTokenDecoder, AccountState } from "@solana-program/token";
import * as s from "../../../program/client/index.js";
import { ASSETS, assetOf, secsOf, feedOf, type Asset } from "../../../program/client/assets.js";
import { TOKEN, TOKEN_2022 } from "../../../program/client/constants.js";
import { getTokenSize } from "@solana-program/token-2022";
import { RpcPool, type Mode } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { parseFeed, type FeedValue } from "../common/feed.js";
import { log, type Logger } from "../common/log.js";
export const CLOCK = "SysvarC1ock11111111111111111111111111111111";
export const bytes = (raw: any) => Buffer.from(raw?.data?.[0] ?? "", "base64");
export type SpanHoldRead = { amount: bigint; burned: bigint; slot: number; read: number;
  buyer?: Address | null; marker?: Address; spanLoaded?: bigint; stepBps?: number };
/** Only a coherent ticket/holding pair can establish the paced reader's current balance. */
export function pairedSpanBalance(ticket: Live<s.Ticket>, held?: SpanHoldRead) {
  const t = ticket.value;
  return held && held.slot >= ticket.slot && held.buyer === (unwrapOption(t.buyer) ?? null) &&
    held.marker === t.marker && held.spanLoaded === t.spanLoaded && held.stepBps === t.stepBps &&
    held.burned === t.burned ? held.amount : undefined;
}
// Each ticket burn increases burned by the amount removed from the holding.
export function spanHeld(t: Pick<s.Ticket, "spanLoaded" | "burned">, held?: SpanHoldRead) {
  if (t.spanLoaded === 0n) return 0n;
  const amount = held ? held.amount + held.burned - t.burned : t.spanLoaded - t.burned;
  return amount > 0n ? amount : 0n;
}
export type Live<T> = { value: T; slot: number; data: string };
export const filter = (disc: ReadonlyUint8Array) => [
  { memcmp: { offset: 0, bytes: getBase58Decoder().decode(disc) } },
];
export const account = async (
  rpc: RpcPool,
  key: string,
  mode: Mode = "normal",
) =>
  (
    await rpc.call(
      "getAccountInfo",
      [key, { encoding: "base64", commitment: "processed" }],
      mode,
    )
  ).value;
export async function signerFile(path: string) {
  try {
    return await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
    );
  } catch {
    throw Error("Unable to load signing key");
  }
}
export class Chain {
  config?: s.Config;
  configKey!: Address;
  candles = new Map<Address, Live<s.Candle>>();
  tickets = new Map<Address, Live<s.Ticket>>();
  untils = new Map<Address, Live<s.Until>>();
  resales = new Map<Address, Live<s.Resale>>();
  bids = new Map<Address, Live<s.Bid>>();
  requests = new Map<Address, Live<s.Request>>();
  feeds = new Map<Asset, FeedValue>();
  get feed() { return this.feeds.get(0); }
  set feed(value: FeedValue | undefined) { if(value)this.feeds.set(0,value);else this.feeds.delete(0); }
  spanHolds = new Map<Address, SpanHoldRead>();
  // Assigned before the RPC starts, so an earlier in-flight read cannot clear a later shortfall.
  spanRead = 0;
  slot = 0;
  height = 0n;
  lastFullMs = 0;
  lastReadMs = 0;
  private anchorTime = 0;
  private anchorAtMs = Date.now();
  private feedKeys = new Map<Asset,Address>();
  private feedStops = new Map<Asset,()=>void>();
  private lastFeed = new Map<Asset,string>();
  private feedSync?: Promise<void>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stops: (() => void)[] = [];
  private busy = new Set<string>();
  onChange = () => {};
  onFeed = (_v: FeedValue) => {};
  onSlot = () => {};
  constructor(
    readonly rpc: RpcPool,
    readonly ws: Subscriptions,
    readonly logger: Logger = log,
    readonly keeper?: Address,
  ) {}
  now() {
    return BigInt(this.anchorTime + Math.floor(this.clockAgeMs() / 1000));
  }
  clockAgeMs() {
    return Date.now() - this.anchorAtMs;
  }
  active() {
    const now = this.now();
    return [...this.candles.values()].some(
      ({ value: c }) => now >= c.t0 - 30n && now <= s.settleAfter(c) + 60n,
    );
  }
  recording(asset?: Asset) {
    const now = this.now();
    return [...this.candles.values()].some(
      ({ value: c }) => (asset === undefined || assetOf(c.t0) === asset) && now >= c.t0 - 120n && now <= c.t0 + secsOf(c.t0) + 120n,
    );
  }
  setSlot(slot: number) {
    if (slot > this.slot) {
      this.slot = slot;
      this.onSlot();
    }
  }
  ingest(kind: "candle" | "ticket" | "until" | "resale" | "bid" | "request", key: Address, raw: any, slot: number) {
    const map = (kind === "candle" ? this.candles : kind === "ticket" ? this.tickets : kind === "until" ? this.untils : kind === "resale" ? this.resales : kind === "bid" ? this.bids : this.requests) as Map<
        Address,
        Live<any>
      >,
      old = map.get(key);
    if (old && slot < old.slot) return;
    if (!raw || raw.lamports === 0 || bytes(raw).length === 0) {
      if (map.delete(key)) this.onChange();
      return;
    }
    const d = bytes(raw),
      disc =
        kind === "candle" ? s.CANDLE_DISCRIMINATOR : kind === "ticket" ? s.TICKET_DISCRIMINATOR : kind === "until" ? s.UNTIL_DISCRIMINATOR : kind === "resale" ? s.RESALE_DISCRIMINATOR : kind === "bid" ? s.BID_DISCRIMINATOR : s.REQUEST_DISCRIMINATOR;
    if (
      raw.owner !== s.SPAN_PROGRAM_ADDRESS ||
      !disc.every((x, i) => d[i] === x) ||
      d.length !== (kind === "candle" ? 247 : kind === "ticket" ? 173 : kind === "until" ? 81 : kind === "resale" ? 89 : kind === "bid" ? 141 : 127)
    )
      return;
    if (old && old.data === raw.data[0]) {
      old.slot = slot;
      return;
    }
    const value =
      kind === "candle"
        ? s.getCandleDecoder().decode(d)
        : kind === "ticket" ? s.getTicketDecoder().decode(d) : kind === "until" ? s.getUntilDecoder().decode(d) : kind === "resale" ? s.getResaleDecoder().decode(d) : kind === "bid" ? s.getBidDecoder().decode(d) : s.getRequestDecoder().decode(d);
    map.set(key, { value, slot, data: raw.data[0] });
    this.onChange();
  }
  async ingestFeed(raw: any, slot: number, source: "ws" | "poll", asset: Asset = 0) {
    if (!this.config) return;
    const configFeed = this.config.feed, key = await feedOf(asset, configFeed, this.rpc.cluster),
      v = await parseFeed(raw, key, this.rpc.cluster, asset);
    if (this.config?.feed !== configFeed) return;
    const id = `${v.publishTs}:${v.price}`;
    if (id === this.lastFeed.get(asset)) return;
    const old = this.feeds.get(asset);
    if (old && slot < old.slot) return;
    this.lastFeed.set(asset,id);
    const value = { ...v, slot, source, recvMs: Date.now() };
    this.feeds.set(asset,value);
    this.logger({ event: "feed", asset: ASSETS[asset], ...value });
    this.onFeed(value);
  }
  private assets(): Asset[] {
    return [...new Set<Asset>([0,...[...this.candles.values()].map(x=>assetOf(x.value.t0))])];
  }
  private async syncFeeds() {
    if(this.feedSync)return this.feedSync;
    this.feedSync=(async()=>{
      const configFeed=this.config?.feed;if(!configFeed)return;
      for(const asset of this.assets()){
        const key=await feedOf(asset,configFeed,this.rpc.cluster);
        if(this.config?.feed!==configFeed)return;
        if(this.feedKeys.get(asset)===key)continue;
        this.feedStops.get(asset)?.();this.feedKeys.set(asset,key);this.lastFeed.delete(asset);this.feeds.delete(asset);
        this.feedStops.set(asset,this.ws.subscribe('accountSubscribe',[key,{encoding:'base64',commitment:'processed'}],v=>{
          if(this.feedKeys.get(asset)!==key)return;
          void this.ingestFeed(v.value,v.context.slot,'ws',asset).catch(()=>this.logger({event:'invalid-feed',asset:ASSETS[asset]}));
        }));
      }
      for(const asset of this.feedKeys.keys())if(!this.assets().includes(asset)){
        this.feedStops.get(asset)?.();this.feedStops.delete(asset);this.feedKeys.delete(asset);this.feeds.delete(asset);this.lastFeed.delete(asset);
      }
    })().finally(()=>{this.feedSync=undefined;});
    return this.feedSync;
  }
  ingestConfig(raw: any) {
    if (raw?.owner !== s.SPAN_PROGRAM_ADDRESS) throw Error('Config owner mismatch');
    const value=s.getConfigDecoder().decode(bytes(raw));
    if(this.config?.feed!==value.feed){this.feedStops.get(0)?.();this.feedStops.delete(0);this.feedKeys.delete(0);this.feeds.delete(0);this.lastFeed.delete(0);}
    this.config=value;
    void this.syncFeeds().catch(()=>this.logger({event:'feed-subscription-error'}));this.onChange();
  }
  async pollPrograms() {
    await Promise.all(
      (["candle", "ticket", "until", "resale", "bid", "request"] as const).map(async (kind) => {
        const v = await this.rpc.call("getProgramAccounts", [
          s.SPAN_PROGRAM_ADDRESS,
          {
            encoding: "base64",
            commitment: "processed",
            withContext: true,
            filters: filter(
              kind === "candle"
                ? s.CANDLE_DISCRIMINATOR
                : kind === "ticket" ? s.TICKET_DISCRIMINATOR : kind === "until" ? s.UNTIL_DISCRIMINATOR : kind === "resale" ? s.RESALE_DISCRIMINATOR : kind === "bid" ? s.BID_DISCRIMINATOR : s.REQUEST_DISCRIMINATOR,
            ),
          },
        ]);
        const seen = new Set(v.value.map((x: any) => x.pubkey));
        for (const x of v.value)
          this.ingest(kind, address(x.pubkey), x.account, v.context.slot);
        const map = kind === "candle" ? this.candles : kind === "ticket" ? this.tickets : kind === "until" ? this.untils : kind === "resale" ? this.resales : kind === "bid" ? this.bids : this.requests;
        for (const [key, item] of map)
          if (!seen.has(key) && item.slot <= v.context.slot) {
            map.delete(key);
            this.onChange();
          }
        this.setSlot(v.context.slot);
      }),
    );
    await this.syncFeeds();
    this.lastReadMs = Date.now();
  }
  async pollSpanHolds(role: "keeper" | "tape") {
    const config = this.config, now = this.now();
    const mint = config ? unwrapOption(config.spanMint) : null;
    const program = config ? unwrapOption(config.spanTokenProgram) : null;
    const eligible = (key: Address) => {
      const t = this.tickets.get(key)?.value;
      if (!t || t.state !== s.TicketState.Sold || t.spanLoaded === 0n) return false;
      if (role === "tape") return true;
      const c = [...this.candles.values()].find(x => x.value.t0 === t.t0)?.value;
      return t.marker === this.keeper && !!c && now >= t.t0 &&
        now <= t.t0 + secsOf(t.t0) + BigInt(c.ageLimit);
    };
    const keys = mint && (program === TOKEN || program === TOKEN_2022)
      ? [...this.tickets.keys()].filter(eligible) : [];
    const keep = new Set(keys);
    for (const key of this.spanHolds.keys()) if (!keep.has(key)) this.spanHolds.delete(key);
    if (!keys.length) return;
    const batches = Array.from({ length: Math.ceil(keys.length / 50) },
      (_, i) => keys.slice(i * 50, (i + 1) * 50));
    await Promise.all(batches.map(async (batch) => {
      try {
        const holds = await Promise.all(batch.map(async key => (await s.findSpanHoldPda(key))[0]));
        const read = ++this.spanRead;
        const accounts = batch.flatMap((key, i) => [key, holds[i]]);
        const v = await this.rpc.call("getMultipleAccounts", [accounts, {
          encoding: "base64", commitment: "processed",
        }], "normal", "span-holds");
        if (!Number.isSafeInteger(v?.context?.slot) || !Array.isArray(v.value) || v.value.length !== accounts.length)
          throw Error("Invalid SPAN account response");
        if (!this.config || unwrapOption(this.config.spanMint) !== mint ||
            unwrapOption(this.config.spanTokenProgram) !== program) return;
        for (let i = 0; i < batch.length; i++) {
          const key = batch[i], ticket = v.value[i * 2], raw = v.value[i * 2 + 1], old = this.spanHolds.get(key);
          if (!eligible(key) || (old && (v.context.slot < old.slot || read <= old.read))) continue;
          let paired: s.Ticket;
          try {
            const data = bytes(ticket);
            if (ticket?.owner !== s.SPAN_PROGRAM_ADDRESS || data.length !== 173 ||
                !s.TICKET_DISCRIMINATOR.every((x, j) => data[j] === x))
              throw Error("Invalid SPAN ticket");
            paired = s.getTicketDecoder().decode(data);
          } catch {
            this.logger({ event: "invalid-span-ticket", ticket: key });
            continue;
          }
          let amount = 0n;
          if (raw !== null) {
            const data = bytes(raw);
            if (raw.owner !== program || data.length < 165 ||
                (program === TOKEN && data.length !== 165) ||
                (program === TOKEN_2022 && data.length > 165 && data[165] !== 2)) {
              this.logger({ event: "invalid-span-hold", ticket: key });
              continue;
            }
            try {
              const token = getTokenDecoder().decode(data.subarray(0, 165));
              if (token.mint !== mint || token.owner !== key || token.state === AccountState.Uninitialized)
                throw Error("Invalid SPAN account");
              amount = token.amount;
            } catch {
              this.logger({ event: "invalid-span-hold", ticket: key });
              continue;
            }
          }
          this.spanHolds.set(key, { amount, burned: paired.burned, slot: v.context.slot, read,
            buyer: unwrapOption(paired.buyer) ?? null, marker: paired.marker,
            spanLoaded: paired.spanLoaded, stepBps: paired.stepBps });
        }
        this.onChange();
      } catch {
        this.logger({ event: "span-hold-read-error", accounts: batch.length * 2 });
      }
    }));
  }
  async pollConfig() {
    this.ingestConfig(await account(this.rpc, this.configKey));
    await this.syncFeeds();
    this.lastReadMs = Date.now();
  }
  async pollClock() {
    const d = bytes(await account(this.rpc, CLOCK));
    if (d.length < 40) throw Error("Clock unavailable");
    this.anchorTime = Number(d.readBigInt64LE(32));
    this.anchorAtMs = Date.now();
    this.setSlot(Number(d.readBigUInt64LE(0)));
  }
  async pollFeed() {
    if(!this.config)return;
    await this.syncFeeds();
    await Promise.all(this.assets().map(async asset=>{
      const key=await feedOf(asset,this.config!.feed,this.rpc.cluster);
      const v=await this.rpc.call('getAccountInfo',[key,{encoding:'base64',commitment:'processed'}],'normal',`overlay-feed:${asset}`);
      await this.ingestFeed(v.value,v.context.slot,'poll',asset);this.setSlot(v.context.slot);
    }));
  }
  async full() {
    await Promise.all([
      this.pollPrograms(),
      this.pollConfig(),
      this.pollClock(),
    ]);
    this.lastFullMs = Date.now();
  }
  async init() {
    this.configKey = (await s.findConfigPda())[0];
    const p = await account(this.rpc, s.SPAN_PROGRAM_ADDRESS);
    if (!p?.executable) throw Error("Program unavailable");
    await this.full();
  }
  private job(name: string, fn: () => Promise<unknown>) {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    void fn()
      .catch(() => this.logger({ event: "state-read-error", method: name }))
      .finally(() => this.busy.delete(name));
  }
  start(role: "keeper" | "tape") {
    for (const kind of ["candle", "ticket", "until", "resale", "bid", "request"] as const)
      this.stops.push(
        this.ws.subscribe(
          "programSubscribe",
          [
            s.SPAN_PROGRAM_ADDRESS,
            {
              encoding: "base64",
              commitment: "processed",
              filters: filter(
                kind === "candle"
                  ? s.CANDLE_DISCRIMINATOR
                  : kind === "ticket" ? s.TICKET_DISCRIMINATOR : kind === "until" ? s.UNTIL_DISCRIMINATOR : kind === "resale" ? s.RESALE_DISCRIMINATOR : kind === "bid" ? s.BID_DISCRIMINATOR : s.REQUEST_DISCRIMINATOR,
              ),
            },
          ],
          (v) => {
            this.ingest(
              kind,
              address(v.value.pubkey),
              v.value.account,
              v.context.slot,
            );
            this.setSlot(v.context.slot);
          },
        ),
      );
    this.stops.push(
      this.ws.subscribe(
        "accountSubscribe",
        [this.configKey, { encoding: "base64", commitment: "processed" }],
        (v) => this.ingestConfig(v.value),
      ),
    );
    this.stops.push(
      this.ws.subscribe("slotSubscribe", [], (v) => this.setSlot(v.slot)),
    );
    this.ws.on("ready", () => this.job("reconnect", () => this.full()));
    let programs = 0,
      config = 0,
      feed = 0,
      clock = 0,
      full = Date.now();
    this.timers.push(
      setInterval(() => {
        const at = Date.now(),
          active = this.active();
        if (role === "tape" && at - full >= 15000) {
          full = at;
          this.job("full", () => this.full());
        }
        if (at - programs >= (role === "tape" ? 5000 : active ? 2000 : 15000)) {
          programs = at;
          this.job("programs", async () => {
            await this.pollPrograms();
            await this.pollSpanHolds(role);
          });
        }
        if (at - config >= (role === "tape" ? 5000 : 15000)) {
          config = at;
          this.job("config", () => this.pollConfig());
        }
        if (role === "keeper" && active && at - feed >= 400) {
          feed = at;
          this.job("feed", () => this.pollFeed());
        }
        if (at - clock >= 10000) {
          clock = at;
          this.job("clock", () => this.pollClock());
        }
      }, 50),
    );
    this.ws.start();
  }
  close() {
    this.timers.forEach(clearInterval);
    this.stops.forEach((f) => f());
    for(const stop of this.feedStops.values())stop();
    this.ws.close();
  }
}
export async function settlement(
  rpc: RpcPool,
  payer: TransactionSigner,
  config: s.Config,
  candle: s.Candle,
  ticket: s.Ticket,
  ticketAddress: Address,
) {
  const buyer = unwrapOption(ticket.buyer),
    mint = unwrapOption(config.spanMint),
    program = unwrapOption(config.spanTokenProgram);
  const keys: Address[] = [
    (await s.findVaultPda(ticketAddress))[0],
    (
      await findAssociatedTokenPda({
        owner: ticket.seller,
        mint: config.usdcMint,
        tokenProgram: TOKEN,
      })
    )[0],
  ];
  if (buyer)
    keys.push(
      (
        await findAssociatedTokenPda({
          owner: buyer,
          mint: config.usdcMint,
          tokenProgram: TOKEN,
        })
      )[0],
    );
  if (ticket.spanLoaded > 0n && buyer && mint && program)
    keys.push(
      (await s.findSpanHoldPda(ticketAddress))[0],
      (
        await findAssociatedTokenPda({
          owner: buyer,
          mint,
          tokenProgram: program,
        })
      )[0],
      mint,
    );
  const v = await rpc.call(
    "getMultipleAccounts",
    [keys, { encoding: "base64", commitment: "processed" }],
    "prepare",
  );
  const cache = new Map(keys.map((k, i) => [k, v.value[i]]));
  const balance = (k: Address) => {
    const raw = cache.get(k);
    return raw ? bytes(raw).readBigUInt64LE(64) : 0n;
  };
  const rents = new Map<number, bigint>();
  const ixs = await s.buildSettleInstructions({
    payer,
    config,
    candle,
    ticket,
    ticketAddress,
    vaultBalance: balance(keys[0]),
    spanBalance:
      ticket.spanLoaded > 0n
        ? balance((await s.findSpanHoldPda(ticketAddress))[0])
        : 0n,
    getAccount: async (a) => {
      const x = cache.get(a);
      return x ? { programOwner: address(x.owner), data: bytes(x) } : null;
    },
    getMintData: async (a) => bytes(cache.get(a)),
    getRent: async (size) => {
      if (!rents.has(size))
        rents.set(
          size,
          BigInt(
            await rpc.call(
              "getMinimumBalanceForRentExemption",
              [size],
              "prepare",
            ),
          ),
        );
      return rents.get(size)!;
    },
  });
  let rent = 0n;
  for (const ix of ixs) {
    if (ix.programAddress === "11111111111111111111111111111111")
      rent += Buffer.from(ix.data!).readBigUInt64LE(4);
    else if (
      ix.programAddress === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    ) {
      const tokenProgram = ix.accounts![5].address;
      let size = 165;
      if (tokenProgram === TOKEN_2022) {
        const regular = s.tokenAccountSize(
          TOKEN_2022,
          bytes(cache.get(ix.accounts![3].address)),
        );
        // Associated accounts add ImmutableOwner. Configured mints cannot be
        // nontransferable, so the normal-account size never includes it.
        size =
          regular === 165
            ? getTokenSize([{ __kind: "ImmutableOwner" }])
            : regular + 4;
      }
      if (!rents.has(size))
        rents.set(
          size,
          BigInt(
            await rpc.call(
              "getMinimumBalanceForRentExemption",
              [size],
              "prepare",
            ),
          ),
        );
      rent += rents.get(size)!;
    }
  }
  return { ixs, rent };
}

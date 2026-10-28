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
import { findAssociatedTokenPda } from "@solana-program/token";
import * as s from "../../../program/client/index.js";
import { TOKEN, TOKEN_2022 } from "../../../program/client/constants.js";
import { getTokenSize } from "@solana-program/token-2022";
import { RpcPool, type Mode } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { parseFeed, type FeedValue } from "../common/feed.js";
import { log, type Logger } from "../common/log.js";
export const CLOCK = "SysvarC1ock11111111111111111111111111111111";
export const bytes = (raw: any) => Buffer.from(raw?.data?.[0] ?? "", "base64");
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
  feed?: FeedValue;
  slot = 0;
  height = 0n;
  lastFullMs = 0;
  lastReadMs = 0;
  private anchorSlot = 0;
  private anchorTime = 0;
  private slotMs = 400;
  private slotAt = 0;
  private feedKey?: Address;
  private feedStop?: () => void;
  private lastFeed = "";
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
  ) {}
  now() {
    return BigInt(
      Math.floor(
        this.anchorTime +
          (Math.max(0, this.slot - this.anchorSlot) * this.slotMs) / 1000,
      ),
    );
  }
  active() {
    const now = this.now();
    return [...this.candles.values()].some(
      ({ value: c }) => now >= c.t0 - 30n && now <= s.settleAfter(c) + 60n,
    );
  }
  recording() {
    const now = this.now();
    return [...this.candles.values()].some(
      ({ value: c }) => now >= c.t0 - 120n && now <= c.t0 + 3720n,
    );
  }
  setSlot(slot: number) {
    if (slot > this.slot) {
      const at = Date.now();
      if (this.slotAt && slot - this.slot < 20) {
        const measured = (at - this.slotAt) / (slot - this.slot);
        if (measured > 100 && measured < 2000)
          this.slotMs = this.slotMs * 0.9 + measured * 0.1;
      }
      this.slotAt = at;
      this.slot = slot;
      this.onSlot();
    }
  }
  ingest(kind: "candle" | "ticket", key: Address, raw: any, slot: number) {
    const map = (kind === "candle" ? this.candles : this.tickets) as Map<
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
        kind === "candle" ? s.CANDLE_DISCRIMINATOR : s.TICKET_DISCRIMINATOR;
    if (
      raw.owner !== s.SPAN_PROGRAM_ADDRESS ||
      !disc.every((x, i) => d[i] === x) ||
      d.length !== (kind === "candle" ? 247 : 173)
    )
      return;
    if (old && old.data === raw.data[0]) {
      old.slot = slot;
      return;
    }
    const value =
      kind === "candle"
        ? s.getCandleDecoder().decode(d)
        : s.getTicketDecoder().decode(d);
    map.set(key, { value, slot, data: raw.data[0] });
    this.onChange();
  }
  async ingestFeed(raw: any, slot: number, source: "ws" | "poll") {
    if (!this.config) return;
    const key = this.config.feed,
      v = await parseFeed(raw, key, this.rpc.cluster);
    if (this.config.feed !== key) return;
    const id = `${v.publishTs}:${v.price}`;
    if (id === this.lastFeed) return;
    if (this.feed && slot < this.feed.slot) return;
    this.lastFeed = id;
    this.feed = { ...v, slot, source, recvMs: Date.now() };
    this.logger({ event: "feed", ...this.feed });
    this.onFeed(this.feed);
  }
  ingestConfig(raw: any) {
    if (raw?.owner !== s.SPAN_PROGRAM_ADDRESS)
      throw Error("Config owner mismatch");
    this.config = s.getConfigDecoder().decode(bytes(raw));
    if (this.feedKey !== this.config.feed) {
      this.feedStop?.();
      this.feedKey = this.config.feed;
      this.lastFeed = "";
      this.feed = undefined;
      this.feedStop = this.ws.subscribe(
        "accountSubscribe",
        [this.feedKey, { encoding: "base64", commitment: "processed" }],
        (v) => {
          void this.ingestFeed(v.value, v.context.slot, "ws").catch(() =>
            this.logger({ event: "invalid-feed" }),
          );
        },
      );
    }
    this.onChange();
  }
  async pollPrograms() {
    await Promise.all(
      (["candle", "ticket"] as const).map(async (kind) => {
        const v = await this.rpc.call("getProgramAccounts", [
          s.SPAN_PROGRAM_ADDRESS,
          {
            encoding: "base64",
            commitment: "processed",
            withContext: true,
            filters: filter(
              kind === "candle"
                ? s.CANDLE_DISCRIMINATOR
                : s.TICKET_DISCRIMINATOR,
            ),
          },
        ]);
        const seen = new Set(v.value.map((x: any) => x.pubkey));
        for (const x of v.value)
          this.ingest(kind, address(x.pubkey), x.account, v.context.slot);
        const map = kind === "candle" ? this.candles : this.tickets;
        for (const [key, item] of map)
          if (!seen.has(key) && item.slot <= v.context.slot) {
            map.delete(key);
            this.onChange();
          }
        this.setSlot(v.context.slot);
      }),
    );
    this.lastReadMs = Date.now();
  }
  async pollConfig() {
    this.ingestConfig(await account(this.rpc, this.configKey));
    this.lastReadMs = Date.now();
  }
  async pollClock() {
    const d = bytes(await account(this.rpc, CLOCK));
    if (d.length < 40) throw Error("Clock unavailable");
    this.anchorTime = Number(d.readBigInt64LE(32));
    this.anchorSlot = Number(d.readBigUInt64LE(0));
    this.setSlot(this.anchorSlot);
  }
  async pollFeed() {
    if (this.config) {
      const v = await this.rpc.call(
        "getAccountInfo",
        [this.config.feed, { encoding: "base64", commitment: "processed" }],
        "normal",
        "overlay-feed",
      );
      await this.ingestFeed(v.value, v.context.slot, "poll");
      this.setSlot(v.context.slot);
    }
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
    for (const kind of ["candle", "ticket"] as const)
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
                  : s.TICKET_DISCRIMINATOR,
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
          this.job("programs", () => this.pollPrograms());
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
    this.feedStop?.();
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

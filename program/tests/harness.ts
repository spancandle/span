import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import * as token from "@solana-program/token-2022";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  findAssociatedTokenPda,
} from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import * as r from "../client/src/generated/index.js";
import {
  TOKEN,
  TOKEN_2022,
  LOADER,
  SOL_FEED,
  BTC_FEED,
  USDC,
  DOVES,
} from "../client/constants.js";
import { decodeEvents } from "../client/events.js";
import { verifyEvents } from "./event-proof.js";
import {
  findConfigPda,
  findCandlePda,
  findTicketPda,
  findVaultPda,
  findSpanHoldPda,
  findEventAuthorityPda,
} from "../client/pdas.js";
export { r, TOKEN, TOKEN_2022, SOL_FEED, BTC_FEED, USDC, DOVES };
export const PROGRAM = r.SPAN_PROGRAM_ADDRESS;
export const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
export type Wallet = Awaited<ReturnType<typeof generateKeyPairSigner>>;
export const accountData = (s: LiteSVM, a: Address) => {
  const x = s.getAccount(a);
  if (!x.exists) throw Error(`Missing ${a}`);
  return Buffer.from(x.data);
};
export const amount = (s: LiteSVM, a: Address) =>
  s.getAccount(a).exists ? accountData(s, a).readBigUInt64LE(64) : 0n;
export const ata = async (
  owner: Address,
  mint: Address,
  program: Address = TOKEN,
) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: program }))[0];
export type Ref = {
  id: bigint;
  t0: bigint;
  candle: Address;
  ticket: Address;
  vault: Address;
  spanHold: Address;
};
export const measurements: Record<string, string[]> = {};
export const sizes: Record<string, number> = {};
export const rents: Record<string, { bytes: number; lamports: string }> = {};
export class Harness {
  svm = new LiteSVM().withTransactionHistory(0n);
  admin!: Wallet;
  seller!: Wallet;
  buyer!: Wallet;
  marker!: Wallet;
  stranger!: Wallet;
  config!: Address;
  programData!: Address;
  eventAuthority!: Address;
  spanMint!: Address;
  spanProgram: Address = TOKEN;
  sellerUsdc!: Address;
  buyerUsdc!: Address;
  buyerSpan!: Address;
  events: ReturnType<typeof decodeEvents> = [];
  lastFee = 0n;
  createSigner = generateKeyPairSigner;
  static async create(
    o: {
      initialize?: boolean;
      spanProgram?: Address;
      setSpan?: boolean;
      binary?: string;
    } = {},
  ) {
    const h = new Harness();
    const root = new URL("./fixtures/", import.meta.url);
    const manifest = JSON.parse(
      readFileSync(new URL("manifest.json", root), "utf8"),
    );
    for (const row of manifest.programs) {
      const bytes = readFileSync(new URL(row.file, root));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
      h.svm.addProgram(address(row.program), bytes);
    }
    h.svm.addProgramWithLoader(
      PROGRAM,
      readFileSync(
        new URL(o.binary ?? "../target/mainnet/span.so", import.meta.url),
      ),
      LOADER,
    );
    [h.admin, h.seller, h.buyer, h.marker, h.stranger] = await Promise.all(
      Array.from({ length: 5 }, () => generateKeyPairSigner()),
    );
    for (const w of [h.admin, h.seller, h.buyer, h.marker, h.stranger])
      h.svm.airdrop(w.address, lamports(100_000_000_000n));
    h.programData = (
      await getProgramDerivedAddress({
        programAddress: LOADER,
        seeds: [getAddressEncoder().encode(PROGRAM)],
      })
    )[0];
    const pd = h.svm.getAccount(h.programData);
    if (!pd.exists) throw Error("Missing ProgramData");
    const d = Buffer.from(pd.data);
    d[12] = 1;
    d.set(getAddressEncoder().encode(h.admin.address), 13);
    h.svm.setAccount({ ...pd, data: d });
    h.config = (await findConfigPda())[0];
    h.eventAuthority = (await findEventAuthorityPda())[0];
    const fixturesBytes = readFileSync(new URL(manifest.accounts.file, root));
    expect(createHash("sha256").update(fixturesBytes).digest("hex")).toBe(
      manifest.accounts.sha256,
    );
    const fixtures = JSON.parse(fixturesBytes.toString());
    for (const [key, raw] of Object.entries(fixtures.accounts) as [
      string,
      any,
    ][]) {
      const data = Buffer.from(raw.data[0], "base64");
      if (key === USDC)
        data.set(getAddressEncoder().encode(h.admin.address), 4);
      h.svm.setAccount({
        address: address(key),
        programAddress: address(raw.owner),
        executable: false,
        lamports: lamports(BigInt(raw.lamports)),
        data,
        space: BigInt(data.length),
      });
    }
    h.clock(1000n);
    h.price(8_246_000_000n, 1000n);
    h.sellerUsdc = await h.fundToken(h.seller, USDC, TOKEN, 1_000_000_000_000n);
    h.buyerUsdc = await h.fundToken(h.buyer, USDC, TOKEN, 1_000_000_000_000n);
    h.spanProgram = o.spanProgram ?? TOKEN;
    h.spanMint = await h.createMint(
      h.spanProgram,
      h.spanProgram === TOKEN_2022 ? "metadata" : "classic",
    );
    h.buyerSpan = await h.fundToken(
      h.buyer,
      h.spanMint,
      h.spanProgram,
      1_000_000_000_000n,
    );
    if (o.initialize !== false)
      await h.send(
        "init",
        h.ix("init", {
          authority: h.admin,
          deployment: PROGRAM,
          programData: h.programData,
          admin: h.admin.address,
          readWindow: 20,
          ageLimit: 20,
          buyCutoff: 5,
        }),
        h.admin,
      );
    if (o.setSpan)
      await h.send(
        "set_span",
        h.ix("setSpan", { admin: h.admin, burnPerMark: 100n }),
      );
    return h;
  }
  clock(now: bigint, slot = now * 4n) {
    const c = this.svm.getClock();
    c.unixTimestamp = now;
    c.slot = slot;
    this.svm.setClock(c);
  }
  price(price: bigint, publishTs: bigint, feed: Address = SOL_FEED) {
    const a = this.svm.getAccount(feed);
    if (!a.exists) throw Error("Missing feed");
    const d = Buffer.from(a.data);
    d.writeBigUInt64LE(price, 168);
    d.writeBigInt64LE(publishTs, 177);
    this.svm.setAccount({ ...a, data: d });
  }
  clone(source: Address, destination: Address, edit?: (d: Buffer) => void) {
    const a = this.svm.getAccount(source);
    if (!a.exists) throw Error("Missing source");
    const data = Buffer.from(a.data);
    edit?.(data);
    this.svm.setAccount({ ...a, address: destination, data });
  }
  ix(name: string, overrides: Record<string, any> = {}): Instruction {
    const fn = (r as any)[
      `get${name[0].toUpperCase() + name.slice(1)}Instruction`
    ];
    if (!fn) throw Error(`Unknown ${name}`);
    return fn({
      config: this.config,
      usdcMint: USDC,
      feed: SOL_FEED,
      tokenProgram: TOKEN,
      spanTokenProgram: this.spanProgram,
      spanMint: this.spanMint,
      buyer: this.buyer,
      seller: this.seller,
      marker: this.marker,
      eventAuthority: this.eventAuthority,
      program: PROGRAM,
      ...overrides,
    });
  }
  configState() {
    return r.getConfigDecoder().decode(accountData(this.svm, this.config));
  }
  candleState(t: Pick<Ref, "candle">) {
    return r.getCandleDecoder().decode(accountData(this.svm, t.candle));
  }
  ticketState(t: Ref) {
    return r.getTicketDecoder().decode(accountData(this.svm, t.ticket));
  }
  async ref(t0 = 1200n, id = this.configState().nextTicketId): Promise<Ref> {
    const ticket = (await findTicketPda(id))[0];
    return {
      id,
      t0,
      candle: (await findCandlePda(t0))[0],
      ticket,
      vault: (await findVaultPda(ticket))[0],
      spanHold: (await findSpanHoldPda(ticket))[0],
    };
  }
  openCandleIx(t: Ref, overrides: Record<string, any> = {}) {
    return this.ix("openCandle", { ...t, payer: this.stranger, ...overrides });
  }
  openIx(t: Ref, premium = 20_000_000n, overrides: Record<string, any> = {}) {
    return this.ix("openTicket", {
      ...t,
      premium,
      strikeBps: 0,
      sellerSource: this.sellerUsdc,
      ...overrides,
    });
  }
  buyIx(t: Ref, overrides: Record<string, any> = {}) {
    return this.ix("buy", { ...t, buyerSource: this.buyerUsdc, ...overrides });
  }
  loadIx(t: Ref, overrides: Record<string, any> = {}) {
    return this.ix("loadSpan", {
      ...t,
      amount: 100_000n,
      stepBps: 5,
      marker: this.marker.address,
      spanSource: this.buyerSpan,
      ...overrides,
    });
  }
  readIx(t: Ref, j: number, overrides: Record<string, any> = {}) {
    return this.ix("read", { ...t, j, ...overrides });
  }
  markIx(t: Ref, overrides: Record<string, any> = {}) {
    return this.ix("mark", { ...t, ...overrides });
  }
  withdrawIx(t: Ref, overrides: Record<string, any> = {}) {
    return this.ix("withdraw", {
      ...t,
      sellerDestination: this.sellerUsdc,
      ...overrides,
    });
  }
  settleIx(t: Ref, overrides: Record<string, any> = {}) {
    const loaded = this.ticketState(t).spanLoaded > 0n;
    return this.ix("settle", {
      ...t,
      seller: this.seller.address,
      buyer:
        this.ticketState(t).buyer.__option === "Some"
          ? this.buyer.address
          : undefined,
      sellerUsdc: this.sellerUsdc,
      buyerUsdc: this.buyerUsdc,
      spanMint: loaded ? this.spanMint : undefined,
      spanHold: loaded ? t.spanHold : undefined,
      spanTokenProgram: loaded ? this.spanProgram : undefined,
      buyerSpan: loaded ? this.buyerSpan : undefined,
      ...overrides,
    });
  }
  async open(
    o: {
      t0?: bigint;
      sold?: boolean;
      loaded?: boolean;
      premium?: bigint;
      strikeBps?: number;
      step?: number;
    } = {},
  ) {
    const t = await this.ref(o.t0);
    await this.send(
      "open",
      [this.openCandleIx(t), this.openIx(t, o.premium, {strikeBps: o.strikeBps ?? 0})],
      this.seller,
    );
    if (o.sold || o.loaded)
      await this.send(
        "buy_load",
        o.loaded
          ? [this.buyIx(t), this.loadIx(t, { stepBps: o.step ?? 5 })]
          : this.buyIx(t),
        this.buyer,
      );
    return t;
  }
  totals() {
    const balances: Record<string, bigint> = {};
    for (const p of [TOKEN, TOKEN_2022])
      for (const a of this.svm.getProgramAccounts(p)) {
        const d = Buffer.from(a.data);
        if (d.length === 165 || (d.length >= 166 && d[165] === 2)) {
          const m = getAddressDecoder().decode(d.subarray(0, 32));
          balances[m] = (balances[m] ?? 0n) + d.readBigUInt64LE(64);
        }
      }
    return balances;
  }
  supplies() {
    const result: Record<string, bigint> = {};
    for (const p of [TOKEN, TOKEN_2022])
      for (const a of this.svm.getProgramAccounts(p)) {
        const d = Buffer.from(a.data);
        if (d.length === 82 || (d.length >= 166 && d[165] === 1))
          result[a.address] = d.readBigUInt64LE(36);
      }
    return result;
  }
  async transaction(ixs: readonly Instruction[], payer: TransactionSigner) {
    this.svm.expireBlockhash();
    return signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (x) => setTransactionMessageFeePayerSigner(payer, x),
        (x) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: this.svm.latestBlockhash(),
              lastValidBlockHeight: 10n ** 12n,
            },
            x,
          ),
        (x) => appendTransactionMessageInstructions(ixs, x),
      ),
    );
  }
  async send(
    label: string,
    input: Instruction | readonly Instruction[],
    payer: TransactionSigner = this.stranger,
    failure?: string,
  ) {
    const ixs = Array.isArray(input) ? input : [input as Instruction];
    const tx = await this.transaction(ixs, payer);
    const keys = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    ).staticAccounts;
    const before = keys.map((k) => this.svm.getAccount(k));
    const totals = this.totals(),
      supplies = this.supplies();
    const result = this.svm.sendTransaction(tx);
    this.lastFee = keys.reduce(
      (n, k, i) =>
        n +
        (before[i].exists ? before[i].lamports : 0n) -
        ((a) => (a.exists ? a.lamports : 0n))(this.svm.getAccount(k)),
      0n,
    );
    if (failure !== undefined) {
      expect(result, label).toBeInstanceOf(FailedTransactionMetadata);
      if (!(result instanceof FailedTransactionMetadata))
        throw Error("Expected failure");
      if (failure)
        expect(result.meta().logs().join("\n"), label).toContain(
          `Error Code: ${failure}.`,
        );
      keys.forEach((k, i) => {
        const a = this.svm.getAccount(k),
          b = before[i];
        expect(a.exists, label).toBe(b.exists);
        if (a.exists && b.exists) {
          expect(Buffer.from(a.data), label).toEqual(Buffer.from(b.data));
          if (k !== payer.address) expect(a.lamports, label).toBe(b.lamports);
        }
      });
      expect(this.totals()).toEqual(totals);
      return result.meta();
    }
    if (result instanceof FailedTransactionMetadata)
      throw Error(
        `${label}: ${String(result.err())}\n${result.meta().logs().join("\n")}`,
      );
    if (ixs.some((i) => i.programAddress === PROGRAM)) {
      const afterTotals = this.totals(),
        afterSupplies = this.supplies();
      for (const mint of Object.keys(totals))
        expect(
          (afterTotals[mint] ?? 0n) - totals[mint],
          `${label}:conservation`,
        ).toBe((afterSupplies[mint] ?? 0n) - (supplies[mint] ?? 0n));
      this.events = decodeEvents(
        result
          .innerInstructions()
          .flat()
          .map((i) => ({
            programAddress: keys[i.instruction().programIdIndex()],
            data: i.instruction().data(),
          })),
      );
      await verifyEvents(
        this.svm,
        this.events,
        ixs.filter((i) => i.programAddress === PROGRAM),
        new Map(keys.map((k, i) => [k, before[i]])),
        payer.address,
        this.lastFee,
      );
      (measurements[label] ??= []).push(
        result.computeUnitsConsumed().toString(),
      );
      sizes[label] = getTransactionEncoder().encode(tx).length;
      appendFileSync(
        new URL("../target/checks/transactions.jsonl", import.meta.url),
        json({
          label,
          cu: result.computeUnitsConsumed(),
          bytes: sizes[label],
          events: this.events.map((e) => ({
            name: e.name,
            ...(e.name === "Settled" ? { outcome: e.data.outcome } : {}),
          })),
        }) + "\n",
      );
    }
    return result;
  }
  measure(name: string, a: Address) {
    const x = this.svm.getAccount(a);
    if (!x.exists) throw Error("Missing measurement");
    rents[name] = { bytes: x.data.length, lamports: x.lamports.toString() };
  }
  async createMint(
    program: Address,
    kind:
      | "classic"
      | "metadata"
      | "hook"
      | "fee"
      | "frozen"
      | "delegate"
      | "freeze"
      | "pause"
      | "paused"
      | "hook-authority"
      | "hook-none" = "classic",
  ) {
    const mint = await this.createSigner();
    const extensions: token.ExtensionArgs[] =
      kind === "metadata"
        ? [
            {
              __kind: "MetadataPointer",
              authority: this.admin.address,
              metadataAddress: mint.address,
            },
            {
              __kind: "TokenMetadata",
              updateAuthority: this.admin.address,
              mint: mint.address,
              name: "Span Test",
              symbol: "SPANT",
              uri: "",
              additionalMetadata: new Map(),
            },
          ]
        : [];
    const size =
      kind === "pause" || kind === "paused"
        ? 203
        : kind === "delegate"
          ? 202
          : kind.startsWith("hook")
            ? 234
            : kind === "fee"
              ? 278
              : kind === "frozen"
                ? 171
                : token.getMintSize(extensions.length ? extensions : undefined);
    const ixs: Instruction[] = [
      getCreateAccountInstruction({
        payer: this.admin,
        newAccount: mint,
        space: BigInt(
          kind === "metadata"
            ? token.getMintSize(extensions.slice(0, 1))
            : size,
        ),
        lamports: this.svm.minimumBalanceForRentExemption(BigInt(size)),
        programAddress: program,
      }),
    ];
    if (kind === "metadata")
      ixs.push(
        token.getInitializeMetadataPointerInstruction({
          mint: mint.address,
          authority: this.admin.address,
          metadataAddress: mint.address,
        }),
      );
    if (kind === "pause" || kind === "paused")
      ixs.push(
        token.getInitializePausableConfigInstruction({
          mint: mint.address,
          authority: this.admin.address,
        }),
      );
    if (kind === "delegate")
      ixs.push(
        token.getInitializePermanentDelegateInstruction({
          mint: mint.address,
          delegate: this.admin.address,
        }),
      );
    if (kind.startsWith("hook"))
      ixs.push(
        token.getInitializeTransferHookInstruction({
          mint: mint.address,
          authority: this.admin.address,
          programId: kind === "hook" ? this.stranger.address : null,
        }),
      );
    if (kind === "fee")
      ixs.push(
        token.getInitializeTransferFeeConfigInstruction({
          mint: mint.address,
          transferFeeConfigAuthority: this.admin.address,
          withdrawWithheldAuthority: this.admin.address,
          transferFeeBasisPoints: 100,
          maximumFee: 100n,
        }),
      );
    if (kind === "frozen")
      ixs.push(
        token.getInitializeDefaultAccountStateInstruction({
          mint: mint.address,
          state: token.AccountState.Frozen,
        }),
      );
    ixs.push(
      token.getInitializeMint2Instruction(
        {
          mint: mint.address,
          mintAuthority: this.admin.address,
          decimals: 8,
          freezeAuthority:
            kind === "freeze" || kind === "frozen" ? this.admin.address : null,
        },
        { programAddress: program },
      ),
    );
    if (kind === "metadata")
      ixs.push(
        token.getInitializeTokenMetadataInstruction({
          metadata: mint.address,
          updateAuthority: this.admin.address,
          mint: mint.address,
          mintAuthority: this.admin,
          name: "Span Test",
          symbol: "SPANT",
          uri: "",
        }),
      );
    if (kind === "paused")
      ixs.push(
        token.getPauseInstruction({
          mint: mint.address,
          authority: this.admin,
        }),
      );
    if (kind === "hook-none")
      ixs.push(
        token.getSetAuthorityInstruction({
          owned: mint.address,
          owner: this.admin,
          authorityType: token.AuthorityType.TransferHookProgramId,
          newAuthority: null,
        }),
      );
    await this.send(`create_${kind}_mint`, ixs, this.admin);
    return mint.address;
  }
  async fundToken(
    owner: Wallet,
    mint: Address,
    program: Address,
    value: bigint,
  ) {
    const destination = await ata(owner.address, mint, program);
    const prepare: Instruction[] = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: this.admin,
        owner: owner.address,
        mint,
        tokenProgram: program,
      }),
    ];
    if (!this.svm.getAccount(destination).exists && program === TOKEN_2022) {
      const d = accountData(this.svm, mint);
      for (let offset = 166; offset + 4 <= d.length;) {
        const type = d.readUInt16LE(offset),
          size = d.readUInt16LE(offset + 2);
        if (type === 6 && d[offset + 4] === 2)
          prepare.push(
            token.getThawAccountInstruction({
              account: destination,
              mint,
              owner: this.admin,
            }),
          );
        if (type === 0) break;
        offset += 4 + size;
      }
    }
    await this.send(
      "fund_token",
      [
        ...prepare,
        token.getMintToCheckedInstruction(
          {
            mint,
            token: destination,
            mintAuthority: this.admin,
            amount: value,
            decimals: accountData(this.svm, mint)[44],
          },
          { programAddress: program },
        ),
      ],
      this.admin,
    );
    return destination;
  }
}

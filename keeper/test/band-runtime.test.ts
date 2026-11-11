import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeyPairSignerFromBytes, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, lamports, type Address } from "@solana/kit";
import { Harness, amount } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { capture } from "./resale-support.js";
const fixture = vi.hoisted(() => ({ rpc: undefined as any, sockets: [] as any[] }));
vi.mock("../src/common/rpc.js", async () => {
  const actual = await vi.importActual<any>("../src/common/rpc.js");
  return { ...actual, RpcPool: class { constructor() { return fixture.rpc; } } };
});
vi.mock("../src/common/ws.js", () => ({ Subscriptions: class {
  ready = true; endpoint = "local-vm"; subs: any[] = []; closed = false;
  constructor() { fixture.sockets.push(this); }
  subscribe(kind: string, args: any[], cb: any) {
    const sub = { kind, args, cb }; this.subs.push(sub);
    if (kind === "signatureSubscribe") queueMicrotask(() => cb({ context: { slot: 1 }, value: { err: null } }));
    return () => { this.subs = this.subs.filter(s => s !== sub); };
  }
  on() {} start() {} close() { this.closed = true; this.subs = []; }
} }));
import { runKeeper, createPrepare } from "../src/keeper/main.js";
import { Chain, pairedSpanBalance } from "../src/keeper/chain.js";
import { Engine } from "../src/keeper/engine.js";
import { Sender, type Action, type Prepared } from "../src/keeper/sender.js";
import { readerOptions } from "../src/keeper/reader-policy.js";
import { ROOT } from "../src/common/env.js";
import { keeperLock } from "../src/keeper/lock.js";
import { RpcFault } from "../src/common/rpc.js";
import { runTape } from "../src/tape/main.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.sockets = []; });
const wait = async (fn: () => boolean) => {
  const end = performance.now() + 6000;
  while (!fn()) { if (performance.now() > end) throw Error("Local reader timeout"); await new Promise(r => setTimeout(r, 5)); }
};
async function signer(dir: string, name: string) {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const bytes = Buffer.concat([Buffer.from(key.d!, "base64url"), Buffer.from(key.x!, "base64url")]), file = join(dir, name + ".json");
  writeFileSync(file, JSON.stringify([...bytes]), { mode: 0o600 });
  return { signer: await createKeyPairSignerFromBytes(bytes), file };
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "span-reader-runtime-")), h = await Harness.create(),
    greedy = await signer(dir, "greedy"), paced = await signer(dir, "paced");
  h.marker = greedy.signer; h.stranger = paced.signer;
  for (const p of [h.marker, h.stranger]) h.svm.airdrop(p.address, lamports(100000000000n));
  h.svm.withBlockhashCheck(false);
  const spanSetup=capture(h,Buffer.from((await import("@solana/kit")).getTransactionEncoder().encode(await h.transaction([h.ix("setSpan",{admin:h.admin,burnPerMark:100n})],h.admin))).toString("base64"));
  const catalog = join(dir, "readers.json");
  writeFileSync(catalog, JSON.stringify({ v: 1, readers: [
    { id: "greedy", marker: greedy.signer.address, mode: "full", policy: "greedy" },
    { id: "paced-v1", marker: paced.signer.address, mode: "marks", policy: "paced-v1" }] }));
  const raw = (key: Address) => {
    const a = h.svm.getAccount(key);
    return a.exists ? { executable: a.executable, owner: a.programAddress, lamports: Number(a.lamports), data: [Buffer.from(a.data).toString("base64"), "base64"] } : null;
  };
  const rows: { payer: string; kind: string; wire: string; error: any; cu:number }[] = [];
  let failInit = false;
  const rpc: any = { cluster: "mainnet", metrics: { snapshot: () => ({}) }, closed: false,
    initialize: async () => { if (failInit) throw Error("Local initialization failure"); }, close: () => { rpc.closed = true; },
    call: async (method: string, args: any[] = []) => {
      const context = { slot: Number(h.svm.getClock().slot) };
      if (method === "getAccountInfo") return { context, value: raw(args[0]) };
      if (method === "getMultipleAccounts") return { context, value: args[0].map(raw) };
      if (method === "getProgramAccounts") return { context, value: h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS)
        .filter(a => (!args[1].filters?.length || getBase58Decoder().decode(a.data.subarray(0, 8)) === args[1].filters[0].memcmp.bytes))
        .map(a => ({ pubkey: a.address, account: raw(a.address) })) };
      if (method === "getLatestBlockhash") return { value: { blockhash: h.svm.latestBlockhash(), lastValidBlockHeight: 10000000000 } };
      if (method === "getBlockHeight") return 1;
      if (method === "getEpochInfo") return { blockHeight: 20000000000, absoluteSlot: context.slot };
      if (method === "getSignaturesForAddress" || method === "getRecentPrioritizationFees") return [];
      if (method === "getBalance") return { value: 100000000000 };
      if (method === "getMinimumBalanceForRentExemption") return Number(h.svm.minimumBalanceForRentExemption(BigInt(args[0])));
      throw Error(`Unexpected local RPC ${method}`);
    },
    callAt: async (method: string, args: any[], _mode: any, _a: any, _b: any, onRequest: () => void) => {
      expect(method).toBe("sendTransaction"); onRequest();
      const tx = getTransactionDecoder().decode(Buffer.from(args[0], "base64")), message: any = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
        instruction = message.instructions.find((i: any) => message.staticAccounts[i.programAddressIndex] === s.SPAN_PROGRAM_ADDRESS)!;
      const discriminator = Buffer.from(instruction.data!.subarray(0, 8));
      const kind = discriminator.equals(Buffer.from(s.MARK_DISCRIMINATOR)) ? "mark" :
        discriminator.equals(Buffer.from(s.READ_DISCRIMINATOR)) ? "read" : discriminator.equals(Buffer.from(s.SETTLE_DISCRIMINATOR)) ? "settle" : "other";
      const result = capture(h, args[0]); rpc.onCapture?.(result); rows.push({ payer: message.staticAccounts[0], kind, wire: args[0], error: result.tx.meta.err, cu:result.tx.meta.computeUnitsConsumed });
      if (result.tx.meta.err) {
        const code = Number(/Error Number: (\d+)/.exec(result.tx.meta.logMessages.join("\n"))?.[1]);
        throw new RpcFault("sendTransaction", -32002, { err: { InstructionError: [2, { Custom: code }] } }, true);
      }
      return { value: result.signature, endpoint: "local-vm" };
    } };
  fixture.rpc = rpc;
  vi.stubEnv("SPAN_CLUSTER", "mainnet"); vi.stubEnv("KEEPER_ALLOW_MAINNET", "1");
  vi.stubEnv("KEEPER_RELEASE_HOURS", "0"); vi.stubEnv("KEEPER_HALF_HOURS", "0"); vi.stubEnv("SPAN_READERS_FILE", catalog);
  vi.stubEnv("KEEPER_PRIORITY_FEE_MIN", "10000"); vi.stubEnv("KEEPER_ASSETS", "SOL");
  const start = async (policy: "greedy" | "paced-v1", suffix: string = policy) => {
    const data = mkdtempSync(join(dir, suffix + "-")); writeFileSync(join(data, "mainnet-keeper.json"), '{"lastValidBlockHeight":"1"}');
    vi.stubEnv("KEEPER_ACTION_MODE", policy === "greedy" ? "full" : "marks"); vi.stubEnv("KEEPER_MARK_POLICY", policy);
    vi.stubEnv("KEEPER_KEYPAIR", policy === "greedy" ? greedy.file : paced.file); vi.stubEnv("KEEPER_DATA_DIR", data);
    return runKeeper({ releaseHours: [] });
  };
  return { h, dir, greedy, paced, start, rpc, rows, spanSetup, failInit: (v: boolean) => { failInit = v; } };
}
import { spawnSync } from "node:child_process";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { Publisher } from "../src/tape/publish.js";
import { liveDocuments } from "../src/tape/state.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { TOKEN } from "../../program/client/constants.js";
import type { Ref } from "../../program/tests/harness.js";

it("actual full and paced runtimes carry all three widths through entry, marks, resale, bid, settlement, cleanup and both public boundaries", async()=>{
 const x=await setup(),{h}=x;
 const base=process.env.SPAN_BAND_OUT??x.dir;mkdirSync(base,{recursive:true});
 const dir=mkdtempSync(join(base,"runtime-")),store=new Store(join(dir,"tape.sqlite")),history=new History(store,x.rpc,()=>{}),recorder=new DovesRecorder(store,x.rpc);
 const captured:any[]=[];
 const ingest=(row:any)=>{if(row.tx.meta.err)return;captured.push(row);history.ingest(row.signature,row.tx);};
 x.rpc.onCapture=ingest;
 const execute=async(ixs:any[],payer=h.buyer)=>{const tx=await h.transaction(ixs,payer),row=capture(h,Buffer.from((await import("@solana/kit")).getTransactionEncoder().encode(tx)).toString("base64"));expect(row.tx.meta.err,row.tx.meta.logMessages.join("\n")).toBe(null);ingest(row);return row;};
 ingest(x.spanSetup);
 const refs:{t:Ref;until:any;bandBps:number;policy:"greedy"|"paced-v1"}[]=[];
 for(const policy of ["greedy","paced-v1"] as const)for(const bandBps of [100,200,400]){
  const t=await h.ref(),until=(await s.findUntilPda(t.ticket))[0];
  await execute([...(refs.length?[]:[h.openCandleIx(t)]),h.ix("openRunning",{...t,until,untilArg:t.t0+3600n,premium:1000000n,strikeBps:100,bandBps,sellerSource:h.sellerUsdc})],h.seller);
  refs.push({t,until,bandBps,policy});
 }
 const adminUsdc=await h.fundToken(h.admin,h.configState().usdcMint,TOKEN,1000000000n),adminSpan=await h.fundToken(h.admin,h.spanMint,h.spanProgram,1000000n);
 let full:Awaited<ReturnType<typeof runKeeper>>|undefined,paced:typeof full;
 const sync=async()=>{for(const live of [full,paced])if(live){await live.chain.pollClock();await live.chain.pollPrograms();await live.chain.pollSpanHolds("keeper");await live.chain.pollFeed();live.engine.update();}};
 const feed=async(elapsed:bigint,price:bigint)=>{h.clock(1200n+elapsed);h.price(price,1200n+elapsed);await sync();};
 const done=async(predicate:()=>boolean)=>{const until=performance.now()+10000;while(!predicate()){if(performance.now()>until)throw Error("Band runtime timeout");await sync();await new Promise(r=>setTimeout(r,5));}};
 try{
  full=await x.start("greedy");paced=await x.start("paced-v1");
  expect(liveDocuments(full.chain,history,()=>null,3).state.candles[0].tickets.offers.map(t=>t.bandBps)).toEqual([100,200,400]);
  expect(liveDocuments(full.chain,history,()=>null,2).state.candles[0].tickets.open).toBe(2);
  await feed(0n,10000000000n);await done(()=>h.candleState(refs[0].t).reads[0].price>0n);
  await feed(60n,10120000000n);
  for(const {t,until,policy} of refs)await execute([h.ix("buyRunning",{...t,until,buyerSource:h.buyerUsdc,maxPay:40000000n}),h.loadIx(t,{amount:500n,marker:policy==="greedy"?h.marker.address:h.stranger.address})]);
  await feed(70n,10140000000n);await done(()=>refs.every(({t})=>h.ticketState(t).marks===1));
  for(const {t,policy}of refs){
   const resale=(await s.findResalePda(t.ticket))[0],bid=(await s.findBidPda(t.ticket,h.buyer.address))[0],bidUsdc=(await s.findBidUsdcPda(bid))[0],bidSpan=(await s.findBidSpanPda(bid))[0];
   await execute([h.ix("listResale",{...t,resale,holder:h.buyer,ask:100000n,until:4800n})]);
   await execute([h.ix("buyResale",{...t,resale,holder:h.buyer.address,holderUsdc:h.buyerUsdc,buyer:h.admin,buyerSource:adminUsdc,maxPay:40000000n,holderSpan:h.buyerSpan})],h.admin);
   await execute([h.ix("placeBid",{...t,bid,bidUsdc,bidder:h.buyer,bidderSource:h.buyerUsdc,ask:100000n,cap:40000000n,until:4800n}),h.ix("bidSpan",{bid,bidUsdc,bidSpan,bidder:h.buyer,spanSource:h.buyerSpan,amount:500n,stepBps:5,marker:policy==="greedy"?h.marker.address:h.stranger.address})]);
   await sync();
   const mixed=liveDocuments(full.chain!,history,()=>null,3).tickets,legacy=liveDocuments(full.chain!,history,()=>null,2).tickets;
   expect(mixed.tickets.find(r=>r.address===t.ticket)!.bids).toHaveLength(1);
   expect(legacy.tickets.every(r=>refs.find(x=>x.t.ticket===r.address)!.bandBps===400)).toBe(true);
   await execute([h.ix("acceptBid",{...t,bid,bidUsdc,bidSpan,bidder:h.buyer.address,bidderUsdc:h.buyerUsdc,holder:h.admin,holderUsdc:adminUsdc,holderSpan:undefined,resale,feed:h.feed})],h.admin);
  }
  for(let j=1;j<=12;j++){await feed(BigInt(j*300),10000000000n);await done(()=>h.candleState(refs[0].t).reads[j].price>0n);}
  h.clock(s.settleAfter(h.candleState(refs[0].t)));await sync();await done(()=>refs.every(({t,until})=>!h.svm.getAccount(t.ticket).exists&&!h.svm.getAccount(until).exists&&!h.svm.getAccount(t.band).exists));
  const pub=new Publisher(store,full.chain,history,recorder,join(dir,"public"));full.chain.lastReadMs=Date.now();pub.publish(Date.now()+3000);
  const docs=Object.fromEntries(["v2","v3"].map(v=>[v,JSON.parse(readFileSync(join(dir,"public",v,"history.json"),"utf8"))]));
  for(const name of ["feed.json","hours.json"])expect(readFileSync(join(dir,"public/v3",name))).toEqual(readFileSync(join(dir,"public/v2",name)));
  expect(docs.v3.receipts).toHaveLength(6);expect(docs.v2.receipts).toHaveLength(2);
  for(const {t,bandBps}of refs){const r=docs.v3.receipts.find((r:any)=>r.ticket===t.ticket);expect(r.bandBps).toBe(bandBps);expect(r.payout).toBe(String(4000000n*BigInt(400/bandBps)));expect(r.transfers.map((x:any)=>x.via)).toEqual(["resale","bid"]);expect(r.entry.recorded).toBe(String(2000000n*BigInt(400/bandBps)));}
  expect(history.events("BandClosed")).toHaveLength(4);expect(history.events("UntilClosed")).toHaveLength(6);
  const script=resolve(import.meta.dirname,"recalculate.py"),checked=spawnSync("python3",[script,join(dir,"tape.sqlite"),"--public",join(dir,"public")],{encoding:"utf8"});expect(checked.status,checked.stdout+checked.stderr).toBe(0);writeFileSync(join(dir,"recalculated.json"),checked.stdout);
  const path=join(dir,"public/v3/history.json"),bad=JSON.parse(readFileSync(path,"utf8"));bad.receipts.find((r:any)=>r.bandBps===100).bandBps=200;writeFileSync(path,JSON.stringify(bad));const rejected=spawnSync("python3",[script,join(dir,"tape.sqlite"),"--public",join(dir,"public")],{encoding:"utf8"});expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain("public payout band");writeFileSync(path,JSON.stringify(docs.v3));
  const event=history.events("BandSet").find(e=>e.widthBps===100)!,stored=store.db.prepare("SELECT raw FROM transactions WHERE sig=?").get(event.sig) as {raw:string},tampered=JSON.parse(stored.raw),kit=await import("@solana/kit");
  const discriminator=(await import("node:crypto")).createHash("sha256").update("event:BandSet").digest().subarray(0,8);
  let changed=false;
  for(const group of tampered.meta.innerInstructions)for(const ix of group.instructions){const data=Buffer.from(kit.getBase58Encoder().encode(ix.data));if(data.subarray(8,16).equals(discriminator)){data.writeUInt16LE(200,56);ix.data=kit.getBase58Decoder().decode(data);changed=true;}}
  expect(changed).toBe(true);store.db.prepare("UPDATE transactions SET raw=? WHERE sig=?").run(JSON.stringify(tampered),event.sig);
  const rawRejected=spawnSync("python3",[script,join(dir,"tape.sqlite")],{encoding:"utf8",timeout:10000});expect(rawRejected.status).not.toBe(0);store.db.prepare("UPDATE transactions SET raw=? WHERE sig=?").run(stored.raw,event.sig);
  const result={receipts:docs.v3.receipts.map((r:any)=>({ticket:r.ticket,bandBps:r.bandBps,payout:r.payout,entry:r.entry,transfers:r.transfers})),actions:x.rows.map(r=>({kind:r.kind,bytes:Buffer.from(r.wire,"base64").length,error:r.error,cu:r.cu})),bandClosed:4,untilClosed:6};writeFileSync(join(dir,"result.json"),JSON.stringify(result,null,2));console.log("BAND_RUNTIME",JSON.stringify({dir,receipts:6,bandClosed:4,untilClosed:6}));
 }finally{full?.close();paced?.close();store.close();}
},60000);

import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction } from "@solana/kit";
import { Harness, accountData } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { releaseHours, RELEASE_HOURS } from "../src/common/release-hours.js";
import { Engine, type EnginePort } from "../src/keeper/engine.js";
import { createPrepare } from "../src/keeper/main.js";
import { CreationBudget } from "../src/keeper/budget.js";
import type { Chain } from "../src/keeper/chain.js";
import type { Prepared } from "../src/keeper/sender.js";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
const T = RELEASE_HOURS[1];
const flush = async () => { for (let i=0;i<20;i++) await new Promise<void>(r=>setTimeout(r,5)); };
async function fixture(hours: readonly bigint[] = []) {
  const h=await Harness.create(), ref=await h.ref(T);
  let now=T-86401n;
  const chain={ configKey:h.config, config:s.getConfigDecoder().decode(accountData(h.svm,h.config)), candles:new Map(), tickets:new Map(), now:()=>now } as unknown as Chain;
  const budget=new CreationBudget({call:vi.fn()} as any,h.marker.address,50000000n,0n); budget.ready=true;
  const sent:Prepared[]=[], logs:any[]=[], ixs=new Map<string,readonly Instruction[]>();
  const rpc={call:vi.fn(async()=>1905000)} as any;
  const prepare=await createPrepare(rpc,h.marker,chain,{register:(key,list)=>{ixs.set(key,list);}},()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}));
  const port:EnginePort={blockhash:()=> '11111111111111111111111111111111',price:()=>10000n,prepare,send:p=>{sent.push(p);},cancel:vi.fn()};
  const engine=new Engine(chain,h.marker.address,port,budget,e=>logs.push(e),hours);
  const setNow=(n:bigint)=>{now=n;h.clock(n);};
  const sync=()=>chain.candles.set(ref.candle,{value:h.candleState(ref),slot:1,data:''});
  return {h,ref,chain,budget,sent,logs,ixs,rpc,prepare,port,engine,setNow,sync};
}
it("rejects each malformed release schedule at load",()=>{
  const row={type:'Jobs',date:'2026-11-06',et:'08:30',t:Number(T+60n)};
  expect(releaseHours([row])).toEqual([T]);
  for(const rows of [[{...row,t:row.t+1}],[{...row,type:'OPEN'}],[{...row,t:row.t+60},row],[row,row]])
    expect(()=>releaseHours(rows)).toThrow('Invalid release hour');
});
it("disabled default has no opens and ignores ticketless candles",async()=>{
  const x=await fixture();x.setNow(T-86400n);x.engine.update();await flush();expect(x.sent).toHaveLength(0);
  await x.h.send('candle',x.h.openCandleIx(x.ref));x.sync();x.setNow(T);
  x.chain.feed={price:10000000000n,publishTs:T,source:'poll',recvMs:Date.now(),slot:1};
  x.engine.update();await flush();expect(x.sent).toHaveLength(0);x.engine.close();
});
it("open starts exactly a day ahead, stops at the guarded cutoff and skips existing candles",async()=>{
  const x=await fixture([T]);x.engine.update();await flush();expect(x.sent).toHaveLength(0);
  x.setNow(T-86400n);x.engine.update();await flush();expect(x.sent.map(p=>p.action.kind)).toEqual(['open']);
  const p=x.sent[0];expect(p.rent).toBe(1905000n);
  const tx=getTransactionDecoder().decode(Buffer.from(p.wire,'base64'));
  const m=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (m.version === 1) throw Error('Unexpected transaction version');
  expect(new DataView(m.instructions[0].data!.buffer,m.instructions[0].data!.byteOffset).getUint32(1,true)).toBe(40000);
  await x.h.send('open release',x.ixs.get(p.action.key)!,x.h.marker);x.sync();x.engine.update();x.engine.update();
  expect(x.engine.pending.size).toBe(0);expect(x.engine.prepared.size).toBe(0);
  expect(x.logs.filter(e=>e.event==='recorded'&&e.kind==='open')).toHaveLength(1);x.engine.close();
  for(const delta of [-1n,0n,1n]) {
    const y=await fixture([T]);y.setNow(T-BigInt(y.chain.config!.buyCutoff)-30n+delta);y.engine.update();await flush();
    expect(y.sent).toHaveLength(delta<0n?1:0);y.engine.close();
  }
});
it("cached prepare rent flows through the budget; observation cancels waiting work",async()=>{
  const x=await fixture([T]);x.budget.used=49000000n;x.setNow(T-86400n);x.engine.update();await flush();
  const key=`open:${T}`;expect(x.budget.waiting.has(key)).toBe(true);expect(x.sent).toHaveLength(0);
  x.budget.used=0n;x.engine.update();expect(x.sent).toHaveLength(1);expect(x.budget.reserved()).toBe(1905000n);
  await x.prepare({kind:'open',key,t0:T},10001n);expect(x.rpc.call).toHaveBeenCalledTimes(1);x.engine.close();
  const y=await fixture([T]);y.budget.used=49000000n;y.setNow(T-86400n);y.engine.update();await flush();
  await y.h.send('other payer',y.h.openCandleIx(y.ref));y.sync();y.engine.update();
  expect(y.budget.waiting.size).toBe(0);expect(y.engine.prepared.size).toBe(0);expect(y.sent).toHaveLength(0);y.engine.close();
  expect(y.logs.filter(e=>e.kind==='open')).toHaveLength(0);
});
it("BuyClosed abandons the open; other errors wait two seconds",async()=>{
  vi.useFakeTimers({toFake:['Date']});
  try {
    const x=await fixture([T]);x.setNow(T-86400n);x.engine.update();await flush();
    x.engine.result(x.sent[0],'BuyClosed','preflight');vi.advanceTimersByTime(3000);x.engine.update();await flush();
    expect(x.engine.abandoned.has(`open:${T}`)).toBe(true);expect(x.sent).toHaveLength(1);x.engine.close();
    const y=await fixture([T]);y.setNow(T-86400n);y.engine.update();await flush();y.engine.result(y.sent[0],'RPCTransport','preflight');
    y.engine.update();await flush();expect(y.sent).toHaveLength(1);vi.advanceTimersByTime(1999);y.engine.update();await flush();expect(y.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);y.engine.update();await flush();expect(y.sent).toHaveLength(2);y.engine.close();
  } finally {vi.useRealTimers();}
});
it("an observed candle discards an in-flight open preparation",async()=>{
  const x=await fixture([T]);let release!:()=>void;
  const prepare=x.port.prepare;x.port.prepare=(a,p)=>new Promise(resolve=>{void prepare(a,p).then(prepared=>{release=()=>resolve(prepared);});});
  x.setNow(T-86400n);x.engine.update();await flush();await x.h.send('other opens',x.h.openCandleIx(x.ref));x.sync();x.engine.update();release();await flush();
  expect(x.sent).toHaveLength(0);expect(x.engine.prepared.size).toBe(0);x.engine.close();
});
it("drives thirteen actual program reads without a ticket, excluding unlisted candles",async()=>{
  const x=await fixture([T]);x.setNow(T-100n);await x.h.send('ticketless open',x.h.openCandleIx(x.ref));x.sync();
  const other=await x.h.ref(T+60n);await x.h.send('unlisted open',x.h.openCandleIx(other));x.chain.candles.set(other.candle,{value:x.h.candleState(other),slot:1,data:''});
  for(let j=0;j<13;j++) {
    x.setNow(T+BigInt(j*300));const price=10000000000n+BigInt(j)*1000000n;x.h.price(price,T+BigInt(j*300));
    x.chain.feed={price,publishTs:T+BigInt(j*300),source:'poll',recvMs:Date.now(),slot:j+1};
    x.engine.update();await flush();const p=x.sent.at(-1)!;expect(p.action.kind).toBe('read');expect(p.action.j).toBe(j);expect(p.action.t0).toBe(T);
    await x.h.send(`read ${j}`,x.ixs.get(p.action.key)!,x.h.marker);x.sync();x.engine.update();
  }
  expect(x.sent).toHaveLength(13);expect(x.h.candleState(x.ref).reads.every(r=>r.price>0n)).toBe(true);expect(x.h.candleState(other).reads.every(r=>r.price===0n)).toBe(true);expect(x.chain.tickets.size).toBe(0);x.engine.close();
});
it("publishes ticketless releases at settleAfter, including voids and late discovery",async()=>{
  const x=await fixture([T]);x.setNow(T-100n);await x.h.send('release',x.h.openCandleIx(x.ref));x.sync();
  const voidRef=await x.h.ref(T-86400n);x.setNow(voidRef.t0-100n);await x.h.send('void',x.h.openCandleIx(voidRef));
  const outsider=await x.h.ref(T-60n);await x.h.send('outsider',x.h.openCandleIx(outsider));
  x.chain.candles.set(outsider.candle,{value:x.h.candleState(outsider),slot:1,data:''});
  const store=new Store(':memory:'),rpc={cluster:'devnet'} as any,recorder=new DovesRecorder(store,rpc),history=new History(store,rpc,()=>{}),dir=mkdtempSync(join(tmpdir(),'span-releases-'));
  const pub=new Publisher(store,x.chain,history,recorder,dir,undefined,[T,voidRef.t0]);
  recorder.sample('p0',10000000000n,Number(T),1);recorder.sample('close',10100000000n,Number(T+3600n),2);
  const end=s.settleAfter(x.h.candleState(x.ref));x.setNow(end-1n);pub.publish(10000);expect(JSON.parse(readFileSync(join(dir,'history.json'),'utf8')).candles).toHaveLength(0);
  const revision=store.revision;x.setNow(end);pub.publish(12000);expect(store.revision).toBe(revision);
  expect(JSON.parse(readFileSync(join(dir,'history.json'),'utf8')).candles.map((c:any)=>c.t0)).toEqual([String(T)]);
  x.setNow(T+3720n);pub.publish(12250);expect(existsSync(join(dir,'candles',`${T}.json`))).toBe(true);
  x.chain.candles.set(voidRef.candle,{value:x.h.candleState(voidRef),slot:1,data:''});pub.publish(14000);
  const doc=JSON.parse(readFileSync(join(dir,'history.json'),'utf8'));expect(doc.candles.map((c:any)=>c.t0)).toEqual([String(T),String(voidRef.t0)]);expect(doc.candles[1].reads).toEqual(Array(13).fill(null));expect(doc.receipts).toEqual([]);
  store.close();x.engine.close();
});

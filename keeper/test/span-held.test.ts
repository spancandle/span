import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
import { expect, it, vi } from "vitest";
import { getAddressEncoder, type Address } from "@solana/kit";
import { Harness, accountData } from "../../program/tests/harness.js";
import * as s from "../../program/client/index.js";
import { TOKEN_2022 } from "../../program/client/constants.js";
import { Chain, spanHeld } from "../src/keeper/chain.js";
import { Engine, type EnginePort } from "../src/keeper/engine.js";
import type { Prepared } from "../src/keeper/sender.js";
import { liveDocuments } from "../src/tape/state.js";
import { validateDocument } from "./schemas.js";
const flush = async () => { for (let i=0;i<20;i++) await new Promise<void>(r=>queueMicrotask(r)); };
async function setup(spanProgram?: Address, loaded=100000n) {
  const h=await Harness.create({setSpan:true,spanProgram}), ref=await h.open({sold:true});
  await h.send('load',h.loadIx(ref,{amount:loaded}),h.buyer);
  h.clock(ref.t0);h.price(10000000000n,ref.t0);await h.send('opening read',h.readIx(ref,0));h.clock(ref.t0+30n);
  let slot=10, fail=false;
  const raw=(key:Address)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
  const rpc={cluster:'devnet',call:vi.fn(async(method:string,params:any[])=>{
    expect(method).toBe('getMultipleAccounts');if(fail)throw Error('Unavailable');
    return {context:{slot},value:params[0].map(raw)};
  })};
  const chain=new Chain(rpc as any,{} as any,()=>{},h.marker.address);chain.config=h.configState();
  chain.now=()=>h.svm.getClock().unixTimestamp;
  chain.candles.set(ref.candle,{value:h.candleState(ref),slot:1,data:''});
  chain.tickets.set(ref.ticket,{value:h.ticketState(ref),slot:1,data:''});
  chain.feed={publishTs:ref.t0+30n,price:10100000000n,slot:10,source:'poll',recvMs:Date.now()};
  const sent:Prepared[]=[], port:EnginePort={blockhash:()=> 'hash',price:()=>1n,
    prepare:async(action,price)=>({action,price,signature:String(sent.length)+':'+action.key,wire:'',blockhash:'hash',lastValidBlockHeight:100n,rent:0n}),send:p=>{sent.push(p);},cancel:vi.fn()};
  const engine=new Engine(chain,h.marker.address,port,{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
  return {h,ref,chain,rpc,raw,port,engine,sent,setFail:(v:boolean)=>{fail=v;},setSlot:(v:number)=>{slot=v;}};
}
it('tickets.json subtracts a websocket-observed burn without another holding read and keeps total input constant',async()=>{
  const x=await setup(),out=mkdtempSync(join(tmpdir(),'span-held-')),
    store=new Store(':memory:'),rpc={cluster:'devnet'} as any,
    history=new History(store,rpc,()=>{}),pub=new Publisher(store,x.chain,history,new DovesRecorder(store,rpc),out);
  try{
    x.chain.lastReadMs=Date.now();await x.chain.pollSpanHolds('tape');pub.publish(x.chain.lastReadMs);
    const read=()=>JSON.parse(readFileSync(join(out,'tickets.json'),'utf8')).tickets[0];
    const before=read();expect(before.spanHeld).toBe('100000');
    x.h.price(10100000000n,x.ref.t0+30n);await x.h.send('mark',x.h.markIx(x.ref),x.h.marker);
    x.chain.ingest('ticket',x.ref.ticket,x.raw(x.ref.ticket),11);
    pub.publish(x.chain.lastReadMs+250);
    const after=read();expect(after.burned).toBe('100');expect(after.spanHeld).toBe('99900');
    expect(BigInt(after.spanHeld)+BigInt(after.burned)).toBe(100000n);
    expect(BigInt(after.spanHeld)/x.chain.config!.burnPerMark).toBe(999n);
    expect(x.rpc.call).toHaveBeenCalledTimes(1);
  }finally{store.close();x.engine.close();}
});
it('does not send another mark after the websocket observes the last funded burn, without another holding read',async()=>{
  const x=await setup(undefined,100n);
  try{
    await x.chain.pollSpanHolds('keeper');x.engine.update();await flush();
    expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);
    x.h.price(10100000000n,x.ref.t0+30n);await x.h.send('mark',x.h.markIx(x.ref),x.h.marker);
    x.chain.ingest('ticket',x.ref.ticket,x.raw(x.ref.ticket),11);
    x.chain.feed={...x.chain.feed!,publishTs:x.ref.t0+31n,price:10200000000n};
    x.engine.update();await flush();
    expect(x.chain.tickets.get(x.ref.ticket)!.value.burned).toBe(100n);
    expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);
    expect(x.rpc.call).toHaveBeenCalledTimes(1);
  }finally{x.engine.close();}
});
it('reconciles a ticket cache behind the paired read for tape, while the keeper never exceeds the read holding',async()=>{
  const x=await setup(undefined,100n);
  try{
    x.h.price(10100000000n,x.ref.t0+30n);await x.h.send('mark',x.h.markIx(x.ref),x.h.marker);
    await x.chain.pollSpanHolds('tape');
    expect(x.chain.tickets.get(x.ref.ticket)!.value.burned).toBe(0n);
    expect(x.chain.spanHolds.get(x.ref.ticket)?.amount).toBe(0n);
    const doc=liveDocuments(x.chain,{events:()=>[]} as any).tickets;
    validateDocument('tickets',doc);expect(doc.tickets[0].spanHeld).toBe('100');
    expect(BigInt(doc.tickets[0].spanHeld)+BigInt(doc.tickets[0].burned)).toBe(100n);
    x.engine.update();await flush();expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(0);
  }finally{x.engine.close();}
});
it('keeps SpanShort fenced when a later read is sufficient before adjusting for the cached ticket burn',async()=>{
  const x=await setup(undefined,100n);
  try{
    await x.chain.pollSpanHolds('keeper');x.engine.update();await flush();
    const first=x.sent.find(p=>p.action.kind==='mark')!,pair=[x.raw(x.ref.ticket),x.raw(x.ref.spanHold)];
    x.engine.result(first,'SpanShort','signature');
    x.h.price(10100000000n,x.ref.t0+30n);await x.h.send('mark',x.h.markIx(x.ref),x.h.marker);
    x.chain.ingest('ticket',x.ref.ticket,x.raw(x.ref.ticket),11);
    x.rpc.call.mockResolvedValueOnce({context:{slot:12},value:pair});await x.chain.pollSpanHolds('keeper');
    expect(x.chain.spanHolds.get(x.ref.ticket)?.read).toBe(2);
    expect(x.chain.spanHolds.get(x.ref.ticket)?.amount).toBe(100n);
    x.chain.feed={...x.chain.feed!,publishTs:x.ref.t0+31n,price:10200000000n};x.engine.update();await flush();
    expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);
    expect(x.engine.endedMarks.has(x.ref.ticket)).toBe(false);
  }finally{x.engine.close();}
});
it('clamps a reconciled holding and the unread lower bound at zero',()=>{
  expect(spanHeld({spanLoaded:100n,burned:300n},{amount:50n,burned:100n,slot:10,read:1})).toBe(0n);
  expect(spanHeld({spanLoaded:100n,burned:300n})).toBe(0n);
});
it('reads the actual classic and Token-2022 holding once per batch and uses it over the inferred remainder',async()=>{
  for(const program of [undefined,TOKEN_2022]){
    const x=await setup(program),t=x.chain.tickets.get(x.ref.ticket)!.value;
    t.spanLoaded=199n;t.burned=100n;
    await x.chain.pollSpanHolds('keeper');expect(x.rpc.call).toHaveBeenCalledTimes(1);
    expect(x.chain.spanHolds.get(x.ref.ticket)?.amount).toBe(100000n);
    x.engine.update();await flush();expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);x.engine.close();
  }
});
it('uses the inferred lower bound only until a holding has been read',async()=>{
  const x=await setup();x.engine.update();await flush();expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);x.engine.close();
  const y=await setup();y.chain.spanHolds.set(y.ref.ticket,{amount:0n,burned:0n,slot:10,read:1});y.engine.update();await flush();expect(y.sent.filter(p=>p.action.kind==='mark')).toHaveLength(0);y.engine.close();
});
it('SpanShort fences existing and in-flight balance reads; only a later sufficient read resumes the latest publication',async()=>{
  const x=await setup();await x.chain.pollSpanHolds('keeper');x.engine.update();await flush();
  const first=x.sent.find(p=>p.action.kind==='mark')!;expect(first).toBeDefined();
  let release!:(v:any)=>void, started!:()=>void;const pair=[x.raw(x.ref.ticket),x.raw(x.ref.spanHold)];
  const ready=new Promise<void>(resolve=>{started=resolve;});
  x.rpc.call.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;started();}));
  const delayed=x.chain.pollSpanHolds('keeper');
  await ready;
  expect(release).toBeDefined();x.engine.result(first,'SpanShort','signature');
  release({context:{slot:11},value:pair});await delayed;
  x.chain.feed={...x.chain.feed!,publishTs:x.ref.t0+31n,price:10200000000n};x.engine.update();await flush();
  expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);expect(x.engine.endedMarks.has(x.ref.ticket)).toBe(false);
  const zero=Buffer.from(accountData(x.h.svm,x.ref.spanHold));zero.writeBigUInt64LE(0n,64);
  x.rpc.call.mockResolvedValueOnce({context:{slot:12},value:[pair[0],{owner:x.h.spanProgram,data:[zero.toString('base64'),'base64']}]});
  await x.chain.pollSpanHolds('keeper');x.engine.update();await flush();expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);
  x.setSlot(13);await x.chain.pollSpanHolds('keeper');x.engine.update();await flush();
  expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(2);
  expect(x.chain.feed.publishTs).toBe(x.ref.t0+31n);x.engine.close();
});
it('CapReached stays terminal even after a fresh sufficient balance',async()=>{
  const x=await setup();x.engine.update();await flush();const p=x.sent.find(p=>p.action.kind==='mark')!;
  x.engine.result(p,'CapReached','signature');await x.chain.pollSpanHolds('keeper');
  x.chain.feed={...x.chain.feed!,publishTs:x.ref.t0+31n,price:10200000000n};x.engine.update();await flush();
  expect(x.engine.endedMarks.has(x.ref.ticket)).toBe(true);expect(x.sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);x.engine.close();
});
it('keeper reads only its loaded Sold tickets, inclusively inside the recording interval; tape reads all unsettled loaded tickets',async()=>{
  const x=await setup(),own=x.chain.tickets.get(x.ref.ticket)!;
  const other=(await s.findTicketPda(999n))[0];x.chain.tickets.set(other,{...own,value:{...own.value,marker:x.h.stranger.address}});
  for(const [now,expected]of [[x.ref.t0-1n,0],[x.ref.t0,1],[x.ref.t0+3620n,1],[x.ref.t0+3621n,0]]as const){
    x.h.clock(now);x.rpc.call.mockClear();await x.chain.pollSpanHolds('keeper');expect(x.rpc.call).toHaveBeenCalledTimes(expected);
    if(expected)expect(x.rpc.call.mock.calls[0][1][0]).toEqual([x.ref.ticket,x.ref.spanHold]);
  }
  x.rpc.call.mockClear();await x.chain.pollSpanHolds('tape');expect(x.rpc.call.mock.calls[0][1][0]).toHaveLength(4);
  own.value.spanLoaded=0n;x.chain.tickets.delete(other);x.rpc.call.mockClear();await x.chain.pollSpanHolds('tape');expect(x.rpc.call).toHaveBeenCalledTimes(0);
  own.value.spanLoaded=100n;own.value.state=s.TicketState.Open;await x.chain.pollSpanHolds('tape');expect(x.rpc.call).toHaveBeenCalledTimes(0);x.engine.close();
});
it('publishes spanHeld as an integer string at v1, including zero without SPAN and the initial fallback',async()=>{
  const x=await setup();const history={events:()=>[]} as any;
  let doc=liveDocuments(x.chain,history).tickets;validateDocument('tickets',doc);expect(doc.tickets[0].spanHeld).toBe('100000');
  await x.chain.pollSpanHolds('tape');x.chain.spanHolds.get(x.ref.ticket)!.amount=123456n;
  doc=liveDocuments(x.chain,history).tickets;validateDocument('tickets',doc);expect(doc.v).toBe(1);expect(doc.tickets[0].spanHeld).toBe('123456');
  x.chain.tickets.get(x.ref.ticket)!.value.spanLoaded=0n;expect(liveDocuments(x.chain,history).tickets.tickets[0].spanHeld).toBe('0');x.engine.close();
});
it('retains the last valid balance on transport or malformed-account failure, and records a missing account as zero',async()=>{
  const x=await setup();await x.chain.pollSpanHolds('keeper');const old=x.chain.spanHolds.get(x.ref.ticket);
  x.setFail(true);await x.chain.pollSpanHolds('keeper');expect(x.chain.spanHolds.get(x.ref.ticket)).toEqual(old);x.setFail(false);
  const good=x.raw(x.ref.spanHold)!;
  for(const raw of [{...good,owner:x.h.stranger.address},{...good,data:[Buffer.alloc(164).toString('base64'),'base64']},
    {...good,data:[(()=>{const d=Buffer.from(good.data[0],'base64');d.set(getAddressEncoder().encode(x.h.stranger.address),0);return d.toString('base64');})(),'base64']},
    {...good,data:[(()=>{const d=Buffer.from(good.data[0],'base64');d.set(getAddressEncoder().encode(x.h.stranger.address),32);return d.toString('base64');})(),'base64']}]){
    x.rpc.call.mockResolvedValueOnce({context:{slot:12},value:[x.raw(x.ref.ticket),raw]});await x.chain.pollSpanHolds('keeper');expect(x.chain.spanHolds.get(x.ref.ticket)).toEqual(old);
  }
  x.rpc.call.mockResolvedValueOnce({context:{slot:13},value:[x.raw(x.ref.ticket),null]});await x.chain.pollSpanHolds('keeper');expect(x.chain.spanHolds.get(x.ref.ticket)?.amount).toBe(0n);x.engine.close();
});
it('preserves the paired reading when its ticket is missing, invalid, or cannot be decoded',async()=>{
  const x=await setup();
  try{
    await x.chain.pollSpanHolds('tape');const previous=x.chain.spanHolds.get(x.ref.ticket)!,good=x.raw(x.ref.ticket)!,data=Buffer.from(good.data[0],'base64');
    const invalidState=Buffer.from(data);invalidState[99]=255;
    expect(()=>s.getTicketDecoder().decode(invalidState)).toThrow();
    const badDiscriminator=Buffer.from(data);badDiscriminator[0]^=255;
    for(const ticket of [null,{...good,owner:x.h.stranger.address},
      {...good,data:[data.subarray(0,172).toString('base64'),'base64']},
      {...good,data:[badDiscriminator.toString('base64'),'base64']},
      {...good,data:[invalidState.toString('base64'),'base64']}]){
      x.rpc.call.mockResolvedValueOnce({context:{slot:12},value:[ticket,null]});
      await x.chain.pollSpanHolds('tape');expect(x.chain.spanHolds.get(x.ref.ticket)).toEqual(previous);
    }
  }finally{x.engine.close();}
});
it.each([51,101])('%i tickets use paired batches of at most 100 accounts; one failed batch preserves only its own previous balances',async count=>{
  const x=await setup(),template=x.chain.tickets.get(x.ref.ticket)!,base=accountData(x.h.svm,x.ref.spanHold);
  x.chain.tickets.clear();const accounts=new Map<string,{owner:Address,data:Buffer}>(),holds=new Map<Address,Address>(),keys:Address[]=[];
  for(let i=0;i<count;i++){
    const key=(await s.findTicketPda(BigInt(1000+i)))[0],hold=(await s.findSpanHoldPda(key))[0],data=Buffer.from(base);
    data.set(getAddressEncoder().encode(key),32);data.writeBigUInt64LE(BigInt(i+1),64);
    const value={...template.value,id:BigInt(1000+i)};
    x.chain.tickets.set(key,{...template,value});keys.push(key);holds.set(key,hold);
    accounts.set(key,{owner:s.SPAN_PROGRAM_ADDRESS,data:Buffer.from(s.getTicketEncoder().encode({...value,burned:BigInt(i)}))});
    accounts.set(hold,{owner:x.h.spanProgram,data});
  }
  const failedStart=count===51?0:50,failedKeys=keys.slice(failedStart,failedStart+50);
  let failBatch=false,amount=0n;
  x.rpc.call.mockImplementation(async(method,params)=>{
    expect(method).toBe('getMultipleAccounts');expect(params[0].length).toBeLessThanOrEqual(100);
    if(failBatch&&params[0][0]===keys[failedStart])throw Error('batch unavailable');
    return {context:{slot:20},value:params[0].map((key:string)=>{const raw=accounts.get(key)!,data=Buffer.from(raw.data);if(amount&&raw.owner===x.h.spanProgram)data.writeBigUInt64LE(amount,64);return{owner:raw.owner,data:[data.toString('base64'),'base64']};})};
  });
  await x.chain.pollSpanHolds('tape');expect(x.rpc.call).toHaveBeenCalledTimes(Math.ceil(count/50));expect(x.chain.spanHolds.size).toBe(count);
  const calls=[...x.rpc.call.mock.calls].sort((a,b)=>keys.indexOf(a[1][0][0])-keys.indexOf(b[1][0][0]));
  expect(calls.map(call=>call[1][0].length)).toEqual(count===51?[100,2]:[100,100,2]);
  for(let i=0;i<calls.length;i++)expect(calls[i][1][0]).toEqual(keys.slice(i*50,(i+1)*50).flatMap(key=>[key,holds.get(key)]));
  keys.forEach((key,i)=>{expect(x.chain.spanHolds.get(key)?.amount).toBe(BigInt(i+1));expect(x.chain.spanHolds.get(key)?.burned).toBe(BigInt(i));});
  const previous=new Map(x.chain.spanHolds);
  x.rpc.call.mockClear();failBatch=true;amount=999n;await x.chain.pollSpanHolds('tape');expect(x.rpc.call).toHaveBeenCalledTimes(Math.ceil(count/50));
  keys.forEach(key=>{if(failedKeys.includes(key))expect(x.chain.spanHolds.get(key)).toEqual(previous.get(key));else expect(x.chain.spanHolds.get(key)?.amount).toBe(999n);});
  failBatch=false;await x.chain.pollSpanHolds('tape');keys.forEach(key=>expect(x.chain.spanHolds.get(key)?.amount).toBe(999n));x.engine.close();
});

it('the production scheduler polls holdings with program accounts at 2s active and 5s tape intervals',async()=>{
  for(const role of ['keeper','tape'] as const){
    vi.useFakeTimers();
    const ws={subscribe:()=>()=>{},on:()=>{},start:()=>{},close:()=>{}};
    const chain=new Chain({} as any,ws as any,()=>{});
    vi.spyOn(chain,'active').mockReturnValue(true);
    const programs=vi.spyOn(chain,'pollPrograms').mockResolvedValue(undefined),
      holds=vi.spyOn(chain,'pollSpanHolds').mockResolvedValue(undefined);
    vi.spyOn(chain,'pollConfig').mockResolvedValue(undefined);
    vi.spyOn(chain,'pollClock').mockResolvedValue(undefined);
    vi.spyOn(chain,'pollFeed').mockResolvedValue(undefined);
    try{
      chain.start(role);await vi.advanceTimersByTimeAsync(50);expect(holds).toHaveBeenCalledTimes(1);
      const period=role==='keeper'?2000:5000;
      await vi.advanceTimersByTimeAsync(period-50);expect(holds).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50);expect(holds).toHaveBeenCalledTimes(2);
      expect(programs).toHaveBeenCalledTimes(2);expect(holds.mock.calls.every(args=>args[0]===role)).toBe(true);
    }finally{chain.close();vi.useRealTimers();}
  }
});

it('publishes a changed holding in tickets.json even when the ticket account itself is unchanged',async()=>{
  const x=await setup(),out=mkdtempSync(join(tmpdir(),'span-held-')),
    store=new Store(':memory:'),rpc={cluster:'devnet'} as any,
    history=new History(store,rpc,()=>{}),pub=new Publisher(store,x.chain,history,new DovesRecorder(store,rpc),out);
  try{
    x.chain.lastReadMs=Date.now();await x.chain.pollSpanHolds('tape');
    const before=x.chain.tickets.get(x.ref.ticket)!.value;
    pub.publish(x.chain.lastReadMs);
    const read=()=>JSON.parse(readFileSync(join(out,'tickets.json'),'utf8'));
    expect(read().tickets[0].spanHeld).toBe('100000');
    x.chain.spanHolds.set(x.ref.ticket,{amount:100900n,burned:0n,read:2,slot:11});
    pub.publish(x.chain.lastReadMs+250);
    const doc=read();validateDocument('tickets',doc);
    expect(doc.tickets[0].spanHeld).toBe('100900');
    expect(x.chain.tickets.get(x.ref.ticket)!.value).toBe(before);
  }finally{store.close();x.engine.close();}
});

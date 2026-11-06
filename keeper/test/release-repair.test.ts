import {expect,it,vi} from 'vitest';
import {appendFileSync} from 'node:fs';
import {address} from '@solana/kit';
import * as s from '../../program/client/index.js';
import {Chain} from '../src/keeper/chain.js';
import {Engine} from '../src/keeper/engine.js';
import {Sender,type Prepared} from '../src/keeper/sender.js';
import {RpcPool,type Endpoint} from '../src/common/rpc.js';
const P0=10000000000n,BASE=1800000000000,T0=1200n;
const report=(proof:string,result:Record<string,unknown>)=>{const row={proof,...result};console.log('RELEASE_REPAIR',JSON.stringify(row));if(process.env.SPAN_RELEASE_REPAIR_OUT)appendFileSync(process.env.SPAN_RELEASE_REPAIR_OUT,JSON.stringify(row)+'\n');};
function candle(open=true):s.Candle{return{t0:T0,readWindow:20,ageLimit:20,buyCutoff:5,readHigh:open?P0:0n,readLow:open?P0:0n,reads:Array.from({length:13},(_,j)=>({price:open&&j===0?P0:0n,publishTs:open&&j===0?T0:0n})),bump:255}as s.Candle;}
async function clockFixture(){
 let wall=BASE,first=true,failures=0,elapsed=0,next=0,slot=100,attemptAt=10000;
 vi.spyOn(Date,'now').mockImplementation(()=>wall);
 const data=Buffer.alloc(40);data.writeBigUInt64LE(BigInt(slot));data.writeBigInt64LE(T0,32);
 const rpc={call:vi.fn(async()=>{if(!first){failures++;throw Error('Clock unavailable');}first=false;return{value:{data:[data.toString('base64'),'base64']}};})};
 const chain=new Chain(rpc as any,{close:()=>{}}as any,()=>{});await chain.pollClock();
 const intervals=[50,271,271,271,272];
 const advance=async(ms:number,onTick=()=>{})=>{
  while(elapsed+intervals[next%5]<=ms){elapsed+=intervals[next++%5];wall=BASE+elapsed;chain.setSlot(++slot);while(attemptAt<=elapsed){await chain.pollClock().catch(()=>{});attemptAt+=10000;}onTick();}
  wall=BASE+ms;while(attemptAt<=ms){await chain.pollClock().catch(()=>{});attemptAt+=10000;}onTick();
 };
 return{chain,advance,actual:()=>T0+BigInt(Math.floor((wall-BASE)/1000)),failures:()=>failures,slots:()=>slot-100};
}
it('P1 anchors time to the successful Clock read across a ten-minute outage and bursty slots',async()=>{
 const x=await clockFixture();try{await x.advance(600000);const drift=Number(x.chain.now()-x.actual());report('P1',{seconds:600,clockFailures:x.failures(),slots:x.slots(),driftSeconds:drift});expect(Math.abs(drift)).toBeLessThanOrEqual(2);expect(x.chain.clockAgeMs()).toBe(600000);}finally{x.chain.close();vi.restoreAllMocks();}
});
it('P2 never abandons a reading before its wall-clock deadline while the Clock anchor is stale',async()=>{
 const x=await clockFixture(),key=(await s.findCandlePda(T0))[0],logs:any[]=[];x.chain.candles.set(key,{value:candle(),slot:1,data:''});
 const engine=new Engine(x.chain,address('11111111111111111111111111111111'),{blockhash:()=>undefined,price:()=>10000n,prepare:async()=>{throw Error('Unexpected preparation');},send:()=>{},cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},e=>logs.push({...e,actual:x.actual()}),[T0]);
 try{await x.advance(300000,()=>engine.update());const deadline=T0+342n,early=logs.filter(e=>e.event==='missed-read'&&e.actual<=deadline);report('P2',{anchorAgeSeconds:300,earlyMissed:early.length,firstActual:early[0]?String(early[0].actual):null,deadline:String(deadline),estimatedNow:String(x.chain.now())});expect(early).toEqual([]);await x.advance(342999,()=>engine.update());expect(logs.filter(e=>e.event==='missed-read')).toEqual([]);await x.advance(343000,()=>engine.update());expect(logs.find(e=>e.event==='missed-read')?.actual).toBe(T0+343n);}finally{engine.close();x.chain.close();vi.restoreAllMocks();}
});
it('P3 retains one read signature during cooldown and audits only its actual dispatch',async()=>{
 vi.useFakeTimers();vi.setSystemTime(BASE);
 const timeout=vi.spyOn(globalThis,'setTimeout'),calls:any[]=[],c=candle(false),key=(await s.findCandlePda(T0))[0];let serial=0;
 const list:Endpoint[]=[{name:'public',url:'https://public.invalid',ws:'',verified:true,hold:BASE+2000},{name:'fallback',url:'https://fallback.invalid',ws:'',verified:true,hold:BASE+2000}];
 const rpc=new RpcPool('mainnet',list,(async(_url:any,init:any)=>{const q=JSON.parse(init.body);calls.push({method:q.method,params:q.params,at:Date.now()-BASE});return new Response(JSON.stringify({result:q.method==='sendTransaction'?q.params[0]:{value:[{slot:1,err:null}]}}));})as typeof fetch,()=>{});
 const callbacks:any[]=[],sender=new Sender(rpc,{subscribe:(_m:any,_p:any,cb:any)=>{callbacks.push(cb);return()=>{};}}as any,()=>1,()=>1n,()=>T0+BigInt(Math.floor((Date.now()-BASE)/1000)),()=>{});
 const chain={candles:new Map([[key,{value:c,slot:1,data:''}]]),tickets:new Map(),config:undefined,feed:{price:P0,publishTs:T0,slot:1,source:'ws',recvMs:BASE},now:()=>T0+BigInt(Math.floor((Date.now()-BASE)/1000))}as any;
 const engine=new Engine(chain,address('11111111111111111111111111111111'),{blockhash:()=> 'B0',price:()=>10000n,prepare:async(action,price)=>({action,price,signature:`wire-${++serial}`,wire:`wire-${serial}`,blockhash:'B0',lastValidBlockHeight:100n,rent:0n}),send:p=>sender.send(p),cancel:k=>sender.cancel(k)},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{},[T0]);sender.done=(p,error,stage)=>engine.result(p,error,stage);
 try{
  engine.update();await vi.advanceTimersByTimeAsync(0);for(let ms=50;ms<2000;ms+=50){await vi.advanceTimersByTimeAsync(50);engine.update();await vi.advanceTimersByTimeAsync(0);}await vi.advanceTimersByTimeAsync(49);
  const reserved=timeout.mock.calls.filter(c=>c[1]===20000).length;report('P3-held',{elapsedMs:1999,signatures:serial,transportRequests:calls.length,reservedAudits:reserved});expect(calls).toEqual([]);expect(serial).toBe(1);expect(reserved).toBe(0);
  await vi.advanceTimersByTimeAsync(1);expect(calls.filter(c=>c.method==='sendTransaction')).toEqual([{method:'sendTransaction',params:['wire-1',{encoding:'base64',skipPreflight:false,preflightCommitment:'processed',maxRetries:0}],at:2000}]);expect(timeout.mock.calls.filter(c=>c[1]===20000)).toHaveLength(1);
  c.reads[0]={price:P0,publishTs:T0};callbacks[0]({context:{slot:1},value:{err:null}});await vi.advanceTimersByTimeAsync(20000);report('P3-resumed',{signatures:serial,sends:calls.filter(c=>c.method==='sendTransaction').length,statusChecks:calls.filter(c=>c.method==='getSignatureStatuses').length,reservedAudits:timeout.mock.calls.filter(c=>c[1]===20000).length,dispatchAt:calls[0].at});expect(calls.filter(c=>c.method==='getSignatureStatuses')).toHaveLength(1);expect(calls.filter(c=>c.method==='sendTransaction')).toHaveLength(1);expect(serial).toBe(1);
 }finally{engine.close();sender.close();rpc.close();vi.clearAllTimers();vi.restoreAllMocks();vi.useRealTimers();}
});
it('P4 excludes a fifteen-second query queue from the endpoint response timeout',async()=>{
 vi.useFakeTimers();vi.setSystemTime(BASE);const logs:any[]=[],calls:number[]=[],endpoint:Endpoint={name:'fallback',url:'https://fallback.invalid',ws:'',verified:true};
 const rpc=new RpcPool('mainnet',[endpoint],(async()=>{calls.push(Date.now()-BASE);await new Promise(r=>setTimeout(r,20));return new Response(JSON.stringify({result:1}));})as typeof fetch,e=>logs.push(e));
 try{const all=Promise.allSettled(Array.from({length:60},()=>rpc.call('getSlot')));await vi.advanceTimersByTimeAsync(15000);const result=await all,failed=result.filter(r=>r.status==='rejected').length,errors=logs.filter(e=>e.event==='rpc-error').length,held=(endpoint.hold??0)>Date.now();report('P4',{queries:60,succeeded:60-failed,failed,transportRequests:calls.length,lastDispatchMs:calls.at(-1),rpcErrors:errors,held});expect(failed).toBe(0);expect(held).toBe(false);expect(errors).toBe(0);expect(calls.at(-1)).toBe(14750);}finally{rpc.close();vi.clearAllTimers();vi.useRealTimers();}
});

for(const kind of['read','mark']as const)for(const terminal of['end','height']as const)it(`unsent ${kind} expires by ${terminal} without dispatch or audit`,async()=>{
 vi.useFakeTimers();vi.setSystemTime(BASE);const timeout=vi.spyOn(globalThis,'setTimeout'),transport=vi.fn(),endpoint:Endpoint={name:'public',url:'https://public.invalid',ws:'',verified:true,hold:BASE+2000},rpc=new RpcPool('mainnet',[endpoint],transport,()=>{});
 const sender=new Sender(rpc,{subscribe:()=>()=>{}}as any,()=>1,()=>terminal==='height'&&Date.now()>=BASE+1500?101n:1n,()=>T0+BigInt(Math.floor((Date.now()-BASE)/1000)),()=>{}),done=vi.fn();sender.done=done;
 try{sender.send({action:{kind,key:'waiting',t0:T0,...(terminal==='end'?{end:T0+1n}:{})},signature:'wire',wire:'wire',blockhash:'B0',lastValidBlockHeight:100n,price:10000n,rent:0n});await vi.advanceTimersByTimeAsync(25000);expect(sender.flights.size).toBe(0);expect(done).toHaveBeenCalledTimes(1);expect(done.mock.calls[0][1]).toBe('Expired');expect(transport).not.toHaveBeenCalled();expect(timeout.mock.calls.filter(c=>c[1]===20000)).toEqual([]);}finally{sender.close();rpc.close();vi.clearAllTimers();vi.restoreAllMocks();vi.useRealTimers();}
});
for(const kind of['mark','settle','closeUntil','closeResale','closeBid','open']as const)it(`${kind} audits actual rejected dispatch once and never audits an unsent attempt`,async()=>{
 vi.useFakeTimers();vi.setSystemTime(BASE);const timeout=vi.spyOn(globalThis,'setTimeout'),requests:string[]=[],endpoint:Endpoint={name:'public',url:'https://public.invalid',ws:'',verified:true,hold:BASE+2000};
 const rpc=new RpcPool('mainnet',[endpoint],(async(_url:any,init:any)=>{const q=JSON.parse(init.body);requests.push(q.method);return q.method==='sendTransaction'?new Response(JSON.stringify({error:{code:-32002}})):new Response(JSON.stringify({result:{value:[null]}}));})as typeof fetch,()=>{}),sender=new Sender(rpc,{subscribe:()=>()=>{}}as any,()=>1,()=>1n,()=>T0,()=>{});
 const p:Prepared={action:{kind,key:'unsent',t0:T0},signature:'wire',wire:'wire',blockhash:'B0',lastValidBlockHeight:100n,price:10000n,rent:0n};
 try{sender.send(p);await vi.advanceTimersByTimeAsync(0);expect(requests).toEqual([]);expect(timeout.mock.calls.filter(c=>c[1]===20000)).toEqual([]);sender.cancel('unsent');endpoint.hold=0;sender.send({...p,action:{...p.action,key:'actual'}});await vi.advanceTimersByTimeAsync(0);expect(requests).toEqual(['sendTransaction']);expect(sender.flights.size).toBe(0);expect(timeout.mock.calls.filter(c=>c[1]===20000)).toHaveLength(1);await vi.advanceTimersByTimeAsync(20000);expect(requests).toEqual(['sendTransaction','getSignatureStatuses']);}finally{sender.close();rpc.close();vi.clearAllTimers();vi.restoreAllMocks();vi.useRealTimers();}
});
it('an unsent read whose retry timer wakes a millisecond early still goes out once the rest has passed',async()=>{
 vi.useFakeTimers();vi.setSystemTime(BASE);
 const timeout=vi.spyOn(globalThis,'setTimeout'),sends:{at:number,skip:boolean}[]=[],endpoint:Endpoint={name:'public',url:'https://public.invalid',ws:'',verified:true,hold:BASE+2000};
 const rpc=new RpcPool('mainnet',[endpoint],(async(_url:any,init:any)=>{const q=JSON.parse(init.body);if(q.method==='sendTransaction')sends.push({at:Date.now()-BASE,skip:q.params[1].skipPreflight});return new Response(JSON.stringify({result:q.method==='sendTransaction'?q.params[0]:{value:[null]}}));})as typeof fetch,()=>{});
 const sender=new Sender(rpc,{subscribe:()=>()=>{}}as any,()=>1,()=>1n,()=>T0,()=>{});sender.done=()=>{};
 try{
  sender.send({action:{kind:'read',key:'early',t0:T0,j:1,end:T0+100n},signature:'wire',wire:'wire',blockhash:'B0',lastValidBlockHeight:100n,price:10000n,rent:0n}as Prepared);await vi.advanceTimersByTimeAsync(0);
  const i=timeout.mock.calls.findIndex(c=>c[1]===2000);expect(i).toBeGreaterThanOrEqual(0);
  clearTimeout(timeout.mock.results[i]!.value);await vi.advanceTimersByTimeAsync(1999);(timeout.mock.calls[i]![0] as ()=>void)();await vi.advanceTimersByTimeAsync(0);
  expect(sends).toEqual([]);await vi.advanceTimersByTimeAsync(1);expect(sends).toEqual([{at:2000,skip:false}]);await vi.advanceTimersByTimeAsync(1000);expect(sends.slice(1).every(x=>x.skip)).toBe(true);
 }finally{sender.close();rpc.close();vi.clearAllTimers();vi.restoreAllMocks();vi.useRealTimers();}
});

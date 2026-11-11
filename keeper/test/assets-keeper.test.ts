import {expect,it,vi} from 'vitest';
import {getAddressEncoder,getTransactionDecoder,getCompiledTransactionMessageDecoder} from '@solana/kit';
import {Harness,accountData} from '../../program/tests/harness.js';
import * as s from '../../program/client/index.js';
import {SOL_FEED,BTC_FEED,ETH_FEED} from '../../program/client/constants.js';
import {ASSETS,mintOf} from '../../program/client/assets.js';
import {Chain} from '../src/keeper/chain.js';
import {Engine} from '../src/keeper/engine.js';
import {createPrepare,keeperAssets,releaseStarts,runKeeper} from '../src/keeper/main.js';
const prices=[9490000000n,7790511000000n,226297000000n],feeds=[SOL_FEED,BTC_FEED,ETH_FEED];
it('defaults to SOL and expands only release hours into the requested assets',async()=>{
 vi.stubEnv('KEEPER_ASSETS',undefined);expect(keeperAssets()).toEqual([0]);expect(releaseStarts([1200n],keeperAssets())).toEqual([1200n]);
 expect(releaseStarts([1200n],keeperAssets('SOL,BTC,ETH'))).toEqual([1200n,1201n,1202n]);
 vi.stubEnv('KEEPER_ASSETS','SOL,DOG');await expect(runKeeper()).rejects.toThrow('Invalid KEEPER_ASSETS');vi.unstubAllEnvs();
});
it('mixed feed publications cannot abandon another asset read or supply its mark trigger',async()=>{
 const h=await Harness.create({setSpan:true}),refs=[];for(const asset of [0,1,2] as const){h.clock(1000n);const t=await h.open({t0:1200n+BigInt(asset),loaded:true});refs.push(t);h.clock(t.t0);h.price(prices[asset],t.t0);if(asset)h.clone(SOL_FEED,feeds[asset],d=>d.set(getAddressEncoder().encode(mintOf(asset)),8));await h.send('opening',h.readIx(t,0,{feed:feeds[asset]}));}
 const chain=new Chain({cluster:'mainnet'} as any,{} as any,()=>{});chain.config=h.configState();chain.bandBps=()=>400;chain.now=()=>1510n;
 for(const t of refs){chain.candles.set(t.candle,{value:h.candleState(t),slot:1,data:''});chain.tickets.set(t.ticket,{value:h.ticketState(t),slot:1,data:''});}
 chain.feeds.set(0,{price:prices[0],publishTs:1501n,slot:1,source:'poll',recvMs:0});chain.feeds.set(1,{price:prices[1]*101n/100n,publishTs:1522n,slot:2,source:'poll',recvMs:0});
 const sent:any[]=[];const engine=new Engine(chain,h.marker.address,{blockhash:()=> 'hash',price:()=>1n,prepare:async(action,price)=>({action,price,signature:action.key,wire:'',blockhash:'hash',lastValidBlockHeight:10n,rent:0n}),send:(p,v)=>sent.push({p,v}),cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 try{engine.update();for(let i=0;i<40;i++)await Promise.resolve();expect(engine.abandoned.has(`read:${refs[0].candle}:1`)).toBe(false);expect(engine.abandoned.has(`read:${refs[1].candle}:1`)).toBe(true);expect(engine.abandoned.has(`read:${refs[2].candle}:1`)).toBe(false);
  expect(sent.filter(x=>x.p.action.kind==='read').map(x=>[x.p.action.t0,x.v.price])).toEqual([[1200n,prices[0]]]);
  expect(sent.filter(x=>x.p.action.kind==='mark').every(x=>x.p.action.t0===1201n&&x.v.price===prices[1]*101n/100n)).toBe(true);
 }finally{engine.close();}
});
it('the actual engine and transaction builder open three candles and drive 39 reads, marks and settlements with each own feed',async()=>{
 const h=await Harness.create({setSpan:true}),base=1000200n,times=releaseStarts([base],[0,1,2]);
 for(const asset of [1,2] as const)h.clone(SOL_FEED,feeds[asset],d=>d.set(getAddressEncoder().encode(mintOf(asset)),8));
 h.svm.withBlockhashCheck(false);h.clock(base-86398n);
 const raw=(key:any)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,executable:a.executable,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
 const rpc={cluster:'mainnet',call:async(method:string,params:any[])=>{if(method==='getAccountInfo')return{value:raw(params[0])};if(method==='getMultipleAccounts')return{value:params[0].map(raw)};if(method==='getMinimumBalanceForRentExemption')return 1905000;throw Error(method);}};
 const chain=new Chain(rpc as any,{} as any,()=>{},h.marker.address);chain.configKey=h.config;chain.config=h.configState();chain.bandBps=()=>400;chain.now=()=>h.svm.getClock().unixTimestamp;
 const candles=await Promise.all(times.map(async t0=>({t0,candle:(await s.findCandlePda(t0))[0]}))),tickets:any[]=[],receipts:any[]=[],errors:string[]=[],sent:any[]=[];let slot=1,engine:Engine;
 const sync=()=>{for(const ref of candles)if(h.svm.getAccount(ref.candle).exists)chain.candles.set(ref.candle,{value:h.candleState(ref),slot:slot++,data:''});for(const ref of tickets){if(h.svm.getAccount(ref.ticket).exists)chain.tickets.set(ref.ticket,{value:h.ticketState(ref),slot:slot++,data:''});else chain.tickets.delete(ref.ticket);}};
 const preparedIxs=new Map<string,any>();const prepare=await createPrepare(rpc as any,h.marker,chain,{register:(key,ixs)=>preparedIxs.set(key,ixs)},()=>({blockhash:h.svm.latestBlockhash(),lastValidBlockHeight:1000000000000n}));
 engine=new Engine(chain,h.marker.address,{blockhash:()=>h.svm.latestBlockhash(),price:()=>10000n,prepare:async(a,p)=>{try{return await prepare(a,p);}catch(e){errors.push(String(e));throw e;}},send:(p,v)=>{
  const tx=getTransactionDecoder().decode(Buffer.from(p.wire,'base64')),keys=getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
  expect(keys[0]).toBe(h.marker.address);
  const result=h.svm.sendTransaction(tx);
  if('err' in result){errors.push(result.meta().logs().join('\n'));return;}
  const events=s.decodeEvents(result.innerInstructions().flat().map(ix=>({programAddress:keys[ix.instruction().programIdIndex()],data:ix.instruction().data()})));
  receipts.push(...events.filter(e=>e.name==='Settled').map(e=>e.data));sent.push({kind:p.action.kind,t0:p.action.t0,feed:preparedIxs.get(p.action.key)?.[0]?.accounts?.find((a:any)=>feeds.includes(a.address))?.address,trigger:v});sync();engine.result(p,null,'signature');
 },cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{},times);
 const wait=async(fn:()=>boolean)=>{const until=Date.now()+3000;while(!fn()){if(errors.length)throw Error(errors[0]);if(Date.now()>until)throw Error('Engine action timeout');await new Promise(r=>setTimeout(r,5));}};
 try{
  engine.update();await wait(()=>chain.candles.size===3);expect(sent.filter(x=>x.kind==='open').map(x=>x.t0).sort()).toEqual([...times].sort());
  for(const t0 of times)tickets.push(await h.open({t0,loaded:true}));sync();
  const totals=h.totals(),supplies=h.supplies();
  for(let j=0;j<13;j++){
   for(const asset of [0,1,2] as const){const ts=times[asset]+BigInt(j)*300n;h.clock(ts);h.price(prices[asset],ts,feeds[asset]);await chain.ingestFeed(raw(feeds[asset]),slot++,'poll',asset);engine.update();await wait(()=>h.candleState(candles[asset]).reads[j].price===prices[asset]);}
   if(j===0)for(const asset of [0,1,2] as const){const ts=times[asset]+30n;h.clock(ts);h.price(prices[asset]*101n/100n,ts,feeds[asset]);await chain.ingestFeed(raw(feeds[asset]),slot++,'poll',asset);engine.update();await wait(()=>h.ticketState(tickets[asset]).marks===1);}
  }
  h.clock(times[2]+3641n);engine.update();await wait(()=>receipts.length===3);
  for(const asset of [0,1,2] as const){const e=receipts.find(e=>e.t0===times[asset]);expect(e).toMatchObject({p0:prices[asset],payout:10000000n,burned:100n,spanReturned:99900n,reads:8191});
   for(const action of sent.filter(x=>x.t0===times[asset]&&['read','mark'].includes(x.kind)))expect(action.feed).toBe(feeds[asset]);}
  expect(sent.filter(x=>x.kind==='read')).toHaveLength(39);expect(sent.filter(x=>x.kind==='mark')).toHaveLength(3);
  expect(h.totals()[h.spanMint]-totals[h.spanMint]).toBe(-300n);expect(h.supplies()[h.spanMint]-supplies[h.spanMint]).toBe(-300n);
 }finally{engine.close();}
},30000);

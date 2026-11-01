import { expect, it, vi } from 'vitest';
import { getBase58Decoder, type Address } from '@solana/kit';
import { Harness } from '../../program/tests/harness.js';
import * as s from '../../program/client/index.js';
import { Chain } from '../src/keeper/chain.js';
import { Engine } from '../src/keeper/engine.js';
import type { Prepared } from '../src/keeper/sender.js';
import { Store } from '../src/common/sqlite.js';
import { History } from '../src/tape/history.js';
const flush=async()=>{for(let i=0;i<30;i++)await new Promise<void>(r=>queueMicrotask(r));};
it('production polling discovers a changed marker and a first load during the hour without a permanent stop',async()=>{
 const h=await Harness.create({setSpan:true}),a=await h.open({loaded:true}),b=await h.open({sold:true});
 h.clock(a.t0);h.price(10000000000n,a.t0);await h.send('opening',h.readIx(a,0));h.clock(a.t0+1830n);
 const raw=(key:Address)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
 const rpc={cluster:'devnet',call:vi.fn(async(method:string,params:any[])=>{
  if(method==='getMultipleAccounts')return{context:{slot:10},value:params[0].map(raw)};
  expect(method).toBe('getProgramAccounts');const candle=params[1].filters[0].memcmp.bytes===getBase58Decoder().decode(s.CANDLE_DISCRIMINATOR);
  return{context:{slot:10},value:(candle?[a.candle]:[a.ticket,b.ticket]).map(pubkey=>({pubkey,account:raw(pubkey)}))};
 })};
 const chain=new Chain(rpc as any,{} as any,()=>{},h.stranger.address);chain.config=h.configState();chain.now=()=>h.svm.getClock().unixTimestamp;
 await chain.pollPrograms();await chain.pollSpanHolds('keeper');
 const sent:Prepared[]=[];const engine=new Engine(chain,h.stranger.address,{blockhash:()=> 'hash',price:()=>1n,
  prepare:async(action,price)=>({action,price,signature:action.key,wire:'',blockhash:'hash',lastValidBlockHeight:100n,rent:0n}),send:p=>sent.push(p),cancel:()=>{}},
  {available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 try{
  chain.feed={publishTs:a.t0+1830n,price:10100000000n,source:'poll',slot:10,recvMs:Date.now()};engine.update();await flush();
  expect(sent.filter(x=>x.action.kind==='mark')).toHaveLength(0);
  await h.send('change',h.ix('setMarker',{...a,buyer:h.buyer,marker:h.stranger.address}),h.buyer);
  await h.send('load',h.loadIx(b,{marker:h.stranger.address}),h.buyer);
  await chain.pollPrograms();await chain.pollSpanHolds('keeper');
  engine.update();await flush();expect(sent.filter(x=>x.action.kind==='mark').map(x=>x.action.ticket).sort()).toEqual([a.ticket,b.ticket].sort());
  const pending=sent.find(x=>x.action.ticket===a.ticket)!;engine.result(pending,'NotMarker','preflight');
  expect(engine.endedMarks.has(a.ticket)).toBe(false);
  await h.send('change_away',h.ix('setMarker',{...a,buyer:h.buyer,marker:h.marker.address}),h.buyer);
  await chain.pollPrograms();await chain.pollSpanHolds('keeper');engine.update();await flush();
  expect(chain.tickets.get(a.ticket)!.value.marker).toBe(h.marker.address);expect(chain.spanHolds.has(a.ticket)).toBe(false);
  expect(sent.filter(x=>x.action.kind==='mark')).toHaveLength(2);
 }finally{engine.close();}
});
it('history poll decodes MarkerSet and advances its cursor through later Marked and Settled transactions',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({loaded:true});
 const prefix=Buffer.from([228,69,165,46,81,203,154,29]),encoded=[
  s.getMarkerSetEventEncoder().encode({ticket:t.ticket,id:t.id,buyer:h.buyer.address,oldMarker:h.marker.address,newMarker:h.stranger.address}),
  s.getMarkedEventEncoder().encode({ticket:t.ticket,id:t.id,t0:t.t0,side:s.Side.High,price:10100000000n,publishTs:t.t0+1n,slot:2n,tailHigh:10100000000n,tailLow:0n,marks:1,burned:100n,burn:100n,spanLeft:99900n}),
  s.getSettledEventEncoder().encode({ticket:t.ticket,id:t.id,t0:t.t0,outcome:s.Outcome.Paid,seller:h.seller.address,buyer:h.buyer.address,premium:20000000n,strikeBps:0,p0:10000000000n,readHigh:10000000000n,readLow:10000000000n,tailHigh:10100000000n,tailLow:0n,high:10100000000n,low:10000000000n,payout:10000000n,toBuyer:10000000n,toSeller:30000000n,spanReturned:99900n,burned:100n,marks:1,reads:1}),
 ];
 const txs=encoded.map((data,i)=>({slot:i+1,blockTime:1200+i,transaction:{message:{accountKeys:[s.SPAN_PROGRAM_ADDRESS],instructions:[]}},meta:{err:null,innerInstructions:[{index:0,instructions:[{programIdIndex:0,data:getBase58Decoder().decode(Buffer.concat([prefix,Buffer.from(data)]))}]}]}}));
 const store=new Store(':memory:'),rpc={cluster:'devnet',call:vi.fn(async(method:string,params:any[])=>method==='getSignaturesForAddress'?[2,1,0].map(i=>({signature:String(i),slot:i+1})):txs[Number(params[0])])};
 try{const history=new History(store,rpc as any,()=>{});await history.poll();
  expect(store.get('program-cursor')).toBe('2');expect(store.get('program-slot')).toBe('3');
  expect(history.events('MarkerSet')[0]).toMatchObject({ticket:t.ticket,buyer:h.buyer.address,oldMarker:h.marker.address,newMarker:h.stranger.address});
  expect(history.events('Marked')).toHaveLength(1);expect(history.events('Settled')).toHaveLength(1);
 }finally{store.close();}
});

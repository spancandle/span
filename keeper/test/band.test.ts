import {expect,it,vi} from 'vitest';
import * as s from '../../program/client/index.js';
import {Chain} from '../src/keeper/chain.js';
import {Engine} from '../src/keeper/engine.js';
import {createPrepare} from '../src/keeper/main.js';
import {CLOSE_BAND_UNITS} from '../src/keeper/sender.js';
import {liveDocuments} from '../src/tape/state.js';
import {resaleRuntime,capture} from './resale-support.js';
import {getTransactionDecoder,getCompiledTransactionMessageDecoder} from '@solana/kit';

it('a shared successful account snapshot establishes absence, a later failure keeps it and unseen websocket tickets stay unknown',async()=>{
 const x=await resaleRuntime(),{h,t,chain}=x;
 chain.bandBps=Chain.prototype.bandBps.bind(chain);
 await h.send('set span',h.ix('setSpan',{admin:h.admin,burnPerMark:100n}),h.admin);chain.config=h.configState();
 await h.send('open',[h.openCandleIx(t),h.openIx(t,1000000n,{bandBps:100})],h.seller);
 await h.send('buy/load',[h.buyIx(t),h.loadIx(t)],h.buyer);
 h.clock(t.t0);h.price(10000000000n,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);
 x.sync();expect(chain.bandBps(t.ticket)).toBeUndefined();
 const sent:any[]=[],engine=new Engine(chain,h.marker.address,{blockhash:()=> 'hash',price:()=>1n,
  prepare:async(action,price)=>({action,price,signature:action.key,wire:'',blockhash:'hash',lastValidBlockHeight:100n,rent:0n}),send:p=>sent.push(p),cancel:()=>{}},
  {available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 chain.feed={price:10100000000n,publishTs:t.t0+60n,slot:1,source:'poll',recvMs:0};
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 try{
  engine.update();await flush();expect(sent.filter(p=>p.action.kind==='mark')).toHaveLength(0);
  await chain.pollPrograms();expect(chain.bandBps(t.ticket)).toBe(100);expect(chain.bands.size).toBe(1);
  const read=x.rpc.call.getMockImplementation()!;
  x.rpc.call.mockImplementation(async(method,params)=>{if(method==='getProgramAccounts'&&!params[1].filters.length)throw Error('Unavailable');return read(method,params);});
  await expect(chain.pollPrograms()).rejects.toThrow('Unavailable');expect(chain.bandBps(t.ticket)).toBe(100);
  chain.feed={price:10100000000n,publishTs:t.t0+60n,slot:1,source:'poll',recvMs:0};engine.update();await flush();expect(sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);
  x.rpc.call.mockImplementation(read);await chain.pollPrograms();chain.feed={price:10100000000n,publishTs:t.t0+60n,slot:1,source:"poll",recvMs:0};engine.update();await flush();expect(sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);
  h.clock(t.t0+60n);const other=await h.open({t0:2400n,bandBps:400});chain.ingest('ticket',other.ticket,x.raw(other.ticket),Number(h.svm.getClock().slot));
  expect(chain.bandBps(other.ticket)).toBeUndefined();await chain.pollPrograms();expect(chain.bandBps(other.ticket)).toBe(400);
 }finally{engine.close();chain.close();}
});

it('a failed snapshot keeps a width already established, so v2/v3 documents and marks continue',async()=>{
 const x=await resaleRuntime(),{h,t,chain}=x;
 chain.bandBps=Chain.prototype.bandBps.bind(chain);
 await h.send('set span',h.ix('setSpan',{admin:h.admin,burnPerMark:100n}),h.admin);chain.config=h.configState();
 await h.send('open',[h.openCandleIx(t),h.openIx(t,1000000n,{bandBps:400})],h.seller);
 await h.send('buy/load',[h.buyIx(t),h.loadIx(t)],h.buyer);
 h.clock(t.t0);h.price(10000000000n,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);
 x.sync();await chain.pollPrograms();expect(chain.bandBps(t.ticket)).toBe(400);
 const history={events:()=>[]} as any,listed=(v:2|3)=>liveDocuments(chain,history,()=>null,v).tickets.tickets.map(r=>r.address);
 expect(listed(2)).toEqual([t.ticket]);
 const read=x.rpc.call.getMockImplementation()!;
 x.rpc.call.mockImplementation(async(method,params)=>{if(method==='getProgramAccounts'&&!params[1].filters.length)throw Error('Unavailable');return read(method,params);});
 await expect(chain.pollPrograms()).rejects.toThrow('Unavailable');
 expect(listed(2)).toEqual([t.ticket]);expect(listed(3)).toEqual([t.ticket]);expect(chain.bandBps(t.ticket)).toBe(400);
 const sent:any[]=[],engine=new Engine(chain,h.marker.address,{blockhash:()=> 'hash',price:()=>1n,
  prepare:async(action,price)=>({action,price,signature:action.key,wire:'',blockhash:'hash',lastValidBlockHeight:100n,rent:0n}),send:p=>sent.push(p),cancel:()=>{}},
  {available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 chain.feed={price:10100000000n,publishTs:t.t0+60n,slot:1,source:'poll',recvMs:0};
 try{engine.update();for(let i=0;i<30;i++)await Promise.resolve();expect(sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);}
 finally{engine.close();chain.close();}
});

it('full cleanup confirms the bound ticket is empty and returns Band rent to its stored seller without a candle or feed',async()=>{
 const x=await resaleRuntime(),{h,t,chain}=x;chain.bandBps=Chain.prototype.bandBps.bind(chain);
 await h.send('open',[h.openCandleIx(t),h.openIx(t,1000000n,{bandBps:200})],h.seller);await chain.pollPrograms();
 const prepare=await createPrepare(x.rpc as any,h.marker,chain,{register:()=>{}},()=>({blockhash:h.svm.latestBlockhash(),lastValidBlockHeight:100000000000n}));
 chain.tickets.clear();const a={kind:'closeBand' as const,key:`closeBand:${t.band}`,band:t.band,t0:0n};
 await expect(prepare(a,10000n)).rejects.toThrow('Ticket still present');
 await h.send('withdraw',h.withdrawIx(t));await chain.pollPrograms();chain.candles.clear();chain.config=undefined;
 Object.defineProperty(chain,'feed',{get:()=>{throw Error('Oracle accessed');}});
 const sent:any[]=[],engine=new Engine(chain,h.marker.address,{blockhash:()=>h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>sent.push(p),cancel:()=>{}},
 {available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 try{engine.update();const end=performance.now()+5000;while(!sent.length){if(performance.now()>end)throw Error('Cleanup timeout');await new Promise(r=>setTimeout(r,5));}
  expect(sent[0].action).toEqual(a);expect(sent[0].action.ticket).toBeUndefined();
  const m:any=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(sent[0].wire,'base64')).messageBytes);
  expect(Buffer.from(m.instructions[0].data).readUInt32LE(1)).toBe(CLOSE_BAND_UNITS);
  const before=h.svm.getAccount(h.seller.address) as any,rent=h.svm.getAccount(t.band) as any,row=capture(h,sent[0].wire);
  expect(row.tx.meta.err,row.tx.meta.logMessages.join('\n')).toBe(null);expect(h.svm.getAccount(t.band).exists).toBe(false);
  expect((h.svm.getAccount(h.seller.address) as any).lamports-before.lamports).toBe(rent.lamports);
 }finally{engine.close();chain.close();}
});

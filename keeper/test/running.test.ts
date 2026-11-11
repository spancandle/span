import {beforeBid} from './bid-compat.js';
import {expect,it,vi} from 'vitest';
import {existsSync,mkdtempSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getAddressDecoder,type Address} from '@solana/kit';
import * as s from '../../program/client/index.js';
import {TOKEN,TOKEN_2022} from '../../program/client/constants.js';
import {Harness,accountData} from '../../program/tests/harness.js';
import {Chain} from '../src/keeper/chain.js';
import {Engine} from '../src/keeper/engine.js';
import {createPrepare} from '../src/keeper/main.js';
import {Store} from '../src/common/sqlite.js';
import {History} from '../src/tape/history.js';
import {liveDocuments} from '../src/tape/state.js';
import {Publisher} from '../src/tape/publish.js';
import {DovesRecorder} from '../src/tape/doves.js';
import {validateDocument} from './schemas.js';
const P0=10000000000n;
async function fixture(o:{deferSpan?:boolean}={}) {
 const h=await Harness.create({setSpan:!o.deferSpan}),t=await h.ref(),until=(await s.findUntilPda(t.ticket))[0];
 await h.send('candle',h.openCandleIx(t));
 const open=h.ix('openRunning',{...t,until,untilArg:t.t0+3600n,premium:1000000n,strikeBps:0,sellerSource:h.sellerUsdc});
 const raw=(key:Address)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
 const subs:any[]=[],rpc={cluster:'mainnet',call:vi.fn(async(method:string,params:any[])=>{
  if(method==='getAccountInfo')return{context:{slot:100},value:raw(params[0])};
  if(method==='getProgramAccounts')return{context:{slot:100},value:h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS).filter(a=>(!params[1].filters?.length||getBase58Decoder().decode(a.data.subarray(0,8))===params[1].filters[0].memcmp.bytes)).map(a=>({pubkey:a.address,account:raw(a.address)}))};
  if(method==='getMultipleAccounts')return{context:{slot:100},value:params[0].map(raw)};
  throw Error(method);
 })},ws={subscribe:(kind:string,args:any[],cb:any)=>{subs.push({kind,args,cb});return()=>{};},on:()=>{},start:()=>{},close:()=>{}};
 const chain=new Chain(rpc as any,ws as any,()=>{},h.marker.address);chain.config=h.configState();chain.configKey=h.config;chain.now=()=>h.svm.getClock().unixTimestamp;
 return{h,t,until,open,raw,rpc,ws,subs,chain};
}
/** Actual VM metadata is represented in the same JSON shape the tape receives over RPC. */
function apply(h:Harness,wire:string){
 const tx=getTransactionDecoder().decode(Buffer.from(wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as any,keys:Address[]=message.staticAccounts;
 const before=keys.map(k=>h.svm.getAccount(k)),result=h.svm.sendTransaction(tx);
 if('err' in result)throw Error(result.meta().logs().join('\n'));
 const tokenBalances=(accounts:any[])=>accounts.flatMap((a,i)=>a.exists&&[TOKEN,TOKEN_2022].includes(a.programAddress)&&a.data.length>=165?[
  {accountIndex:i,mint:getAddressDecoder().decode(a.data.subarray(0,32)),owner:getAddressDecoder().decode(a.data.subarray(32,64)),uiTokenAmount:{amount:Buffer.from(a.data).readBigUInt64LE(64).toString(),decimals:6}}
 ]:[]);
 return{slot:Number(h.svm.getClock().slot),blockTime:Number(h.svm.getClock().unixTimestamp),transaction:{message:{accountKeys:keys,instructions:message.instructions.map((ix:any)=>({programIdIndex:ix.programAddressIndex,accounts:Array.from(ix.accountIndices??[]),data:getBase58Decoder().decode(ix.data??new Uint8Array())}))}},meta:{err:null,fee:5000,preTokenBalances:tokenBalances(before),postTokenBalances:tokenBalances(keys.map(k=>h.svm.getAccount(k))),innerInstructions:result.innerInstructions().map((ixs,index)=>({index,instructions:ixs.map(x=>({programIdIndex:x.instruction().programIdIndex(),accounts:Array.from(x.instruction().accounts()),data:getBase58Decoder().decode(x.instruction().data())}))}))}};
}
async function driver(h:Harness,ixs:any[],payer=h.stranger){const tx=await h.transaction(ixs,payer);return apply(h,Buffer.from((await import('@solana/kit')).getTransactionEncoder().encode(tx)).toString('base64'));}
it('reads Until through polling and program subscriptions, ignores older slots, and deletes closed accounts',async()=>{
 const x=await fixture();await x.h.send('open',x.open,x.h.seller);await x.chain.pollPrograms();expect(x.chain.untils.get(x.until)!.value).toMatchObject({ticket:x.t.ticket,seller:x.h.seller.address,until:x.t.t0+3600n});
 x.chain.start('tape');try{const callback=x.subs.find(q=>q.kind==='programSubscribe'&&q.args[1].filters[0].memcmp.bytes===getBase58Decoder().decode(s.UNTIL_DISCRIMINATOR)).cb;
  callback({context:{slot:99},value:{pubkey:x.until,account:null}});expect(x.chain.untils.has(x.until)).toBe(true);
  callback({context:{slot:101},value:{pubkey:x.until,account:null}});expect(x.chain.untils.has(x.until)).toBe(false);
  callback({context:{slot:102},value:{pubkey:x.until,account:x.raw(x.until)}});expect(x.chain.untils.has(x.until)).toBe(true);
  await x.h.send('close',x.h.ix('closeUntil',{until:x.until,ticket:x.t.ticket,seller:x.h.seller.address,closer:x.h.seller}));
  callback({context:{slot:103},value:{pubkey:x.until,account:null}});await x.chain.pollPrograms();expect(x.chain.untils.has(x.until)).toBe(false);
 }finally{x.chain.close();}
});
it('plans closeUntil without a ticket key and reaches createPrepare with no candle, config or feed',async()=>{
 const x=await fixture();await x.h.send('open',x.open,x.h.seller);await x.chain.pollPrograms();await x.h.send('withdraw',x.h.withdrawIx(x.t));x.chain.tickets.clear();x.chain.candles.clear();x.chain.config=undefined;
 Object.defineProperty(x.chain,'feed',{get:()=>{throw Error('Unexpected oracle lookup');}});
 const prepare=await createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:1000000000000n})),sent:any[]=[],engine=new Engine(x.chain,x.h.marker.address,{blockhash:()=>x.h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>sent.push(p),cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 try{engine.update();for(let n=0;n<100&&!sent.length;n++)await new Promise(r=>setTimeout(r,5));expect(sent).toHaveLength(1);const p=sent[0];expect(p.action).toEqual({kind:'closeUntil',key:`closeUntil:${x.until}`,until:x.until,t0:0n});expect(p.action.ticket).toBeUndefined();
  const m=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(p.wire,'base64')).messageBytes) as any;expect(Buffer.from(m.instructions[0].data).readUInt32LE(1)).toBe(20000);expect(x.rpc.call.mock.calls.some(c=>c[0]==='getAccountInfo'&&c[1][0]===x.t.ticket&&c[1][1].commitment==='confirmed')).toBe(true);
  apply(x.h,p.wire);expect(x.h.svm.getAccount(x.until).exists).toBe(false);x.chain.untils.clear();engine.update();expect(engine.pending.size).toBe(0);
 }finally{engine.close();x.chain.close();}
});
it('does not prepare a cleanup while a confirmed ticket still exists, even when the local ticket is absent',async()=>{
 const x=await fixture();await x.h.send('open',x.open,x.h.seller);await x.chain.pollPrograms();x.chain.tickets.clear();const prepare=await createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:1000n}));
 await expect(prepare({kind:'closeUntil',key:`closeUntil:${x.until}`,until:x.until,t0:0n},10000n)).rejects.toThrow('Ticket still present');x.chain.close();
});
for(const markAfterEntry of [false,true])it(`production decisions and tape handle a running purchase with ${markAfterEntry?'one mark':'no marks'} through settlement and cleanup`,async()=>{
 const x=await fixture({deferSpan:true}),dir=mkdtempSync(join(tmpdir(),'span-running-')),store=new Store(join(dir,'tape.sqlite')),history=new History(store,{cluster:'mainnet'} as any,()=>{}),recorder=new DovesRecorder(store,{cluster:'mainnet'} as any),pub=new Publisher(store,x.chain,history,recorder,join(dir,'public'));
 x.chain.bandBps=()=>400;
 let sig=0,slot=200,engine:Engine;const sent:any[]=[],errors:any[]=[];x.h.svm.withBlockhashCheck(false);
 const sync=()=>{for(const [kind,key]of [['candle',x.t.candle],['ticket',x.t.ticket],['until',x.until]] as const)x.chain.ingest(kind,key,x.raw(key),slot++);};
 const ingest=(tx:any)=>{history.ingest(`vm-${++sig}`,tx);sync();};
 ingest(await driver(x.h,[x.h.ix('setSpan',{admin:x.h.admin,burnPerMark:100n})],x.h.admin));x.chain.config=x.h.configState();
 ingest(await driver(x.h,[x.open],x.h.seller));
 const prepare=await createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:1000000000000n}));
 engine=new Engine(x.chain,x.h.marker.address,{blockhash:()=>x.h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{try{const tx=apply(x.h,p.wire);sent.push(p);ingest(tx);engine.result(p,null,'signature');}catch(e){errors.push(e);}},cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 x.chain.onChange=()=>engine.update();x.chain.onFeed=()=>engine.update();
 const wait=async(fn:()=>boolean)=>{const end=Date.now()+4000;while(!fn()){if(errors.length)throw errors[0];if(Date.now()>end)throw Error('Keeper did not finish action');await new Promise(r=>setTimeout(r,5));}};
 try{
  x.h.clock(x.t.t0);x.h.price(P0,x.t.t0);await x.chain.ingestFeed(x.raw(x.h.feed),slot++,'poll');await wait(()=>x.h.candleState(x.t).reads[0].price===P0);expect(sent.at(-1).action.kind).toBe('read');
  x.h.clock(x.t.t0+30n);x.h.price(P0*101n/100n,x.t.t0+30n);ingest(await driver(x.h,[x.h.ix('buyRunning',{...x.t,until:x.until,buyerSource:x.h.buyerUsdc,maxPay:11000000n}),x.h.loadIx(x.t)],x.h.buyer));
  const docs=liveDocuments(x.chain,history);validateDocument('state',docs.state);validateDocument('tickets',docs.tickets);const ticket=docs.tickets.tickets[0];expect(ticket.until).toBe(String(x.t.t0+3600n));expect(ticket.entry).toMatchObject({recorded:'10000000',paid:'11000000',price:'10100000000'});
  if(markAfterEntry){x.h.clock(x.t.t0+40n);x.h.price(P0*102n/100n,x.t.t0+40n);await x.chain.ingestFeed(x.raw(x.h.feed),slot++,'ws');await wait(()=>x.h.ticketState(x.t).marks===1);}
  for(let j=1;j<13;j++){const ts=x.t.t0+BigInt(j)*300n;x.h.clock(ts);x.h.price(P0,ts);await x.chain.ingestFeed(x.raw(x.h.feed),slot++,'poll');await wait(()=>x.h.candleState(x.t).reads[j].price===P0);}
  x.h.clock(s.settleAfter(x.h.candleState(x.t)));engine.update();await wait(()=>!x.h.svm.getAccount(x.until).exists);expect(sent.filter(p=>p.action.kind==='read')).toHaveLength(13);expect(sent.filter(p=>p.action.kind==='closeUntil')).toHaveLength(1);
  const document=pub.historyDocument();validateDocument('history',document);expect(document.receipts[0].entry).toEqual(ticket.entry);expect(document.receipts[0].marks).toBe(markAfterEntry?1:0);expect(document.receipts[0].payout).toBe(markAfterEntry?'20000000':'10000000');expect(history.events('UntilSet')).toHaveLength(1);expect(history.events('UntilClosed')).toHaveLength(1);
  if(existsSync(resolve(import.meta.dirname,'recalculate.py'))){const recalculated=spawnSync('python3',['test/recalculate.py',join(dir,'tape.sqlite')],{cwd:resolve(import.meta.dirname,'..'),encoding:'utf8'});expect(recalculated.status,recalculated.stderr+recalculated.stdout).toBe(0);expect(JSON.parse(recalculated.stdout).receipts[0].marks).toBe(markAfterEntry?1:0);}
 }finally{engine.close();x.chain.close();store.close();}
},30000);
it.skipIf(!process.env.SPAN_PREVIOUS_KEEPER)('keeps every old public value on a 1.12.0 state, adding only null until and entry',async()=>{
 const h=await Harness.create({binary:process.env.SPAN_PREVIOUS_BINARY,setSpan:true}),t=await h.open({loaded:true}),chain={rpc:{cluster:'mainnet'},config:h.configState(),candles:new Map([[t.candle,{value:h.candleState(t),slot:1,data:''}]]),tickets:new Map([[t.ticket,{value:h.ticketState(t),slot:1,data:''}]]),untils:new Map(),now:()=>1300n,slot:1} as unknown as Chain;
 const history={events:()=>[]} as any,old=await import(pathToFileURL(resolve(process.env.SPAN_PREVIOUS_KEEPER!,'src/tape/state.ts')).href);vi.spyOn(Date,'now').mockReturnValue(1800000000000);
 try{const before=old.liveDocuments(chain,history),after=beforeBid(liveDocuments(chain,history));for(const row of after.tickets.tickets){expect(row.until).toBe(null);expect(row.entry).toBe(null);delete(row as any).until;delete(row as any).entry;expect(row.resale).toBe(null);expect(row.transfers).toEqual([]);delete(row as any).resale;delete(row as any).transfers;}expect(after).toEqual(before);
  const dir=mkdtempSync(join(tmpdir(),'span-legacy-publish-')),store=new Store(':memory:'),archive=new History(store,{cluster:'mainnet'} as any,()=>{}),recorder=new DovesRecorder(store,{cluster:'mainnet'} as any),oldModule=await import(pathToFileURL(resolve(process.env.SPAN_PREVIOUS_KEEPER!,'src/tape/publish.ts')).href);
  try{
   h.clock(t.t0);h.price(P0,t.t0);archive.ingest('old-read',await driver(h,[h.readIx(t,0)]));h.clock(t.t0+30n);h.price(P0*101n/100n,t.t0+30n);archive.ingest('old-mark',await driver(h,[h.markIx(t)],h.marker));chain.candles.set(t.candle,{value:h.candleState(t),slot:1,data:''});chain.tickets.set(t.ticket,{value:h.ticketState(t),slot:1,data:''});
   h.clock(s.settleAfter(h.candleState(t)));archive.ingest('old-settled',await driver(h,[h.settleIx(t)]));chain.now=()=>h.svm.getClock().unixTimestamp;
   recorder.startRecording(Number(t.t0)-120);recorder.sample('old-price',P0,t.t0,1);recorder.sample('old-high',P0*101n/100n,t.t0+30n,2);recorder.closeGaps();recorder.cover(Number(t.t0)+3720);
   const baseline=new oldModule.Publisher(store,chain,archive,recorder,join(dir,'before')),current=new Publisher(store,chain,archive,recorder,join(dir,'after'));
   expect(current.feedDocument()).toEqual(baseline.feedDocument());expect(current.hoursDocument()).toEqual(baseline.hoursDocument());expect(current.candlePathBody(Number(t.t0))).toEqual(baseline.candlePathBody(Number(t.t0)));
   const beforeBook=baseline.historyDocument(),afterBook=current.historyDocument();for(const receipt of afterBook.receipts){expect(receipt.entry).toBe(null);delete receipt.entry;expect(receipt.transfers).toEqual([]);delete receipt.transfers;}expect(afterBook).toEqual(beforeBook);
  }finally{store.close();}
 }finally{vi.restoreAllMocks();}
});

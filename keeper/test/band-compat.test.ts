import {it,expect,vi} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {getBase58Decoder} from '@solana/kit';
import * as s from '../../program/client/index.js';
import {Chain} from '../src/keeper/chain.js';
import {Engine} from '../src/keeper/engine.js';
import {createPrepare} from '../src/keeper/main.js';
import {capture} from './resale-support.js';
import {Store} from '../src/common/sqlite.js';
import {History} from '../src/tape/history.js';
import {DovesRecorder} from '../src/tape/doves.js';
import {Publisher} from '../src/tape/publish.js';
import {liveDocuments} from '../src/tape/state.js';

it.skipIf(!process.env.SPAN_BAND_BASELINE_KEEPER||!process.env.SPAN_BAND_BASELINE_HARNESS||!process.env.SPAN_BAND_BASELINE_BINARY)(
 'the new keeper marks and settles on the current bytes and retains every v1/v2 public value',async()=>{
 const old=process.env.SPAN_BAND_BASELINE_KEEPER!,legacy=await import(pathToFileURL(process.env.SPAN_BAND_BASELINE_HARNESS!).href),h=await legacy.Harness.create({binary:process.env.SPAN_BAND_BASELINE_BINARY,setSpan:true}),t=await h.open({loaded:true,strikeBps:100});h.svm.withBlockhashCheck(false);
 const raw=(key:any)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
 const rpc:any={cluster:'mainnet',call:async(method:string,args:any[])=>{
  const context={slot:Number(h.svm.getClock().slot)};
  if(method==='getProgramAccounts')return{context,value:h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS).filter((a:any)=>!args[1].filters.length||getBase58Decoder().decode(a.data.subarray(0,8))===args[1].filters[0].memcmp.bytes).map((a:any)=>({pubkey:a.address,account:raw(a.address)}))};
  if(method==='getMultipleAccounts')return{context,value:args[0].map(raw)};
  if(method==='getAccountInfo')return{context,value:raw(args[0])};
  if(method==='getMinimumBalanceForRentExemption')return Number(h.svm.minimumBalanceForRentExemption(BigInt(args[0])));
  throw Error(method);
 }},chain=new Chain(rpc,{subscribe:()=>()=>{},close:()=>{}} as any,()=>{},h.marker.address);
 chain.config=h.configState();chain.configKey=h.config;chain.now=()=>h.svm.getClock().unixTimestamp;
 const store=new Store(':memory:'),history=new History(store,rpc,()=>{}),recorder=new DovesRecorder(store,rpc),dir=mkdtempSync(join(tmpdir(),'span-band-compat-')),
 oldState=await import(pathToFileURL(resolve(old,'src/tape/state.ts')).href),oldPublisher=await import(pathToFileURL(resolve(old,'src/tape/publish.ts')).href),before=new oldPublisher.Publisher(store,chain,history,recorder,join(dir,'old')),after=new Publisher(store,chain,history,recorder,join(dir,'new'));
 const compare=()=>{for(const version of [1,2] as const){expect(liveDocuments(chain,history,()=>null,version)).toEqual(oldState.liveDocuments(chain,history,()=>null,version));const a=version===1?after:after.versioned(),b=version===1?before:before.versioned();expect(a.feedDocument()).toEqual(b.feedDocument());expect(a.hoursDocument()).toEqual(b.hoursDocument());expect(a.historyDocument()).toEqual(b.historyDocument());expect(a.candlePathBody(Number(t.t0))).toEqual(b.candlePathBody(Number(t.t0)));}};
 const errors:any[]=[],sent:any[]=[],prepare=await createPrepare(rpc,h.marker,chain,{register:()=>{}},()=>({blockhash:h.svm.latestBlockhash(),lastValidBlockHeight:100000000000n}));let engine:Engine;
 engine=new Engine(chain,h.marker.address,{blockhash:()=>h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{
  const row=capture(h,p.wire);if(row.tx.meta.err){errors.push(row.tx.meta.logMessages);return;}history.ingest(row.signature,row.tx);sent.push(p);
  void chain.pollPrograms().then(()=>{engine.result(p,null,'signature');engine.update();}).catch(e=>errors.push(e));
 },cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 const wait=async(fn:()=>boolean)=>{const until=performance.now()+5000;while(!fn()){if(errors.length)throw Error(JSON.stringify(errors));if(performance.now()>until)throw Error('Compatibility timeout');await new Promise(r=>setTimeout(r,5));}};
 vi.spyOn(Date,'now').mockReturnValue(1800000000000);
 try{
  h.clock(t.t0);h.price(10000000000n,t.t0);await h.send('opening',h.readIx(t,0));h.clock(t.t0+60n);await chain.pollPrograms();expect(chain.bandBps(t.ticket)).toBe(400);compare();
  chain.feed={price:10200000000n,publishTs:t.t0+60n,slot:1,source:'poll',recvMs:0};h.price(10200000000n,t.t0+60n);engine.update();await wait(()=>h.ticketState(t).marks===1);await chain.pollPrograms();compare();
  h.clock(s.settleAfter(h.candleState(t)));engine.update();await wait(()=>!h.svm.getAccount(t.ticket).exists);await chain.pollPrograms();compare();expect(sent.filter(p=>p.action.kind==='mark')).toHaveLength(1);expect(sent.filter(p=>p.action.kind==='settle')).toHaveLength(1);expect(errors).toEqual([]);
 }finally{engine.close();chain.close();store.close();vi.restoreAllMocks();}
});

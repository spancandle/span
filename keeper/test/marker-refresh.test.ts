import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../../program/tests/harness.js';
const fixture=vi.hoisted(()=>({signer:undefined as any}));
vi.mock('../src/keeper/chain.js',async()=>{
 const actual=await vi.importActual<any>('../src/keeper/chain.js');
 return{...actual,signerFile:async()=>fixture.signer};
});
vi.mock('../src/common/rpc.js',async()=>{
 const actual=await vi.importActual<any>('../src/common/rpc.js');
 return{...actual,RpcPool:class{
  cluster='devnet';metrics={snapshot:()=>({})};async initialize(){}close(){}
  async call(method:string){if(method==='getLatestBlockhash')return{value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:100n}};
   if(method==='getBlockHeight')return 1;throw Error('Unexpected RPC');}
 }};
});
vi.mock('../src/common/ws.js',()=>({Subscriptions:class{ready=true;subscribe(){return()=>{};}on(){}start(){}close(){}}}));
vi.mock('../src/common/telemetry.js',()=>({keeperTelemetry:()=>()=>{}}));
import { Chain } from '../src/keeper/chain.js';
import { Sender, type Prepared } from '../src/keeper/sender.js';
import { CreationBudget } from '../src/keeper/budget.js';
import { runKeeper } from '../src/keeper/main.js';
it('the running keeper refreshes program accounts and re-evaluates their new marker after NotMarker',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({loaded:true});fixture.signer=h.marker;
 vi.useFakeTimers();vi.stubEnv('SPAN_CLUSTER','devnet');vi.stubEnv('KEEPER_RELEASE_HOURS','0');vi.stubEnv('KEEPER_DATA_DIR',mkdtempSync(join(tmpdir(),'marker-refresh-')));
 vi.spyOn(Chain.prototype,'init').mockImplementation(async function(this:Chain){this.configKey=h.config;this.config=h.configState();this.now=()=>h.svm.getClock().unixTimestamp;});
 vi.spyOn(Chain.prototype,'start').mockImplementation(()=>{});
 vi.spyOn(CreationBudget.prototype,'reconcile').mockResolvedValue(undefined);
 let sender:Sender|undefined;vi.spyOn(Sender.prototype,'onSlot').mockImplementation(function(this:Sender){sender=this;});
 const signals=['SIGINT','SIGTERM'] as const,prior=signals.map(s=>new Set(process.listeners(s)));
 let live:Awaited<ReturnType<typeof runKeeper>>|undefined;
 try{
  live=await runKeeper();live.chain.onSlot();expect(sender).toBeDefined();
  live.chain.candles.set(t.candle,{value:h.candleState(t),slot:1,data:''});live.chain.tickets.set(t.ticket,{value:h.ticketState(t),slot:1,data:''});
  const p={action:{kind:'mark',key:`mark:${t.ticket}`,ticket:t.ticket,t0:t.t0},signature:'pending',wire:'',blockhash:'hash',lastValidBlockHeight:100n,price:1n,rent:0n} as Prepared;
  live.engine.pending.set(p.action.key,p);
  let release!:()=>void;
  const chain=live.chain,reload=vi.spyOn(chain,'pollPrograms').mockImplementation(()=>new Promise<void>(yes=>{release=()=>{chain.tickets.get(t.ticket)!.value.marker=h.stranger.address;yes();};}));
  const update=vi.spyOn(live.engine,'update'),result=vi.spyOn(live.engine,'result');
  sender!.done(p,'NotMarker','preflight');expect(reload).toHaveBeenCalledTimes(1);expect(update).not.toHaveBeenCalled();
  release();await Promise.resolve();await Promise.resolve();
  expect(result).toHaveBeenCalledWith(p,'NotMarker','preflight');expect(reload).toHaveBeenCalledTimes(1);
  expect(chain.tickets.get(t.ticket)!.value.marker).toBe(h.stranger.address);expect(update).toHaveBeenCalled();
  expect(live.engine.pending.has(p.action.key)).toBe(false);expect(live.engine.endedMarks.has(t.ticket)).toBe(false);
 }finally{
  live?.close();signals.forEach((s,i)=>{for(const listener of process.listeners(s))if(!prior[i].has(listener))process.removeListener(s,listener);});
  vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();
 }
});

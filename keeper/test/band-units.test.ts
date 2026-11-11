import {expect,it} from 'vitest';
import {appendFileSync} from 'node:fs';
import {getBase58Decoder,getCompiledTransactionMessageDecoder,getTransactionDecoder,lamports} from '@solana/kit';
import {Harness} from '../../program/tests/harness.js';
import * as s from '../../program/client/index.js';
import {TOKEN,TOKEN_2022} from '../../program/client/constants.js';
import {Chain} from '../src/keeper/chain.js';
import {createPrepare} from '../src/keeper/main.js';
import {capture} from './resale-support.js';

for(const spanProgram of [TOKEN,TOKEN_2022])for(const bandBps of [100,200,400])for(const mode of ['existing','missing','reassigned','memo'] as const)
it(`production CU and packet bounds ${spanProgram}/${bandBps}/${mode}`,async()=>{
 if(mode==='memo'&&spanProgram===TOKEN)return;
 const h=await Harness.create({setSpan:true,spanProgram}),t=await h.open({loaded:true,strikeBps:100,bandBps});h.svm.withBlockhashCheck(false);
 const raw=(key:any)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
 const rpc:any={cluster:'mainnet',call:async(method:string,args:any[])=>{
  if(method==='getAccountInfo')return{value:raw(args[0])};
  if(method==='getMultipleAccounts')return{value:args[0].map(raw)};
  if(method==='getMinimumBalanceForRentExemption')return Number(h.svm.minimumBalanceForRentExemption(BigInt(args[0])));
  throw Error(method);
 }},chain=new Chain(rpc,{} as any,()=>{},h.marker.address);
 chain.configKey=h.config;chain.config=h.configState();chain.bandBps=()=>bandBps;
 const sync=()=>{chain.candles.set(t.candle,{value:h.candleState(t),slot:1,data:''});if(h.svm.getAccount(t.ticket).exists)chain.tickets.set(t.ticket,{value:h.ticketState(t),slot:1,data:''});else chain.tickets.delete(t.ticket);};
 const prepare=await createPrepare(rpc,h.marker,chain,{register:()=>{}},()=>({blockhash:h.svm.latestBlockhash(),lastValidBlockHeight:100000000000n}));
 const measure=async(kind:'mark'|'settle'|'closeBand',fee:bigint,label:string)=>{
  sync();const action={kind,key:`${kind}:${t.ticket}:${label}`,t0:t.t0,...(kind==='closeBand'?{band:t.band}:{ticket:t.ticket})},p=await prepare(action,fee),message:any=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(p.wire,'base64')).messageBytes),limit=Buffer.from(message.instructions[0].data).readUInt32LE(1),row=capture(h,p.wire);
  expect(row.tx.meta.err,row.tx.meta.logMessages.join('\n')).toBe(null);expect(row.tx.meta.computeUnitsConsumed).toBeLessThanOrEqual(limit);
  const bytes=Buffer.from(p.wire,'base64').length;expect(bytes).toBeLessThanOrEqual(1232);
  if(process.env.SPAN_BAND_KEEPER_UNITS)appendFileSync(process.env.SPAN_BAND_KEEPER_UNITS,JSON.stringify({kind,label,bandBps,spanProgram,mode,cu:row.tx.meta.computeUnitsConsumed,limit,bytes,rent:String(p.rent)})+'\n');
 };
 h.clock(t.t0);h.price(10000000000n,t.t0);await h.send('opening',h.readIx(t,0));
 h.clock(t.t0+60n);h.price(10010000000n,t.t0+60n);await measure('mark',10000n,'free');
 h.clock(t.t0+61n);h.price(10110000000n,t.t0+61n);await measure('mark',10001n,'paid');
 if(mode==='missing'){
  const a=h.svm.getAccount(h.buyerSpan);if(!a.exists)throw Error('Missing recipient');
  h.svm.setAccount({...a,programAddress:'11111111111111111111111111111111' as any,data:new Uint8Array(),lamports:lamports(0n)});
 }
 if(mode==='reassigned'){
  const a=h.svm.getAccount(h.buyerSpan);if(!a.exists)throw Error('Missing recipient');const d=Buffer.from(a.data);d.set((await import('@solana/kit')).getAddressEncoder().encode(h.stranger.address),32);h.svm.setAccount({...a,data:d});
 }
 if(mode==='memo'){
  const token=await import('@solana-program/token-2022');await h.send('memo',[token.getReallocateInstruction({token:h.buyerSpan,payer:h.buyer,owner:h.buyer,newExtensionTypes:[token.ExtensionType.MemoTransfer]}),token.getEnableMemoTransfersInstruction({token:h.buyerSpan,owner:h.buyer})],h.buyer);
 }
 h.clock(s.settleAfter(h.candleState(t)));await measure('settle',10000n,'paid');
 if(bandBps!==400){chain.bands.set(t.band,{value:s.getBandDecoder().decode(Buffer.from(raw(t.band)!.data[0],'base64')),slot:1,data:''});await measure('closeBand',10000n,'rent');}
});

import {vi} from 'vitest';
import {getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getAddressDecoder,getTransactionEncoder,getSignatureFromTransaction,type Address} from '@solana/kit';
import {FailedTransactionMetadata} from '../../program/node_modules/litesvm/dist/index.js';
import * as s from '../../program/client/index.js';
import {TOKEN,TOKEN_2022,USDC} from '../../program/client/constants.js';
import {Harness,type Wallet} from '../../program/tests/harness.js';
import {Chain} from '../src/keeper/chain.js';

/** Convert native VM execution metadata to the JSON RPC shape consumed by the recorder. */
export function capture(h:Harness,wire:string){
 const tx=getTransactionDecoder().decode(Buffer.from(wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes)as any,keys:Address[]=message.staticAccounts;
 const before=keys.map(k=>h.svm.getAccount(k)),result=h.svm.sendTransaction(tx),failed=result instanceof FailedTransactionMetadata,meta=failed?result.meta():result,after=keys.map(k=>h.svm.getAccount(k));
 const balances=(accounts:any[])=>accounts.flatMap((a,i)=>{
  if(!a.exists||!(a.programAddress===TOKEN&&a.data.length===165||a.programAddress===TOKEN_2022&&(a.data.length===165||a.data.length>=166&&a.data[165]===2)))return[];
  const mint=getAddressDecoder().decode(a.data.subarray(0,32)),mintAccount=h.svm.getAccount(mint);
  return[{accountIndex:i,mint,owner:getAddressDecoder().decode(a.data.subarray(32,64)),uiTokenAmount:{amount:Buffer.from(a.data).readBigUInt64LE(64).toString(),decimals:mintAccount.exists?mintAccount.data[44]:0}}];
 });
 const preBalances=before.map(a=>a.exists?Number(a.lamports):0),postBalances=after.map(a=>a.exists?Number(a.lamports):0),signature=getSignatureFromTransaction(tx);
 return{signature,result,tx:{slot:Number(h.svm.getClock().slot),blockTime:Number(h.svm.getClock().unixTimestamp),transaction:{signatures:[signature],message:{accountKeys:keys,instructions:message.instructions.map((ix:any)=>({programIdIndex:ix.programAddressIndex,accounts:Array.from(ix.accountIndices??[]),data:getBase58Decoder().decode(ix.data??new Uint8Array())}))}},meta:{err:failed?String(result.err()):null,fee:preBalances.reduce((a,b)=>a+b,0)-postBalances.reduce((a,b)=>a+b,0),computeUnitsConsumed:Number(meta.computeUnitsConsumed()),preBalances,postBalances,preTokenBalances:balances(before),postTokenBalances:balances(after),logMessages:meta.logs(),innerInstructions:meta.innerInstructions().map((ixs,index)=>({index,instructions:ixs.map(x=>({programIdIndex:x.instruction().programIdIndex(),accounts:Array.from(x.instruction().accounts()),data:getBase58Decoder().decode(x.instruction().data())}))}))}}};
}

export async function resaleRuntime(o:{spanProgram?:Address}={}){
 const h=await Harness.create({spanProgram:o.spanProgram}),t=await h.ref(),resale=(await s.findResalePda(t.ticket))[0];h.svm.withBlockhashCheck(false);
 const actors=[{signer:h.buyer,usdc:h.buyerUsdc,span:h.buyerSpan}];
 for(const signer of[h.stranger,h.admin])actors.push({signer,usdc:await h.fundToken(signer,USDC,TOKEN,1000000000n),span:await h.fundToken(signer,h.spanMint,h.spanProgram,1000000n)});
 const raw=(key:Address)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
 const subscriptions:any[]=[],rpc={cluster:'mainnet',call:vi.fn(async(method:string,params:any[])=>{
  const context={slot:Number(h.svm.getClock().slot)};
  if(method==='getAccountInfo')return{context,value:raw(params[0])};
  if(method==='getMultipleAccounts')return{context,value:params[0].map(raw)};
  if(method==='getProgramAccounts')return{context,value:h.svm.getProgramAccounts(s.SPAN_PROGRAM_ADDRESS).filter(a=>getBase58Decoder().decode(a.data.subarray(0,8))===params[1].filters[0].memcmp.bytes).map(a=>({pubkey:a.address,account:raw(a.address)}))};
  if(method==='getMinimumBalanceForRentExemption')return Number(h.svm.minimumBalanceForRentExemption(BigInt(params[0])));
  throw Error(method);
 })},ws={subscribe:(kind:string,args:any[],cb:any)=>{subscriptions.push({kind,args,cb});return()=>{};},on:()=>{},start:()=>{},close:()=>{}};
 const chain=new Chain(rpc as any,ws as any,()=>{},h.marker.address);chain.config=h.configState();chain.configKey=h.config;chain.now=()=>h.svm.getClock().unixTimestamp;
 const sync=()=>{const slot=Number(h.svm.getClock().slot);for(const[kind,key]of[['candle',t.candle],['ticket',t.ticket],['resale',resale]]as const)chain.ingest(kind,key,raw(key),slot);chain.config=h.configState();};
 const execute=async(ixs:any[],payer:Wallet=h.marker)=>{const tx=await h.transaction(ixs,payer);return capture(h,Buffer.from(getTransactionEncoder().encode(tx)).toString('base64'));};
 const list=(actor=actors[0],ask=100000n)=>h.ix('listResale',{...t,resale,holder:actor.signer,ask,until:t.t0+3600n});
 const buy=(from=actors[0],to=actors[1],extra:any={})=>{const loaded=h.ticketState(t).spanLoaded>0n;return h.ix('buyResale',{...t,resale,holder:from.signer.address,holderUsdc:from.usdc,buyer:to.signer,buyerSource:to.usdc,feed:h.feed,maxPay:40000000n,spanMint:loaded?h.spanMint:undefined,spanHold:loaded?t.spanHold:undefined,holderSpan:loaded?from.span:undefined,spanTokenProgram:loaded?h.spanProgram:undefined,...extra});};
 const load=(actor=actors[0],amount=10000n)=>h.loadIx(t,{buyer:actor.signer,spanSource:actor.span,amount});
 return{h,t,resale,actors,raw,rpc,ws,subscriptions,chain,sync,execute,list,buy,load};
}

import {expect} from 'vitest';
import {FailedTransactionMetadata,Rent} from 'litesvm';
import {getCompiledTransactionMessageDecoder,getTransactionEncoder,unwrapOption,type Address,type Instruction} from '@solana/kit';
import * as s from '../client/index.js';
import {USDC,TOKEN} from '../client/constants.js';
import {Harness,type Wallet,amount,accountData} from './harness.js';
export const P0=10000000000n;
export const bidBudget=():Instruction[]=>{const programAddress='ComputeBudget111111111111111111111111111111'as Address,a=Buffer.alloc(5),b=Buffer.alloc(9);a[0]=2;a.writeUInt32LE(1400000,1);b[0]=3;b.writeBigUInt64LE(10000n,1);return[{programAddress,data:a},{programAddress,data:b}];};
export type Actor={signer:Wallet;usdc:Address;span:Address};
export async function bidFixture(o:{loaded?:boolean;opening?:boolean;secs?:bigint;spanProgram?:Address;mainnetRent?:boolean;setSpan?:boolean;strikeBps?:number}={}){
 const h=await Harness.create({setSpan:o.setSpan??true,spanProgram:o.spanProgram});
 if(o.mainnetRent)h.svm.setRent(new Rent(5080n,1,50));
 const actors:Actor[]=[{signer:h.buyer,usdc:h.buyerUsdc,span:h.buyerSpan}];
 for(const signer of[h.stranger,h.admin])actors.push({signer,usdc:await h.fundToken(signer,USDC,TOKEN,1000000000n),span:await h.fundToken(signer,h.spanMint,h.spanProgram,1000000n)});
 const t=await h.open({t0:o.secs===1800n?1203n:1200n,sold:true,loaded:o.loaded??false,premium:1000000n,strikeBps:o.strikeBps??0}),resale=(await s.findResalePda(t.ticket))[0];
 const holder=()=>actors.find(a=>a.signer.address===unwrapOption(h.ticketState(t).buyer))!;
 const ref=async(bidder=actors[1])=>{const bid=(await s.findBidPda(t.ticket,bidder.signer.address))[0];return{bid,bidUsdc:(await s.findBidUsdcPda(bid))[0],bidSpan:(await s.findBidSpanPda(bid))[0],bidder};};
 const place=async(bidder=actors[1],extra:any={})=>{const b=await ref(bidder);return h.ix('placeBid',{...t,...b,bidder:bidder.signer,bidderSource:bidder.usdc,ask:100000n,cap:40000000n,until:t.t0+s.secsOf(t.t0),...extra});};
 const bidSpan=async(bidder=actors[1],extra:any={})=>{const b=await ref(bidder);return h.ix('bidSpan',{...b,bidder:bidder.signer,spanSource:bidder.span,amount:1000n,stepBps:5,marker:h.marker.address,...extra});};
 const accept=async(bidder=actors[1],extra:any={})=>{const b=await ref(bidder),from=holder(),offered=h.svm.getAccount(b.bid).exists&&s.getBidDecoder().decode(accountData(h.svm,b.bid)).spanAmount>0n,old=h.ticketState(t).spanLoaded>0n;return h.ix('acceptBid',{...t,...b,bidder:bidder.signer.address,holder:from.signer,holderUsdc:from.usdc,bidderUsdc:bidder.usdc,feed:h.feed,resale,spanMint:old||offered?h.spanMint:undefined,spanTokenProgram:old||offered?h.spanProgram:undefined,spanHold:old||offered?t.spanHold:undefined,holderSpan:old?from.span:undefined,bidSpan:offered?b.bidSpan:undefined,...extra});};
 const close=async(bidder=actors[1],extra:any={})=>{const b=await ref(bidder),offered=s.getBidDecoder().decode(accountData(h.svm,b.bid)).spanAmount>0n;return h.ix('closeBid',{...b,bidder:bidder.signer.address,ticket:t.ticket,closer:bidder.signer,bidderUsdc:bidder.usdc,bidSpan:offered?b.bidSpan:undefined,bidderSpan:offered?bidder.span:undefined,spanMint:offered?h.spanMint:undefined,spanTokenProgram:offered?h.spanProgram:undefined,...extra});};
 const list=(ask=100000n)=>h.ix('listResale',{...t,resale,holder:holder().signer,ask,until:t.t0+s.secsOf(t.t0)});
 const buyResale=(to:Actor,extra:any={})=>{const from=holder(),loaded=h.ticketState(t).spanLoaded>0n;return h.ix('buyResale',{...t,resale,holder:from.signer.address,holderUsdc:from.usdc,buyer:to.signer,buyerSource:to.usdc,feed:h.feed,maxPay:79000000n,spanMint:loaded?h.spanMint:undefined,spanTokenProgram:loaded?h.spanProgram:undefined,spanHold:loaded?t.spanHold:undefined,holderSpan:loaded?from.span:undefined,...extra});};
 const settle=()=>{const a=holder();return h.settleIx(t,{buyer:a.signer.address,buyerUsdc:a.usdc,buyerSpan:h.ticketState(t).spanLoaded?a.span:undefined});};
 if(o.opening!==false){h.clock(t.t0);h.price(P0,t.t0);await h.send('opening',h.readIx(t,0));h.clock(t.t0+60n);h.price(P0,t.t0+60n);}
 return{h,t,actors,resale,holder,ref,place,bidSpan,accept,close,list,buyResale,settle};
}
export type BidFixture=Awaited<ReturnType<typeof bidFixture>>;
export async function sendBid(h:Harness,input:Instruction|readonly Instruction[],payer:Wallet,failure?:string){
 const own=Array.isArray(input)?input:[input as Instruction],ixs=[...bidBudget(),...own],tx=await h.transaction(ixs,payer),keys=getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts,before=keys.map(k=>h.svm.getAccount(k)),totals=h.totals(),supply=h.supplies(),result=h.svm.sendTransaction(tx),failed=result instanceof FailedTransactionMetadata,meta=failed?result.meta():result;
 const fee=keys.reduce((n,k,i)=>{const a=h.svm.getAccount(k);return n+(before[i].exists?before[i].lamports:0n)-(a.exists?a.lamports:0n);},0n);h.lastFee=fee;
 if(failure!==undefined){expect(failed).toBe(true);if(failure)expect(meta.logs().join('\n')).toContain(`Error Code: ${failure}.`);keys.forEach((k,i)=>{const a=h.svm.getAccount(k),b=before[i];expect(a.exists).toBe(b.exists);if(a.exists&&b.exists){expect(a.data).toEqual(b.data);if(k!==payer.address)expect(a.lamports).toBe(b.lamports);}});expect(h.totals()).toEqual(totals);}
 else{if(failed){keys.forEach((k,i)=>{const a=h.svm.getAccount(k),b=before[i];expect(a.exists).toBe(b.exists);if(a.exists&&b.exists){expect(a.data).toEqual(b.data);if(k!==payer.address)expect(a.lamports).toBe(b.lamports);}});expect(h.totals()).toEqual(totals);throw Error(meta.logs().join('\n'));}for(const mint of Object.keys(totals))expect((h.totals()[mint]??0n)-totals[mint]).toBe((h.supplies()[mint]??0n)-supply[mint]);h.events=s.decodeEvents(meta.innerInstructions().flat().map(ix=>({programAddress:keys[ix.instruction().programIdIndex()],data:ix.instruction().data()})));}
 return{meta,fee,bytes:getTransactionEncoder().encode(tx).length,events:h.events};
}
export const native=(h:Harness,key:Address)=>{const a=h.svm.getAccount(key);return a.exists?a.lamports:0n;};
export const token=(h:Harness,key:Address)=>amount(h.svm,key);

import {it,expect} from 'vitest';
import {appendFileSync} from 'node:fs';
import {getTransactionEncoder,type Instruction,lamports} from '@solana/kit';
import {getCreateAssociatedTokenIdempotentInstruction} from '@solana-program/token';
import * as s from '../client/index.js';
import {TOKEN,TOKEN_2022} from '../client/constants.js';
import {Harness,type Wallet} from './harness.js';
import {requestFixture,requestOrder,requestBudget,sendRequest} from './request-fixture.js';
const record=(x:any)=>{if(process.env.SPAN_REQUEST_EVIDENCE)appendFileSync(process.env.SPAN_REQUEST_EVIDENCE,JSON.stringify({name:'packet',...x})+'\n');};
async function packet(h:Harness,core:Instruction[],prep:Instruction[],payer:Wallet,label:string){
 const bytes=getTransactionEncoder().encode(await h.transaction([...requestBudget(),...prep,...core],payer)).length;let split=false;
 if(bytes>1232){split=true;if(prep.length)await sendRequest(h,prep,payer);}
 const row=await sendRequest(h,split?core:[...prep,...core],payer);expect(row.bytes).toBeLessThanOrEqual(1232);record({label,withPrepBytes:bytes,split,bytes:row.bytes,cu:Number(row.meta.computeUnitsConsumed())});
}
function ata(h:Harness,payer:Wallet,owner:Wallet,address:Wallet['address'],span=false){
 const old=h.svm.getAccount(address);if(old.exists)h.svm.setAccount({...old,data:new Uint8Array(),lamports:lamports(0n),programAddress:'11111111111111111111111111111111' as Wallet['address']});
 return getCreateAssociatedTokenIdempotentInstruction({payer,ata:address,owner:owner.address,mint:span?h.spanMint:h.configState().usdcMint,tokenProgram:span?h.spanProgram:TOKEN});
}
for(const spanProgram of[TOKEN,TOKEN_2022])for(const old of[false,true])for(const offered of[false,true])it(`held site-shaped packet ${spanProgram}/${old}/${offered}`,async()=>{
 const x=await requestFixture({loaded:old,spanProgram}),{h,actors}=x;await sendRequest(h,[await x.place(),...(offered?[await x.requestSpan()]:[])],actors[1].signer);await sendRequest(h,x.list(),actors[0].signer);
 const prep=[ata(h,actors[0].signer,actors[1].signer,actors[1].usdc),ata(h,actors[0].signer,actors[0].signer,actors[0].usdc),...(old?[ata(h,actors[0].signer,actors[0].signer,actors[0].span,true)]:[])];
 await packet(h,[h.ix('closeResale',{resale:x.resale,ticket:x.t.ticket,holder:actors[0].signer.address,closer:actors[0].signer}),await x.accept()],prep,actors[0].signer,`held/${spanProgram}/${old}/${offered}`);
});
for(const kind of['open','running']as const)for(const spanProgram of[TOKEN,TOKEN_2022])for(const loaded of[false,true])it(`${kind} site-shaped packet ${spanProgram}/${loaded}`,async()=>{
 const h=await Harness.create({setSpan:true,spanProgram}),t=await h.ref(),a={signer:h.buyer,usdc:h.buyerUsdc,span:h.buyerSpan},r=await requestOrder(h,a);const place=await sendRequest(h,[r.place(),...(loaded?[r.span()]:[])],h.buyer);record({label:`place/${spanProgram}/${loaded}`,withPrepBytes:place.bytes,split:false,bytes:place.bytes,cu:Number(place.meta.computeUnitsConsumed())});
 if(kind==='running'){await h.send('candle',h.openCandleIx(t),h.stranger);h.clock(t.t0);h.price(10000000000n,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);h.price(10000000000n,t.t0+60n);}
 const prep=[...(kind==='open'?[h.openCandleIx(t,{payer:h.seller})]:[]),ata(h,h.seller,h.buyer,h.buyerUsdc)];await packet(h,[r.fill(kind,t)],prep,h.seller,`${kind}/${spanProgram}/${loaded}`);
});

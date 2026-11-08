import {expect,it} from 'vitest';
import {LiteSVM,Rent} from 'litesvm';
import {appendFileSync,readFileSync} from 'node:fs';
import {getTransferSolInstruction} from '@solana-program/system';
import {getTransferCheckedInstruction} from '@solana-program/token';
import {lamports,unwrapOption,type Address} from '@solana/kit';
import * as s from '../client/index.js';
import {TOKEN,TOKEN_2022,USDC,LOADER} from '../client/constants.js';
import {Harness,accountData,PROGRAM} from './harness.js';
import {bidFixture} from './bid-fixture.js';
import {requestFixture,requestOrder,sendRequest,native,token,P0,type Actor} from './request-fixture.js';
const evidence=(name:string,row:any)=>{if(process.env.SPAN_REQUEST_EVIDENCE)appendFileSync(process.env.SPAN_REQUEST_EVIDENCE,JSON.stringify({name,...row},(_,v)=>typeof v==='bigint'?String(v):v)+'\n');};
const filled=(h:Harness)=>h.events.find(e=>e.name==='RequestFilled')!.data;
const buyer=(h:Harness):Actor=>({signer:h.buyer,usdc:h.buyerUsdc,span:h.buyerSpan});
async function finish(h:Harness,t:Awaited<ReturnType<Harness['ref']>>,a=buyer(h)){
 for(let j=0;j<=s.lastReadOf(t.t0);j++)if(!h.candleState(t).reads[j].price){const ts=t.t0+BigInt(j)*300n;h.clock(ts);h.price(P0,ts);await h.send('read',h.readIx(t,j),h.marker);}
 h.clock(s.settleAfter(h.candleState(t)));await h.send('settle',h.settleIx(t,{buyer:a.signer.address,buyerUsdc:a.usdc,buyerSpan:h.ticketState(t).spanLoaded?a.span:undefined}),h.marker);return h.events.find(e=>e.name==='Settled')!.data;
}
it('places before the candle exists and validates start, strike, room and both duration endpoints',async()=>{
 const h=await Harness.create({setSpan:true});for(const t0 of[1200n,1203n]){
  for(const extra of[{t0:1206n},{t0:-54n},{t0:9223372036854775800n,until:9223372036854775807n},{t0:9223372036854775803n,until:9223372036854775807n},{strikeBps:525},{strikeBps:1},{minRoom:40000001n},{until:1000n},{until:t0+s.secsOf(t0)+1n}]){const r=await requestOrder(h,buyer(h),{t0,...extra});await sendRequest(h,r.place(),h.buyer,'InvalidValue');}
  for(const strikeBps of[0,500]){const r=await requestOrder(h,buyer(h),{t0,strikeBps,minRoom:40000000n});expect(h.svm.getAccount((await s.findCandlePda(t0))[0]).exists).toBe(false);await sendRequest(h,r.place(),h.buyer);expect(accountData(h.svm,r.request)).toHaveLength(127);await sendRequest(h,r.close(),h.buyer);}
 }
});
for(const spanProgram of[TOKEN,TOKEN_2022])for(const mainnetRent of[false,true])for(const old of[false,true])for(const offered of[false,true])it(`held matches accept_bid from identical state: ${spanProgram}/${mainnetRent}/${old}/${offered}`,async()=>{
 const x=await bidFixture({loaded:old,spanProgram,mainnetRent}),{h,t,actors}=x;
 if(old){h.price(P0*101n/100n,t.t0+60n);await h.send('mark',h.markIx(t));}
 const r=await requestOrder(h,actors[1],{t0:t.t0}),snapshot=h.svm.toBytes(),results:any[]=[];
 for(const request of[false,true]){h.svm=LiteSVM.fromBytes(snapshot);const before=actors.map(a=>({usdc:token(h,a.usdc),span:token(h,a.span),sol:native(h,a.signer.address)}));
  const placed=await sendRequest(h,[request?r.place():await x.place(),...(offered?[request?r.span():await x.bidSpan()]:[])],actors[1].signer);
  const y=request?await requestFixtureFrom(x):undefined,row=await sendRequest(h,request?await y!.accept():await x.accept(),actors[0].signer),event=h.events.find(e=>e.name===(request?'RequestFilled':'BidAccepted'))!.data as any;
  const balances=actors.map((a,i)=>({usdc:token(h,a.usdc)-before[i].usdc,span:token(h,a.span)-before[i].span,sol:native(h,a.signer.address)-before[i].sol+(i===0?row.fee:i===1?placed.fee:0n)}));
  results.push({balances,ticket:h.ticketState(t),vault:token(h,t.vault),hold:token(h,t.spanHold),holdingRent:native(h,t.spanHold),fields:Object.fromEntries(['recorded','paid','refund','extra','spanReturned','spanLoaded','marks','burned','high','low','tailHigh','tailLow'].map(k=>[k,event[k]]))});
 }
 expect(results[1]).toEqual(results[0]);evidence('held-comparison',{spanProgram,mainnetRent,old,offered,...results[1]});
});
async function requestFixtureFrom(x:Awaited<ReturnType<typeof bidFixture>>){
 const {h,t,actors}=x,r=await requestOrder(h,actors[1],{t0:t.t0}),old=h.ticketState(t).spanLoaded>0n,loaded=s.getRequestDecoder().decode(accountData(h.svm,r.request)).spanAmount>0n;
 return{accept:()=>h.ix('fillRequestHeld',{...t,...r,holder:actors[0].signer,holderUsdc:actors[0].usdc,requester:actors[1].signer.address,requesterUsdc:actors[1].usdc,resale:x.resale,feed:h.feed,spanMint:old||loaded?h.spanMint:undefined,spanTokenProgram:old||loaded?h.spanProgram:undefined,spanHold:old||loaded?t.spanHold:undefined,holderSpan:old?actors[0].span:undefined,requestSpan:loaded?r.requestSpan:undefined})};
}
for(const minRoom of[30000000n,30000001n])it(`held room boundary ${minRoom} and candle/strike mismatch`,async()=>{
 const x=await requestFixture({loaded:true}),{h,t}=x;h.price(P0*101n/100n,t.t0+60n);await h.send('mark',h.markIx(t));await sendRequest(h,await x.place(undefined,{minRoom}),x.actors[1].signer);await sendRequest(h,await x.accept(),x.actors[0].signer,minRoom===30000001n?'RoomShort':undefined);
 if(minRoom===30000000n)expect(filled(h).recorded).toBe(10000000n);
 const y=await requestFixture(),r=await requestOrder(y.h,y.actors[1],{t0:y.t.t0+60n});await sendRequest(y.h,r.place(),y.actors[1].signer);await sendRequest(y.h,await y.accept(undefined,{...r,requestSpan:undefined}),y.actors[0].signer,'RequestMismatch');
 const z=await requestFixture(),r2=await requestOrder(z.h,z.actors[1],{t0:z.t.t0,strikeBps:25});await sendRequest(z.h,r2.place(),z.actors[1].signer);await sendRequest(z.h,await z.accept(undefined,{...r2,requestSpan:undefined}),z.actors[0].signer,'RequestMismatch');
});
for(const kind of['open','running']as const)for(const spanProgram of[TOKEN,TOKEN_2022])for(const mainnetRent of[false,true])for(const loaded of[false,true])it(`${kind} equals the existing real command pair: ${spanProgram}/${mainnetRent}/${loaded}`,async()=>{
 const h=await Harness.create({setSpan:true,spanProgram});if(mainnetRent)h.svm.setRent(new Rent(5080n,1,50));const t=await h.ref(),r=await requestOrder(h,buyer(h)),until=(await s.findUntilPda(t.ticket))[0];
 await h.send('candle',h.openCandleIx(t),h.stranger);if(kind==='running'){h.clock(t.t0);h.price(P0,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);h.price(P0*101n/100n,t.t0+60n);}
 const initial=h.svm.toBytes(),out:any[]=[];
 for(const request of[false,true]){h.svm=LiteSVM.fromBytes(initial);const bn=native(h,h.buyer.address),sn=native(h,h.seller.address),bu=token(h,h.buyerUsdc),su=token(h,h.sellerUsdc),bs=token(h,h.buyerSpan);let buyerFees=0n,sellerFees=0n;
  if(request){const a=await sendRequest(h,[r.place(),...(loaded?[r.span({amount:100000n})]:[])],h.buyer);buyerFees+=a.fee;const b=await sendRequest(h,r.fill(kind,t),h.seller);sellerFees+=b.fee;const event=filled(h);expect(event.kind).toBe(kind==='open'?s.RequestKind.Open:s.RequestKind.Running);expect(event.paid).toBe(kind==='open'?100000n:10100000n);expect(event.refund).toBe(40000000n-event.paid);expect(token(h,t.vault)).toBe(40000000n+event.recorded);expect(unwrapOption(h.ticketState(t).buyer)).toBe(h.buyer.address);expect(h.configState().nextTicketId).toBe(t.id+1n);for(const a of[r.request,r.requestUsdc,r.requestSpan])expect(h.svm.getAccount(a).exists).toBe(false);evidence('seller-balance',{kind,spanProgram,mainnetRent,loaded,recorded:event.recorded,paid:event.paid,refund:event.refund,vault:token(h,t.vault),sellerUsdc:token(h,h.sellerUsdc)-su,requesterUsdc:token(h,h.buyerUsdc)-bu,sellerSolExFee:native(h,h.seller.address)-sn+sellerFees,requesterSolExFee:native(h,h.buyer.address)-bn+buyerFees,cu:Number(b.meta.computeUnitsConsumed()),bytes:b.bytes});}
  else{const a=await sendRequest(h,kind==='open'?h.openIx(t,100000n):h.ix('openRunning',{...t,until,untilArg:t.t0+3600n,premium:100000n,strikeBps:0,sellerSource:h.sellerUsdc}),h.seller);sellerFees+=a.fee;
   const b=await sendRequest(h,[kind==='open'?h.buyIx(t):h.ix('buyRunning',{...t,until,feed:h.feed,buyerSource:h.buyerUsdc,maxPay:40000000n}),...(loaded?[h.loadIx(t)]:[])],h.buyer);buyerFees+=b.fee;
   if(kind==='running'){const c=await sendRequest(h,h.ix('closeUntil',{...t,until,seller:h.seller.address,closer:h.seller}),h.seller);sellerFees+=c.fee;}}
  const state=h.ticketState(t),balances={buyerUsdc:token(h,h.buyerUsdc)-bu,sellerUsdc:token(h,h.sellerUsdc)-su,buyerSpan:token(h,h.buyerSpan)-bs,buyerNative:native(h,h.buyer.address)-bn+buyerFees,sellerNative:native(h,h.seller.address)-sn+sellerFees},vault=token(h,t.vault),settled=await finish(h,t);expect(settled.payout).toBeGreaterThanOrEqual(kind==='running'?10000000n:0n);out.push({state,balances,vault,settled});
 }
 expect(out[1]).toEqual(out[0]);evidence('seller-comparison',{kind,spanProgram,mainnetRent,loaded,...out[1]});
});
it('seller paths reject invalid identities, windows, expiry and oracle prices without side effects',async()=>{
 for(const kind of['open','running']as const){const h=await Harness.create({setSpan:true}),t=await h.ref(),r=await requestOrder(h,buyer(h),{until:1300n});await sendRequest(h,r.place(),h.buyer);await h.send('candle',h.openCandleIx(t),h.stranger);
  await sendRequest(h,r.fill(kind,t,undefined,{id:1n,ticket:(await h.ref(t.t0,1n)).ticket,vault:(await h.ref(t.t0,1n)).vault}),h.seller,'IdMismatch');
  await sendRequest(h,r.fill(kind,t,{signer:h.buyer,usdc:h.buyerUsdc}),h.buyer,'InvalidValue');
  const other=await h.ref(t.t0+60n);await h.send('other_candle',h.openCandleIx(other),h.stranger);await sendRequest(h,r.fill(kind,t,undefined,{candle:other.candle}),h.seller,'RequestMismatch');
  if(kind==='running'){await sendRequest(h,r.fill(kind,t),h.seller,'NoOpen');h.clock(t.t0);h.price(P0,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);
   for(const [publish,code]of[[t.t0,'FeedStale'],[t.t0+3601n,'OutsideCandle']]as const){h.price(P0,publish);await sendRequest(h,r.fill(kind,t),h.seller,code);}
   h.price(P0,t.t0);h.clock(t.t0);await sendRequest(h,r.fill(kind,t),h.seller,'OutsideCandle');}
  h.clock(kind==='open'?t.t0-5n:1301n);h.price(P0,kind==='open'?t.t0-5n:1301n);await sendRequest(h,r.fill(kind,t),h.seller,'BuyClosed');
  expect(h.configState().nextTicketId).toBe(0n);expect(h.svm.getAccount(t.ticket).exists).toBe(false);expect(token(h,r.requestUsdc)).toBe(40000000n);}
});
for(const [cap,minRoom,price,error]of[[10099999n,0n,P0*101n/100n,'PriceAboveMax'],[10100000n,30000001n,P0*101n/100n,'RoomShort'],[79000000n,0n,P0*104n/100n,'CapReached'],[10100000n,30000000n,P0*101n/100n,undefined]]as const)it(`running cap and room boundaries ${cap}/${minRoom}/${error??'exact'}`,async()=>{
 const h=await Harness.create(),t=await h.ref(),r=await requestOrder(h,buyer(h),{cap,minRoom});await sendRequest(h,r.place(),h.buyer);await h.send('candle',h.openCandleIx(t),h.stranger);h.clock(t.t0);h.price(P0,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);h.price(price,t.t0+60n);await sendRequest(h,r.fill('running',t),h.seller,error);
 if(!error){expect(filled(h).refund).toBe(0n);expect(token(h,t.vault)).toBe(50000000n);const result=await finish(h,t);expect(result.payout).toBeGreaterThanOrEqual(10000000n);expect(result.toSeller).toBe(50000000n-result.payout);}
});
for(const kind of['open','running']as const)for(const spanProgram of[TOKEN,TOKEN_2022])it(`${kind}/${spanProgram}: prefunded holding and unsolicited escrow units return exactly`,async()=>{
 const h=await Harness.create({setSpan:true,spanProgram});h.svm.setRent(new Rent(5080n,1,50));const t=await h.ref(),r=await requestOrder(h,buyer(h));await sendRequest(h,[r.place(),r.span()],h.buyer);await h.send('candle',h.openCandleIx(t),h.stranger);
 if(kind==='running'){h.clock(t.t0);h.price(P0,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);h.price(P0*101n/100n,t.t0+60n);}
 const rent=h.svm.getRent();h.svm.setRent(new Rent(1n,1,50));await sendRequest(h,getTransferSolInstruction({source:h.stranger,destination:t.spanHold,amount:lamports(777n)}),h.stranger);h.svm.setRent(rent);
 await sendRequest(h,[getTransferCheckedInstruction({source:h.buyerUsdc,mint:USDC,destination:r.requestUsdc,authority:h.buyer,amount:1n,decimals:6}),getTransferCheckedInstruction({source:h.buyerSpan,mint:h.spanMint,destination:r.requestSpan,authority:h.buyer,amount:1n,decimals:accountData(h.svm,h.spanMint)[44]},{programAddress:spanProgram})],h.buyer);
 const reserve=native(h,r.request),eu=native(h,r.requestUsdc),es=native(h,r.requestSpan),minimum=h.svm.minimumBalanceForRentExemption(BigInt(accountData(h.svm,r.requestSpan).length)),bn=native(h,h.buyer.address),sn=native(h,h.seller.address),bu=token(h,h.buyerUsdc),row=await sendRequest(h,r.fill(kind,t),h.seller),event=filled(h);
 expect(event.extra).toBe(1n);expect(event.spanLoaded).toBe(1001n);expect(token(h,h.buyerUsdc)-bu).toBe(event.refund+1n);expect(native(h,h.buyer.address)-bn).toBe(reserve+eu+es-(minimum-777n));expect(native(h,t.spanHold)).toBe(minimum);expect(native(h,h.seller.address)-sn+row.fee).toBe(-native(h,t.ticket)-native(h,t.vault));evidence('seller-prefund',{kind,spanProgram,reimbursed:minimum-777n,requesterRefund:reserve+eu+es-(minimum-777n),cu:Number(row.meta.computeUnitsConsumed()),bytes:row.bytes});
});
it('competing fills, close and duplicate next IDs commit only once',async()=>{
 const h=await Harness.create(),t=await h.ref(),r=await requestOrder(h,buyer(h));await sendRequest(h,r.place(),h.buyer);await h.send('candle',h.openCandleIx(t),h.stranger);const fill=r.fill('open',t),close=r.close();await sendRequest(h,fill,h.seller);await sendRequest(h,fill,h.seller,'');await sendRequest(h,close,h.buyer,'');
 const requester:Actor={signer:h.stranger,usdc:await h.fundToken(h.stranger,USDC,TOKEN,1000000000n),span:h.buyerSpan},r2=await requestOrder(h,requester);await sendRequest(h,r2.place(),h.stranger);await sendRequest(h,r2.fill('open',t),h.seller,'');await sendRequest(h,r2.close(),h.stranger);await sendRequest(h,r2.fill('running',await h.ref()),h.seller,'');expect(h.configState().nextTicketId).toBe(1n);
});
for(const secs of[3600n,1800n])it.skipIf(!process.env.SPAN_REQUEST_PREVIOUS_BINARY)(`current baseline state continues identically after upgrade: ${secs}s`,async()=>{
 const out:any[]=[];for(const upgraded of[false,true]){
  const h=await Harness.create({setSpan:true,binary:process.env.SPAN_REQUEST_PREVIOUS_BINARY}),t0=secs===1800n?1203n:1200n,t=await h.open({t0,loaded:true}),unsold=await h.ref(t0),until=(await s.findUntilPda(unsold.ticket))[0],resale=(await s.findResalePda(t.ticket))[0],bu=await h.fundToken(h.stranger,USDC,TOKEN,1000000000n),bs=await h.fundToken(h.stranger,h.spanMint,h.spanProgram,1000000n),bid=(await s.findBidPda(t.ticket,h.stranger.address))[0],bidUsdc=(await s.findBidUsdcPda(bid))[0],bidSpan=(await s.findBidSpanPda(bid))[0];
  await sendRequest(h,[h.openCandleIx(unsold),h.ix('openRunning',{...unsold,until,untilArg:t0+secs,premium:1000000n,strikeBps:0,sellerSource:h.sellerUsdc})],h.seller);
  await sendRequest(h,h.ix('listResale',{...t,resale,holder:h.buyer,ask:100000n,until:t0+secs}),h.buyer);
  await sendRequest(h,[h.ix('placeBid',{...t,bid,bidUsdc,bidder:h.stranger,bidderSource:bu,ask:100000n,cap:40000000n,until:t0+secs}),h.ix('bidSpan',{bid,bidSpan,bidder:h.stranger,spanSource:bs,amount:1000n,stepBps:5,marker:h.marker.address})],h.stranger);
  if(upgraded)h.svm.addProgramWithLoader(PROGRAM,readFileSync(new URL('../target/mainnet/span.so',import.meta.url)),LOADER);
  h.clock(t0);h.price(P0,t0);await h.send('read',h.readIx(t,0));h.clock(t0+60n);h.price(P0*101n/100n,t0+60n);await h.send('mark',h.markIx(t));
  await sendRequest(h,[h.ix('closeResale',{...t,resale,holder:h.buyer.address,closer:h.buyer}),h.ix('acceptBid',{...t,bid,bidUsdc,bidSpan,bidder:h.stranger.address,bidderUsdc:bu,holder:h.buyer,holderUsdc:h.buyerUsdc,holderSpan:h.buyerSpan,resale,feed:h.feed})],h.buyer);const transfer=h.events.find(e=>e.name==='BidAccepted')!.data;
  await sendRequest(h,[h.withdrawIx(unsold),h.ix('closeUntil',{...unsold,until,seller:h.seller.address,closer:h.marker})],h.marker);
  for(let j=1;j<=Number(secs/300n);j++){const ts=t0+BigInt(j)*300n;h.clock(ts);h.price(P0,ts);await h.send('read',h.readIx(t,j));}
  h.clock(s.settleAfter(h.candleState(t)));await h.send('settle',h.settleIx(t,{buyer:h.stranger.address,buyerUsdc:bu,buyerSpan:bs}));const final=h.events.find(e=>e.name==='Settled')!.data;
  out.push({transfer:Object.fromEntries(['recorded','paid','refund','spanReturned','spanLoaded','marks','burned'].map(k=>[k,(transfer as any)[k]])),final:Object.fromEntries(['payout','toSeller','spanReturned','marks','burned','reads'].map(k=>[k,(final as any)[k]])),balances:[h.sellerUsdc,h.buyerUsdc,bu,h.buyerSpan,bs].map(k=>token(h,k))});
  for(const key of[t.ticket,t.vault,t.spanHold,unsold.ticket,unsold.vault,until,resale,bid,bidUsdc,bidSpan])expect(h.svm.getAccount(key).exists).toBe(false);
 }expect(out[1]).toEqual(out[0]);evidence('previous-binary',{secs,...out[1]});
});
it('allows every supported SPAN step and rejects an unsold held ticket',async()=>{
 for(const spanProgram of[TOKEN,TOKEN_2022])for(const stepBps of[2,5,10,25]){const h=await Harness.create({setSpan:true,spanProgram}),r=await requestOrder(h,buyer(h));await sendRequest(h,[r.place(),r.span({stepBps})],h.buyer);expect(s.getRequestDecoder().decode(accountData(h.svm,r.request)).stepBps).toBe(stepBps);await sendRequest(h,r.close(),h.buyer);}
 const h=await Harness.create(),t=await h.open(),r=await requestOrder(h,buyer(h)),resale=(await s.findResalePda(t.ticket))[0];await sendRequest(h,r.place(),h.buyer);await sendRequest(h,h.ix('fillRequestHeld',{...t,...r,requestSpan:undefined,requester:h.buyer.address,requesterUsdc:h.buyerUsdc,holder:h.seller,holderUsdc:h.sellerUsdc,resale,feed:h.feed,spanMint:undefined,spanTokenProgram:undefined,spanHold:undefined,holderSpan:undefined}),h.seller,'NotSold');
});

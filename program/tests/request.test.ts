import {expect,it} from 'vitest';
import {Rent} from 'litesvm';
import {appendFileSync} from 'node:fs';
import {getTransferCheckedInstruction} from '@solana-program/token';
import {getTransferSolInstruction} from '@solana-program/system';
import {getAddressDecoder,getCompiledTransactionMessageDecoder,getTransactionEncoder,lamports,unwrapOption} from '@solana/kit';
import * as s from '../client/index.js';
import {TOKEN,TOKEN_2022,BTC_FEED,USDC} from '../client/constants.js';
import {accountData} from './harness.js';
import {requestFixture,sendRequest,native,token,requestBudget,P0,type RequestFixture} from './request-fixture.js';
const e=(x:RequestFixture)=>x.h.events.find(e=>e.name==='RequestFilled')!.data;
const record=(name:string,row:any)=>{const out=process.env.SPAN_REQUEST_EVIDENCE;if(out)appendFileSync(out,JSON.stringify({name,...row},(_,v)=>typeof v==='bigint'?v.toString():v)+'\n');};
async function openRequest(x:RequestFixture,span=false,extra:any={}){const sent=await sendRequest(x.h,[await x.place(x.actors[1],extra),...(span?[await x.requestSpan()]:[])],x.actors[1].signer);record('place',{withSpan:span,spanProgram:x.h.spanProgram,cu:Number(sent.meta.computeUnitsConsumed()),bytes:sent.bytes});return x.ref();}
async function finish(x:RequestFixture){for(let j=1;j<=s.lastReadOf(x.t.t0);j++)if(!x.h.candleState(x.t).reads[j].price){const ts=x.t.t0+BigInt(j)*300n;x.h.clock(ts);x.h.price(P0,ts);await x.h.send('read',x.h.readIx(x.t,j),x.h.marker);}x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('settle',x.settle(),x.h.marker);return x.h.events.find(e=>e.name==='Settled')!.data;}

for(const spanProgram of[TOKEN,TOKEN_2022])for(const mainnetRent of[false,true])for(const old of[false,true])for(const offered of[false,true])it(`balance sheet: ${spanProgram}, mainnet rent ${mainnetRent}, old holding ${old}, offered SPAN ${offered}`,async()=>{
 const x=await requestFixture({loaded:old,mainnetRent,spanProgram}),{h,t,actors}=x;if(old){h.price(P0*101n/100n,t.t0+60n);await h.send('old_mark',h.markIx(t));}const b=await openRequest(x,offered),before=h.ticketState(t),holder=actors[0],requester=actors[1],oldHoldRent=old?native(h,t.spanHold):0n,oldSpan=old?token(h,t.spanHold):0n,requestRent=native(h,b.request),usdcRent=native(h,b.requestUsdc),spanRent=offered?native(h,b.requestSpan):0n,minHold=offered?h.svm.minimumBalanceForRentExemption(BigInt(accountData(h.svm,b.requestSpan).length)):0n;
 const hu=token(h,holder.usdc),hs=token(h,holder.span),hn=native(h,holder.signer.address),bu=token(h,requester.usdc),bn=native(h,requester.signer.address),vault=token(h,t.vault),paid=s.bidPaid(h.candleState(t),before,100000n),sent=await sendRequest(h,await x.accept(),holder.signer),event=e(x),after=h.ticketState(t);
 expect(event).toEqual({ticket:t.ticket,id:t.id,t0:t.t0,request:b.request,kind:s.RequestKind.Held,minRoom:0n,price:0n,publishTs:0n,from:holder.signer.address,to:requester.signer.address,ask:100000n,cap:40000000n,recorded:paid-100000n,paid,refund:40000000n-paid,extra:0n,...s.highLow(h.candleState(t),before),tailHigh:before.tailHigh,tailLow:before.tailLow,reads:1,marks:before.marks,burned:before.burned,spanReturned:oldSpan,spanLoaded:offered?1000n:0n,stepBps:offered?5:0,marker:offered?h.marker.address:'11111111111111111111111111111111',slot:h.svm.getClock().slot});
 expect(token(h,holder.usdc)-hu).toBe(paid);expect(token(h,holder.span)-hs).toBe(oldSpan);expect(native(h,holder.signer.address)-hn+sent.fee).toBe(oldHoldRent);expect(token(h,requester.usdc)-bu).toBe(40000000n-paid);expect(native(h,requester.signer.address)-bn).toBe(requestRent+usdcRent+spanRent-minHold);expect(token(h,t.vault)).toBe(vault);expect(h.svm.getAccount(b.request).exists).toBe(false);expect(h.svm.getAccount(b.requestUsdc).exists).toBe(false);expect(h.svm.getAccount(b.requestSpan).exists).toBe(false);
 for(const key of['tailHigh','tailLow','marks','burned']as const)expect(after[key]).toBe(before[key]);expect(unwrapOption(after.buyer)).toBe(requester.signer.address);
 if(offered){const hold=h.svm.getAccount(t.spanHold);if(!hold.exists)throw Error();expect(hold.lamports).toBe(minHold);expect(hold.programAddress).toBe(h.spanProgram);expect(token(h,t.spanHold)).toBe(1000n);expect(getAddressDecoder().decode(hold.data.subarray(32,64))).toBe(t.ticket);expect(after.spanBump).toBe((await s.findSpanHoldPda(t.ticket))[1]);}else expect(after).toMatchObject({spanLoaded:0n,stepBps:0,spanBump:0,marker:'11111111111111111111111111111111'});
 record('balance-sheet',{spanProgram,mainnetRent,old,offered,paid,refund:event.refund,holderSolExFee:oldHoldRent,requesterSolRefund:requestRent+usdcRent+spanRent-minHold,minHold,cu:Number(sent.meta.computeUnitsConsumed()),bytes:sent.bytes});
 const settled=await finish(x);expect(settled.payout).toBeGreaterThanOrEqual(event.recorded);expect(settled.toSeller).toBe(vault-settled.payout);
});

it('place boundaries, opening and repeated place/close follow the escrow contract for both lengths',async()=>{
 for(const secs of[3600n,1800n]){const x=await requestFixture({secs,opening:false}),{h,t}=x,b=await x.ref();for(const [ask,cap,until]of[[99999n,100000n,t.t0+secs],[39000001n,40000000n,t.t0+secs],[100000n,99999n,t.t0+secs],[100000n,79000001n,t.t0+secs],[100000n,100000n,1000n],[100000n,100000n,t.t0+secs+1n]])await sendRequest(h,await x.place(x.actors[1],{ask,cap,until}),x.actors[1].signer,'InvalidValue');
  await sendRequest(h,await x.place(x.actors[0]),x.actors[0].signer);await sendRequest(h,await x.close(x.actors[0]),x.actors[0].signer);
  for(const[ask,cap]of[[100000n,100000n],[39000000n,79000000n]]){await sendRequest(h,await x.place(x.actors[1],{ask,cap}),x.actors[1].signer);expect(accountData(h.svm,b.request)).toHaveLength(127);expect(token(h,b.requestUsdc)).toBe(cap);await sendRequest(h,await x.place(),x.actors[1].signer,'');await sendRequest(h,await x.close(),x.actors[1].signer);}
 }

});

it('SPAN deposit checks ownership, amount, steps, duplicate load and runtime rent reserve',async()=>{
 const x=await requestFixture(),b=await openRequest(x),before=native(x.h,b.request);for(const stepBps of[0,1,3,26])await sendRequest(x.h,await x.requestSpan(undefined,{stepBps}),x.actors[1].signer,'StepNotAllowed');await sendRequest(x.h,await x.requestSpan(undefined,{amount:99n}),x.actors[1].signer,'InvalidValue');await sendRequest(x.h,await x.requestSpan(undefined,{requester:x.actors[2].signer,spanSource:x.actors[2].span}),x.actors[2].signer,'NotRequester');
 await sendRequest(x.h,await x.requestSpan(),x.actors[1].signer);expect(native(x.h,b.request)-before).toBe(x.h.svm.minimumBalanceForRentExemption(BigInt(accountData(x.h.svm,b.requestSpan).length)));await sendRequest(x.h,await x.requestSpan(),x.actors[1].signer,'AlreadyLoaded');
 const y=await requestFixture({setSpan:false});await openRequest(y);await sendRequest(y.h,await y.requestSpan(),y.actors[1].signer,'SpanNotSet');
});

it('accept rejects unauthorized, open resale, no opening, expiry, wrong feed, cap and insufficient price atomically',async()=>{
 const x=await requestFixture({opening:false}),b=await openRequest(x);await sendRequest(x.h,await x.accept(undefined,{holder:x.actors[2].signer,holderUsdc:x.actors[2].usdc}),x.actors[2].signer,'NotHolder');await sendRequest(x.h,await x.accept(),x.actors[0].signer,'NoOpen');
 x.h.clock(x.t.t0);x.h.price(P0,x.t.t0);await x.h.send('read',x.h.readIx(x.t,0));x.h.clock(x.t.t0+60n);await sendRequest(x.h,x.list(),x.actors[0].signer);await sendRequest(x.h,await x.accept(),x.actors[0].signer,'ResaleOpen');await sendRequest(x.h,x.h.ix('closeResale',{resale:x.resale,ticket:x.t.ticket,holder:x.actors[0].signer.address,closer:x.actors[0].signer}),x.actors[0].signer);
 await sendRequest(x.h,await x.accept(undefined,{feed:BTC_FEED}),x.actors[0].signer,'FeedNotConfig');x.h.clock(x.t.t0+3601n);await sendRequest(x.h,await x.accept(),x.actors[0].signer,'BuyClosed');
 const y=await requestFixture({loaded:true});y.h.price(P0*104n/100n,y.t.t0+60n);await y.h.send('cap_mark',y.h.markIx(y.t));await openRequest(y);await sendRequest(y.h,await y.accept(),y.actors[0].signer,'CapReached');
 const z=await requestFixture({loaded:true});z.h.price(P0*101n/100n,z.t.t0+60n);await z.h.send('mark',z.h.markIx(z.t));await openRequest(z,false,{cap:10099999n});await sendRequest(z.h,await z.accept(),z.actors[0].signer,'PriceAboveMax');
});

for(const spanProgram of[TOKEN,TOKEN_2022])it(`${spanProgram}: prefunded empty holding charges and reimburses only the missing rent`,async()=>{
 const x=await requestFixture({mainnetRent:true,spanProgram}),b=await openRequest(x,true),h=x.h,requester=x.actors[1],holder=x.actors[0],donation=777n;const currentRent=h.svm.getRent();h.svm.setRent(new Rent(1n,1,50));await sendRequest(h,getTransferSolInstruction({source:x.actors[2].signer,destination:x.t.spanHold,amount:lamports(donation)}),x.actors[2].signer);h.svm.setRent(currentRent);
 const hn=native(h,holder.signer.address),bn=native(h,requester.signer.address),requestLamports=native(h,b.request),escrows=native(h,b.requestUsdc)+native(h,b.requestSpan),rent=h.svm.minimumBalanceForRentExemption(BigInt(accountData(h.svm,b.requestSpan).length)),row=await sendRequest(h,await x.accept(),holder.signer);
 expect(native(h,holder.signer.address)-hn+row.fee).toBe(0n);expect(native(h,x.t.spanHold)).toBe(rent);expect(native(h,requester.signer.address)-bn).toBe(requestLamports+escrows-(rent-donation));expect(e(x).spanLoaded).toBe(1000n);record('prefunded',{spanProgram,donation,rent,actualReimbursed:rent-donation,cu:Number(row.meta.computeUnitsConsumed()),bytes:row.bytes});
});

for(const spanProgram of[TOKEN,TOKEN_2022])it(`${spanProgram}: old excess lamports return in full and external USDC and SPAN units cannot block acceptance`,async()=>{
 const x=await requestFixture({loaded:true,mainnetRent:true,spanProgram}),b=await openRequest(x,true),h=x.h,from=x.actors[2],requester=x.actors[1],holder=x.actors[0];
 await sendRequest(h,getTransferSolInstruction({source:from.signer,destination:x.t.spanHold,amount:lamports(12345n)}),from.signer);
 await sendRequest(h,[getTransferCheckedInstruction({source:from.usdc,mint:USDC,destination:b.requestUsdc,authority:from.signer,amount:1n,decimals:6}),getTransferCheckedInstruction({source:from.span,mint:h.spanMint,destination:b.requestSpan,authority:from.signer,amount:1n,decimals:accountData(h.svm,h.spanMint)[44]},{programAddress:spanProgram})],from.signer);
 const oldRent=native(h,x.t.spanHold),hn=native(h,holder.signer.address),bu=token(h,requester.usdc),minimum=h.svm.minimumBalanceForRentExemption(BigInt(accountData(h.svm,b.requestSpan).length)),row=await sendRequest(h,await x.accept(),holder.signer),event=e(x);
 expect(event.extra).toBe(1n);expect(event.refund).toBe(39900000n);expect(token(h,requester.usdc)-bu).toBe(event.refund+1n);expect(event.spanLoaded).toBe(1001n);expect(token(h,x.t.spanHold)).toBe(1001n);expect(native(h,holder.signer.address)-hn+row.fee).toBe(oldRent);expect(native(h,x.t.spanHold)).toBe(minimum);
 const bn=native(h,requester.signer.address);await finish(x);expect(native(h,requester.signer.address)-bn).toBe(minimum);record('extra-deposits',{spanProgram,oldRent,minimum,extra:event.extra,spanLoaded:event.spanLoaded});
});

it('closes the old resale atomically, revokes the old holder and records with the request reader',async()=>{
 const x=await requestFixture({loaded:true}),h=x.h,t=x.t,next=x.actors[1];await openRequest(x,true);await sendRequest(h,x.list(),x.actors[0].signer);const resaleRent=native(h,x.resale),oldHold=native(h,t.spanHold);
 await sendRequest(h,await x.accept(),x.actors[0].signer,'ResaleOpen');const hn=native(h,x.actors[0].signer.address),row=await sendRequest(h,[h.ix('closeResale',{resale:x.resale,ticket:t.ticket,holder:x.actors[0].signer.address,closer:x.actors[0].signer}),await x.accept()],x.actors[0].signer);expect(native(h,x.actors[0].signer.address)-hn+row.fee).toBe(resaleRent+oldHold);
 for(const ix of[h.ix('setMarker',{...t,buyer:x.actors[0].signer,marker:h.marker.address}),h.loadIx(t,{buyer:x.actors[0].signer,spanSource:x.actors[0].span}),h.ix('listResale',{...t,resale:x.resale,holder:x.actors[0].signer,ask:100000n,until:t.t0+3600n})])await sendRequest(h,ix,x.actors[0].signer,'NotBuyer');
 const newHolderNative=native(h,next.signer.address),oldHolderNative=native(h,x.actors[0].signer.address);await sendRequest(h,x.list(),next.signer);await sendRequest(h,h.ix('closeResale',{resale:x.resale,ticket:t.ticket,holder:next.signer.address,closer:next.signer}),next.signer);expect(native(h,x.actors[0].signer.address)).toBe(oldHolderNative);expect(native(h,next.signer.address)).toBeLessThan(newHolderNative);
 h.price(P0*101n/100n,t.t0+60n);await h.send('same_reader',h.markIx(t));expect(h.ticketState(t).marks).toBe(1);expect(h.ticketState(t).burned).toBe(100n);record('close-resale-accept',{cu:Number(row.meta.computeUnitsConsumed()),bytes:row.bytes});
 const y=await requestFixture({loaded:true});await openRequest(y,false);await sendRequest(y.h,await y.accept(),y.actors[0].signer);await sendRequest(y.h,y.h.markIx(y.t),y.h.marker,'NotLoaded');await sendRequest(y.h,y.h.loadIx(y.t,{buyer:y.actors[1].signer,spanSource:y.actors[1].span}),y.actors[1].signer);y.h.price(P0*101n/100n,y.t.t0+60n);await y.h.send('later_load_mark',y.h.markIx(y.t));
});

it('a changed reader fences the former reader and only the chosen reader can mark',async()=>{
 const x=await requestFixture({loaded:true}),h=x.h;await sendRequest(h,[await x.place(),await x.requestSpan(undefined,{marker:x.actors[2].signer.address})],x.actors[1].signer);await sendRequest(h,await x.accept(),x.actors[0].signer);h.price(P0*101n/100n,x.t.t0+60n);await sendRequest(h,h.markIx(x.t),h.marker,'NotMarker');await sendRequest(h,h.markIx(x.t,{marker:x.actors[2].signer}),x.actors[2].signer);expect(h.ticketState(x.t).marks).toBe(1);
});

for(const spanProgram of[TOKEN,TOKEN_2022])for(const mode of['cancel','expiry','settled','settle-and-close']as const)for(const withSpan of[false,true])it(`close ${mode}, SPAN ${withSpan}, ${spanProgram}: all balances, reserve and excess return`,async()=>{
 const x=await requestFixture({spanProgram}),h=x.h,a=x.actors[1],from=x.actors[2],b=await openRequest(x,withSpan,{until:x.t.t0+100n});
 await sendRequest(h,getTransferCheckedInstruction({source:from.usdc,mint:USDC,destination:b.requestUsdc,authority:from.signer,amount:1n,decimals:6}),from.signer);if(withSpan)await sendRequest(h,getTransferCheckedInstruction({source:from.span,mint:h.spanMint,destination:b.requestSpan,authority:from.signer,amount:1n,decimals:accountData(h.svm,h.spanMint)[44]},{programAddress:spanProgram}),from.signer);
 await sendRequest(h,await x.close(undefined,{closer:h.marker}),h.marker,'NotRequester');if(mode==='expiry'){h.clock(x.t.t0+100n);await sendRequest(h,await x.close(undefined,{closer:h.marker}),h.marker,'NotRequester');h.clock(x.t.t0+101n);}if(mode==='settled'||mode==='settle-and-close')h.clock(s.settleAfter(h.candleState(x.t)));if(mode==='settled')await h.send('settled',x.settle());
 const before={usdc:token(h,a.usdc),span:token(h,a.span),sol:native(h,a.signer.address)},rent=native(h,b.request)+native(h,b.requestUsdc)+(withSpan?native(h,b.requestSpan):0n),payer=mode==='cancel'?a.signer:h.marker,ix=await x.close(undefined,{closer:payer}),row=await sendRequest(h,mode==='settle-and-close'?[x.settle(),ix]:ix,payer),event=h.events.find(e=>e.name==='RequestClosed')!.data;
 expect(event).toEqual({request:b.request,requester:a.signer.address,closer:payer.address,usdc:40000001n,span:withSpan?1001n:0n});expect(token(h,a.usdc)-before.usdc).toBe(40000001n);expect(token(h,a.span)-before.span).toBe(withSpan?1001n:0n);expect(native(h,a.signer.address)-before.sol+(payer===a.signer?row.fee:0n)).toBe(rent);for(const key of[b.request,b.requestUsdc,b.requestSpan])expect(h.svm.getAccount(key).exists).toBe(false);record('close',{mode,withSpan,spanProgram,cu:Number(row.meta.computeUnitsConsumed()),bytes:row.bytes,rent});
});

it('failed reserve and wrong destinations leave a request completely recoverable',async()=>{
 const x=await requestFixture(),h=x.h,b=await openRequest(x,true),rent=h.svm.getRent();rent.lamportsPerByteYear=9000n;rent.exemptionThreshold=1;h.svm.setRent(rent);await sendRequest(h,await x.accept(),x.actors[0].signer,'InvalidValue');
 await sendRequest(h,await x.close(undefined,{requesterUsdc:x.actors[2].usdc}),x.actors[1].signer,'WrongOwner');await sendRequest(h,await x.close(undefined,{requesterSpan:x.actors[2].span}),x.actors[1].signer,'WrongOwner');await sendRequest(h,await x.close(),x.actors[1].signer);for(const key of[b.request,b.requestUsdc,b.requestSpan])expect(h.svm.getAccount(key).exists).toBe(false);
});

for(const secs of[3600n,1800n])it(`ReadPending matches buy_resale on the same ${secs}-second ticket and preserves unrecorded tails`,async()=>{
 const cases=[{name:'open-window',offset:300n,publish:300n,pending:true},{name:'read-before',offset:300n,publish:300n,pending:false,read:1},{name:'inclusive-age',offset:340n,publish:320n,pending:true},{name:'closed-window',offset:341n,publish:341n,pending:false},{name:'future',offset:60n,publish:300n,pending:true},{name:'stale',offset:360n,publish:300n,pending:false},{name:'age-plus-one',offset:341n,publish:320n,pending:false},{name:'last',offset:secs,publish:secs,pending:true},{name:'last-read-before',offset:secs,publish:secs,pending:false,read:Number(secs/300n)}];
 for(const c of cases){const x=await requestFixture({secs}),h=x.h;await openRequest(x);await sendRequest(h,x.list(),x.actors[0].signer);h.clock(x.t.t0+c.offset);h.price(P0*101n/100n,x.t.t0+c.publish);const beforeTicket=accountData(h.svm,x.t.ticket),beforeCandle=accountData(h.svm,x.t.candle);
  const simulated=async(ix:any)=>{const tx=await h.transaction([...requestBudget(),...(c.read!==undefined?[h.readIx(x.t,c.read)]:[]),ix],x.actors[1].signer),keys=getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts,result=h.svm.simulateTransaction(tx),meta=result.meta(),failed='err'in result;const events=failed?[]:s.decodeEvents(meta.innerInstructions().flat().map(ix=>({programAddress:keys[ix.instruction().programIdIndex()],data:ix.instruction().data()})));return{failed,logs:meta.logs().join('\n'),event:events.find(e=>e.name==='Resold'||e.name==='RequestFilled')?.data};};
  const resale=await simulated(x.buyResale(x.actors[1],{maxPay:40000000n}));await sendRequest(h,h.ix('closeResale',{resale:x.resale,ticket:x.t.ticket,holder:x.actors[0].signer.address,closer:x.actors[0].signer}),x.actors[0].signer);
  // The holder signs acceptance; the requester signs an ordinary resale.
  const acceptIx=await x.accept(),tx=await h.transaction([...requestBudget(),...(c.read!==undefined?[h.readIx(x.t,c.read)]:[]),acceptIx],x.actors[0].signer),keys=getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts,result=h.svm.simulateTransaction(tx),meta=result.meta(),failed='err'in result,events=failed?[]:s.decodeEvents(meta.innerInstructions().flat().map(ix=>({programAddress:keys[ix.instruction().programIdIndex()],data:ix.instruction().data()}))),accepted=events.find(e=>e.name==='RequestFilled')?.data;
  expect(resale.failed,c.name).toBe(c.pending);expect(failed,c.name).toBe(resale.failed);if(c.pending){expect(resale.logs).toContain('Error Code: ReadPending.');expect(meta.logs().join('\n')).toContain('Error Code: ReadPending.');}else{expect(accepted!.recorded).toBe((resale.event as any).recorded);expect(accepted!.recorded).toBe(c.read!==undefined?10000000n:0n);}
  expect(accountData(h.svm,x.t.ticket)).toEqual(beforeTicket);expect(accountData(h.svm,x.t.candle)).toEqual(beforeCandle);record('read-pending',{secs,case:c.name,rejected:failed,recorded:accepted?.recorded??null,cu:failed?null:Number(meta.computeUnitsConsumed()),bytes:failed?null:getTransactionEncoder().encode(tx).length});
 }
});

it('accepts an exact cap, rejects self acceptance after ownership changed and supports cancel plus replace',async()=>{
 const x=await requestFixture({loaded:true});x.h.price(P0*101n/100n,x.t.t0+60n);await x.h.send('mark',x.h.markIx(x.t));await openRequest(x,false,{cap:10099999n});await sendRequest(x.h,await x.accept(),x.actors[0].signer,'PriceAboveMax');await sendRequest(x.h,[await x.close(),await x.place(undefined,{cap:10100000n})],x.actors[1].signer);await sendRequest(x.h,await x.accept(),x.actors[0].signer);expect(e(x).paid).toBe(10100000n);expect(e(x).refund).toBe(0n);
 const y=await requestFixture();await openRequest(y);await sendRequest(y.h,y.list(),y.actors[0].signer);await sendRequest(y.h,y.buyResale(y.actors[1]),y.actors[1].signer);await sendRequest(y.h,await y.accept(),y.actors[1].signer,'InvalidValue');await sendRequest(y.h,await y.close(),y.actors[1].signer);
});

it('F >= every request/resale A and the seller equals a real no-transfer control across 64 deterministic paths',async()=>{
 const seed=0x1162026;let state=seed;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};let transfers=0,requests=0,resales=0;
 for(let path=0;path<64;path++){
  const secs=path%2?1800n:3600n,strikeBps=(rand()%21)*25,x=await requestFixture({loaded:true,opening:false,secs,strikeBps}),h=x.h,control=await h.open({t0:x.t.t0,loaded:true,premium:1000000n,strikeBps}),last=s.lastReadOf(x.t.t0),count=1+rand()%3,positions=new Set<number>();while(positions.size<count)positions.add(rand()%last);const recorded:bigint[]=[];
  for(let j=0;j<=last;j++){
   const ts=x.t.t0+BigInt(j)*300n;h.clock(ts);h.price(j?P0*BigInt(9900+rand()%201)/10000n:P0,ts);await h.send('property_read',h.readIx(x.t,j));
   if(j<last){const now=ts+60n,price=P0*BigInt(9900+rand()%201)/10000n;h.clock(now);h.price(price,now);const a=s.markAccepts(h.candleState(x.t),h.ticketState(x.t),price),b=s.markAccepts(h.candleState(control),h.ticketState(control),price);expect(a.accepted).toBe(b.accepted);if(a.accepted)await h.send('property_marks',[h.markIx(x.t),h.markIx(control)]);
    if(positions.has(j)){const current=x.holder(),next=x.actors[(x.actors.indexOf(current)+1)%3];if(rand()%2){await sendRequest(h,[await x.place(next,{cap:79000000n}),await x.requestSpan(next,{amount:100000n})],next.signer);await sendRequest(h,await x.accept(next),current.signer);recorded.push(e(x).recorded);requests++;}else{await sendRequest(h,x.list(),current.signer);await sendRequest(h,[x.buyResale(next),h.loadIx(x.t,{buyer:next.signer,spanSource:next.span})],next.signer);recorded.push(h.events.find(e=>e.name==='Resold')!.data.recorded);resales++;}transfers++;}
   }
  }
  h.clock(s.settleAfter(h.candleState(x.t)));await h.send('property_settle',x.settle());const final=h.events.find(e=>e.name==='Settled')!.data;await h.send('control_settle',h.settleIx(control));const expected=h.events.find(e=>e.name==='Settled')!.data;for(const a of recorded)expect(final.payout).toBeGreaterThanOrEqual(a);expect(final.payout).toBe(expected.payout);expect(final.toSeller).toBe(expected.toSeller);expect(final.burned).toBe(expected.burned);expect(final.marks).toBe(expected.marks);
 }
 record('property',{seed,paths:64,controlPaths:64,transfers,requests,resales});
},300000);


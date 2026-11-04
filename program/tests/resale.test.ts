import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {getAddressEncoder,getTransactionEncoder,unwrapOption,type Instruction} from '@solana/kit';
import {FailedTransactionMetadata} from 'litesvm';
import * as s from '../client/index.js';
import {TOKEN,TOKEN_2022,BTC_FEED,LOADER} from '../client/constants.js';
import {amount,accountData,PROGRAM,Harness} from './harness.js';
import {resaleFixture,RESALE_P0 as P0,type ResaleActor} from './resale-fixture.js';
type X=Awaited<ReturnType<typeof resaleFixture>>;
const sold=(x:X)=>x.h.events.find(e=>e.name==='Resold')!.data;
async function finish(x:X,prices=Array<bigint>(12).fill(P0)){
 for(let j=1;j<13;j++)if(!x.h.candleState(x.t).reads[j].price){const ts=x.t.t0+BigInt(j)*300n;x.h.clock(ts);x.h.price(prices[j-1],ts);await x.h.send('read',x.h.readIx(x.t,j));}
 x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('settle',x.settle());return x.h.events.find(e=>e.name==='Settled')!.data;
}
it('lists only a sold ticket for its buyer, validates ask and until, and updates a pre-opening offer',async()=>{
 const x=await resaleFixture({opening:false});await x.h.send('other',x.list(100000n,x.t.t0+3600n,x.actors[1]),x.h.marker,'NotBuyer');
 for(const ask of[99999n,39000001n])await x.h.send('ask',x.list(ask),x.h.marker,'InvalidValue');
 for(const until of[1000n,x.t.t0+3601n])await x.h.send('until',x.list(100000n,until),x.h.marker,'InvalidValue');
 await x.h.send('min',x.list(),x.h.marker);expect(accountData(x.h.svm,x.resale)).toHaveLength(89);const rent=x.h.svm.getAccount(x.resale);expect(rent.exists&&rent.lamports).toBe(x.h.svm.minimumBalanceForRentExemption(89n));
 await x.h.send('max',x.list(39000000n),x.h.marker);expect(s.getResaleDecoder().decode(accountData(x.h.svm,x.resale)).ask).toBe(39000000n);
 const h=await Harness.create(),t=await h.open(),resale=(await s.findResalePda(t.ticket))[0];await h.send('open_ticket',h.ix('listResale',{...t,resale,holder:h.seller,ask:100000n,until:t.t0+3600n}),h.marker,'NotSold');
});
it('rejects no opening, expiry, self purchase, stale holder, wrong feed, payment limit and cap atomically',async()=>{
 const x=await resaleFixture({opening:false});await x.h.send('list',x.list());await x.h.send('no_open',x.buy(),x.h.marker,'NoOpen');
 x.h.clock(x.t.t0);x.h.price(P0,x.t.t0);await x.h.send('read0',x.h.readIx(x.t,0));x.h.clock(x.t.t0+60n);x.h.price(P0,x.t.t0+60n);
 await x.h.send('self',x.buy(x.actors[0]),x.h.marker,'InvalidValue');await x.h.send('feed',x.buy(x.actors[1],{feed:BTC_FEED}),x.h.marker,'FeedNotConfig');
 await x.h.send('one_below',x.buy(x.actors[1],{maxPay:99999n}),x.h.marker,'PriceAboveMax');
 const offer=x.h.svm.getAccount(x.resale);if(!offer.exists)throw Error();const d=Buffer.from(offer.data);d.set(getAddressEncoder().encode(x.actors[2].signer.address),40);x.h.svm.setAccount({...offer,data:d});await x.h.send('holder',x.buy(x.actors[1],{holder:x.actors[2].signer.address,holderUsdc:x.actors[2].usdc}),x.h.marker,'NotHolder');x.h.svm.setAccount(offer);
 x.h.clock(x.t.t0+3601n);await x.h.send('expired',x.buy(),x.h.marker,'BuyClosed');
 x.h.clock(x.t.t0+60n);x.h.price(P0*104n/100n,x.t.t0+60n);const c=x.h.svm.getAccount(x.t.candle);if(!c.exists)throw Error();const data=Buffer.from(c.data),v=x.h.candleState(x.t);data.set(s.getCandleEncoder().encode({...v,readHigh:P0*104n/100n}));x.h.svm.setAccount({...c,data});await x.h.send('cap',x.buy(),x.h.marker,'CapReached');
});
for(const kind of ['window','future']as const)it(`ReadPending blocks the ${kind} observation; read then buy uses its updated A`,async()=>{
 const x=await resaleFixture();await x.h.send('list',x.list());const now=x.t.t0+(kind==='window'?300n:299n);x.h.clock(now);x.h.price(P0*101n/100n,x.t.t0+300n);
 expect(s.readPending(x.h.candleState(x.t),now,{price:P0*101n/100n,publishTs:x.t.t0+300n})).toBe(true);
 if(process.env.SPAN_RESALE_UNGUARDED==='1'){
  await x.h.send('unguarded_buy',x.buy(),x.h.marker);const entry=sold(x);x.h.clock(x.t.t0+300n);await x.h.send('read1',x.h.readIx(x.t,1));const result=await finish(x);
  console.log('RESALE_COUNTEREXAMPLE',JSON.stringify({kind,A:String(entry.recorded),q:String(entry.ask),F:String(result.payout),unburnedGain:String(result.payout-entry.recorded),burned:String(result.burned)}));expect(result.payout-entry.recorded).toBeLessThanOrEqual(entry.ask);return;
 }
 await x.h.send('pending',x.buy(),x.h.marker,'ReadPending');x.h.clock(x.t.t0+300n);await x.h.send('read_buy',[x.h.readIx(x.t,1),x.buy()],x.h.marker);expect(sold(x)).toMatchObject({recorded:10000000n,paid:10100000n,reads:3});
});
it('releases a closed vacant window and expired observations, while protecting the final vacant slot',async()=>{
 const x=await resaleFixture();await x.h.send('list',x.list());x.h.clock(x.t.t0+341n);x.h.price(P0*101n/100n,x.t.t0+300n);expect(s.readPending(x.h.candleState(x.t),x.t.t0+341n,{price:P0,publishTs:x.t.t0+300n})).toBe(false);await x.h.send('expired_observation',x.buy(),x.h.marker);expect(sold(x).recorded).toBe(0n);
 const y=await resaleFixture();await y.h.send('list',y.list());for(const now of[y.t.t0+3599n,y.t.t0+3600n]){y.h.clock(now);y.h.price(P0*101n/100n,y.t.t0+3600n);await y.h.send('final_pending',y.buy(),y.h.marker,'ReadPending');}
 await y.h.send('last_read_buy',[y.h.readIx(y.t,12),y.buy()],y.h.marker);expect(sold(y).reads).toBe(4097);
});
for(const spanProgram of[TOKEN,TOKEN_2022])it(`${spanProgram}: returns all SPAN and both rents, preserves the vault, tails and cumulative marks`,async()=>{
 const x=await resaleFixture({loaded:true,spanProgram});x.h.price(P0*101n/100n,x.t.t0+60n);await x.h.send('mark',x.h.markIx(x.t),x.h.marker);await x.h.send('list',x.list());const before=x.h.ticketState(x.t),vault=amount(x.h.svm,x.t.vault),usdc=amount(x.h.svm,x.actors[0].usdc),span=amount(x.h.svm,x.actors[0].span),hold=amount(x.h.svm,x.t.spanHold);
 x.h.price(P0*103n/100n,x.t.t0+60n);await x.h.send('resold',x.buy(x.actors[1],{maxPay:10100000n}),x.actors[1].signer);const event=sold(x);
 expect(event.recorded).toBe(s.resaleRecorded(x.h.candleState(x.t),before));expect(event.recorded).toBe(10000000n);expect(amount(x.h.svm,x.t.vault)).toBe(vault);expect(amount(x.h.svm,x.actors[0].usdc)-usdc).toBe(10100000n);expect(amount(x.h.svm,x.actors[0].span)-span).toBe(hold);expect(x.h.svm.getAccount(x.t.spanHold).exists).toBe(false);
 expect(x.h.ticketState(x.t)).toMatchObject({spanLoaded:0n,marker:'11111111111111111111111111111111',marks:before.marks,burned:before.burned,tailHigh:before.tailHigh,tailLow:before.tailLow});
 await x.h.send('old_marker',x.h.markIx(x.t),x.h.marker,'NotLoaded');await x.h.send('old_set',x.h.ix('setMarker',{...x.t,buyer:x.actors[0].signer,marker:x.h.marker.address}),x.h.marker,'NotBuyer');await x.h.send('old_load',x.load(x.actors[0]),x.h.marker,'NotBuyer');await x.h.send('old_list',x.list(100000n,x.t.t0+3600n,x.actors[0]),x.h.marker,'NotBuyer');
 await x.h.send('new_load',x.load(),x.h.marker);x.h.price(P0*102n/100n,x.t.t0+60n);await x.h.send('new_mark',x.h.markIx(x.t),x.h.marker);await x.h.send('new_offer',x.list(),x.h.marker);expect(x.h.ticketState(x.t).marks).toBe(2);const result=await finish(x);expect(result.payout).toBeGreaterThanOrEqual(event.recorded);expect(result.toSeller).toBe(vault-result.payout);
 await x.h.send('cleanup',x.h.ix('closeResale',{resale:x.resale,ticket:x.t.ticket,holder:x.actors[1].signer.address,closer:x.h.marker}),x.h.marker);
});
it('closes a zero-balance holding, needs no destination for zero, and accepts an unloaded ticket without SPAN accounts',async()=>{
 const x=await resaleFixture();await x.h.send('small_load',x.load(x.actors[0],{amount:100n}),x.h.marker);x.h.price(P0*101n/100n,x.t.t0+60n);await x.h.send('last_burn',x.h.markIx(x.t),x.h.marker);expect(amount(x.h.svm,x.t.spanHold)).toBe(0n);await x.h.send('list',x.list());await x.h.send('zero',x.buy(x.actors[1],{holderSpan:undefined}),x.h.marker);expect(sold(x).spanReturned).toBe(0n);expect(x.h.svm.getAccount(x.t.spanHold).exists).toBe(false);
 const y=await resaleFixture();await y.h.send('list',y.list());await y.h.send('none',y.buy(),y.h.marker);expect(sold(y).spanReturned).toBe(0n);
});
it('rolls back payment and ownership when SPAN accounts or their destination are missing or invalid',async()=>{
 const x=await resaleFixture({loaded:true});await x.h.send('list',x.list());for(const field of['spanMint','spanHold','spanTokenProgram','holderSpan'])await x.h.send('missing_'+field,x.buy(x.actors[1],{[field]:undefined}),x.h.marker,'MissingAccount');
 await x.h.send('wrong_span_owner',x.buy(x.actors[1],{holderSpan:x.actors[1].span}),x.h.marker,'WrongOwner');await x.h.send('wrong_usdc',x.buy(x.actors[1],{holderUsdc:x.actors[1].usdc}),x.h.marker,'WrongOwner');
 const raw=x.h.svm.getAccount(x.actors[0].span);if(!raw.exists)throw Error();const d=Buffer.from(raw.data);d[108]=2;x.h.svm.setAccount({...raw,data:d});await x.h.send('frozen_destination',x.buy(),x.h.marker,'');
});
it('closes a live offer only for its holder, and permissionlessly after settlement in the same transaction',async()=>{
 const x=await resaleFixture();await x.h.send('list',x.list());await x.h.send('not_holder',x.close(),x.h.marker,'NotHolder');await x.h.send('holder_close',x.close(x.actors[0].signer),x.h.marker);expect(x.h.svm.getAccount(x.resale).exists).toBe(false);
 await x.h.send('relist',x.list());x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('settle_close',[x.settle(),x.close()],x.h.marker);expect(x.h.svm.getAccount(x.resale).exists).toBe(false);
});
it('two transfers preserve a running-entry vault and give the final holder the same settlement as the control',async()=>{
 const x=await resaleFixture({running:true,loaded:true}),control=await resaleFixture({running:true,loaded:true});
 for(const to of[x.actors[1],x.actors[2]]){await x.h.send('list',x.list());await x.h.send('transfer',x.buy(to),x.h.marker);expect(sold(x).recorded).toBe(10000000n);}
 const a=await finish(x),b=await finish(control);expect(a.toSeller).toBe(b.toSeller);expect(a.payout).toBe(b.payout);expect(unwrapOption(a.buyer)).toBe(x.actors[2].signer.address);expect(a.toSeller).toBe(40000000n);
});
it('F >= every resale A and seller matches an actual no-resale control over 64 seeded paths',async()=>{
 const seed=0x1142026;let state=seed;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
 for(let path=0;path<64;path++){
  const x=await resaleFixture({loaded:true}),control=await resaleFixture({loaded:true}),count=1+rand()%3,slots=new Set<number>();while(slots.size<count)slots.add(rand()%12);const entries:bigint[]=[];
  for(let j=0;j<13;j++){
   const ts=x.t.t0+BigInt(j)*300n,readPrice=P0*BigInt(9925+rand()%151)/10000n;
   for(const y of[x,control])if(j){y.h.clock(ts);y.h.price(readPrice,ts);await y.h.send('path_read',y.h.readIx(y.t,j));}
   const price=P0*BigInt(9900+rand()%201)/10000n;for(const y of j<12?[x,control]:[]){y.h.clock(ts+60n);y.h.price(price,ts+60n);const t=y.h.ticketState(y.t);if(s.markAccepts(y.h.candleState(y.t),t,price).accepted)await y.h.send('path_mark',y.h.markIx(y.t),y.h.marker);}
   if(slots.has(j)){const to=x.actors[(x.actors.indexOf(x.holder())+1)%3];await x.h.send('path_list',x.list());await x.h.send('path_buy',x.buy(to),x.h.marker);entries.push(sold(x).recorded);await x.h.send('path_reload',x.load(),x.h.marker);}
  }
  const end=s.settleAfter(x.h.candleState(x.t));x.h.clock(end);control.h.clock(end);await x.h.send('path_settle',x.settle());const a=x.h.events.find(e=>e.name==='Settled')!.data;await control.h.send('control_settle',control.settle());const b=control.h.events.find(e=>e.name==='Settled')!.data;
  expect(entries.every(v=>a.payout>=v),`seed=${seed} path=${path}`).toBe(true);expect(a.toSeller).toBe(b.toSeller);expect(a.payout).toBe(b.payout);expect(amount(x.h.svm,x.t.vault)).toBe(0n);
 }
 console.log('RESALE_PROPERTY',JSON.stringify({seed,paths:64,controlPaths:64,readsPerPath:13,resalesPerPath:'1-3'}));
},240000);
it('measures wallet-shaped transactions, including close and recreate in a single transaction',async()=>{
 const rows:any[]=[];const budget=()=>{const programAddress='ComputeBudget111111111111111111111111111111' as any,a=Buffer.alloc(5),b=Buffer.alloc(9);a[0]=2;a.writeUInt32LE(400000,1);b[0]=3;b.writeBigUInt64LE(10000n,1);return[{programAddress,data:a},{programAddress,data:b}];};
 for(const spanProgram of[TOKEN,TOKEN_2022])for(const loaded of[false,true]){
  const x=await resaleFixture({loaded,spanProgram});const measure=async(kind:string,ixs:Instruction[],payer:ResaleActor)=>{const all=[...budget(),...ixs],tx=await x.h.transaction(all,payer.signer),bytes=getTransactionEncoder().encode(tx).length,meta=await x.h.send(kind,all,payer.signer);rows.push({kind,tokenProgram:spanProgram,loaded,cu:Number(meta.computeUnitsConsumed()),bytes});};
  await measure('list_resale',[x.list()],x.actors[0]);if(loaded){const alone=[...budget(),x.buy()],txAlone=await x.h.transaction(alone,x.actors[1].signer),simAlone=x.h.svm.simulateTransaction(txAlone);if(simAlone instanceof FailedTransactionMetadata)throw Error(simAlone.meta().logs().join('\n'));rows.push({kind:'buy_resale',tokenProgram:spanProgram,loaded,cu:Number(simAlone.meta().computeUnitsConsumed()),bytes:getTransactionEncoder().encode(txAlone).length});const all=[...budget(),x.buy(),x.load(x.actors[1])],tx=await x.h.transaction(all,x.actors[1].signer),bytes=getTransactionEncoder().encode(tx).length,meta=x.h.svm.simulateTransaction(tx);const works=!(meta instanceof FailedTransactionMetadata);rows.push({kind:'buy_resale_load_span',tokenProgram:spanProgram,loaded,success:works,bytes,cu:Number(works?meta.meta().computeUnitsConsumed():meta.meta().computeUnitsConsumed()),error:works?null:meta.meta().logs().filter(s=>s.includes('Error')||s.includes('already in use'))});if(works){await measure('buy_resale_load_span',[x.buy(),x.load(x.actors[1])],x.actors[1]);}else await measure('buy_resale',[x.buy()],x.actors[1]);}
  else await measure('buy_resale',[x.buy()],x.actors[1]);
  await measure('relist',[x.list()],x.actors[1]);await measure('close_resale',[x.close(x.actors[1].signer)],x.actors[1]);
  await measure('list_again',[x.list()],x.actors[1]);x.h.clock(x.t.t0+300n);x.h.price(P0*101n/100n,x.t.t0+300n);await measure('read_buy_resale',[x.h.readIx(x.t,1),x.buy(x.actors[2])],x.actors[2]);
 }
 console.log('RESALE_CU',JSON.stringify(rows));if(process.env.SPAN_RESALE_CU_OUT)writeFileSync(process.env.SPAN_RESALE_CU_OUT,JSON.stringify(rows,null,2)+'\n');
});
it.skipIf(!process.env.SPAN_PREVIOUS_BINARY)('preserves 1.13.0 sold and Until states through read, mark, settle, withdraw and close_until',async()=>{
 const x=await resaleFixture({loaded:true,binary:process.env.SPAN_PREVIOUS_BINARY}),y=await resaleFixture({loaded:true,binary:process.env.SPAN_PREVIOUS_BINARY});
 x.h.svm.addProgramWithLoader(PROGRAM,readFileSync(new URL('../target/mainnet/span.so',import.meta.url)),LOADER);
 for(const v of[x,y]){v.h.price(P0*101n/100n,v.t.t0+60n);await v.h.send('continued_mark',v.h.markIx(v.t),v.h.marker);}
 const a=await finish(x),b=await finish(y);for(const k of['payout','toSeller','marks','burned','spanReturned','reads'] as const)expect(a[k]).toBe(b[k]);
 for(const upgraded of[false,true]){const h=await Harness.create({binary:process.env.SPAN_PREVIOUS_BINARY}),t=await h.ref(),until=(await s.findUntilPda(t.ticket))[0];await h.send('running',[h.openCandleIx(t),h.ix('openRunning',{...t,until,untilArg:t.t0+3600n,premium:1000000n,strikeBps:0,sellerSource:h.sellerUsdc})],h.seller);if(upgraded)h.svm.addProgramWithLoader(PROGRAM,readFileSync(new URL('../target/mainnet/span.so',import.meta.url)),LOADER);await h.send('withdraw_close',[h.withdrawIx(t),h.ix('closeUntil',{until,ticket:t.ticket,seller:h.seller.address,closer:h.marker})],h.marker);expect(h.svm.getAccount(until).exists).toBe(false);}
});

import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {Harness,accountData,amount,PROGRAM} from './harness.js';
import * as s from '../client/index.js';
import {SOL_FEED,BTC_FEED,ETH_FEED,DOVES,LOADER,TOKEN,TOKEN_2022} from '../client/constants.js';
import {getAddressEncoder,getTransactionEncoder,lamports,type Address} from '@solana/kit';
const P0=10000000000n;
async function fixture(o:{until?:bigint;premium?:bigint;strikeBps?:number;asset?:0|1|2;binary?:string;open?:boolean;spanProgram?:Address}={}){
 const h=await Harness.create({setSpan:true,asset:o.asset,spanProgram:o.spanProgram,binary:o.binary??process.env.SPAN_RUNNING_BINARY}),t=await h.ref(),until=(await s.findUntilPda(t.ticket))[0];
 await h.send('candle',h.openCandleIx(t));
 const open=(extra:any={})=>h.ix('openRunning',{...t,until,untilArg:o.until??t.t0+3600n,premium:o.premium??1000000n,strikeBps:o.strikeBps??0,sellerSource:h.sellerUsdc,...extra});
 const buy=(maxPay=40000000n,extra:any={})=>h.ix('buyRunning',{...t,until,feed:h.feed,buyerSource:h.buyerUsdc,maxPay,...extra});
 const close=(closer=h.stranger,extra:any={})=>h.ix('closeUntil',{until,ticket:t.ticket,seller:h.seller.address,closer,...extra});
 const openMeta=o.open===false?undefined:await h.send('running_open',open(),h.seller);return{h,t,until,open,buy,close,openMeta};
}
async function opening(x:Awaited<ReturnType<typeof fixture>>){x.h.clock(x.t.t0);x.h.price(P0,x.t.t0);await x.h.send('read0',x.h.readIx(x.t,0));}
async function finish(x:Awaited<ReturnType<typeof fixture>>,prices:bigint[]=Array(12).fill(P0)){
 for(let j=1;j<13;j++){const ts=x.t.t0+BigInt(j)*300n;x.h.clock(ts);x.h.price(prices[j-1],ts);await x.h.send('read',x.h.readIx(x.t,j));}
 x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('settle',x.h.settleIx(x.t));return x.h.events.find(e=>e.name==='Settled')!.data;
}
it('preserves the bought extension when the price returns and no mark follows: F >= A',async()=>{
 const x=await fixture();await opening(x);x.h.clock(x.t.t0+30n);x.h.price(P0*101n/100n,x.t.t0+30n);await x.h.send('running_buy',x.buy());
 const entry=x.h.events.find(e=>e.name==='BoughtRunning')!.data;const e=await finish(x);
 console.log('RUNNING_TAIL_FLOOR',JSON.stringify({price:String(entry.price),A:String(entry.recorded),F:String(e.payout),marks:e.marks}));
 expect(e.payout).toBeGreaterThanOrEqual(entry.recorded);expect(e.toSeller).toBe(40000000n+entry.recorded-e.payout);expect(e.marks).toBe(0);expect(e.burned).toBe(0n);
});
for(const asset of [0,1,2] as const)for(const delta of [-100n,0n,100n])it(`asset ${asset}, price move ${delta}: charges A+q and preserves the computed range without a burn`,async()=>{
 const x=await fixture({asset}),{h,t}=x;await opening(x);h.clock(t.t0+30n);const price=P0*(10000n+delta)/10000n;h.price(price,t.t0+30n);
 const quote=s.runningPrice(h.candleState(t),h.ticketState(t),price),before=amount(h.svm,h.buyerUsdc),sold=amount(h.svm,h.sellerUsdc);
 await h.send('one_below',x.buy(quote.recorded+1000000n-1n),h.buyer,'PriceAboveMax');await h.send('exact',x.buy(quote.recorded+1000000n),h.buyer);
 const entry=h.events.find(e=>e.name==='BoughtRunning')!.data;expect(entry.recorded).toBe(quote.recorded);expect(entry.paid).toBe(quote.recorded+1000000n);
 expect(h.ticketState(t)).toMatchObject({tailHigh:quote.tailHigh,tailLow:quote.tailLow,marks:0,burned:0n});expect(before-amount(h.svm,h.buyerUsdc)).toBe(entry.paid);expect(amount(h.svm,t.vault)).toBe(40000000n+entry.recorded);
 const receipt=await finish(x);expect(receipt.payout).toBeGreaterThanOrEqual(entry.recorded);expect(receipt.toSeller).toBe(40000000n+entry.recorded-receipt.payout);expect(amount(h.svm,t.vault)).toBe(0n);expect(amount(h.svm,h.sellerUsdc)-sold).toBe(receipt.toSeller);
});
it('rejects missing opening, expiry, cap, wrong feed, stale and outside publications atomically',async()=>{
 const x=await fixture({until:1300n});
 for(const now of [1199n,1201n]){x.h.clock(now);x.h.price(P0,now);await x.h.send('no_open',x.buy(),x.h.buyer,'NoOpen');}
 await opening(x);x.h.clock(1230n);
 await x.h.send('wrong_feed',x.buy(40000000n,{feed:BTC_FEED}),x.h.buyer,'FeedNotConfig');
 x.h.price(P0,1200n);await x.h.send('stale',x.buy(),x.h.buyer,'FeedStale');
 x.h.clock(1200n);x.h.price(P0,1200n);await x.h.send('at_start',x.buy(),x.h.buyer,'OutsideCandle');
 x.h.clock(1230n);x.h.price(P0,4801n);await x.h.send('after_end_publication',x.buy(),x.h.buyer,'OutsideCandle');
 x.h.price(P0*104n/100n,1230n);await x.h.send('cap',x.buy(100000000n),x.h.buyer,'CapReached');
 x.h.clock(1301n);x.h.price(P0,1301n);await x.h.send('expired',x.buy(),x.h.buyer,'BuyClosed');
 x.h.clock(1300n);x.h.price(P0,1300n);await x.h.send('until_equal',x.buy(),x.h.buyer);await x.h.send('sold',x.buy(),x.h.buyer,'NotOpen');
});
it('checks open_running cutoff bounds, id and now<until without changing existing ticket creation',async()=>{
 const x=await fixture({open:false});
 for(const untilArg of [1194n,1195n,4801n])await x.h.send('bad_until',x.open({untilArg}),x.h.seller,'InvalidValue');
 const wrong=await x.h.ref(x.t.t0,x.t.id+1n);await x.h.send('id',x.open({...wrong,until:(await s.findUntilPda(wrong.ticket))[0]}),x.h.seller,'IdMismatch');
 for(const now of [4800n,4801n]){x.h.clock(now);await x.h.send('open_expired',x.open(),x.h.seller,'BuyClosed');}
 x.h.clock(1196n);await x.h.send('lower_bound_plus_one',x.open({untilArg:1196n}),x.h.seller,'BuyClosed');
 x.h.clock(1195n);await x.h.send('open_before_until',x.open({untilArg:1196n}),x.h.seller);expect(accountData(x.h.svm,x.until)).toHaveLength(81);
});
it('leaves ordinary tickets closed at the old cutoff and requires an Until for buy_running',async()=>{
 const h=await Harness.create(),t=await h.open(),until=(await s.findUntilPda(t.ticket))[0];h.clock(t.t0-5n);await h.send('old_cutoff',h.buyIx(t),h.buyer,'BuyClosed');
 h.clock(t.t0+1n);await h.send('no_until',h.ix('buyRunning',{...t,until,buyerSource:h.buyerUsdc,maxPay:40000000n}),h.buyer,'');
});
it('does not pay again for the same P through a mark or later reading',async()=>{
 const x=await fixture();await opening(x);x.h.clock(1230n);const price=P0*101n/100n;x.h.price(price,1230n);await x.h.send('buy_load',[x.buy(),x.h.loadIx(x.t)],x.h.buyer);
 await x.h.send('same_mark',x.h.markIx(x.t),x.h.marker,'NotExtension');
 x.h.clock(1500n);x.h.price(price,1500n);await x.h.send('same_read',x.h.readIx(x.t,1));expect(s.payout(x.h.candleState(x.t),x.h.ticketState(x.t))).toBe(10000000n);
 x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('settle',x.h.settleIx(x.t));expect(x.h.events.find(e=>e.name==='Settled')!.data.payout).toBe(10000000n);
});
it('pays F=40 after a positive entry and the seller keeps exactly A',async()=>{
 const x=await fixture();await opening(x);x.h.clock(1230n);x.h.price(P0*101n/100n,1230n);await x.h.send('entry',x.buy());const e=await finish(x,[P0*105n/100n,...Array(11).fill(P0)]);
 expect(e.payout).toBe(40000000n);expect(e.toSeller).toBe(10000000n);expect(e.toBuyer).toBe(40000000n);
});
it('returns 40-q Unsold and refunds q on a pre-cutoff legacy buy followed by Void',async()=>{
 const x=await fixture();x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('unsold',x.h.settleIx(x.t));expect(x.h.events.find(e=>e.name==='Settled')!.data).toMatchObject({outcome:s.Outcome.Unsold,toSeller:39000000n,toBuyer:0n});
 const y=await fixture();await y.h.send('legacy_buy',y.h.buyIx(y.t),y.h.buyer);y.h.clock(s.settleAfter(y.h.candleState(y.t)));await y.h.send('void',y.h.settleIx(y.t));expect(y.h.events.find(e=>e.name==='Settled')!.data).toMatchObject({outcome:s.Outcome.Void,toBuyer:1000000n,toSeller:39000000n});
});
it('only the seller closes a live Until, refunds that seller, and closes access to buy_running',async()=>{
 const x=await fixture();await x.h.send('not_seller',x.close(),x.h.stranger,'NotSeller');const before=x.h.svm.getAccount(x.h.seller.address),u=x.h.svm.getAccount(x.until);if(!before.exists||!u.exists)throw Error();
 await x.h.send('seller_closes',x.close(x.h.seller),x.h.stranger);const after=x.h.svm.getAccount(x.h.seller.address);if(!after.exists)throw Error();expect(after.lamports-before.lamports).toBe(u.lamports);await opening(x);x.h.clock(1230n);x.h.price(P0,1230n);await x.h.send('closed_until',x.buy(),x.h.buyer,'');
});
it('allows anyone to clean up after withdraw or settlement, including the same transaction',async()=>{
 const x=await fixture();await x.h.send('withdraw_close',[x.h.withdrawIx(x.t),x.close()],x.h.stranger);expect(x.h.svm.getAccount(x.until).exists).toBe(false);
 const y=await fixture();await opening(y);y.h.clock(1230n);y.h.price(P0,1230n);await y.h.send('entry',y.buy());y.h.clock(s.settleAfter(y.h.candleState(y.t)));await y.h.send('settle_close',[y.h.settleIx(y.t),y.close()],y.h.stranger);expect(y.h.svm.getAccount(y.until).exists).toBe(false);
 const z=await fixture();await z.h.send('withdraw',z.h.withdrawIx(z.t),z.h.seller);await z.h.send('late_cleanup',z.close(),z.h.stranger);expect(z.h.svm.getAccount(z.until).exists).toBe(false);
});
it('continues public marks above the bought tail after an atomic buy_running plus load_span and measures CU and size',async()=>{
 const measurements:any[]=[];
 for(const spanProgram of [TOKEN,TOKEN_2022]){const x=await fixture({spanProgram});await opening(x);x.h.clock(1230n);x.h.price(P0*101n/100n,1230n);
  const ixs=[x.buy(),x.h.loadIx(x.t)],tx=await x.h.transaction(ixs,x.h.buyer),bytes=getTransactionEncoder().encode(tx).length;
  const meta=await x.h.send('running_buy_load',ixs,x.h.buyer);x.h.clock(1240n);x.h.price(P0*102n/100n,1240n);await x.h.send('public_mark',x.h.markIx(x.t),x.h.marker);expect(x.h.ticketState(x.t).marks).toBe(1);expect(s.payout(x.h.candleState(x.t),x.h.ticketState(x.t))).toBe(20000000n);
  x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('settle',x.h.settleIx(x.t));const close=await x.h.send('close',x.close(),x.h.stranger);
  const y=await fixture({spanProgram});await opening(y);y.h.clock(1230n);y.h.price(P0,1230n);const buy=await y.h.send('running_buy',y.buy(),y.h.buyer);
  measurements.push({tokenProgram:spanProgram,open:Number(x.openMeta!.computeUnitsConsumed()),buy:Number(buy.computeUnitsConsumed()),close:Number(close.computeUnitsConsumed()),buyLoad:Number(meta.computeUnitsConsumed()),bytes});
 }
 console.log('RUNNING_CU',JSON.stringify(measurements));if(process.env.SPAN_RUNNING_CU_OUT)writeFileSync(process.env.SPAN_RUNNING_CU_OUT,JSON.stringify(measurements,null,2)+'\n');
});
it('F >= A over 128 deterministic random paths of thirteen reads and later marks',async()=>{
 const seed=0x1132026;let state=seed;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
 for(let path=0;path<128;path++){
  const x=await fixture({strikeBps:(rand()%21)*25});await opening(x);const buyJ=rand()%12,entryOffset=BigInt(buyJ)*300n+30n;let entry:any;
  for(let j=0;j<13;j++){
   if(j){const ts=x.t.t0+BigInt(j)*300n;x.h.clock(ts);x.h.price(P0*BigInt(9850+rand()%301)/10000n,ts);await x.h.send('property_read',x.h.readIx(x.t,j));}
   if(j===buyJ){x.h.clock(x.t.t0+entryOffset);x.h.price(P0*BigInt(9850+rand()%301)/10000n,x.t.t0+entryOffset);await x.h.send('property_entry',[x.buy(),x.h.loadIx(x.t)],x.h.buyer);entry=x.h.events.find(e=>e.name==='BoughtRunning')!.data;}
   if(entry&&j<12){const ts=x.t.t0+BigInt(j)*300n+60n,price=P0*BigInt(9800+rand()%401)/10000n;x.h.clock(ts);x.h.price(price,ts);if(s.markAccepts(x.h.candleState(x.t),x.h.ticketState(x.t),price).accepted)await x.h.send('property_mark',x.h.markIx(x.t),x.h.marker);}
  }
  x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.h.send('property_settle',x.h.settleIx(x.t));const e=x.h.events.find(e=>e.name==='Settled')!.data;
  expect(e.payout,`seed=${seed} path=${path}`).toBeGreaterThanOrEqual(entry.recorded);expect(e.toSeller).toBe(40000000n+entry.recorded-e.payout);expect(e.toSeller).toBeGreaterThanOrEqual(entry.recorded);expect(amount(x.h.svm,x.t.vault)).toBe(0n);
 }
 console.log('RUNNING_PROPERTY',JSON.stringify({seed,paths:128,readsPerPath:13}));
},120000);

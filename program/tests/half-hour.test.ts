import {expect,it} from 'vitest';
import {getAddressEncoder,unwrapOption} from '@solana/kit';
import {Harness,accountData,amount} from './harness.js';
import * as s from '../client/index.js';
import {SOL_FEED,BTC_FEED,ETH_FEED,TOKEN,USDC} from '../client/constants.js';

const P0=10000000000n;
async function fixture(asset:0|1|2=0,secs=1800n){
 const h=await Harness.create({setSpan:true,asset}),t=await h.open({t0:1200n+BigInt(asset)+(secs===1800n?3n:0n),loaded:true});
 h.clock(t.t0);h.price(P0,t.t0);await h.send('opening',h.readIx(t,0));return{h,t,end:t.t0+secs};
}

it('maps both lengths and all assets without changing the old starts',()=>{
 for(const a of [0,1,2]as const){const hour=s.startOf(1260n,a),half=s.halfStartOf(1260n,a);expect(hour).toBe(1200n+BigInt(a));expect(half).toBe(hour+3n);expect(s.assetOf(half)).toBe(a);expect(s.secsOf(hour)).toBe(3600n);expect(s.secsOf(half)).toBe(1800n);expect(s.lastReadOf(half)).toBe(6);expect(s.boundary(half,6)).toBe(half+1800n);expect(()=>s.boundary(half,7)).toThrow('InvalidValue');}
 for(const t0 of [1206n,1259n])expect(()=>s.assetOf(t0)).toThrow();
});

for(const asset of [0,1,2]as const)it(`asset ${asset}: seven readings, inclusive closing publication window and bounded payout`,async()=>{
 const{h,t,end}=await fixture(asset);
 for(let j=1;j<6;j++){const ts=t.t0+BigInt(j)*300n;h.clock(ts);h.price(P0,ts);await h.send('read',h.readIx(t,j));}
 h.clock(end+21n);h.price(P0*102n/100n,end+21n);await h.send('closing_window_plus_one',h.readIx(t,6),h.stranger,'OutsideWindow');
 h.clock(end+20n);h.price(P0*101n/100n,end+20n);await h.send('closing_window_inclusive',h.readIx(t,6));await h.send('seventh_slot_rejected',h.readIx(t,7),h.stranger,'InvalidValue');
 const c=h.candleState(t);expect(c.reads.slice(7).every(r=>r.price===0n)).toBe(true);const quote=s.payout(c,h.ticketState(t));expect(quote).toBe(10000000n);
 const close=end+41n;expect(s.settleAfter(c)).toBe(close);h.clock(close-1n);await h.send('not_closed',h.settleIx(t),h.stranger,'NotClosed');h.clock(close);await h.send('closed',h.settleIx(t));expect(h.events.find(e=>e.name==='Settled')!.data).toMatchObject({payout:quote,reads:127,toSeller:40000000n-quote});
});

for(const secs of [1800n,3600n])it(`${secs} seconds: mark publications and load/reader/mark deadlines remain inclusive`,async()=>{
 const h=await Harness.create({setSpan:true}),t0=secs===1800n?1203n:1200n,t=await h.open({t0,loaded:true}),unloaded=await h.open({t0,sold:true}),late=await h.open({t0,sold:true}),end=t0+secs;
 h.clock(t0);h.price(P0,t0);await h.send('opening',h.readIx(t,0));h.clock(end);h.price(P0*101n/100n,end);await h.send('last_mark_publication',h.markIx(t));
 h.clock(end+1n);h.price(P0*102n/100n,end+1n);await h.send('after_end_publication',h.markIx(t),h.marker,'OutsideCandle');
 h.clock(end+20n);h.price(P0*102n/100n,end);await h.send('last_mark_time',h.markIx(t));await h.send('last_load_time',h.loadIx(unloaded),h.buyer);const marker=h.ix('setMarker',{...t,buyer:h.buyer,marker:h.marker.address});await h.send('last_reader_time',marker,h.buyer);
 h.clock(end+21n);await h.send('late_mark',h.markIx(t),h.marker,'FeedStale');await h.send('late_reader',marker,h.buyer,'MarkClosed');await h.send('late_load',h.loadIx(late),h.buyer,'MarkClosed');
 expect(h.ticketState(t).marks).toBe(2);expect(h.ticketState(t).tailHigh).toBe(P0*102n/100n);
});

for(const secs of [1800n,3600n])it(`${secs} seconds: running sale expiry and entry publication stop at the candle end`,async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.ref(secs===1800n?1203n:1200n),end=t.t0+secs,until=(await s.findUntilPda(t.ticket))[0];await h.send('candle',h.openCandleIx(t));
 const open=(untilArg:bigint)=>h.ix('openRunning',{...t,until,untilArg,premium:1000000n,strikeBps:0,sellerSource:h.sellerUsdc});await h.send('until_after_end',open(end+1n),h.seller,'InvalidValue');await h.send('until_end',open(end),h.seller);
 h.clock(t.t0);h.price(P0,t.t0);await h.send('opening',h.readIx(t,0));h.clock(end);const buy=h.ix('buyRunning',{...t,until,buyerSource:h.buyerUsdc,maxPay:40000000n,feed:h.feed});h.price(P0*101n/100n,end+1n);await h.send('entry_after_end',buy,h.buyer,'OutsideCandle');h.price(P0*101n/100n,end);await h.send('entry_end',buy,h.buyer);expect(h.events.find(e=>e.name==='BoughtRunning')!.data.recorded).toBe(10000000n);
});

for(const secs of [1800n,3600n])it(`${secs} seconds: resale limits and read-pending ignore slots outside the candle`,async()=>{
 const{h,t,end}=await fixture(0,secs),resale=(await s.findResalePda(t.ticket))[0],recipient=h.stranger,recipientUsdc=await h.fundToken(recipient,USDC,TOKEN,1000000000n);
 const list=(until:bigint)=>h.ix('listResale',{...t,resale,holder:h.buyer,ask:100000n,until});await h.send('resale_after_end',list(end+1n),h.buyer,'InvalidValue');await h.send('resale_end',list(end),h.buyer);
 for(let j=1;j<=Number(secs/300n);j++){const ts=t.t0+BigInt(j)*300n;h.clock(ts);h.price(P0,ts);if(j<Number(secs/300n))await h.send('read',h.readIx(t,j));}
 const buy=h.ix('buyResale',{...t,resale,holder:h.buyer.address,holderUsdc:h.buyerUsdc,buyer:recipient,buyerSource:recipientUsdc,feed:h.feed,maxPay:40000000n,spanMint:h.spanMint,spanHold:t.spanHold,holderSpan:h.buyerSpan,spanTokenProgram:h.spanProgram});
 expect(s.readPending(h.candleState(t),end,{price:P0,publishTs:end})).toBe(true);await h.send('pending_last',buy,recipient,'ReadPending');await h.send('last_read',h.readIx(t,Number(secs/300n)));expect(s.readPending(h.candleState(t),end,{price:P0,publishTs:end})).toBe(false);await h.send('resale_at_end',buy,recipient);expect(unwrapOption(h.ticketState(t).buyer)).toBe(recipient.address);expect(h.ticketState(t).spanLoaded).toBe(0n);expect(amount(h.svm,t.vault)).toBe(40000000n);
});

it('isolates the six candle accounts, readings, tickets and vaults at one named minute',async()=>{
 const h=await Harness.create({setSpan:true}),feeds=[SOL_FEED,BTC_FEED,ETH_FEED];for(const asset of [1,2]as const)h.clone(SOL_FEED,feeds[asset],data=>data.set(getAddressEncoder().encode(s.mintOf(asset)),8));
 const tickets=[];for(let second=0;second<6;second++)tickets.push(await h.open({t0:1200n+BigInt(second),sold:true}));
 expect(new Set(tickets.map(t=>t.candle)).size).toBe(6);expect(new Set(tickets.map(t=>t.vault)).size).toBe(6);
 for(let i=0;i<6;i++){const t=tickets[i],feed=feeds[i%3],other=tickets[(i+1)%6],saved=accountData(h.svm,other.candle),vault=amount(h.svm,other.vault);h.clock(t.t0);h.price(P0+BigInt(i),t.t0,feed);await h.send('isolated_read',h.readIx(t,0,{feed}));expect(accountData(h.svm,other.candle)).toEqual(saved);expect(amount(h.svm,other.vault)).toBe(vault);await h.send('cross_candle',h.buyIx({...t,candle:other.candle}),h.buyer,'InvalidValue');}
});

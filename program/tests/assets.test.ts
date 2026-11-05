import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {getAddressEncoder,getProgramDerivedAddress} from '@solana/kit';
import {Harness,PROGRAM,accountData,amount} from './harness.js';
import {SOL_FEED,BTC_FEED,ETH_FEED,DOVES,LOADER} from '../client/constants.js';
import {ASSETS,assetOf,mintOf,startOf} from '../client/assets.js';
import {settleAfter} from '../client/math.js';
import {devFeedInstruction,feedPda} from './feed.js';
const prices=[9490000000n,7790511000000n,226297000000n],feeds=[SOL_FEED,BTC_FEED,ETH_FEED],cu:any[]=[];
it('maps starts without normalizing their seconds',()=>{for(const a of [0,1,2] as const){expect(assetOf(1200n+BigInt(a))).toBe(a);expect(startOf(1260n,a)).toBe(1200n+BigInt(a));}expect(assetOf(1203n)).toBe(0);for(const t of [1206n,1259n])expect(()=>assetOf(t)).toThrow();});
for(const asset of [0,1,2] as const)it(`${ASSETS[asset]} opens, reads thirteen times, marks and settles with the same price ratios`,async()=>{
 const h=await Harness.create({setSpan:true,asset}),ref=await h.ref();
 const open=await h.send('asset_open_candle',h.openCandleIx(ref));const t=await h.open({t0:ref.t0,loaded:true});
 h.clock(t.t0);h.price(prices[asset],t.t0);const read=await h.send('asset_read',h.readIx(t,0));
 h.clock(t.t0+1n);h.price(prices[asset]*101n/100n,t.t0+1n);const mark=await h.send('asset_mark',h.markIx(t));
 for(let j=1;j<13;j++){const ts=t.t0+BigInt(j)*300n;h.clock(ts);h.price(prices[asset],ts);await h.send('asset_read',h.readIx(t,j));}
 h.clock(settleAfter(h.candleState(t)));await h.send('asset_settle',h.settleIx(t));
 expect(h.events.find(e=>e.name==='Settled')!.data).toMatchObject({payout:10000000n,toBuyer:10000000n,toSeller:30000000n,burned:100n,spanReturned:99900n,reads:8191});
 const row={asset:ASSETS[asset],open:Number(open.computeUnitsConsumed()),read:Number(read.computeUnitsConsumed()),mark:Number(mark.computeUnitsConsumed())};cu.push(row);console.log('ASSET_CU',JSON.stringify(row));
 expect(row.open).toBeLessThanOrEqual(28000);expect(row.read).toBeLessThanOrEqual(28000);expect(row.mark).toBeLessThanOrEqual(42000);
 if(process.env.SPAN_ASSET_CU_OUT)writeFileSync(process.env.SPAN_ASSET_CU_OUT,JSON.stringify(cu,null,2)+'\n');
});
it('rejects unsupported start seconds',async()=>{const h=await Harness.create();await h.send('half_asset',h.openCandleIx(await h.ref(1203n)));for(const t0 of [1206n,1259n])await h.send('bad_asset',h.openCandleIx(await h.ref(t0)),h.stranger,'InvalidValue');});
for(const asset of [1,2] as const)it(`${ASSETS[asset]} rejects another feed, wrong mint, owner and stale publication in reads and marks`,async()=>{
 const h=await Harness.create({setSpan:true,asset}),t=await h.open({loaded:true});h.clock(t.t0);h.price(prices[asset],t.t0);
 for(const feed of feeds.filter(f=>f!==h.feed))await h.send('wrong_read_feed',h.readIx(t,0,{feed}),h.stranger,'FeedNotConfig');
 const good=h.svm.getAccount(h.feed);if(!good.exists)throw Error('Missing feed');
 const edit=(owner=good.programAddress,mint=mintOf(asset))=>{const data=Buffer.from(good.data);data.set(getAddressEncoder().encode(mint),8);h.svm.setAccount({...good,programAddress:owner,data});};
 edit(DOVES,mintOf(0));await h.send('wrong_read_mint',h.readIx(t,0),h.stranger,'FeedAssetMismatch');edit(h.stranger.address);await h.send('wrong_read_owner',h.readIx(t,0),h.stranger,'FeedInvalid');edit();
 h.price(prices[asset],t.t0-21n);await h.send('stale_read',h.readIx(t,0),h.stranger,'FeedStale');h.price(prices[asset],t.t0);await h.send('open',h.readIx(t,0));
 h.clock(t.t0+30n);h.price(prices[asset]*101n/100n,t.t0+30n);
 for(const feed of feeds.filter(f=>f!==h.feed))await h.send('wrong_mark_feed',h.markIx(t,{feed}),h.marker,'FeedNotConfig');
 const fresh=h.svm.getAccount(h.feed);if(!fresh.exists)throw Error();
 edit(DOVES,mintOf(0));await h.send('wrong_mark_mint',h.markIx(t),h.marker,'FeedAssetMismatch');edit(h.stranger.address);await h.send('wrong_mark_owner',h.markIx(t),h.marker,'FeedInvalid');h.svm.setAccount(fresh);
 h.price(prices[asset],t.t0);await h.send('stale_mark',h.markIx(t),h.marker,'FeedStale');
});
it('rejects a BTC source on a SOL candle',async()=>{const h=await Harness.create(),t=await h.open();h.clock(t.t0);await h.send('cross_feed',h.readIx(t,0,{feed:BTC_FEED}),h.stranger,'FeedNotConfig');});
it('preserves BTC ticket funds when SOL or ETH candles are substituted',async()=>{
 const h=await Harness.create({setSpan:true,asset:1}),btc=await h.open(),sol=await h.open({t0:1200n}),eth=await h.open({t0:1202n});
 for(const other of [sol,eth])await h.send('cross_buy',h.buyIx({...btc,candle:other.candle}),h.buyer,'InvalidValue');await h.send('buy',h.buyIx(btc),h.buyer);
 for(const other of [sol,eth])await h.send('cross_load',h.loadIx({...btc,candle:other.candle}),h.buyer,'InvalidValue');await h.send('load',h.loadIx(btc),h.buyer);
 const before=accountData(h.svm,btc.ticket),vault=amount(h.svm,btc.vault),held=amount(h.svm,btc.spanHold);
 for(const other of [sol,eth]){const ref={...btc,candle:other.candle};for(const [name,ix,payer]of [['set',h.ix('setMarker',{...ref,buyer:h.buyer,marker:h.stranger.address}),h.buyer],['mark',h.markIx(ref),h.marker],['settle',h.settleIx(ref),h.stranger]]as const)await h.send('cross_'+name,ix,payer,'InvalidValue');}
 expect(accountData(h.svm,btc.ticket)).toEqual(before);expect(amount(h.svm,btc.vault)).toBe(vault);expect(amount(h.svm,btc.spanHold)).toBe(held);
});
it('development feed PDAs preserve SOL and isolate BTC and ETH',async()=>{
 const h=await Harness.create({binary:'../target/devnet/span.so'});
 for(const asset of [0,1,2] as const){const tx=await h.transaction([await devFeedInstruction('dev_feed_init',h.admin,undefined,undefined,asset)],h.admin),result=h.svm.sendTransaction(tx);if('err' in result)throw Error(result.meta().logs().join('\n'));
  expect(accountData(h.svm,await feedPda(asset)).subarray(8,40)).toEqual(Buffer.from(getAddressEncoder().encode(mintOf(asset))));}
});
it.skipIf(!process.env.SPAN_PREVIOUS_BINARY)('old SOL accounts keep the same reads, marks, settlement and withdrawal after upgrading',async()=>{
 const run=async(upgrade:boolean)=>{const h=await Harness.create({setSpan:true,binary:process.env.SPAN_PREVIOUS_BINARY}),t=await h.open({loaded:true}),unsold=await h.open();const before=accountData(h.svm,t.ticket),wallets=[h.admin,h.seller,h.buyer,h.marker,h.stranger],nativeBefore=wallets.map(w=>{const a=h.svm.getAccount(w.address);return a.exists?a.lamports:0n;});
  if(upgrade)h.svm.addProgramWithLoader(PROGRAM,readFileSync(new URL('../target/mainnet/span.so',import.meta.url)),LOADER);expect(accountData(h.svm,t.ticket)).toEqual(before);
  h.clock(t.t0);h.price(10000000000n,t.t0);await h.send('compat_read',h.readIx(t,0));h.clock(t.t0+1n);h.price(10100000000n,t.t0+1n);await h.send('compat_mark',h.markIx(t));h.clock(settleAfter(h.candleState(t)));await h.send('compat_settle',h.settleIx(t));const e=h.events.find(e=>e.name==='Settled')!.data;
  await h.send('compat_withdraw',h.withdrawIx(unsold));return{nativeDeltas:wallets.map((w,i)=>{const a=h.svm.getAccount(w.address);return(a.exists?a.lamports:0n)-nativeBefore[i];}),payout:e.payout,burned:e.burned,returned:e.spanReturned,buyer:amount(h.svm,h.buyerUsdc),seller:amount(h.svm,h.sellerUsdc),span:amount(h.svm,h.buyerSpan)};};expect(await run(true)).toEqual(await run(false));
});

it('development commands reject unsupported asset indices',async()=>{
 const h=await Harness.create({binary:'../target/devnet/span.so'}),feed=(await getProgramDerivedAddress({programAddress:PROGRAM,seeds:['dev_feed',new Uint8Array([3])]}))[0];
 for(const name of ['dev_feed_init','dev_feed_write'] as const){
  if(name==='dev_feed_write'){const raw=h.svm.getAccount(SOL_FEED);if(!raw.exists)throw Error();h.svm.setAccount({...raw,address:feed,programAddress:PROGRAM});}
  const ix=await devFeedInstruction(name,h.admin,1n,1000n,0),data=Uint8Array.from(ix.data!);data[8]=3;
  const accounts=ix.accounts!.map((a,i)=>i===3?{...a,address:feed}:a);
  await h.send('invalid_dev_asset',{...ix,data,accounts},h.admin,'InvalidValue');
 }
});

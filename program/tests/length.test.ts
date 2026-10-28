import {it,expect} from 'vitest';
import {Harness,amount} from './harness.js';
import {payout,markAccepts} from '../client/math.js';
const p0=10000000000n;
it('accepts the length/premium boundaries and deposits the forty-USDC remainder',async()=>{
 const h=await Harness.create();
 for(const [k,p,ok]of [[0,100000,true],[25,39000000,true],[500,3000000,true],[10,3000000,false],[26,3000000,false],[525,3000000,false],[200,99999,false],[200,39000001,false]]as const){const t=await h.ref();await h.send('length_boundary',[h.openCandleIx(t),h.openIx(t,BigInt(p),{strikeBps:k})],h.seller,ok?undefined:'InvalidValue');if(ok){expect(h.ticketState(t).strikeBps).toBe(k);expect(amount(h.svm,t.vault)).toBe(40000000n-BigInt(p));}}
});
it('computes floor then strike then cap, including the February replay',async()=>{
 const c={t0:1200n,readWindow:20,ageLimit:20,reads:[{price:p0,publishTs:1200n}],readHigh:p0,readLow:p0};
 for(const [k,h,want]of [[0,10100000000n,10000000n],[200,10100000000n,0n],[200,10300000000n,10000000n],[200,10600000000n,40000000n]]as const)expect(payout({...c,readHigh:h},{strikeBps:k,tailHigh:0n,tailLow:0n,stepBps:5})).toBe(want);
 const h=await Harness.create({setSpan:true}),t=await h.open({sold:true,strikeBps:200});h.clock(t.t0);h.price(8245717232n,t.t0);await h.send('length_open_read',h.readIx(t,0));h.clock(t.t0+300n);h.price(8374074305n,t.t0+300n);await h.send('length_high_read',h.readIx(t,1));h.clock(t.t0+600n);h.price(8184020762n,t.t0+600n);await h.send('length_low_read',h.readIx(t,2));h.clock(t.t0+3641n);await h.send('length_replay_settle',h.settleIx(t));expect(h.events.find(e=>e.name==='Settled')!.data).toMatchObject({strikeBps:200,payout:3048758n,toBuyer:3048758n,toSeller:36951242n});
});
it('keeps unpaid tails, burns payout increases, and fences retries and capped tickets',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({loaded:true,strikeBps:25});h.clock(t.t0);h.price(p0,t.t0);await h.send('length_read',h.readIx(t,0));
 for(const [i,price,burn]of [[1,10010000000n,0n],[2,10030000000n,100n],[3,10040000000n,100n],[4,10425000000n,100n]]as const){h.clock(t.t0+BigInt(i));h.price(price,t.t0+BigInt(i));const before=amount(h.svm,t.spanHold),b=h.ticketState(t).burned;expect(markAccepts(h.candleState(t),h.ticketState(t),price)).toMatchObject({accepted:true,burns:burn>0n});await h.send('length_mark',h.markIx(t));expect(h.events.find(e=>e.name==='Marked')!.data).toMatchObject({burn});expect(amount(h.svm,t.spanHold)).toBe(before-burn);expect(h.ticketState(t).burned).toBe(b+burn);await h.send('length_retry',h.markIx(t),h.stranger,'NotExtension');}
 expect(h.ticketState(t).marks).toBe(4);h.clock(t.t0+5n);h.price(10440000000n,t.t0+5n);await h.send('length_capped',h.markIx(t),h.stranger,'CapReached');
});
it('requires a burn in reserve below the length and preserves zero-length burning',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({loaded:true,strikeBps:200});h.clock(t.t0);h.price(p0,t.t0);await h.send('reserve_read',h.readIx(t,0));h.clone(t.spanHold,t.spanHold,d=>d.writeBigUInt64LE(99n,64));h.clock(t.t0+1n);h.price(10010000000n,t.t0+1n);await h.send('reserve_mark',h.markIx(t),h.stranger,'SpanShort');
 const z=await h.open({loaded:true,t0:2400n,strikeBps:0});h.clock(z.t0);h.price(p0,z.t0);await h.send('zero_read',h.readIx(z,0));h.clock(z.t0+1n);h.price(10010000000n,z.t0+1n);await h.send('zero_mark',h.markIx(z));expect(h.events.find(e=>e.name==='Marked')!.data.burn).toBe(100n);
});

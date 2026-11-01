import { expect, it } from 'vitest';
import { Harness, accountData, amount, type Ref, type Wallet } from './harness.js';
import { settleAfter } from '../client/math.js';
const p0=10000000000n;
const change=(h:Harness,t:Ref,who:Wallet=h.buyer,marker=h.stranger.address)=>h.ix('setMarker',{...t,buyer:who,marker});
async function opening(h:Harness,t:Ref){h.clock(t.t0);h.price(p0,t.t0);await h.send('opening',h.readIx(t,0));}
async function mark(h:Harness,t:Ref,at:bigint,price:bigint,who=h.marker,failure?:string){h.clock(at);h.price(price,at);await h.send('mark',h.markIx(t,{marker:who}),who,failure);}
it('only the buyer of a loaded Sold ticket can change its marker',async()=>{
 const h=await Harness.create({setSpan:true}),open=await h.open(),sold=await h.open({sold:true}),t=await h.open({loaded:true});
 await h.send('open_marker',change(h,open),h.buyer,'NotSold');
 await h.send('unloaded_marker',change(h,sold),h.buyer,'NotLoaded');
 for(const who of [h.seller,h.stranger,h.marker])await h.send('wrong_buyer',change(h,t,who),who,'NotBuyer');
 const before=h.ticketState(t),held=accountData(h.svm,t.spanHold);
 await h.send('buyer_marker',change(h,t),h.buyer);
 expect(h.ticketState(t)).toEqual({...before,marker:h.stranger.address});
 expect(accountData(h.svm,t.spanHold)).toEqual(held);
 expect(h.events[0]).toMatchObject({name:'MarkerSet',data:{id:t.id,buyer:h.buyer.address,oldMarker:h.marker.address,newMarker:h.stranger.address}});
});
it('accepts the inclusive marker deadline and rejects the following second and a different valid candle',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({loaded:true}),other=await h.open({t0:2400n});
 const end=t.t0+3600n+BigInt(h.candleState(t).ageLimit);
 h.clock(end);await h.send('marker_boundary',change(h,t),h.buyer);
 h.clock(end+1n);await h.send('marker_closed',change(h,t,h.buyer,h.marker.address),h.buyer,'MarkClosed');
 await h.send('marker_wrong_candle',change(h,{...t,candle:other.candle},h.buyer,h.marker.address),h.buyer,'InvalidValue');
 expect(h.ticketState(t).marker).toBe(h.stranger.address);
});
it('preserves recorded tails and funds through marker changes; only payout increases burn',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({loaded:true,strikeBps:25});await opening(h,t);
 await mark(h,t,t.t0+1n,10010000000n);expect(h.ticketState(t).burned).toBe(0n);
 const old=h.ticketState(t),hold=accountData(h.svm,t.spanHold);
 await h.send('change_after_mark',change(h,t),h.buyer);
 expect(h.ticketState(t)).toEqual({...old,marker:h.stranger.address});expect(accountData(h.svm,t.spanHold)).toEqual(hold);
 await mark(h,t,t.t0+2n,10020000000n,h.marker,'NotMarker');
 await mark(h,t,t.t0+2n,10010000000n,h.stranger,'NotExtension');
 await mark(h,t,t.t0+3n,10020000000n,h.stranger);expect(h.ticketState(t).burned).toBe(0n);
 await mark(h,t,t.t0+4n,10030000000n,h.stranger);expect(h.ticketState(t).burned).toBe(100n);
 const after=h.ticketState(t);await h.send('change_before_old_mark',change(h,t,h.buyer,h.marker.address),h.buyer);
 await mark(h,t,t.t0+5n,10040000000n,h.stranger,'NotMarker');
 await mark(h,t,t.t0+5n,10040000000n);expect(h.ticketState(t).marks).toBe(after.marks+1);
 h.clock(settleAfter(h.candleState(t)));await h.send('settle_changed_marker',h.settleIx(t));
 const e=h.events.find(e=>e.name==='Settled')!;expect(e.data.burned+e.data.spanReturned).toBe(100000n);
});
it('loads for the first time halfway through the hour, then marks and settles without changing settlement',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({sold:true});await opening(h,t);
 h.clock(t.t0+1800n);await h.send('late_first_load',h.loadIx(t),h.buyer);
 await mark(h,t,t.t0+1801n,10100000000n);expect(h.ticketState(t).marks).toBe(1);expect(amount(h.svm,t.spanHold)).toBe(99900n);
 h.clock(settleAfter(h.candleState(t)));await h.send('late_load_settle',h.settleIx(t));
 const e=h.events.find(e=>e.name==='Settled')!;expect(e.data.burned+e.data.spanReturned).toBe(100000n);
});
it('first-load boundary uses independent unloaded tickets and retains AlreadyLoaded and candle linkage checks',async()=>{
 const h=await Harness.create({setSpan:true}),a=await h.open({sold:true}),b=await h.open({sold:true}),other=await h.open({t0:2400n});
 const end=a.t0+3600n+BigInt(h.candleState(a).ageLimit);
 h.clock(end);await h.send('load_boundary',h.loadIx(a),h.buyer);
 await h.send('load_again',h.loadIx(a),h.buyer,'AlreadyLoaded');
 h.clock(end+1n);await h.send('first_load_closed',h.loadIx(b),h.buyer,'MarkClosed');
 await h.send('load_wrong_candle',h.loadIx({...b,candle:other.candle}),h.buyer,'InvalidValue');
 expect(h.ticketState(b).spanLoaded).toBe(0n);expect(h.svm.getAccount(b.spanHold).exists).toBe(false);
});
it('overflows the checked marker and first-load deadline rather than wrapping',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({loaded:true}),u=await h.open({sold:true});
 const c=h.svm.getAccount(t.candle);if(!c.exists)throw Error('Missing candle');
 const future=9223372036854775800n,ref=await h.ref(future,t.id),unloaded={...u,t0:future,candle:ref.candle};
 const value={...h.candleState(t),t0:future};
 const {getCandleEncoder,getTicketEncoder}=await import('../client/index.js');
 h.svm.setAccount({...c,address:ref.candle,data:getCandleEncoder().encode(value)});
 // Derive the new bump for a valid PDA, leaving only the deadline arithmetic invalid.
 const {findCandlePda}=await import('../client/index.js');
 const [,bump]=await findCandlePda(future);h.svm.setAccount({...c,address:ref.candle,data:getCandleEncoder().encode({...value,bump})});
 for(const x of [t,u]){const raw=h.svm.getAccount(x.ticket);if(!raw.exists)throw Error('Missing ticket');h.svm.setAccount({...raw,data:getTicketEncoder().encode({...h.ticketState(x),t0:future})});}
 await h.send('marker_overflow',change(h,{...t,t0:future,candle:ref.candle}),h.buyer,'Overflow');
 await h.send('load_overflow',h.loadIx(unloaded),h.buyer,'Overflow');
});

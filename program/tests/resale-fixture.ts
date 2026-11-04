import {unwrapOption,type Address} from '@solana/kit';
import {Harness,type Wallet} from './harness.js';
import * as s from '../client/index.js';
import {TOKEN,USDC} from '../client/constants.js';
export const RESALE_P0=10000000000n;
export type ResaleActor={signer:Wallet;usdc:Address;span:Address};
export async function resaleFixture(o:{loaded?:boolean;opening?:boolean;running?:boolean;spanProgram?:Address;binary?:string;asset?:0|1|2}={}){
 const h=await Harness.create({setSpan:true,spanProgram:o.spanProgram,binary:o.binary??process.env.SPAN_RESALE_BINARY,asset:o.asset});
 const actors:ResaleActor[]=[{signer:h.buyer,usdc:h.buyerUsdc,span:h.buyerSpan}];
 for(const signer of[h.stranger,h.admin])actors.push({signer,usdc:await h.fundToken(signer,USDC,TOKEN,1000000000n),span:await h.fundToken(signer,h.spanMint,h.spanProgram,1000000n)});
 const t=await h.ref(),resale=(await s.findResalePda(t.ticket))[0];
 if(o.running){const until=(await s.findUntilPda(t.ticket))[0];await h.send('open_running',[h.openCandleIx(t),h.ix('openRunning',{...t,until,untilArg:t.t0+3600n,premium:1000000n,strikeBps:0,sellerSource:h.sellerUsdc})],h.seller);h.clock(t.t0);h.price(RESALE_P0,t.t0);await h.send('read0',h.readIx(t,0));h.clock(t.t0+30n);h.price(RESALE_P0*101n/100n,t.t0+30n);await h.send('entry',h.ix('buyRunning',{...t,until,buyerSource:h.buyerUsdc,maxPay:11000000n,feed:h.feed}),h.buyer);}
 else{await h.send('sale',[h.openCandleIx(t),h.openIx(t,1000000n)],h.seller);await h.send('buy',h.buyIx(t),h.buyer);}
 if(o.loaded)await h.send('load',h.loadIx(t),h.buyer);
 if(o.opening!==false&&!o.running){h.clock(t.t0);h.price(RESALE_P0,t.t0);await h.send('read0',h.readIx(t,0));}
 if(o.opening!==false||o.running){h.clock(t.t0+60n);h.price(RESALE_P0,t.t0+60n);}
 const holder=()=>actors.find(a=>a.signer.address===unwrapOption(h.ticketState(t).buyer))!;
 const list=(ask=100000n,until=t.t0+3600n,who=holder())=>h.ix('listResale',{...t,resale,holder:who.signer,ask,until});
 const buy=(to=actors[1],extra:any={})=>{const from=holder(),loaded=h.ticketState(t).spanLoaded>0n;return h.ix('buyResale',{...t,resale,holder:from.signer.address,holderUsdc:from.usdc,buyer:to.signer,buyerSource:to.usdc,feed:h.feed,maxPay:40000000n,spanMint:loaded?h.spanMint:undefined,spanHold:loaded?t.spanHold:undefined,holderSpan:loaded?from.span:undefined,spanTokenProgram:loaded?h.spanProgram:undefined,...extra});};
 const load=(who=holder(),extra:any={})=>h.loadIx(t,{buyer:who.signer,spanSource:who.span,...extra});
 const settle=(extra:any={})=>{const who=holder();return h.settleIx(t,{buyer:who.signer.address,buyerUsdc:who.usdc,buyerSpan:h.ticketState(t).spanLoaded?who.span:undefined,...extra});};
 const close=(closer=h.marker)=>h.ix('closeResale',{resale,ticket:t.ticket,holder:holder().signer.address,closer});
 return{h,t,resale,actors,holder,list,buy,load,settle,close};
}

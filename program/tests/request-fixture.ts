import {Rent} from 'litesvm';
import {unwrapOption,type Address} from '@solana/kit';
import * as s from '../client/index.js';
import {USDC,TOKEN} from '../client/constants.js';
import {Harness,type Wallet,accountData} from './harness.js';
export const P0=10000000000n;
export {bidBudget as requestBudget,sendBid as sendRequest,native,token} from './bid-fixture.js';
export type Actor={signer:Wallet;usdc:Address;span:Address};
export async function requestFixture(o:{loaded?:boolean;opening?:boolean;secs?:bigint;spanProgram?:Address;mainnetRent?:boolean;setSpan?:boolean;strikeBps?:number}={}){
 const h=await Harness.create({setSpan:o.setSpan??true,spanProgram:o.spanProgram});
 if(o.mainnetRent)h.svm.setRent(new Rent(5080n,1,50));
 const actors:Actor[]=[{signer:h.buyer,usdc:h.buyerUsdc,span:h.buyerSpan}];
 for(const signer of[h.stranger,h.admin])actors.push({signer,usdc:await h.fundToken(signer,USDC,TOKEN,1000000000n),span:await h.fundToken(signer,h.spanMint,h.spanProgram,1000000n)});
 const t=await h.open({t0:o.secs===1800n?1203n:1200n,sold:true,loaded:o.loaded??false,premium:1000000n,strikeBps:o.strikeBps??0}),resale=(await s.findResalePda(t.ticket))[0];
 const holder=()=>actors.find(a=>a.signer.address===unwrapOption(h.ticketState(t).buyer))!;
 const ref=async(requester=actors[1])=>{const request=(await s.findRequestPda(t.t0,(o.strikeBps??0),requester.signer.address))[0];return{request,requestUsdc:(await s.findRequestUsdcPda(request))[0],requestSpan:(await s.findRequestSpanPda(request))[0],requester};};
 const place=async(requester=actors[1],extra:any={})=>{const b=await ref(requester);return h.ix('placeRequest',{...t,...b,strikeBps:(o.strikeBps??0),minRoom:0n,requester:requester.signer,requesterSource:requester.usdc,ask:100000n,cap:40000000n,until:t.t0+s.secsOf(t.t0),...extra});};
 const requestSpan=async(requester=actors[1],extra:any={})=>{const b=await ref(requester);return h.ix('requestSpan',{...b,requester:requester.signer,spanSource:requester.span,amount:1000n,stepBps:5,marker:h.marker.address,...extra});};
 const accept=async(requester=actors[1],extra:any={})=>{const b=await ref(requester),from=holder(),offered=h.svm.getAccount(b.request).exists&&s.getRequestDecoder().decode(accountData(h.svm,b.request)).spanAmount>0n,old=h.ticketState(t).spanLoaded>0n;return h.ix('fillRequestHeld',{...t,...b,requester:requester.signer.address,holder:from.signer,holderUsdc:from.usdc,requesterUsdc:requester.usdc,feed:h.feed,resale,spanMint:old||offered?h.spanMint:undefined,spanTokenProgram:old||offered?h.spanProgram:undefined,spanHold:old||offered?t.spanHold:undefined,holderSpan:old?from.span:undefined,requestSpan:offered?b.requestSpan:undefined,...extra});};
 const close=async(requester=actors[1],extra:any={})=>{const b=await ref(requester),offered=s.getRequestDecoder().decode(accountData(h.svm,b.request)).spanAmount>0n;return h.ix('closeRequest',{...b,requester:requester.signer.address,ticket:t.ticket,closer:requester.signer,requesterUsdc:requester.usdc,requestSpan:offered?b.requestSpan:undefined,requesterSpan:offered?requester.span:undefined,spanMint:offered?h.spanMint:undefined,spanTokenProgram:offered?h.spanProgram:undefined,...extra});};
 const list=(ask=100000n)=>h.ix('listResale',{...t,resale,holder:holder().signer,ask,until:t.t0+s.secsOf(t.t0)});
 const buyResale=(to:Actor,extra:any={})=>{const from=holder(),loaded=h.ticketState(t).spanLoaded>0n;return h.ix('buyResale',{...t,resale,holder:from.signer.address,holderUsdc:from.usdc,buyer:to.signer,buyerSource:to.usdc,feed:h.feed,maxPay:79000000n,spanMint:loaded?h.spanMint:undefined,spanTokenProgram:loaded?h.spanProgram:undefined,spanHold:loaded?t.spanHold:undefined,holderSpan:loaded?from.span:undefined,...extra});};
 const settle=()=>{const a=holder();return h.settleIx(t,{buyer:a.signer.address,buyerUsdc:a.usdc,buyerSpan:h.ticketState(t).spanLoaded?a.span:undefined});};
 if(o.opening!==false){h.clock(t.t0);h.price(P0,t.t0);await h.send('opening',h.readIx(t,0));h.clock(t.t0+60n);h.price(P0,t.t0+60n);}
 return{h,t,actors,resale,holder,ref,place,requestSpan,accept,close,list,buyResale,settle};
}
export type RequestFixture=Awaited<ReturnType<typeof requestFixture>>;

export async function requestOrder(h:Harness,requester:Actor,o:{t0?:bigint;strikeBps?:number;ask?:bigint;cap?:bigint;until?:bigint;minRoom?:bigint}={}){
 const t0=o.t0??1200n,strikeBps=o.strikeBps??0,request=(await s.findRequestPda(t0,strikeBps,requester.signer.address))[0],requestUsdc=(await s.findRequestUsdcPda(request))[0],requestSpan=(await s.findRequestSpanPda(request))[0];
 const r={request,requestUsdc,requestSpan},offered=()=>h.svm.getAccount(request).exists&&s.getRequestDecoder().decode(accountData(h.svm,request)).spanAmount>0n;
 const place=(extra:any={})=>h.ix('placeRequest',{...r,requester:requester.signer,requesterSource:requester.usdc,t0,strikeBps,ask:100000n,cap:40000000n,until:t0+(((t0%60n+60n)%60n)<3n?3600n:1800n),minRoom:0n,...o,...extra});
 const span=(extra:any={})=>h.ix('requestSpan',{...r,requester:requester.signer,spanSource:requester.span,amount:1000n,stepBps:5,marker:h.marker.address,...extra});
 const fill=(kind:'open'|'running',t:Awaited<ReturnType<Harness['ref']>>,seller={signer:h.seller,usdc:h.sellerUsdc},extra:any={})=>h.ix(kind==='open'?'fillRequestOpen':'fillRequestRunning',{...t,...r,seller:seller.signer,sellerSource:seller.usdc,requester:requester.signer.address,requesterUsdc:requester.usdc,feed:h.feed,spanMint:offered()?h.spanMint:undefined,spanTokenProgram:offered()?h.spanProgram:undefined,spanHold:offered()?t.spanHold:undefined,requestSpan:offered()?requestSpan:undefined,...extra});
 const close=(extra:any={})=>h.ix('closeRequest',{...r,requester:requester.signer.address,requesterUsdc:requester.usdc,closer:requester.signer,requestSpan:offered()?requestSpan:undefined,requesterSpan:offered()?requester.span:undefined,spanMint:offered()?h.spanMint:undefined,spanTokenProgram:offered()?h.spanProgram:undefined,...extra});
 return{...r,place,span,fill,close};
}

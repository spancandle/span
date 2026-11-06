import {unwrapOption} from '@solana/kit';
import * as s from '../../program/client/index.js';
import {accountData} from '../../program/tests/harness.js';
import {resaleRuntime} from './resale-support.js';
export async function bidRuntime(){
 const x=await resaleRuntime(),{h,t,actors}=x;
 const holder=()=>actors.find(a=>a.signer.address===unwrapOption(h.ticketState(t).buyer))!;
 const ref=async(to=actors[1])=>{const bid=(await s.findBidPda(t.ticket,to.signer.address))[0];return{bid,bidUsdc:(await s.findBidUsdcPda(bid))[0],bidSpan:(await s.findBidSpanPda(bid))[0]};};
 const place=async(to=actors[1],o:any={})=>h.ix('placeBid',{...t,...await ref(to),bidder:to.signer,bidderSource:to.usdc,ask:100000n,cap:40000000n,until:t.t0+3600n,...o});
 const deposit=async(to=actors[1],o:any={})=>h.ix('bidSpan',{...await ref(to),bidder:to.signer,spanSource:to.span,amount:1000n,stepBps:5,marker:h.marker.address,...o});
 const accept=async(to=actors[1],o:any={})=>{const b=await ref(to),old=h.ticketState(t).spanLoaded>0n,loaded=s.getBidDecoder().decode(accountData(h.svm,b.bid)).spanAmount>0n,from=holder();return h.ix('acceptBid',{...t,...b,bidder:to.signer.address,holder:from.signer,holderUsdc:from.usdc,bidderUsdc:to.usdc,feed:h.feed,resale:x.resale,spanMint:old||loaded?h.spanMint:undefined,spanTokenProgram:old||loaded?h.spanProgram:undefined,spanHold:old||loaded?t.spanHold:undefined,holderSpan:old?from.span:undefined,bidSpan:loaded?b.bidSpan:undefined,...o});};
 const close=async(to=actors[1],o:any={})=>{const b=await ref(to),loaded=s.getBidDecoder().decode(accountData(h.svm,b.bid)).spanAmount>0n;return h.ix('closeBid',{...b,ticket:t.ticket,bidder:to.signer.address,closer:to.signer,bidderUsdc:to.usdc,bidSpan:loaded?b.bidSpan:undefined,bidderSpan:loaded?to.span:undefined,spanMint:loaded?h.spanMint:undefined,spanTokenProgram:loaded?h.spanProgram:undefined,...o});};
 const sync=async()=>{x.sync();await x.chain.pollPrograms();};
 return{...x,holder,ref,place,deposit,accept,close,sync};
}

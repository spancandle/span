import { expect, it } from 'vitest';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LiteSVM } from 'litesvm';
import { AccountRole, getTransactionEncoder, type Instruction, type Address } from '@solana/kit';
import { sendBid, bidFixture } from './bid-fixture.js';
import { requestOrder } from './request-fixture.js';
import { spawnSync } from 'node:child_process';
import { getTransferSolInstruction } from '@solana-program/system';
import * as s from '../client/index.js';
import { LOADER, TOKEN, TOKEN_2022 } from '../client/constants.js';
import { Harness, amount, accountData, type Ref } from './harness.js';
const oldBinary=process.env.SPAN_BAND_BASELINE_BINARY,oldHarness=process.env.SPAN_BAND_BASELINE_HARNESS,oldIdl=process.env.SPAN_BAND_BASELINE_IDL;
const P0=1000000000n;
function state(h:any){
 return {accounts:[s.SPAN_PROGRAM_ADDRESS,TOKEN,TOKEN_2022].flatMap(owner=>h.svm.getProgramAccounts(owner).map((x:any)=>({address:x.address,owner,lamports:String(x.lamports),data:Buffer.from(x.data).toString('hex')}))).sort((a:any,b:any)=>a.address.localeCompare(b.address)),
 wallets:[h.admin,h.seller,h.buyer,h.marker,h.stranger].map(x=>({address:x.address,lamports:String(h.svm.getAccount(x.address).lamports)})),events:h.events};
}
const flatten=(rows:any[]):any[]=>rows.flatMap(a=>a.accounts?flatten(a.accounts):[a]);
const camel=(text:string)=>text.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
async function newIx(legacy:any,name:string,ix:Instruction){
 const idl=JSON.parse(readFileSync(oldIdl!,'utf8')), definition=idl.instructions.find((i:any)=>camel(i.name)===name),
  input:any={...legacy.r[`get${name[0].toUpperCase()+name.slice(1)}InstructionDataDecoder`]().decode(ix.data),bandBps:400};
 for(const [i,a] of flatten(definition.accounts).entries()){const meta=ix.accounts![i] as any;input[camel(a.name)]=a.optional && meta.address===s.SPAN_PROGRAM_ADDRESS ? undefined : meta.signer??meta.address;}
 for(const arg of definition.args){const key=camel(arg.name);if(flatten(definition.accounts).some(a=>camel(a.name)===key))input[key+'Arg']=legacy.r[`get${name[0].toUpperCase()+name.slice(1)}InstructionDataDecoder`]().decode(ix.data)[key];}
 if(input.ticket)input.band=(await s.findBandPda(input.ticket.address??input.ticket))[0];
 return (s as any)[`get${name[0].toUpperCase()+name.slice(1)}Instruction`](input) as Instruction;
}
const replace=(h:any,binary:Uint8Array,snapshot:Uint8Array)=>{h.svm=LiteSVM.fromBytes(snapshot);h.svm.addProgramWithLoader(s.SPAN_PROGRAM_ADDRESS,binary,LOADER);};
for(const running of [false,true])it.skipIf(!oldBinary||!oldHarness||!oldIdl)(`400bp new ${running?'open_running':'open_ticket'} preserves the preceding program's created state and events`,async()=>{
 const legacy=await import(pathToFileURL(oldHarness!).href),h=await legacy.Harness.create({binary:oldBinary,setSpan:true}),t=await h.ref();
 await h.send('candle',h.openCandleIx(t));
 const base=running?h.ix('openRunning',{...t,until:(await s.findUntilPda(t.ticket))[0],untilArg:t.t0+3600n,premium:1000000n,strikeBps:100,sellerSource:h.sellerUsdc}):h.openIx(t,1000000n,{strikeBps:100}),
  ix=await newIx(legacy,running?'openRunning':'openTicket',base),snapshot=h.svm.toBytes();
 await h.send('old open',base,h.seller);const expected=state(h);
 replace(h,readFileSync(new URL('../target/mainnet/span.so',import.meta.url)),snapshot);await h.send('new open',ix,h.seller);
 expect(state(h)).toEqual(expected);expect(h.svm.getAccount((await s.findBandPda(t.ticket))[0]).exists).toBe(false);expect(h.events.some((x:any)=>x.name==='BandSet')).toBe(false);
});
for(const action of ['mark','settle','buyRunning','buyResale','acceptBid','fillRequestHeld'] as const)it.skipIf(!oldBinary||!oldHarness||!oldIdl)(`400bp preceding ticket keeps ${action} identical after upgrade and accepts the new trailing account before upgrade`,async()=>{
 const legacy=await import(pathToFileURL(oldHarness!).href),h=await legacy.Harness.create({binary:oldBinary,setSpan:true});
 // Helpers for the nontrivial ownership instructions use the same preceding bindings and state.
 const t=action==='buyRunning'?await h.ref():await h.open({sold:true,loaded:true,strikeBps:100,premium:1000000n});
 if(action==='buyRunning')await h.send('running open',[h.openCandleIx(t),h.ix('openRunning',{...t,until:(await s.findUntilPda(t.ticket))[0],untilArg:t.t0+3600n,premium:1000000n,strikeBps:100,sellerSource:h.sellerUsdc})],h.seller);
 h.clock(t.t0);h.price(P0,t.t0);await h.send('read zero',h.readIx(t,0));
 h.clock(t.t0+60n);h.price(P0+12000000n,t.t0+60n);
 let ix:Instruction;
 if(action==='mark')ix=h.markIx(t);
 else if(action==='settle') {for(let j=1;j<=12;j++){h.clock(t.t0+BigInt(j*300));h.price(P0+12000000n,t.t0+BigInt(j*300));await h.send('read',h.readIx(t,j));}h.clock(s.settleAfter(h.candleState(t)));ix=h.settleIx(t);}
 else if(action==='buyRunning') {ix=h.ix('buyRunning',{...t,until:(await s.findUntilPda(t.ticket))[0],buyerSource:h.buyerUsdc,feed:h.feed,maxPay:40000000n});}
 else if(action==='buyResale') {const resale=(await s.findResalePda(t.ticket))[0];await h.send('list',h.ix('listResale',{...t,resale,holder:h.buyer,ask:100000n,until:t.t0+3600n}),h.buyer);const buyer=h.stranger,source=await h.fundToken(buyer,h.configState().usdcMint,TOKEN,100000000n);ix=h.ix('buyResale',{...t,resale,holder:h.buyer.address,holderUsdc:h.buyerUsdc,buyer,buyerSource:source,maxPay:40000000n,feed:h.feed,holderSpan:h.buyerSpan});}
 else if(action==='acceptBid') {const bidder=h.stranger,bid=(await s.findBidPda(t.ticket,bidder.address))[0],bidUsdc=(await s.findBidUsdcPda(bid))[0],source=await h.fundToken(bidder,h.configState().usdcMint,TOKEN,100000000n);await sendBid(h,h.ix('placeBid',{...t,bid,bidUsdc,bidder,bidderSource:source,ask:100000n,cap:40000000n,until:t.t0+3600n}),bidder);ix=h.ix('acceptBid',{...t,bid,bidUsdc,holder:h.buyer,holderUsdc:h.buyerUsdc,bidder:bidder.address,bidderUsdc:source,resale:(await s.findResalePda(t.ticket))[0],feed:h.feed,holderSpan:h.buyerSpan});}
 else {const requester=h.stranger,request=(await s.findRequestPda(t.t0,100,requester.address))[0],requestUsdc=(await s.findRequestUsdcPda(request))[0],source=await h.fundToken(requester,h.configState().usdcMint,TOKEN,100000000n);await sendBid(h,h.ix('placeRequest',{request,requestUsdc,requester,requesterSource:source,t0:t.t0,strikeBps:100,ask:100000n,cap:40000000n,until:t.t0+3600n,minRoom:0n}),requester);ix=h.ix('fillRequestHeld',{...t,request,requestUsdc,requester:requester.address,requesterUsdc:source,holder:h.buyer,holderUsdc:h.buyerUsdc,resale:(await s.findResalePda(t.ticket))[0],feed:h.feed,holderSpan:h.buyerSpan});}
 const modern=await newIx(legacy,action,ix),snapshot=h.svm.toBytes(),payer=action==='buyResale'?h.stranger:action==='acceptBid'||action==='fillRequestHeld'?h.buyer:action==='buyRunning'?h.buyer:h.marker;
 expect(modern.accounts!.slice(0,-1).map(x=>({address:x.address,role:x.role}))).toEqual(ix.accounts!.map(x=>({address:x.address,role:x.role})));
 expect(modern.accounts!.at(-1)).toMatchObject({address:(await s.findBandPda(t.ticket))[0],role:AccountRole.READONLY});
 measured(action+':old-wire',400,await sendBid(h,ix,payer));const expected=state(h);
 replace(h,readFileSync(oldBinary!),snapshot);measured(action+':current-trailing',400,await sendBid(h,modern,payer));expect(state(h)).toEqual(expected);
 replace(h,readFileSync(new URL('../target/mainnet/span.so',import.meta.url)),snapshot);measured(action+':new',400,await sendBid(h,modern,payer));expect(state(h)).toEqual(expected);
});
for(const bandBps of [100,200,400])it(`band ${bandBps} scales integer payouts and mark burns before the same cap, preserves vault and closes rent`,async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({sold:true,loaded:true,strikeBps:100,bandBps});
 expect(h.ticketState(t).bandBps).toBe(bandBps);expect(h.svm.getAccount(t.band).exists).toBe(bandBps!==400);
 h.clock(t.t0);h.price(P0,t.t0);await h.send('first read',h.readIx(t,0));
 const initial=h.svm.toBytes();
 for(const net of [-1n,0n,1n,40000000n/BigInt(400/bandBps)-1n,40000000n/BigInt(400/bandBps),40000000n/BigInt(400/bandBps)+1n]){
  h.svm=LiteSVM.fromBytes(initial);const price=P0+10000000n+net;h.clock(t.t0+60n);h.price(price,t.t0+60n);
  const before=h.ticketState(t),c=h.candleState(t),decision=s.markAccepts(c,before,price),burned=before.burned;
  await h.send('boundary mark',h.markIx(t),h.marker,decision.accepted?undefined:decision.reason);
  if(decision.accepted){const next=h.ticketState(t),pay=s.payout(c,next),expected=(net>0n?net:0n)*BigInt(400/bandBps);expect(pay).toBe(expected>40000000n?40000000n:expected);expect(next.burned-burned).toBe(pay>0n?h.configState().burnPerMark:0n);}
 }
 expect(amount(h.svm,t.vault)).toBe(40000000n);
 if(bandBps!==400){await h.send('live band close',h.ix('closeBand',{...t,seller:h.seller.address,closer:h.seller}),h.seller,'TicketLive');}
 for(let j=1;j<=12;j++){h.clock(t.t0+BigInt(j*300));h.price(P0,t.t0+BigInt(j*300));await h.send('read',h.readIx(t,j));}
 h.clock(s.settleAfter(h.candleState(t)));const beforeBuyer=amount(h.svm,h.buyerUsdc);await h.send('settle',h.settleIx(t),h.marker);expect(amount(h.svm,h.buyerUsdc)-beforeBuyer).toBe(40000000n);
 if(bandBps!==400){const rent=(h.svm.getAccount(t.band) as any).lamports,before=(h.svm.getAccount(h.seller.address) as any).lamports;await h.send('band rent',h.ix('closeBand',{...t,seller:h.seller.address,closer:h.stranger}),h.stranger);expect(h.svm.getAccount(t.band).exists).toBe(false);expect((h.svm.getAccount(h.seller.address) as any).lamports-before).toBe(rent);}
});
for(const bandBps of [100,200])it(`a prefunded canonical ${bandBps} band initializes, and malformed/missing/replaced bands cannot change its payout`,async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.ref();
 await h.send('prefund',getTransferSolInstruction({source:h.stranger,destination:t.band,amount:h.svm.minimumBalanceForRentExemption(0n)}),h.stranger);
 await h.send('open',[h.openCandleIx(t),h.openIx(t,1000000n,{bandBps,strikeBps:100})],h.seller);expect(h.ticketState(t).bandBps).toBe(bandBps);
 await h.send('buy',h.buyIx(t),h.buyer);await h.send('load',h.loadIx(t),h.buyer);h.clock(t.t0);h.price(P0,t.t0);await h.send('read',h.readIx(t,0));h.clock(t.t0+60n);h.price(P0+12000000n,t.t0+60n);
 const mark=h.markIx(t),before=accountData(h.svm,t.ticket);
 await h.send('missing',{...mark,accounts:mark.accounts!.slice(0,-1)},h.marker,'BandMissing');
 await h.send('replace',h.markIx(t,{band:h.admin.address}),h.marker,'InvalidBand');
 const band=h.svm.getAccount(t.band);if(!band.exists)throw Error('Missing band');
 for(const mutate of [()=>({...band,programAddress:TOKEN}),()=>({...band,data:new Uint8Array(75)}),()=>{const data=Buffer.from(band.data);data.set(Buffer.from(s.getBandEncoder().encode({...s.getBandDecoder().decode(data),ticket:h.admin.address})));return{...band,data};}]){
  h.svm.setAccount(mutate());await h.send('invalid band',mark,h.marker,'InvalidBand');h.svm.setAccount(band);
 }
 expect(accountData(h.svm,t.ticket)).toEqual(before);await h.send('valid',mark,h.marker);expect(h.ticketState(t).bandBps).toBe(bandBps);
});
it('rejects unsupported creation widths atomically',async()=>{
 const h=await Harness.create();for(const bandBps of [0,50,300,800]){const t=await h.ref();await h.send('invalid width',[h.openCandleIx(t),h.openIx(t,1000000n,{bandBps})],h.seller,'InvalidBand');expect(h.svm.getAccount(t.ticket).exists).toBe(false);expect(h.svm.getAccount(t.vault).exists).toBe(false);expect(h.svm.getAccount(t.band).exists).toBe(false);}
});

const measured=(kind:string,bandBps:number,row:Awaited<ReturnType<typeof sendBid>>)=>{
 if(process.env.SPAN_BAND_MEASUREMENTS)appendFileSync(process.env.SPAN_BAND_MEASUREMENTS,JSON.stringify({kind,bandBps,cu:Number(row.meta.computeUnitsConsumed()),bytes:row.bytes})+"\n");
};
for(const bandBps of [100,200,400])for(const kind of ['buyRunning','buyResale','acceptBid','settle','fillRequestHeld','fillRequestRunning'] as const)
it(`integer boundaries and funds on ${kind}, ${bandBps}bp`,async()=>{
 const x=await bidFixture({loaded:kind!=='buyRunning'&&kind!=='fillRequestRunning',strikeBps:100,bandBps}),{h,t,actors}=x;
 let running=t,until:any,request:any;
 if(kind==='buyRunning'){
  h.clock(1000n);running=await h.ref(2400n);until=(await s.findUntilPda(running.ticket))[0];
  await h.send('open running',[h.openCandleIx(running),h.ix('openRunning',{...running,until,untilArg:6000n,premium:1000000n,strikeBps:100,bandBps,sellerSource:h.sellerUsdc})],h.seller);
  h.clock(running.t0);h.price(10000000007n,running.t0);await h.send('opening',h.readIx(running,0));
 }else if(kind==='buyResale')await sendBid(h,x.list(),h.buyer);
 else if(kind==='acceptBid')await sendBid(h,[await x.place(actors[1],{cap:79000000n}),await x.bidSpan()],actors[1].signer);
 else if(kind==='fillRequestHeld'||kind==='fillRequestRunning'){
  request=await requestOrder(h,actors[1],{t0:t.t0,strikeBps:100,cap:79000000n});await sendBid(h,[request.place(),request.span()],actors[1].signer);
 }
 const snapshot=h.svm.toBytes(),actualBand=kind==='fillRequestRunning'?400:bandBps,p0=kind==='buyRunning'?10000000007n:10000000000n,capNet=40000000n/BigInt(400/actualBand);
 for(const net of [0n,1n,capNet-1n,capNet,capNet+1n]){
  h.svm=LiteSVM.fromBytes(snapshot);const ref=kind==='buyRunning'?running:t,raw=10000000n+net,delta=(raw*p0+999999999n)/1000000000n,price=p0+delta;
  const expectedRaw=1000000000n*delta/p0,uncapped=(expectedRaw-10000000n)*BigInt(400/actualBand),expected=uncapped>40000000n?40000000n:uncapped;
  if(kind==='settle'){for(let j=1;j<=12;j++){h.clock(t.t0+BigInt(j*300));h.price(j===1?price:p0,t.t0+BigInt(j*300));await h.send('read',h.readIx(t,j));}h.clock(s.settleAfter(h.candleState(t)));}
  else if(kind==='buyResale'||kind==='acceptBid'||kind==='fillRequestHeld'){h.clock(t.t0+300n);h.price(price,t.t0+300n);await h.send('reading',h.readIx(t,1));h.clock(t.t0+330n);h.price(price,t.t0+330n);}
  else {h.clock(ref.t0+60n);h.price(price,ref.t0+60n);}
  let ix:Instruction,payer=h.buyer;
  if(kind==='settle'){ix=h.settleIx(t);payer=h.marker;}
  else if(kind==='buyRunning')ix=h.ix('buyRunning',{...ref,until,buyerSource:h.buyerUsdc,maxPay:79000000n});
  else if(kind==='buyResale'){ix=x.buyResale(actors[1]);payer=actors[1].signer;}
  else if(kind==='acceptBid')ix=await x.accept();
  else if(kind==='fillRequestHeld'){ix=h.ix('fillRequestHeld',{...t,...request,requester:actors[1].signer.address,requesterUsdc:actors[1].usdc,holder:h.buyer,holderUsdc:h.buyerUsdc,resale:x.resale,holderSpan:h.buyerSpan,requestSpan:request.requestSpan,feed:h.feed});}
  else {const fresh=await h.ref(t.t0);ix=request.fill('running',fresh);payer=h.seller;}
  const failure=kind==='fillRequestHeld'&&bandBps!==400?'BandMismatch':kind!=='settle'&&expected===40000000n?'CapReached':undefined;
  const before=amount(h.svm,ref.vault),row=await sendBid(h,ix,payer,failure);measured(kind,actualBand,row);
  if(!failure){const name=kind==='settle'?'Settled':kind==='buyRunning'?'BoughtRunning':kind==='buyResale'?'Resold':kind==='acceptBid'?'BidAccepted':'RequestFilled',e=row.events.find(e=>e.name===name)!.data as any;
   expect(kind==='settle'?e.payout:e.recorded).toBe(expected);
   if(kind==='buyRunning'||kind==='fillRequestRunning')expect(amount(h.svm,e.ticket?e.ticket===ref.ticket?ref.vault:(await s.findVaultPda(e.ticket))[0]:ref.vault)).toBe(40000000n+expected);
   else if(kind!=='settle')expect(amount(h.svm,t.vault)).toBe(before);
   expect(s.payout({...h.candleState(ref),readHigh:price,readLow:p0},{strikeBps:100,stepBps:5,tailHigh:0n,tailLow:0n,bandBps:actualBand})).toBe(expected);
  }
 }
});

it('closing cannot redirect the stored seller or substitute the live bound ticket',async()=>{
 const h=await Harness.create(),t=await h.open({bandBps:100}),other=await h.open({t0:2400n});
 await h.send('redirect seller',h.ix('closeBand',{...t,seller:h.buyer.address,closer:h.seller}),h.seller,'ReceiverMismatch');
 await h.send('substitute ticket',h.ix('closeBand',{...t,ticket:other.ticket,seller:h.seller.address,closer:h.seller}),h.seller,'InvalidBand');
 expect(h.ticketState(t).bandBps).toBe(100);
});

it.skipIf(!process.env.SPAN_BAND_RECALCULATOR)('independent Python floor/scale/cap agrees at every integer boundary for all widths',()=>{
 const rows:any[]=[];
 for(const bandBps of [100,200,400])for(const p0 of [1000000000n,10000000007n])for(const net of [-1n,0n,1n,40000000n/BigInt(400/bandBps)-1n,40000000n/BigInt(400/bandBps),40000000n/BigInt(400/bandBps)+1n]){
  const high=p0+((10000000n+net)*p0+999999999n)/1000000000n,c={t0:1200n,readWindow:20,ageLimit:20,reads:[{price:p0,publishTs:1200n}],readHigh:high,readLow:p0},t={strikeBps:100,bandBps,tailHigh:0n,tailLow:0n,stepBps:5};
  rows.push({p0:String(p0),high:String(high),bandBps,want:String(s.payout(c,t))});
 }
 const python='import runpy,json,sys;m=runpy.run_path(sys.argv[1]);rows=json.loads(sys.argv[2]);assert all(str(m["payout"](int(x["p0"]),int(x["high"]),int(x["p0"]),100,x["bandBps"]))==x["want"] for x in rows);print(len(rows))';
 const result=spawnSync('python3',['-c',python,process.env.SPAN_BAND_RECALCULATOR!,JSON.stringify(rows)],{stdio:['ignore','pipe','pipe'],timeout:10000,encoding:'utf8'});expect(result.status,result.stderr).toBe(0);expect(Number(result.stdout)).toBe(36);
});

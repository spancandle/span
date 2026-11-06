import {expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {lamports,getBase58Decoder,getBase58Encoder,getCompiledTransactionMessageDecoder,getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import * as s from '../../program/client/index.js';
import {accountData,amount,Harness} from '../../program/tests/harness.js';
import {bidBudget,native} from '../../program/tests/bid-fixture.js';
import {Engine,BidderAccountUnavailable} from '../src/keeper/engine.js';
import {createPrepare} from '../src/keeper/main.js';
import {CLOSE_BID_UNITS} from '../src/keeper/sender.js';
import {Chain} from '../src/keeper/chain.js';
import {Store} from '../src/common/sqlite.js';
import {History,transactionEvents} from '../src/tape/history.js';
import {Publisher} from '../src/tape/publish.js';
import {DovesRecorder} from '../src/tape/doves.js';
import {liveDocuments} from '../src/tape/state.js';
import {transfersOf} from '../src/tape/transfers.js';
import {validateDocument} from './schemas.js';
import {bidRuntime} from './bid-support.js';
import {capture} from './resale-support.js';
const P0=10000000000n;
const wait=async(fn:()=>boolean)=>{const end=performance.now()+8000;while(!fn()){if(performance.now()>end)throw Error('Keeper action timeout');await new Promise(r=>setTimeout(r,5));}};
type X=Awaited<ReturnType<typeof bidRuntime>>;
async function seed(x:X){const rows=[];for(const [ixs,payer]of[[[x.h.ix('setSpan',{admin:x.h.admin,burnPerMark:100n})],x.h.admin],[[x.h.openCandleIx(x.t),x.h.openIx(x.t,1000000n)],x.h.seller],[[x.h.buyIx(x.t),x.load(x.actors[0],1000n)],x.h.buyer]]as const){const row=await x.execute([...ixs],payer);expect(row.tx.meta.err,row.tx.meta.logMessages.join('\n')).toBe(null);rows.push(row);}await x.sync();return rows;}
async function preparation(x:X){return createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:10000000000n}));}

it('decodes, polls, subscribes to and removes Bid accounts, including stale deletion rejection',async()=>{
 const x=await bidRuntime();await seed(x);const b=await x.ref();expect((await x.execute([await x.place(),await x.deposit()],x.actors[1].signer)).tx.meta.err).toBe(null);await x.sync();expect(accountData(x.h.svm,b.bid)).toHaveLength(141);expect(x.chain.bids.get(b.bid)?.value).toMatchObject({ticket:x.t.ticket,bidder:x.actors[1].signer.address,spanAmount:1000n});
 const other=await x.ref(x.actors[2]);await x.execute([await x.place(x.actors[2])],x.actors[2].signer);await x.sync();const live=liveDocuments(x.chain,{events:()=>[]}as any).tickets.tickets[0];expect(live.bids.map(b=>b.bid)).toEqual([b.bid,other.bid].sort());expect(live.bids.find(q=>q.bid===other.bid)?.span).toBe(null);
 x.chain.start('tape');const sub=x.subscriptions.find(q=>q.kind==='programSubscribe'&&q.args[1].filters[0].memcmp.bytes===getBase58Decoder().decode(s.BID_DISCRIMINATOR));expect(sub).toBeDefined();
 try{const slot=Number(x.h.svm.getClock().slot);sub.cb({context:{slot:slot-1},value:{pubkey:b.bid,account:null}});expect(x.chain.bids.has(b.bid)).toBe(true);sub.cb({context:{slot:slot+1},value:{pubkey:b.bid,account:null}});expect(x.chain.bids.has(b.bid)).toBe(false);sub.cb({context:{slot:slot+2},value:{pubkey:b.bid,account:x.raw(b.bid)}});expect(x.chain.bids.has(b.bid)).toBe(true);await x.execute([await x.close()],x.actors[1].signer);x.h.clock(1001n,BigInt(slot+10));await x.sync();expect(x.chain.bids.has(b.bid)).toBe(false);await x.execute([await x.close(x.actors[2])],x.actors[2].signer);await x.sync();expect(x.chain.bids.size).toBe(0);}finally{x.chain.close();}
});

for(const missingTicket of[false,true])it(`prepares and sends cleanup through the actual engine, missing ticket ${missingTicket}`,async()=>{
 const x=await bidRuntime();await seed(x);const to=x.actors[1],b=await x.ref();await x.execute([await x.place(to,{until:x.t.t0+100n}),await x.deposit()],to.signer);await x.sync();const prepare=await preparation(x),sent:any[]=[],engine=new Engine(x.chain,x.h.marker.address,{blockhash:()=>x.h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>sent.push(p),cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{}),action={key:`closeBid:${b.bid}`,kind:'closeBid' as const,bid:b.bid,t0:0n};
 try{engine.update();await new Promise(r=>setTimeout(r,20));expect(sent).toHaveLength(0);x.chain.tickets.clear();await expect(prepare(action,10000n)).rejects.toThrow('Bid still live');await x.sync();
  for(const ata of[to.usdc,to.span]){const original=x.h.svm.getAccount(ata);if(!original.exists)throw Error();x.h.svm.setAccount({...original,lamports:lamports(0n),data:new Uint8Array(),space:0n});x.h.clock(x.t.t0+103n);await expect(prepare(action,10000n)).rejects.toThrow('Bidder token account unavailable');x.h.svm.setAccount(original);}
  if(missingTicket){x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.execute([x.h.settleIx(x.t)]);await x.sync();}else{x.h.clock(x.t.t0+102n);engine.update();await new Promise(r=>setTimeout(r,20));expect(sent).toHaveLength(0);x.h.clock(x.t.t0+103n);}
  const sol=native(x.h,to.signer.address),usdc=amount(x.h.svm,to.usdc),span=amount(x.h.svm,to.span),rent=native(x.h,b.bid)+native(x.h,b.bidUsdc)+native(x.h,b.bidSpan);engine.update();await wait(()=>sent.length===1);expect(sent[0].action).toEqual(action);expect(sent[0].action.ticket).toBeUndefined();const msg=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(sent[0].wire,'base64')).messageBytes)as any;expect(Buffer.from(msg.instructions[0].data).readUInt32LE(1)).toBe(CLOSE_BID_UNITS);const row=capture(x.h,sent[0].wire);expect(row.tx.meta.err,row.tx.meta.logMessages.join('\n')).toBe(null);expect(native(x.h,to.signer.address)-sol).toBe(rent);expect(amount(x.h.svm,to.usdc)-usdc).toBe(40000000n);expect(amount(x.h.svm,to.span)-span).toBe(1000n);for(const k of[b.bid,b.bidUsdc,b.bidSpan])expect(x.h.svm.getAccount(k).exists).toBe(false);await x.sync();engine.update();expect(engine.pending.size).toBe(0);
 }finally{engine.close();x.chain.close();}
});

async function lifecycle(name:string,o:{before?:boolean;after?:boolean;sameState?:boolean;otherReader?:boolean}={}){
 const base=process.env.SPAN_BID_K_OUT??tmpdir();mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,name+'-')),x=await bidRuntime(),h=x.h,t=x.t,store=new Store(join(dir,'tape.sqlite')),history=new History(store,x.rpc as any,()=>{}),recorder=new DovesRecorder(store,x.rpc as any),publisher=new Publisher(store,x.chain,history,recorder,join(dir,'public')),rows:any[]=[],sent:any[]=[],errors:any[]=[];let engine:Engine;let enabled=false;
 const time=(ts:bigint)=>h.clock(ts,o.sameState?77777n:ts*4n);
 const ingest=async(row:any)=>{history.ingest(row.signature,row.tx);rows.push(row);await x.sync();};
 const driver=async(ixs:any[],payer=h.marker)=>{const row=await x.execute([...bidBudget(),...ixs],payer);expect(row.tx.meta.err,row.tx.meta.logMessages.join('\n')).toBe(null);await ingest(row);return row;};
 const prepare=await preparation(x);engine=new Engine(x.chain,h.marker.address,{blockhash:()=>h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{void(async()=>{try{const row=capture(h,p.wire);sent.push({p,row});if(row.tx.meta.err)errors.push(row.tx.meta.logMessages.join('\n'));await ingest(row);engine.result(p,row.tx.meta.err?'VMFailure':null,'signature');}catch(e){errors.push(String(e));}})();},cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 x.chain.onChange=()=>{if(enabled)engine.update();};x.chain.onFeed=()=>{if(enabled)engine.update();};
 const feed=async(price:bigint)=>{h.price(price,h.svm.getClock().unixTimestamp);await x.chain.ingestFeed(x.raw(h.feed),Number(h.svm.getClock().slot),'poll');if(enabled)engine.update();};
 let at=Date.now();const files=()=>{at+=3000;x.chain.lastReadMs=at;publisher.publish(at);const docs=Object.fromEntries(['state','tickets','history'].map(k=>[k,JSON.parse(readFileSync(join(dir,'public',k+'.json'),'utf8'))]));for(const[k,v]of Object.entries(docs))validateDocument(k,v);for(const k of['tickets','history']){const v2=JSON.parse(readFileSync(join(dir,'public/v2',k+'.json'),'utf8'));expect(v2[k]??v2.receipts).toEqual(docs[k][k]??docs[k].receipts);}return docs as any;};
 try{
  for(const row of await seed(x))await ingest(row);enabled=true;time(t.t0);await feed(P0);await wait(()=>h.candleState(t).reads[0].price===P0);time(t.t0+60n);await feed(P0*101n/100n);await wait(()=>h.ticketState(t).marks===1);enabled=false;
  if(o.before){await driver([x.list()]);await driver([x.buy(x.actors[0],x.actors[1])],x.actors[1].signer);await driver([x.load(x.actors[1],1000n)],x.actors[1].signer);}
  const holder=x.holder(),to=x.actors[o.before?2:1],other=x.actors[o.before?0:2],b=await x.ref(to);await driver([x.list(holder)]);await driver([await x.place(to),await x.deposit(to,{marker:o.otherReader?other.signer.address:h.marker.address})],to.signer);
  // A second live bid makes the ordering and nullable SPAN deposit observable.
  await driver([await x.place(other,{ask:200000n,until:t.t0+400n})],other.signer);const second=await x.ref(other),initial=files().tickets.tickets[0];expect(initial.bids.map((b:any)=>b.ask)).toEqual(['200000','100000']);expect(initial.bids[0].span).toBe(null);expect(initial.bids[1].span).toEqual({amount:'1000',stepBps:5,marker:o.otherReader?other.signer.address:h.marker.address});
  const closeResale=()=>h.ix('closeResale',{resale:x.resale,ticket:t.ticket,holder:holder.signer.address,closer:holder.signer});
  if(!o.sameState){time(t.t0+300n);h.price(P0*102n/100n,t.t0+300n);const bad=await x.execute([closeResale(),await x.accept(to)],holder.signer);expect(bad.tx.meta.err).not.toBe(null);expect(bad.tx.meta.logMessages.join('\n')).toContain('Error Code: ReadPending.');expect(h.svm.getAccount(x.resale).exists).toBe(true);}
  const old={usdc:amount(h.svm,holder.usdc),span:amount(h.svm,holder.span),sol:native(h,holder.signer.address)},bidder={usdc:amount(h.svm,to.usdc),sol:native(h,to.signer.address)},vault=amount(h.svm,t.vault),oldHold=native(h,t.spanHold),resaleRent=native(h,x.resale),bidRent=native(h,b.bid),usdcRent=native(h,b.bidUsdc),spanRent=native(h,b.bidSpan),minimum=h.svm.minimumBalanceForRentExemption(BigInt(accountData(h.svm,b.bidSpan).length)),ixs=[closeResale(),...(!o.sameState?[h.readIx(t,1)]:[]),await x.accept(to)];
  const row=await driver(ixs,holder.signer),accepted=transactionEvents(row.tx).find(e=>e.name==='BidAccepted')!.data;expect(amount(h.svm,holder.usdc)-old.usdc).toBe(accepted.paid);expect(amount(h.svm,holder.span)-old.span).toBe(accepted.spanReturned);expect(native(h,holder.signer.address)-old.sol+BigInt(row.tx.meta.fee)).toBe(oldHold+resaleRent);expect(amount(h.svm,to.usdc)-bidder.usdc).toBe(accepted.refund);expect(native(h,to.signer.address)-bidder.sol).toBe(bidRent+usdcRent+spanRent-minimum);expect(amount(h.svm,t.vault)).toBe(vault);for(const k of[b.bid,b.bidUsdc,b.bidSpan])expect(h.svm.getAccount(k).exists).toBe(false);
  let live=files().tickets.tickets[0];expect(live.spanHeld).toBe('1000');expect(live.transfers.at(-1)).toMatchObject({via:'bid',cap:'40000000',refund:String(accepted.refund),extra:'0'});
  if(o.after){await driver([x.list(to)]);await driver([x.buy(to,other)],other.signer);await driver([x.load(other,1000n)],other.signer);}
  if(o.sameState){time(t.t0+300n);h.price(P0,t.t0+300n);await driver([h.readIx(t,1)]);}
  enabled=true;time(t.t0+360n);await x.chain.pollSpanHolds('keeper');await feed(P0*103n/100n);
  if(o.otherReader){await new Promise(r=>setTimeout(r,30));expect(sent.filter(q=>q.p.action.kind==='mark')).toHaveLength(1);await driver([h.markIx(t,{marker:other.signer})],other.signer);}else await wait(()=>h.ticketState(t).marks===2);
  expect(h.ticketState(t).marks).toBe(2);expect(amount(h.svm,t.spanHold)).toBe(900n);expect(files().tickets.tickets[0].spanHeld).toBe('900');
  time(t.t0+403n);engine.update();await wait(()=>!h.svm.getAccount(second.bid).exists);expect(sent.filter(q=>q.p.action.kind==='closeBid')).toHaveLength(1);expect(files().tickets.tickets[0].bids).toEqual([]);
  for(let j=2;j<=12;j++){time(t.t0+BigInt(j)*300n);await feed(P0);await wait(()=>h.candleState(t).reads[j].price===P0);}
  time(s.settleAfter(h.candleState(t)));engine.update();await wait(()=>!h.svm.getAccount(t.ticket).exists);expect(errors).toEqual([]);const receipt=files().history.receipts.find((r:any)=>r.ticket===t.ticket);expect(BigInt(receipt.payout)).toBeGreaterThanOrEqual(accepted.recorded);expect(receipt.toSeller).toBe(String(vault-BigInt(receipt.payout)));expect(receipt.buyer).toBe(x.actors[o.after?(o.before?0:2):(o.before?2:1)].signer.address);expect(receipt.payout).toBe('30000000');expect(receipt.transfers.map((q:any)=>q.via)).toEqual([...(o.before?['resale']:[]),'bid',...(o.after?['resale']:[])]);
  if(o.sameState){const transfer=receipt.transfers;store.db.exec('DELETE FROM transactions; DELETE FROM events');for(const row of [...rows].reverse())history.ingest(row.signature,row.tx);expect(files().history.receipts[0].transfers).toEqual(transfer);}
  let recalculated:any=null;const script=resolve(import.meta.dirname,'recalculate.py');if(existsSync(script)){
   const good=spawnSync('python3',[script,join(dir,'tape.sqlite'),'--public',join(dir,'public')],{encoding:'utf8'});expect(good.status,good.stderr+good.stdout).toBe(0);recalculated=JSON.parse(good.stdout);writeFileSync(join(dir,'recalculated.json'),good.stdout);
   const sig=history.events('BidAccepted')[0].sig,original=(store.db.prepare('SELECT raw FROM transactions WHERE sig=?').get(sig)as any).raw;
   for(const field of['recorded','refund']as const){const tx=JSON.parse(original);for(const group of tx.meta.innerInstructions)for(const ix of group.instructions){const data=Buffer.from(getBase58Encoder().encode(ix.data));if(data.subarray(8,16).equals(Buffer.from(s.BID_ACCEPTED_EVENT_DISCRIMINATOR))){const event=s.getBidAcceptedEventDecoder().decode(data.subarray(8));ix.data=getBase58Decoder().decode(Buffer.concat([data.subarray(0,8),Uint8Array.from(s.getBidAcceptedEventEncoder().encode({...event,[field]:event[field]+1n}))]));}}
    store.db.prepare('UPDATE transactions SET raw=? WHERE sig=?').run(JSON.stringify(tx),sig);try{const bad=spawnSync('python3',[script,join(dir,'tape.sqlite'),'--public',join(dir,'public')],{encoding:'utf8'});expect(bad.status).not.toBe(0);expect(bad.stderr).toContain(field==='refund'?'bid refund':'resale paid');writeFileSync(join(dir,`tamper-${field}-rejected.txt`),bad.stderr);}finally{store.db.prepare('UPDATE transactions SET raw=? WHERE sig=?').run(original,sig);}
   }
  }
  const result={name,dir,recorded:String(accepted.recorded),payout:receipt.payout,toSeller:receipt.toSeller,transfers:receipt.transfers,marks:receipt.marks,burned:receipt.burned,acceptCu:row.tx.meta.computeUnitsConsumed,acceptBytes:Buffer.from(getTransactionEncoder().encode(await h.transaction([...bidBudget(),...ixs],holder.signer))).length,recalculated};writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');if(process.env.SPAN_BID_K_OUT)appendFileSync(join(base,'results.jsonl'),JSON.stringify(result)+'\n');
 }finally{engine.close();x.chain.close();store.close();}
}
for(const[name,options]of[['one-bid',{}],['resale-bid',{before:true,sameState:true}],['bid-resale',{after:true,sameState:true}],['other-reader',{otherReader:true}]]as const)it(`production bid lifecycle: ${name}`,()=>lifecycle(name,options),60000);

for(const secs of[3600n,1800n])it.skipIf(!process.env.SPAN_BID_PREVIOUS_BINARY||!process.env.SPAN_BID_PREVIOUS_KEEPER)(`retains every prior public value on the ${secs}-second preceding binary`,async()=>{
 const previous=process.env.SPAN_BID_PREVIOUS_KEEPER!,h=await Harness.create({binary:process.env.SPAN_BID_PREVIOUS_BINARY}),t=await h.ref(secs===1800n?1203n:1200n),resale=(await s.findResalePda(t.ticket))[0],dir=mkdtempSync(join(tmpdir(),'span-bid-previous-')),store=new Store(join(dir,'tape.sqlite'));
 const raw=(key:any)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;},rpc={cluster:'mainnet',call:async(method:string,args:any[])=>{if(method==='getAccountInfo')return{context:{slot:1},value:raw(args[0])};if(method==='getMultipleAccounts')return{context:{slot:1},value:args[0].map(raw)};if(method==='getMinimumBalanceForRentExemption')return Number(h.svm.minimumBalanceForRentExemption(BigInt(args[0])));throw Error(method);}},chain=new Chain(rpc as any,{subscribe:()=>()=>{},close:()=>{}}as any,()=>{},h.marker.address),history=new History(store,rpc as any,()=>{}),recorder=new DovesRecorder(store,rpc as any),oldState=await import(pathToFileURL(resolve(previous,'src/tape/state.ts')).href),oldPublisher=await import(pathToFileURL(resolve(previous,'src/tape/publish.ts')).href),before=new oldPublisher.Publisher(store,chain,history,recorder,join(dir,'old'),()=>0,[t.t0]),after=new Publisher(store,chain,history,recorder,join(dir,'new'),()=>0,[t.t0]);
 chain.configKey=h.config;chain.now=()=>h.svm.getClock().unixTimestamp;h.svm.withBlockhashCheck(false);
 const sync=()=>{chain.config=h.configState();for(const[kind,key]of[['candle',t.candle],['ticket',t.ticket],['resale',resale]]as const)chain.ingest(kind,key,raw(key),Number(h.svm.getClock().slot));};
 const execute=async(ixs:any[],payer=h.marker)=>{const tx=await h.transaction(ixs,payer),row=capture(h,Buffer.from(getTransactionEncoder().encode(tx)).toString('base64'));expect(row.tx.meta.err,row.tx.meta.logMessages.join('\n')).toBe(null);history.ingest(row.signature,row.tx);sync();};
 const {beforeBid}=await import('./bid-compat.js');let engine:Engine|undefined;
 try{
  await execute([h.ix('setSpan',{admin:h.admin,burnPerMark:100n})],h.admin);await execute([h.openCandleIx(t),h.openIx(t,1000000n)],h.seller);await execute([h.buyIx(t),h.loadIx(t)],h.buyer);h.clock(t.t0);h.price(P0,t.t0);await execute([h.readIx(t,0)]);h.clock(t.t0+60n);h.price(P0*101n/100n,t.t0+60n);await execute([h.markIx(t)]);await execute([h.ix('listResale',{...t,resale,holder:h.buyer,ask:100000n,until:t.t0+secs})],h.buyer);
  vi.spyOn(Date,'now').mockReturnValue(1800000000000);for(const v of[1,2]as const)expect(beforeBid(liveDocuments(chain,history,()=>0,v))).toEqual(oldState.liveDocuments(chain,history,()=>0,v));
  const prepare=await createPrepare(rpc as any,h.marker,chain,{register:()=>{}},()=>({blockhash:h.svm.latestBlockhash(),lastValidBlockHeight:10000000000n})),sent:any[]=[],errors:any[]=[];
  engine=new Engine(chain,h.marker.address,{blockhash:()=>h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{const row=capture(h,p.wire);sent.push(p);if(row.tx.meta.err)errors.push(row.tx.meta.logMessages.join('\n'));history.ingest(row.signature,row.tx);sync();engine!.result(p,row.tx.meta.err?'VMFailure':null,'signature');},cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
  h.clock(s.settleAfter(h.candleState(t)));engine.update();await wait(()=>!h.svm.getAccount(t.ticket).exists);engine.update();await wait(()=>!h.svm.getAccount(resale).exists);expect(errors).toEqual([]);expect(sent.map(p=>p.action.kind)).toEqual(['settle','closeResale']);expect(chain.bids.size).toBe(0);
  recorder.startRecording(Number(t.t0)-120);recorder.sample('read',P0,t.t0,1);recorder.sample('mark',P0*101n/100n,t.t0+60n,2);recorder.closeGaps();recorder.cover(Number(t.t0)+Number(secs)+120);before.publish();after.publish();
  for(const prefix of['','v2/'])for(const file of['state.json','tickets.json','feed.json','history.json','hours.json',`candles/${t.t0}.json`]){const oldFile=join(dir,'old',prefix,file),newFile=join(dir,'new',prefix,file);if(!existsSync(oldFile)){expect(existsSync(newFile)).toBe(false);continue;}const a=JSON.parse(readFileSync(oldFile,'utf8')),b=JSON.parse(readFileSync(newFile,'utf8'));expect(beforeBid(b)).toEqual(a);}
 }finally{vi.restoreAllMocks();engine?.close();chain.close();store.close();}
},30000);

async function cleanupRetryFixture(){
 const x=await bidRuntime();await seed(x);const bidder=x.actors[1],b=await x.ref();
 const placed=await x.execute([await x.place(bidder,{until:x.t.t0+100n}),await x.deposit()],bidder.signer);expect(placed.tx.meta.err).toBe(null);await x.sync();x.h.clock(x.t.t0+103n);
 const actual=await preparation(x),sent:ReturnType<typeof capture>[]=[],prepareAt:number[]=[];let wall=1800000000000,completed=0,engine:Engine;
 const prepare=vi.fn(async(...args:Parameters<typeof actual>)=>{prepareAt.push(wall);try{return await actual(...args);}finally{completed++;}});
 vi.spyOn(Date,'now').mockImplementation(()=>wall);x.rpc.call.mockClear();
 engine=new Engine(x.chain,x.h.marker.address,{blockhash:()=>x.h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{
  const row=capture(x.h,p.wire);sent.push(row);x.chain.ingest('bid',b.bid,x.raw(b.bid),Number(x.h.svm.getClock().slot));engine.result(p,row.tx.meta.err?'VMFailure':null,'signature');
 },cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 const tick=async(offset:number)=>{
  wall=1800000000000+offset;engine.update();const end=performance.now()+5000;
  do{await new Promise<void>(r=>setImmediate(r));if(performance.now()>end)throw Error('Preparation did not finish');}while(completed<prepare.mock.calls.length);
  await new Promise<void>(r=>setImmediate(r));
 };
 let elapsed=0;const advance=async(offset:number)=>{for(;elapsed<=offset;elapsed+=50)await tick(elapsed);};
 const metrics=()=>({preparations:prepare.mock.calls.length,rpc:x.rpc.call.mock.calls.length,sent:sent.length,prepareAt:prepareAt.map(at=>at-1800000000000)});
 const report=(name:string)=>{const result={name,...metrics()};console.log('BID_CLEANUP_RETRY',JSON.stringify(result));if(process.env.SPAN_BID_RETRY_OUT)appendFileSync(process.env.SPAN_BID_RETRY_OUT,JSON.stringify(result)+'\n');return result;};
 const close=()=>{engine.close();x.chain.close();vi.restoreAllMocks();};
 return{...x,b,bidder,prepare,sent,advance,tick,metrics,report,closeRetry:close};
}

for(const kind of['missing-usdc','missing-span','frozen-usdc']as const)it(`cleanup retry: ${kind} uses at most one preparation during sixty seconds`,async()=>{
 const x=await cleanupRetryFixture();try{
  const key=kind==='missing-span'?x.bidder.span:x.bidder.usdc,original=x.h.svm.getAccount(key);if(!original.exists)throw Error();
  if(kind==='frozen-usdc'){const data=Buffer.from(original.data);data[108]=2;x.h.svm.setAccount({...original,data});}
  else x.h.svm.setAccount({...original,lamports:lamports(0n),data:new Uint8Array(),space:0n});
  await x.advance(60000);const result=x.report(kind);expect(result.preparations).toBe(1);expect(result.rpc).toBeLessThanOrEqual(4);expect(result.sent).toBe(0);
 }finally{x.closeRetry();}
});

it('cleanup retry: a restored ATA closes once after ten minutes and refunds every asset and rent',async()=>{
 const x=await cleanupRetryFixture();try{
  const original=x.h.svm.getAccount(x.bidder.usdc);if(!original.exists)throw Error();x.h.svm.setAccount({...original,lamports:lamports(0n),data:new Uint8Array(),space:0n});await x.advance(60000);expect(x.metrics()).toMatchObject({preparations:1,rpc:3,sent:0});x.h.svm.setAccount(original);
  const usdc=amount(x.h.svm,x.bidder.usdc),span=amount(x.h.svm,x.bidder.span),sol=native(x.h,x.bidder.signer.address),rent=native(x.h,x.b.bid)+native(x.h,x.b.bidUsdc)+native(x.h,x.b.bidSpan);
  await x.advance(599950);expect(x.metrics()).toMatchObject({preparations:1,rpc:3,sent:0});await x.advance(601000);const result=x.report('restored-after-ten-minutes');expect(result.preparations).toBe(2);expect(result.rpc).toBe(7);expect(result.sent).toBe(1);expect(result.prepareAt).toEqual([0,600000]);expect(x.sent[0].tx.meta.err).toBe(null);expect(amount(x.h.svm,x.bidder.usdc)-usdc).toBe(40000000n);expect(amount(x.h.svm,x.bidder.span)-span).toBe(1000n);expect(native(x.h,x.bidder.signer.address)-sol).toBe(rent);for(const key of[x.b.bid,x.b.bidUsdc,x.b.bidSpan])expect(x.h.svm.getAccount(key).exists).toBe(false);
 }finally{x.closeRetry();}
},30000);

it('cleanup retry: a transient RPC failure still retries after two seconds',async()=>{
 const x=await cleanupRetryFixture();try{
  x.rpc.call.mockImplementationOnce(async()=>{throw Error('Temporary RPC failure');});await x.advance(1950);expect(x.metrics()).toMatchObject({preparations:1,rpc:1,sent:0});await x.advance(2050);const result=x.report('transient-rpc');expect(result.preparations).toBe(2);expect(result.rpc).toBe(5);expect(result.sent).toBe(1);expect(result.prepareAt).toEqual([0,2000]);expect(x.sent[0].tx.meta.err).toBe(null);for(const key of[x.b.bid,x.b.bidUsdc,x.b.bidSpan])expect(x.h.svm.getAccount(key).exists).toBe(false);
 }finally{x.closeRetry();}
});

it('cleanup retry: malformed, mismatched and non-initialized destinations share the typed error',async()=>{
 const x=await cleanupRetryFixture();try{
  const action={kind:'closeBid' as const,key:`closeBid:${x.b.bid}`,bid:x.b.bid,t0:0n};
  for(const kind of['short','program','mint','owner','uninitialized','invalid-state','frozen-span']as const){
   const key=kind==='frozen-span'?x.bidder.span:x.bidder.usdc,original=x.h.svm.getAccount(key);if(!original.exists)throw Error();
   const data=Buffer.from(original.data);
   if(kind==='mint')data[0]^=1;
   if(kind==='owner')data[32]^=1;
   if(kind==='uninitialized')data[108]=0;
   if(kind==='invalid-state')data[108]=255;
   if(kind==='frozen-span')data[108]=2;
   const malformed=kind==='short'?data.subarray(0,164):data;
   x.h.svm.setAccount({...original,data:malformed,space:BigInt(malformed.length),...(kind==='program'?{programAddress:x.h.config}:{})});
   try{await expect(x.prepare(action,10000n),kind).rejects.toBeInstanceOf(BidderAccountUnavailable);}finally{x.h.svm.setAccount(original);}
  }
  expect(x.sent).toEqual([]);
 }finally{x.closeRetry();}
});

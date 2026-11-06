import {beforeBid} from './bid-compat.js';
import {expect,it,vi} from 'vitest';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {getCompiledTransactionMessageDecoder,getTransactionDecoder,getBase58Decoder,getBase58Encoder,getTransactionEncoder} from '@solana/kit';
import {getTransferCheckedInstruction} from '@solana-program/token';
import * as s from '../../program/client/index.js';
import {TOKEN} from '../../program/client/constants.js';
import {Harness,amount,accountData} from '../../program/tests/harness.js';
import {Engine} from '../src/keeper/engine.js';
import {createPrepare} from '../src/keeper/main.js';
import {Chain,spanHeld} from '../src/keeper/chain.js';
import {Store} from '../src/common/sqlite.js';
import {History} from '../src/tape/history.js';
import {Publisher} from '../src/tape/publish.js';
import {DovesRecorder} from '../src/tape/doves.js';
import {liveDocuments,tapeSpanHeld} from '../src/tape/state.js';
import {orderResales,transfersOf} from '../src/tape/transfers.js';
import {validateDocument} from './schemas.js';
import {resaleRuntime,capture} from './resale-support.js';
const P0=10000000000n;
type Runtime=Awaited<ReturnType<typeof resaleRuntime>>;
async function seed(x:Runtime,loaded=true){
 const rows=[];for(const [ixs,payer]of[[[x.h.ix('setSpan',{admin:x.h.admin,burnPerMark:100n})],x.h.admin],[[x.h.openCandleIx(x.t),x.h.openIx(x.t,1000000n)],x.h.seller],[[x.h.buyIx(x.t),...(loaded?[x.load(x.actors[0],1000n)]:[])],x.actors[0].signer]]as const){const row=await x.execute([...ixs],payer);expect(row.tx.meta.err).toBe(null);rows.push(row);}x.sync();return rows;
}
const wait=async(fn:()=>boolean)=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Action did not complete');await new Promise(r=>setTimeout(r,5));}};
it('polls, subscribes to and removes Resale accounts while rejecting stale subscription slots',async()=>{
 const x=await resaleRuntime();await seed(x);expect((await x.execute([x.list()])).tx.meta.err).toBe(null);await x.chain.pollPrograms();expect(x.chain.resales.get(x.resale)?.value).toMatchObject({ticket:x.t.ticket,holder:x.actors[0].signer.address,ask:100000n});
 x.chain.start('tape');const subscription=x.subscriptions.find(q=>q.kind==='programSubscribe'&&q.args[1].filters[0].memcmp.bytes===getBase58Decoder().decode(s.RESALE_DISCRIMINATOR));expect(subscription).toBeDefined();
 try{const slot=Number(x.h.svm.getClock().slot);subscription.cb({context:{slot:slot-1},value:{pubkey:x.resale,account:null}});expect(x.chain.resales.has(x.resale)).toBe(true);subscription.cb({context:{slot:slot+1},value:{pubkey:x.resale,account:null}});expect(x.chain.resales.has(x.resale)).toBe(false);subscription.cb({context:{slot:slot+2},value:{pubkey:x.resale,account:x.raw(x.resale)}});expect(x.chain.resales.has(x.resale)).toBe(true);
  await x.execute([x.h.ix('closeResale',{resale:x.resale,ticket:x.t.ticket,holder:x.actors[0].signer.address,closer:x.actors[0].signer})]);x.h.clock(1001n,BigInt(slot+10));await x.chain.pollPrograms();expect(x.chain.resales.has(x.resale)).toBe(false);
 }finally{x.chain.close();}
});
it('reaches the actual closeResale prepare and VM send with no ticket field, config, candle or feed',async()=>{
 const x=await resaleRuntime();await seed(x);await x.execute([x.list()]);x.sync();x.h.clock(s.settleAfter(x.h.candleState(x.t)));await x.execute([x.h.settleIx(x.t)]);x.chain.tickets.clear();x.chain.candles.clear();x.chain.config=undefined;Object.defineProperty(x.chain,'feed',{get:()=>{throw Error('Unexpected feed lookup');}});
 const prepare=await createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:10000000000n})),sent:any[]=[],engine=new Engine(x.chain,x.h.marker.address,{blockhash:()=>x.h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>sent.push(p),cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 try{engine.update();await wait(()=>sent.length===1);const p=sent[0];expect(p.action).toEqual({kind:'closeResale',key:`closeResale:${x.resale}`,resale:x.resale,t0:0n});expect(p.action.ticket).toBeUndefined();const message=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(p.wire,'base64')).messageBytes)as any;expect(Buffer.from(message.instructions[0].data).readUInt32LE(1)).toBe(20000);expect(x.rpc.call.mock.calls.some(a=>a[0]==='getAccountInfo'&&a[1][0]===x.t.ticket&&a[1][1].commitment==='confirmed')).toBe(true);const executed=capture(x.h,p.wire);expect(executed.tx.meta.err).toBe(null);expect(x.h.svm.getAccount(x.resale).exists).toBe(false);x.chain.resales.clear();engine.update();expect(engine.pending.size).toBe(0);
 }finally{engine.close();x.chain.close();}
});
it('rejects preparation when a confirmed ticket exists despite a missing local entry',async()=>{
 const x=await resaleRuntime();await seed(x);await x.execute([x.list()]);x.sync();x.chain.tickets.clear();const prepare=await createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:10000000000n}));try{await expect(prepare({kind:'closeResale',key:`closeResale:${x.resale}`,resale:x.resale,t0:0n},10000n)).rejects.toThrow('Ticket still present');}finally{x.chain.close();}
});

async function scenario(name:string,o:{two?:boolean;sameSlot?:boolean;reverse?:boolean;reload?:boolean;cycle?:boolean}={}){
 const base=process.env.SPAN_RESALE_K_OUT??tmpdir();mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,name+'-')),x=await resaleRuntime(),store=new Store(join(dir,'tape.sqlite')),history=new History(store,x.rpc as any,()=>{}),recorder=new DovesRecorder(store,x.rpc as any),publisher=new Publisher(store,x.chain,history,recorder,join(dir,'public'));const captured:any[]=[],sent:any[]=[],errors:any[]=[];let engine:Engine;
 const time=(n:bigint)=>x.h.clock(n,o.sameSlot?77777n:n*4n);
 const ingest=(row:any)=>{history.ingest(row.signature,row.tx);captured.push(row);x.sync();};
 const driver=async(ixs:any[],payer=x.h.marker)=>{const row=await x.execute(ixs,payer);expect(row.tx.meta.err,row.tx.meta.logMessages.join('\n')).toBe(null);ingest(row);return row;};
 const prepare=await createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:10000000000n}));
 engine=new Engine(x.chain,x.h.marker.address,{blockhash:()=>x.h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{try{const row=capture(x.h,p.wire);sent.push({p,row});if(row.tx.meta.err)errors.push(row.tx.meta.logMessages.join('\n'));ingest(row);engine.result(p,row.tx.meta.err?'VMFailure':null,'signature');}catch(error){errors.push(error);}},cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 x.chain.onChange=()=>engine.update();x.chain.onFeed=()=>engine.update();
 const feed=async(price:bigint)=>{x.h.price(price,x.h.svm.getClock().unixTimestamp);await x.chain.ingestFeed(x.raw(x.h.feed),Number(x.h.svm.getClock().slot),'poll');};
 let publishAt=Date.now();const files=()=>{publishAt+=3000;x.chain.lastReadMs=publishAt;publisher.publish(publishAt);const docs={state:JSON.parse(readFileSync(join(dir,'public/state.json'),'utf8')),tickets:JSON.parse(readFileSync(join(dir,'public/tickets.json'),'utf8')),history:JSON.parse(readFileSync(join(dir,'public/history.json'),'utf8'))};for(const[k,v]of Object.entries(docs))validateDocument(k,v);return docs;};
 try{
  time(1000n);for(const row of await seed(x))ingest(row);time(x.t.t0);await feed(P0);await wait(()=>x.h.candleState(x.t).reads[0].price===P0);time(x.t.t0+60n);await feed(P0*101n/100n);await wait(()=>x.h.ticketState(x.t).marks===1);
  await driver([x.list()]);expect(files().tickets.tickets[0].resale).toEqual({holder:x.actors[0].signer.address,ask:'100000',until:String(x.t.t0+3600n)});
  time(x.t.t0+300n);x.h.price(P0*102n/100n,x.t.t0+300n);const negative=await x.execute([x.buy()]);expect(negative.tx.meta.logMessages.join('\n')).toContain('Error Code: ReadPending.');expect(negative.tx.meta.err).not.toBe(null);
  const vault=amount(x.h.svm,x.t.vault),usdc=amount(x.h.svm,x.actors[0].usdc),span=amount(x.h.svm,x.actors[0].span),holder=x.h.svm.getAccount(x.actors[0].signer.address),hold=x.h.svm.getAccount(x.t.spanHold),offer=x.h.svm.getAccount(x.resale);if(!holder.exists||!hold.exists||!offer.exists)throw Error();
  await driver([x.h.readIx(x.t,1),x.buy()],x.actors[1].signer);const after=x.h.svm.getAccount(x.actors[0].signer.address);if(!after.exists)throw Error();expect(amount(x.h.svm,x.actors[0].usdc)-usdc).toBe(20100000n);expect(amount(x.h.svm,x.actors[0].span)-span).toBe(900n);expect(after.lamports-holder.lamports).toBe(hold.lamports+offer.lamports);expect(amount(x.h.svm,x.t.vault)).toBe(vault);
  expect((await x.execute([x.h.markIx(x.t)])).tx.meta.logMessages.join('\n')).toContain('Error Code: NotLoaded.');let current=x.actors[1];
  if(o.two){time(x.t.t0+301n);await driver([x.list(current)]);const next=o.cycle?x.actors[0]:x.actors[2];await driver([x.buy(current,next)],next.signer);current=next;}
  let live=files().tickets.tickets[0];expect(live.transfers).toHaveLength(o.two?2:1);expect(live.resale).toBe(null);expect(live.spanHeld).toBe('0');
  if(o.reload!==false){time(x.t.t0+360n);await driver([x.load(current,100n)],current.signer);live=files().tickets.tickets[0];expect(live.spanHeld).toBe('100');expect(spanHeld(x.h.ticketState(x.t))).toBe(0n);await feed(P0*103n/100n);expect(x.h.ticketState(x.t).marks).toBe(1);await x.chain.pollSpanHolds('keeper');await wait(()=>x.h.ticketState(x.t).marks===2);}
  await driver([x.list(current)]);expect((await x.execute([x.h.ix('closeResale',{resale:x.resale,ticket:x.t.ticket,holder:current.signer.address,closer:x.actors.find(a=>a!==current)!.signer})])).tx.meta.logMessages.join('\n')).toContain('Error Code: NotHolder.');
  for(let j=2;j<13;j++){time(x.t.t0+BigInt(j)*300n);await feed(P0);await wait(()=>x.h.candleState(x.t).reads[j].price===P0);}
  time(s.settleAfter(x.h.candleState(x.t)));engine.update();await wait(()=>!x.h.svm.getAccount(x.resale).exists);expect(errors).toEqual([]);const docs=files(),receipt=docs.history.receipts.find((r:any)=>r.ticket===x.t.ticket);expect(receipt.payout).toBe(o.reload===false?'20000000':'30000000');expect(receipt.toSeller).toBe(String(vault-BigInt(receipt.payout)));expect(receipt.buyer).toBe(current.signer.address);expect(receipt.transfers).toHaveLength(o.two?2:1);expect(receipt.burned).toBe(o.reload===false?'100':'200');expect(receipt.markLog).toHaveLength(o.reload===false?1:2);expect(sent.filter(q=>q.p.action.kind==='read')).toHaveLength(12);expect(sent.filter(q=>q.p.action.kind==='closeResale')).toHaveLength(1);
  if(o.sameSlot)expect(new Set(captured.map(r=>r.tx.slot)).size).toBe(1);
  if(o.reverse){store.db.exec('DELETE FROM events; DELETE FROM transactions');for(const row of [...captured].reverse())history.ingest(row.signature,row.tx);const reversed=files().history.receipts.find((r:any)=>r.ticket===x.t.ticket);expect(reversed.transfers).toEqual(receipt.transfers);expect(reversed.payout).toBe(receipt.payout);}
  const verifier=resolve(import.meta.dirname,'recalculate.py');let recalculated:any=null;if(existsSync(verifier)){const run=spawnSync('python3',[verifier,join(dir,'tape.sqlite'),'--public',join(dir,'public')],{encoding:'utf8'});expect(run.status,run.stderr+run.stdout).toBe(0);recalculated=JSON.parse(run.stdout);writeFileSync(join(dir,'recalculated.json'),JSON.stringify(recalculated,null,2)+'\n');
   if(name==='one-resale'){
    const sig=history.events('Resold')[0].sig,original=(store.db.prepare('SELECT raw FROM transactions WHERE sig=?').get(sig)as any).raw,tx=JSON.parse(original);let changed=0;
    for(const group of tx.meta.innerInstructions)for(const ix of group.instructions){const bytes=Buffer.from(getBase58Encoder().encode(ix.data));if(bytes.subarray(8,16).equals(Buffer.from(s.RESOLD_EVENT_DISCRIMINATOR))){const event=s.getResoldEventDecoder().decode(bytes.subarray(8));ix.data=getBase58Decoder().decode(Buffer.concat([bytes.subarray(0,8),Uint8Array.from(s.getResoldEventEncoder().encode({...event,recorded:event.recorded+1n}))]));changed++;}}
    expect(changed).toBe(1);store.db.prepare('UPDATE transactions SET raw=? WHERE sig=?').run(JSON.stringify(tx),sig);
    try{const bad=spawnSync('python3',[verifier,join(dir,'tape.sqlite'),'--public',join(dir,'public')],{encoding:'utf8'});expect(bad.status).not.toBe(0);expect(bad.stderr).toContain('resale paid');writeFileSync(join(dir,'tamper-rejected.json'),JSON.stringify({recordedDelta:1,status:bad.status,error:'resale paid'})+'\n');}finally{store.db.prepare('UPDATE transactions SET raw=? WHERE sig=?').run(original,sig);}
   }
  }
  const summary={name,dir,payout:receipt.payout,toSeller:receipt.toSeller,transfers:receipt.transfers,marks:receipt.marks,burned:receipt.burned,recalculated};if(process.env.SPAN_RESALE_K_OUT)appendFileSync(join(base,'results.jsonl'),JSON.stringify(summary)+'\n');console.log('RESALE_K6',JSON.stringify(summary));
 }finally{engine.close();x.chain.close();store.close();}
}
for(const[name,options]of[
 ['one-resale',{reload:true}],['two-resales',{two:true,reload:true}],['same-slot-marks',{sameSlot:true,reload:true}],['reverse-collection',{sameSlot:true,reverse:true,reload:true}],['same-slot-chain',{sameSlot:true,two:true,reload:true}],['new-holder-unloaded',{reload:false}],['same-state-cycle',{sameSlot:true,two:true,cycle:true,reverse:true,reload:true}],
]as const)it(`production resale lifecycle: ${name}`,()=>scenario(name,options),30000);

it('connects all equal-state transfers through cycles without relying on collection order',()=>{
 const edges=[{from:'A',to:'C',sig:'1',marks:2,reads:3},{from:'A',to:'B',sig:'2',marks:2,reads:3},{from:'B',to:'A',sig:'3',marks:2,reads:3}];const sorted=orderResales(edges,'A');expect(sorted.map(x=>x.to)).toEqual(['B','A','C']);expect(orderResales([...edges].reverse(),'A')).toEqual(sorted);
});

it('recovers a stale pre-resale holding cache after one actual SpanShort and a fresh funded balance read',async()=>{
 const x=await resaleRuntime();await seed(x);x.h.clock(x.t.t0);x.h.price(P0,x.t.t0);await x.execute([x.h.readIx(x.t,0)]);x.h.clock(x.t.t0+60n);x.h.price(P0*101n/100n,x.t.t0+60n);await x.execute([x.h.markIx(x.t)]);x.sync();await x.chain.pollSpanHolds('keeper');expect(x.chain.spanHolds.get(x.t.ticket)?.amount).toBe(900n);
 await x.execute([x.list()]);await x.execute([x.buy()],x.actors[1].signer);await x.execute([x.load(x.actors[1],100n)],x.actors[1].signer);x.sync();expect(x.chain.spanHolds.get(x.t.ticket)?.amount).toBe(900n);
 const prepare=await createPrepare(x.rpc as any,x.h.marker,x.chain,{register:()=>{}},()=>({blockhash:x.h.svm.latestBlockhash(),lastValidBlockHeight:10000000000n})),results:any[]=[];let engine:Engine;
 engine=new Engine(x.chain,x.h.marker.address,{blockhash:()=>x.h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{const row=capture(x.h,p.wire);results.push(row);x.sync();const error=row.tx.meta.err?(/Error Code: (\w+)\./.exec(row.tx.meta.logMessages.join('\n'))?.[1]??'VMFailure'):null;engine.result(p,error,'signature');},cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});x.chain.onChange=()=>engine.update();x.chain.onFeed=()=>engine.update();
 const feed=async(price:bigint)=>{x.h.price(price,x.h.svm.getClock().unixTimestamp);await x.chain.ingestFeed(x.raw(x.h.feed),Number(x.h.svm.getClock().slot),'poll');};
 try{await feed(P0*103n/100n);await wait(()=>x.h.ticketState(x.t).marks===2);expect(amount(x.h.svm,x.t.spanHold)).toBe(0n);await feed(P0*10350n/10000n);await wait(()=>results.some(r=>r.tx.meta.logMessages.join('\n').includes('Error Code: SpanShort.')));for(let n=0;n<4;n++)engine.update();expect(results.filter(r=>r.tx.meta.err)).toHaveLength(1);
  const mint=x.h.svm.getAccount(x.h.spanMint);if(!mint.exists)throw Error();const topup=getTransferCheckedInstruction({source:x.actors[1].span,mint:x.h.spanMint,destination:x.t.spanHold,authority:x.actors[1].signer,amount:100n,decimals:mint.data[44]});expect((await x.execute([topup],x.actors[1].signer)).tx.meta.err).toBe(null);engine.update();expect(x.h.ticketState(x.t).marks).toBe(2);await x.chain.pollSpanHolds('keeper');await wait(()=>x.h.ticketState(x.t).marks===3);expect(results.filter(r=>r.tx.meta.err)).toHaveLength(1);expect(x.h.ticketState(x.t).burned).toBe(300n);
 }finally{engine.close();x.chain.close();}
});

it.skipIf(!process.env.SPAN_RESALE_PREVIOUS_KEEPER||!process.env.SPAN_RESALE_PREVIOUS_BINARY)('retains every previous public value on 1.13.0 with only null offers and empty transfers added',async()=>{
 const previous=process.env.SPAN_RESALE_PREVIOUS_KEEPER,binary=process.env.SPAN_RESALE_PREVIOUS_BINARY;if(!previous||!binary)return;
 const h=await Harness.create({binary,setSpan:true}),t=await h.open({loaded:true}),chain={rpc:{cluster:'mainnet'},config:h.configState(),candles:new Map([[t.candle,{value:h.candleState(t),slot:1,data:''}]]),tickets:new Map([[t.ticket,{value:h.ticketState(t),slot:1,data:''}]]),untils:new Map(),resales:new Map(),now:()=>1300n,slot:1}as unknown as Chain,history={events:()=>[]}as any,old=await import(pathToFileURL(resolve(previous,'src/tape/state.ts')).href);vi.spyOn(Date,'now').mockReturnValue(1800000000000);
 try{const before=old.liveDocuments(chain,history),after=beforeBid(liveDocuments(chain,history));for(const row of after.tickets.tickets){expect(row.resale).toBe(null);expect(row.transfers).toEqual([]);delete(row as any).resale;delete(row as any).transfers;}expect(after).toEqual(before);
  const dir=mkdtempSync(join(tmpdir(),'span-resale-legacy-')),store=new Store(':memory:'),archive=new History(store,{cluster:'mainnet'}as any,()=>{}),recorder=new DovesRecorder(store,{cluster:'mainnet'}as any),oldPublisher=await import(pathToFileURL(resolve(previous,'src/tape/publish.ts')).href);
  const record=async(ixs:any[],payer=h.marker)=>{const tx=await h.transaction(ixs,payer),row=capture(h,Buffer.from(getTransactionEncoder().encode(tx)).toString('base64'));expect(row.tx.meta.err).toBe(null);archive.ingest(row.signature,row.tx);};
  try{h.clock(t.t0);h.price(P0,t.t0);await record([h.readIx(t,0)]);h.clock(t.t0+60n);h.price(P0*101n/100n,t.t0+60n);await record([h.markIx(t)]);chain.candles.set(t.candle,{value:h.candleState(t),slot:1,data:''});chain.tickets.set(t.ticket,{value:h.ticketState(t),slot:1,data:''});h.clock(s.settleAfter(h.candleState(t)));await record([h.settleIx(t)]);chain.now=()=>h.svm.getClock().unixTimestamp;
   recorder.startRecording(Number(t.t0)-120);recorder.sample('legacy-price',P0,t.t0,1);recorder.sample('legacy-high',P0*101n/100n,t.t0+60n,2);recorder.closeGaps();recorder.cover(Number(t.t0)+3720);
   const prior=new oldPublisher.Publisher(store,chain,archive,recorder,join(dir,'old')),current=new Publisher(store,chain,archive,recorder,join(dir,'new'));expect(current.feedDocument()).toEqual(prior.feedDocument());expect(current.hoursDocument()).toEqual(prior.hoursDocument());expect(current.candlePathBody(Number(t.t0))).toEqual(prior.candlePathBody(Number(t.t0)));const before=prior.historyDocument(),after=current.historyDocument();for(const receipt of after.receipts){expect(receipt.transfers).toEqual([]);delete receipt.transfers;}expect(after).toEqual(before);
  }finally{store.close();}
 }finally{vi.restoreAllMocks();}
});

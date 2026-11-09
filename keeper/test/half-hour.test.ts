import {beforeBid} from './bid-compat.js';
import {expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {getAddressEncoder,getBase58Decoder,getTransactionEncoder} from '@solana/kit';
import {Harness} from '../../program/tests/harness.js';
import * as s from '../../program/client/index.js';
import {SOL_FEED,BTC_FEED,ETH_FEED} from '../../program/client/constants.js';
import {Chain} from '../src/keeper/chain.js';
import {Engine} from '../src/keeper/engine.js';
import {createPrepare,releaseStarts,listedStarts} from '../src/keeper/main.js';
import {EventHoursFile,hourAt} from '../src/common/event-hours.js';
import {Store} from '../src/common/sqlite.js';
import {History} from '../src/tape/history.js';
import {DovesRecorder,ORACLE_FEEDS} from '../src/tape/doves.js';
import {Publisher} from '../src/tape/publish.js';
import {liveDocuments,legacyStart} from '../src/tape/state.js';
import {httpServer} from '../src/tape/http.js';
import {health} from '../scripts/health.js';
import {readersDocument} from '../src/common/readers.js';
import {capture} from './resale-support.js';

const feeds=[SOL_FEED,BTC_FEED,ETH_FEED],prices=[10000000000n,8000000000000n,250000000000n];
const wait=async(fn:()=>boolean)=>{const end=performance.now()+8000;while(!fn()){if(performance.now()>end)throw Error('Keeper action timeout');await new Promise(r=>setTimeout(r,5));}};

it('keeps half-hour creation off by default and expands both release and reread listed starts only when enabled',()=>{
 vi.stubEnv('KEEPER_HALF_HOURS',undefined);
 try{expect(releaseStarts([1200n],[0,1,2])).toEqual([1200n,1201n,1202n]);expect(listedStarts([1200n],[0,1,2])).toEqual([1200n]);
  vi.stubEnv('KEEPER_HALF_HOURS','1');expect(releaseStarts([1200n],[0,1,2])).toEqual([1200n,1203n,1201n,1204n,1202n,1205n]);expect(listedStarts([1200n],[1,2])).toEqual([1200n,1204n,1205n]);
  const dir=mkdtempSync(join(tmpdir(),'span-half-list-')),file=join(dir,'hours.json'),t=hourAt('2026-11-06','10:00')!,entry={date:'2026-11-06',et:'10:00',t,name:'Decision',why:'Decision due',source:'https://example.org/notice'},listed=new EventHoursFile(file,undefined,()=>{});
  writeFileSync(file,JSON.stringify({v:1,hours:[entry],hide:[]}));listed.read();expect(listedStarts(listed.t0s(),[0,1,2])).toEqual([BigInt(t-60),BigInt(t-57),BigInt(t-56),BigInt(t-55)]);
  writeFileSync(file,JSON.stringify({v:1,hours:[],hide:[]}));listed.read();expect(listedStarts(listed.t0s(),[0,1,2])).toEqual([]);
 }finally{vi.unstubAllEnvs();}
});

for(const auto of [false,true])it(`runs six real candle lifecycles through the production keeper and both tape views, automatic creation ${auto}`,async()=>{
 const base=process.env.SPAN_HALF_HOUR_OUT??tmpdir();mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,auto?'auto-':'direct-')),h=await Harness.create({setSpan:false});h.svm.withBlockhashCheck(false);
 for(const asset of [1,2]as const)h.clone(SOL_FEED,feeds[asset],data=>data.set(getAddressEncoder().encode(s.mintOf(asset)),8));
 const refs=await Promise.all(Array.from({length:6},(_,i)=>h.ref(1200n+BigInt(i),BigInt(i)))),raw=(key:any)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']}:null;};
 const rpc={cluster:'mainnet',call:async(method:string,args:any[])=>{
  const context={slot:Number(h.svm.getClock().slot)};
  if(method==='getAccountInfo')return{context,value:raw(args[0])};
  if(method==='getMultipleAccounts')return{context,value:args[0].map(raw)};
  if(method==='getMinimumBalanceForRentExemption')return Number(h.svm.minimumBalanceForRentExemption(BigInt(args[0])));
  throw Error(method);
 }},ws={subscribe:()=>()=>{},on:()=>{},start:()=>{},close:()=>{}},chain=new Chain(rpc as any,ws as any,()=>{},h.marker.address),store=new Store(join(dir,'tape.sqlite')),history=new History(store,rpc as any,()=>{}),recorder=new DovesRecorder(store,rpc as any);
 chain.config=h.configState();chain.configKey=h.config;chain.now=()=>h.svm.getClock().unixTimestamp;
 const publisher=new Publisher(store,chain,history,recorder,join(dir,'public'),()=>0,[1200n]);
 const sync=()=>{chain.config=h.configState();const slot=Number(h.svm.getClock().slot);for(const t of refs){chain.ingest('candle',t.candle,raw(t.candle),slot);chain.ingest('ticket',t.ticket,raw(t.ticket),slot);}};
 const captured:any[]=[],sent:any[]=[],errors:any[]=[];let engine:Engine;
 const ingest=(row:any)=>{if(row.tx.meta.err)throw Error(row.tx.meta.logMessages.join('\n'));captured.push(row);history.ingest(row.signature,row.tx);sync();};
 const execute=async(ixs:any[],payer=h.marker)=>{const tx=await h.transaction(ixs,payer);const row=capture(h,Buffer.from(getTransactionEncoder().encode(tx)).toString('base64'));ingest(row);return row;};
 const prepare=await createPrepare(rpc as any,h.marker,chain,{register:()=>{}},()=>({blockhash:h.svm.latestBlockhash(),lastValidBlockHeight:100000000000n}));
 vi.stubEnv('KEEPER_HALF_HOURS',auto?'1':undefined);
 engine=new Engine(chain,h.marker.address,{blockhash:()=>h.svm.latestBlockhash(),price:()=>10000n,prepare,send:p=>{try{const row=capture(h,p.wire);ingest(row);sent.push(p.action);engine.result(p,null,'signature');}catch(error){errors.push(String(error));}},cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{},auto?releaseStarts([1200n],[0,1,2]):[]);
 chain.onChange=()=>engine.update();chain.onFeed=()=>engine.update();
 const feed=async(asset:0|1|2,price:bigint,ts:bigint)=>{h.clock(ts);h.price(price,ts,feeds[asset]);recorder.sample(`sample-${asset}-${ts}`,price,ts,Number(h.svm.getClock().slot),feeds[asset]);await chain.ingestFeed(raw(feeds[asset]),Number(h.svm.getClock().slot),'poll',asset);engine.update();};
 const previous=process.env.SPAN_HALF_HOUR_PREVIOUS_KEEPER;
 let old:any,oldState:any,oldStore:Store|undefined,oldPublisher:any,oldHistory:any;
 const copyHourTransactions=()=>{
  if(!oldHistory)return;
  for(const row of captured){
   const events=store.db.prepare('SELECT raw FROM events WHERE sig=?').all(row.signature)as {raw:string}[];
   if(events.every(e=>{const v=JSON.parse(e.raw);return !('t0'in v)||legacyStart(v.t0);}))oldHistory.ingest(row.signature,row.tx);
  }
 };
 const checkBytes=()=>{
  if(!oldPublisher)return;
  const projected=Object.assign(Object.create(chain),{candles:new Map([...chain.candles].filter(([,x])=>legacyStart(x.value.t0))),tickets:new Map([...chain.tickets].filter(([,x])=>legacyStart(x.value.t0)))});
  Object.assign(oldPublisher.chain,projected);
  for(const table of ['doves','gaps','coverage','hour_reason']){oldStore!.db.exec(`DELETE FROM ${table}`);const rows=store.db.prepare(`SELECT * FROM ${table}`).all()as any[];for(const row of rows){if(table==='hour_reason'&&!legacyStart(row.t0))continue;const keys=Object.keys(row);oldStore!.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}}
  const oldDocs=oldState.liveDocuments(oldPublisher.chain,oldHistory,()=>0),newDocs=liveDocuments(chain,history,()=>0);
  expect(JSON.stringify(beforeBid(newDocs))).toBe(JSON.stringify(oldDocs));
  for(const method of ['feedDocument','hoursDocument','historyDocument'])expect(JSON.stringify((publisher as any)[method]())).toBe(JSON.stringify(oldPublisher[method]()));
  for(const t of refs.slice(0,3))expect(JSON.stringify(publisher.candlePathBody(Number(t.t0)))).toBe(JSON.stringify(oldPublisher.candlePathBody(Number(t.t0))));
 };
 const publish=()=>{const now=Date.now();chain.lastReadMs=now;publisher.publish(now);};
 try{
  await execute([h.ix('setSpan',{admin:h.admin,burnPerMark:100n})],h.admin);
  if(auto){engine.update();await wait(()=>chain.candles.size===6);expect(sent.filter(x=>x.kind==='open')).toHaveLength(6);}
  for(const t of refs){await execute([h.openCandleIx(t),h.openIx(t,1000000n)],h.seller);await execute([h.buyIx(t),h.loadIx(t)],h.buyer);}
  for(const asset of [0,1,2]as const)recorder.startRecording(1100,feeds[asset]);
  if(previous){oldState=await import(pathToFileURL(resolve(previous,'src/tape/state.ts')).href);old=await import(pathToFileURL(resolve(previous,'src/tape/publish.ts')).href);oldStore=new Store(':memory:');oldHistory=new History(oldStore,rpc as any,()=>{});oldPublisher=new old.Publisher(oldStore,Object.assign(Object.create(chain),{candles:new Map(),tickets:new Map()}),oldHistory,new DovesRecorder(oldStore,rpc as any),join(dir,'previous'),()=>0,[1200n]);}
  const events:{at:bigint;kind:'read'|'mark'|'settle';index:number;j?:number}[]=[];
  refs.forEach((t,index)=>{const last=s.lastReadOf(t.t0);for(let j=0;j<=last;j++)events.push({at:t.t0+BigInt(j)*300n+(last===6&&j===6?20n:0n),kind:'read',index,j});events.push({at:t.t0+60n,kind:'mark',index});events.push({at:t.t0+s.secsOf(t.t0)+41n,kind:'settle',index});});
  let comparedLive=false;
  for(const event of events.sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:0)){
   const t=refs[event.index],asset=s.assetOf(t.t0);h.clock(event.at);
   if(event.kind==='read'){await feed(asset,prices[asset],event.at);await wait(()=>h.candleState(t).reads[event.j!].price>0n);}
   else if(event.kind==='mark'){await feed(asset,prices[asset]*101n/100n,event.at);await wait(()=>h.ticketState(t).marks===1);}
   else{engine.update();await wait(()=>!h.svm.getAccount(t.ticket).exists);}
   expect(errors).toEqual([]);
   if(!comparedLive&&event.at>=1265n){
    copyHourTransactions();
    vi.spyOn(Date,'now').mockReturnValue(1800000000000);checkBytes();publish();const v2=publisher.versioned().feedDocument();expect(v2.candles).toHaveLength(6);expect(publisher.feedDocument().candles).toHaveLength(1);writeFileSync(join(dir,'live-views.json'),JSON.stringify({legacy:publisher.feedDocument(),v2},null,2)+'\n');vi.restoreAllMocks();comparedLive=true;
   }
  }
  for(const action of sent.filter(x=>x.kind==='read'))expect(action.j).toBeLessThanOrEqual(s.lastReadOf(action.t0));
  expect(sent.filter(x=>x.kind==='read')).toHaveLength(60);expect(sent.filter(x=>x.kind==='mark')).toHaveLength(6);expect(sent.filter(x=>x.kind==='settle')).toHaveLength(6);
  for(const asset of [0,1,2]as const){recorder.closeGaps(feeds[asset]);recorder.cover(5000,feeds[asset]);}
  for(const t of refs)store.db.prepare('INSERT OR REPLACE INTO hour_reason VALUES(?,?,?,?)').run(String(t.t0),'Decision due',h.seller.address,`reason-${t.t0}`);
  copyHourTransactions();
  h.clock(5000n);vi.spyOn(Date,'now').mockReturnValue(1800000100000);checkBytes();publish();vi.restoreAllMocks();
  const publicDir=join(dir,'public'),legacy=JSON.parse(readFileSync(join(publicDir,'history.json'),'utf8')),v2=JSON.parse(readFileSync(join(publicDir,'v2/history.json'),'utf8'));
  expect(legacy.receipts).toHaveLength(3);expect(v2.receipts).toHaveLength(6);expect(v2.candles.filter((c:any)=>c.secs===1800)).toHaveLength(3);for(const c of v2.candles)expect(c.reads).toHaveLength(c.secs/300+1);
  for(const receipt of v2.receipts)expect(receipt).toMatchObject({payout:'10000000',toSeller:'30000000',burned:'100',marks:1});
  for(const t of refs){expect(existsSync(join(publicDir,'v2/candles',`${t.t0}.json`))).toBe(true);expect(existsSync(join(publicDir,'candles',`${t.t0}.json`))).toBe(legacyStart(t.t0));}
  const script=resolve(import.meta.dirname,'recalculate.py');if(existsSync(script)){
   const good=spawnSync('python3',[script,join(dir,'tape.sqlite'),'--public',publicDir],{encoding:'utf8'});expect(good.status,good.stdout+good.stderr).toBe(0);writeFileSync(join(dir,'recalculated.json'),good.stdout);
   const file=join(publicDir,'v2/history.json'),original=readFileSync(file,'utf8');v2.candles.find((c:any)=>c.asset==='BTC').doves.high='1';writeFileSync(file,JSON.stringify(v2));try{const bad=spawnSync('python3',[script,join(dir,'tape.sqlite'),'--public',publicDir],{encoding:'utf8'});expect(bad.status).not.toBe(0);expect(bad.stderr).toContain('oracle extremes');writeFileSync(join(dir,'wrong-high-rejected.txt'),bad.stderr);}finally{writeFileSync(file,original);}
  }
  const summary={auto,dir,publicDir,reads:60,marks:6,settlements:6,legacyByteIdentical:!!oldPublisher,receipts:v2.receipts.map((r:any)=>({t0:r.t0,payout:r.payout,marks:r.marks,burned:r.burned}))};writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2)+'\n');if(process.env.SPAN_HALF_HOUR_OUT)writeFileSync(join(base,'latest.json'),JSON.stringify(summary,null,2)+'\n');console.log('HALF_HOUR',JSON.stringify(summary));
 }finally{vi.restoreAllMocks();vi.unstubAllEnvs();engine.close();chain.close();store.close();oldStore?.close();}
},90000);

it('serves only the allowed versioned paths and rejects half-hour paths under the legacy prefix',async()=>{
 const server=httpServer('/unused',async()=>Buffer.from('{"v":2}'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address()as any).port}`;
 try{for(const path of ['/v2/state.json','/v2/tickets.json','/v2/feed.json','/v2/history.json','/v2/hours.json','/v2/candles/1203.json','/candles/1200.json'])expect((await fetch(base+path)).status).toBe(200);for(const path of ['/v2/status.json','/v2/chain.json','/candles/1203.json','/candles/1204.json','/candles/1205.json','/v2/state.json?x=1'])expect((await fetch(base+path)).status).toBe(404);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

it('checks the versioned state and both versioned edge denials in health',async()=>{
 const seen:any[]=[],now=1800000000000,deps:any={now:()=>now,sleep:async()=>{},service:async()=>true,read:async(name:string)=>name==='readers.json'?readersDocument('mainnet'):({generated:now,hashAt:now,listedAt:now,feed:{recording:false},state:{lastFullMs:now,lastSlot:'1'},http:{total:{}}}),listeners:async()=>[{address:'127.0.0.1:8789'}],publicIps:async()=>['198.51.100.1'],dns:async()=>['203.0.113.1'],balance:async()=>100000000,secrets:[],fetch:async(url:string,init:any)=>{seen.push({url,init});return url.includes('?')||init?.method==='POST'||init?.headers&&!init.headers.Origin?.includes('span.press')||url.includes('nope')||url.includes('status')?new Response('denied',{status:403,headers:{'cf-ray':'test'}}):url.includes('abc.json')?new Response('missing',{status:404}):new Response(JSON.stringify(url.endsWith('/readers.json')?readersDocument('mainnet'):{generated:now}),{headers:{'cf-cache-status':'HIT',age:'0'}});}};
 const result=await health(deps,{scope:'data',data:'https://data.span.press',site:'https://span.press'});expect(result.ok,JSON.stringify(result.lines)).toBe(true);expect(seen.some(x=>x.url.endsWith('/v2/state.json')&&!x.init)).toBe(true);expect(seen.some(x=>x.url.includes('/v2/state.json?'))).toBe(true);expect(seen.some(x=>x.url.endsWith('/v2/state.json')&&x.init?.headers?.Origin?.endsWith('.invalid'))).toBe(true);
});

it('filters before receipt, withdrawal and reason limits and before selecting feed start times',async()=>{
 const h=await Harness.create(),store=new Store(':memory:'),history={events:(name:string)=>name==='Settled'||name==='Withdrawn'?[{t0:'1200',ticket:'hour'},...Array.from({length:501},(_,i)=>({t0:String(1203+i*60),ticket:`half-${i}`}))]:[]}as any;
 const make=(t0:bigint)=>({value:{t0,readWindow:20,ageLimit:20,buyCutoff:5,reads:Array.from({length:13},()=>({price:0n,publishTs:0n})),readHigh:0n,readLow:0n,bump:0},slot:1,data:''}),chain={rpc:{cluster:'mainnet'},config:h.configState(),candles:new Map([['half-sol',make(1203n)],['hour-sol',make(1260n)],['half-btc',make(1204n)],['hour-btc',make(1261n)]]),tickets:new Map(),now:()=>1400n,slot:1}as any;
 const pub=new Publisher(store,chain,history,new DovesRecorder(store,{cluster:'mainnet'}as any),mkdtempSync(join(tmpdir(),'span-half-limits-')),()=>0,[]);
 try{store.db.prepare('INSERT INTO hour_reason VALUES(?,?,?,?)').run('1200','Hour reason','holder','sig-hour');for(let i=0;i<501;i++)store.db.prepare('INSERT INTO hour_reason VALUES(?,?,?,?)').run(String(1203+i*60),'Half reason','holder',`sig-${i}`);
  const book=pub.historyDocument();expect(book.receipts).toHaveLength(1);expect(book.withdrawals).toHaveLength(1);expect(book.candles.map(c=>c.t0)).toEqual(['1200']);expect(pub.hoursDocument().hours.map(r=>r.t0)).toEqual(['1200']);
  const feed=pub.feedDocument();expect(feed.from).toBe('1260');expect(feed.assets.BTC.from).toBe('1261');expect(pub.versioned().feedDocument().from).toBe('1203');expect(pub.versioned().feedDocument().assets.BTC.from).toBe('1204');
  chain.now=()=>5000n;const scheduled=new Publisher(store,chain,{events:()=>[]}as any,new DovesRecorder(store,{cluster:'mainnet'}as any),mkdtempSync(join(tmpdir(),'span-half-scheduled-')),()=>0,[1200n]);expect(scheduled.historyDocument().candles).toEqual([]);expect(scheduled.versioned().historyDocument().candles.map(c=>c.t0).sort()).toEqual(['1203','1204']);
 }finally{store.close();}
});

it('keeps half-hour recording and holding windows bounded and refuses an extending mark published after its end',async()=>{
 const h=await Harness.create({setSpan:true}),t=await h.open({t0:1203n,loaded:true}),end=t.t0+1800n;h.svm.withBlockhashCheck(false);h.clock(t.t0);h.price(prices[0],t.t0);await h.send('open_read',h.readIx(t,0));h.clock(end);h.price(prices[0],end);await h.send('last_read',h.readIx(t,6));
 const raw=(key:any)=>{const a=h.svm.getAccount(key);return a.exists?{owner:a.programAddress,data:[Buffer.from(a.data).toString('base64'),'base64']}:null;},rpc={cluster:'mainnet',call:async(method:string,args:any[])=>method==='getMultipleAccounts'?{context:{slot:Number(h.svm.getClock().slot)},value:args[0].map(raw)}:null},chain=new Chain(rpc as any,{subscribe:()=>()=>{},on:()=>{},start:()=>{},close:()=>{}}as any,()=>{},h.marker.address);
 chain.now=()=>h.svm.getClock().unixTimestamp;chain.config=h.configState();chain.candles.set(t.candle,{value:h.candleState(t),slot:1,data:''});chain.tickets.set(t.ticket,{value:h.ticketState(t),slot:1,data:''});
 const send=vi.fn(),engine=new Engine(chain,h.marker.address,{blockhash:()=>h.svm.latestBlockhash(),price:()=>10000n,prepare:async(action,price)=>({action,price,blockhash:h.svm.latestBlockhash(),signature:'test',wire:'',lastValidBlockHeight:1000000n,rent:0n})as any,send,cancel:()=>{}},{available:()=>true,reserve:()=>true,waiting:new Set()},()=>{});
 try{h.clock(end+1n);chain.feeds.set(0,{price:prices[0]*102n/100n,publishTs:end+1n,slot:1,source:'poll',at:Date.now()}as any);engine.update();await new Promise(r=>setTimeout(r,10));expect(send).not.toHaveBeenCalled();
  h.clock(end+20n);await chain.pollSpanHolds('keeper');expect(chain.spanHolds.has(t.ticket)).toBe(true);h.clock(end+21n);await chain.pollSpanHolds('keeper');expect(chain.spanHolds.has(t.ticket)).toBe(false);
  h.clock(end+120n);expect(chain.recording(0)).toBe(true);h.clock(end+121n);expect(chain.recording(0)).toBe(false);
 }finally{engine.close();chain.close();}
});

it.skipIf(!process.env.SPAN_HALF_HOUR_PREVIOUS_KEEPER||!process.env.SPAN_HALF_HOUR_PREVIOUS_BINARY)('keeps every legacy public file byte identical on the preceding program binary',async()=>{
 const previous=process.env.SPAN_HALF_HOUR_PREVIOUS_KEEPER!,h=await Harness.create({setSpan:true,binary:process.env.SPAN_HALF_HOUR_PREVIOUS_BINARY}),t=await h.open({loaded:true}),dir=mkdtempSync(join(tmpdir(),'span-half-previous-')),store=new Store(join(dir,'tape.sqlite')),rpc={cluster:'mainnet'}as any,history=new History(store,rpc,()=>{}),recorder=new DovesRecorder(store,rpc),chain={rpc,config:h.configState(),candles:new Map([[t.candle,{value:h.candleState(t),slot:1,data:''}]]),tickets:new Map([[t.ticket,{value:h.ticketState(t),slot:1,data:''}]]),slot:1,lastReadMs:1800000000000,now:()=>5000n}as any;
 const oldState=await import(pathToFileURL(resolve(previous,'src/tape/state.ts')).href),oldPublisher=await import(pathToFileURL(resolve(previous,'src/tape/publish.ts')).href),before=new oldPublisher.Publisher(store,chain,history,recorder,join(dir,'old'),()=>0,[t.t0]),after=new Publisher(store,chain,history,recorder,join(dir,'new'),()=>0,[t.t0]);
 const execute=async(ixs:any[])=>{const tx=await h.transaction(ixs,h.marker),row=capture(h,Buffer.from(getTransactionEncoder().encode(tx)).toString('base64'));expect(row.tx.meta.err).toBe(null);history.ingest(row.signature,row.tx);};
 try{h.clock(t.t0);h.price(prices[0],t.t0);await execute([h.readIx(t,0)]);h.clock(t.t0+60n);h.price(prices[0]*101n/100n,t.t0+60n);await execute([h.markIx(t)]);chain.candles.get(t.candle).value=h.candleState(t);chain.tickets.get(t.ticket).value=h.ticketState(t);vi.spyOn(Date,'now').mockReturnValue(1800000000000);
  expect(JSON.stringify(beforeBid(liveDocuments(chain,history,()=>0)))).toBe(JSON.stringify(oldState.liveDocuments(chain,history,()=>0)));
  h.clock(s.settleAfter(h.candleState(t)));await execute([h.settleIx(t)]);chain.tickets.clear();recorder.startRecording(1100);recorder.sample('read',prices[0],t.t0,1);recorder.sample('mark',prices[0]*101n/100n,t.t0+60n,2);recorder.closeGaps();recorder.cover(5000);before.publish();after.publish();
  for(const file of ['state.json','tickets.json','feed.json','history.json','hours.json',`candles/${t.t0}.json`])expect(Buffer.from(JSON.stringify(beforeBid(JSON.parse(readFileSync(join(dir,'new',file),'utf8'))))+'\n')).toEqual(readFileSync(join(dir,'old',file)));
 }finally{vi.restoreAllMocks();store.close();}
});

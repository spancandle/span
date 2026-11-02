import { expect,it,vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getAddressEncoder,getBase58Decoder } from '@solana/kit';
import * as s from '../../program/client/index.js';
import { SOL_FEED,BTC_FEED,ETH_FEED,DOVES } from '../../program/client/constants.js';
import { mintOf,feedOf } from '../../program/client/assets.js';
import { Harness } from '../../program/tests/harness.js';
import { Chain } from '../src/keeper/chain.js';
import { Store } from '../src/common/sqlite.js';
import { DovesRecorder,ORACLE_FEEDS } from '../src/tape/doves.js';
import { decodeDovesTransaction } from '../src/tape/doves-tx.js';
import { History,transactionEvents } from '../src/tape/history.js';
import { Publisher } from '../src/tape/publish.js';
import { liveDocuments } from '../src/tape/state.js';
const prices=[9490000000n,7790511000000n,226297000000n];
const shared=(ts=1202)=>({slot:20,blockTime:ts,transaction:{message:{accountKeys:[DOVES,...ORACLE_FEEDS,'11111111111111111111111111111111'],instructions:[1,2,3,4].map(i=>({programIdIndex:0,accounts:[0,i],data:'BFFRQh5PNJx'}))}},meta:{err:null,logMessages:[...prices,1n].flatMap(p=>['Program log: Instruction: UpdateAgPrice2',`Program log: lazer price: ${p}, timestamp: ${ts}`,'Program log: updated from lazer'])}});
it('atomically migrates the old rows and cursor and preserves them on a second open',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'span-db-')),'tape.sqlite'),old=new DatabaseSync(path);
 old.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE doves(sig TEXT NOT NULL,publish_ts INTEGER NOT NULL,price TEXT NOT NULL,slot INTEGER NOT NULL,received_ms INTEGER NOT NULL,PRIMARY KEY(sig,publish_ts,price)); CREATE INDEX doves_time ON doves(publish_ts); CREATE TABLE gaps(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,reason TEXT); CREATE TABLE coverage(id INTEGER PRIMARY KEY,start_ts INTEGER,end_ts INTEGER); INSERT INTO kv VALUES('doves-cursor','old-head'),('program-cursor','span-head'); INSERT INTO doves VALUES('a',1200,'9490000000',9,123),('b',1201,'9491000000',10,124); INSERT INTO gaps VALUES(3,1200,NULL,'process-start'); INSERT INTO coverage VALUES(7,1080,1201);");old.close();
 const snapshot=(x:Store)=>Object.fromEntries(['doves','gaps','coverage','kv'].map(t=>[t,x.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
 let store=new Store(path);const once=snapshot(store);
 expect(once.doves).toEqual([{sig:'a',publish_ts:1200,price:'9490000000',slot:9,received_ms:123,feed:SOL_FEED},{sig:'b',publish_ts:1201,price:'9491000000',slot:10,received_ms:124,feed:SOL_FEED}]);
 expect(once.gaps).toEqual([{id:3,a:1200,b:null,reason:'process-start',feed:SOL_FEED}]);expect(once.coverage).toEqual([{id:7,start_ts:1080,end_ts:1201,feed:SOL_FEED}]);
 expect(store.get(`doves-cursor:${SOL_FEED}`)).toBe('old-head');expect(store.get('program-cursor')).toBe('span-head');expect(store.get('doves-cursor')).toBeUndefined();expect(store.get('oracle-feeds-v1')).toBe('1');store.close();
 store=new Store(path);expect(snapshot(store)).toEqual(once);store.close();
});
it('retains three writes of one transaction, fetches it once, and resumes three independent cursors',async()=>{
 let generation=0;const store=new Store(':memory:'),calls:any[]=[],rpc={cluster:'mainnet',call:vi.fn(async(method,params)=>{calls.push([method,params]);return method==='getTransaction'?shared():generation===2?[]:[{signature:generation===0?'shared':`head-${ORACLE_FEEDS.indexOf(params[0])}`,err:null,blockTime:1202}];})} as any;
 let recorder=new DovesRecorder(store,rpc);recorder.startRecording(1080);await recorder.poll(1202);
 expect(calls.filter(x=>x[0]==='getSignaturesForAddress').map(x=>x[1][0])).toEqual([SOL_FEED]);expect(decodeDovesTransaction(shared()).map(x=>x.feed)).toEqual([...ORACLE_FEEDS]);
 calls.length=0;recorder.startRecording(1081,BTC_FEED);recorder.startRecording(1082,ETH_FEED);await recorder.poll(1202);
 expect(calls.filter(x=>x[0]==='getTransaction')).toHaveLength(1);expect(store.db.prepare('SELECT feed,price FROM doves ORDER BY feed').all()).toEqual(ORACLE_FEEDS.map((feed,i)=>({feed,price:String(prices[i])})).sort((a,b)=>a.feed.localeCompare(b.feed)));
 for(const feed of ORACLE_FEEDS)expect(store.get(`doves-cursor:${feed}`)).toBe('shared');
 for(const feed of ORACLE_FEEDS)recorder.sample('equal-prices',1n,1202,20,feed);expect(store.db.prepare("SELECT COUNT(*) n FROM doves WHERE sig='equal-prices'").get()).toEqual({n:3});
 generation=1;await recorder.poll(1203);generation=2;recorder=new DovesRecorder(store,rpc);calls.length=0;for(const f of ORACLE_FEEDS)recorder.startRecording(1203,f);await recorder.poll(1203);
 expect(calls.filter(x=>x[0]==='getSignaturesForAddress').map(x=>x[1][1].until)).toEqual(['head-0','head-1','head-2']);store.close();
});
it('isolates oracle paths, high/low, coverage and completeness for the three different price scales',async()=>{
 const h=await Harness.create(),refs=await Promise.all(([0,1,2] as const).map(a=>h.ref(1200n+BigInt(a))));
 h.clock(1000n);for(const ref of refs)await h.send('open',h.openCandleIx(ref));
 const chain={rpc:{cluster:'mainnet'},config:h.configState(),candles:new Map(refs.map(t=>[t.candle,{value:h.candleState(t),slot:1,data:''}])),tickets:new Map(),now:()=>1300n,slot:1} as unknown as Chain;
 const store=new Store(':memory:'),rpc={cluster:'mainnet'} as any,recorder=new DovesRecorder(store,rpc),history=new History(store,rpc,()=>{}),dir=mkdtempSync(join(tmpdir(),'span-assets-')),pub=new Publisher(store,chain,history,recorder,dir,undefined,[1200n]);
 for(const [i,feed] of ORACLE_FEEDS.entries()){recorder.startRecording(1080+i,feed);recorder.sample('pre',prices[i],1080+i,19,feed);recorder.closeGaps(feed);recorder.sample('same',prices[i],1202,20,feed);recorder.closeGaps(feed);recorder.cover(5000,feed);}
 const before=pub.candlePathBody(1200);expect(before).toMatchObject({feed:SOL_FEED,asset:'SOL',p:String(prices[0]),complete:true});
 for(const [i,feed] of ORACLE_FEEDS.entries())expect(pub.doves(1202,1300,feed)).toEqual({high:String(prices[i]),low:String(prices[i]),complete:true});
 recorder.gap('BTC-only',BTC_FEED);expect(pub.candlePathBody(1201).complete).toBe(false);expect(pub.candlePathBody(1202).complete).toBe(true);expect(pub.candlePathBody(1200)).toEqual(before);
 const doc=pub.feedDocument();expect(doc.p).toBe(String(prices[0]));expect(doc.candles).toHaveLength(1);expect(doc.assets).toMatchObject({BTC:{feed:BTC_FEED,p:String(prices[1])},ETH:{feed:ETH_FEED,p:String(prices[2])}});
 const live=liveDocuments(chain,history);expect(live.state.candles.map(x=>x.asset)).toEqual(['SOL','BTC','ETH']);
 chain.now=()=>5000n;const book=pub.historyDocument();expect(book.candles.map(x=>x.asset).sort()).toEqual(['BTC','ETH','SOL']);expect(book.candles.find(x=>x.asset==='BTC')!.doves!.complete).toBe(false);expect(book.candles.find(x=>x.asset==='SOL')!.doves!.high).toBe(String(prices[0]));store.close();
});
it('attributes unchanged development events using each outer instruction feed account',async()=>{
 const keys=[s.SPAN_PROGRAM_ADDRESS,...await Promise.all(([0,1,2] as const).map(a=>feedOf(a,SOL_FEED,'devnet')))];
 const data=prices.map(p=>{const d=Buffer.alloc(32);Buffer.from([228,69,165,46,81,203,154,29]).copy(d);createHash('sha256').update('event:DevFeedUpdated').digest().copy(d,8,0,8);d.writeBigUInt64LE(p,16);d.writeBigInt64LE(1202n,24);return getBase58Decoder().decode(d);});
 const tx={slot:20,blockTime:1202,transaction:{message:{accountKeys:keys,instructions:[1,2,3].map(i=>({accounts:[0,i]}))}},meta:{err:null,innerInstructions:data.map((d,index)=>({index,instructions:[{programIdIndex:0,data:d}]}))}};
 expect(transactionEvents(tx).map(e=>[e.feed,e.data.price])).toEqual(ORACLE_FEEDS.map((f,i)=>[f,prices[i]]));
});
it('subscribes and polls only represented assets, orders slots independently, and keeps the SOL alias',async()=>{
 const h=await Harness.create(),subs:any[]=[],calls:any[]=[],raw=(key:any)=>{const a=h.svm.getAccount(key);if(!a.exists)throw Error('Missing feed');return{owner:a.programAddress,lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']};};
 for(const a of [1,2] as const)h.clone(SOL_FEED,ORACLE_FEEDS[a],d=>d.set(getAddressEncoder().encode(mintOf(a)),8));
 const chain=new Chain({cluster:'mainnet',call:async(method:string,params:any[])=>{calls.push(params[0]);return{context:{slot:10},value:raw(params[0])};}} as any,{close:()=>{},subscribe:(kind:string,args:any[],cb:any)=>{const row={key:args[0],cb,stopped:false};subs.push(row);return()=>{row.stopped=true;};}} as any,()=>{});chain.config=h.configState();
 await chain.pollFeed();expect(calls).toEqual([SOL_FEED]);expect(subs.map(x=>x.key)).toEqual([SOL_FEED]);
 const c=await h.ref();for(const a of [1,2] as const){const t=await h.ref(c.t0+BigInt(a));chain.candles.set(t.candle,{value:{...h.candleState(await h.open()),t0:t.t0},slot:1,data:''});}
 calls.length=0;await chain.pollFeed();expect(calls.sort()).toEqual([...ORACLE_FEEDS].sort());expect(subs.map(x=>x.key).sort()).toEqual([...ORACLE_FEEDS].sort());
 h.price(prices[1],1202n,BTC_FEED);await chain.ingestFeed(raw(BTC_FEED),100,'ws',1);h.price(prices[0],1203n);await chain.ingestFeed(raw(SOL_FEED),11,'poll',0);expect(chain.feed!.price).toBe(prices[0]);expect(chain.feeds.get(1)!.price).toBe(prices[1]);
 h.price(1n,1203n,BTC_FEED);await chain.ingestFeed(raw(BTC_FEED),99,'poll',1);expect(chain.feeds.get(1)!.price).toBe(prices[1]);
 h.price(999n,1204n);h.clone(SOL_FEED,ETH_FEED);await expect(chain.ingestFeed(raw(ETH_FEED),200,'ws',2)).rejects.toThrow();expect(chain.feeds.get(2)!.price).not.toBe(999n);
 chain.candles.clear();calls.length=0;await chain.pollFeed();expect(calls).toEqual([SOL_FEED]);expect(subs.filter(x=>x.key!==SOL_FEED).every(x=>x.stopped)).toBe(true);expect([...chain.feeds.keys()]).toEqual([0]);
 chain.close();
});

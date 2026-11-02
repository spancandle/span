import type { Store } from '../common/sqlite.js';
import type { RpcPool } from '../common/rpc.js';
import { SOL_FEED,BTC_FEED,ETH_FEED } from '../../../program/client/constants.js';
import { decodeDovesTransaction } from './doves-tx.js';
export const ORACLE_FEEDS=[SOL_FEED,BTC_FEED,ETH_FEED] as const;
type State={recording:boolean;lastPublishTs:number;lastSlot:number};
export class DovesRecorder {
 private busy=false;
 readonly states=new Map<string,State>();
 constructor(readonly store:Store,readonly rpc:RpcPool){
  for(const feed of ORACLE_FEEDS){const last=store.db.prepare('SELECT publish_ts,slot FROM doves WHERE feed=? ORDER BY publish_ts DESC,slot DESC LIMIT 1').get(feed) as any;
   this.states.set(feed,{recording:false,lastPublishTs:last?.publish_ts??0,lastSlot:last?.slot??0});if(last)this.gap('process-start',feed);}
 }
 private state(feed:string){const s=this.states.get(feed);if(!s)throw Error('Unknown oracle feed');return s;}
 get recording(){return this.state(SOL_FEED).recording;}
 get lastPublishTs(){return this.state(SOL_FEED).lastPublishTs;}
 get lastSlot(){return this.state(SOL_FEED).lastSlot;}
 gap(reason:string,feed:string=SOL_FEED){
  if(!this.store.db.prepare('SELECT 1 FROM gaps WHERE feed=? AND b IS NULL AND reason=?').get(feed,reason)){
   this.store.db.prepare('INSERT INTO gaps(a,b,reason,feed) VALUES(?,NULL,?,?)').run(this.state(feed).lastPublishTs,reason,feed);this.store.change();}
 }
 sample(sig:string,price:bigint|string,publishTs:bigint|number,slot:number,feed:string=SOL_FEED){
  const ts=Number(publishTs),state=this.state(feed),x=this.store.db.prepare('INSERT OR IGNORE INTO doves VALUES(?,?,?,?,?,?)').run(sig,ts,String(price),slot,Date.now(),feed);
  if(x.changes)this.store.change();if(ts>=state.lastPublishTs){state.lastPublishTs=ts;state.lastSlot=slot;}
 }
 startRecording(now:number,feed:string=SOL_FEED){const state=this.state(feed);if(state.recording)return;state.recording=true;this.gap('recording-start',feed);
  this.store.db.prepare('INSERT INTO coverage(start_ts,end_ts,feed) VALUES(?,?,?)').run(now,now,feed);this.store.change();}
 stopRecording(feed:string=SOL_FEED){const state=this.state(feed);if(state.recording&&this.rpc.cluster==='mainnet'){
  this.store.db.prepare('DELETE FROM kv WHERE key=?').run(`doves-cursor:${feed}`);if(feed===SOL_FEED)this.store.db.prepare("DELETE FROM kv WHERE key='doves-cursor'").run();}state.recording=false;}
 closeGaps(feed:string=SOL_FEED){
  const last=this.state(feed).lastPublishTs;if(!last)return;
  const coverage=this.rpc.cluster==='devnet'?this.store.db.prepare('SELECT start_ts FROM coverage WHERE feed=? ORDER BY id DESC LIMIT 1').get(feed) as {start_ts:number}|undefined:undefined;
  let changes=0;
  if(coverage){const first=this.store.db.prepare('SELECT publish_ts FROM doves WHERE feed=? AND publish_ts>=? ORDER BY publish_ts LIMIT 1').get(feed,coverage.start_ts) as {publish_ts:number}|undefined;
   if(first)changes+=Number(this.store.db.prepare('UPDATE gaps SET b=? WHERE feed=? AND b IS NULL AND a<?').run(first.publish_ts,feed,coverage.start_ts).changes);
   changes+=Number(this.store.db.prepare('UPDATE gaps SET b=? WHERE feed=? AND b IS NULL AND a>=? AND a<?').run(last,feed,coverage.start_ts,last).changes);
  }else changes=Number(this.store.db.prepare('UPDATE gaps SET b=? WHERE feed=? AND b IS NULL AND a<?').run(last,feed,last).changes);
  if(changes)this.store.change();
 }
 async poll(now=Math.floor(Date.now()/1000)){
  if(this.busy||this.rpc.cluster!=='mainnet')return;
  const active=ORACLE_FEEDS.filter(f=>this.state(f).recording);if(!active.length)return;this.busy=true;
  const bodies=new Map<string,Promise<any>>();
  try{await Promise.all(active.map(async feed=>{try{
   const last=this.store.get(`doves-cursor:${feed}`),rows:any[]=[];let before:string|undefined;
   for(;;){const batch:any[]=await this.rpc.call('getSignaturesForAddress',[feed,{commitment:'confirmed',limit:1000,...(last?{until:last}:{}),...(before?{before}:{})}],'normal',`doves-list:${feed}`);
    rows.push(...batch);if(batch.length<1000||!last)break;const next=batch.at(-1).signature;if(next===before)throw Error('Oracle pagination incomplete');before=next;}
   const relevant=last?rows:rows.filter(x=>x.blockTime!==null&&x.blockTime>=now-15),head=rows[0];
   for(const row of [...relevant].reverse()){
    if(row.err!==null)continue;
    if(!bodies.has(row.signature))bodies.set(row.signature,this.rpc.call('getTransaction',[row.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:1}],'normal','doves-body'));
    const tx=await bodies.get(row.signature);if(!tx)throw Error('Oracle transaction unavailable');
    for(const v of decodeDovesTransaction(tx))if(v.feed===feed)this.sample(row.signature,v.price,v.publish_ts,v.slot,feed);
    await new Promise(r=>setTimeout(r,80));
   }
   if(head)this.store.set(`doves-cursor:${feed}`,head.signature);this.closeGaps(feed);this.cover(now,feed);
  }catch{this.gap('listing-or-decode',feed);}}));}finally{this.busy=false;}
 }
 cover(now:number,feed:string=SOL_FEED){this.store.db.prepare('UPDATE coverage SET end_ts=? WHERE id=(SELECT MAX(id) FROM coverage WHERE feed=?)').run(now,feed);}
 prune(now:number){this.store.db.prepare('DELETE FROM doves WHERE publish_ts<?').run(now-8*86400);}
}

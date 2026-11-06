import type {History} from './history.js';

type Snapshot={from:string;to:string;marks:number;reads:number;sig:string};
const popcount=(n:number)=>{let count=0;for(;n;n&=n-1)count++;return count;};

/** A complete holder path at each recorded state; equal-state cycles need not have a unique chronology. */
export function orderResales<T extends Snapshot>(events:readonly T[],firstHolder:string):T[]{
 const groups=new Map<string,{marks:number;reads:number;events:T[]}>();
 for(const event of events){const reads=popcount(event.reads),key=`${event.marks}:${reads}`;let group=groups.get(key);if(!group){group={marks:event.marks,reads,events:[]};groups.set(key,group);}group.events.push(event);}
 let holder=firstHolder;const out:T[]=[];
 for(const group of [...groups.values()].sort((a,b)=>a.marks-b.marks||a.reads-b.reads)){
  const edges=new Map<string,T[]>();
  for(const event of group.events){const list=edges.get(event.from)??[];list.push(event);edges.set(event.from,list);}
  for(const list of edges.values())list.sort((a,b)=>a.to<b.to?1:a.to>b.to?-1:a.sig<b.sig?1:a.sig>b.sig?-1:0);
  const nodes=[holder],stack:T[]=[],reverse:T[]=[];
  while(nodes.length){const edge=edges.get(nodes.at(-1)!)?.pop();if(edge){nodes.push(edge.to);stack.push(edge);}else{nodes.pop();const previous=stack.pop();if(previous)reverse.push(previous);}}
  const path=reverse.reverse();
  if(path.length!==group.events.length)throw Error('Incomplete holder path');
  for(const edge of path){if(edge.from!==holder)throw Error('Disconnected holder path');out.push(edge);holder=edge.to;}
 }
 return out;
}

export function resaleEventsOf(history:Pick<History,'events'>,ticket:string){
 const events=[...history.events('Resold').map(e=>({...e,via:'resale' as const})),...history.events('BidAccepted').map(e=>({...e,via:'bid' as const}))].filter(e=>e.ticket===ticket);
 if(!events.length)return [];
 const purchase=[...history.events('Bought'),...history.events('BoughtRunning')].find(e=>e.ticket===ticket);
 if(!purchase)throw Error('Initial buyer unavailable');
 return orderResales(events,purchase.buyer);
}
export function transfersOf(history:Pick<History,'events'>,ticket:string){
 return resaleEventsOf(history,ticket).map(e=>({sig:e.sig,at:e.blockTime,from:e.from,to:e.to,ask:e.ask,recorded:e.recorded,paid:e.paid,spanReturned:e.spanReturned,via:e.via,...(e.via==='bid'?{cap:e.cap,refund:e.refund,extra:e.extra}:{})}));
}

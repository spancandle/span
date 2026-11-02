import { getProgramDerivedAddress, type Address } from '@solana/kit';
import { SPAN_PROGRAM_ADDRESS } from './src/generated/index.js';
import { SOL, BTC_MINT, ETH_MINT, BTC_FEED, ETH_FEED } from './constants.js';
export const ASSETS = ['SOL','BTC','ETH'] as const;
export type Asset = 0|1|2;
const checked=(asset:number):Asset=>{if(!Number.isInteger(asset)||asset<0||asset>=ASSETS.length)throw Error('Invalid asset');return asset as Asset;};
export function assetOf(t0:bigint|number):Asset {
 if(typeof t0==='number'&&!Number.isSafeInteger(t0))throw Error('Invalid start');
 const t=BigInt(t0);return checked(Number((t%60n+60n)%60n));
}
export const nameOf=(asset:Asset)=>ASSETS[checked(asset)];
export const mintOf=(asset:Asset)=>[SOL,BTC_MINT,ETH_MINT][checked(asset)];
export const startOf=(namedMinute:bigint,asset:Asset)=>namedMinute-60n+BigInt(checked(asset));
export async function feedOf(asset:Asset,configFeed:Address,cluster:'devnet'|'mainnet'):Promise<Address> {
 checked(asset);
 if(cluster==='mainnet')return [configFeed,BTC_FEED,ETH_FEED][asset];
 return (await getProgramDerivedAddress({programAddress:SPAN_PROGRAM_ADDRESS,seeds:asset===0?['dev_feed']:['dev_feed',new Uint8Array([asset])]}))[0];
}

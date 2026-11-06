import {expect} from 'vitest';
/** Remove only the two additive bid fields before comparing a pre-bid document. */
export function beforeBid(value:any):any{
 if(Array.isArray(value))return value.map(beforeBid);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).flatMap(([key,v])=>{
  if(key==='bids'){expect(v).toEqual([]);return[];}
  if(key==='via'){expect(v).toBe('resale');return[];}
  return[[key,beforeBid(v)]];
 }));
}

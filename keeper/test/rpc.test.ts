import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { RpcPool, type Endpoint, endpoints } from "../src/common/rpc.js";
import { GENESIS, PUBLIC } from "../src/common/env.js";
it("devnet fallback selection preserves public first and isolates the mainnet WebSocket", () => {
  vi.stubEnv("DEVNET_RPC_URL_FALLBACK", "https://devnet.invalid/test");
  vi.stubEnv("DEVNET_RPC_WS_URL_FALLBACK", "");
  vi.stubEnv("RPC_URL_FALLBACK", "https://mainnet.invalid/test");
  vi.stubEnv("RPC_WS_URL_FALLBACK", "wss://mainnet.invalid/test");
  for (const name of [
    "DEVNET_RPC_URL_FALLBACK_2",
    "DEVNET_RPC_WS_URL_FALLBACK_2",
    "RPC_URL_FALLBACK_2",
    "RPC_WS_URL_FALLBACK_2",
    "DEVNET_RPC_URL_FALLBACK_3",
    "DEVNET_RPC_WS_URL_FALLBACK_3",
    "RPC_URL_FALLBACK_3",
    "RPC_WS_URL_FALLBACK_3",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("DEVNET_RPC_URL_FALLBACK_2", "https://devnet2.invalid/test");
  try {
    expect(endpoints("devnet")).toEqual([
      {
        name: "public",
        url: PUBLIC.devnet,
        ws: PUBLIC.devnet.replace("https:", "wss:"),
      },
      {
        name: "fallback",
        url: "https://devnet.invalid/test",
        ws: "wss://devnet.invalid/test",
      },
      {
        name: "fallback2",
        url: "https://devnet2.invalid/test",
        ws: "wss://devnet2.invalid/test",
      },
    ]);
    expect(endpoints("mainnet")[1]).toMatchObject({
      url: "https://mainnet.invalid/test",
      ws: "wss://mainnet.invalid/test",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
async function fake(fn: (method: string, params: any[]) => any, delay = 0) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const x of req) data += x;
    const b = JSON.parse(data);
    calls.push({ method: b.method, params: b.params, at: Date.now() });
    const v = fn(b.method, b.params);
    if (v === "hang") return;
    if (delay && b.method !== "getGenesisHash")
      await new Promise((r) => setTimeout(r, delay));
    if (v === 429) {
      res.writeHead(429, { "retry-after": "0" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: b.id,
          ...(v?.error ? { error: v.error } : { result: v }),
        }),
      );
    }
  });
  await new Promise<void>((r, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", r);
  });
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
it("S4 actual HTTP: 429 and timeout fail over identical wire; deterministic errors do not; genesis mismatch is disabled", async () => {
  let mode = "429";
  const logs: any[] = [];
  const primary = await fake((method) =>
    method === "getGenesisHash"
      ? GENESIS.devnet
      : mode === "429"
        ? 429
        : mode === "timeout"
          ? "hang"
          : { error: { code: -32002, data: { err: "BeforeWindow" } } },
  );
  const fallback = await fake(
    (method) => (method === "getGenesisHash" ? GENESIS.devnet : "signature"),
    200,
  );
  const wrong = await fake(() => GENESIS.mainnet);
  const list: Endpoint[] = [
    { name: "public", url: primary.url, ws: "" },
    { name: "fallback", url: fallback.url, ws: "" },
    { name: "fallback2", url: wrong.url, ws: "" },
  ];
  try {
    const rpc = new RpcPool("devnet", list, fetch, (x) => logs.push(x));
    await rpc.initialize();
    expect(list[2].disabled).toBe(true);
    const wire = "same-signed-bytes";
    await rpc.call("sendTransaction", [wire], "window");
    expect(primary.calls.at(-1).params).toEqual(fallback.calls.at(-1).params);
    mode = "timeout";
    list[0].hold = 0;
    const at = Date.now();
    await rpc.call("sendTransaction", [wire], "window");
    expect(fallback.calls.at(-1).at - at).toBeLessThanOrEqual(450);
    mode = "deterministic";
    list[0].hold = 0;
    const previous = fallback.calls.length;
    await expect(
      rpc.call("sendTransaction", [wire], "window"),
    ).rejects.toMatchObject({ code: -32002 });
    expect(fallback.calls.length).toBe(previous);
    expect(JSON.stringify(logs)).not.toContain("127.0.0.1");
    expect(wrong.calls).toHaveLength(1);
  } finally {
    primary.close();
    fallback.close();
    wrong.close();
  }
}, 10000);
it("S4 an unavailable primary genesis is retried off the transaction path after cooldown", async () => {
  let available = false;
  const first = await fake((method) =>
    method === "getGenesisHash"
      ? available
        ? GENESIS.devnet
        : 429
      : "primary",
  );
  const second = await fake((method) =>
    method === "getGenesisHash" ? GENESIS.devnet : "fallback",
  );
  const list: Endpoint[] = [
    { name: "public", url: first.url, ws: "" },
    { name: "fallback", url: second.url, ws: "" },
  ];
  const rpc = new RpcPool("devnet", list, fetch, () => {});
  try {
    await rpc.initialize();
    expect(await rpc.call("getSlot")).toBe("fallback");
    available = true;
    list[0].hold = 0;
    await rpc.recheck();
    expect(await rpc.call("getSlot")).toBe("primary");
    expect(list[0].verified).toBe(true);
  } finally {
    rpc.close();
    first.close();
    second.close();
  }
});
it("S4 two fallbacks receive the identical signed bytes in order and a deterministic first-fallback error stops the chain", async () => {
  const order: string[] = [];
  let deterministic = false;
  const servers = await Promise.all(
    ["public", "fallback", "fallback2"].map((name) =>
      fake((method) => {
        if (method === "getGenesisHash") return GENESIS.devnet;
        order.push(name);
        if (name === "public") return 429;
        if (name === "fallback")
          return deterministic ? { error: { code: -32002 } } : 429;
        return "signature";
      }),
    ),
  );
  const rpc = new RpcPool(
    "devnet",
    servers.map((s, i) => ({
      name: (["public", "fallback", "fallback2"] as const)[i],
      url: s.url,
      ws: "",
    })),
    fetch,
    () => {},
  );
  try {
    await rpc.initialize();
    await rpc.call("sendTransaction", ["same-signed-bytes"], "window");
    expect(order).toEqual(["public", "fallback", "fallback2"]);
    expect(servers.map((s) => s.calls.at(-1).params)).toEqual(
      Array(3).fill(["same-signed-bytes"]),
    );
    deterministic = true;
    order.length = 0;
    await expect(
      rpc.call("sendTransaction", ["same-signed-bytes"], "window"),
    ).rejects.toMatchObject({ code: -32002 });
    expect(order).toEqual(["public", "fallback"]);
  } finally {
    rpc.close();
    servers.forEach((s) => s.close());
  }
});

function thirdFallbackEnv(){
 vi.stubEnv('SPAN_WS_URL','');
 for(const prefix of['','DEVNET_'])for(const suffix of['','_2','_3']){
  vi.stubEnv(`${prefix}RPC_URL_FALLBACK${suffix}`,`https://${prefix?'devnet':'mainnet'}${suffix||'1'}.invalid/rpc`);
  vi.stubEnv(`${prefix}RPC_WS_URL_FALLBACK${suffix}`,`wss://${prefix?'devnet':'mainnet'}${suffix||'1'}.invalid/ws`);
 }
}
it('P5 selects the third HTTP and websocket fallback independently for both clusters in public-first order',()=>{
 thirdFallbackEnv();try{
  for(const cluster of['mainnet','devnet']as const){const rows=endpoints(cluster),prefix=cluster==='devnet'?'DEVNET_':'';expect(rows.map(e=>e.name)).toEqual(['public','fallback','fallback2','fallback3']);expect(rows[3]).toMatchObject({url:process.env[`${prefix}RPC_URL_FALLBACK_3`],ws:process.env[`${prefix}RPC_WS_URL_FALLBACK_3`]});vi.stubEnv(`${prefix}RPC_WS_URL_FALLBACK_3`,'');expect(endpoints(cluster)[3].ws).toBe(process.env[`${prefix}RPC_URL_FALLBACK_3`]!.replace(/^http/,'ws'));}
 }finally{vi.unstubAllEnvs();}
});
it('P5 deduplicates a third fallback URL, including the public URL',()=>{
 thirdFallbackEnv();try{
  for(const cluster of['mainnet','devnet']as const){const prefix=cluster==='devnet'?'DEVNET_':'';vi.stubEnv(`${prefix}RPC_URL_FALLBACK_3`,process.env[`${prefix}RPC_URL_FALLBACK`]!);expect(endpoints(cluster).map(e=>e.name)).toEqual(['public','fallback','fallback2']);vi.stubEnv(`${prefix}RPC_URL_FALLBACK_3`,PUBLIC[cluster]);expect(endpoints(cluster).map(e=>e.name)).toEqual(['public','fallback','fallback2']);}
 }finally{vi.unstubAllEnvs();}
});
function fourEndpoints():Endpoint[]{return(['public','fallback','fallback2','fallback3']as const).map(name=>({name,url:`https://${name}.invalid`,ws:''}));}
it('P5 forwards identical signed bytes through three transient errors to fallback3',async()=>{
 const rows=fourEndpoints(),calls:any[]=[],logs:any[]=[];
 const rpc=new RpcPool('mainnet',rows,(async(url:any,init:any)=>{const q=JSON.parse(init.body),i=rows.findIndex(e=>e.url===url);if(q.method==='getGenesisHash')return new Response(JSON.stringify({result:GENESIS.mainnet}));calls.push({endpoint:rows[i].name,params:q.params});if(i===0)return new Response('',{status:429});if(i===1)throw Error('Transport failure');if(i===2)return new Response('',{status:500});return new Response(JSON.stringify({result:'same-signature'}));})as typeof fetch,e=>logs.push(e));
 try{await rpc.initialize();const params=['signed-wire',{encoding:'base64',skipPreflight:false}];expect(await rpc.callAt('sendTransaction',params,'window')).toEqual({value:'same-signature',endpoint:'fallback3'});expect(calls.map(c=>c.endpoint)).toEqual(['public','fallback','fallback2','fallback3']);expect(calls.map(c=>c.params)).toEqual(Array(4).fill(params));expect(JSON.stringify(logs)).not.toContain('.invalid');console.log('FALLBACK3',JSON.stringify({case:'identical-wire',order:calls.map(c=>c.endpoint)}));}finally{rpc.close();}
});
it('P5 stops at a deterministic preflight error before reaching fallback3',async()=>{
 const rows=fourEndpoints(),calls:string[]=[];
 const rpc=new RpcPool('mainnet',rows,(async(url:any,init:any)=>{const q=JSON.parse(init.body),i=rows.findIndex(e=>e.url===url);if(q.method==='getGenesisHash')return new Response(JSON.stringify({result:GENESIS.mainnet}));calls.push(rows[i].name);return i<2?new Response('',{status:429}):new Response(JSON.stringify({error:{code:-32002,data:{err:'BeforeBoundary'}}}));})as typeof fetch,()=>{});
 try{await rpc.initialize();await expect(rpc.call('sendTransaction',['same-wire'],'window')).rejects.toMatchObject({code:-32002,deterministic:true});expect(calls).toEqual(['public','fallback','fallback2']);}finally{rpc.close();}
});
it('P5 disables fallback3 on a genesis mismatch and never sends application requests to it',async()=>{
 const rows=fourEndpoints(),calls:any[]=[];
 const rpc=new RpcPool('mainnet',rows,(async(url:any,init:any)=>{const q=JSON.parse(init.body),i=rows.findIndex(e=>e.url===url);calls.push({endpoint:rows[i].name,method:q.method});return q.method==='getGenesisHash'?new Response(JSON.stringify({result:i===3?GENESIS.devnet:GENESIS.mainnet})):new Response('',{status:429});})as typeof fetch,()=>{});
 try{await rpc.initialize();expect(rows[3]).toMatchObject({verified:false,disabled:true});await expect(rpc.call('sendTransaction',['same-wire'],'window')).rejects.toBeDefined();await rpc.recheck();expect(calls.filter(c=>c.endpoint==='fallback3')).toEqual([{endpoint:'fallback3',method:'getGenesisHash'}]);}finally{rpc.close();}
});
it('P5 rechecks an unavailable fallback3 after its cooldown and then uses it',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1800000000000);const rows=fourEndpoints();let ready=false,checks=0;
 const rpc=new RpcPool('mainnet',rows,(async(url:any,init:any)=>{const q=JSON.parse(init.body),i=rows.findIndex(e=>e.url===url);if(q.method==='getGenesisHash'){if(i===3){checks++;if(!ready)throw Error('Unavailable');}return new Response(JSON.stringify({result:GENESIS.mainnet}));}return new Response(JSON.stringify({result:'signature'}));})as typeof fetch,()=>{});
 try{await rpc.initialize();expect(rows[3].verified).toBe(false);expect(rows[3].disabled).toBeUndefined();ready=true;await vi.advanceTimersByTimeAsync(9999);await rpc.recheck();expect(checks).toBe(1);await vi.advanceTimersByTimeAsync(1);await rpc.recheck();expect(checks).toBe(2);expect(rows[3]).toMatchObject({verified:true,disabled:false});for(const e of rows.slice(0,3))e.hold=Date.now()+10000;expect(await rpc.callAt('sendTransaction',['same-wire'],'window')).toEqual({value:'signature',endpoint:'fallback3'});}finally{rpc.close();vi.clearAllTimers();vi.useRealTimers();}
});

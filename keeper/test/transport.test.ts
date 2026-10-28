import { it, expect } from "vitest";
import { createSecureServer } from "node:http2";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import type { ServerHttp2Session } from "node:http2";

it("uses HTTP/1.1 for RPC on an h2-capable origin, including after an aborted request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "span-rpc-tls-"));
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem"), child = join(dir, "child.mts");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-days", "1", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const protocols: string[] = [], sessions = new Set<ServerHttp2Session>(), sockets = new Set<Socket>();
  const server = createSecureServer({ key: readFileSync(key), cert: readFileSync(cert), allowHTTP1: true }, async (req, res) => {
    protocols.push(req.httpVersion);
    let body = ""; for await (const b of req) body += b;
    const q = JSON.parse(body);
    if (q.method === "abort-me") return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: q.method === "getGenesisHash" ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" : 123 }));
  });
  server.on("session", s => { sessions.add(s); s.once("close", () => sessions.delete(s)); });
  server.on("sessionError", () => {});
  server.on("connection", s => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as {port:number}).port;
  writeFileSync(child, `import assert from 'node:assert/strict';import {RpcPool} from ${JSON.stringify(resolve("src/common/rpc.ts"))};
const p=new RpcPool('devnet',[{name:'public',url:'https://127.0.0.1:${port}',ws:'ws://127.0.0.1:1'}],undefined,()=>{});
try{await p.initialize();assert.equal(await p.call('getSlot',[]),123);await assert.rejects(()=>p.call('abort-me',[],'window'));p.list[0].hold=0;assert.equal(await p.call('getBlockHeight',[]),123);}finally{p.close();}
`);
  try {
    await promisify(execFile)(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), child], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 20000 });
    expect(protocols.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(protocols)]).toEqual(["1.1"]);
  } finally {
    for (const s of sessions) s.destroy();
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => server.close(() => r()));
    rmSync(dir, { recursive: true });
  }
}, 30000);

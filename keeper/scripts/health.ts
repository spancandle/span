import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { resolve4, resolve6 } from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { RpcPool } from "../src/common/rpc.js";
import { cluster, dataDir, sleep, ROOT } from "../src/common/env.js";
import { rpcSecrets, scanBytes } from "./leak-scan.js";
export type Scope = "local" | "data" | "all";
export type HealthDeps = {
  now(): number; sleep(ms: number): Promise<void>;
  service(name: string): Promise<boolean>; read(name: string): Promise<any>;
  listeners(): Promise<{ address: string }[]>; publicIps(): Promise<string[]>; dns(host: string): Promise<string[]>;
  fetch(url: string, init?: RequestInit): Promise<Response>; balance(): Promise<number>;
  secrets: any[];
};
export type HealthOptions = { scope: Scope; local?: string; data?: string; site?: string };
export const FORWARD_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override", "x-forwarded-host", "x-host", "x-forwarded-scheme", "x-original-url", "x-rewrite-url", "forwarded"];
const shared = ["state.json", "chain.json"];
const totals = (status: any) => { if (!status?.http?.total || !Number.isFinite(status.generated)) throw Error("Origin counters unavailable"); return JSON.stringify(status.http.total); };
export async function health(deps: HealthDeps, options: HealthOptions) {
  const lines: { check: string; ok: boolean }[] = [], local = options.local ?? "http://127.0.0.1:8789", data = options.data ?? "", site = options.site ?? "";
  const check = async (name: string, fn: () => Promise<unknown> | unknown) => { try { lines.push({ check: name, ok: !!(await fn()) }); } catch { lines.push({ check: name, ok: false }); } };
  for (const name of options.scope === "local" ? ["keeper", "tape"] : ["keeper", "tape", "tunnel"]) await check(`service ${name}`, () => deps.service(name));
  const read = async (name: string) => deps.read(name).catch(() => null);
  const status = await read("status.json"), state = await read("state.json"), chain = await read("chain.json"), now = deps.now();
  // The tape records DOVES only while a candle is in its window; outside one there is no record to age.
  const idle = status?.feed?.recording === false;
  await check(idle ? "DOVES age (idle: no candle in its window)" : "DOVES age", () => idle || (Number.isFinite(status?.feed?.lagSecs) && status.feed.lagSecs >= 0 && status.feed.lagSecs <= 10 && status.feed.lastPublishTs !== "0"));
  await check("state ready", () => Number.isFinite(status?.state?.lastFullMs) && status.state.lastFullMs > 0 && Number(status.state.lastSlot) > 0);
  await check("state generated", () => state && now - state.generated >= -2000 && now - state.generated <= 5000);
  await check("chain generated", () => chain && now - chain.generated >= -2000 && now - chain.generated <= 5000);
  await check("chain hash age", () => chain && now - chain.hashAt >= -2000 && now - chain.hashAt <= 15000);
  await check("chain listing age", () => chain && now - chain.listedAt >= -2000 && now - chain.listedAt <= 10000);
  await check("loopback listeners", async () => (await deps.listeners()).every(l => l.address.startsWith("127.0.0.1:")));
  await check("keeper balance", async () => await deps.balance() >= 20000000);
  if (options.scope !== "local") {
    const hosts = [new URL(data).hostname, ...(options.scope === "all" ? [new URL(site).hostname, "www." + new URL(site).hostname.replace(/^www\./, "")] : [])];
    for (const host of hosts) await check(`DNS ${host}`, async () => { const [ips, own] = await Promise.all([deps.dns(host), deps.publicIps()]); return ips.length > 0 && ips.every(ip => !own.includes(ip)); });
    for (const name of shared) {
      await check(`shared ${name}`, async () => {
        const localJson = await deps.read(name), response = await deps.fetch(`${data}/${name}`), remote = await response.json();
        return response.ok && Math.abs(remote.generated - localJson.generated) <= 5000;
      });
      await check(`cache ${name}`, async () => {
        let hit = false;
        for (let i = 0; i < 10; i++) {
          const r = await deps.fetch(`${data}/${name}`), json = await r.json(), age = Number(r.headers.get("age") ?? 0);
          hit ||= r.headers.get("cf-cache-status") === "HIT";
          if (!r.ok || !Number.isFinite(age) || age < 0 || age > 2 || deps.now() - json.generated > 5000) return false;
          if (i < 9) await deps.sleep(200);
        }
        return hit;
      });
    }
    const nonce = Math.random().toString(36).slice(2), probes: [string, RequestInit][] = [
      [`/state.json?x=${nonce}`, {}], ["/nope.json", {}], ["/status.json", {}], ["/state.json", { method: "POST" }],
      ["/state.json", { headers: { Origin: `https://n${nonce}.invalid` } }], ...FORWARD_HEADERS.map(name => ["/state.json", { headers: { [name]: `${nonce}.invalid` } }] as [string, RequestInit]),
    ];
    let before: string | undefined;
    if (options.scope === "data") {
      await deps.sleep(5200);
      before = totals(await deps.read("status.json"));
    }
    for (let i = 0; i < probes.length; i++) await check(`edge probe ${i + 1}`, async () => {
      const [path, init] = probes[i]!, r = await deps.fetch(data + path, init), text = await r.text();
      let body: any; try { body = JSON.parse(text); } catch { body = null; }
      return r.status === 403 && !!r.headers.get("cf-ray") && !body?.v && !body?.generated && !text.includes('"rows"');
    });
    if (options.scope === "data") {
      await deps.sleep(5200);
      await check("edge origin counters", async () => totals(await deps.read("status.json")) === before);
    }
    // strict wildcard "/candles/*.json" also admits non-numeric names, so this one may reach the origin; it must end in 403 or 404, never a tape document.
    await check("non-numeric candle path", async () => {
      const r = await deps.fetch(`${data}/candles/abc.json`), text = await r.text();
      let body: any; try { body = JSON.parse(text); } catch { body = null; }
      return (r.status === 403 || r.status === 404) && !body?.v && !body?.generated;
    });
    await check("site Origin cache", async () => {
      let hit = false;
      for (let i = 0; i < 10; i++) {
        const r = await deps.fetch(`${data}/state.json`, { headers: { Origin: new URL(site).origin } });
        if (!r.ok) return false; await r.arrayBuffer(); hit ||= r.headers.get("cf-cache-status") === "HIT";
        if (i < 9) await deps.sleep(200);
      }
      return hit;
    });
  }
  if (options.scope === "all") await check("page RPC leak", async () => {
    for (const path of ["/", "/live.js"]) { const r = await deps.fetch(site + path); if (!r.ok || scanBytes(Buffer.from(await r.arrayBuffer()), deps.secrets).length) return false; }
    return true;
  });
  return { ok: lines.every(l => l.ok), lines };
}
function publicAddress(ip: string) { return !/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fe80:|f[cd])/i.test(ip); }
export function localDeps(dir = resolve(dataDir(), "public"), keeper?: string, selected = cluster()): HealthDeps {
  const command = (name: string, args: string[]) => execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    now: Date.now, sleep, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) }), secrets: rpcSecrets(ROOT),
    service: async name => command("systemctl", ["--user", "is-active", `span-${selected}-${name}.service`]).trim() === "active",
    read: async name => JSON.parse(readFileSync(resolve(dir, name), "utf8")),
    publicIps: async () => {
      const ips = Object.values(networkInterfaces()).flatMap(rows => rows ?? []).filter(row => !row.internal && publicAddress(row.address)).map(row => row.address);
      for (const url of ["https://api.ipify.org", "https://api6.ipify.org"]) try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); const ip = (await r.text()).trim(); if (r.ok && /^[0-9a-f:.]+$/i.test(ip) && publicAddress(ip)) ips.push(ip); } catch {}
      if (!ips.length) throw Error("Public addresses unavailable"); return [...new Set(ips)];
    },
    dns: async host => [...await resolve4(host).catch(() => []), ...await resolve6(host).catch(() => [])],
    listeners: async () => {
      const roots = ["keeper", "tape"].map(name => Number(command("systemctl", ["--user", "show", `span-${selected}-${name}.service`, "--property=MainPID", "--value"]).trim())).filter(Boolean);
      const children = command("ps", ["-eo", "pid=,ppid="]).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
      const owned = new Set(roots); for (let i = 0; i < 8; i++) for (const [pid, ppid] of children) if (owned.has(ppid!)) owned.add(pid!);
      return command("ss", ["-ltnpH"]).split("\n").filter(line => /:8789\b/.test(line) || [...line.matchAll(/pid=(\d+)/g)].some(m => owned.has(Number(m[1])))).map(line => ({ address: line.trim().split(/\s+/)[3]! }));
    },
    balance: async () => {
      let key = keeper;
      if (!key && process.env.KEEPER_KEYPAIR) { const bytes = Uint8Array.from(JSON.parse(readFileSync(resolve(ROOT, process.env.KEEPER_KEYPAIR), "utf8"))); try { key = (await createKeyPairSignerFromBytes(bytes)).address; } finally { bytes.fill(0); } }
      if (!key) throw Error("Keeper address required");
      const rpc = new RpcPool(selected); await rpc.initialize(); try { return (await rpc.call("getBalance", [key, { commitment: "confirmed" }])).value; } finally { rpc.close(); }
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = (key: string) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined;
  const selected = arg("--cluster"); if (selected !== "mainnet" && selected !== "devnet") throw Error("Required --cluster");
  const scope = arg("--scope") ?? "all"; if (!["local", "data", "all"].includes(scope)) throw Error("Invalid scope");
  const result = await health(localDeps(arg("--dir") ?? resolve(ROOT, "keeper/data", selected === "devnet" ? "devnet-rehearsal" : "mainnet", "tape/public"), arg("--keeper"), selected), { scope: scope as Scope, local: arg("--local"), data: arg("--data"), site: arg("--site") });
  for (const line of result.lines) console.log(`${line.ok ? "PASS" : "FAIL"} ${line.check}`);
  process.exitCode = result.ok ? 0 : 1;
}

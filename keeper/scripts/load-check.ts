import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { sleep } from '../src/common/env.js';
export function readOriginCounter(dir: string, now = Date.now) {
  let status: any;
  try { status = JSON.parse(readFileSync(resolve(dir, 'status.json'), 'utf8')); }
  catch { throw Error('load-check: status unavailable'); }
  const count = status?.http?.total?.['/state.json'];
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) throw Error('load-check: origin counter unavailable');
  const age = now() - status.generated;
  if (typeof status.generated !== 'number' || !Number.isFinite(status.generated) || age < 0 || age > 10000)
    throw Error('load-check: status is stale');
  return count;
}
export async function loadCheck(options: { base: string; clients?: number; seconds?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch; origin: () => Promise<number> }) {
  const clients = options.clients ?? 50, seconds = options.seconds ?? 60, now = options.now ?? Date.now, wait = options.sleep ?? sleep, fetcher = options.fetch ?? fetch;
  await wait(5200);
  const before = await options.origin(), start = now(); let requests = 0, errors = 0, stale = 0, maxAge = 0;
  await Promise.all(Array.from({ length: clients }, async () => {
    for (let i = 0; i < seconds; i++) {
      const at = start + i * 1000; if (at > now()) await wait(at - now());
      requests++;
      try { const r = await fetcher(`${options.base}/state.json`); if (!r.ok) { errors++; continue; } const value = await r.json(), age = now() - value.generated; maxAge = Math.max(maxAge, age); if (!Number.isFinite(age) || age > 5000) stale++; }
      catch { errors++; }
    }
  }));
  if (now() < start + seconds * 1000) await wait(start + seconds * 1000 - now());
  await wait(5200);
  const delta = await options.origin() - before, originRps = delta / seconds;
  return { ok: errors === 0 && stale === 0 && originRps >= 0 && originRps <= 5, clients, seconds, requests, errors, stale, maxAgeMs: maxAge, originDelta: delta, originRps };
}
export async function main(args = process.argv.slice(2)) {
  const base = args[0], at = args.indexOf('--dir'), dir = at >= 0 ? args[at + 1] : undefined;
  if (!base || !base.startsWith('https://')) throw Error('load-check: required https data URL');
  if (!dir || dir.startsWith('--')) throw Error('load-check: required --dir');
  const cached = await loadCheck({ base, origin: async () => readOriginCounter(dir) });
  const mixed = await candleLoad({ base, counters: () => { readOriginCounter(dir); return JSON.parse(readFileSync(resolve(dir, 'status.json'), 'utf8')).http.total; } });
  const result = { ok: cached.ok && mixed.ok, cached, mixed };
  console.log(JSON.stringify(result)); return result.ok ? 0 : 1;
}
export async function candleLoad(options: { base: string; clients?: number; stateClients?: number; seconds?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch; counters: () => Record<string, number> }) {
  const clients = options.clients ?? 50, stateClients = options.stateClients ?? 10, seconds = options.seconds ?? 60,
    now = options.now ?? Date.now, wait = options.sleep ?? sleep, fetcher = options.fetch ?? fetch, before = options.counters(), start = now();
  let stateErrors = 0, stale = 0, maxAgeMs = 0, missing = 0, busy = 0, candleErrors = 0, serial = 0;
  const one = async (state: boolean) => { for (let i = 0; i < seconds; i++) {
    const at = start + i * 1000; if (at > now()) await wait(at - now());
    const id = String(randomInt(1_000_000_000, 10_000_000_000)); serial++;
    try { const r = await fetcher(options.base + (state ? '/state.json' : '/candles/' + id + '.json'));
      if (state) { if (!r.ok) { stateErrors++; await r.arrayBuffer(); continue; } const value = await r.json(), age = now() - value.generated;
        maxAgeMs = Math.max(maxAgeMs, age); if (!Number.isFinite(age) || age > 5000) stale++;
      } else { if (r.status === 404) missing++; else if (r.status === 503) busy++; else if (!r.ok) candleErrors++; await r.arrayBuffer(); }
    } catch { if (state) stateErrors++; else candleErrors++; }
  } };
  await Promise.all([...Array.from({ length: clients }, () => one(false)), ...Array.from({ length: stateClients }, () => one(true))]);
  if (now() < start + seconds * 1000) await wait(start + seconds * 1000 - now());
  await wait(5200); const after = options.counters(), originDelta = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map(k => [k, (after[k] ?? 0) - (before[k] ?? 0)]));
  return { ok: stateErrors === 0 && stale === 0, clients, stateClients, seconds, missing, busy, candleErrors, stateErrors, stale, maxAgeMs, originDelta, originRps: Object.fromEntries(Object.entries(originDelta).map(([k, n]) => [k, n / seconds])) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : 'load-check: failed'); process.exitCode = 1; });

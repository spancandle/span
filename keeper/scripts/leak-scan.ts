import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
export type Secret = { name: string; needles: string[] };
export function rpcSecrets(root: string, environment = process.env): Secret[] {
  const file = resolve(root, '.env'), values = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...environment }, out: Secret[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value || !/(?:RPC|WS_URL)/.test(name) || !/^(?:https?|wss?):\/\//.test(value)) continue;
    const needles = new Set([value]);
    try { const u = new URL(value); if (u.pathname.length > 1) needles.add(u.pathname); if (u.search) needles.add(u.search);
      for (const v of u.searchParams.values()) if (v.length >= 8) needles.add(v);
      if (u.username) needles.add(u.username); if (u.password) needles.add(u.password);
      const head = u.hostname.split('.')[0]; if (head && head.length >= 16) needles.add(head);
    } catch {}
    out.push({ name, needles: [...needles].filter(v => v.length >= 6) });
  }
  return out;
}
export function scanBytes(data: Uint8Array, secrets: Secret[]) {
  const bytes = Buffer.from(data); return secrets.filter(s => s.needles.some(n => bytes.includes(Buffer.from(n)))).map(s => s.name);
}

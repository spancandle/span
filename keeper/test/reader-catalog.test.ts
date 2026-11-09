import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateKeyPairSigner } from "@solana/kit";
import { checkReaderSigner, loadReaders, readersDocument, validateReaders } from "../src/common/readers.js";
import { readerOptions } from "../src/keeper/reader-policy.js";
import { httpServer, atomicFile } from "../src/tape/http.js";
import { renderServices, writeServices, type ServiceValues } from "../scripts/install-services.js";
import { health } from "../scripts/health.js";

async function config() {
  const [a, b] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  return { v: 1, readers: [{ id: "greedy", marker: a.address, mode: "full", policy: "greedy" },
    { id: "paced-v1", marker: b.address, mode: "marks", policy: "paced-v1" }] };
}
it("validates the complete public configuration and binds each process to its signer", async () => {
  const input = await config(), readers = validateReaders(input), dir = mkdtempSync(join(tmpdir(), "span-readers-")), file = join(dir, "readers.json");
  writeFileSync(file, JSON.stringify(input)); expect(loadReaders(file)).toEqual(readers);
  checkReaderSigner(undefined, readers.readers[0].marker, readerOptions());
  checkReaderSigner(readers, readers.readers[1].marker, readerOptions("marks", "paced-v1"));
  expect(() => checkReaderSigner(undefined, readers.readers[1].marker, readerOptions("marks", "paced-v1"))).toThrow();
  expect(() => checkReaderSigner(readers, readers.readers[1].marker, readerOptions())).toThrow();
  for (const bad of [{ v: 2, readers: input.readers }, { ...input, privateKey: "no" }, { ...input, readers: [] },
    { ...input, readers: [input.readers[0], input.readers[0]] },
    { ...input, readers: [input.readers[0], { ...input.readers[1], marker: input.readers[0].marker }] },
    { ...input, readers: [input.readers[0], { ...input.readers[1], marker: "bad" }] },
    { ...input, readers: [input.readers[0], { ...input.readers[1], mode: "full" }] }])
    expect(() => validateReaders(bad)).toThrow();
  writeFileSync(file, "{}"); expect(() => loadReaders(file)).toThrow();
  expect(() => loadReaders(join(dir, "absent"))).toThrow();
});
it("atomically serves the catalog and empty catalog with the existing HTTP cache and Origin contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "span-readers-http-")), configured = validateReaders(await config());
  const server = httpServer(dir); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/readers.json`;
  try {
    for (const readers of [undefined, configured]) {
      const doc = readersDocument("mainnet", readers); atomicFile(dir, "readers.json", doc);
      const r = await fetch(url, { headers: { Origin: "https://example.invalid" } });
      expect(r.status).toBe(200); expect(await r.json()).toEqual(doc);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("cache-control")).toBe("public, max-age=2");
      expect((await fetch(url, { headers: { "if-none-match": r.headers.get("etag")! } })).status).toBe(304);
      expect(await (await fetch(url, { method: "HEAD" })).text()).toBe("");
    }
    expect((await fetch(url + "?x=1")).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect(readersDocument("mainnet", configured).readers[1]).toMatchObject({ intervalSeconds: 300,
      budgetBasis: "initial-load-reserve", topUp: "immediately-available-above-reserve" });
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
it("renders three legacy units or four isolated units to a directory without systemctl", () => {
  const values: ServiceValues = { repo: "/tmp/span", cluster: "mainnet", signer: "keys/greedy.json", keeperData: "keeper/data/greedy",
    data: "keeper/data/tape", npm: "/usr/bin/npm", path: "/usr/bin:/bin", cloudflared: "/usr/bin/cloudflared", tunnelConfig: "/tmp/tunnel.yml" };
  expect(Object.keys(renderServices(values))).toHaveLength(3);
  const both = { ...values, pacedSigner: "keys/paced.json", pacedData: "keeper/data/paced", readersFile: "readers.json" };
  const out = mkdtempSync(join(tmpdir(), "span-units-")), names = writeServices(both, out);
  expect(names).toHaveLength(4);
  const paced = readFileSync(join(out, "span-mainnet-keeper-paced.service"), "utf8");
  for (const text of ["KEEPER_ACTION_MODE=marks", "KEEPER_MARK_POLICY=paced-v1", "KEEPER_RELEASE_HOURS=0", "KEEPER_HALF_HOURS=0", "KEEPER_DATA_DIR=keeper/data/paced", "KEEPER_KEYPAIR=keys/paced.json"])
    expect(paced).toContain(text);
  for (const name of names.filter(n => !n.includes("tunnel")))
    expect(readFileSync(join(out, name), "utf8")).toContain("SPAN_READERS_FILE=/tmp/span/readers.json");
  for (const bad of [{ ...both, pacedSigner: "./keys/greedy.json" }, { ...both, pacedData: "keeper/data/greedy" },
    { ...both, readersFile: undefined }, { ...both, pacedData: undefined }]) expect(() => renderServices(bad)).toThrow();
});
it("render-only CLI rejects the same relative signer path for both processes", () => {
  const out = mkdtempSync(join(tmpdir(), "span-cli-units-")), result = spawnSync(process.execPath, ["--import", "tsx",
    fileURLToPath(new URL("../scripts/install-services.ts", import.meta.url)), "--cluster", "mainnet",
    "--keeper-key", "keys/same.json", "--paced-key", "keys/same.json", "--paced-data", "keeper/data/paced",
    "--readers-file", "readers.json", "--render-only", "--out", out], { encoding: "utf8" });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("Keeper signers and data directories must differ");
});
it("health checks catalog bytes, edge cache and disallowed Origin, with an empty list allowed", async () => {
  const now = Date.now(), seen: any[] = [], catalog = readersDocument("mainnet"), state = { generated: now, hashAt: now, listedAt: now,
    feed: { recording: false }, state: { lastFullMs: now, lastSlot: "1" }, http: { total: {} } };
  const deps: any = { now: () => now, sleep: async () => {}, service: async () => true,
    read: async (name: string) => name === "readers.json" ? catalog : state,
    listeners: async () => [{ address: "127.0.0.1:8789" }], publicIps: async () => ["198.51.100.1"], dns: async () => ["203.0.113.1"], balance: async () => 100000000, secrets: [],
    fetch: async (url: string, init: any) => {
      seen.push({ url, init });
      if (url.includes("?") || init?.method === "POST" || init?.headers && !init.headers.Origin?.includes("span.press") || url.includes("nope") || url.includes("status"))
        return new Response("denied", { status: 403, headers: { "cf-ray": "test" } });
      if (url.includes("abc.json")) return new Response("missing", { status: 404 });
      return new Response(JSON.stringify(url.endsWith("readers.json") ? catalog : state), { headers: { "cf-cache-status": "HIT", age: "0" } });
    } };
  const result = await health(deps, { scope: "data", data: "https://data.span.press", site: "https://span.press" });
  expect(result.ok, JSON.stringify(result.lines)).toBe(true);
  expect(seen.some(r => r.url.endsWith("/readers.json") && r.init?.headers?.Origin?.endsWith(".invalid"))).toBe(true);
});

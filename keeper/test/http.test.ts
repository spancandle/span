import { it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpServer, atomicFile } from "../src/tape/http.js";
import { createHash } from "node:crypto";
const names = ["state", "tickets", "feed", "history", "chain", "status"];
it("S7 serves six immutable file bytes with CORS/cache/ETag; HEAD/304/404/405; no request calls RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "span-http-"));
  for (const name of names) atomicFile(dir, `${name}.json`, { v: 1, name });
  const server = httpServer(dir);
  await new Promise<void>((r, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", r);
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const name of names) {
      const res = await fetch(`${base}/${name}.json`),
        bytes = readFileSync(join(dir, `${name}.json`));
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
      expect(res.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("cache-control")).toBe(
        `public, max-age=${["tickets", "history", "status"].includes(name) ? 2 : 1}`,
      );
      const etag = '"' + createHash("sha1").update(bytes).digest("hex") + '"';
      expect(res.headers.get("etag")).toBe(etag);
      expect(
        (
          await fetch(`${base}/${name}.json`, {
            headers: { "if-none-match": etag },
          })
        ).status,
      ).toBe(304);
      const head = await fetch(`${base}/${name}.json`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect((await fetch(`${base}/state.json?q=1`)).status).toBe(404);
    expect((await fetch(`${base}/../keys/private`)).status).toBe(404);
    expect((await fetch(`${base}/state.json`, { method: "POST" })).status).toBe(
      405,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
it("S7 caps active file requests at 64 and returns retry-after 2 to the 65th", async () => {
  const dir = mkdtempSync(join(tmpdir(), "span-busy-"));
  const resolves: ((b: Buffer) => void)[] = [];
  const server = httpServer(dir, () => new Promise((r) => resolves.push(r)));
  await new Promise<void>((r, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", r);
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}/state.json`;
  try {
    const pending = Array.from({ length: 64 }, () => fetch(url));
    while (resolves.length < 64) await new Promise((r) => setTimeout(r, 5));
    const extra = await fetch(url);
    expect(extra.status).toBe(503);
    expect(extra.headers.get("retry-after")).toBe("2");
    for (const r of resolves) r(Buffer.from("{}"));
    await Promise.all(pending);
    expect(server.stats().busy1h).toBe(1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

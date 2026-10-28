import { it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { address, getBase58Decoder } from "@solana/kit";
import * as s from "../../program/client/index.js";
import { SOL_FEED } from "../../program/client/constants.js";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
import { httpServer } from "../src/tape/http.js";
import type { Chain } from "../src/keeper/chain.js";

const T = 1_800_000_000,
  DAY = 86400,
  FEED = SOL_FEED,
  NOBODY = address("11111111111111111111111111111111"),
  prefix = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
let slot = 100;
function settledTx(t0: number) {
  const data = s.getSettledEventEncoder().encode({
    ticket: NOBODY,
    id: BigInt(t0),
    t0: BigInt(t0),
    outcome: s.Outcome.Paid,
    seller: NOBODY,
    buyer: NOBODY,
    premium: 20000000n,
    p0: 8_246_000_000n,
    readHigh: 8_246_000_000n,
    readLow: 8_246_000_000n,
    strikeBps: 0, tailHigh: 0n,
    tailLow: 0n,
    high: 8_300_000_000n,
    low: 8_200_000_000n,
    payout: 0n,
    toBuyer: 0n,
    toSeller: 20000000n,
    spanReturned: 0n,
    burned: 0n,
    marks: 0,
    reads: 13,
  });
  slot++;
  return {
    slot,
    blockTime: t0 + 3700,
    transaction: {
      message: { accountKeys: [s.SPAN_PROGRAM_ADDRESS], instructions: [] },
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 0,
              data: getBase58Decoder().decode(
                Buffer.concat([prefix, Buffer.from(data)]),
              ),
            },
          ],
        },
      ],
    },
  };
}
// One receipt candle at T with oracle rows across the recording window.
function fixture(dir = mkdtempSync(join(tmpdir(), "span-candle-"))) {
  let clock = T + 3600;
  const store = new Store(join(dir, "tape.sqlite")),
    rpc = { cluster: "devnet" } as any,
    recorder = new DovesRecorder(store, rpc),
    history = new History(store, rpc, () => {}),
    chain = {
      rpc,
      slot: 1,
      lastFullMs: 0,
      lastReadMs: -Infinity,
      now: () => BigInt(clock),
      candles: new Map(),
      tickets: new Map(),
      config: { feed: FEED },
    } as unknown as Chain,
    pub = join(dir, "public"),
    publisher = new Publisher(store, chain, history, recorder, pub);
  return {
    dir,
    pub,
    store,
    recorder,
    history,
    chain,
    publisher,
    file: join(pub, "candles", `${T}.json`),
    setClock: (x: number) => (clock = x),
  };
}
function record(x: ReturnType<typeof fixture>) {
  x.recorder.startRecording(T - 120);
  x.recorder.sample("pre", 8_250_000_000n, T - 60, 1000);
  x.recorder.sample("open-a", 8_246_000_000n, T, 1010);
  x.recorder.sample("open-b", 8_247_000_000n, T, 1011);
  x.recorder.sample("mid-low", 8_201_000_000n, T + 900, 3000);
  // Same publish time from a later slot keeps slot order.
  x.recorder.sample("mid-high-late", 8_299_000_000n, T + 1500, 4600);
  x.recorder.sample("mid-high", 8_298_000_000n, T + 1500, 4500);
  x.recorder.sample("close", 8_250_000_000n, T + 3600, 10000);
  x.recorder.sample("after", 8_500_000_000n, T + 3650, 10100);
  x.recorder.cover(T + 3720);
  x.recorder.closeGaps();
  x.history.ingest("settle", settledTx(T));
}
const undelta = (csv: string) => {
  if (!csv) return [] as bigint[];
  const out: bigint[] = [];
  for (const x of csv.split(","))
    out.push(out.length ? out[out.length - 1] + BigInt(x) : BigInt(x));
  return out;
};
const windowRows = (x: ReturnType<typeof fixture>) =>
  (
    x.store.db
      .prepare("SELECT COUNT(*) n FROM doves WHERE publish_ts>=? AND publish_ts<=?")
      .get(T, T + 3600) as any
  ).n;

it("K1 writes a receipt candle path once its recording window ends; values equal Publisher.doves()", () => {
  const x = fixture();
  record(x);
  x.publisher.publish(10_000);
  expect(existsSync(join(x.pub, "history.json"))).toBe(true);
  expect(existsSync(x.file)).toBe(false);
  x.setClock(T + 3719);
  x.publisher.publish(10_250);
  expect(existsSync(x.file)).toBe(false);
  // No store change: eligibility by time alone writes the file.
  const revision = x.store.revision;
  x.setClock(T + 3720);
  x.publisher.publish(10_500);
  expect(x.store.revision).toBe(revision);
  expect(existsSync(x.file)).toBe(true);
  const text = readFileSync(x.file, "utf8"),
    doc = JSON.parse(text),
    d = x.publisher.doves(T, T + 3600)!;
  expect(Object.keys(doc)).toEqual([
    "v",
    "generated",
    "feed",
    "t0",
    "from",
    "ts",
    "p",
    "slots",
    "gaps",
    "complete",
  ]);
  expect(doc).toMatchObject({
    v: 1,
    feed: FEED,
    t0: String(T),
    from: String(T),
    gaps: [],
  });
  expect(doc.generated).toBeTypeOf("number");
  const ts = undelta(doc.ts),
    p = undelta(doc.p),
    slots = undelta(doc.slots),
    rows = x.publisher.values(T, T + 3600);
  expect(ts.map(Number)).toEqual(rows.map((r) => r.publish_ts - T));
  expect(ts[0]).toBe(0n);
  expect(ts.at(-1)).toBe(3600n);
  expect(p.map(String)).toEqual(rows.map((r) => r.price));
  expect(slots.map(Number)).toEqual([1010, 1011, 3000, 4500, 4600, 10000]);
  expect(String(p.reduce((a, b) => (a > b ? a : b)))).toBe(d.high);
  expect(String(p.reduce((a, b) => (a < b ? a : b)))).toBe(d.low);
  expect(d).toEqual({
    high: "8299000000",
    low: "8201000000",
    complete: true,
  });
  expect(doc.complete).toBe(d.complete);
  const history = JSON.parse(readFileSync(join(x.pub, "history.json"), "utf8"));
  expect(history.candles.map((c: any) => c.t0)).toEqual([String(T)]);
  expect(history.candles[0].doves).toEqual(d);
  expect(
    (x.store.db.prepare("SELECT raw FROM candle_path WHERE t0=?").get(String(T)) as any)
      .raw + "\n",
  ).toBe(text);
  console.log(
    "CANDLE_PATH " +
      JSON.stringify({ t0: T, rows: rows.length, doves: d, file: doc }),
  );
  x.store.close();
});

it("K1 a gap across (t0, t0 + 3600) makes complete false; boundary gaps do not; gap changes rewrite the file", () => {
  const x = fixture();
  record(x);
  const add = (a: number, b: number | null, reason: string) => {
    x.store.db
      .prepare("INSERT INTO gaps(a,b,reason) VALUES(?,?,?)")
      .run(a, b, reason);
    x.store.change();
  };
  add(T - 50, T, "edge-before");
  add(T + 3600, null, "edge-after");
  x.setClock(T + 3720);
  x.publisher.publish(10_000);
  const first = JSON.parse(readFileSync(x.file, "utf8"));
  expect(first.complete).toBe(true);
  expect(first.gaps).toEqual([]);
  expect(x.publisher.doves(T, T + 3600)!.complete).toBe(true);
  add(T + 3599, T + 3700, "listing-or-decode");
  x.publisher.publish(12_000);
  const second = JSON.parse(readFileSync(x.file, "utf8"));
  expect(second.complete).toBe(false);
  expect(second.gaps).toEqual([
    { a: String(T + 3599), b: String(T + 3700), reason: "listing-or-decode" },
  ]);
  expect(second.complete).toBe(x.publisher.doves(T, T + 3600)!.complete);
  expect(second.p).toBe(first.p);
  x.store.close();
});

it("K1 the candle path keeps its bytes after the oracle rows are pruned at eight days, across restarts and clock steps", async () => {
  const x = fixture();
  record(x);
  x.setClock(T + 3720);
  x.publisher.publish(10_000);
  const initial = readFileSync(x.file);
  // A rewrite with unchanged content keeps the bytes.
  x.store.change();
  x.publisher.publish(12_000);
  expect(readFileSync(x.file)).toEqual(initial);
  // A late row inside the window is a content change.
  x.recorder.sample("late", 8_100_000_000n, T + 1800, 5000);
  x.publisher.publish(14_000);
  const before = readFileSync(x.file);
  expect(before).not.toEqual(initial);
  expect(JSON.parse(before.toString()).p).toContain("-");
  expect(x.publisher.doves(T, T + 3600)!.low).toBe("8100000000");
  expect(windowRows(x)).toBe(7);

  // Prune with a clock that later steps back by five seconds.
  x.setClock(T + 8 * DAY + 3);
  x.publisher.prune(T + 8 * DAY + 3);
  expect(windowRows(x)).toBe(5);
  x.setClock(T + 8 * DAY - 2);
  x.store.change();
  x.publisher.publish(16_000);
  expect(readFileSync(x.file)).toEqual(before);

  x.setClock(T + 8 * DAY + 3600 + 61);
  x.publisher.prune(T + 8 * DAY + 3600 + 61);
  expect(windowRows(x)).toBe(0);
  expect(x.publisher.doves(T, T + 3600)!.high).toBeNull();
  x.store.change();
  x.publisher.publish(18_000);
  expect(readFileSync(x.file)).toEqual(before);

  // A new process (empty memory) serves the stored bytes unchanged.
  x.store.close();
  const y = fixture(x.dir);
  y.setClock(T + 9 * DAY);
  y.recorder.prune(T + 9 * DAY);
  y.publisher.publish(20_000);
  expect(readFileSync(y.file)).toEqual(before);
  const server = httpServer(y.pub);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/candles/${T}.json`,
    );
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(before);
  } finally {
    server.closeAllConnections();
    server.close();
    y.store.close();
  }
});

it("K1 files for candles pushed out of the newest 200 receipt candles are deleted", () => {
  const x = fixture();
  record(x);
  x.setClock(T + 3720);
  x.publisher.publish(10_000);
  expect(existsSync(x.file)).toBe(true);
  for (let i = 1; i <= 200; i++)
    x.history.ingest(`settle-${i}`, settledTx(T + 60 * i));
  x.publisher.publish(12_000);
  const history = JSON.parse(readFileSync(join(x.pub, "history.json"), "utf8"));
  expect(history.candles).toHaveLength(200);
  expect(history.candles.some((c: any) => c.t0 === String(T))).toBe(false);
  expect(existsSync(x.file)).toBe(false);
  expect(readdirSync(join(x.pub, "candles")).filter((n) => n.endsWith(".json"))).toEqual(
    [],
  );
  x.store.close();
});

it("K1 HTTP serves candle paths byte for byte with history.json headers; malformed, query and missing paths are 404", async () => {
  const x = fixture();
  record(x);
  x.setClock(T + 3720);
  x.publisher.publish(10_000);
  const server = httpServer(x.pub),
    failing = httpServer(x.pub, async () => {
      throw Error("Read failed");
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => failing.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const res = await fetch(`${base}/candles/${T}.json`),
      bytes = readFileSync(x.file),
      history = await fetch(`${base}/history.json`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    for (const h of ["content-type", "access-control-allow-origin", "cache-control"])
      expect(res.headers.get(h)).toBe(history.headers.get(h));
    expect(res.headers.get("cache-control")).toBe("public, max-age=2");
    const etag = '"' + createHash("sha1").update(bytes).digest("hex") + '"';
    expect(res.headers.get("etag")).toBe(etag);
    expect(
      (await fetch(`${base}/candles/${T}.json`, { headers: { "if-none-match": etag } }))
        .status,
    ).toBe(304);
    const head = await fetch(`${base}/candles/${T}.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const path of [
      "/candles/x.json",
      `/candles/${T}.json?x=1`,
      "/candles/123.json",
      "/candles/1234567890123.json",
      "/candles/",
      `/candles/${T}.json/`,
    ])
      expect((await fetch(base + path)).status, path).toBe(404);
    const missing = await fetch(`${base}/candles/123.json`);
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    expect(server.stats().total["/candles/"]).toBeGreaterThan(0);
    expect(Object.keys(server.stats().total).every((k) => !k.includes(String(T)))).toBe(true);
    const port = (failing.address() as any).port;
    expect((await fetch(`http://127.0.0.1:${port}/candles/${T}.json`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/history.json`)).status).toBe(503);
  } finally {
    for (const srv of [server, failing]) {
      srv.closeAllConnections();
      srv.close();
    }
    x.store.close();
  }
});

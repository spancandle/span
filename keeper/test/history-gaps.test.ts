import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Store } from "../src/common/sqlite.js";
import { History } from "../src/tape/history.js";
import { DovesRecorder } from "../src/tape/doves.js";
it("devnet transaction-list/body failure opens a gap; successful resumption closes it at a recorded publication", async () => {
  const store = new Store(":memory:"),
    tx = JSON.parse(
      readFileSync(
        new URL("./fixtures/dev-feed-write.json", import.meta.url),
        "utf8",
      ),
    );
  let fail = true;
  const rpc = {
    cluster: "devnet",
    call: async (method: string) => {
      if (fail) throw Error("Unavailable");
      return method === "getSignaturesForAddress"
        ? [
            {
              signature: "source",
              slot: tx.slot,
              blockTime: tx.blockTime,
              err: null,
            },
          ]
        : tx;
    },
  } as any;
  const recorder = new DovesRecorder(store, rpc);
  recorder.startRecording(tx.blockTime - 120);
  recorder.cover(tx.blockTime + 120);
  const history = new History(
    store,
    rpc,
    (sig, v, slot) => recorder.sample(sig, v.price, v.publishTs, slot),
    () => {
      if (recorder.recording) recorder.gap("program-history");
    },
  );
  await expect(history.poll()).rejects.toThrow("Unavailable");
  expect(
    store.db
      .prepare(
        "SELECT 1 FROM gaps WHERE reason='program-history' AND b IS NULL",
      )
      .get(),
  ).toBeDefined();
  fail = false;
  await history.poll();
  recorder.closeGaps();
  expect(
    (store.db.prepare("SELECT COUNT(*) n FROM doves").get() as any).n,
  ).toBe(1);
  expect(
    store.db.prepare("SELECT b FROM gaps WHERE reason='program-history'").get(),
  ).toEqual({ b: recorder.lastPublishTs });
  store.close();
});
it("a new mainnet recording window starts at the current baseline instead of backfilling an inactive interval", async () => {
  const store = new Store(":memory:"),
    calls: any[] = [],
    rpc = {
      cluster: "mainnet",
      call: async (method: string, params: any[]) => {
        calls.push({ method, params });
        return [];
      },
    } as any,
    recorder = new DovesRecorder(store, rpc);
  recorder.startRecording(1000);
  store.set("doves-cursor", "old-window");
  recorder.stopRecording();
  expect(store.get("doves-cursor")).toBeUndefined();
  recorder.startRecording(2000);
  await recorder.poll(2000);
  expect(calls[0].params[1].until).toBeUndefined();
  store.close();
});

import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/common/sqlite.js";
import { DovesRecorder } from "../src/tape/doves.js";
import { Publisher } from "../src/tape/publish.js";
import type { Chain } from "../src/keeper/chain.js";
import type { History } from "../src/tape/history.js";

it("restart gaps stay open through delayed previous-window history and cover every unrecorded publication", () => {
  const dir = mkdtempSync(join(tmpdir(), "span-restart-gap-")),
    file = join(dir, "tape.sqlite"),
    rpc = { cluster: "devnet" } as any;
  let store = new Store(file), recorder = new DovesRecorder(store, rpc);
  recorder.startRecording(1000);
  recorder.sample("first", 100n, 1000, 1);
  recorder.sample("last-before-delay", 110n, 1010, 2);
  recorder.closeGaps();
  recorder.cover(1016);
  store.close();

  store = new Store(file);
  recorder = new DovesRecorder(store, rpc);
  recorder.startRecording(1022);
  const coveredSample = (ts: number) => {
    if (store.db.prepare("SELECT 1 FROM coverage WHERE start_ts<=? AND end_ts>=?").get(ts, ts))
      recorder.sample(`history-${ts}`, BigInt(ts), ts, ts);
  };
  // First successful history batch only reaches old coverage; the outage's
  // later publications cannot be reconstructed by this recording window.
  for (let ts = 1011; ts <= 1020; ts++) coveredSample(ts);
  recorder.closeGaps();
  expect(store.db.prepare("SELECT COUNT(*) n FROM gaps WHERE b IS NULL").get()).toEqual({ n: 2 });
  expect(store.db.prepare("SELECT COUNT(*) n FROM doves WHERE publish_ts BETWEEN 1017 AND 1021").get()).toEqual({ n: 0 });

  recorder.cover(1030);
  for (let ts = 1021; ts <= 1024; ts++) coveredSample(ts);
  recorder.closeGaps();
  const publisher = new Publisher(store, {} as Chain, {} as History, recorder, dir), gaps = publisher.gaps();
  expect(gaps.filter((g) => g.a === 1010)).toEqual([
    { a: 1010, b: 1022, reason: "process-start" },
    { a: 1010, b: 1022, reason: "recording-start" },
  ]);
  for (let ts = 1017; ts <= 1021; ts++)
    expect(gaps.some((g) => g.a < ts && (g.b === null || ts < g.b))).toBe(true);
  expect(publisher.doves(1018, 1030)).toMatchObject({ complete: false });
  // A failure within the current window still closes at its latest sample.
  recorder.gap("program-history");
  recorder.sample("resumed-in-window", 120n, 1026, 1026);
  recorder.closeGaps();
  expect(publisher.gaps().find((g) => g.reason === "program-history")).toEqual({ a: 1024, b: 1026, reason: "program-history" });
  console.log("RESTART_GAPS " + JSON.stringify({ gaps: publisher.gaps(), missingPublications: [1017,1018,1019,1020,1021], interval: publisher.doves(1018,1030) }));
  store.close();
});

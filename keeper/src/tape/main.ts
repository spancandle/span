import { resolve } from "node:path";
import { unwrapOption } from "@solana/kit";
import { cluster, dataDir } from "../common/env.js";
import { log, safeError } from "../common/log.js";
import { RpcPool } from "../common/rpc.js";
import { Subscriptions } from "../common/ws.js";
import { Store } from "../common/sqlite.js";
import { Chain } from "../keeper/chain.js";
import { History } from "./history.js";
import { DovesRecorder } from "./doves.js";
import { Publisher } from "./publish.js";
import { SpanDecimals } from "./state.js";
import { ChainReader } from "./chain.js";
import { httpServer, atomicFile } from "./http.js";
import { readKeeperTelemetry } from "../common/telemetry.js";
import { ROOT } from "../common/env.js";
export async function runTape() {
  const rpc = new RpcPool(cluster());
  await rpc.initialize();
  const ws = new Subscriptions(rpc, 2000),
    chain = new Chain(rpc, ws);
  await chain.init();
  const dir = dataDir(),
    pub = resolve(dir, "public"),
    store = new Store(resolve(dir, "tape.sqlite")),
    recorder = new DovesRecorder(store, rpc);
  const history = new History(
    store,
    rpc,
    (sig, v, slot) => {
      const ts = Number(v.publishTs);
      if (
        store.db
          .prepare("SELECT 1 FROM coverage WHERE start_ts<=? AND end_ts>=?")
          .get(ts, ts)
      ) {
        recorder.sample(sig, v.price, v.publishTs, slot);
      }
    },
    () => {
      if (recorder.recording) recorder.gap("program-history");
    },
  );
  const decimals = new SpanDecimals(rpc),
    spanMint = () =>
      chain.config ? (unwrapOption(chain.config.spanMint) ?? null) : null,
    readDecimals = () =>
      guarded("span-mint-error", () => decimals.refresh(spanMint()));
  const publisher = new Publisher(store, chain, history, recorder, pub, (m) =>
      decimals.get(m),
    ),
    chainReader = new ChainReader(rpc, pub, history),
    server = httpServer(pub);
  await new Promise<void>((yes, no) => {
    server.once("error", () => no(Error("Tape HTTP listener unavailable")));
    server.listen(
      Number(process.env.TAPE_PORT || 8789),
      process.env.TAPE_HOST || "127.0.0.1",
      yes,
    );
  });
  chain.start("tape");
  const guarded = (event: string, fn: () => Promise<unknown>) =>
    void fn().catch(() => log({ event }));
  let keepers: any[] = [];
  const status = () => {
    void readKeeperTelemetry(
      resolve(ROOT, process.env.KEEPER_DATA_DIR || "keeper/data"),
      rpc.cluster,
    ).then((x) => (keepers = x));
    const value = publisher.status(server.stats(), keepers);
    atomicFile(pub, "status.json", value);
    return value;
  };

  const record = () => {
    const now = Number(chain.now());
    if (chain.recording()) {
      recorder.startRecording(now);
      recorder.cover(now);
      guarded("doves-read-error", () => recorder.poll(now));
    } else recorder.stopRecording();
  };
  record();
  await decimals
    .refresh(spanMint())
    .catch(() => log({ event: "span-mint-error" }));
  guarded("history-read-error", () => history.poll());
  guarded("blockhash-error", () => chainReader.refresh());
  publisher.publish();
  status();
  const timers = [
    setInterval(record, 1000),
    setInterval(() => {
      guarded("history-read-error", async () => {
        await history.poll();
        if (recorder.recording && rpc.cluster === "devnet")
          recorder.closeGaps();
      });
    }, 2000),
    setInterval(() => {
      try {
        publisher.publish();
        chainReader.publish();
      } catch (e) {
        log({ event: "publish-error", error: safeError(e) });
      }
    }, 250),
    setInterval(
      () => guarded("blockhash-error", () => chainReader.refresh()),
      2000,
    ),
    setInterval(
      () =>
        guarded("fee-error", () =>
          chainReader.fees([...chain.candles.keys(), ...chain.tickets.keys()]),
        ),
      15000,
    ),
    setInterval(() => status(), 5000),
    setInterval(readDecimals, 1000),
    setInterval(() => {
      publisher.prune(Number(chain.now()));
      log({
        event: "tape-minute",
        rss: process.memoryUsage().rss,
        cpu: process.resourceUsage(),
        rpc: rpc.metrics.snapshot(),
        status: status(),
      });
    }, 60000),
  ];
  const close = () => {
    timers.forEach(clearInterval);
    chain.close();
    rpc.close();
    server.close();
    store.close();
  };
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });
  log({ event: "tape-ready", cluster: rpc.cluster });
  return { close, store, chain, history, publisher, recorder };
}
if (process.argv[1]?.endsWith("/tape/main.ts"))
  void runTape().catch((e) => {
    log({ event: "fatal", error: safeError(e) });
    process.exitCode = 1;
  });

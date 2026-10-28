import { it, expect } from "vitest";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Harness, accountData, type Ref } from "../../program/tests/harness.js";
import {
  getConfigDecoder,
  highLow,
  payout,
} from "../../program/client/index.js";
import { Engine } from "../src/keeper/engine.js";
import type { Chain } from "../src/keeper/chain.js";
import type { Prepared } from "../src/keeper/sender.js";
const vectors = JSON.parse(
  readFileSync(
    new URL("../../program/tests/replay-vectors.json", import.meta.url),
    "utf8",
  ),
);
const directory = process.env.SPAN_REPLAY_DIR;
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
it.skipIf(!directory)(
  "S5 runs the production decision engine against all nine LiteSVM hours at 0/2/8/18-slot landing delays",
  async () => {
    const output: any[] = [];
    for (const file of readdirSync(directory!)
      .filter((x) => x.endsWith(".json"))
      .sort()) {
      const input = JSON.parse(readFileSync(join(directory!, file), "utf8")),
        date = input.label.split("_")[1],
        hour = input.label.startsWith("FOMC")
          ? "17:59"
          : input.label.startsWith("OPEN")
            ? "13:29"
            : "12:29",
        t0 = BigInt(Date.parse(`${date}T${hour}:00Z`) / 1000);
      for (const delay of [0, 2, 8, 18]) {
        const h = await Harness.create({ setSpan: true }),
          refs: Ref[] = [];
        for (const step of [2, 5, 10, 25])
          refs.push(await h.open({ t0, loaded: true, step }));
        const chain = {
          candles: new Map(),
          tickets: new Map(),
          config: getConfigDecoder().decode(accountData(h.svm, h.config)),
          feed: undefined,
          now: () => h.svm.getClock().unixTimestamp,
        } as unknown as Chain;
        const sync = () => {
          chain.candles.set(refs[0].candle, {
            value: h.candleState(refs[0]),
            slot: 0,
            data: "",
          });
          for (const t of refs)
            chain.tickets.set(t.ticket, {
              value: h.ticketState(t),
              slot: 0,
              data: "",
            });
        };
        sync();
        const queue: { p: Prepared; due: bigint }[] = [];
        let slot = 0n;
        const engine = new Engine(
          chain,
          h.marker.address,
          {
            blockhash: () => "replay",
            price: () => 10000n,
            prepare: async (action, price) => ({
              action,
              price,
              signature: action.key,
              wire: "",
              blockhash: "replay",
              lastValidBlockHeight: 999999999n,
              rent: 0n,
            }),
            send: (p) => {
              if (p.action.kind !== "settle")
                queue.push({ p, due: slot + BigInt(delay) });
            },
            cancel: () => {},
          },
          { available: () => true, reserve: () => true, waiting: new Set() },
          () => {},
        );
        const run = async () => {
          for (let round = 0; round < 12; round++) {
            await flush();
            const eligible = queue.filter((x) => x.due <= slot);
            if (!eligible.length) break;
            for (const entry of eligible) {
              queue.splice(queue.indexOf(entry), 1);
              const { p } = entry,
                a = p.action,
                t = a.ticket
                  ? refs.find((t) => t.ticket === a.ticket)!
                  : refs[0];
              try {
                await h.send(
                  "engine_replay",
                  a.kind === "read" ? h.readIx(t, a.j!) : h.markIx(t),
                  a.kind === "mark" ? h.marker : h.stranger,
                );
                sync();
                engine.result(p, null, "signature");
                engine.update();
              } catch (e) {
                const name =
                  /Error Code: (\w+)/.exec(String(e))?.[1] ?? "Other";
                if (name === "BeforeBoundary") {
                  queue.push({ p, due: slot + 1n });
                } else {
                  engine.result(p, name, "signature");
                  if (a.kind === "mark") engine.update();
                }
              }
            }
          }
        };
        const first = input.writes[0],
          last = input.writes.at(-1);
        const slotSeconds =
          (Number(last.blockTime) - Number(first.blockTime)) /
          (Number(last.slot) - Number(first.slot));
        const drainBefore = async (
          limit: bigint,
          previous: any,
          next?: any,
        ) => {
          for (let count = 0; count < 10000; count++) {
            await flush();
            const due = queue.length
              ? queue.reduce((n, x) => (x.due < n ? x.due : n), queue[0].due)
              : undefined;
            if (due === undefined || due >= limit) return;
            slot = due;
            const fraction = next
              ? (Number(due) - Number(previous.slot)) /
                (Number(next.slot) - Number(previous.slot))
              : 0;
            const clock = next
              ? Math.floor(
                  Number(previous.blockTime) +
                    fraction *
                      (Number(next.blockTime) - Number(previous.blockTime)),
                )
              : Math.floor(
                  Number(previous.blockTime) +
                    (Number(due) - Number(previous.slot)) * slotSeconds,
                );
            h.clock(BigInt(clock), slot);
            engine.update();
            await run();
          }
          throw Error("Replay event queue did not advance");
        };
        let previous: any;
        for (const w of input.writes) {
          if (previous) await drainBefore(BigInt(w.slot), previous, w);
          slot = BigInt(w.slot);
          h.clock(BigInt(w.blockTime), slot);
          h.price(BigInt(w.price), BigInt(w.publish_ts));
          chain.feed = {
            price: BigInt(w.price),
            publishTs: BigInt(w.publish_ts),
            slot: Number(slot),
            recvMs: Date.now(),
            source: "ws",
          };
          engine.update();
          await run();
          previous = w;
        }
        // At equal slots the source write precedes queued landings. Between
        // writes Clock is interpolated; no additional oracle values are made.
        await drainBefore(slot + 100n, previous);
        const c = h.candleState(refs[0]);
        for (let i = 0; i < 4; i++) {
          const t = h.ticketState(refs[i]),
            step = [2, 5, 10, 25][i],
            { high, low } = highLow(c, t),
            actual = {
              reads: c.reads.filter((r) => r.price > 0n).length,
              marks: t.marks,
              high: String(high),
              low: String(low),
              payout: String(payout(c, t)),
            },
            expected = vectors[input.label][step];
          if (delay === 0)
            expect(actual, `${input.label}/${step}`).toEqual({
              reads: expected.reads,
              marks: expected.marks,
              high: expected.high,
              low: expected.low,
              payout: expected.payout,
            });
          output.push({
            label: input.label,
            step,
            delay,
            ...actual,
            markDifference: t.marks - expected.marks,
            payoutDifference: String(
              BigInt(actual.payout) - BigInt(expected.payout),
            ),
          });
        }
        engine.close();
        console.log(
          `ENGINE_REPLAY ${input.label} delay=${delay}: ${c.reads.filter((r) => r.price > 0n).length}/13 reads; four tickets`,
        );
      }
    }
    mkdirSync(new URL("../data/checks/", import.meta.url), { recursive: true });
    writeFileSync(
      new URL("../data/checks/replay.json", import.meta.url),
      JSON.stringify(output, null, 2) + "\n",
    );
    expect(output).toHaveLength(144);
    console.log("ENGINE_REPLAY_TABLE " + JSON.stringify(output));
  },
  600000,
);

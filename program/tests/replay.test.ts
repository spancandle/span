import { it, expect } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, json, type Ref } from "./harness.js";
import { markAccepts, payout, highLow, settleAfter } from "../client/math.js";
const dir = process.env.SPAN_REPLAY_DIR;
if (!dir)
  console.log("SKIP: SPAN_REPLAY_DIR is unset; price replay is not requested.");
const vectors = JSON.parse(
  readFileSync(new URL("./replay-vectors.json", import.meta.url), "utf8"),
);
it.skipIf(!dir)(
  "P12 executes every price replay and eight-second delayed reads",
  async () => {
    const rows: any[] = [];
    for (const file of readdirSync(dir!)
      .filter((x) => x.endsWith(".json"))
      .sort()) {
      const input = JSON.parse(readFileSync(join(dir!, file), "utf8"));
      const date = input.label.split("_")[1];
      const hour = input.label.startsWith("FOMC")
        ? "17:59"
        : input.label.startsWith("OPEN")
          ? "13:29"
          : "12:29";
      const t0 = BigInt(Date.parse(`${date}T${hour}:00Z`) / 1000);
      const h = await Harness.create({ setSpan: true });
      const tickets: Ref[] = [];
      for (const step of [2, 5, 10, 25])
        tickets.push(await h.open({ t0, loaded: true, step }));
      const tried = new Set<number>();
      for (const w of input.writes) {
        const now = BigInt(w.blockTime),
          ts = BigInt(w.publish_ts),
          price = BigInt(w.price);
        h.clock(now, BigInt(w.slot));
        h.price(price, ts);
        for (let j = 0; j < 13; j++) {
          const b = t0 + 300n * BigInt(j);
          if (!tried.has(j) && ts >= b && now >= b) {
            tried.add(j);
            await h.send("replay_read", h.readIx(tickets[0], j));
          }
        }
        if (ts > t0 && ts <= t0 + 3600n)
          for (const t of tickets) {
            if (markAccepts(h.candleState(t), h.ticketState(t), price).accepted)
              await h.send("replay_mark", h.markIx(t));
          }
      }
      const candle = h.candleState(tickets[0]);
      expect(candle.reads.filter((x) => x.price > 0n)).toHaveLength(13);
      for (let i = 0; i < 4; i++) {
        const t = tickets[i],
          ticket = h.ticketState(t),
          step = [2, 5, 10, 25][i],
          expected = vectors[input.label][step];
        const { high, low } = highLow(candle, ticket),
          paid = payout(candle, ticket);
        expect({
          reads: candle.reads.filter((x) => x.price > 0n).length,
          marks: ticket.marks,
          high: high.toString(),
          low: low.toString(),
          payout: paid.toString(),
          readPayout: payout(candle, {
            ...ticket,
            strikeBps: 0, tailHigh: 0n,
            tailLow: 0n,
          }).toString(),
        }).toEqual(expected);
        h.clock(settleAfter(candle));
        await h.send("replay_settle", h.settleIx(t));
        expect(h.svm.getAccount(t.ticket).exists).toBe(false);
        expect(h.svm.getAccount(t.vault).exists).toBe(false);
        expect(h.svm.getAccount(t.spanHold).exists).toBe(false);
        rows.push({ label: input.label, step, ...expected });
      }
      const delayed = await Harness.create();
      const t = await delayed.open({ t0 });
      for (let j = 0; j < 13; j++) {
        const boundary = t0 + BigInt(j) * 300n;
        const first = input.writes.find(
          (w: any) =>
            BigInt(w.publish_ts) >= boundary && BigInt(w.blockTime) >= boundary,
        );
        if (!first) throw Error("Missing boundary");
        const x = BigInt(first.blockTime) + 8n;
        const last = input.writes
          .filter((w: any) => BigInt(w.blockTime) <= x)
          .at(-1);
        delayed.clock(x);
        delayed.price(BigInt(last.price), BigInt(last.publish_ts));
        await delayed.send("delayed_read", delayed.readIx(t, j));
      }
      expect(
        delayed.candleState(t).reads.filter((x) => x.price > 0n),
      ).toHaveLength(13);
      console.log(
        `REPLAY ${input.label}: 4 tickets match; 13/13 reads; delayed 13/13`,
      );
    }
    expect(rows).toHaveLength(Object.keys(vectors).length * 4);
    writeFileSync(
      new URL("../target/checks/replay.json", import.meta.url),
      json(rows) + "\n",
    );
    console.log("REPLAY_TABLE " + json(rows));
  },
  120_000,
);

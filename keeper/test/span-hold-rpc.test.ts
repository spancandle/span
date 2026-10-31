import { expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { Harness } from "../../program/tests/harness.js";
import { Chain } from "../src/keeper/chain.js";
import { RpcPool } from "../src/common/rpc.js";

// The websocket's slot often runs ahead of the HTTP node that answers. A balance read must not ask for that
// slot: the node refuses (-32016) and the pool would hold the endpoint for every other call.
it("SPAN balance reads succeed on an RPC node behind the websocket slot and leave its endpoints in use", async () => {
  const h = await Harness.create({ setSpan: true }), ref = await h.open({ loaded: true, sold: true });
  h.clock(ref.t0 + 30n);
  const node = 100;
  const raw = (key: Address) => {
    const a = h.svm.getAccount(key);
    return a.exists ? { owner: a.programAddress, data: [Buffer.from(a.data).toString("base64"), "base64"] } : null;
  };
  const transport = async (_url: string, init: { body: string }) => {
    const q = JSON.parse(init.body), min = q.params[1]?.minContextSlot;
    const body = min !== undefined && min > node
      ? { jsonrpc: "2.0", id: 1, error: { code: -32016, message: "Minimum context slot has not been reached" } }
      : { jsonrpc: "2.0", id: 1, result: { context: { slot: node }, value: q.params[0].map(raw) } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const rpc = new RpcPool("devnet", [
    { name: "public", url: "http://public.invalid", ws: "" },
    { name: "fallback", url: "http://fallback.invalid", ws: "" },
  ], transport as any, () => {});
  for (const e of rpc.list) e.verified = true;
  const chain = new Chain(rpc, {} as any, () => {}, h.marker.address);
  chain.config = h.configState();
  chain.now = () => h.svm.getClock().unixTimestamp;
  chain.candles.set(ref.candle, { value: h.candleState(ref), slot: 1, data: "" });
  chain.tickets.set(ref.ticket, { value: h.ticketState(ref), slot: 1, data: "" });
  chain.slot = node + 3;
  await chain.pollSpanHolds("keeper");
  expect(chain.spanHolds.get(ref.ticket)?.amount).toBeGreaterThan(0n);
  expect(rpc.list.map((e) => (e.hold ?? 0) > Date.now())).toEqual([false, false]);
  rpc.close();
});

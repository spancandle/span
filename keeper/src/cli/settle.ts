import { resolve } from "node:path";
import { address } from "@solana/kit";
import * as s from "../../../program/client/index.js";
import { cluster, ROOT, sleep } from "../common/env.js";
import { RpcPool } from "../common/rpc.js";
import { account, bytes, signerFile, settlement } from "../keeper/chain.js";
import { prepareTransaction, errorName } from "../keeper/sender.js";
import { log, safeError } from "../common/log.js";
export async function settleOne(key: string) {
  const c = cluster();
  if (c !== "devnet") throw Error("This command sends only to devnet");
  const rpc = new RpcPool(c);
  await rpc.initialize();
  try {
    const payer = await signerFile(
        resolve(ROOT, process.env.KEEPER_KEYPAIR || "keys/devnet-keeper.json"),
      ),
      ticketAddress = address(key),
      ticket = s.getTicketDecoder().decode(bytes(await account(rpc, key))),
      config = s
        .getConfigDecoder()
        .decode(bytes(await account(rpc, (await s.findConfigPda())[0]))),
      candle = s
        .getCandleDecoder()
        .decode(
          bytes(await account(rpc, (await s.findCandlePda(ticket.t0))[0])),
        );
    const { ixs, rent } = await settlement(
        rpc,
        payer,
        config,
        candle,
        ticket,
        ticketAddress,
      ),
      latest = (
        await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }])
      ).value;
    const p = await prepareTransaction(
      ixs,
      payer,
      {
        blockhash: latest.blockhash,
        lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
      },
      { key: `settle:${key}`, kind: "settle", ticket: key, t0: ticket.t0 },
      10000n,
      rent,
    );
    const sim = await rpc.call("simulateTransaction", [
      p.wire,
      { encoding: "base64", commitment: "processed", sigVerify: true },
    ]);
    if (sim.value.err) throw Error(errorName(sim.value.err));
    await rpc.call("sendTransaction", [
      p.wire,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 0,
      },
    ]);
    for (let i = 0; i < 120; i++) {
      const v = (await rpc.call("getSignatureStatuses", [[p.signature]]))
        .value[0];
      if (v?.err) throw Error(errorName(v.err));
      if (
        v?.confirmationStatus === "confirmed" ||
        v?.confirmationStatus === "finalized"
      ) {
        log({ event: "settled", ticket: key, signature: p.signature, rent });
        return p.signature;
      }
      await sleep(500);
    }
    throw Error("Settlement confirmation timeout");
  } finally {
    rpc.close();
  }
}
if (process.argv[1]?.endsWith("/cli/settle.ts"))
  void settleOne(process.argv[2] ?? "").catch((e) => {
    log({ event: "fatal", error: safeError(e) });
    process.exitCode = 1;
  });

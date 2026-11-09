import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { address } from "@solana/kit";
import type { Cluster } from "../common/env.js";

/** A repository-local OS lock; separate hosts require separate operational coordination. */
export function keeperLock(root: string, cluster: Cluster, signer: string) {
  address(signer);
  if (cluster !== "mainnet" && cluster !== "devnet") throw Error("Invalid lock cluster");
  const dir = join(root, "keeper/data/locks");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${cluster}-${signer}.lock`), "a", 0o600);
  const result = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
  if (result.error || result.status !== 0) {
    closeSync(fd);
    if (result.error) throw Error("Keeper lock requires the flock utility");
    throw Error(result.status === 1 ? "Keeper signer is already running" : "Keeper lock unavailable");
  }
  let closed = false;
  return () => { if (!closed) { closed = true; closeSync(fd); } };
}

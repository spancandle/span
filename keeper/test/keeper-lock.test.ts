import { expect, it, vi } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSigner } from "@solana/kit";
import { keeperLock } from "../src/keeper/lock.js";

const modulePath = new URL("../src/keeper/lock.ts", import.meta.url).href;
function child(root: string, signer: string) {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {keeperLock} from ${JSON.stringify(modulePath)};try{keeperLock(${JSON.stringify(root)},"devnet",${JSON.stringify(signer)});console.log("locked");setInterval(()=>{},1000);}catch(e){console.error(e.message);process.exit(1);}`],
    { stdio: ["ignore", "pipe", "pipe"] });
}
function outcome(p: ChildProcess) {
  return new Promise<"locked" | "rejected">((yes, no) => {
    p.once("error", no); p.stdout!.once("data", () => yes("locked")); p.once("exit", code => { if (code) yes("rejected"); });
  });
}
async function kill(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise<void>(r => p.once("exit", () => r())); p.kill("SIGKILL"); await exited;
}
it("OS lock survives different data paths, releases on close/kill and does not serialize different signers", async () => {
  const root = mkdtempSync(join(tmpdir(), "span-lock-")), a = (await generateKeyPairSigner()).address, b = (await generateKeyPairSigner()).address;
  const release = keeperLock(root, "devnet", a), contender = child(root, a);
  expect(await outcome(contender)).toBe("rejected"); release(); release();
  const first = child(root, a); expect(await outcome(first)).toBe("locked");
  const other = child(root, b); expect(await outcome(other)).toBe("locked");
  try {
    expect(() => keeperLock(root, "devnet", a)).toThrow("already running");
    await kill(first);
    const restarted = keeperLock(root, "devnet", a); restarted();
    expect(existsSync(join(root, `keeper/data/locks/devnet-${a}.lock`))).toBe(true);
  } finally { await kill(first); await kill(other); }
});
it("exactly one simultaneous process wins the same signer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "span-lock-race-")), signer = (await generateKeyPairSigner()).address,
    a = child(root, signer), b = child(root, signer);
  try { expect((await Promise.all([outcome(a), outcome(b)])).sort()).toEqual(["locked", "rejected"]); }
  finally { await kill(a); await kill(b); }
});
it("a missing flock is an explicit startup failure and closes the parent fd", async () => {
  const root = mkdtempSync(join(tmpdir(), "span-no-flock-")), signer = (await generateKeyPairSigner()).address;
  vi.stubEnv("PATH", root);
  try { expect(() => keeperLock(root, "devnet", signer)).toThrow("requires the flock utility"); }
  finally { vi.unstubAllEnvs(); }
  const release = keeperLock(root, "devnet", signer); release();
  expect(spawnSync("flock", ["--version"]).status).toBe(0);
});

import { readFileSync } from "node:fs";
import { address, type Address } from "@solana/kit";
import { SPAN_PROGRAM_ADDRESS } from "../../../program/client/index.js";
import type { Cluster } from "./env.js";
import type { ReaderOptions } from "../keeper/reader-policy.js";

export type Reader = ReaderOptions & { id: "greedy" | "paced-v1"; marker: Address };
export type ReadersFile = { v: 1; readers: Reader[] };
const keys = (v: any, expected: string[]) => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...expected].sort().join(",");
export function validateReaders(value: unknown): ReadersFile {
  const v = value as any;
  if (!keys(v, ["v", "readers"]) || v.v !== 1 || !Array.isArray(v.readers) || v.readers.length !== 2)
    throw Error("Invalid readers configuration");
  const readers: Reader[] = ["greedy", "paced-v1"].map(id => {
    const r = v.readers.find((r: any) => r?.id === id), mode = id === "greedy" ? "full" : "marks";
    if (!keys(r, ["id", "marker", "mode", "policy"]) || r.mode !== mode || r.policy !== id || typeof r.marker !== "string")
      throw Error("Invalid reader entry");
    try { return { id, marker: address(r.marker), mode, policy: id } as Reader; }
    catch { throw Error("Invalid reader address"); }
  });
  if (readers[0].marker === readers[1].marker) throw Error("Reader addresses must differ");
  return { v: 1, readers };
}
export function loadReaders(path?: string): ReadersFile | undefined {
  if (!path) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw Error("Unable to load readers configuration"); }
  return validateReaders(value);
}
export function checkReaderSigner(readers: ReadersFile | undefined, signer: Address, options: ReaderOptions) {
  if (!readers && options.policy === "greedy") return;
  if (!readers || readers.readers.find(r => r.policy === options.policy)?.marker !== signer)
    throw Error("Reader signer does not match configuration");
}
export function readersDocument(cluster: Cluster, configured?: ReadersFile) {
  return { v: 1, cluster, program: SPAN_PROGRAM_ADDRESS, readers: (configured?.readers ?? []).map(r =>
    r.policy === "paced-v1" ? { ...r, intervalSeconds: 300, budgetBasis: "initial-load-reserve",
      topUp: "immediately-available-above-reserve" } : { ...r }) };
}

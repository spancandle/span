import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, type Cluster } from "../src/common/env.js";
export type ServiceValues = { repo: string; cluster: Cluster; signer: string; data: string; npm: string; path: string; cloudflared: string; tunnelConfig: string; keeperData?: string; ws?: string };
const safe = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw Error("Invalid service value");
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
};
export function renderServices(values: ServiceValues, templates = resolve(ROOT, "keeper/deploy")) {
  const tokens: Record<string, string> = { REPO: values.repo, CLUSTER: values.cluster, SIGNER: values.signer, DATA: values.data, KEEPER_DATA: values.keeperData ?? `keeper/data/${values.cluster}`, WS: values.ws ?? "",
    NPM: values.npm, PATH: values.path, CLOUDFLARED: values.cloudflared, TUNNEL_CONFIG: values.tunnelConfig };
  const out: Record<string, string> = {};
  for (const name of ["keeper", "tape", "tunnel"]) {
    let text = readFileSync(join(templates, `span-${name}.service`), "utf8");
    for (const [key, value] of Object.entries(tokens)) text = text.replaceAll(`@${key}@`, safe(value));
    if (/@[A-Z_]+@/.test(text)) throw Error("Unfilled service value");
    if (name === "tunnel" && values.cluster === "devnet")
      text = text.replace(/^ExecStart=.*$/m, `ExecStart=${safe(values.cloudflared)} tunnel --config /dev/null --no-autoupdate --protocol http2 --edge-ip-version 4 --url http://127.0.0.1:8789`);
    out[`span-${values.cluster}-${name}.service`] = text;
  }
  return out;
}
export function installServices(values: ServiceValues, out = resolve(homedir(), ".config/systemd/user"), run = () => execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" })) {
  const units = renderServices(values);
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(units)) writeFileSync(join(out, name), text, { mode: 0o600 });
  run();
  return Object.keys(units);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = (key: string) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined;
  const cluster = arg("--cluster");
  if (cluster !== "mainnet" && cluster !== "devnet") throw Error("Required --cluster mainnet|devnet");
  const signer = arg("--keeper-key") ?? process.env.KEEPER_KEYPAIR;
  if (!signer) throw Error("Required --keeper-key or KEEPER_KEYPAIR");
  const home = homedir(), npm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
  const names = installServices({ repo: ROOT.replace(/\/$/, ""), cluster, signer: resolve(signer), data: `keeper/data/${cluster === "devnet" ? "devnet-rehearsal" : "mainnet"}/tape`, keeperData: `keeper/data/${cluster === "devnet" ? "devnet-rehearsal" : "mainnet"}`, ws: arg("--ws"), npm,
    path: [dirname(process.execPath), join(home, ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    cloudflared: join(home, ".local/bin/cloudflared"), tunnelConfig: arg("--tunnel-config") ?? join(home, ".cloudflared/span.yml") }, arg("--out"));
  console.log(JSON.stringify({ installed: names, started: false, lingerChanged: false }));
}

import { createServer, createConnection } from "node:net";
import { mkdirSync, readdirSync, unlinkSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { json } from "./env.js";
/** Local, ephemeral IPC for the read-only tape; it stores no keeper state. */
export function keeperTelemetry(
  dir: string,
  cluster: string,
  address: string,
  read: () => unknown,
) {
  mkdirSync(dir, { recursive: true });
  const path = resolve(
    dir,
    `${cluster}-keeper-${createHash("sha256").update(address).digest("hex").slice(0, 12)}.sock`,
  );
  // A reader that leaves before the answer is written must not take the keeper down with it.
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.end(json(read()) + "\n");
  });
  let owns = false;
  server.on("error", () => {});
  const listen = () =>
    server.listen(path, () => {
      owns = true;
      chmodSync(path, 0o600);
    });
  // A stale socket has no listener; a live process must never be unlinked.
  const probe = createConnection(path);
  probe.once("connect", () => probe.end());
  probe.once("error", () => {
    try {
      unlinkSync(path);
    } catch {}
    listen();
  });
  return () => {
    probe.destroy();
    server.close();
    if (owns)
      try {
        unlinkSync(path);
      } catch {}
  };
}
export async function readKeeperTelemetry(dir: string, cluster: string) {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (x) => x.startsWith(`${cluster}-keeper-`) && x.endsWith(".sock"),
    );
  } catch {
    return [];
  }
  return (
    await Promise.all(
      files.map(
        (file) =>
          new Promise<any>((resolveValue) => {
            let data = "";
            const socket = createConnection(resolve(dir, file)),
              timer = setTimeout(() => {
                socket.destroy();
                resolveValue(null);
              }, 300);
            socket.on("data", (b) => {
              data += b.toString();
              if (data.length > 16384) socket.destroy();
            });
            socket.on("end", () => {
              clearTimeout(timer);
              try {
                resolveValue(JSON.parse(data));
              } catch {
                resolveValue(null);
              }
            });
            socket.on("error", () => {
              clearTimeout(timer);
              resolveValue(null);
            });
          }),
      ),
    )
  ).filter(Boolean);
}

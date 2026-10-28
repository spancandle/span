# span keeper and tape

Requires Node 26.11.1. Install with `npm ci`, then run `npm run typecheck` and `npm test`. The package imports the sibling `program/client`.

Run `npm run keeper` to record reads, extend eligible ticket tails and settle every expired ticket. Run `npm run tape` separately to serve six JSON snapshots on `127.0.0.1:8789`. The tape does not use a signing key and an HTTP request never calls RPC.

Both processes load the repository root `.env` when present. `SPAN_CLUSTER` defaults to `devnet`. Public cluster RPC is always first. Optional devnet endpoints use `DEVNET_RPC_URL_FALLBACK`, `DEVNET_RPC_URL_FALLBACK_2` and their `DEVNET_RPC_WS_URL_FALLBACK` equivalents. Mainnet read endpoints use the names without `DEVNET_`. `SPAN_WS_URL` overrides only the public WebSocket. Endpoint URLs are never logged.

`KEEPER_KEYPAIR` defaults to `keys/<cluster>-keeper.json` relative to the repository root. Keep key files private and outside version control. Use a dedicated fee wallet. **Do not run two keeper processes with the same key.** Different fee wallets can operate independently. Sending to mainnet is disabled unless `KEEPER_ALLOW_MAINNET=1`; deployment and mainnet operation require separate operator setup.

Priority fees use the positive 75th percentile, clamped by `KEEPER_PRIORITY_FEE_MIN` and `KEEPER_PRIORITY_FEE_MAX` (default 10,000 and 1,000,000 microlamports/CU). `KEEPER_CREATE_BUDGET_LAMPORTS` defaults to 50,000,000 per trailing 24 hours. When the recipient needs an account and the budget is exhausted or its finalized history is incomplete, settlement waits. Settlements requiring no account creation continue.

`KEEPER_DATA_DIR` defaults to `keeper/data`. Give each fee wallet its own data directory, including when running different keys concurrently. A single blockhash expiration height is stored durably there before signing. After a restart, reads and marks start immediately. Account-creating settlements wait for finalized history beyond the previous height; if the height file is missing they wait ten minutes before reconstruction. Pending creation costs remain reserved until a complete finalized recount proves their result or expiration.

Anyone can settle one ticket with their own fee wallet, including while the public keeper's creation budget is exhausted:

```sh
SPAN_CLUSTER=devnet KEEPER_KEYPAIR=keys/my-wallet.json NO_DNA=1 npm run settle -- <ticket-address>
```

This command simulates, creates any necessary receiving accounts, and sends an atomic settlement transaction. Buyer and seller signatures are unnecessary. Replaced receiving accounts belong to the original recipient; memo-required Token-2022 ATAs receive their remainder in a fresh normal token account.

Tape storage uses built-in SQLite under `TAPE_DATA_DIR` (default `keeper/data`) and atomically publishes `public/state.json`, `tickets.json`, `feed.json`, `history.json`, `chain.json`, `status.json`. `TAPE_HOST` and `TAPE_PORT` default to 127.0.0.1 and 8789. Stop with SIGTERM. Restart backfills confirmed program transactions and retains receipts after ticket closure. Feed gaps represent recorder outages or unreadable transaction history, not a pause in oracle publications. Budget wait counts reach status.json through a local Unix socket; the socket is ephemeral and persists no decision state. The generated timestamp freezes when state is stale; chain snapshots stop updating when the blockhash is older than 15 seconds. Consumers must check freshness.

Run optional historical replay with `SPAN_REPLAY_DIR=<input-directory> NO_DNA=1 npm test`. `npm run devnet:e2e` runs real-time integration scenarios and uses devnet SOL and test tokens. `npm run observe:mainnet` is a read-only one-hour oracle recording check. Generated data and keys are ignored by git.

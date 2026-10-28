import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export class Store {
  readonly db: DatabaseSync;
  revision = 0;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS transactions(sig TEXT PRIMARY KEY,slot INTEGER NOT NULL,block_time INTEGER,received_ms INTEGER NOT NULL,raw TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(sig TEXT NOT NULL,idx INTEGER NOT NULL,name TEXT NOT NULL,slot INTEGER NOT NULL,block_time INTEGER,raw TEXT NOT NULL,PRIMARY KEY(sig,idx));
 CREATE INDEX IF NOT EXISTS events_name ON events(name,slot);
 CREATE TABLE IF NOT EXISTS doves(sig TEXT NOT NULL,publish_ts INTEGER NOT NULL,price TEXT NOT NULL,slot INTEGER NOT NULL,received_ms INTEGER NOT NULL,PRIMARY KEY(sig,publish_ts,price));
 CREATE INDEX IF NOT EXISTS doves_time ON doves(publish_ts);
 CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY,a INTEGER NOT NULL,b INTEGER,reason TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS coverage(id INTEGER PRIMARY KEY,start_ts INTEGER NOT NULL,end_ts INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS candle_history(t0 TEXT PRIMARY KEY,raw TEXT NOT NULL);
 `);
  }
  get(key: string) {
    return (this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as any)
      ?.value as string | undefined;
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  change() {
    this.revision++;
  }
  close() {
    this.db.close();
  }
}

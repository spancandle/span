import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { SOL_FEED } from "../../../program/client/constants.js";
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
 CREATE TABLE IF NOT EXISTS candle_history(t0 TEXT PRIMARY KEY,raw TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS hour_reason(t0 TEXT PRIMARY KEY,why TEXT NOT NULL,opener TEXT NOT NULL,sig TEXT NOT NULL);
 `);
    this.migrateFeeds();
  }
  private migrateFeeds() {
    const columns = this.db.prepare("PRAGMA table_info(doves)").all() as { name: string }[];
    const schema = (name: string) => name === 'doves'
      ? `sig TEXT NOT NULL,publish_ts INTEGER NOT NULL,price TEXT NOT NULL,slot INTEGER NOT NULL,received_ms INTEGER NOT NULL,feed TEXT NOT NULL DEFAULT '${SOL_FEED}',PRIMARY KEY(feed,sig,publish_ts,price)`
      : name === 'gaps' ? `id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,reason TEXT,feed TEXT NOT NULL DEFAULT '${SOL_FEED}'`
      : `id INTEGER PRIMARY KEY,start_ts INTEGER,end_ts INTEGER,feed TEXT NOT NULL DEFAULT '${SOL_FEED}'`;
    if (!columns.length || !columns.some(c => c.name === 'feed')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const name of ['doves','gaps','coverage']) {
          this.db.exec(`CREATE TABLE ${name}_feeds(${schema(name)})`);
          if (columns.length) this.db.exec(`INSERT INTO ${name}_feeds SELECT *, '${SOL_FEED}' FROM ${name}; DROP TABLE ${name}`);
          this.db.exec(`ALTER TABLE ${name}_feeds RENAME TO ${name}`);
        }
        this.db.prepare('INSERT OR IGNORE INTO kv(key,value) SELECT ?,value FROM kv WHERE key=?').run(`doves-cursor:${SOL_FEED}`,'doves-cursor');
        this.db.prepare('DELETE FROM kv WHERE key=?').run('doves-cursor');
        this.set('oracle-feeds-v1','1');this.db.exec('COMMIT');
      } catch(error) {this.db.exec('ROLLBACK');throw error;}
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS doves_time ON doves(feed,publish_ts); CREATE INDEX IF NOT EXISTS gaps_feed ON gaps(feed,a); CREATE INDEX IF NOT EXISTS coverage_feed ON coverage(feed,start_ts,end_ts)');
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

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { config } from "./config.mjs";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS boxes (
  id           TEXT PRIMARY KEY,          -- box-xxxxxx
  container    TEXT NOT NULL,             -- docker container name
  ip           TEXT,                      -- address on agentnet
  slot_dir     TEXT NOT NULL,             -- host dir mounted at /workspace
  status       TEXT NOT NULL,             -- warming | idle (fresh) | busy | parked (session awaiting follow-up) | draining
  session_id   TEXT,
  created_at   TEXT NOT NULL,
  claimed_at   TEXT,
  parked_at    TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,     -- s-xxxxxxxx
  status            TEXT NOT NULL,        -- queued | starting | running | pushing | idle | sleeping | failed | cancelled
  prompt            TEXT NOT NULL,
  repo              TEXT NOT NULL,        -- owner/name
  base_branch       TEXT,
  branch            TEXT,
  requested_by      TEXT,
  source            TEXT,                 -- cli | api | slack
  box_id            TEXT,
  av_session_id     TEXT,                 -- Agent Vault session (credential grant)
  claude_session_id TEXT,                 -- Claude Code's own session id
  cost_usd          REAL,
  num_turns         INTEGER,
  pr_url            TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT
);
CREATE TABLE IF NOT EXISTS session_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- status | agent | log | error | result | pr
  data       TEXT NOT NULL                -- JSON
);
CREATE INDEX IF NOT EXISTS session_events_by_session ON session_events(session_id, seq);
CREATE TABLE IF NOT EXISTS session_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  author     TEXT,
  status     TEXT NOT NULL,               -- pending | running | done | failed
  created_at TEXT NOT NULL
);
`);
// Columns added after the first version of the schema.
for (const ddl of ["ALTER TABLE boxes ADD COLUMN parked_at TEXT"]) {
  try { db.exec(ddl); } catch {}
}

export const now = () => new Date().toISOString();
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

const insertEvent = db.prepare("INSERT INTO session_events (session_id, ts, kind, data) VALUES (?, ?, ?, ?)");

export function addEvent(sessionId, kind, data) {
  const ts = now();
  const { lastInsertRowid } = insertEvent.run(sessionId, ts, kind, JSON.stringify(data));
  const ev = { seq: Number(lastInsertRowid), session_id: sessionId, ts, kind, data };
  bus.emit(`session:${sessionId}`, ev);
  return ev;
}

export function updateSession(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    id,
  );
  if (fields.status) addEvent(id, "status", { status: fields.status, ...(fields.error ? { error: fields.error } : {}) });
}

export const pendingMessages = (id) =>
  db.prepare("SELECT * FROM session_messages WHERE session_id = ? AND status = 'pending' ORDER BY id").all(id);
export const TERMINAL = ["idle", "sleeping", "failed", "cancelled"];
// A session is "settled" when it has nothing running and nothing waiting to run.
export const settled = (id) => TERMINAL.includes(getSession(id)?.status) && pendingMessages(id).length === 0;

export const getSession = (id) => db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
export const listSessions = (limit = 50) =>
  db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?").all(limit);
export const eventsSince = (id, after = 0) =>
  db
    .prepare("SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq")
    .all(id, after)
    .map((e) => ({ ...e, data: JSON.parse(e.data) }));

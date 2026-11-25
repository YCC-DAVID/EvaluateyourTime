// 本地 SQLite 存储（Node 内置 node:sqlite，无需原生编译）。
// 所有可同步对象都带稳定 ID、创建/修改时间、版本、来源设备和逻辑删除标记，为以后接入同步预留。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BUILTIN_CATEGORIES, RULES_V1 } from "../../../modules/scoring/index.ts";

const DATA_DIR = process.env.DATA_DIR ?? path.resolve("data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

// 设备 ID：每台设备一个，写进本地文件
const deviceFile = path.join(DATA_DIR, "device.json");
export const DEVICE_ID: string = existsSync(deviceFile)
  ? JSON.parse(readFileSync(deviceFile, "utf8")).device_id
  : (() => {
      const id = `dev_${randomUUID().slice(0, 8)}`;
      writeFileSync(deviceFile, JSON.stringify({ device_id: id }));
      return id;
    })();

export function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}
export const nowIso = () => new Date().toISOString();

const SYNC_COLS = `
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  device_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0`;

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, color TEXT NOT NULL,
  parent_id TEXT, builtin INTEGER NOT NULL DEFAULT 0, ${SYNC_COLS});

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, level TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT,
  start_date TEXT, ddl TEXT, progress INTEGER NOT NULL DEFAULT 0, progress_note TEXT,
  priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'active', is_primary INTEGER NOT NULL DEFAULT 0,
  ${SYNC_COLS});

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, tz TEXT NOT NULL,
  raw_text TEXT NOT NULL DEFAULT '', title TEXT, intent TEXT, goal_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft', analysis_error TEXT, ${SYNC_COLS});
CREATE INDEX IF NOT EXISTS idx_entries_time ON entries(start_utc, end_utc);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, category_id TEXT NOT NULL, minutes INTEGER NOT NULL,
  state TEXT NOT NULL, note TEXT, ${SYNC_COLS});
CREATE INDEX IF NOT EXISTS idx_alloc_entry ON allocations(entry_id);

CREATE TABLE IF NOT EXISTS review_questions (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, ord INTEGER NOT NULL, question TEXT NOT NULL,
  options_json TEXT NOT NULL, answer TEXT, source TEXT NOT NULL, entry_version INTEGER NOT NULL, ${SYNC_COLS});

CREATE TABLE IF NOT EXISTS score_revisions (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL,
  execution_quality INTEGER NOT NULL, goal_contribution INTEGER NOT NULL, arrangement_quality INTEGER NOT NULL,
  overall INTEGER NOT NULL, dominant_kind TEXT NOT NULL, reason TEXT, uncertainties_json TEXT, suggestion TEXT,
  source TEXT NOT NULL,            -- ai | user | manual
  ai_raw_json TEXT, change_kind TEXT, change_note TEXT,
  rule_version TEXT NOT NULL, model TEXT, entry_version INTEGER NOT NULL, ${SYNC_COLS});
CREATE INDEX IF NOT EXISTS idx_score_entry ON score_revisions(entry_id);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY, entry_id TEXT, kind TEXT NOT NULL, input_version INTEGER, status TEXT NOT NULL,
  model TEXT, error TEXT, result_json TEXT, created_at TEXT NOT NULL, finished_at TEXT);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS rulesets (
  id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL, effective_from TEXT NOT NULL, note TEXT);
`);

// 种子数据：内置分类、规则 v1
{
  const ins = db.prepare(
    `INSERT OR IGNORE INTO categories (id,name,kind,color,builtin,created_at,updated_at,device_id) VALUES (?,?,?,?,1,?,?,?)`,
  );
  const t = nowIso();
  for (const c of BUILTIN_CATEGORIES) ins.run(c.id, c.name, c.kind, c.color, t, t, DEVICE_ID);
  db.prepare(`INSERT OR IGNORE INTO rulesets (id,version,config_json,effective_from,note) VALUES (?,?,?,?,?)`).run(
    "rules_v1", RULES_V1.version, JSON.stringify(RULES_V1), t, "初始默认规则",
  );
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
    key,
    JSON.stringify(value),
  );
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

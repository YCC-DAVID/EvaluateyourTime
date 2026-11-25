// 本地 SQLite 存储（Node 内置 node:sqlite，无需原生编译）。
// 所有可同步对象都带稳定 ID、创建/修改时间、版本、来源设备和逻辑删除标记，为以后接入同步预留。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { BUILTIN_CATEGORIES, RULES_V1 } from "../../../modules/scoring/index.ts";

// 装了开机自启后，数据统一放在“应用支持”目录（后台登录项读写不了桌面文件夹）；
// 终端里 npm run dev 也自动用这一份，避免出现两份数据
export const SHARED_DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "time-evaluate-agent", "data");
export const DATA_DIR = process.env.DATA_DIR ?? (existsSync(path.join(SHARED_DATA_DIR, "app.db")) ? SHARED_DATA_DIR : path.resolve("data"));
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

// ---------- 迁移：给已有数据库补字段和表 ----------
function addColumn(table: string, column: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
// AI 给出的目标进度建议（评分时一起给）
addColumn("score_revisions", "goal_progress", "INTEGER");
addColumn("score_revisions", "goal_progress_reason", "TEXT");
// 用户对这段的自我反馈、希望以后改进的地方
addColumn("entries", "reflection", "TEXT");
addColumn("entries", "improvement", "TEXT");
// 子目标占父目标的比例（%），以及汇总进度时还没凑满 1% 的零头
addColumn("goals", "weight", "INTEGER");
addColumn("goals", "rollup_carry", "REAL NOT NULL DEFAULT 0");

// 对话：每条消息，以及 AI 提出的操作（待用户应用）
db.exec(`
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, actions_json TEXT,
  model TEXT, created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
`);
addColumn("chat_messages", "quick_json", "TEXT");
// 多个对话：每条消息属于一个对话；早期没有对话的消息归到“之前的对话”
db.exec(`
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
`);
addColumn("chat_messages", "thread_id", "TEXT");
// 手机离线时先存着、之后补发的消息：client_id 防重复，written_at 是写下的时间，reply_to 指向回复的那条用户消息
addColumn("chat_messages", "client_id", "TEXT");
addColumn("chat_messages", "written_at", "TEXT");
addColumn("chat_messages", "reply_to", "TEXT");
{
  const orphan = db.prepare(`SELECT MIN(created_at) a, MAX(created_at) b FROM chat_messages WHERE thread_id IS NULL AND deleted=0`).get() as { a: string | null; b: string | null };
  if (orphan.a) {
    const id = `thr_legacy_${Date.now().toString(36)}`;
    db.prepare(`INSERT INTO chat_threads (id,title,created_at,updated_at) VALUES (?,?,?,?)`).run(id, null, orphan.a, orphan.b);
    db.prepare(`UPDATE chat_messages SET thread_id=? WHERE thread_id IS NULL AND deleted=0`).run(id);
  }
}
// 引导问题的附加信息：例如按电脑记录起草时，“这块时间多少分钟、每个选项对应哪个分类”
addColumn("review_questions", "meta_json", "TEXT");

db.exec(`
CREATE TABLE IF NOT EXISTS goal_progress_events (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, entry_id TEXT,
  from_progress INTEGER NOT NULL, to_progress INTEGER NOT NULL,
  source TEXT NOT NULL,            -- ai（确认 AI 建议）| user（确认时改过 AI 建议）| manual（目标页手动改）
  reason TEXT, ${SYNC_COLS});
CREATE INDEX IF NOT EXISTS idx_gpe_goal ON goal_progress_events(goal_id, created_at);
`);
// 早期版本允许不写原因修改进度；这些没有说明的记录不再显示（逻辑删除，可恢复）
db.exec(`UPDATE goal_progress_events SET deleted=1, updated_at='${new Date().toISOString()}' WHERE deleted=0 AND (reason IS NULL OR trim(reason)='')`);

// 种子数据：内置分类、规则 v1
{
  const ins = db.prepare(
    `INSERT OR IGNORE INTO categories (id,name,kind,color,builtin,created_at,updated_at,device_id) VALUES (?,?,?,?,1,?,?,?)`,
  );
  const t = nowIso();
  for (const c of BUILTIN_CATEGORIES) ins.run(c.id, c.name, c.kind, c.color, t, t, DEVICE_ID);
  // 调色：休息和工作原来太接近（紫 vs 蓝），生活、运动也换成更好区分的颜色；只改还是旧默认色的内置分类
  for (const [id, from, to] of [
    ["cat_rest", "#8e7cc3", "#8e44ad"],
    ["cat_life", "#5aa9c9", "#4cc3d9"],
    ["cat_sport", "#22a06b", "#2b7a3d"],
  ])
    db.prepare(`UPDATE categories SET color=?,updated_at=? WHERE id=? AND color=?`).run(to, t, id, from);
  // 热力图里蓝色表示休息：休息改用蓝色，工作改用紫色（只改还是默认色的）
  if ((db.prepare(`SELECT color FROM categories WHERE id='cat_rest'`).get() as { color: string } | undefined)?.color === "#8e44ad") {
    db.prepare(`UPDATE categories SET color='#4f7cff',updated_at=? WHERE id='cat_rest'`).run(t);
    db.prepare(`UPDATE categories SET color='#8e44ad',updated_at=? WHERE id='cat_work' AND color='#4f7cff'`).run(t);
  }
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

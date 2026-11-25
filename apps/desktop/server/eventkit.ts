// 日历与提醒事项（通过“时间记录助手”这个小应用读写 EventKit）。
//  - 日历：读取选中的日历，缓存“3 天前 ~ 14 天后”的日程（重复日程会展开），每 10 分钟刷新。
//    日程按规则（标题 → 目标）或目标关键词自动关联到目标。
//  - 提醒事项：选中的列表和目标双向同步。列表可以指定一个父目标，列表里的待办成为它下面的“任务”；
//    标题、截止日、完成状态两边互相同步；在应用里给这个父目标新建任务也会写回提醒事项。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, getSetting, newId, nowIso, setSetting } from "./db.ts";

const exec = promisify(execFile);
const HELPER = path.join(os.homedir(), "Library", "Application Support", "time-evaluate-agent", "TimeAgentHelper.app");

db.exec(`
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, title TEXT NOT NULL,
  start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cal_time ON calendar_events(start_utc, end_utc);
CREATE TABLE IF NOT EXISTS reminder_links (
  goal_id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL UNIQUE, list_id TEXT NOT NULL,
  snap_json TEXT NOT NULL, synced_at TEXT NOT NULL);
`);

export const helperInstalled = () => process.platform === "darwin" && fs.existsSync(path.join(HELPER, "Contents", "MacOS", "TimeAgentHelper"));

/** 启动助手执行一个命令，返回它写出的 JSON */
export async function helper<T = any>(cmd: string, input: unknown = {}): Promise<T> {
  if (!helperInstalled()) throw new Error("还没装“时间记录助手”：运行 npm run helper:build");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "time-agent-ek-"));
  const inFile = path.join(dir, "in.json");
  const outFile = path.join(dir, "out.json");
  try {
    fs.writeFileSync(inFile, JSON.stringify(input));
    // -W 等它结束，-g 不抢前台，-n 每次新开一个实例
    await exec("open", ["-W", "-g", "-n", "-a", HELPER, "--args", cmd, inFile, outFile], { timeout: 150_000 });
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
    if (out.error) throw new Error(out.error);
    return out as T;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 设置 ----------

export interface EKSettings {
  calendarIds: string[];
  /** 标题包含某个词 → 关联到某个目标（例如“组会” → 某个研究目标） */
  eventRules: { match: string; goalId: string }[];
  /** 同步的提醒事项列表；goalId 是父目标（可空：任务不挂在父目标下） */
  reminderLists: { listId: string; title: string; goalId: string | null }[];
}

export function ekSettings(): EKSettings {
  return {
    calendarIds: getSetting<string[]>("ek_calendar_ids", []),
    eventRules: getSetting<EKSettings["eventRules"]>("ek_event_rules", []),
    reminderLists: getSetting<EKSettings["reminderLists"]>("ek_reminder_lists", []),
  };
}

export function saveEKSettings(b: Partial<EKSettings>) {
  if (Array.isArray(b.calendarIds)) setSetting("ek_calendar_ids", b.calendarIds.map(String).slice(0, 50));
  if (Array.isArray(b.eventRules))
    setSetting(
      "ek_event_rules",
      b.eventRules.filter((r) => r && String(r.match).trim() && r.goalId).map((r) => ({ match: String(r.match).trim().slice(0, 60), goalId: String(r.goalId) })),
    );
  if (Array.isArray(b.reminderLists))
    setSetting(
      "ek_reminder_lists",
      b.reminderLists.filter((l) => l && l.listId).map((l) => ({ listId: String(l.listId), title: String(l.title ?? "").slice(0, 80), goalId: l.goalId ? String(l.goalId) : null })),
    );
}

// ---------- 日历 ----------

let calSync: { at: string | null; error: string | null; running: boolean } = { at: null, error: null, running: false };

export async function syncCalendar() {
  const ids = ekSettings().calendarIds;
  if (!ids.length || calSync.running) return;
  calSync.running = true;
  try {
    const start = new Date(Date.now() - 3 * 86400_000);
    const end = new Date(Date.now() + 14 * 86400_000);
    const r = await helper<{ events: { id: string; calendarId: string; title: string; start: string; end: string; allDay: boolean }[] }>("events", {
      start: start.toISOString(),
      end: end.toISOString(),
      calendarIds: ids,
    });
    const t = nowIso();
    db.exec("BEGIN");
    try {
      db.prepare(`DELETE FROM calendar_events WHERE end_utc > ? AND start_utc < ?`).run(start.toISOString(), end.toISOString());
      const ins = db.prepare(`INSERT OR REPLACE INTO calendar_events (id,calendar_id,title,start_utc,end_utc,all_day,fetched_at) VALUES (?,?,?,?,?,?,?)`);
      for (const e of r.events) ins.run(e.id, e.calendarId, e.title, new Date(e.start).toISOString(), new Date(e.end).toISOString(), e.allDay ? 1 : 0, t);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    calSync = { at: t, error: null, running: false };
  } catch (e) {
    calSync = { at: calSync.at, error: (e as Error).message, running: false };
  }
}

/** 日程 → 目标：先看规则（标题包含关键词），再看目标标题是否出现在日程标题里 */
function goalFor(title: string, goals: { id: string; title: string }[], rules: EKSettings["eventRules"]): string | null {
  const t = title.toLowerCase();
  for (const r of rules) if (t.includes(r.match.toLowerCase()) && goals.some((g) => g.id === r.goalId)) return r.goalId;
  const g = goals.filter((g) => g.title.length >= 2 && t.includes(g.title.toLowerCase())).sort((a, b) => b.title.length - a.title.length)[0];
  return g?.id ?? null;
}

export function calendarEvents(from: string, to: string) {
  const goals = db.prepare(`SELECT id,title FROM goals WHERE deleted=0 AND status IN ('active','paused')`).all() as { id: string; title: string }[];
  const rules = ekSettings().eventRules;
  return (
    db
      .prepare(`SELECT id,calendar_id,title,start_utc,end_utc,all_day FROM calendar_events WHERE start_utc < ? AND end_utc > ? ORDER BY start_utc`)
      .all(to, from) as { id: string; calendar_id: string; title: string; start_utc: string; end_utc: string; all_day: number }[]
  ).map((e) => ({ ...e, all_day: !!e.all_day, goal_id: goalFor(e.title, goals, rules) }));
}

// ---------- 提醒事项 ⇄ 目标 ----------

interface Rem {
  id: string;
  listId: string;
  title: string;
  completed: boolean;
  due: string | null;
  modified: string | null;
}
interface Snap {
  title: string;
  due: string | null;
  completed: boolean;
}

let remSync: { at: string | null; error: string | null; running: boolean; log: string[] } = { at: null, error: null, running: false, log: [] };

export type GoalWriter = (id: string | null, b: Record<string, unknown>) => { id: string } | undefined;

/**
 * 双向同步。冲突处理：只有一边改了就以那一边为准；两边都改了，以修改时间更晚的为准。
 * 提醒事项里删掉的 → 目标标为“放弃”；应用里删掉的目标 → 只解除关联，不删提醒事项。
 */
export async function syncReminders(writeGoal: GoalWriter) {
  const lists = ekSettings().reminderLists;
  if (!lists.length || remSync.running) return;
  remSync.running = true;
  const log: string[] = [];
  try {
    const links = db.prepare(`SELECT * FROM reminder_links`).all() as { goal_id: string; reminder_id: string; list_id: string; snap_json: string; synced_at: string }[];
    const r = await helper<{ reminders: Rem[]; missing: string[] }>("reminders", {
      listIds: lists.map((l) => l.listId),
      since: new Date(Date.now() - 30 * 86400_000).toISOString(),
      knownIds: links.map((l) => l.reminder_id),
    });
    const byRem = new Map(r.reminders.map((x) => [x.id, x]));
    const goalById = (id: string) =>
      db.prepare(`SELECT id,title,ddl,status,progress,updated_at,deleted,parent_id FROM goals WHERE id=?`).get(id) as
        | { id: string; title: string; ddl: string | null; status: string; progress: number; updated_at: string; deleted: number; parent_id: string | null }
        | undefined;
    const ops: Record<string, unknown>[] = [];
    const opGoal: string[] = [];
    const t = nowIso();
    const saveLink = (goalId: string, rem: { id: string; listId: string }, snap: Snap) =>
      db
        .prepare(`INSERT OR REPLACE INTO reminder_links (goal_id,reminder_id,list_id,snap_json,synced_at) VALUES (?,?,?,?,?)`)
        .run(goalId, rem.id, rem.listId, JSON.stringify(snap), t);

    // 1. 已关联的
    for (const link of links) {
      const g = goalById(link.goal_id);
      if (!g || g.deleted) {
        db.prepare(`DELETE FROM reminder_links WHERE goal_id=?`).run(link.goal_id);
        continue;
      }
      if (r.missing.includes(link.reminder_id)) {
        writeGoal(g.id, { status: "dropped", is_primary: false });
        db.prepare(`DELETE FROM reminder_links WHERE goal_id=?`).run(g.id);
        log.push(`提醒事项里已删除：${g.title}（目标标为放弃）`);
        continue;
      }
      const rem = byRem.get(link.reminder_id);
      if (!rem) continue; // 很早以前完成的，不在这次取回的范围内
      const snap: Snap = JSON.parse(link.snap_json);
      const goalNow: Snap = { title: g.title, due: g.ddl, completed: g.status === "done" };
      const remNow: Snap = { title: rem.title, due: rem.due, completed: rem.completed };
      const same = (a: Snap, b: Snap) => a.title === b.title && (a.due ?? null) === (b.due ?? null) && a.completed === b.completed;
      const remChanged = !same(remNow, snap);
      const goalChanged = !same(goalNow, snap);
      if (!remChanged && !goalChanged) continue;
      const remWins = remChanged && (!goalChanged || (rem.modified ?? "") > g.updated_at);
      if (remWins) {
        const patch: Record<string, unknown> = { title: rem.title, ddl: rem.due };
        if (rem.completed !== goalNow.completed) {
          patch.status = rem.completed ? "done" : "active";
          if (rem.completed) Object.assign(patch, { progress: 100, progress_reason: "在提醒事项里标记完成", is_primary: false });
        }
        writeGoal(g.id, patch);
        saveLink(g.id, rem, remNow);
        log.push(`提醒事项 → 目标：${rem.title}`);
      } else {
        ops.push({ op: "update", id: rem.id, title: g.title, due: g.ddl, completed: g.status === "done" });
        opGoal.push(g.id);
        log.push(`目标 → 提醒事项：${g.title}`);
      }
    }

    // 2. 提醒事项里新的待办 → 目标（只导入没完成的）
    const linkedRem = new Set(links.map((l) => l.reminder_id));
    for (const rem of r.reminders) {
      if (linkedRem.has(rem.id) || rem.completed) continue;
      const list = lists.find((l) => l.listId === rem.listId);
      const g = writeGoal(null, { level: list?.goalId ? "task" : "short", parent_id: list?.goalId ?? null, title: rem.title, ddl: rem.due, weight: 0, progress: 0 });
      if (g) {
        saveLink(g.id, rem, { title: rem.title, due: rem.due, completed: false });
        log.push(`新待办 → 目标：${rem.title}`);
      }
    }

    // 3. 应用里挂在同步列表父目标下、还没关联的任务 → 写进提醒事项
    const linkedGoals = new Set((db.prepare(`SELECT goal_id FROM reminder_links`).all() as { goal_id: string }[]).map((x) => x.goal_id));
    for (const list of lists) {
      if (!list.goalId) continue;
      const kids = db
        .prepare(`SELECT id,title,ddl,status FROM goals WHERE deleted=0 AND parent_id=? AND status IN ('active','paused')`)
        .all(list.goalId) as { id: string; title: string; ddl: string | null; status: string }[];
      for (const k of kids) {
        if (linkedGoals.has(k.id)) continue;
        ops.push({ op: "create", listId: list.listId, title: k.title, due: k.ddl, completed: false });
        opGoal.push(k.id);
        log.push(`新任务 → 提醒事项：${k.title}`);
      }
    }

    if (ops.length) {
      const res = await helper<{ results: (Rem & { error?: string })[] }>("apply-reminders", { ops });
      res.results.forEach((x, i) => {
        if (x.error) return log.push(`写入提醒事项失败：${x.error}`);
        saveLink(opGoal[i], x, { title: x.title, due: x.due, completed: x.completed });
      });
    }
    remSync = { at: t, error: null, running: false, log: [...log, ...remSync.log].slice(0, 30) };
  } catch (e) {
    remSync = { ...remSync, error: (e as Error).message, running: false };
  }
}

export function syncStatus() {
  return { calendar: calSync, reminders: remSync, helperInstalled: helperInstalled() };
}

/** 后台定时：日历每 10 分钟、提醒事项每 3 分钟 */
export function startEKSync(writeGoal: GoalWriter) {
  if (process.platform !== "darwin") return;
  const run = () => {
    if (!helperInstalled()) return;
    syncCalendar();
    syncReminders(writeGoal);
  };
  setTimeout(run, 5000);
  setInterval(() => helperInstalled() && syncCalendar(), 10 * 60_000);
  setInterval(() => helperInstalled() && syncReminders(writeGoal), 3 * 60_000);
}

export const linkedGoalIds = () => new Set((db.prepare(`SELECT goal_id FROM reminder_links`).all() as { goal_id: string }[]).map((x) => x.goal_id));
export { newId };

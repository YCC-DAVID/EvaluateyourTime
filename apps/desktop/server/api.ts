import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, DEVICE_ID, newId, nowIso, getSetting, setSetting, tx } from "./db.ts";
import {
  RULES_V1,
  checkAllocations,
  backfillWindowStart,
  checkRecordWindow,
  clampScore,
  computeOverall,
  dominantKind,
  durationMinutes,
  sanitizeAllocations,
  type Allocation,
  type Category,
  type ScoreDims,
} from "../../../modules/scoring/index.ts";
import { allocateEntry, analyzeEntry, chatTurn, draftFromDevice, guideEntry, scoreEntry, splitGoal, type EntryContext } from "../../../modules/ai/tasks.ts";
import type { ChatAction } from "../../../modules/ai/schemas.ts";
import { appLine, deviceSettings, deviceStatus, deviceSummary, summaryForAI } from "./device.ts";
import { setSetting as saveSetting } from "./db.ts";
import { DEFAULT_PROFILE, PROFILE_PRESETS, profileLine, type Profile } from "../../../modules/profile.ts";
import { AIError, loadAIConfig } from "../../../modules/ai/client.ts";

export const api = express.Router();
api.use(express.json({ limit: "2mb" }));

type Row = Record<string, any>;
const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

// ---------- 读取 ----------

function categories(): Category[] {
  return all(`SELECT id,name,kind,color,parent_id,builtin FROM categories WHERE deleted=0 ORDER BY rowid`) as Category[];
}
function goals() {
  // 已投入：关联到该目标、已确认记录中确认过的脑力工作分钟数（自动统计）
  const invested = new Map(
    all(
      `SELECT x.goal_id AS id, SUM(a.minutes) AS m FROM entries x
       JOIN allocations a ON a.entry_id=x.id AND a.deleted=0 AND a.state='confirmed'
       JOIN categories c ON c.id=a.category_id AND c.kind='work'
       WHERE x.deleted=0 AND x.status='confirmed' AND x.goal_id IS NOT NULL GROUP BY x.goal_id`,
    ).map((r) => [r.id as string, r.m as number]),
  );
  const events = all(
    `SELECT goal_id,entry_id,from_progress,to_progress,source,reason,created_at FROM goal_progress_events WHERE deleted=0 ORDER BY created_at DESC`,
  );
  return all(`SELECT * FROM goals WHERE deleted=0 ORDER BY is_primary DESC, status='active' DESC, priority ASC, ddl IS NULL, ddl`).map(
    (g): Row => ({
      ...g,
      is_primary: !!g.is_primary,
      invested_minutes: invested.get(g.id) ?? 0,
      progress_events: events.filter((ev) => ev.goal_id === g.id).slice(0, 5),
    }),
  );
}

type ProgressSource = "ai" | "user" | "manual" | "rollup";

function insertProgressEvent(goalId: string, from: number, to: number, source: ProgressSource, reason: string, entryId: string | null) {
  const t = nowIso();
  run(
    `INSERT INTO goal_progress_events (id,goal_id,entry_id,from_progress,to_progress,source,reason,created_at,updated_at,device_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId("gpe"), goalId, entryId, from, to, source, reason, t, t, DEVICE_ID,
  );
}

/** 修改目标进度并记一条历史；值没变就什么都不做。变化会按比例带动父目标。 */
function setGoalProgress(goalId: string, value: number, source: ProgressSource, reason: string | null, entryId: string | null) {
  const g = one(`SELECT progress FROM goals WHERE id=? AND deleted=0`, goalId);
  if (!g || g.progress === value) return;
  const t = nowIso();
  run(`UPDATE goals SET progress=?,updated_at=?,version=version+1,device_id=? WHERE id=?`, value, t, DEVICE_ID, goalId);
  // 没写明推进了什么的变化不进入进度记录
  if (reason?.trim()) insertProgressEvent(goalId, g.progress, value, source, reason, entryId);
  rollUp(goalId, value - g.progress, entryId, 0);
}

/**
 * 子目标进度变化 Δ → 父目标增加 Δ × 占比。进度按整数存，不足 1% 的零头记在 rollup_carry 里累计，
 * 凑满再加，避免小步推进被四舍五入吃掉。逐级向上，最多 6 层。
 */
function rollUp(childId: string, exactDelta: number, entryId: string | null, depth: number) {
  if (depth > 5 || exactDelta === 0) return;
  const child = one(`SELECT title,parent_id,weight FROM goals WHERE id=? AND deleted=0`, childId);
  if (!child?.parent_id || !child.weight) return;
  const parent = one(`SELECT id,progress,rollup_carry FROM goals WHERE id=? AND deleted=0`, child.parent_id);
  if (!parent) return;
  const exact = (exactDelta * child.weight) / 100;
  const carry = Number(parent.rollup_carry ?? 0) + exact;
  const step = Math.trunc(carry);
  const next = Math.max(0, Math.min(100, parent.progress + step));
  // 碰到 0 或 100 的边界时零头清零
  const newCarry = next === parent.progress + step ? carry - step : 0;
  run(`UPDATE goals SET progress=?,rollup_carry=?,updated_at=?,version=version+1,device_id=? WHERE id=?`, next, newCarry, nowIso(), DEVICE_ID, parent.id);
  if (next !== parent.progress) {
    const sign = exactDelta > 0 ? "推进" : "回退";
    insertProgressEvent(parent.id, parent.progress, next, "rollup", `子目标「${child.title}」${sign} ${Math.abs(Math.round(exactDelta * 10) / 10)}%（占 ${child.weight}%）`, entryId);
  }
  rollUp(parent.id, exact, entryId, depth + 1);
}
function profile(): Profile {
  return getSetting<Profile>("profile", DEFAULT_PROFILE);
}

function workBudget(): number {
  return getSetting("work_budget_minutes", RULES_V1.default_work_budget_minutes);
}

function loadEntry(id: string) {
  const e = one(`SELECT * FROM entries WHERE id=? AND deleted=0`, id);
  if (!e) throw new HttpError(404, "记录不存在");
  return e;
}

function hydrate(e: Row) {
  const allocations = all(
    `SELECT id,category_id,minutes,state,note FROM allocations WHERE entry_id=? AND deleted=0 ORDER BY minutes DESC`,
    e.id,
  );
  const questions = all(
    `SELECT id,ord,question,options_json,answer,source,meta_json FROM review_questions WHERE entry_id=? AND deleted=0 ORDER BY ord`,
    e.id,
  ).map((q) => ({ ...q, options: JSON.parse(q.options_json), options_json: undefined, meta: q.meta_json ? JSON.parse(q.meta_json) : null, meta_json: undefined }));
  const scores = all(`SELECT * FROM score_revisions WHERE entry_id=? AND deleted=0 ORDER BY created_at`, e.id).map((s): Row => ({
    ...s,
    uncertainties: s.uncertainties_json ? JSON.parse(s.uncertainties_json) : [],
    uncertainties_json: undefined,
    ai_raw_json: undefined,
  }));
  const aiScore = [...scores].reverse().find((s) => s.source === "ai") ?? null;
  const latest = scores.at(-1) ?? null;
  return { ...e, allocations, questions, ai_score: aiScore, score: latest, score_history: scores };
}

api.get("/meta", (_req, res) => {
  const cfg = loadAIConfig();
  res.json({
    device_id: DEVICE_ID,
    categories: categories(),
    goals: goals(),
    work_budget_minutes: workBudget(),
    profile: profile(),
    rules: RULES_V1,
    ai: { provider: cfg.provider, model: cfg.model, base_url: cfg.baseURL, key_configured: !!cfg.apiKey },
    asr: { server: !!process.env.ASR_BASE_URL },
  });
});

api.get("/entries", (req, res) => {
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!from || !to) throw new HttpError(400, "需要 from 和 to");
  const rows = all(`SELECT * FROM entries WHERE deleted=0 AND start_utc < ? AND end_utc > ? ORDER BY start_utc`, to, from);
  res.json(rows.map(hydrate));
});

api.get("/entries/last-end", (_req, res) => {
  const r = one(`SELECT MAX(end_utc) AS end FROM entries WHERE deleted=0 AND end_utc <= ?`, nowIso());
  res.json({ end: r?.end ?? null });
});

api.get("/entries/:id", (req, res) => res.json(hydrate(loadEntry(String(req.params.id)))));

// ---------- 记录增删改 ----------

/** 新建或修改时间时：不能是未来，补录只允许最近 3 天 */
function validateRange(start: string, end: string) {
  const err = checkRecordWindow(Date.parse(start), Date.parse(end), Date.now());
  if (err) throw new HttpError(400, err);
}

api.post("/entries", (req, res) => {
  const { start, end, tz, text, goal_id } = req.body ?? {};
  validateRange(start, end);
  // 用户在记录时直接选的目标；不存在或已删除就忽略
  const goalId = goal_id && one(`SELECT id FROM goals WHERE id=? AND deleted=0`, String(goal_id)) ? String(goal_id) : null;
  const id = newId("entry");
  const t = nowIso();
  run(
    `INSERT INTO entries (id,start_utc,end_utc,tz,raw_text,goal_id,status,created_at,updated_at,device_id) VALUES (?,?,?,?,?,?,'draft',?,?,?)`,
    id,
    new Date(start).toISOString(),
    new Date(end).toISOString(),
    tz || "UTC",
    String(text ?? ""),
    goalId,
    t,
    t,
    DEVICE_ID,
  );
  res.status(201).json(hydrate(loadEntry(id)));
});

api.patch("/entries/:id", (req, res) => {
  const e = loadEntry(String(req.params.id));
  const start = req.body.start ?? e.start_utc;
  const end = req.body.end ?? e.end_utc;
  // 只在时间被改动时检查窗口：超过 3 天的旧记录仍可修改文字和评分
  const timeChanged = Date.parse(start) !== Date.parse(e.start_utc) || Date.parse(end) !== Date.parse(e.end_utc);
  if (timeChanged) validateRange(start, end);
  const text = req.body.text ?? e.raw_text;
  const title = req.body.title ?? e.title;
  const goalId = req.body.goal_id !== undefined ? req.body.goal_id : e.goal_id;
  // 已确认的记录被修改后回到待确认，旧评分保留在历史里
  const status = e.status === "confirmed" ? "needs_confirmation" : e.status;
  run(
    `UPDATE entries SET start_utc=?,end_utc=?,raw_text=?,title=?,goal_id=?,status=?,updated_at=?,version=version+1,device_id=? WHERE id=?`,
    new Date(start).toISOString(),
    new Date(end).toISOString(),
    text,
    title,
    goalId,
    status,
    nowIso(),
    DEVICE_ID,
    e.id,
  );
  res.json(hydrate(loadEntry(e.id)));
});

api.delete("/entries/:id", (req, res) => {
  const e = loadEntry(String(req.params.id));
  const t = nowIso();
  tx(() => {
    run(`UPDATE entries SET deleted=1,updated_at=?,version=version+1,device_id=? WHERE id=?`, t, DEVICE_ID, e.id);
    for (const table of ["allocations", "review_questions", "score_revisions"])
      run(`UPDATE ${table} SET deleted=1,updated_at=?,version=version+1 WHERE entry_id=?`, t, e.id);
  });
  res.json({ ok: true });
});

// ---------- AI：整理与提问 ----------

function fmtLocalRange(startIso: string, endIso: string, tz: string) {
  const f = new Intl.DateTimeFormat("zh-CN", { timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${f.format(new Date(startIso))} – ${f.format(new Date(endIso))}`;
}

function localDayBounds(iso: string): [string, string] {
  const d = new Date(iso);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return [s.toISOString(), e.toISOString()];
}

function entryContext(e: Row): EntryContext {
  const [d0, d1] = localDayBounds(e.start_utc);
  const earlier = all(
    `SELECT start_utc,end_utc,title,raw_text FROM entries WHERE deleted=0 AND id<>? AND start_utc>=? AND start_utc<? ORDER BY start_utc LIMIT 8`,
    e.id,
    d0,
    e.start_utc,
  ).map((r) => ({ time: fmtLocalRange(r.start_utc, r.end_utc, e.tz), title: r.title || String(r.raw_text).slice(0, 30) }));
  const workSoFar = one(
    `SELECT COALESCE(SUM(a.minutes),0) AS m FROM allocations a JOIN entries x ON x.id=a.entry_id JOIN categories c ON c.id=a.category_id
     WHERE a.deleted=0 AND x.deleted=0 AND x.id<>? AND x.status='confirmed' AND a.state='confirmed' AND c.kind='work'
     AND x.start_utc>=? AND x.start_utc<?`,
    e.id,
    d0,
    d1,
  )!.m as number;
  return {
    localRange: fmtLocalRange(e.start_utc, e.end_utc, e.tz),
    durationMinutes: durationMinutes(e.start_utc, e.end_utc),
    text: e.raw_text,
    categories: categories(),
    goals: goals()
      .filter((g) => g.status === "active")
      .map((g) => ({ id: g.id, level: g.level, title: g.title, ddl: g.ddl, is_primary: g.is_primary, progress: g.progress })),
    earlier,
    workSoFarMinutes: workSoFar,
    workBudgetMinutes: workBudget(),
    profile: profileLine(profile()),
  };
}

function startJob(entryId: string, kind: string, version: number) {
  const id = newId("job");
  run(`INSERT INTO ai_jobs (id,entry_id,kind,input_version,status,created_at) VALUES (?,?,?,?,'running',?)`, id, entryId, kind, version, nowIso());
  return id;
}
function finishJob(id: string, status: string, fields: { model?: string; error?: string; result?: unknown }) {
  run(
    `UPDATE ai_jobs SET status=?,model=?,error=?,result_json=?,finished_at=? WHERE id=?`,
    status,
    fields.model ?? null,
    fields.error ?? null,
    fields.result ? JSON.stringify(fields.result) : null,
    nowIso(),
    id,
  );
}

api.post(
  "/entries/:id/analyze",
  wrap(async (req, res) => {
    const e = loadEntry(String(req.params.id));
    if (!String(e.raw_text).trim()) throw new HttpError(400, "先写下这段时间做了什么");
    const version = e.version as number;
    const jobId = startJob(e.id, "analyze_entry", version);
    run(`UPDATE entries SET status='pending_ai',analysis_error=NULL WHERE id=?`, e.id);
    const ctx = { ...entryContext(e), device: await deviceLineFor(e) };
    try {
      const { output, model } = await analyzeEntry(ctx);
      const cur = loadEntry(e.id);
      if (cur.version !== version) {
        // 用户在分析期间修改了记录：旧结果不得覆盖新输入
        finishJob(jobId, "stale", { model, result: output });
        if (cur.status === "pending_ai") run(`UPDATE entries SET status='draft' WHERE id=?`, e.id);
        res.status(409).json({ error: "记录在分析期间被修改，结果已丢弃，请重新分析", entry: hydrate(loadEntry(e.id)) });
        return;
      }
      const catIds = new Set(ctx.categories.map((c) => c.id));
      const goalIds = new Set(ctx.goals.map((g) => g.id));
      const allocs = sanitizeAllocations(output.allocations, ctx.durationMinutes, catIds);
      const questions = output.questions.filter((q) => q.question.trim()).slice(0, 3);
      const t = nowIso();
      tx(() => {
        run(`UPDATE allocations SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0`, t, e.id);
        run(`UPDATE review_questions SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0`, t, e.id);
        for (const a of allocs)
          run(
            `INSERT INTO allocations (id,entry_id,category_id,minutes,state,note,created_at,updated_at,device_id) VALUES (?,?,?,?,'estimated',?,?,?,?)`,
            newId("alloc"), e.id, a.category_id, a.minutes, a.note ?? null, t, t, DEVICE_ID,
          );
        questions.forEach((q, i) => {
          const opts = [...new Set(q.options.map((o) => o.trim()).filter(Boolean))].slice(0, 6);
          run(
            `INSERT INTO review_questions (id,entry_id,ord,question,options_json,source,entry_version,created_at,updated_at,device_id) VALUES (?,?,?,?,?,'ai',?,?,?,?)`,
            newId("q"), e.id, i, q.question, JSON.stringify(opts), version, t, t, DEVICE_ID,
          );
        });
        run(
          `UPDATE entries SET title=?,intent=?,goal_id=COALESCE(goal_id,?),status='needs_confirmation',updated_at=? WHERE id=?`,
          output.title.slice(0, 40),
          output.intent,
          output.goal_id && goalIds.has(output.goal_id) ? output.goal_id : null,
          t,
          e.id,
        );
      });
      finishJob(jobId, "done", { model, result: output });
      res.json({ entry: hydrate(loadEntry(e.id)), summary: output.summary, uncertainties: output.uncertainties });
    } catch (err) {
      const msg = err instanceof AIError ? err.message : `分析失败：${(err as Error).message}`;
      finishJob(jobId, "failed", { error: msg });
      run(`UPDATE entries SET status='analysis_failed',analysis_error=? WHERE id=?`, msg, e.id);
      res.status(502).json({ error: msg, retryable: err instanceof AIError ? err.retryable : true, entry: hydrate(loadEntry(e.id)) });
    }
  }),
);

// ---------- 质量引导：评分前的 0-3 个事实问题 ----------
// 先问事实再评分（规格 7.1）。还没有时间分配时，问题优先用来确定分配。
// 已有分配时，以下情况直接跳过、不调用 AI：
//   不到 30 分钟；全是休息/生活/娱乐/运动且不超过 60 分钟；已经回答过引导问题。
api.post(
  "/entries/:id/guide",
  wrap(async (req, res) => {
    const e = loadEntry(String(req.params.id));
    const h = hydrate(e);
    const total = durationMinutes(e.start_utc, e.end_utc);
    const cats = categories();
    const kindOf = (id: string) => cats.find((c) => c.id === id)?.kind ?? "unknown";
    const skip = (reason: string) => res.json({ skip: true, reason, questions: [] });
    const hasAlloc = h.allocations.length > 0;
    if (hasAlloc && total < 30) return skip("不到 30 分钟，直接评分");
    const kinds = new Set(h.allocations.map((a: Row) => kindOf(a.category_id)));
    const restLike = [...kinds].every((k) => ["rest", "life", "fun", "sport"].includes(k as string));
    if (kinds.size > 0 && restLike && total <= 60) return skip("休息/生活类活动，直接评分");
    if (hasAlloc && h.questions.some((q: Row) => q.source === "ai" && q.answer)) return skip("已经回答过引导问题");

    const ctx = { ...entryContext(e), device: await deviceLineFor(e) };
    try {
      const { output } = await guideEntry({
        localRange: ctx.localRange,
        durationMinutes: total,
        text: e.raw_text,
        allocations: h.allocations.map((a: Row) => ({
          name: cats.find((c) => c.id === a.category_id)?.name ?? a.category_id,
          kind: kindOf(a.category_id),
          minutes: a.minutes,
          note: a.note,
        })),
        goalTitle: ctx.goals.find((g) => g.id === e.goal_id)?.title ?? null,
        goals: ctx.goals,
        device: ctx.device,
        profile: ctx.profile,
      });
      const qs = output.need_questions ? output.questions.filter((q) => q.question.trim()).slice(0, 3) : [];
      if (!qs.length) return skip(output.reason || "信息已经足够，直接评分");
      const t = nowIso();
      tx(() => {
        // 之前没回答的引导问题作废，换成这一轮的
        run(`UPDATE review_questions SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0 AND source='ai' AND answer IS NULL`, t, e.id);
        qs.forEach((q, i) => {
          const opts = [...new Set(q.options.map((o) => o.trim()).filter(Boolean))].slice(0, 6);
          run(
            `INSERT INTO review_questions (id,entry_id,ord,question,options_json,source,entry_version,created_at,updated_at,device_id) VALUES (?,?,?,?,?,'ai',?,?,?,?)`,
            newId("q"), e.id, i, q.question, JSON.stringify(opts), e.version, t, t, DEVICE_ID,
          );
        });
      });
      res.json({ skip: false, reason: output.reason, questions: hydrate(loadEntry(e.id)).questions.filter((q: Row) => q.source === "ai" && !q.answer) });
    } catch (err) {
      // 生成问题失败不挡住流程：直接评分
      skip(`没能生成引导问题（${err instanceof AIError ? err.message : (err as Error).message}），直接评分`);
    }
  }),
);

// 按电脑记录起草：描述、标题、能确定的分配（估计）、说不准的时间块提问（选项直接对应分类）
api.post(
  "/entries/:id/device-draft",
  wrap(async (req, res) => {
    const e = loadEntry(String(req.params.id));
    const start = Date.parse(e.start_utc);
    const end = Date.parse(e.end_utc);
    const total = durationMinutes(e.start_utc, e.end_utc);
    const sm = await deviceSummary(start, end);
    if (sm.coveredMinutes === 0) throw new HttpError(400, "这段时间没有电脑使用数据，没法按电脑记录起草");
    const cats = categories();
    const catIds = new Set(cats.map((c) => c.id));
    const catName = (id: string) => cats.find((c) => c.id === id)?.name ?? id;
    const rules = deviceSettings().rules;
    const ruleLines = Object.entries(rules).map(([k, v]) => `- ${k.replace(/^app:/, "应用 ").replace(/^site:/, "网站 ")} → ${catName(v)}（${v}）`);
    const ctx = { ...entryContext(e) };
    const version = e.version as number;
    // 用户关闭了“把电脑数据发给 AI”：完全在本地起草，数据不出本机
    if (!deviceSettings().sendToAI) {
      const d = localDeviceDraft(sm, rules, total, cats);
      const t = nowIso();
      tx(() => {
        run(`UPDATE allocations SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0`, t, e.id);
        run(`UPDATE review_questions SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0 AND source='ai' AND answer IS NULL`, t, e.id);
        for (const a of d.allocations)
          run(
            `INSERT INTO allocations (id,entry_id,category_id,minutes,state,note,created_at,updated_at,device_id) VALUES (?,?,?,?,'estimated',?,?,?,?)`,
            newId("alloc"), e.id, a.category_id, a.minutes, a.note, t, t, DEVICE_ID,
          );
        d.questions.forEach((q, i) =>
          run(
            `INSERT INTO review_questions (id,entry_id,ord,question,options_json,source,entry_version,meta_json,created_at,updated_at,device_id) VALUES (?,?,?,?,?,'ai',?,?,?,?,?)`,
            newId("q"), e.id, i, q.question, JSON.stringify(q.options.map((o) => o.label)), version,
            JSON.stringify({ kind: "device", minutes: q.minutes, cats: q.options.map((o) => o.category_id) }), t, t, DEVICE_ID,
          ),
        );
        run(
          `UPDATE entries SET title=COALESCE(title,?),raw_text=CASE WHEN trim(raw_text)='' THEN ? ELSE raw_text END,status='needs_confirmation',updated_at=?,version=version+1 WHERE id=?`,
          d.title, d.text, t, e.id,
        );
      });
      return res.json(hydrate(loadEntry(e.id)));
    }
    try {
      const { output } = await draftFromDevice({
        profile: ctx.profile,
        localRange: ctx.localRange,
        durationMinutes: total,
        userText: String(e.raw_text ?? "").trim(),
        device: sm.apps.map((a) => `- ${appLine(a, 5)}`),
        afkMinutes: sm.afkMinutes,
        uncoveredMinutes: Math.max(0, total - sm.coveredMinutes),
        rules: ruleLines,
        categories: cats,
        goals: ctx.goals,
      });
      if (loadEntry(e.id).version !== version) throw new HttpError(409, "记录在起草期间被修改了，请重试");
      const allocs = sanitizeAllocations(output.allocations, total, catIds);
      let room = total - allocs.reduce((a, x) => a + x.minutes, 0);
      const qs = output.questions
        .filter((q) => q.question.trim() && q.options.length)
        .slice(0, 3)
        .map((q) => {
          const minutes = Math.max(0, Math.min(Math.round(q.minutes), room));
          room -= minutes;
          return { ...q, minutes, options: q.options.map((o) => ({ label: o.label.trim(), category_id: o.category_id && catIds.has(o.category_id) ? o.category_id : null })).filter((o) => o.label) };
        })
        .filter((q) => q.minutes > 0);
      const goalIds = new Set(ctx.goals.map((g) => g.id));
      const t = nowIso();
      tx(() => {
        run(`UPDATE allocations SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0`, t, e.id);
        run(`UPDATE review_questions SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0 AND source='ai' AND answer IS NULL`, t, e.id);
        for (const a of allocs)
          run(
            `INSERT INTO allocations (id,entry_id,category_id,minutes,state,note,created_at,updated_at,device_id) VALUES (?,?,?,?,'estimated',?,?,?,?)`,
            newId("alloc"), e.id, a.category_id, a.minutes, a.note ?? null, t, t, DEVICE_ID,
          );
        qs.forEach((q, i) =>
          run(
            `INSERT INTO review_questions (id,entry_id,ord,question,options_json,source,entry_version,meta_json,created_at,updated_at,device_id) VALUES (?,?,?,?,?,'ai',?,?,?,?,?)`,
            newId("q"), e.id, i, q.question, JSON.stringify(q.options.map((o) => o.label)), version,
            JSON.stringify({ kind: "device", minutes: q.minutes, cats: q.options.map((o) => o.category_id) }), t, t, DEVICE_ID,
          ),
        );
        run(
          `UPDATE entries SET title=?,raw_text=CASE WHEN trim(raw_text)='' THEN ? ELSE raw_text END,goal_id=COALESCE(goal_id,?),status='needs_confirmation',updated_at=?,version=version+1 WHERE id=?`,
          output.title.slice(0, 40), output.text, output.goal_id && goalIds.has(output.goal_id) ? output.goal_id : null, t, e.id,
        );
      });
      res.json(hydrate(loadEntry(e.id)));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      res.status(502).json({ error: err instanceof AIError ? err.message : `起草失败：${(err as Error).message}` });
    }
  }),
);

/**
 * 本地起草（不调用 AI）：有归类规则的应用/网站直接分配；其余每块（按分钟数取前 3）问一下归哪类；
 * 离开键鼠超过 10 分钟也问一下。描述只写应用和网站名。
 */
function localDeviceDraft(sm: Awaited<ReturnType<typeof deviceSummary>>, rules: Record<string, string>, total: number, cats: Category[]) {
  const name = (id: string) => cats.find((c) => c.id === id)?.name ?? id;
  const byCat = new Map<string, { minutes: number; notes: string[] }>();
  const unknown: { label: string; minutes: number }[] = [];
  const add = (cat: string, minutes: number, note: string) => {
    const x = byCat.get(cat) ?? { minutes: 0, notes: [] };
    x.minutes += minutes;
    x.notes.push(note);
    byCat.set(cat, x);
  };
  for (const a of sm.apps) {
    if (a.app.startsWith("（")) continue;
    let rest = a.minutes;
    for (const d of a.details) {
      const r = rules[`site:${d.label}`];
      if (r) {
        add(r, d.minutes, d.label);
        rest -= d.minutes;
      } else if (a.details.length > 0 && !rules[`app:${a.app}`]) {
        unknown.push({ label: d.label, minutes: d.minutes });
        rest -= d.minutes;
      }
    }
    if (rest <= 0) continue;
    const r = rules[`app:${a.app}`];
    if (r) add(r, rest, a.app);
    else unknown.push({ label: a.app, minutes: rest });
  }
  const allocations = [...byCat.entries()].map(([category_id, v]) => ({ category_id, minutes: v.minutes, note: v.notes.join("、") }));
  const opts = [
    { label: "工作/学习", category_id: "cat_work" },
    { label: "主动放松", category_id: "cat_fun" },
    { label: "分心", category_id: "cat_waste" },
    { label: "记不清", category_id: null as string | null },
  ];
  const questions = unknown
    .filter((u) => u.minutes >= 3)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 3)
    .map((u) => ({ question: `${u.label} ${u.minutes} 分钟算哪种？`, minutes: u.minutes, options: opts }));
  if (sm.afkMinutes >= 10 && questions.length < 3)
    questions.push({
      question: `离开电脑的 ${sm.afkMinutes} 分钟在做什么？`,
      minutes: sm.afkMinutes,
      options: [
        { label: "开会/讨论/想问题", category_id: "cat_work" },
        { label: "吃饭休息", category_id: "cat_rest" },
        { label: "处理杂事", category_id: "cat_life" },
        { label: "记不清", category_id: null },
      ],
    });
  const used = allocations.reduce((a, x) => a + x.minutes, 0);
  const top = sm.apps.filter((a) => !a.app.startsWith("（")).slice(0, 3).map((a) => (a.details[0] ? `${a.app}（${a.details[0].label}）` : a.app));
  return {
    title: (sm.apps.find((a) => !a.app.startsWith("（"))?.app ?? "电脑上的工作").slice(0, 20),
    text: `按电脑记录：主要在 ${top.join("、") || "电脑上"}`,
    allocations: used > total ? [] : allocations.map((a) => ({ ...a, note: a.note ? `${a.note}（${name(a.category_id)}）` : null })),
    questions,
  };
}

// 根据引导问题的回答估出时间分配（估计值，不保存；用户确认后通过 review 保存）
api.post(
  "/entries/:id/allocate",
  wrap(async (req, res) => {
    const e = loadEntry(String(req.params.id));
    const answers: { id: string; answer: string }[] = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const t = nowIso();
    for (const a of answers)
      run(`UPDATE review_questions SET answer=?,updated_at=?,version=version+1 WHERE id=? AND entry_id=?`, String(a.answer).slice(0, 500), t, a.id, e.id);
    const h = hydrate(loadEntry(e.id));
    const total = durationMinutes(e.start_utc, e.end_utc);
    const cats = categories();
    const ctx = { ...entryContext(e), device: await deviceLineFor(e) };
    try {
      const { output } = await allocateEntry({
        localRange: ctx.localRange,
        durationMinutes: total,
        text: e.raw_text,
        answers: h.questions.filter((q: Row) => q.source === "ai" && q.answer).map((q: Row) => ({ question: q.question, answer: q.answer })),
        categories: cats,
        device: ctx.device,
        profile: ctx.profile,
      });
      res.json({ allocations: sanitizeAllocations(output.allocations, total, new Set(cats.map((c) => c.id))), note: output.note });
    } catch (err) {
      res.status(502).json({ error: err instanceof AIError ? err.message : `估算分配失败：${(err as Error).message}` });
    }
  }),
);

// ---------- 用户确认事实（分配 + 回答） ----------

// 评分后的反馈：对“不确定”项的澄清、自我反馈、希望以后改进的地方
api.put("/entries/:id/feedback", (req, res) => {
  const e = loadEntry(String(req.params.id));
  const b = req.body ?? {};
  const clarifications: { uncertainty: string; answer: string }[] = Array.isArray(b.clarifications) ? b.clarifications : [];
  const t = nowIso();
  tx(() => {
    const existing = all(`SELECT id,question,ord FROM review_questions WHERE entry_id=? AND deleted=0 AND source='uncertainty'`, e.id);
    let ord = 100 + existing.length;
    for (const c of clarifications) {
      const q = String(c.uncertainty ?? "").trim().slice(0, 300);
      const ans = String(c.answer ?? "").trim().slice(0, 1000);
      if (!q) continue;
      const row = existing.find((r) => r.question === q);
      if (row) run(`UPDATE review_questions SET answer=?,updated_at=?,version=version+1 WHERE id=?`, ans || null, t, row.id);
      else if (ans)
        run(
          `INSERT INTO review_questions (id,entry_id,ord,question,options_json,answer,source,entry_version,created_at,updated_at,device_id) VALUES (?,?,?,?,'[]',?,'uncertainty',?,?,?,?)`,
          newId("q"), e.id, ord++, q, ans, e.version, t, t, DEVICE_ID,
        );
    }
    // 反馈是新的事实输入：版本号加一，正在进行的旧 AI 结果不会覆盖它
    run(
      `UPDATE entries SET reflection=?,improvement=?,updated_at=?,version=version+1,device_id=? WHERE id=?`,
      String(b.reflection ?? e.reflection ?? "").trim().slice(0, 2000) || null,
      String(b.improvement ?? e.improvement ?? "").trim().slice(0, 2000) || null,
      t, DEVICE_ID, e.id,
    );
  });
  res.json(hydrate(loadEntry(e.id)));
});

api.put("/entries/:id/review", (req, res) => {
  const e = loadEntry(String(req.params.id));
  const total = durationMinutes(e.start_utc, e.end_utc);
  const catIds = new Set(categories().map((c) => c.id));
  const allocs: Allocation[] = (req.body.allocations ?? [])
    .map((a: any) => ({ category_id: String(a.category_id), minutes: Math.round(Number(a.minutes)), state: "confirmed", note: a.note ?? null }))
    .filter((a: Allocation) => a.minutes > 0);
  const check = checkAllocations(allocs, total, catIds);
  if (!check.ok) throw new HttpError(400, check.errors.join("；"));
  const answers: { id: string; answer: string }[] = req.body.answers ?? [];
  const t = nowIso();
  tx(() => {
    run(`UPDATE allocations SET deleted=1,updated_at=? WHERE entry_id=? AND deleted=0`, t, e.id);
    for (const a of allocs)
      run(
        `INSERT INTO allocations (id,entry_id,category_id,minutes,state,note,created_at,updated_at,device_id) VALUES (?,?,?,?,'confirmed',?,?,?,?)`,
        newId("alloc"), e.id, a.category_id, a.minutes, a.note, t, t, DEVICE_ID,
      );
    for (const a of answers)
      run(`UPDATE review_questions SET answer=?,updated_at=?,version=version+1 WHERE id=? AND entry_id=?`, a.answer, t, a.id, e.id);
    run(
      `UPDATE entries SET goal_id=?,status=CASE WHEN status='confirmed' THEN 'needs_confirmation' ELSE status END,updated_at=?,version=version+1 WHERE id=?`,
      req.body.goal_id !== undefined ? req.body.goal_id : e.goal_id,
      t,
      e.id,
    );
  });
  res.json(hydrate(loadEntry(e.id)));
});

// ---------- AI：评分 ----------

api.post(
  "/entries/:id/score",
  wrap(async (req, res) => {
    const e = loadEntry(String(req.params.id));
    const h = hydrate(e);
    const cats = categories();
    const byId = new Map(cats.map((c) => [c.id, c]));
    const total = durationMinutes(e.start_utc, e.end_utc);
    const allocated = h.allocations.reduce((s: number, a: Row) => s + a.minutes, 0);
    const version = e.version as number;
    const jobId = startJob(e.id, "score_entry", version);
    const ctx = { ...entryContext(e), device: await deviceLineFor(e) };
    const goal = ctx.goals.find((g) => g.id === e.goal_id) ?? null;
    try {
      const { output, model } = await scoreEntry({
        ...ctx,
        title: e.title || "",
        intent: e.intent || "",
        allocations: h.allocations.map((a: Row) => ({
          name: byId.get(a.category_id)?.name ?? a.category_id,
          kind: byId.get(a.category_id)?.kind ?? "unknown",
          minutes: a.minutes,
          state: a.state,
          note: a.note,
        })),
        unallocatedMinutes: Math.max(0, total - allocated),
        answers: h.questions
          .filter((q: Row) => q.answer && q.source !== "uncertainty")
          .map((q: Row) => ({ question: q.question, answer: q.answer })),
        clarifications: h.questions
          .filter((q: Row) => q.answer && q.source === "uncertainty")
          .map((q: Row) => ({ question: q.question, answer: q.answer })),
        reflection: e.reflection ?? "",
        improvement: e.improvement ?? "",
        goal,
      });
      if (loadEntry(e.id).version !== version) {
        finishJob(jobId, "stale", { model, result: output });
        res.status(409).json({ error: "记录在评分期间被修改，结果已丢弃，请重新评分", entry: hydrate(loadEntry(e.id)) });
        return;
      }
      const dims: ScoreDims = {
        execution_quality: clampScore(output.execution_quality),
        goal_contribution: clampScore(output.goal_contribution),
        arrangement_quality: clampScore(output.arrangement_quality),
      };
      const kind = dominantKind(h.allocations as Allocation[], cats);
      const t = nowIso();
      run(
        `INSERT INTO score_revisions (id,entry_id,execution_quality,goal_contribution,arrangement_quality,overall,dominant_kind,reason,uncertainties_json,suggestion,goal_progress,goal_progress_reason,source,ai_raw_json,rule_version,model,entry_version,created_at,updated_at,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ai',?,?,?,?,?,?,?)`,
        newId("score"), e.id, dims.execution_quality, dims.goal_contribution, dims.arrangement_quality,
        computeOverall(dims, kind), kind, output.reason, JSON.stringify(output.uncertainties), output.suggestion,
        // 只有关联了目标才保存进度建议
        goal && output.goal_progress.progress != null ? clampScore(output.goal_progress.progress) : null,
        goal && output.goal_progress.progress != null ? output.goal_progress.reason : null,
        JSON.stringify(output), RULES_V1.version, model, version, t, t, DEVICE_ID,
      );
      run(`UPDATE entries SET status='needs_confirmation',analysis_error=NULL WHERE id=?`, e.id);
      finishJob(jobId, "done", { model, result: output });
      res.json(hydrate(loadEntry(e.id)));
    } catch (err) {
      const msg = err instanceof AIError ? err.message : `评分失败：${(err as Error).message}`;
      finishJob(jobId, "failed", { error: msg });
      run(`UPDATE entries SET analysis_error=? WHERE id=?`, msg, e.id);
      res.status(502).json({ error: msg, retryable: err instanceof AIError ? err.retryable : true, entry: hydrate(loadEntry(e.id)) });
    }
  }),
);

// ---------- 用户确认或修改评分 ----------

const CHANGE_KINDS = new Set(["only_this", "ai_misunderstood", "allocation_wrong", "rule_unfit", "apply_future"]);

api.post("/entries/:id/confirm", (req, res) => {
  const e = loadEntry(String(req.params.id));
  const h = hydrate(e);
  const cats = categories();
  const latest = h.score;
  const body = req.body ?? {};
  const dims: ScoreDims | null = body.dims
    ? {
        execution_quality: clampScore(body.dims.execution_quality),
        goal_contribution: clampScore(body.dims.goal_contribution),
        arrangement_quality: clampScore(body.dims.arrangement_quality),
      }
    : null;
  if (!dims && !latest) throw new HttpError(400, "还没有评分：请先让 AI 评分，或手动填写三个维度");
  const changed =
    dims &&
    (!latest ||
      dims.execution_quality !== latest.execution_quality ||
      dims.goal_contribution !== latest.goal_contribution ||
      dims.arrangement_quality !== latest.arrangement_quality);
  const t = nowIso();
  tx(() => {
    if (changed) {
      if (latest && body.change_kind && !CHANGE_KINDS.has(body.change_kind)) throw new HttpError(400, "修改原因无效");
      const kind = dominantKind(h.allocations as Allocation[], cats);
      run(
        `INSERT INTO score_revisions (id,entry_id,execution_quality,goal_contribution,arrangement_quality,overall,dominant_kind,reason,uncertainties_json,suggestion,goal_progress,goal_progress_reason,source,change_kind,change_note,rule_version,entry_version,created_at,updated_at,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId("score"), e.id, dims.execution_quality, dims.goal_contribution, dims.arrangement_quality,
        computeOverall(dims, kind), kind, latest?.reason ?? null, JSON.stringify(latest?.uncertainties ?? []), latest?.suggestion ?? null,
        latest?.goal_progress ?? null, latest?.goal_progress_reason ?? null,
        latest ? "user" : "manual", body.change_kind ?? null, body.change_note ?? null, RULES_V1.version, e.version, t, t, DEVICE_ID,
      );
    }
    // 目标进度：用户确认（或修改过）的值写回目标，并留下记录
    if (e.goal_id && typeof body.goal_progress === "number") {
      const value = clampScore(body.goal_progress);
      const suggested = latest?.goal_progress ?? null;
      const note = String(body.goal_progress_reason ?? "").trim();
      const reason = note || (value === suggested ? (latest?.goal_progress_reason ?? "") : "");
      const cur = one(`SELECT progress FROM goals WHERE id=?`, e.goal_id);
      if (cur && cur.progress !== value && !reason) throw new HttpError(400, "更新目标进度需要写明这次推进了什么");
      setGoalProgress(e.goal_id, value, value === suggested && (!note || note === latest?.goal_progress_reason) ? "ai" : "user", reason, e.id);
    }
    // 确认时把仍是估计的分配一并标为确认
    run(`UPDATE allocations SET state='confirmed',updated_at=? WHERE entry_id=? AND deleted=0`, t, e.id);
    run(`UPDATE entries SET status='confirmed',updated_at=? WHERE id=?`, t, e.id);
  });
  res.json(hydrate(loadEntry(e.id)));
});

// ---------- 目标 ----------

api.get("/goals", (_req, res) => res.json(goals()));

function writeGoal(id: string | null, b: any) {
  const t = nowIso();
  const level = ["long", "short", "task"].includes(b.level) ? b.level : "short";
  const fields = [
    level,
    b.parent_id || null,
    String(b.title ?? "").trim(),
    b.description ?? null,
    b.start_date || null,
    b.ddl || null,
    Math.max(0, Math.min(100, Math.round(Number(b.progress ?? 0)))),
    b.progress_note ?? null,
    Math.max(1, Math.min(3, Math.round(Number(b.priority ?? 2)))),
    ["active", "paused", "done", "dropped"].includes(b.status) ? b.status : "active",
    b.is_primary ? 1 : 0,
  ];
  if (!fields[2]) throw new HttpError(400, "目标名称不能为空");
  // 父目标不能是自己或自己的下级
  for (let p = fields[1] as string | null, i = 0; p && i < 10; i++) {
    if (p === id) throw new HttpError(400, "父目标不能是它自己或它的子目标");
    p = (one(`SELECT parent_id FROM goals WHERE id=?`, p)?.parent_id as string | null) ?? null;
  }
  // 占父目标的比例：没有父目标时为空；没给时默认取兄弟目标还没分掉的部分
  let weight: number | null = null;
  if (fields[1]) {
    if (b.weight != null && b.weight !== "") weight = Math.max(0, Math.min(100, Math.round(Number(b.weight))));
    else {
      const used = one(`SELECT COALESCE(SUM(weight),0) AS w FROM goals WHERE parent_id=? AND deleted=0 AND id<>?`, fields[1], id ?? "")!.w as number;
      weight = Math.max(0, 100 - used);
    }
  }
  const progressReason = String(b.progress_reason ?? "").trim();
  if (id) {
    const old = one(`SELECT progress FROM goals WHERE id=?`, id);
    if (old && old.progress !== fields[6] && !progressReason) throw new HttpError(400, "修改进度需要写明这次推进了什么");
  }
  tx(() => {
    if (b.is_primary) run(`UPDATE goals SET is_primary=0,updated_at=?,version=version+1 WHERE is_primary=1`, t);
    if (id) {
      setGoalProgress(id, fields[6] as number, "manual", progressReason || null, null);
      run(
        `UPDATE goals SET level=?,parent_id=?,title=?,description=?,start_date=?,ddl=?,progress=?,progress_note=?,priority=?,status=?,is_primary=?,weight=?,updated_at=?,version=version+1,device_id=? WHERE id=?`,
        ...fields, weight, t, DEVICE_ID, id,
      );
    } else {
      id = newId("goal");
      run(
        `INSERT INTO goals (level,parent_id,title,description,start_date,ddl,progress,progress_note,priority,status,is_primary,weight,id,created_at,updated_at,device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ...fields, weight, id, t, t, DEVICE_ID,
      );
    }
  });
  return one(`SELECT * FROM goals WHERE id=?`, id);
}

// 目标详情：关联的全部记录、完整进度历史，用于画完成曲线
api.get("/goals/:id/detail", (req, res) => {
  const id = String(req.params.id);
  const g = goals().find((x) => x.id === id);
  if (!g) throw new HttpError(404, "目标不存在");
  const entries = all(
    `SELECT x.id,x.start_utc,x.end_utc,x.title,x.raw_text,x.status,
       (SELECT overall FROM score_revisions s WHERE s.entry_id=x.id AND s.deleted=0 ORDER BY s.created_at DESC LIMIT 1) AS overall,
       (SELECT COALESCE(SUM(a.minutes),0) FROM allocations a JOIN categories c ON c.id=a.category_id
          WHERE a.entry_id=x.id AND a.deleted=0 AND a.state='confirmed' AND c.kind='work') AS work_minutes
     FROM entries x WHERE x.deleted=0 AND x.goal_id=? ORDER BY x.start_utc`,
    id,
  ).map((e): Row => ({ ...e, counted: e.status === "confirmed" }));
  const events = all(
    `SELECT entry_id,from_progress,to_progress,source,reason,created_at FROM goal_progress_events WHERE deleted=0 AND goal_id=? ORDER BY created_at`,
    id,
  );
  // 起点：第一条进度记录之前的值；没有记录时就是当前进度
  const startProgress = events.length ? events[0].from_progress : g.progress;
  res.json({ goal: g, entries, events, start: { at: g.created_at, progress: startProgress } });
});

api.post("/goals", (req, res) => res.status(201).json(writeGoal(null, req.body)));

// ---------- 拆分目标 ----------

const CHILD_LEVEL: Record<string, string> = { long: "short", short: "task", task: "task" };
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 整理拆分建议：去空标题、占比缩放到剩余份额、DDL 限制在今天到父 DDL 之间且按顺序不递减 */
function cleanSteps(raw: { title: string; description?: string | null; weight: number; ddl: string | null }[], remaining: number, parentDdl: string | null) {
  const today = localToday();
  const steps = raw
    .map((x) => ({
      title: String(x.title ?? "").trim().slice(0, 40),
      description: String(x.description ?? "").trim().slice(0, 200),
      weight: Math.max(0, Number(x.weight) || 0),
      ddl: typeof x.ddl === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.ddl) ? x.ddl : null,
    }))
    .filter((x) => x.title)
    .slice(0, 8);
  const sum = steps.reduce((a, x) => a + x.weight, 0);
  steps.forEach((x) => (x.weight = sum > 0 ? Math.round((x.weight * remaining) / sum) : Math.round(remaining / steps.length)));
  // 四舍五入的误差补到最大的一项上，让合计正好等于剩余份额
  const diff = remaining - steps.reduce((a, x) => a + x.weight, 0);
  if (steps.length && diff) steps.reduce((m, x) => (x.weight > m.weight ? x : m), steps[0]).weight += diff;
  let prev = today;
  for (const x of steps) {
    if (!x.ddl) continue;
    if (x.ddl < prev) x.ddl = prev;
    if (parentDdl && x.ddl > parentDdl) x.ddl = parentDdl;
    prev = x.ddl;
  }
  return steps;
}

function remainingWeightOf(goalId: string) {
  const used = one(`SELECT COALESCE(SUM(weight),0) AS w FROM goals WHERE parent_id=? AND deleted=0`, goalId)!.w as number;
  return Math.max(0, 100 - used);
}

// AI 建议拆分（不保存，返回给界面编辑）
api.post(
  "/goals/:id/split/suggest",
  wrap(async (req, res) => {
    const g = goals().find((x) => x.id === String(req.params.id));
    if (!g) throw new HttpError(404, "目标不存在");
    const remaining = remainingWeightOf(g.id);
    if (remaining <= 0) throw new HttpError(400, "已有子目标的占比已经满 100%，先调整再拆分");
    const existing = all(`SELECT title,weight,progress FROM goals WHERE parent_id=? AND deleted=0`, g.id).map((k) => ({
      title: k.title as string,
      weight: (k.weight ?? 0) as number,
      progress: k.progress as number,
    }));
    try {
      const { output, model } = await splitGoal({
        today: localToday(),
        goal: { title: g.title, description: g.description, level: g.level, ddl: g.ddl, progress: g.progress },
        existing,
        remainingWeight: remaining,
      });
      res.json({ steps: cleanSteps(output.steps, remaining, g.ddl), note: output.note, remaining, model });
    } catch (err) {
      const msg = err instanceof AIError ? err.message : `拆分失败：${(err as Error).message}`;
      res.status(502).json({ error: msg });
    }
  }),
);

// 批量创建子目标（用户确认过的步骤）
api.post("/goals/:id/children", (req, res) => {
  const g = goals().find((x) => x.id === String(req.params.id));
  if (!g) throw new HttpError(404, "目标不存在");
  const list: any[] = Array.isArray(req.body?.children) ? req.body.children : [];
  const steps = list
    .map((x) => ({
      title: String(x.title ?? "").trim().slice(0, 40),
      description: String(x.description ?? "").trim().slice(0, 200) || null,
      weight: Math.max(0, Math.min(100, Math.round(Number(x.weight) || 0))),
      ddl: typeof x.ddl === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.ddl) ? x.ddl : null,
    }))
    .filter((x) => x.title);
  if (!steps.length) throw new HttpError(400, "没有可创建的步骤");
  const created = steps.map((x) =>
    writeGoal(null, { level: CHILD_LEVEL[g.level], parent_id: g.id, title: x.title, description: x.description, ddl: x.ddl, weight: x.weight, priority: g.priority, progress: 0 }),
  );
  res.status(201).json({ created: created.length });
});

// 按子目标汇总：父目标进度 = Σ 子目标进度 × 占比
api.post("/goals/:id/rollup", (req, res) => {
  const id = String(req.params.id);
  const g = one(`SELECT progress FROM goals WHERE id=? AND deleted=0`, id);
  if (!g) throw new HttpError(404, "目标不存在");
  const kids = all(`SELECT title,progress,weight FROM goals WHERE parent_id=? AND deleted=0 AND weight>0`, id);
  if (kids.length === 0) throw new HttpError(400, "没有设置了占比的子目标");
  const value = Math.max(0, Math.min(100, Math.round(kids.reduce((s, k) => s + (k.progress * k.weight) / 100, 0))));
  tx(() => {
    run(`UPDATE goals SET rollup_carry=0 WHERE id=?`, id);
    setGoalProgress(id, value, "rollup", `按子目标汇总（${kids.map((k) => `${k.title} ${k.progress}%×${k.weight}%`).join("，")}）`, null);
  });
  res.json(goals().find((x) => x.id === id));
});
api.patch("/goals/:id", (req, res) => {
  const g = one(`SELECT * FROM goals WHERE id=? AND deleted=0`, String(req.params.id));
  if (!g) throw new HttpError(404, "目标不存在");
  res.json(writeGoal(g.id, { ...g, is_primary: !!g.is_primary, ...req.body }));
});
api.delete("/goals/:id", (req, res) => {
  run(`UPDATE goals SET deleted=1,is_primary=0,updated_at=?,version=version+1 WHERE id=?`, nowIso(), String(req.params.id));
  res.json({ ok: true });
});

// ---------- 设置 ----------

// 身份与常见活动
api.put("/profile", (req, res) => {
  const b = req.body ?? {};
  const catIds = new Set(categories().map((c) => c.id));
  const preset = PROFILE_PRESETS.find((p) => p.key === b.role);
  const roleLabel = String(preset?.label ?? b.roleLabel ?? "").trim().slice(0, 20);
  if (!roleLabel) throw new HttpError(400, "身份不能为空");
  const activities = (Array.isArray(b.activities) ? b.activities : [])
    .map((a: any) => ({ label: String(a?.label ?? "").trim().slice(0, 12), cat: catIds.has(a?.cat) ? a.cat : "cat_unknown" }))
    .filter((a: { label: string }) => a.label)
    .slice(0, 24);
  const p: Profile = { role: preset ? preset.key : "custom", roleLabel, description: String(b.description ?? "").trim().slice(0, 200), activities };
  setSetting("profile", p);
  res.json(p);
});

api.put("/settings", (req, res) => {
  if (req.body.work_budget_minutes != null) {
    const m = Math.round(Number(req.body.work_budget_minutes));
    if (!(m > 0 && m <= 16 * 60)) throw new HttpError(400, "预算需在 1 分钟到 16 小时之间");
    setSetting("work_budget_minutes", m);
  }
  res.json({ work_budget_minutes: workBudget() });
});

// ---------- 导出 / 导入 ----------

const EXPORT_TABLES = ["categories", "goals", "entries", "allocations", "review_questions", "score_revisions", "rulesets", "settings"];

api.get("/export", (_req, res) => {
  const data: Record<string, Row[]> = {};
  for (const tname of EXPORT_TABLES) data[tname] = all(`SELECT * FROM ${tname}`);
  res.setHeader("Content-Disposition", `attachment; filename="time-records-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ format: "time-evaluate-agent/export", schema_version: 1, exported_at: nowIso(), device_id: DEVICE_ID, data });
});

api.post("/import", express.json({ limit: "50mb" }), (req, res) => {
  const body = req.body;
  if (body?.format !== "time-evaluate-agent/export") throw new HttpError(400, "不是本应用导出的文件");
  const counts: Record<string, number> = {};
  tx(() => {
    for (const tname of EXPORT_TABLES) {
      const rows: Row[] = body.data?.[tname] ?? [];
      const cols = new Set(all(`PRAGMA table_info(${tname})`).map((c) => c.name as string));
      const key = tname === "settings" ? "key" : "id";
      let n = 0;
      for (const r of rows) {
        const keys = Object.keys(r).filter((k) => cols.has(k));
        if (!keys.includes(key)) continue;
        const existing = one(`SELECT * FROM ${tname} WHERE ${key}=?`, r[key]);
        // 已有更新版本时不覆盖
        if (existing && "version" in existing && Number(existing.version) > Number(r.version ?? 0)) continue;
        run(
          `INSERT OR REPLACE INTO ${tname} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          ...keys.map((k) => r[k]),
        );
        n++;
      }
      counts[tname] = n;
    }
  });
  res.json({ ok: true, counts });
});

// ---------- 语音转写（可选服务端） ----------

api.post(
  "/asr",
  express.raw({ type: () => true, limit: "25mb" }),
  wrap(async (req, res) => {
    const base = process.env.ASR_BASE_URL;
    if (!base) throw new HttpError(400, "未配置语音转写服务");
    const form = new FormData();
    const mime = String(req.headers["content-type"] || "audio/webm");
    form.append("file", new Blob([new Uint8Array(req.body as Buffer)], { type: mime }), `audio.${mime.includes("mp4") ? "mp4" : "webm"}`);
    form.append("model", process.env.ASR_MODEL || "whisper-1");
    form.append("language", "zh");
    const r = await fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: process.env.ASR_API_KEY ? { Authorization: `Bearer ${process.env.ASR_API_KEY}` } : {},
      body: form,
    });
    if (!r.ok) throw new HttpError(502, `转写失败（${r.status}）`);
    const j = (await r.json()) as { text?: string };
    res.json({ text: j.text ?? "" });
  }),
);

// ---------- 电脑使用参照 ----------

/** 某条记录时段内的电脑使用摘要（给 AI 的一行文字） */
async function deviceLineFor(e: Row): Promise<string | null> {
  try {
    return summaryForAI(await deviceSummary(Date.parse(e.start_utc), Date.parse(e.end_utc)));
  } catch {
    return null;
  }
}

/** 对话用：最近 6 小时、每小时一行的电脑使用参照 */
async function recentDeviceText(): Promise<string> {
  if (!deviceSettings().sendToAI) return "";
  const now = Date.now();
  const lines: string[] = [];
  for (let h = 5; h >= 0; h--) {
    const end = now - h * 3600_000;
    const start = end - 3600_000;
    try {
      const sm = await deviceSummary(start, end);
      if (sm.coveredMinutes === 0) continue;
      const apps = sm.apps.slice(0, 4).map((a) => appLine(a, 2)).join("、");
      lines.push(`- ${localStamp(new Date(start)).slice(11)}–${localStamp(new Date(end)).slice(11)}：${apps || "无"}${sm.afkMinutes ? `；离开键鼠 ${sm.afkMinutes}` : ""}`);
    } catch {
      /* 没有数据就跳过 */
    }
  }
  return lines.length
    ? `\n\n最近 6 小时电脑前台应用（分钟，按小时；只作参照，不等于专注，手机不在其中）：\n${lines.join("\n")}`
    : "";
}

api.get(
  "/device/status",
  wrap(async (_req, res) => res.json(await deviceStatus())),
);

api.get(
  "/device/summary",
  wrap(async (req, res) => {
    const start = Date.parse(String(req.query.start ?? ""));
    const end = Date.parse(String(req.query.end ?? ""));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new HttpError(400, "时间范围无效");
    res.json(await deviceSummary(start, end));
  }),
);

/** 最近 7 天出现过的应用和网站（设置里选择排除用） */
api.get("/device/apps", (_req, res) => {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const apps = all(`SELECT app, COUNT(*) AS n FROM device_spans WHERE afk=0 AND end_utc > ? AND app NOT LIKE '（%' GROUP BY app ORDER BY n DESC LIMIT 40`, since).map((r) => r.app);
  const sites = all(
    `SELECT detail, COUNT(*) AS n FROM device_spans WHERE afk=0 AND end_utc > ? AND detail IS NOT NULL AND detail NOT LIKE '（%'
     AND app IN ('Google Chrome','Microsoft Edge','Brave Browser','Arc','Safari') GROUP BY detail ORDER BY n DESC LIMIT 40`,
    since,
  ).map((r) => r.detail);
  // 已安装的应用（“只记录我选的应用”时从这里挑）
  const installed: string[] = [];
  for (const dir of ["/Applications", path.join(os.homedir(), "Applications")]) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".app")) installed.push(f.slice(0, -4));
    } catch {
      /* 目录不存在 */
    }
  }
  res.json({ apps, sites, installed: [...new Set(installed)].sort((a, b) => a.localeCompare(b)) });
});

api.put("/device/settings", (req, res) => {
  const b = req.body ?? {};
  if (typeof b.enabled === "boolean") saveSetting("device_enabled", b.enabled);
  if (typeof b.send_to_ai === "boolean") saveSetting("device_send_to_ai", b.send_to_ai);
  if (Array.isArray(b.excluded_apps)) saveSetting("device_excluded_apps", b.excluded_apps.map(String).slice(0, 100));
  if (Array.isArray(b.excluded_sites)) saveSetting("device_excluded_sites", b.excluded_sites.map(String).slice(0, 100));
  if (typeof b.detail === "boolean") saveSetting("device_detail", b.detail);
  if (b.rules && typeof b.rules === "object") {
    const ids = new Set(categories().map((c) => c.id));
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.rules)) if (/^(app|site):/.test(k) && ids.has(String(v))) clean[k.slice(0, 120)] = String(v);
    saveSetting("device_rules", clean);
  }
  if (b.mode === "all" || b.mode === "only") saveSetting("device_mode", b.mode);
  if (Array.isArray(b.monitored_apps)) saveSetting("device_monitored_apps", b.monitored_apps.map(String).slice(0, 200));
  res.json(deviceSettings());
});

// ---------- 对话 ----------

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const localStamp = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** “YYYY-MM-DD HH:mm”（当地时间）→ Date；格式不对返回 null */
function parseLocal(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 给 AI 的上下文：分类、目标、最近 3 天的记录（带 ID，便于修改） */
function chatContext() {
  const cats = categories();
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const gs = goals();
  const goalLines = gs
    .filter((g) => g.status === "active" || g.status === "paused")
    .map((g) => {
      const kidsW = gs.filter((k) => k.parent_id === g.id).reduce((a, k) => a + (k.weight ?? 0), 0);
      return `- [${g.id}] ${g.level === "long" ? "长期" : g.level === "short" ? "短期" : "任务"}${g.is_primary ? "★主要" : ""} ${g.title} · 进度 ${g.progress}%${g.ddl ? ` · DDL ${g.ddl}` : ""}${g.parent_id ? ` · 父目标 ${g.parent_id} 占 ${g.weight ?? 0}%` : ""}${kidsW ? ` · 子目标已占 ${kidsW}%` : ""} · 已投入 ${Math.round(g.invested_minutes)} 分钟`;
    });
  const from = new Date(backfillWindowStart(Date.now())).toISOString();
  const rows = all(`SELECT * FROM entries WHERE deleted=0 AND end_utc > ? ORDER BY start_utc`, from).map((r): Row => hydrate(r));
  const entryLines = rows.map((e) => {
    const s = new Date(e.start_utc);
    const en = new Date(e.end_utc);
    const alloc = e.allocations.map((a: Row) => `${catName.get(a.category_id) ?? a.category_id} ${a.minutes}`).join("、");
    const score = e.score ? ` · 评分 ${e.score.overall}${e.status === "confirmed" ? "（已确认）" : "（待确认）"}` : "";
    const goal = e.goal_id ? ` · 目标 ${gs.find((g) => g.id === e.goal_id)?.title ?? e.goal_id}` : "";
    return `- [${e.id}] ${localStamp(s)}–${localStamp(en).slice(11)} ${e.title ?? ""}：${String(e.raw_text).slice(0, 60)}${alloc ? ` · 分配 ${alloc}` : " · 未分配"}${goal}${score}`;
  });
  return {
    text: `${profileLine(profile())}

分类：\n${cats.map((c) => `- ${c.id}：${c.name}（${c.kind}）`).join("\n")}

目标：\n${goalLines.join("\n") || "（无）"}

最近 3 天的记录（含 ID）：\n${entryLines.join("\n") || "（无）"}

每日有效脑力工作预算：${workBudget()} 分钟${
      Object.keys(deviceSettings().rules).length
        ? `\n\n应用/网站归类规则（电脑数据按这个分类）：\n${Object.entries(deviceSettings().rules)
            .map(([k, v]) => `- ${k.replace(/^app:/, "应用 ").replace(/^site:/, "网站 ")} → ${cats.find((c) => c.id === v)?.name ?? v}`)
            .join("\n")}`
        : ""
    }`,
    catIds: new Set(cats.map((c) => c.id)),
    entryIds: new Set(rows.map((e) => e.id as string)),
    goalIds: new Set(gs.map((g) => g.id as string)),
  };
}

type StoredAction = ChatAction & { status: "pending" | "applied" | "dismissed" | "failed" | "invalid"; error?: string; start_iso?: string; end_iso?: string; result?: unknown };

/** 检查 AI 提出的操作：ID 必须存在、时间合法、分类有效；不合格的标成 invalid 并写明原因 */
function checkAction(a: ChatAction, ctx: ReturnType<typeof chatContext>): StoredAction {
  const out: StoredAction = { ...a, status: "pending" };
  const bad = (msg: string) => ({ ...out, status: "invalid" as const, error: msg });
  out.allocations = (a.allocations ?? []).filter((x) => ctx.catIds.has(x.category_id) && x.minutes > 0).map((x) => ({ ...x, minutes: Math.round(x.minutes) }));
  if (["update_entry", "delete_entry", "score_entry"].includes(a.type) && !(a.entry_id && ctx.entryIds.has(a.entry_id))) return bad("找不到要操作的记录");
  if (["update_goal", "update_goal_progress", "split_goal"].includes(a.type) && !(a.goal_id && ctx.goalIds.has(a.goal_id))) return bad("找不到要操作的目标");
  if (a.goal_id && !ctx.goalIds.has(a.goal_id)) out.goal_id = null;
  if (a.parent_id && !ctx.goalIds.has(a.parent_id)) out.parent_id = null;
  if (a.type === "create_entry" || (a.type === "update_entry" && (a.start || a.end))) {
    const s = parseLocal(a.start);
    const e = parseLocal(a.end);
    if (a.type === "create_entry" && (!s || !e)) return bad("时间格式不对");
    if (s && e) {
      const err = checkRecordWindow(s.getTime(), e.getTime(), Date.now());
      if (err) return bad(err);
      out.start_iso = s.toISOString();
      out.end_iso = e.toISOString();
      const total = Math.round((e.getTime() - s.getTime()) / 60000);
      const sum = out.allocations.reduce((x, y) => x + y.minutes, 0);
      if (sum > total) return bad(`分配合计 ${sum} 分钟超过时段 ${total} 分钟`);
    }
  }
  if (a.type === "update_goal_progress") {
    if (a.progress == null) return bad("没有给出新进度");
    if (!a.reason?.trim()) return bad("没有写明推进了什么");
    out.progress = clampScore(a.progress);
  }
  if (a.type === "create_goal" && !a.title?.trim()) return bad("目标名称为空");
  if (a.type === "split_goal") {
    const g = goals().find((x) => x.id === a.goal_id)!;
    const remaining = remainingWeightOf(g.id);
    if (remaining <= 0) return bad("这个目标的子目标占比已满");
    out.steps = cleanSteps(a.steps ?? [], remaining, g.ddl).map((x) => ({ ...x, description: x.description ?? "" }));
    if (!out.steps.length) return bad("没有给出步骤");
  }
  return out;
}

const chatRow = (r: Row) => ({
  id: r.id,
  role: r.role,
  content: r.content,
  actions: r.actions_json ? JSON.parse(r.actions_json) : [],
  quick_replies: r.quick_json ? JSON.parse(r.quick_json) : [],
  model: r.model,
  created_at: r.created_at,
});

api.get("/chat", (_req, res) => {
  res.json(all(`SELECT * FROM chat_messages WHERE deleted=0 ORDER BY created_at`).map(chatRow));
});

api.post(
  "/chat",
  wrap(async (req, res) => {
    const message = String(req.body?.message ?? "").trim().slice(0, 4000);
    if (!message) throw new HttpError(400, "说点什么吧");
    // event：应用里发生的事（用户点了“应用”），不是用户说的话
    const event = req.body?.event === true;
    const t = nowIso();
    const userId = newId("msg");
    run(`INSERT INTO chat_messages (id,role,content,created_at) VALUES (?,?,?,?)`, userId, event ? "event" : "user", message, t);
    // 最近 20 条对话；助手消息附上它提出的操作和处理结果
    const history = all(`SELECT * FROM chat_messages WHERE deleted=0 AND id<>? ORDER BY created_at DESC LIMIT 20`, userId)
      .reverse()
      .map(chatRow)
      .map((m) => {
        if (m.role === "user") return `用户：${m.content}`;
        if (m.role === "event") return `（应用事件：${m.content}）`;
        const acts = (m.actions as StoredAction[])
          .map((a) => `  （操作 ${a.type}：${a.summary} → ${{ pending: "用户还没处理", applied: "已应用", dismissed: "用户忽略了", failed: "应用失败", invalid: "无效" }[a.status]}）`)
          .join("\n");
        return `助手：${m.content}${acts ? `\n${acts}` : ""}`;
      })
      .join("\n");
    const ctx = chatContext();
    const now = new Date();
    try {
      const { output, model } = await chatTurn({ now: `${localStamp(now)} ${WEEK[now.getDay()]}`, context: ctx.text + (await recentDeviceText()), history, message, event });
      const actions = output.actions.slice(0, 8).map((a) => checkAction(a, ctx));
      const quick = output.quick_replies.map((q) => String(q).trim().slice(0, 30)).filter(Boolean).slice(0, 4);
      const id = newId("msg");
      run(
        `INSERT INTO chat_messages (id,role,content,actions_json,quick_json,model,created_at) VALUES (?,?,?,?,?,?,?)`,
        id, "assistant", output.reply, JSON.stringify(actions), JSON.stringify(quick), model, nowIso(),
      );
      res.json(chatRow(one(`SELECT * FROM chat_messages WHERE id=?`, id)!));
    } catch (err) {
      const msg = err instanceof AIError ? err.message : `对话失败：${(err as Error).message}`;
      res.status(502).json({ error: msg });
    }
  }),
);

// 用户处理了某个操作（应用/忽略），记录结果
api.patch("/chat/:id/actions/:idx", (req, res) => {
  const m = one(`SELECT * FROM chat_messages WHERE id=? AND deleted=0`, String(req.params.id));
  if (!m) throw new HttpError(404, "消息不存在");
  const actions: StoredAction[] = JSON.parse(m.actions_json ?? "[]");
  const i = Number(req.params.idx);
  if (!actions[i]) throw new HttpError(404, "操作不存在");
  const status = req.body?.status;
  if (!["applied", "dismissed", "failed"].includes(status)) throw new HttpError(400, "状态无效");
  actions[i] = { ...actions[i], status, error: req.body?.error ?? undefined, result: req.body?.result ?? undefined };
  run(`UPDATE chat_messages SET actions_json=? WHERE id=?`, JSON.stringify(actions), m.id);
  res.json(chatRow(one(`SELECT * FROM chat_messages WHERE id=?`, m.id)!));
});

api.delete("/chat", (_req, res) => {
  run(`UPDATE chat_messages SET deleted=1 WHERE deleted=0`);
  res.json({ ok: true });
});

// ---------- 错误处理 ----------

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});

import express, { type Request, type Response, type NextFunction } from "express";
import { db, DEVICE_ID, newId, nowIso, getSetting, setSetting, tx } from "./db.ts";
import {
  RULES_V1,
  checkAllocations,
  clampScore,
  computeOverall,
  dominantKind,
  durationMinutes,
  sanitizeAllocations,
  type Allocation,
  type Category,
  type ScoreDims,
} from "../../../modules/scoring/index.ts";
import { analyzeEntry, scoreEntry, type EntryContext } from "../../../modules/ai/tasks.ts";
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
  return all(`SELECT * FROM goals WHERE deleted=0 ORDER BY is_primary DESC, status='active' DESC, priority ASC, ddl IS NULL, ddl`).map((g): Row => ({ ...g, is_primary: !!g.is_primary }));
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
    `SELECT id,ord,question,options_json,answer,source FROM review_questions WHERE entry_id=? AND deleted=0 ORDER BY ord`,
    e.id,
  ).map((q) => ({ ...q, options: JSON.parse(q.options_json), options_json: undefined }));
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

function validateRange(start: string, end: string) {
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw new HttpError(400, "时间格式无效");
  if (Date.parse(end) <= Date.parse(start)) throw new HttpError(400, "结束时间必须晚于开始时间");
  if (Date.parse(end) - Date.parse(start) > 24 * 3600_000) throw new HttpError(400, "单段记录不能超过 24 小时");
}

api.post("/entries", (req, res) => {
  const { start, end, tz, text } = req.body ?? {};
  validateRange(start, end);
  const id = newId("entry");
  const t = nowIso();
  run(
    `INSERT INTO entries (id,start_utc,end_utc,tz,raw_text,status,created_at,updated_at,device_id) VALUES (?,?,?,?,?,'draft',?,?,?)`,
    id,
    new Date(start).toISOString(),
    new Date(end).toISOString(),
    tz || "UTC",
    String(text ?? ""),
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
  validateRange(start, end);
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
    const ctx = entryContext(e);
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

// ---------- 用户确认事实（分配 + 回答） ----------

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
    const ctx = entryContext(e);
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
        answers: h.questions.filter((q: Row) => q.answer).map((q: Row) => ({ question: q.question, answer: q.answer })),
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
        `INSERT INTO score_revisions (id,entry_id,execution_quality,goal_contribution,arrangement_quality,overall,dominant_kind,reason,uncertainties_json,suggestion,source,ai_raw_json,rule_version,model,entry_version,created_at,updated_at,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,'ai',?,?,?,?,?,?,?)`,
        newId("score"), e.id, dims.execution_quality, dims.goal_contribution, dims.arrangement_quality,
        computeOverall(dims, kind), kind, output.reason, JSON.stringify(output.uncertainties), output.suggestion,
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
        `INSERT INTO score_revisions (id,entry_id,execution_quality,goal_contribution,arrangement_quality,overall,dominant_kind,reason,uncertainties_json,suggestion,source,change_kind,change_note,rule_version,entry_version,created_at,updated_at,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId("score"), e.id, dims.execution_quality, dims.goal_contribution, dims.arrangement_quality,
        computeOverall(dims, kind), kind, latest?.reason ?? null, JSON.stringify(latest?.uncertainties ?? []), latest?.suggestion ?? null,
        latest ? "user" : "manual", body.change_kind ?? null, body.change_note ?? null, RULES_V1.version, e.version, t, t, DEVICE_ID,
      );
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
  tx(() => {
    if (b.is_primary) run(`UPDATE goals SET is_primary=0,updated_at=?,version=version+1 WHERE is_primary=1`, t);
    if (id) {
      run(
        `UPDATE goals SET level=?,parent_id=?,title=?,description=?,start_date=?,ddl=?,progress=?,progress_note=?,priority=?,status=?,is_primary=?,updated_at=?,version=version+1,device_id=? WHERE id=?`,
        ...fields, t, DEVICE_ID, id,
      );
    } else {
      id = newId("goal");
      run(
        `INSERT INTO goals (level,parent_id,title,description,start_date,ddl,progress,progress_note,priority,status,is_primary,id,created_at,updated_at,device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ...fields, id, t, t, DEVICE_ID,
      );
    }
  });
  return one(`SELECT * FROM goals WHERE id=?`, id);
}

api.post("/goals", (req, res) => res.status(201).json(writeGoal(null, req.body)));
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

// ---------- 错误处理 ----------

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "服务器内部错误" });
});

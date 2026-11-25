import { useEffect, useMemo, useState } from "react";
import { dominantKind, durationMinutes, type ScoreDims } from "../../../../modules/scoring/index.ts";
import { api, ApiError, fmtMinutes, fromLocalInput, roundTo5, toLocalInput, TZ, type Entry, type Meta } from "../api.ts";
import { AllocationEditor, type AllocDraft } from "./AllocationEditor.tsx";
import { ScoreCard } from "./ScoreCard.tsx";
import { VoiceButton } from "./VoiceButton.tsx";
import { STATUS_LABEL } from "./Timeline.tsx";

export type RecordTarget = { kind: "new"; start?: Date; end?: Date } | { kind: "edit"; id: string };

const FREE = "__free__";

export function RecordPanel(props: {
  meta: Meta;
  target: RecordTarget;
  entry: Entry | null;
  onChanged: (e: Entry | null) => void;
  onNew: () => void;
}) {
  const { meta, target } = props;
  const [fetched, setFetched] = useState<Entry | null>(null);
  const entry = props.entry ?? fetched;

  // 记录不在当前日期列表里时单独加载
  useEffect(() => {
    if (target.kind === "edit" && !props.entry) api.getEntry(target.id).then(setFetched).catch(() => setFetched(null));
  }, [target, props.entry]);

  const [startStr, setStartStr] = useState("");
  const [endStr, setEndStr] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allocs, setAllocs] = useState<AllocDraft[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [goalId, setGoalId] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // 初始化表单
  useEffect(() => {
    if (initialized) return;
    if (target.kind === "new") {
      const end = target.end ?? roundTo5(new Date());
      if (target.start) {
        setStartStr(toLocalInput(target.start));
        setEndStr(toLocalInput(end));
        setInitialized(true);
      } else {
        // 默认：上次记录结束至现在
        api.lastEnd().then(({ end: last }) => {
          const lastD = last ? new Date(last) : null;
          const start = lastD && end.getTime() - lastD.getTime() < 12 * 3600_000 && lastD < end ? lastD : new Date(end.getTime() - 3600_000);
          setStartStr(toLocalInput(start));
          setEndStr(toLocalInput(end));
          setInitialized(true);
        });
      }
    } else if (entry) {
      setStartStr(toLocalInput(new Date(entry.start_utc)));
      setEndStr(toLocalInput(new Date(entry.end_utc)));
      setText(entry.raw_text);
      setAllocs(entry.allocations.map((a) => ({ category_id: a.category_id, minutes: a.minutes, note: a.note, state: a.state })));
      const ans: Record<string, string> = {};
      const free: Record<string, string> = {};
      for (const q of entry.questions) {
        if (!q.answer) continue;
        if (q.options.includes(q.answer)) ans[q.id] = q.answer;
        else {
          ans[q.id] = FREE;
          free[q.id] = q.answer;
        }
      }
      setAnswers(ans);
      setFreeText(free);
      setGoalId(entry.goal_id);
      setInitialized(true);
    }
  }, [target, entry, initialized]);

  const start = startStr ? fromLocalInput(startStr) : null;
  const end = endStr ? fromLocalInput(endStr) : null;
  const total = start && end ? durationMinutes(start.toISOString(), end.toISOString()) : 0;
  const rangeError = start && end && end <= start ? "结束时间必须晚于开始时间" : total > 24 * 60 ? "单段不能超过 24 小时" : null;

  const metaDirty =
    !!entry &&
    (text !== entry.raw_text ||
      (start && start.toISOString() !== new Date(entry.start_utc).toISOString()) ||
      (end && end.toISOString() !== new Date(entry.end_utc).toISOString()));

  const allocSum = allocs.reduce((s, a) => s + a.minutes, 0);
  const kind = useMemo(() => dominantKind(allocs.map((a) => ({ ...a })), meta.categories), [allocs, meta.categories]);
  const activeGoals = meta.goals.filter((g) => g.status === "active");

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.body?.entry) props.onChanged(e.body.entry);
    } finally {
      setBusy(null);
    }
  }

  const answerList = () =>
    (entry?.questions ?? [])
      .map((q) => ({ id: q.id, answer: answers[q.id] === FREE ? (freeText[q.id] ?? "").trim() : (answers[q.id] ?? "") }))
      .filter((a) => a.answer);

  const saveReview = (id: string) =>
    api.review(id, {
      allocations: allocs.filter((a) => a.minutes > 0).map((a) => ({ category_id: a.category_id, minutes: a.minutes, note: a.note })),
      answers: answerList(),
      goal_id: goalId,
    });

  // ---------- 动作 ----------

  const createAndMaybeAnalyze = (analyze: boolean) =>
    act(analyze ? "正在保存并分析…" : "正在保存…", async () => {
      const e = await api.createEntry({ start: start!.toISOString(), end: end!.toISOString(), tz: TZ, text });
      if (!analyze || !text.trim()) return props.onChanged(e);
      try {
        const r = await api.analyze(e.id);
        props.onChanged(r.entry);
      } catch (err) {
        // 原始记录已保存，分析失败不影响
        props.onChanged(err instanceof ApiError && err.body?.entry ? err.body.entry : e);
      }
    });

  const saveMeta = () =>
    act("正在保存…", async () => {
      const e = await api.updateEntry(entry!.id, { start: start!.toISOString(), end: end!.toISOString(), text });
      props.onChanged(e);
    });

  const analyze = () =>
    act("AI 正在整理…", async () => {
      if (metaDirty) await api.updateEntry(entry!.id, { start: start!.toISOString(), end: end!.toISOString(), text });
      const r = await api.analyze(entry!.id);
      props.onChanged(r.entry);
    });

  const reviewAndScore = () =>
    act("AI 正在评分…", async () => {
      if (metaDirty) await api.updateEntry(entry!.id, { start: start!.toISOString(), end: end!.toISOString(), text });
      await saveReview(entry!.id);
      const e = await api.score(entry!.id);
      props.onChanged(e);
    });

  const confirm = (p: { dims?: ScoreDims; change_kind?: string; change_note?: string }) =>
    act("正在保存…", async () => {
      if (metaDirty) await api.updateEntry(entry!.id, { start: start!.toISOString(), end: end!.toISOString(), text });
      await saveReview(entry!.id);
      const e = await api.confirm(entry!.id, p);
      props.onChanged(e);
    });

  const remove = () => {
    if (!entry || !window.confirm("删除这条记录？")) return;
    act("正在删除…", async () => {
      await api.deleteEntry(entry.id);
      props.onChanged(null);
    });
  };

  // ---------- 渲染 ----------

  if (target.kind === "edit" && !entry) return <div className="card">加载中…</div>;

  const showReview = !!entry && (entry.status === "needs_confirmation" || entry.status === "confirmed" || manual || entry.allocations.length > 0);
  const hasScore = !!entry?.score;
  const canSubmitAlloc = allocSum <= total;

  return (
    <div className="card record">
      <div className="card-head">
        <h3>{entry ? entry.title || "编辑记录" : "记录一段时间"}</h3>
        {entry && <span className={`badge st-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>}
        {entry && (
          <button className="link" onClick={props.onNew}>
            + 新记录
          </button>
        )}
      </div>

      <div className="range">
        <label>
          开始
          <input type="datetime-local" value={startStr} onChange={(e) => setStartStr(e.target.value)} />
        </label>
        <label>
          结束
          <input type="datetime-local" value={endStr} onChange={(e) => setEndStr(e.target.value)} />
        </label>
        <span className="muted">{total > 0 ? fmtMinutes(total) : ""}</span>
      </div>
      {rangeError && <div className="error-text">{rangeError}</div>}

      <div className="textarea-wrap">
        <textarea
          rows={4}
          placeholder="这段时间做了什么、推进了什么？例如：看论文，主要想理解方法，整理了一点笔记，中间刷了会儿手机。"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="textarea-tools">
          <VoiceButton serverAsr={meta.asr.server} onText={(t) => setText((prev) => (prev ? `${prev}${/[，。！？,.!?\s]$/.test(prev) ? "" : "，"}${t}` : t))} />
        </div>
      </div>

      {!entry && (
        <div className="actions">
          <button className="primary" disabled={!!busy || !!rangeError || !startStr || !text.trim()} onClick={() => createAndMaybeAnalyze(true)}>
            保存并分析
          </button>
          <button disabled={!!busy || !!rangeError || !startStr} onClick={() => createAndMaybeAnalyze(false)}>
            仅保存
          </button>
        </div>
      )}

      {entry && (
        <div className="actions">
          {metaDirty && (
            <button disabled={!!busy || !!rangeError} onClick={saveMeta}>
              保存修改
            </button>
          )}
          <button disabled={!!busy || !!rangeError || !text.trim()} onClick={analyze}>
            {entry.status === "draft" || entry.status === "analysis_failed" ? "AI 分析" : "重新分析"}
          </button>
          {!showReview && (
            <button
              disabled={!!busy}
              onClick={() => {
                setManual(true);
                if (allocs.length === 0) setAllocs([{ category_id: "cat_work", minutes: total, note: null, state: "confirmed" }]);
              }}
            >
              不用 AI，手动填写
            </button>
          )}
          <span className="spacer" />
          <button className="link danger" disabled={!!busy} onClick={remove}>
            删除
          </button>
        </div>
      )}

      {busy && <div className="banner info">{busy}</div>}
      {error && <div className="banner error">{error}</div>}
      {entry?.analysis_error && !error && entry.status !== "confirmed" && (
        <div className="banner error">上次 AI 调用失败：{entry.analysis_error}（原始记录已保存，可以重试或手动填写）</div>
      )}

      {entry && showReview && (
        <>
          <h4>时间分配</h4>
          <AllocationEditor total={total} categories={meta.categories} value={allocs} onChange={setAllocs} />

          {entry.questions.length > 0 && (
            <>
              <h4>补充几个事实</h4>
              {entry.questions.map((q) => (
                <div className="question" key={q.id}>
                  <div className="q-text">{q.question}</div>
                  <div className="chips">
                    {q.options.map((o) => (
                      <button key={o} className={`chip${answers[q.id] === o ? " on" : ""}`} onClick={() => setAnswers({ ...answers, [q.id]: answers[q.id] === o ? "" : o })}>
                        {o}
                      </button>
                    ))}
                    <button className={`chip${answers[q.id] === FREE ? " on" : ""}`} onClick={() => setAnswers({ ...answers, [q.id]: FREE })}>
                      其他…
                    </button>
                  </div>
                  {answers[q.id] === FREE && (
                    <input type="text" placeholder="自己写" value={freeText[q.id] ?? ""} onChange={(e) => setFreeText({ ...freeText, [q.id]: e.target.value })} />
                  )}
                </div>
              ))}
            </>
          )}

          <div className="goal-pick">
            <label>
              关联目标
              <select value={goalId ?? ""} onChange={(e) => setGoalId(e.target.value || null)}>
                <option value="">（无）</option>
                {activeGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.is_primary ? "★ " : ""}
                    {g.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="actions">
            <button className={hasScore ? "" : "primary"} disabled={!!busy || !canSubmitAlloc || !!rangeError} onClick={reviewAndScore}>
              {hasScore ? "按当前事实重新评分" : "确认事实并让 AI 评分"}
            </button>
            {!hasScore && !manual && (
              <button disabled={!!busy} onClick={() => setManual(true)}>
                手动评分
              </button>
            )}
          </div>

          {(hasScore || manual) && (
            <ScoreCard
              key={entry.score?.id ?? "manual"}
              score={entry.score}
              history={entry.score_history}
              kind={kind}
              rules={meta.rules}
              confirmed={entry.status === "confirmed"}
              busy={!!busy || !canSubmitAlloc}
              onConfirm={confirm}
            />
          )}
        </>
      )}
    </div>
  );
}

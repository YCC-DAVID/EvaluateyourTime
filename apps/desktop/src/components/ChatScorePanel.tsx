import { useEffect, useState } from "react";
import { dominantKind, durationMinutes, type ScoreDims } from "../../../../modules/scoring/index.ts";
import { AllocationEditor, type AllocDraft } from "./AllocationEditor.tsx";
import { selectedOptions, toggleOption } from "../answers.ts";
import { api, type Entry, type Meta, type Question } from "../api.ts";
import { FeedbackPanel, type FeedbackPayload } from "./FeedbackPanel.tsx";
import { ScoreCard } from "./ScoreCard.tsx";
import { tr } from "../i18n.ts";

// 对话里嵌入的评分分析：和记录页同一张评分卡（总分、三个维度、理由、不确定项补充、建议、目标进度、确认）。
// autoScore：记录刚被应用、还没有评分时，先做“质量引导”——问 0-3 个事实问题（推进程度、专注程度等），
// 点选回答后再评分；不需要问时直接评分。
// 记录还没有时间分配时，引导问题优先用来确定分配：点选回答 → AI 换算成分钟（估计）→ 微调后“确认分配并评分”。

export function ChatScorePanel(props: {
  entryId: string;
  meta: Meta;
  autoScore: boolean;
  /** 记录在这个时间被修改过（时间、内容、分配或目标变了）：这之前的评分不再适用，重新走分配 / 提问 / 评分 */
  redoSince?: string;
  onChanged: () => void;
  onConfirmed: (e: Entry) => void;
}) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 质量引导
  const [guide, setGuide] = useState<Question[] | null>(null);
  const [guideNote, setGuideNote] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, boolean>>({});
  // 补分配
  const [allocating, setAllocating] = useState(false);
  const [allocs, setAllocs] = useState<AllocDraft[]>([]);
  const [allocNote, setAllocNote] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<Entry>) {
    setBusy(label);
    setError(null);
    try {
      const e = await fn();
      setEntry(e);
      props.onChanged();
      return e;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let alive = true;
    api
      .getEntry(props.entryId)
      .then((e) => {
        if (!alive) return;
        setEntry(e);
        const outdated = !!e.score && !!props.redoSince && Date.parse(e.score.created_at) < Date.parse(props.redoSince);
        if ((!e.score || outdated) && props.autoScore) startGuide(e);
      })
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entryId]);

  async function startGuide(e: Entry) {
    setBusy(tr("看看需不需要先问几句…"));
    try {
      const g = await api.guide(e.id);
      setBusy(null);
      if (g.skip || !g.questions.length) {
        setGuideNote(g.reason);
        // 没有分配又没问出问题时，退回手动分配
        if (e.allocations.length === 0) setAllocating(true);
        else run(tr("AI 正在评分…"), () => api.score(e.id));
      } else {
        setGuide(g.questions);
        setGuideNote(g.reason);
      }
    } catch {
      setBusy(null);
      if (e.allocations.length === 0) setAllocating(true);
      else run(tr("AI 正在评分…"), () => api.score(e.id));
    }
  }

  /** 提交引导问题的回答，然后评分；选项正好是某个目标名称时顺便关联该目标 */
  async function submitGuide(skipAll = false) {
    if (!entry || !guide) return;
    const list = skipAll ? [] : guide.map((q) => ({ id: q.id, answer: (answers[q.id] ?? "").trim() })).filter((a) => a.answer);
    const goalHit = props.meta.goals.find((g) => g.status === "active" && list.some((a) => a.answer === g.title));
    // 还没有分配：用回答换算出分配，给用户看一眼再确认
    if (entry.allocations.length === 0) {
      if (skipAll) {
        setGuide(null);
        return saveAllocs([]);
      }
      setBusy(tr("AI 正在按你的回答换算分配…"));
      setError(null);
      try {
        const r = await api.allocateFromAnswers(entry.id, list);
        setAllocs(r.allocations.map((a) => ({ category_id: a.category_id, minutes: a.minutes, note: a.note, state: "estimated" as const })));
        setAllocNote(r.note || null);
        if (goalHit) await api.updateEntry(entry.id, { goal_id: goalHit.id });
        setGuide(null);
        setAllocating(true);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }
    await run(tr("AI 正在评分…"), async () => {
      await api.review(entry.id, {
        allocations: entry.allocations.map((a) => ({ category_id: a.category_id, minutes: a.minutes, note: a.note })),
        answers: list,
        goal_id: goalHit?.id ?? entry.goal_id,
      });
      return api.score(entry.id);
    });
    setGuide(null);
  }

  /** 让 AI 按描述估一个比例（估计值，用户可以再改） */
  async function estimate() {
    if (!entry) return;
    setBusy(tr("AI 正在按描述估算比例…"));
    setError(null);
    try {
      const r = await api.analyze(entry.id);
      setAllocs(r.entry.allocations.map((a) => ({ category_id: a.category_id, minutes: a.minutes, note: a.note, state: "estimated" as const })));
      if (r.entry.allocations.length === 0) setError(tr("描述里看不出比例，可以手动填，或者整段留作不确定"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 保存分配（可以为空 = 整段不确定），然后进入质量提问 / 评分 */
  async function saveAllocs(list: AllocDraft[]) {
    if (!entry) return;
    const e = await run(tr("正在保存分配…"), () =>
      api.review(entry.id, {
        allocations: list.filter((a) => a.minutes > 0).map((a) => ({ category_id: a.category_id, minutes: a.minutes, note: a.note })),
        answers: [],
        // 不传 goal_id：保留服务器上的值（回答里选的目标已经单独关联过）
      }),
    );
    if (!e) return;
    setAllocating(false);
    // 已经通过回答确定了分配：直接评分；否则（手动填的）再走一次质量提问
    if (e.questions.some((q) => q.source === "ai" && q.answer)) run(tr("AI 正在评分…"), () => api.score(e.id));
    else startGuide(e);
  }

  if (!entry) return error ? <div className="error-text small">{error}</div> : <div className="muted small">{tr("加载中…")}</div>;
  const total = durationMinutes(entry.start_utc, entry.end_utc);
  const allocSum = allocs.reduce((a, x) => a + x.minutes, 0);

  const goal = props.meta.goals.find((g) => g.id === entry.goal_id) ?? null;
  // 修改后还没重新评分：旧评分先不显示，免得看起来像新的
  const outdated = !!entry.score && !!props.redoSince && Date.parse(entry.score.created_at) < Date.parse(props.redoSince);
  const score = outdated ? null : entry.score;
  const goalChoices = props.meta.goals.filter((g) => g.status === "active");

  /** 没关联目标时可以在这里关联：关联后重新评分，评分会给出这个目标的进度建议 */
  async function linkGoal(goalId: string) {
    if (!entry || !goalId) return;
    await run(tr("已关联目标，AI 正在重新评分…"), async () => {
      await api.updateEntry(entry.id, { goal_id: goalId });
      return api.score(entry.id);
    });
  }

  return (
    <div className="chat-score">
      {busy && <div className="banner info">{busy}</div>}
      {error && (
        <div className="banner error">
          {error}
          <button className="link small" onClick={() => run(tr("AI 正在评分…"), () => api.score(entry.id))}>
            {tr("重试评分")}
          </button>
        </div>
      )}
      {allocating && !score && (
        <div className="guide">
          <div className="guide-head small">
            {allocNote !== null || allocs.length
              ? tr("按你的回答估的分配（可以微调，说不清的部分留作“不确定”，不扣分）{0}", [allocNote ? tr("：{0}", [allocNote]) : ""])
              : tr("这 {0} 小时怎么分配？说不清的可以留空（算“不确定”，不扣分）", [Math.round((total / 60) * 10) / 10])}
          </div>
          <AllocationEditor total={total} categories={props.meta.categories} value={allocs} onChange={setAllocs} />
          <div className="actions">
            <button disabled={!!busy} onClick={estimate}>
              {tr("让 AI 按描述估一下")}
            </button>
            <button className="primary" disabled={!!busy || allocs.length === 0 || allocSum > total} onClick={() => saveAllocs(allocs)}>
              {tr("确认分配并评分")}
            </button>
            <button disabled={!!busy} onClick={() => saveAllocs([])}>
              {tr("记不清，直接继续")}
            </button>
          </div>
        </div>
      )}
      {guide && !score && (
        <div className="guide">
          <div className="guide-head small">{tr("评分前先确认几件事（可多选）")}{guideNote ? tr("：{0}", [guideNote]) : ""}</div>
          {guide.map((q) => (
            <div key={q.id} className="question">
              <div className="q-text">{q.question}</div>
              <div className="chips">
                {q.options.map((o) => (
                  <button
                    key={o}
                    className={`chip${!other[q.id] && (selectedOptions(answers[q.id], q.options) ?? []).includes(o) ? " on" : ""}`}
                    onClick={() => {
                      setOther({ ...other, [q.id]: false });
                      setAnswers({ ...answers, [q.id]: toggleOption(other[q.id] ? "" : answers[q.id], o, q.options) });
                    }}
                  >
                    {o}
                  </button>
                ))}
                <button
                  className={`chip${other[q.id] ? " on" : ""}`}
                  onClick={() => {
                    setOther({ ...other, [q.id]: true });
                    setAnswers({ ...answers, [q.id]: "" });
                  }}
                >
                  {tr("其他…")}
                </button>
              </div>
              {other[q.id] && (
                <input type="text" autoFocus placeholder={tr("自己写")} value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
              )}
            </div>
          ))}
          <div className="actions">
            <button className="primary" disabled={!!busy || !guide.some((q) => (answers[q.id] ?? "").trim())} onClick={() => submitGuide()}>
              {tr("提交并评分")}
            </button>
            <button disabled={!!busy} onClick={() => submitGuide(true)}>
              {tr("跳过，直接评分")}
            </button>
          </div>
        </div>
      )}
      {!guide && guideNote && score && <div className="muted small">{guideNote}</div>}
      {outdated && !guide && !allocating && !busy && <div className="muted small">{tr("记录改过了，正在按新的内容重新评分。")}</div>}
      {!score && !guide && !allocating && !busy && !error && (
        <button className="primary" onClick={() => run(tr("AI 正在评分…"), () => api.score(entry.id))}>
          {tr("评分")}
        </button>
      )}
      {score && !entry.goal_id && goalChoices.length > 0 && (
        <label className="link-goal small">
          {tr("这段没有关联目标，关联后会给出目标进度建议：")}
          <select value="" disabled={!!busy} onChange={(e) => linkGoal(e.target.value)}>
            <option value="">{tr("选择目标…")}</option>
            {goalChoices.map((g) => (
              <option key={g.id} value={g.id}>
                {g.level === "task" ? tr("　") : ""}
                {g.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {score && (
        <ScoreCard
          key={`${score.id}-${entry.status}`}
          score={score}
          history={entry.score_history}
          kind={dominantKind(entry.allocations, props.meta.categories)}
          rules={props.meta.rules}
          confirmed={entry.status === "confirmed"}
          busy={!!busy}
          goal={goal}
          feedback={
            <FeedbackPanel
              key={`${score.id}-${entry.version}`}
              uncertainties={score.uncertainties ?? []}
              saved={entry.questions.filter((q) => q.source === "uncertainty")}
              reflection={entry.reflection}
              improvement={entry.improvement}
              busy={!!busy}
              canRescore
              onSave={(p: FeedbackPayload, rescore: boolean) =>
                run(rescore ? tr("AI 正在按补充重新评分…") : tr("正在保存…"), async () => {
                  const e = await api.feedback(entry.id, p);
                  return rescore ? api.score(e.id) : e;
                })
              }
            />
          }
          onConfirm={async (p: { dims?: ScoreDims; change_kind?: string; change_note?: string; goal_progress?: number | null; goal_progress_reason?: string }) => {
            const e = await run(tr("正在保存…"), () => api.confirm(entry.id, p));
            if (e) props.onConfirmed(e);
          }}
        />
      )}
    </div>
  );
}

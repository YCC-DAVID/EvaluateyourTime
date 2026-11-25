import { useEffect, useMemo, useRef, useState } from "react";
import { backfillWindowStart, checkRecordWindow, dominantKind, durationMinutes, BACKFILL_DAYS, type ScoreDims } from "../../../../modules/scoring/index.ts";
import { api, ApiError, fmtMinutes, fromLocalInput, hm, toLocalInput, TZ, type DeviceSummary, type Entry, type Meta, type Question } from "../api.ts";
import { AllocationEditor, type AllocDraft } from "./AllocationEditor.tsx";
import { ScoreCard } from "./ScoreCard.tsx";
import { VoiceButton } from "./VoiceButton.tsx";
import { ActivitySuggestions } from "./ActivitySuggestions.tsx";
import { DeviceRef, deviceTopItems } from "./DeviceRef.tsx";
import { selectedOptions, toggleOption } from "../answers.ts";
import { FeedbackPanel, type FeedbackPayload } from "./FeedbackPanel.tsx";
import { STATUS_LABEL } from "./Timeline.tsx";
import { tr } from "../i18n.ts";

export type RecordTarget =
  | { kind: "new"; start?: Date; end?: Date; fromDevice?: boolean; prefillText?: string; goalId?: string | null }
  | { kind: "edit"; id: string };

const FREE = "__free__";

// 快速记录：结束时间总是“现在”，只选开始方式
type Preset = "since_last" | "30" | "60" | "custom";
const MIN = 60000;
const floorMin = (ms: number) => Math.floor(ms / MIN) * MIN;

function quickRange(preset: Preset, atMs: number, lastEnd: number | null, customStart: string): { start: Date; end: Date } | null {
  const end = floorMin(atMs);
  let s: number | null = null;
  if (preset === "since_last") s = lastEnd == null ? null : floorMin(lastEnd);
  else if (preset === "30" || preset === "60") s = end - Number(preset) * MIN;
  else if (/^\d{2}:\d{2}$/.test(customStart)) {
    const [h, m] = customStart.split(":").map(Number);
    const d = new Date(end);
    d.setHours(h, m, 0, 0);
    s = d.getTime();
    if (s >= end) s -= 24 * 3600_000; // 比现在晚，说明是昨天（跨午夜）
  }
  return s == null ? null : { start: new Date(s), end: new Date(end) };
}

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

  const isNew = target.kind === "new";
  // 从时间轴空档或热力图点进来的新记录直接进入补录模式
  const [backfill, setBackfill] = useState(target.kind === "new" && !!target.start);
  const [preset, setPreset] = useState<Preset>("60");
  const [customStart, setCustomStart] = useState("");
  const [lastEnd, setLastEnd] = useState<number | null>(null);
  // 这段时间的电脑使用摘要（有数据才显示“按电脑记录生成”）
  const [devSum, setDevSum] = useState<DeviceSummary | null>(null);
  const hasDevice = !!devSum && devSum.coveredMinutes > 0;
  // 新记录时从备选项里选中的目标
  const [linkedGoalId, setLinkedGoalId] = useState<string | null>(null);
  /** 追加一段文字到描述末尾，自动补逗号 */
  const appendText = (t: string) => setText((prev) => (prev.trim() ? `${prev}${/[，。！？、,.!?\s]$/.test(prev) ? "" : tr("，")}${t}` : t));
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);

  /** 把服务器上这条记录的最新状态填进表单（打开时，以及每次分析、评分、保存之后） */
  function applyEntry(e: Entry) {
    setStartStr(toLocalInput(new Date(e.start_utc)));
    setEndStr(toLocalInput(new Date(e.end_utc)));
    setText(e.raw_text);
    setAllocs(e.allocations.map((a) => ({ category_id: a.category_id, minutes: a.minutes, note: a.note, state: a.state })));
    const ans: Record<string, string> = {};
    const free: Record<string, string> = {};
    for (const q of e.questions) {
      if (!q.answer) continue;
      if (selectedOptions(q.answer, q.options)) ans[q.id] = q.answer;
      else {
        ans[q.id] = FREE;
        free[q.id] = q.answer;
      }
    }
    setAnswers(ans);
    setFreeText(free);
    setGoalId(e.goal_id);
  }

  /** 操作完成后：用服务器返回的记录刷新表单，再通知外面刷新列表 */
  function synced(e: Entry) {
    applyEntry(e);
    setFetched(e);
    setManual(false);
    props.onChanged(e);
  }

  // 初始化表单
  useEffect(() => {
    if (initialized) return;
    if (target.kind === "new") {
      const now = Date.now();
      if (target.prefillText) setText(target.prefillText);
      if (target.goalId) setLinkedGoalId(target.goalId);
      if (target.start) {
        // 补录：裁到允许范围内（最近 3 天、不超过现在）
        const s = Math.max(target.start.getTime(), backfillWindowStart(now));
        const e = Math.min((target.end ?? new Date(now)).getTime(), floorMin(now));
        setStartStr(toLocalInput(new Date(s)));
        setEndStr(toLocalInput(new Date(Math.max(e, s + MIN))));
        setInitialized(true);
      } else {
        // 默认：距上次记录不超过 3 小时就“从上次记录起”，否则“最近 1 小时”
        api.lastEnd().then(({ end: last }) => {
          const l = last ? Date.parse(last) : null;
          setLastEnd(l);
          const gap = l != null ? floorMin(now) - l : Infinity;
          setPreset(gap >= MIN && gap <= 3 * 3600_000 ? "since_last" : "60");
          setInitialized(true);
        });
      }
    } else if (entry) {
      applyEntry(entry);
      setInitialized(true);
    }
  }, [target, entry, initialized]);

  const quick = isNew && !backfill;
  const windowStart = backfillWindowStart(nowMs);
  const sinceLastOk = lastEnd != null && floorMin(nowMs) - lastEnd >= MIN && floorMin(nowMs) - lastEnd <= 12 * 3600_000;
  const range = quick
    ? quickRange(preset, nowMs, lastEnd, customStart)
    : startStr && endStr
      ? { start: fromLocalInput(startStr), end: fromLocalInput(endStr) }
      : null;
  const start = range?.start ?? null;
  const end = range?.end ?? null;
  const total = start && end ? durationMinutes(start.toISOString(), end.toISOString()) : 0;
  // 输入框只精确到分钟，比较时也按分钟，避免秒数差异被误认为改动
  const timeChanged =
    !!entry &&
    !!start &&
    !!end &&
    (floorMin(start.getTime()) !== floorMin(Date.parse(entry.start_utc)) || floorMin(end.getTime()) !== floorMin(Date.parse(entry.end_utc)));
  /** 只在时间真的改了时才提交时间 */
  const timePatch = () => (timeChanged ? { start: start!.toISOString(), end: end!.toISOString() } : {});
  const rangeError = start && end && (isNew || timeChanged) ? checkRecordWindow(start.getTime(), end.getTime(), nowMs) : null;
  // 超过补录窗口的旧记录：可以改文字和评分，不能改时间
  const timeLocked = !!entry && Date.parse(entry.start_utc) < windowStart;
  const overlapMin = quick && start && lastEnd != null && start.getTime() < lastEnd ? Math.round((lastEnd - start.getTime()) / MIN) : 0;

  const enterBackfill = () => {
    // 补录通常是快速记录之前的时间：默认取它前面的 1 小时
    const e = start ? start.getTime() : floorMin(nowMs);
    setStartStr(toLocalInput(new Date(Math.max(e - 3600_000, windowStart))));
    setEndStr(toLocalInput(new Date(e)));
    setBackfill(true);
  };

  const metaDirty = !!entry && (text !== entry.raw_text || timeChanged);

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
      if (e instanceof ApiError && e.body?.entry) synced(e.body.entry);
    } finally {
      setBusy(null);
    }
  }

  /** 选择问题的答案；按电脑记录起草的问题会把这块时间直接写进分配 */
  function pickAnswer(q: Question, option: string) {
    const value = toggleOption(answers[q.id] === FREE ? "" : answers[q.id], option, q.options);
    setAnswers({ ...answers, [q.id]: value });
    if (q.meta?.kind !== "device") return;
    // 多选时把这块时间平均分给选中的几类（同一类合并），之后还能在分配里微调
    const chosen = (selectedOptions(value, q.options) ?? [])
      .map((o) => ({ label: o, cat: q.meta!.cats[q.options.indexOf(o)] }))
      .filter((x): x is { label: string; cat: string } => !!x.cat);
    const byCat = new Map<string, string[]>();
    for (const c of chosen) byCat.set(c.cat, [...(byCat.get(c.cat) ?? []), c.label]);
    const n = byCat.size;
    const base = n ? Math.floor(q.meta.minutes / n) : 0;
    let extra = n ? q.meta.minutes - base * n : 0;
    const rows: AllocDraft[] = [...byCat.entries()].map(([cat, labels]) => {
      const minutes = base + (extra-- > 0 ? 1 : 0);
      return { category_id: cat, minutes, note: labels.join(tr("、")), state: "confirmed", qid: q.id };
    });
    setAllocs((prev) => [...prev.filter((a) => a.qid !== q.id), ...rows]);
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
    act(analyze ? tr("正在保存并分析…") : tr("正在保存…"), async () => {
      // 快速记录在点击的这一刻重新取“现在”作为结束时间
      const r = quick ? quickRange(preset, Date.now(), lastEnd, customStart) : range;
      if (!r) throw new Error(tr("请选择开始时间"));
      const e = await api.createEntry({ start: r.start.toISOString(), end: r.end.toISOString(), tz: TZ, text, goal_id: linkedGoalId });
      if (!analyze || !text.trim()) return synced(e);
      try {
        const r = await api.analyze(e.id);
        synced(r.entry);
      } catch (err) {
        // 原始记录已保存，分析失败不影响
        synced(err instanceof ApiError && err.body?.entry ? err.body.entry : e);
      }
    });

  /** 按电脑记录起草：新记录先建好，再让 AI 按电脑数据填描述、分配和问题 */
  const draftFromDevice = () =>
    act(tr("正在按电脑记录起草…"), async () => {
      let id = entry?.id;
      if (!id) {
        const r = quick ? quickRange(preset, Date.now(), lastEnd, customStart) : range;
        if (!r) throw new Error(tr("请选择时间段"));
        const e = await api.createEntry({ start: r.start.toISOString(), end: r.end.toISOString(), tz: TZ, text, goal_id: linkedGoalId });
        id = e.id;
      } else if (metaDirty) await api.updateEntry(id, { ...timePatch(), text });
      try {
        synced(await api.deviceDraft(id));
      } catch (err) {
        // 记录已经建好，起草失败不影响
        synced(await api.getEntry(id));
        throw err;
      }
    });

  // 从时间轴空档“按电脑记录补录”进来：自动起草一次
  const autoDrafted = useRef(false);
  useEffect(() => {
    if (target.kind === "new" && target.fromDevice && initialized && start && end && !autoDrafted.current) {
      autoDrafted.current = true;
      draftFromDevice();
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMeta = () =>
    act(tr("正在保存…"), async () => {
      const e = await api.updateEntry(entry!.id, { ...timePatch(), text });
      synced(e);
    });

  const analyze = () =>
    act(tr("AI 正在整理…"), async () => {
      if (metaDirty) await api.updateEntry(entry!.id, { ...timePatch(), text });
      const r = await api.analyze(entry!.id);
      synced(r.entry);
    });

  const reviewAndScore = () =>
    act(tr("AI 正在评分…"), async () => {
      if (metaDirty) await api.updateEntry(entry!.id, { ...timePatch(), text });
      await saveReview(entry!.id);
      const e = await api.score(entry!.id);
      synced(e);
    });

  const confirm = (p: { dims?: ScoreDims; change_kind?: string; change_note?: string; goal_progress?: number | null; goal_progress_reason?: string }) =>
    act(tr("正在保存…"), async () => {
      if (metaDirty) await api.updateEntry(entry!.id, { ...timePatch(), text });
      await saveReview(entry!.id);
      const e = await api.confirm(entry!.id, p);
      synced(e);
    });

  // 保存对不确定项的补充和自我反馈；可选按补充重新评分
  const saveFeedback = (p: FeedbackPayload, rescore: boolean) =>
    act(rescore ? tr("AI 正在按补充重新评分…") : tr("正在保存反馈…"), async () => {
      let e = await api.feedback(entry!.id, p);
      if (rescore) e = await api.score(entry!.id);
      synced(e);
    });

  const remove = () => {
    if (!entry || !window.confirm(tr("删除这条记录？"))) return;
    act(tr("正在删除…"), async () => {
      await api.deleteEntry(entry.id);
      props.onChanged(null);
    });
  };

  // ---------- 渲染 ----------

  if (target.kind === "edit" && !entry) return <div className="card">{tr("加载中…")}</div>;

  const showReview = !!entry && (entry.status === "needs_confirmation" || entry.status === "confirmed" || manual || entry.allocations.length > 0);
  const hasScore = !!entry?.score;
  const canSubmitAlloc = allocSum <= total;

  return (
    <div className="card record">
      <div className="card-head">
        <h3>{entry ? entry.title || tr("编辑记录") : tr("记录一段时间")}</h3>
        {entry && <span className={`badge st-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>}
        {entry && (
          <button className="link" onClick={props.onNew}>
            {tr("+ 新记录")}
          </button>
        )}
      </div>

      {quick ? (
        <div className="quick-range">
          <div className="chips">
            {sinceLastOk && (
              <button className={`chip${preset === "since_last" ? " on" : ""}`} onClick={() => setPreset("since_last")}>
                {tr("从上次记录起（")}{hm(lastEnd!)}{tr("）")}
              </button>
            )}
            <button className={`chip${preset === "30" ? " on" : ""}`} onClick={() => setPreset("30")}>
              {tr("最近 30 分钟")}
            </button>
            <button className={`chip${preset === "60" ? " on" : ""}`} onClick={() => setPreset("60")}>
              {tr("最近 1 小时")}
            </button>
            <button
              className={`chip${preset === "custom" ? " on" : ""}`}
              onClick={() => {
                if (!customStart && start) setCustomStart(hm(start));
                setPreset("custom");
              }}
            >
              {tr("自定义开始")}
            </button>
          </div>
          <div className="range-summary">
            {preset === "custom" ? (
              <label className="inline">
                {tr("从")} <input type="time" value={customStart} onChange={(e) => setCustomStart(e.target.value)} /> {tr("到现在")}
              </label>
            ) : start ? (
              <span>
                {hm(start)} {tr("– 现在")}
              </span>
            ) : null}
            {total > 0 && <span className="muted">{fmtMinutes(total)}</span>}
            <span className="spacer" />
            <button className="link" onClick={enterBackfill}>
              {tr("补录更早的时间…")}
            </button>
          </div>
          {overlapMin > 0 && (
            <div className="warn-text">
              {tr("与上一条记录重叠")} {fmtMinutes(overlapMin)}
              <button className="link" onClick={() => setPreset("since_last")}>
                {tr("改为从上次结束开始")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="range">
            <label>
              {tr("开始")}
              <input
                type="datetime-local"
                value={startStr}
                min={toLocalInput(new Date(windowStart))}
                max={toLocalInput(new Date(nowMs))}
                disabled={timeLocked}
                onChange={(e) => setStartStr(e.target.value)}
              />
            </label>
            <label>
              {tr("结束")}
              <input
                type="datetime-local"
                value={endStr}
                min={toLocalInput(new Date(windowStart))}
                max={toLocalInput(new Date(nowMs))}
                disabled={timeLocked}
                onChange={(e) => setEndStr(e.target.value)}
              />
            </label>
            <span className="muted">{total > 0 ? fmtMinutes(total) : ""}</span>
            {isNew && (
              <button className="link" onClick={() => setBackfill(false)}>
                {tr("返回快速记录")}
              </button>
            )}
          </div>
          {isNew && <div className="hint">{tr("补录：只能选最近")} {BACKFILL_DAYS} {tr("天（今天、昨天、前天）。")}</div>}
          {timeLocked && <div className="hint">{tr("超过")} {BACKFILL_DAYS} {tr("天的记录不能再改时间，文字和评分仍可修改。")}</div>}
        </>
      )}
      {rangeError && <div className="error-text">{rangeError}</div>}
      {!rangeError && start && end && <DeviceRef start={start.toISOString()} end={end.toISOString()} onSummary={setDevSum} />}

      {isNew && (
        <ActivitySuggestions
          goals={meta.goals}
          categories={meta.categories}
          activities={meta.profile.activities}
          deviceChip={
            hasDevice && !rangeError && start
              ? {
                  label: tr("💻 按电脑记录：{0}", [deviceTopItems(devSum!)
                    .slice(0, 3)
                    .map((x) => `${x.label} ${x.minutes}`)
                    .join(" · ")]),
                  disabled: !!busy,
                  onClick: draftFromDevice,
                }
              : null
          }
          linkedGoalId={linkedGoalId}
          onPickText={appendText}
          onPickGoal={(g) => {
            if (linkedGoalId === g.id) return setLinkedGoalId(null); // 再点一次取消关联，文字保留
            setLinkedGoalId(g.id);
            if (!text.includes(g.title)) appendText(g.title);
          }}
        />
      )}

      <div className="textarea-wrap">
        <textarea
          rows={4}
          autoFocus={isNew}
          placeholder={tr("这段时间做了什么、推进了什么？例如：看论文，主要想理解方法，整理了一点笔记，中间刷了会儿手机。{0}", [isNew ? tr("\n⌘ + Enter 保存并分析") : ""])}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isNew && (e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim() && !busy && !rangeError && start) {
              e.preventDefault();
              createAndMaybeAnalyze(true);
            }
          }}
        />
        <div className="textarea-tools">
          <VoiceButton serverAsr={meta.asr.server} onText={appendText} />
        </div>
      </div>

      {!entry && (
        <div className="actions">
          <button className="primary" disabled={!!busy || !!rangeError || !start || !text.trim()} onClick={() => createAndMaybeAnalyze(true)}>
            {tr("保存并分析")}
          </button>
          <button disabled={!!busy || !!rangeError || !start} onClick={() => createAndMaybeAnalyze(false)}>
            {tr("仅保存")}
          </button>

        </div>
      )}

      {entry && (
        <div className="actions">
          {metaDirty && (
            <button disabled={!!busy || !!rangeError} onClick={saveMeta}>
              {tr("保存修改")}
            </button>
          )}
          <button disabled={!!busy || !!rangeError || !text.trim()} onClick={analyze}>
            {entry.status === "draft" || entry.status === "analysis_failed" ? tr("AI 分析") : tr("重新分析")}
          </button>
          {hasDevice && entry.status !== "confirmed" && (
            <button disabled={!!busy || !!rangeError} onClick={draftFromDevice} title={tr("按这段时间的电脑使用重新起草时间分配")}>
              {tr("按电脑记录起草")}
            </button>
          )}
          {!showReview && (
            <button
              disabled={!!busy}
              onClick={() => {
                setManual(true);
                if (allocs.length === 0) setAllocs([{ category_id: "cat_work", minutes: total, note: null, state: "confirmed" }]);
              }}
            >
              {tr("不用 AI，手动填写")}
            </button>
          )}
          <span className="spacer" />
          <button className="link danger" disabled={!!busy} onClick={remove}>
            {tr("删除")}
          </button>
        </div>
      )}

      {busy && <div className="banner info">{busy}</div>}
      {error && <div className="banner error">{error}</div>}
      {entry?.analysis_error && !error && entry.status !== "confirmed" && (
        <div className="banner error">{tr("上次 AI 调用失败：")}{entry.analysis_error}{tr("（原始记录已保存，可以重试或手动填写）")}</div>
      )}

      {entry && showReview && (
        <>
          <h4>{tr("时间分配")}</h4>
          <AllocationEditor total={total} categories={meta.categories} value={allocs} onChange={setAllocs} />

          {entry.questions.some((q) => q.source !== "uncertainty") && (
            <>
              <h4>{tr("补充几个事实")}</h4>
              {entry.questions.filter((q) => q.source !== "uncertainty").map((q) => (
                <div className="question" key={q.id}>
                  <div className="q-text">
                    {q.question}
                    {q.meta?.kind === "device" && <span className="muted small">{tr("（")}{fmtMinutes(q.meta.minutes)}{tr("，可多选，选完自动计入分配）")}</span>}
                    {q.meta?.kind !== "device" && <span className="muted small">{tr("（可多选）")}</span>}
                  </div>
                  <div className="chips">
                    {q.options.map((o) => (
                      <button
                        key={o}
                        className={`chip${answers[q.id] !== FREE && (selectedOptions(answers[q.id], q.options) ?? []).includes(o) ? " on" : ""}`}
                        onClick={() => pickAnswer(q, o)}
                      >
                        {o}
                      </button>
                    ))}
                    <button
                      className={`chip${answers[q.id] === FREE ? " on" : ""}`}
                      onClick={() => {
                        setAnswers({ ...answers, [q.id]: FREE });
                        setAllocs((prev) => prev.filter((a) => a.qid !== q.id));
                      }}
                    >
                      {tr("其他…")}
                    </button>
                  </div>
                  {answers[q.id] === FREE && (
                    <input type="text" placeholder={tr("自己写")} value={freeText[q.id] ?? ""} onChange={(e) => setFreeText({ ...freeText, [q.id]: e.target.value })} />
                  )}
                </div>
              ))}
            </>
          )}

          <div className="goal-pick">
            <label>
              {tr("关联目标")}
              <select value={goalId ?? ""} onChange={(e) => setGoalId(e.target.value || null)}>
                <option value="">{tr("（无）")}</option>
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
              {hasScore ? tr("按当前事实重新评分") : tr("确认事实并让 AI 评分")}
            </button>
            {!hasScore && !manual && (
              <button disabled={!!busy} onClick={() => setManual(true)}>
                {tr("手动评分")}
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
              goal={meta.goals.find((g) => g.id === (goalId ?? entry.goal_id)) ?? null}
              feedback={
                <FeedbackPanel
                  key={`${entry.score?.id ?? "manual"}-${entry.version}`}
                  uncertainties={entry.score?.uncertainties ?? []}
                  saved={entry.questions.filter((q) => q.source === "uncertainty")}
                  reflection={entry.reflection}
                  improvement={entry.improvement}
                  busy={!!busy}
                  canRescore={!!entry.score}
                  onSave={saveFeedback}
                />
              }
              busy={!!busy || !canSubmitAlloc}
              onConfirm={confirm}
            />
          )}
        </>
      )}
    </div>
  );
}

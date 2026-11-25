import { useState } from "react";
import { api, fmtMinutes, type Goal, type Meta } from "../api.ts";
import { ProgressSlider } from "./ProgressSlider.tsx";
import { LEVEL_COLOR } from "./ActivitySuggestions.tsx";
import { GoalDetail, type GoalEntry } from "./GoalDetail.tsx";
import { GoalSplitPanel } from "./GoalSplitPanel.tsx";
import { locale, tr } from "../i18n.ts";

const LEVEL_LABEL = { long: tr("长期（2–3 个月）"), short: tr("短期（1–2 周）"), task: tr("具体任务") } as const;
const STATUS_LABEL = { active: tr("进行中"), paused: tr("暂停"), done: tr("完成"), dropped: tr("放弃") } as const;
const PRIORITY_LABEL = { 1: tr("高"), 2: tr("中"), 3: tr("低") } as const;
// 进度记录只显示“推进了什么”；来自评分的标一下来源
const SOURCE_TAG = { ai: tr("评分·AI"), user: tr("评分"), manual: null, rollup: tr("子目标") } as const;
// 加子目标时默认低一层
const CHILD_LEVEL = { long: "short", short: "task", task: "task" } as const;

const empty: Partial<Goal> = { level: "short", title: "", description: "", ddl: "", progress: 0, priority: 2, status: "active", is_primary: false, parent_id: null };

function daysLeft(ddl: string | null) {
  if (!ddl) return null;
  const [y, m, d] = ddl.split("-").map(Number);
  const t = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((t - today) / 86400_000);
}

export function GoalsView({ meta, onChanged, onOpenEntry }: { meta: Meta; onChanged: () => void; onOpenEntry: (e: GoalEntry) => void }) {
  // 展开查看关联记录和完成曲线的目标
  const [expanded, setExpanded] = useState<string | null>(null);
  // 正在拆分的目标
  const [splitting, setSplitting] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Goal> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 卡片上正在拖动的进度（松手后保存）
  const [dragging, setDragging] = useState<Record<string, number>>({});
  // 拖完之后等待填写“推进了什么”的目标
  const [pending, setPending] = useState<{ id: string; note: string; error?: string } | null>(null);
  const cancelPending = (id: string) => {
    setPending(null);
    setDragging(({ [id]: _drop, ...rest }) => rest);
  };
  async function saveProgress(g: Goal) {
    if (!pending) return;
    const note = pending.note.trim();
    if (!note) return setPending({ ...pending, error: tr("写一句这次推进了什么") });
    try {
      await api.updateGoal(g.id, { progress: dragging[g.id], progress_reason: note } as Partial<Goal>);
      setPending(null);
      setDragging(({ [g.id]: _done, ...rest }) => rest);
      onChanged();
    } catch (e) {
      setPending({ ...pending, error: (e as Error).message });
    }
  }

  /** 打开编辑表单并滚动到它（表单在页面顶部，从下面的卡片点进来时看不到） */
  function openForm(g: Partial<Goal>) {
    setEditing(g);
    requestAnimationFrame(() => document.querySelector(".goal-form")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  async function save() {
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) {
        // 编辑表单不改进度（进度在卡片上改并写明原因），所以不提交进度字段
        const { progress: _p, invested_minutes: _i, progress_events: _e, ...rest } = editing;
        await api.updateGoal(editing.id, rest);
      }
      else await api.createGoal(editing);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function quick(g: Goal, patch: Partial<Goal>) {
    await api.updateGoal(g.id, patch);
    onChanged();
  }

  const groups: Goal["level"][] = ["long", "short", "task"];
  const parents = meta.goals.filter((g) => g.level !== "task" && g.id !== editing?.id);

  return (
    <main className="page">
      <div className="page-head">
        <h2>{tr("目标")}</h2>
        <button className="primary" onClick={() => setEditing({ ...empty })}>
          {tr("+ 新目标")}
        </button>
      </div>
      <p className="muted">
        {tr("设一个“当前主要目标”（★），统计里的“重点目标投入”按它计算。进度可以是里程碑或你的判断，不必等于投入小时。")}
      </p>

      {editing && (
        <div className="card goal-form">
          <div className="form-grid">
            <label>
              {tr("名称")}
              <input value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus />
            </label>
            <label>
              {tr("层级")}
              <select value={editing.level} onChange={(e) => setEditing({ ...editing, level: e.target.value as Goal["level"] })}>
                {groups.map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("DDL（可选）")}
              <input type="date" value={editing.ddl ?? ""} onChange={(e) => setEditing({ ...editing, ddl: e.target.value || null })} />
            </label>
            <label>
              {tr("优先级")}
              <select value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}>
                {[1, 2, 3].map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p as 1 | 2 | 3]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("父目标")}
              <select value={editing.parent_id ?? ""} onChange={(e) => setEditing({ ...editing, parent_id: e.target.value || null })}>
                <option value="">{tr("（无）")}</option>
                {parents.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </label>
            {editing.parent_id && (() => {
              const used = meta.goals
                .filter((x) => x.parent_id === editing.parent_id && x.id !== editing.id)
                .reduce((s, x) => s + (x.weight ?? 0), 0);
              const w = editing.weight ?? null;
              return (
                <label>
                  {tr("占父目标的比例（%）")}
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    placeholder={tr("留空则取剩余的 {0}", [Math.max(0, 100 - used)])}
                    value={w ?? ""}
                    onChange={(e) => setEditing({ ...editing, weight: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                  <span className={`small${used + (w ?? Math.max(0, 100 - used)) > 100 ? " error-text" : ""}`}>
                    {tr("其他子目标已占")} {used}%{used + (w ?? 0) > 100 ? tr("，合计超过 100%") : ""}{tr("。这个子目标进度 +10% 时，父目标 +")}{((w ?? Math.max(0, 100 - used)) / 10).toFixed(1)}%
                  </span>
                </label>
              );
            })()}
            {editing.id ? (
              <label>
                {tr("进度")} {editing.progress ?? 0}%
                <span className="small">{tr("在目标卡片上拖动修改，并写明推进了什么")}</span>
              </label>
            ) : (
              <label>
                {tr("起始进度")} {editing.progress ?? 0}%
                <input type="range" min={0} max={100} step={5} value={editing.progress ?? 0} onChange={(e) => setEditing({ ...editing, progress: Number(e.target.value) })} />
              </label>
            )}
            <label className="wide">
              {tr("说明")}
              <textarea rows={2} value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={!!editing.is_primary} onChange={(e) => setEditing({ ...editing, is_primary: e.target.checked })} />
              {tr("设为当前主要目标")}
            </label>
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="actions">
            <button className="primary" onClick={save}>
              {tr("保存")}
            </button>
            <button onClick={() => setEditing(null)}>{tr("取消")}</button>
          </div>
        </div>
      )}

      {groups.map((level) => {
        const list = meta.goals.filter((g) => g.level === level);
        if (list.length === 0) return null;
        return (
          <section key={level}>
            <h3>{LEVEL_LABEL[level]}</h3>
            <div className="goal-list">
              {list.map((g) => {
                const dl = daysLeft(g.ddl);
                return (
                  <div key={g.id} className={`card goal lvl-${g.level}${g.status !== "active" ? " inactive" : ""}`}>
                    <div className="goal-top">
                      <button
                        className={`star${g.is_primary ? " on" : ""}`}
                        title={g.is_primary ? tr("当前主要目标") : tr("设为主要目标")}
                        onClick={() => quick(g, { is_primary: !g.is_primary })}
                      >
                        ★
                      </button>
                      <button
                        className="goal-title"
                        aria-expanded={expanded === g.id}
                        title={tr("查看关联的记录和完成曲线")}
                        onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                      >
                        <strong>{g.title}</strong>
                        <span className="caret">{expanded === g.id ? "▾" : "▸"}</span>
                      </button>
                      <span className="badge">{STATUS_LABEL[g.status]}</span>
                      <span className="badge">{tr("优先级")} {PRIORITY_LABEL[g.priority as 1 | 2 | 3]}</span>
                      {dl != null && (
                        <span className={`badge${dl < 0 ? " danger" : dl <= 3 ? " warn" : ""}`}>
                          {dl < 0 ? tr("已过 DDL {0} 天", [-dl]) : dl === 0 ? tr("今天截止") : tr("还剩 {0} 天", [dl])}
                        </span>
                      )}
                    </div>
                    {g.description && <p className="muted">{g.description}</p>}
                    {g.parent_id && (
                      <div className="parent-link small muted">
                        {tr("↳ 属于「")}{meta.goals.find((p) => p.id === g.parent_id)?.title ?? tr("已删除的目标")}{tr("」")}
                        {g.weight ? tr(" · 占 {0}%，进度会按比例计入", [g.weight]) : tr(" · 未设占比，不计入父目标")}
                      </div>
                    )}
                    {(() => {
                      const kids = meta.goals.filter((k) => k.parent_id === g.id);
                      const sumW = kids.reduce((s, k) => s + (k.weight ?? 0), 0);
                      const fromKids = Math.round(kids.reduce((s, k) => s + (k.progress * (k.weight ?? 0)) / 100, 0));
                      return (
                        <div className="children">
                          {kids.length > 0 && (
                            <>
                              <div className="children-head small">
                                <span>{tr("子目标（占比合计")} {sumW}%{sumW > 100 ? tr("，超过 100%") : ""}{tr("）")}</span>
                                <span className="muted">{tr("按子目标算：")}{fromKids}%</span>
                              </div>
                              <ul>
                                {kids.map((k) => (
                                  <li key={k.id} className={k.status !== "active" ? "inactive" : ""}>
                                    <span className={`lvl-dot lvl-${k.level}`} />
                                    <span className="child-title">{k.title}</span>
                                    <span className="mini-bar">
                                      <span style={{ width: `${k.progress}%`, background: LEVEL_COLOR[k.level] }} />
                                    </span>
                                    <span className="small">{k.progress}%</span>
                                    <span className="muted small">{tr("占")} {k.weight ?? 0}{tr("% → 贡献")} {Math.round((k.progress * (k.weight ?? 0)) / 10) / 10}%</span>
                                    <button className="link small" onClick={() => openForm({ ...k })}>
                                      {tr("编辑")}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                          <div className="actions">
                            <button
                              className="link small"
                              onClick={() => openForm({ ...empty, parent_id: g.id, level: CHILD_LEVEL[g.level], ddl: g.ddl, weight: null })}
                            >
                              {tr("+ 添加子目标")}
                            </button>
                            {g.level !== "task" && g.status === "active" && 100 - sumW > 0 && splitting !== g.id && (
                              <button className="link small" onClick={() => setSplitting(g.id)}>
                                {tr("拆分成子目标")}
                              </button>
                            )}
                          </div>
                          {splitting === g.id && (
                            <GoalSplitPanel
                              goal={g}
                              remaining={Math.max(0, 100 - sumW)}
                              onCancel={() => setSplitting(null)}
                              onDone={() => {
                                setSplitting(null);
                                onChanged();
                              }}
                            />
                          )}
                          <div className="actions">
                            {kids.some((k) => k.weight) && fromKids !== g.progress && (
                              <button
                                className="link small"
                                title={tr("把父目标进度设为 Σ 子目标进度 × 占比")}
                                onClick={async () => {
                                  await api.rollupGoal(g.id);
                                  onChanged();
                                }}
                              >
                                {tr("按子目标汇总为")} {fromKids}%
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    {expanded !== g.id && g.progress_events && g.progress_events.some((ev) => ev.reason?.trim()) && (
                      <ul className="progress-events">
                        {g.progress_events.filter((ev) => ev.reason?.trim()).slice(0, 3).map((ev, i) => (
                          <li key={i}>
                            <span className="pe-delta">
                              {ev.from_progress}% → {ev.to_progress}%
                            </span>
                            <span className="pe-reason">{ev.reason}</span>
                            <span className="muted pe-meta">
                              {SOURCE_TAG[ev.source] && <span className="tag">{SOURCE_TAG[ev.source]}</span>}
                              {new Date(ev.created_at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <ProgressSlider
                      value={dragging[g.id] ?? g.progress}
                      base={g.progress}
                      color={LEVEL_COLOR[g.level]}
                      disabled={g.status !== "active" || (!!pending && pending.id !== g.id)}
                      onChange={(v) => setDragging({ ...dragging, [g.id]: v })}
                      onCommit={(v) => {
                        // 松手后不直接保存：先问这次推进了什么
                        if (v === g.progress) return cancelPending(g.id);
                        if (pending?.id !== g.id) setPending({ id: g.id, note: "" });
                      }}
                    />
                    {pending?.id === g.id && dragging[g.id] !== undefined && (
                      <div className="progress-note">
                        <div className="small">
                          {g.progress}% → {dragging[g.id]}{tr("%：这次推进了什么？")}
                        </div>
                        <input
                          type="text"
                          autoFocus
                          placeholder={dragging[g.id] > g.progress ? tr("例如：跑完了模块 B 的消融，结果整理成表") : tr("例如：发现之前的结果有 bug，需要重跑")}
                          value={pending.note}
                          onChange={(e) => setPending({ ...pending, note: e.target.value, error: undefined })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveProgress(g);
                            if (e.key === "Escape") cancelPending(g.id);
                          }}
                        />
                        {pending.error && <div className="error-text small">{pending.error}</div>}
                        <div className="actions">
                          <button className="primary" disabled={!pending.note.trim()} onClick={() => saveProgress(g)}>
                            {tr("保存进度")}
                          </button>
                          <button onClick={() => cancelPending(g.id)}>{tr("取消")}</button>
                        </div>
                      </div>
                    )}
                    <div className="actions">
                      <span className="muted small">{tr("已投入")} {fmtMinutes(g.invested_minutes ?? 0)}</span>
                      <button className="link" onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                        {expanded === g.id ? tr("收起") : tr("记录与曲线")}
                      </button>
                      <span className="spacer" />
                      <button className="link" onClick={() => openForm({ ...g })}>
                        {tr("编辑")}
                      </button>
                      {g.status === "active" && (
                        <button className="link" onClick={() => quick(g, { status: "done", progress: 100, is_primary: false, progress_reason: tr("标记为完成") } as Partial<Goal>)}>
                          {tr("完成")}
                        </button>
                      )}
                      <button
                        className="link danger"
                        onClick={async () => {
                          if (!window.confirm(tr("删除目标“{0}”？", [g.title]))) return;
                          await api.deleteGoal(g.id);
                          onChanged();
                        }}
                      >
                        {tr("删除")}
                      </button>
                    </div>
                    {expanded === g.id && <GoalDetail goal={g} color={LEVEL_COLOR[g.level]} onOpenEntry={onOpenEntry} />}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {meta.goals.length === 0 && !editing && <p className="muted">{tr("还没有目标。先设一个短期目标和 DDL 吧。")}</p>}
    </main>
  );
}

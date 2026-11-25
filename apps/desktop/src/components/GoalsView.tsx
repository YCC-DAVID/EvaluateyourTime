import { useState } from "react";
import { api, type Goal, type Meta } from "../api.ts";

const LEVEL_LABEL = { long: "长期（2–3 个月）", short: "短期（1–2 周）", task: "具体任务" } as const;
const STATUS_LABEL = { active: "进行中", paused: "暂停", done: "完成", dropped: "放弃" } as const;
const PRIORITY_LABEL = { 1: "高", 2: "中", 3: "低" } as const;

const empty: Partial<Goal> = { level: "short", title: "", description: "", ddl: "", progress: 0, priority: 2, status: "active", is_primary: false, parent_id: null };

function daysLeft(ddl: string | null) {
  if (!ddl) return null;
  const [y, m, d] = ddl.split("-").map(Number);
  const t = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((t - today) / 86400_000);
}

export function GoalsView({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const [editing, setEditing] = useState<Partial<Goal> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) await api.updateGoal(editing.id, editing);
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
        <h2>目标</h2>
        <button className="primary" onClick={() => setEditing({ ...empty })}>
          + 新目标
        </button>
      </div>
      <p className="muted">
        设一个“当前主要目标”（★），统计里的“重点目标投入”按它计算。进度可以是里程碑或你的判断，不必等于投入小时。
      </p>

      {editing && (
        <div className="card goal-form">
          <div className="form-grid">
            <label>
              名称
              <input value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus />
            </label>
            <label>
              层级
              <select value={editing.level} onChange={(e) => setEditing({ ...editing, level: e.target.value as Goal["level"] })}>
                {groups.map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              DDL（可选）
              <input type="date" value={editing.ddl ?? ""} onChange={(e) => setEditing({ ...editing, ddl: e.target.value || null })} />
            </label>
            <label>
              优先级
              <select value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}>
                {[1, 2, 3].map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p as 1 | 2 | 3]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              父目标
              <select value={editing.parent_id ?? ""} onChange={(e) => setEditing({ ...editing, parent_id: e.target.value || null })}>
                <option value="">（无）</option>
                {parents.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              进度 {editing.progress ?? 0}%
              <input type="range" min={0} max={100} step={5} value={editing.progress ?? 0} onChange={(e) => setEditing({ ...editing, progress: Number(e.target.value) })} />
            </label>
            <label className="wide">
              说明
              <textarea rows={2} value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={!!editing.is_primary} onChange={(e) => setEditing({ ...editing, is_primary: e.target.checked })} />
              设为当前主要目标
            </label>
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="actions">
            <button className="primary" onClick={save}>
              保存
            </button>
            <button onClick={() => setEditing(null)}>取消</button>
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
                  <div key={g.id} className={`card goal${g.status !== "active" ? " inactive" : ""}`}>
                    <div className="goal-top">
                      <button
                        className={`star${g.is_primary ? " on" : ""}`}
                        title={g.is_primary ? "当前主要目标" : "设为主要目标"}
                        onClick={() => quick(g, { is_primary: !g.is_primary })}
                      >
                        ★
                      </button>
                      <strong>{g.title}</strong>
                      <span className="badge">{STATUS_LABEL[g.status]}</span>
                      <span className="badge">优先级 {PRIORITY_LABEL[g.priority as 1 | 2 | 3]}</span>
                      {dl != null && (
                        <span className={`badge${dl < 0 ? " danger" : dl <= 3 ? " warn" : ""}`}>
                          {dl < 0 ? `已过 DDL ${-dl} 天` : dl === 0 ? "今天截止" : `还剩 ${dl} 天`}
                        </span>
                      )}
                    </div>
                    {g.description && <p className="muted">{g.description}</p>}
                    <div className="bar">
                      <div className="bar-fill" style={{ width: `${g.progress}%` }} />
                    </div>
                    <div className="actions">
                      <span className="muted small">进度 {g.progress}%</span>
                      <span className="spacer" />
                      <button className="link" onClick={() => setEditing({ ...g })}>
                        编辑
                      </button>
                      {g.status === "active" && (
                        <button className="link" onClick={() => quick(g, { status: "done", progress: 100, is_primary: false })}>
                          完成
                        </button>
                      )}
                      <button
                        className="link danger"
                        onClick={async () => {
                          if (!window.confirm(`删除目标“${g.title}”？`)) return;
                          await api.deleteGoal(g.id);
                          onChanged();
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {meta.goals.length === 0 && !editing && <p className="muted">还没有目标。先设一个短期目标和 DDL 吧。</p>}
    </main>
  );
}

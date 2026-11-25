import { useState } from "react";
import type { Goal } from "../api.ts";

// 把一个目标拆成按顺序执行的子目标：
//  - “AI 建议拆分”按目标说明、DDL、已有子目标给出步骤、占比和建议截止日期
//  - 也可以完全手动填（流程已经确定时）
// 每一行都能改；确认后一次性创建，子目标的进度会按占比计入这个目标。

interface Step {
  title: string;
  description: string;
  weight: number;
  ddl: string | null;
}

const blank = (): Step => ({ title: "", description: "", weight: 0, ddl: null });

export function GoalSplitPanel(props: { goal: Goal; remaining: number; onDone: () => void; onCancel: () => void }) {
  const { goal, remaining } = props;
  const [steps, setSteps] = useState<Step[]>([blank(), blank(), blank()]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const filled = steps.filter((s) => s.title.trim());
  const sum = filled.reduce((a, s) => a + (Number(s.weight) || 0), 0);
  const set = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  async function suggest() {
    setBusy("AI 正在拆分…");
    setError(null);
    try {
      const r = await fetch(`/api/goals/${goal.id}/split/suggest`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "拆分失败");
      setSteps(j.steps.map((s: Step) => ({ ...s, description: s.description ?? "" })));
      setNote(j.note || null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 按当前比例缩放到剩余份额 */
  function normalize() {
    if (sum <= 0) {
      const each = Math.floor(remaining / filled.length);
      setSteps(steps.map((s) => (s.title.trim() ? { ...s, weight: each } : s)));
      return;
    }
    let acc = 0;
    const out = steps.map((s) => {
      if (!s.title.trim()) return s;
      const w = Math.round(((Number(s.weight) || 0) * remaining) / sum);
      acc += w;
      return { ...s, weight: w };
    });
    const diff = remaining - acc;
    const k = out.findIndex((s) => s.title.trim());
    if (k >= 0 && diff) out[k] = { ...out[k], weight: out[k].weight + diff };
    setSteps(out);
  }

  async function create() {
    setBusy("正在创建…");
    setError(null);
    try {
      const r = await fetch(`/api/goals/${goal.id}/children`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ children: filled }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "创建失败");
      props.onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="split-panel">
      <div className="split-head">
        <strong>拆分成子目标</strong>
        <span className="muted small">
          可分配 {remaining}%{goal.ddl ? ` · 父目标 DDL ${goal.ddl}` : ""}
        </span>
        <span className="spacer" />
        <button className="primary" disabled={!!busy} onClick={suggest}>
          {busy === "AI 正在拆分…" ? busy : "AI 建议拆分"}
        </button>
      </div>
      <p className="muted small">
        流程已经确定就直接按顺序填；不确定时让 AI 按目标说明和 DDL 给一版，再改。每步写成能检查的交付物。
      </p>
      {note && <p className="suggestion small">AI：{note}</p>}

      <div className="split-rows">
        <div className="split-row split-label">
          <span>#</span>
          <span>步骤（交付物）</span>
          <span>占比 %</span>
          <span>建议截止</span>
          <span />
        </div>
        {steps.map((s, i) => (
          <div key={i} className="split-row">
            <span className="muted small">{i + 1}</span>
            <span className="split-title">
              <input type="text" placeholder="例如：完成模块 A 消融并出表" value={s.title} onChange={(e) => set(i, { title: e.target.value })} />
              {s.description && <span className="muted small">{s.description}</span>}
            </span>
            <input type="number" min={0} max={100} step={5} value={s.weight} onChange={(e) => set(i, { weight: Number(e.target.value) })} />
            <input type="date" value={s.ddl ?? ""} max={goal.ddl ?? undefined} onChange={(e) => set(i, { ddl: e.target.value || null })} />
            <button className="icon" title="删除这一步" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="actions">
        <button className="link small" onClick={() => setSteps([...steps, blank()])}>
          + 加一步
        </button>
        <span className={`small${filled.length && sum !== remaining ? " error-text" : " muted"}`}>
          占比合计 {sum}% / 可分配 {remaining}%
        </span>
        {filled.length > 0 && sum !== remaining && (
          <button className="link small" onClick={normalize}>
            按比例调成 {remaining}%
          </button>
        )}
      </div>
      {error && <div className="error-text small">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={!!busy || filled.length === 0 || sum > remaining} onClick={create}>
          创建 {filled.length} 个子目标
        </button>
        <button disabled={!!busy} onClick={props.onCancel}>
          取消
        </button>
        {sum > remaining && <span className="error-text small">占比超过可分配的 {remaining}%</span>}
      </div>
    </div>
  );
}

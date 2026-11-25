import { minutesToPercent, percentToMinutes, type Category } from "../../../../modules/scoring/index.ts";
import { fmtMinutes } from "../api.ts";

export interface AllocDraft {
  category_id: string;
  minutes: number;
  note: string | null;
  state: "estimated" | "confirmed";
}

export function AllocationEditor(props: {
  total: number;
  categories: Category[];
  value: AllocDraft[];
  onChange: (v: AllocDraft[]) => void;
}) {
  const { total, value, categories } = props;
  const sum = value.reduce((s, a) => s + (Number.isFinite(a.minutes) ? a.minutes : 0), 0);
  const remaining = total - sum;
  const set = (i: number, patch: Partial<AllocDraft>) =>
    props.onChange(value.map((a, j) => (j === i ? { ...a, ...patch, state: "confirmed" } : a)));
  const used = new Set(value.map((a) => a.category_id));
  const nextCat = categories.find((c) => !used.has(c.id) && c.kind !== "unknown")?.id ?? categories[0].id;

  return (
    <div className="alloc">
      <div className="alloc-head">
        <span>分类</span>
        <span>分钟</span>
        <span>%</span>
        <span>说明</span>
        <span />
      </div>
      {value.map((a, i) => {
        const cat = categories.find((c) => c.id === a.category_id);
        return (
          <div className="alloc-row" key={i}>
            <span className="alloc-cat">
              <i style={{ background: cat?.color }} />
              <select value={a.category_id} onChange={(e) => set(i, { category_id: e.target.value })}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </span>
            <input
              type="number"
              min={0}
              max={total}
              step={5}
              value={a.minutes}
              onChange={(e) => set(i, { minutes: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            />
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={minutesToPercent(a.minutes, total)}
              onChange={(e) => set(i, { minutes: percentToMinutes(Math.max(0, Number(e.target.value) || 0), total) })}
            />
            <input
              type="text"
              placeholder="可选"
              value={a.note ?? ""}
              onChange={(e) => set(i, { note: e.target.value || null })}
            />
            <span className="alloc-tail">
              {a.state === "estimated" && <span className="tag est" title="AI 估计，确认后才计入有效工作">估计</span>}
              <button className="icon" title="删除" onClick={() => props.onChange(value.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          </div>
        );
      })}
      <div className="alloc-foot">
        <button className="link" onClick={() => props.onChange([...value, { category_id: nextCat, minutes: Math.max(0, remaining), note: null, state: "confirmed" }])}>
          + 添加分类
        </button>
        <span className={remaining < 0 ? "error-text" : "muted"}>
          {remaining < 0
            ? `超出时段 ${fmtMinutes(-remaining)}，请减少`
            : remaining > 0
              ? `未分配 ${fmtMinutes(remaining)}（保留为不确定，不判低分）`
              : "已全部分配"}
        </span>
      </div>
    </div>
  );
}

import { useState } from "react";
import { minutesToPercent, percentToMinutes, type Category } from "../../../../modules/scoring/index.ts";
import { fmtMinutes } from "../api.ts";
import { tr } from "../i18n.ts";

export interface AllocDraft {
  category_id: string;
  minutes: number;
  note: string | null;
  state: "estimated" | "confirmed";
  /** 由某个问题的回答生成的行（换答案时替换掉） */
  qid?: string;
}

/**
 * 数字输入框：编辑时保留你敲的原文，不被换算结果改写（否则输入 5% 会立刻变成按整分钟反算的 5.2%）；
 * 每次输入都把解析出的值交出去，离开输入框后再显示规范值。
 */
function DraftNumberInput(props: { value: number; onValue: (v: number) => void; step: number; min: number; max: number; ariaLabel: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={props.ariaLabel}
      min={props.min}
      max={props.max}
      step={props.step}
      value={draft ?? String(props.value)}
      onFocus={(e) => {
        setDraft(String(props.value));
        e.target.select();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) props.onValue(Math.max(props.min, Math.min(props.max, n)));
        else if (e.target.value === "") props.onValue(0);
      }}
      onBlur={() => setDraft(null)}
    />
  );
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
        <span>{tr("分类")}</span>
        <span>{tr("分钟")}</span>
        <span>%</span>
        <span>{tr("说明")}</span>
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
                    {tr(c.name)}
                  </option>
                ))}
              </select>
            </span>
            <DraftNumberInput
              ariaLabel={tr("分钟")}
              min={0}
              max={total}
              step={5}
              value={a.minutes}
              onValue={(v) => set(i, { minutes: Math.round(v) })}
            />
            <DraftNumberInput
              ariaLabel={tr("百分比")}
              min={0}
              max={100}
              step={1}
              value={minutesToPercent(a.minutes, total)}
              onValue={(v) => set(i, { minutes: percentToMinutes(v, total) })}
            />
            <input
              type="text"
              placeholder={tr("可选")}
              value={a.note ?? ""}
              onChange={(e) => set(i, { note: e.target.value || null })}
            />
            <span className="alloc-tail">
              {a.state === "estimated" && <span className="tag est" title={tr("AI 估计，确认后才计入有效工作")}>{tr("估计")}</span>}
              <button className="icon" title={tr("删除")} onClick={() => props.onChange(value.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          </div>
        );
      })}
      <div className="alloc-foot">
        <button className="link" onClick={() => props.onChange([...value, { category_id: nextCat, minutes: Math.max(0, remaining), note: null, state: "confirmed" }])}>
          {tr("+ 添加分类")}
        </button>
        {remaining < 0 && sum > 0 && (
          <button
            className="link small"
            title={tr("时段改短后，把各项按原来的比例缩到新时长内")}
            onClick={() =>
              props.onChange(value.map((x) => ({ ...x, minutes: Math.floor((x.minutes * total) / sum) })).filter((x) => x.minutes > 0))
            }
          >
            {tr("按比例缩到")} {fmtMinutes(total)}
          </button>
        )}
        <span className={remaining < 0 ? "error-text" : "muted"}>
          {remaining < 0
            ? tr("超出时段 {0}，请减少", [fmtMinutes(-remaining)])
            : remaining > 0
              ? tr("未分配 {0}（保留为不确定，不判低分）", [fmtMinutes(remaining)])
              : tr("已全部分配")}
        </span>
      </div>
    </div>
  );
}

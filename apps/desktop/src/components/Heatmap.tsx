import { useEffect, useRef, useState, type ReactNode } from "react";
import { GRADE_LABEL, gradeOf, type HeatCell, type RuleSet } from "../../../../modules/scoring/index.ts";
import { fmtMinutes, hm, type Entry } from "../api.ts";

export function gradeColor(score: number | null, rules: RuleSet): string {
  const g = gradeOf(score, rules);
  return g === "good" ? "var(--good)" : g === "fair" ? "var(--fair)" : g === "poor" ? "var(--poor)" : "var(--none)";
}

const PER_ROW = 16; // 每行 4 小时，每格 15 分钟

export type HeatMode = "day" | "week" | "month";

export function HeatLegend() {
  return (
    <div className="legend">
      <span><i style={{ background: "var(--good)" }} />较好</span>
      <span><i style={{ background: "var(--fair)" }} />一般</span>
      <span><i style={{ background: "var(--poor)" }} />偏离</span>
      <span><i className="pending" />已记录未评</span>
      <span><i style={{ background: "var(--none)" }} />未记录</span>
    </div>
  );
}

export function ModeSwitch({ mode, onChange }: { mode: HeatMode; onChange: (m: HeatMode) => void }) {
  return (
    <div className="seg" role="tablist" aria-label="热力图范围">
      {(
        [
          ["day", "日"],
          ["week", "周"],
          ["month", "月"],
        ] as const
      ).map(([m, label]) => (
        <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => onChange(m)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Heatmap(props: {
  cells: HeatCell[];
  entries: Entry[];
  rules: RuleSet;
  selectedId: string | null;
  onPick: (entryId: string) => void;
  /** 选中一段空白时间（单格点击或拖选多格）来补录 */
  onPickEmpty: (start: Date, end: Date) => void;
  /** 可补录范围 [backfillFrom, now) */
  backfillFrom: number;
  now: number;
  /** 正在补录的那段时间（点空白格或拖选后），保持高亮直到换成别的 */
  picked?: { start: number; end: number } | null;
  /** 标题旁的日/周/月切换 */
  modeSwitch?: ReactNode;
}) {
  const { cells, rules } = props;
  const rows: HeatCell[][] = [];
  for (let i = 0; i < cells.length; i += PER_ROW) rows.push(cells.slice(i, i + PER_ROW));
  const titleOf = (id: string) => {
    const e = props.entries.find((x) => x.id === id);
    return e ? e.title || e.raw_text.slice(0, 16) : "";
  };
  const inWindow = (c: HeatCell) => c.end > props.backfillFrom && c.start < props.now;

  // ---------- 拖选 ----------
  // 按下一格开始，拖过的格子按时间顺序连成一段（可以跨行）；松手时：
  //   没有移动 → 当作点击（已记录的打开记录，空白的补录这一格）
  //   拖过多格 → 用这一整段时间新建记录
  const [sel, setSel] = useState<{ a: number; b: number; moved: boolean } | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;

  const clickCell = (c: HeatCell) => {
    if (c.entryIds.length) props.onPick(c.entryIds[c.entryIds.length - 1]);
    else if (inWindow(c)) props.onPickEmpty(new Date(Math.max(c.start, props.backfillFrom)), new Date(Math.min(c.end, props.now)));
  };

  const rangeOf = (s: { a: number; b: number }) => {
    const lo = Math.min(s.a, s.b);
    const hi = Math.max(s.a, s.b);
    return { lo, hi, start: Math.max(cells[lo].start, props.backfillFrom), end: Math.min(cells[hi].end, props.now) };
  };

  useEffect(() => {
    if (!sel) return;
    const up = () => {
      const s = selRef.current;
      setSel(null);
      if (!s) return;
      if (!s.moved) return clickCell(cells[s.a]);
      const r = rangeOf(s);
      if (r.end > r.start) props.onPickEmpty(new Date(r.start), new Date(r.end));
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // 只在开始/结束拖选时挂载监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel != null]);

  // 用指针位置找格子：鼠标和触屏都适用
  const onGridMove = (e: React.PointerEvent) => {
    if (!selRef.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const idx = el?.dataset.idx != null ? Number(el.dataset.idx) : null;
    if (idx == null || !inWindow(cells[idx])) return;
    if (idx !== selRef.current.b) setSel({ ...selRef.current, b: idx, moved: true });
  };

  // 按下就高亮（单格也算），拖动时显示时长
  const live = sel ? rangeOf(sel) : null;

  return (
    <div className="card heatmap-card">
      <div className="card-head">
        <h3>24 小时</h3>
        {props.modeSwitch}
        <HeatLegend />
      </div>
      <div className="heatmap" onPointerMove={onGridMove}>
        {/* 顶部刻度：每组 1 小时，组内 15/30/45 分 */}
        <div className="hm-row hm-axis" aria-hidden>
          <span className="hm-hour" />
          {Array.from({ length: PER_ROW }, (_, ci) => (
            <span key={ci} className={`hm-tick${ci % 4 === 0 ? " hour-start major" : ""}`}>
              {ci % 4 === 0 ? `+${ci / 4}h` : `${(ci % 4) * 15}`}
            </span>
          ))}
        </div>
        {rows.map((row, ri) => (
          <div className="hm-row" key={ri}>
            <span className="hm-hour">{String(ri * 4).padStart(2, "0")}:00</span>
            {row.map((c, ci) => {
              const idx = ri * PER_ROW + ci;
              const recorded = c.entryIds.length > 0;
              const scored = c.score != null;
              const coverage = c.coveredMinutes / 15;
              const label = recorded
                ? `${hm(c.start)}–${hm(c.end)} ${c.entryIds.map(titleOf).join(" / ")}${
                    scored ? ` · ${c.score} 分（${GRADE_LABEL[gradeOf(c.score, rules)]}）· 整段平均，估计` : " · 未评分"
                  }${coverage < 1 ? ` · 覆盖 ${c.coveredMinutes} 分钟` : ""}`
                : c.end <= props.backfillFrom
                  ? `${hm(c.start)}–${hm(c.end)} 未记录（超过 3 天，不能补录）`
                  : c.start >= props.now
                    ? `${hm(c.start)}–${hm(c.end)} 还没到`
                    : `${hm(c.start)}–${hm(c.end)} 未记录，点击或拖选补录`;
              const selected = props.selectedId && c.entryIds.includes(props.selectedId);
              const inSel = live && idx >= live.lo && idx <= live.hi;
              const picked = !inSel && props.picked && c.start < props.picked.end && c.end > props.picked.start;
              return (
                <button
                  key={ci}
                  data-idx={idx}
                  className={`hm-cell${ci % 4 === 0 ? " hour-start" : ""}${recorded && !scored ? " pending" : ""}${selected ? " selected" : ""}${inSel ? " in-sel" : ""}${picked ? " picked" : ""}`}
                  style={scored ? { background: gradeColor(c.score, rules), opacity: 0.35 + 0.65 * coverage } : undefined}
                  title={label}
                  aria-label={label}
                  disabled={!recorded && !inWindow(c)}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault(); // 防止拖动时选中文字
                    // 只有可补录范围内的格子能开始拖选；范围外的已记录格子只能点开
                    if (inWindow(c)) setSel({ a: idx, b: idx, moved: false });
                    else if (recorded) clickCell(c);
                  }}
                  // 键盘（回车/空格）触发的点击；鼠标点击已在 pointerup 里处理
                  onClick={(e) => e.detail === 0 && clickCell(c)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="hint">
        {live && sel?.moved ? (
          <strong className="sel-live">
            {hm(live.start)}–{hm(live.end)} · {fmtMinutes(Math.round((live.end - live.start) / 60000))}，松手后记录这一段
          </strong>
        ) : (
          "点一格查看或补录，按住拖动可选多格一起记录。没有具体子段时，整段按平均分着色（估计）。"
        )}
      </p>
    </div>
  );
}

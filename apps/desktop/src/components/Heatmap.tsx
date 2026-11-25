import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { GRADE_LABEL, gradeOf, type Category, type CategoryKind, type HeatCell, type RuleSet } from "../../../../modules/scoring/index.ts";
import { fmtMinutes, hm, type CalEvent, type Entry } from "../api.ts";
import { tr } from "../i18n.ts";

export function gradeColor(score: number | null, rules: RuleSet): string {
  const g = gradeOf(score, rules);
  return g === "good" ? "var(--good)" : g === "fair" ? "var(--fair)" : g === "poor" ? "var(--poor)" : "var(--none)";
}

const PER_ROW = 16; // 每行 4 小时，每格 15 分钟

export type HeatMode = "day" | "week" | "month";

// ---------- 着色 ----------
// 热力图看的是“打分”：非休息的时间按分数着色，越绿越好、越红越偏离，中间是黄。
// 休息 / 睡眠不好用好坏评判，占一格大半的就画成蓝色（休息分类的颜色），不按分数上色。

/** 分数 → 颜色：45 分及以下红，60 分左右黄，80 分及以上绿，中间连续过渡 */
export function scoreColor(score: number): string {
  const stops: [number, string][] = [
    [45, "var(--poor)"],
    [62, "var(--fair)"],
    [80, "var(--good)"],
  ];
  if (score <= stops[0][0]) return stops[0][1];
  if (score >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    const [s1, c1] = stops[i];
    const [s0, c0] = stops[i - 1];
    if (score <= s1) return `color-mix(in oklab, ${c1} ${Math.round(((score - s0) / (s1 - s0)) * 100)}%, ${c0})`;
  }
  return stops[stops.length - 1][1];
}

// 悬停提示里用的活动名
const KIND_ORDER: [CategoryKind, string][] = [
  ["work", tr("工作")],
  ["rest", tr("休息")],
  ["fun", tr("娱乐")],
  ["life", tr("生活")],
  ["sport", tr("运动")],
  ["waste", tr("消耗")],
];

export function kindColor(kind: CategoryKind | null, categories: Category[]): string {
  return categories.find((c) => c.kind === kind)?.color ?? "#9aa0a6";
}

/** 这一格主要是休息吗（休息占这一格已记录时间的一半以上） */
export function isRestCell(c: HeatCell): boolean {
  const total = Object.values(c.kindMinutes).reduce((x, y) => x + (y ?? 0), 0);
  return total > 0 && (c.kindMinutes.rest ?? 0) * 2 >= total;
}

/** 一格的样式；slotMinutes 用来算覆盖比例（覆盖少的格子更淡） */
export function heatCellStyle(c: HeatCell, categories: Category[], slotMinutes: number): CSSProperties | undefined {
  if (!c.entryIds.length) return undefined;
  const opacity = 0.4 + 0.6 * Math.min(1, c.coveredMinutes / slotMinutes);
  if (isRestCell(c)) {
    const blue = kindColor("rest", categories);
    if (c.score != null) return { background: blue, opacity };
    const a = `color-mix(in srgb, ${blue} 30%, var(--none))`;
    const b = `color-mix(in srgb, ${blue} 65%, var(--none))`;
    return { background: `repeating-linear-gradient(45deg, ${a}, ${a} 3px, ${b} 3px, ${b} 5px)`, opacity };
  }
  if (c.score == null) return undefined; // 已记录未评：斜纹（样式表）
  return { background: scoreColor(c.score), opacity };
}

export function HeatLegend({ categories }: { categories: Category[] }) {
  return (
    <div className="legend">
      <span className="score-ramp">
        {tr("低分")}
        <i className="ramp" />
        {tr("高分")}
      </span>
      <span>
        <i style={{ background: kindColor("rest", categories) }} />
        {tr("休息（不评好坏）")}
      </span>
      <span>
        <i className="pending" />
        {tr("已记录未评")}
      </span>
      <span>
        <i style={{ background: "var(--none)" }} />
        {tr("未记录")}
      </span>
    </div>
  );
}

export function ModeSwitch({ mode, onChange }: { mode: HeatMode; onChange: (m: HeatMode) => void }) {
  return (
    <div className="seg" role="tablist" aria-label={tr("热力图范围")}>
      {(
        [
          ["day", tr("日")],
          ["week", tr("周")],
          ["month", tr("月")],
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
  categories: Category[];
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
  /** 当天的日程（虚线框标出） */
  events?: CalEvent[];
}) {
  const evOf = (c: HeatCell) => (props.events ?? []).filter((e) => !e.all_day && Date.parse(e.start_utc) < c.end && Date.parse(e.end_utc) > c.start);
  const { cells, rules } = props;
  const kindLabel = (c: HeatCell) =>
    Object.entries(c.kindMinutes)
      .filter(([, m]) => (m as number) > 0)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .map(([k, m]) => tr("{0} {1} 分", [KIND_ORDER.find(([x]) => x === k)?.[1] ?? tr("未分配"), m]))
      .join(tr("、"));
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
        <h3>{tr("24 小时")}</h3>
        {props.modeSwitch}
        <HeatLegend categories={props.categories} />
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
                    scored ? tr(" · {0} 分（{1}）· 整段平均，估计", [c.score, tr(GRADE_LABEL[gradeOf(c.score, rules)])]) : tr(" · 未评分")
                  }${coverage < 1 ? tr(" · 覆盖 {0} 分钟", [c.coveredMinutes]) : ""}${kindLabel(c) ? tr("\n{0}（按分配比例估计）", [kindLabel(c)]) : ""}`
                : c.end <= props.backfillFrom
                  ? tr("{0}–{1} 未记录（超过 3 天，不能补录）", [hm(c.start), hm(c.end)])
                  : c.start >= props.now
                    ? tr("{0}–{1} 还没到", [hm(c.start), hm(c.end)])
                    : tr("{0}–{1} 未记录，点击或拖选补录", [hm(c.start), hm(c.end)]);
              const selected = props.selectedId && c.entryIds.includes(props.selectedId);
              const evs = evOf(c);
              const inSel = live && idx >= live.lo && idx <= live.hi;
              const picked = !inSel && props.picked && c.start < props.picked.end && c.end > props.picked.start;
              return (
                <button
                  key={ci}
                  data-idx={idx}
                  className={`hm-cell${ci % 4 === 0 ? " hour-start" : ""}${recorded && !scored ? " pending" : ""}${selected ? " selected" : ""}${inSel ? " in-sel" : ""}${picked ? " picked" : ""}${evs.length ? " has-event" : ""}`}
                  style={heatCellStyle(c, props.categories, 15)}
                  title={evs.length ? `${label}\n📅 ${evs.map((e) => e.title).join(" / ")}` : label}
                  aria-label={label}
                  data-event={evs.length ? "1" : undefined}
                  disabled={!recorded && !inWindow(c) && !evs.length}
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
            {hm(live.start)}–{hm(live.end)} · {fmtMinutes(Math.round((live.end - live.start) / 60000))}{tr("，松手后记录这一段")}
          </strong>
        ) : (
          tr("点一格查看或补录，按住拖动可选多格一起记录。颜色是分数：越绿越好、越红越偏离；休息为主的时间画成蓝色，不评好坏。没有具体子段时按整段平均（估计）。")
        )}
      </p>
    </div>
  );
}

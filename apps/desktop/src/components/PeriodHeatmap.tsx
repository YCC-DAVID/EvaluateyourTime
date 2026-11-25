import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  GRADE_LABEL,
  buildHeatmap,
  computeDayStats,
  gradeOf,
  localDayRange,
  type Category,
  type DayEntry,
  type HeatCell,
  type RuleSet,
} from "../../../../modules/scoring/index.ts";
import { api, fmtMinutes, todayStr, toDayEntry, type Entry } from "../api.ts";
import { gradeColor, HeatLegend } from "./Heatmap.tsx";

// 周热力图：7 行（周一到周日）× 24 小时，每格 1 小时。
// 月热力图：日历，每天一格，按当天的平均评价着色。
// 着色规则和日视图一致：已确认的按时长加权平均分；已记录未评为斜纹；未记录为灰；透明度表示覆盖了多少。
// 点任意格子跳到那一天的日视图。

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DAY = 86400_000;

const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s: string, n: number) => {
  const d = parse(s);
  return todayStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
/** 所在周的周一 */
export const weekStartOf = (s: string) => addDays(s, -((parse(s).getDay() + 6) % 7));
export const monthStartOf = (s: string) => {
  const d = parse(s);
  return todayStr(new Date(d.getFullYear(), d.getMonth(), 1));
};

function cellStyle(c: HeatCell, rules: RuleSet, slotMinutes: number) {
  if (c.score == null) return undefined;
  return { background: gradeColor(c.score, rules), opacity: 0.35 + 0.65 * Math.min(1, c.coveredMinutes / slotMinutes) };
}

export function PeriodHeatmap(props: {
  mode: "week" | "month";
  anchor: string; // YYYY-MM-DD
  rules: RuleSet;
  categories: Category[];
  workBudgetMinutes: number;
  primaryGoalId: string | null;
  now: number;
  /** 日视图的数据变化时也重新取 */
  refreshKey: unknown;
  modeSwitch: ReactNode;
  onShift: (dir: -1 | 1) => void;
  onPickDay: (day: string) => void;
}) {
  const { mode, anchor, rules, now } = props;
  const first = mode === "week" ? weekStartOf(anchor) : weekStartOf(monthStartOf(anchor));
  const monthStart = monthStartOf(anchor);
  const monthIdx = parse(monthStart).getMonth();
  // 月视图：从当月 1 号所在周的周一，铺满到月底所在周的周日
  const days = useMemo(() => {
    if (mode === "week") return Array.from({ length: 7 }, (_, i) => addDays(first, i));
    const last = parse(monthStart);
    const monthEnd = todayStr(new Date(last.getFullYear(), last.getMonth() + 1, 0));
    const out: string[] = [];
    for (let d = first; out.length < 42; d = addDays(d, 1)) {
      out.push(d);
      if (d >= monthEnd && out.length % 7 === 0) break;
    }
    return out;
  }, [mode, first, monthStart]);

  const rangeStart = localDayRange(days[0])[0];
  const rangeEnd = localDayRange(days[days.length - 1])[1];

  const [entries, setEntries] = useState<DayEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .entries(new Date(rangeStart).toISOString(), new Date(rangeEnd).toISOString())
      .then((list: Entry[]) => alive && (setEntries(list.map(toDayEntry)), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [rangeStart, rangeEnd, props.refreshKey]);

  // 汇总：周看整周，月只看本月的日子
  const sumStart = mode === "week" ? rangeStart : localDayRange(monthStart)[0];
  const monthDays = days.filter((d) => parse(d).getMonth() === monthIdx);
  const sumEnd = mode === "week" ? rangeEnd : localDayRange(monthDays[monthDays.length - 1])[1];
  const nDays = Math.round((sumEnd - sumStart) / DAY);
  const stats = entries
    ? computeDayStats(entries, props.categories, sumStart, sumEnd, now, props.workBudgetMinutes * nDays, props.primaryGoalId)
    : null;
  const elapsedDays = Math.max(1, Math.min(nDays, Math.ceil((Math.min(now, sumEnd) - sumStart) / DAY)));

  const title =
    mode === "week"
      ? `${parse(days[0]).getMonth() + 1}/${parse(days[0]).getDate()} – ${parse(days[6]).getMonth() + 1}/${parse(days[6]).getDate()}`
      : `${parse(monthStart).getFullYear()} 年 ${monthIdx + 1} 月`;
  const today = todayStr(new Date(now));

  return (
    <div className="card heatmap-card">
      <div className="card-head">
        <h3>{mode === "week" ? "周" : "月"}</h3>
        {props.modeSwitch}
        <HeatLegend />
      </div>
      <div className="period-nav">
        <button onClick={() => props.onShift(-1)} aria-label={mode === "week" ? "上一周" : "上个月"}>
          ‹
        </button>
        <strong>{title}</strong>
        <button onClick={() => props.onShift(1)} aria-label={mode === "week" ? "下一周" : "下个月"}>
          ›
        </button>
        {stats && (
          <span className="period-sum muted small">
            记录 {fmtMinutes(stats.recordedMinutes)}
            {stats.coverage != null && `（覆盖 ${Math.round(stats.coverage * 100)}%）`} · 有效工作 {fmtMinutes(stats.effectiveWorkMinutes)}
            （日均 {fmtMinutes(Math.round(stats.effectiveWorkMinutes / elapsedDays))}） · 平均评价 {stats.avgScore ?? "—"}
          </span>
        )}
      </div>
      {error && <div className="error-text small">{error}</div>}

      {mode === "week" ? (
        <div className="week-heat">
          <div className="wk-row wk-axis" aria-hidden>
            <span className="wk-label" />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="wk-tick">
                {h % 3 === 0 ? h : ""}
              </span>
            ))}
          </div>
          {days.map((d, i) => {
            const [d0, d1] = localDayRange(d);
            const cells = entries ? buildHeatmap(entries, d0, d1, 60) : [];
            return (
              <div key={d} className={`wk-row${d === today ? " today" : ""}`}>
                <button className="wk-label link" onClick={() => props.onPickDay(d)} title="查看这一天">
                  {WEEKDAYS[i]} {parse(d).getMonth() + 1}/{parse(d).getDate()}
                </button>
                {cells.map((c, h) => {
                  const recorded = c.entryIds.length > 0;
                  const future = c.start >= now;
                  const label = `${WEEKDAYS[i]} ${h}:00–${h + 1}:00 ${
                    recorded
                      ? c.score != null
                        ? `${c.score} 分（${GRADE_LABEL[gradeOf(c.score, rules)]}）· 覆盖 ${c.coveredMinutes} 分钟`
                        : `已记录 ${c.coveredMinutes} 分钟，未评分`
                      : future
                        ? "还没到"
                        : "未记录"
                  }`;
                  return (
                    <button
                      key={h}
                      className={`wk-cell${recorded && c.score == null ? " pending" : ""}${future ? " future" : ""}${h % 6 === 0 ? " six" : ""}`}
                      style={cellStyle(c, rules, 60)}
                      title={label}
                      aria-label={label}
                      onClick={() => props.onPickDay(d)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="month-heat">
          {WEEKDAYS.map((w) => (
            <span key={w} className="mo-head">
              {w.slice(1)}
            </span>
          ))}
          {days.map((d) => {
            const [d0, d1] = localDayRange(d);
            const c = entries ? buildHeatmap(entries, d0, d1, 1440)[0] : null;
            const inMonth = parse(d).getMonth() === monthIdx;
            const future = d0 > now;
            const recorded = !!c && c.entryIds.length > 0;
            // 透明度按当天已过时间里的覆盖比例
            const elapsed = Math.max(1, Math.min(1440, Math.round((Math.min(now, d1) - d0) / 60000)));
            // 覆盖少就把颜色调淡（只淡背景，数字保持清楚）；颜色够深时换成白字/深字保证对比
            let style: React.CSSProperties | undefined;
            if (c && c.score != null) {
              const pct = Math.round(35 + 65 * Math.min(1, c.coveredMinutes / elapsed));
              const grade = gradeOf(c.score, rules);
              style = {
                background: `color-mix(in srgb, ${gradeColor(c.score, rules)} ${pct}%, var(--none))`,
                color: pct >= 60 ? (grade === "fair" ? "#3d3000" : "#fff") : undefined,
              };
            }
            const label = `${parse(d).getMonth() + 1}/${parse(d).getDate()} ${
              recorded ? `记录 ${fmtMinutes(c!.coveredMinutes)}${c!.score != null ? ` · ${c!.score} 分（${GRADE_LABEL[gradeOf(c!.score, rules)]}）` : " · 未评分"}` : future ? "还没到" : "未记录"
            }`;
            return (
              <button
                key={d}
                className={`mo-cell${recorded && c!.score == null ? " pending" : ""}${inMonth ? "" : " other"}${future ? " future" : ""}${d === today ? " today" : ""}`}
                style={style}
                title={label}
                aria-label={label}
                onClick={() => props.onPickDay(d)}
              >
                <span className="mo-day">{parse(d).getDate()}</span>
                {recorded && <span className="mo-val">{c!.score ?? ""}</span>}
                {recorded && <span className="mo-hours">{Math.round((c!.coveredMinutes / 60) * 10) / 10}h</span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="hint">点任意格子查看那一天。颜色是已确认记录按时长加权的平均评价，越淡表示记录覆盖越少。</p>
    </div>
  );
}

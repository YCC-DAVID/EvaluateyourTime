import { useEffect, useState } from "react";
import { GRADE_LABEL, gradeOf } from "../../../../modules/scoring/index.ts";
import { api, fmtMinutes, hm, type CalEvent, type Goal, type ProgressEvent } from "../api.ts";
import { StepChart, type StepPoint } from "./StepChart.tsx";
import { locale, tr } from "../i18n.ts";

export interface GoalEntry {
  id: string;
  start_utc: string;
  end_utc: string;
  title: string | null;
  raw_text: string;
  status: string;
  overall: number | null;
  work_minutes: number;
  counted: boolean;
}

interface Detail {
  goal: Goal & { created_at: string };
  entries: GoalEntry[];
  events: ProgressEvent[];
  start: { at: string; progress: number };
}

const DAY = 86400_000;
const fmtDateTime = (t: string | number) =>
  new Date(t).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtHours = (h: number) => (h < 10 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h)} h`);
const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function GoalDetail(props: { goal: Goal; color: string; onOpenEntry: (e: GoalEntry) => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const { goal } = props;

  // 关联到这个目标的日程（3 天前 ~ 14 天后）
  useEffect(() => {
    api
      .calendarEvents(new Date(Date.now() - 3 * DAY).toISOString(), new Date(Date.now() + 14 * DAY).toISOString())
      .then((l) => setEvents(l.filter((e) => e.goal_id === goal.id && !e.all_day)))
      .catch(() => setEvents([]));
  }, [goal.id]);

  // 进度或投入变化后重新加载
  useEffect(() => {
    fetch(`/api/goals/${goal.id}/detail`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error)))))
      // 只保留写明了推进内容的进度记录
      .then((d: Detail) => setData({ ...d, events: d.events.filter((ev) => ev.reason?.trim()) }))
      .catch((e) => setError(e.message));
  }, [goal.id, goal.progress, goal.invested_minutes]);

  if (error) return <div className="error-text small">{error}</div>;
  if (!data) return <div className="muted small">{tr("加载中…")}</div>;

  const now = Date.now();
  const t0 = Date.parse(data.start.at);
  const ddl = goal.ddl ? (() => { const [y, m, d] = goal.ddl.split("-").map(Number); return new Date(y, m - 1, d, 23, 59).getTime(); })() : null;

  const progressPoints: StepPoint[] = [
    { t: t0, v: data.start.progress, tip: [`${data.start.progress}%`, tr("{0} · 创建目标", [fmtDateTime(t0)])] },
    ...data.events.map((ev) => {
      const delta = ev.to_progress - ev.from_progress;
      return {
        t: Date.parse(ev.created_at),
        v: ev.to_progress,
        tip: [tr("{0}%（{1}{2}）", [ev.to_progress, delta > 0 ? "+" : "", delta]), fmtDateTime(ev.created_at), ev.reason ?? ""].filter(Boolean),
      };
    }),
  ];

  let cum = 0;
  const investPoints: StepPoint[] = [{ t: t0, v: 0, tip: ["0 h", tr("{0} · 创建目标", [fmtDateTime(t0)])] }];
  for (const e of data.entries) {
    if (!e.counted || e.work_minutes <= 0) continue;
    cum += e.work_minutes;
    investPoints.push({
      t: Date.parse(e.end_utc),
      v: cum / 60,
      tip: [tr("累计 {0}", [fmtMinutes(cum)]), `+${fmtMinutes(e.work_minutes)} · ${e.title || e.raw_text.slice(0, 20)}`, fmtDateTime(e.end_utc)],
    });
  }
  const maxH = Math.max(1, Math.ceil(cum / 60));
  const hTicks = maxH <= 4 ? [0, maxH] : [0, Math.round(maxH / 2), maxH];

  // 每条记录带来的进度变化
  const deltaByEntry = new Map<string, number>();
  for (const ev of data.events) if (ev.entry_id) deltaByEntry.set(ev.entry_id, (deltaByEntry.get(ev.entry_id) ?? 0) + ev.to_progress - ev.from_progress);

  const groups = new Map<string, GoalEntry[]>();
  for (const e of [...data.entries].reverse()) {
    const k = dayKey(e.start_utc);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }

  return (
    <div className="goal-detail">
      <div className="charts-row">
        <StepChart
          title={tr("完成进度")}
          points={progressPoints}
          start={t0}
          yMax={100}
          yTicks={[0, 50, 100]}
          yFormat={(v) => `${v}%`}
          color={props.color}
          now={now}
          ddl={ddl}
          pace={100}
        />
        <StepChart
          title={tr("累计投入（已确认的脑力工作）")}
          points={investPoints}
          start={t0}
          yMax={maxH}
          yTicks={hTicks}
          yFormat={fmtHours}
          color={props.color}
          now={now}
          ddl={ddl}
        />
      </div>
      <p className="hint">
        {tr("横轴按距现在的时间取对数：最近一天最宽，越早越压缩；右侧阴影是到 DDL 的剩余时间，虚线是按时完成需要的节奏。")}
        {ddl &&
          (ddl >= now
            ? tr(" DDL {0}，还剩 {1} 天。", [goal.ddl, Math.max(0, Math.ceil((ddl - now) / DAY) - 1)])
            : tr(" 已过 DDL（{0}）。", [goal.ddl]))}
      </p>

      {events.length > 0 && (
        <>
          <h4>
            {tr("日程（")}{events.length} {tr("个，共")} {fmtMinutes(Math.round(events.reduce((a, e) => a + (Date.parse(e.end_utc) - Date.parse(e.start_utc)), 0) / 60000))}{tr("，3 天前到 2 周后）")}
          </h4>
          <ul className="gd-entries">
            {events.map((e) => (
              <li key={e.id} className={Date.parse(e.start_utc) > now ? "future" : ""}>
                <span className="tl-time">
                  {new Date(e.start_utc).toLocaleDateString(locale, { month: "numeric", day: "numeric", weekday: "short" })} {hm(e.start_utc)}–{hm(e.end_utc)}
                </span>
                <span className="tl-title">📅 {e.title}</span>
                {Date.parse(e.start_utc) > now && <span className="badge">{tr("待进行")}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>{tr("关联的记录（")}{data.entries.length}{tr("）")}</h4>
      {data.entries.length === 0 && <p className="muted small">{tr("还没有记录关联到这个目标。记录时点选目标，或在记录里选“关联目标”。")}</p>}
      {[...groups.entries()].map(([k, list]) => (
        <div key={k} className="gd-day">
          <div className="gd-date">{new Date(list[0].start_utc).toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" })}</div>
          <ul className="gd-entries">
            {list.map((e) => {
              const delta = deltaByEntry.get(e.id);
              return (
                <li key={e.id} onClick={() => props.onOpenEntry(e)} title={tr("打开这条记录")}>
                  <span className="tl-time">
                    {hm(e.start_utc)}–{hm(e.end_utc)}
                  </span>
                  <span className="tl-title">{e.title || e.raw_text.slice(0, 30) || tr("（无描述）")}</span>
                  {e.counted ? (
                    e.work_minutes > 0 && <span className="muted small">{fmtMinutes(e.work_minutes)}</span>
                  ) : (
                    <span className="badge">{tr("未确认，未计入")}</span>
                  )}
                  {delta ? <span className={`badge ${delta > 0 ? "up" : "down"}`}>{tr("进度")} {delta > 0 ? "+" : ""}{delta}%</span> : null}
                  {e.overall != null && (
                    <span className={`score-pill g-${gradeOf(e.overall)}`}>
                      {e.overall} {tr(GRADE_LABEL[gradeOf(e.overall)])}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {data.events.length > 0 && (
        <>
          <h4>{tr("进度记录（")}{data.events.length}{tr("）")}</h4>
          <ul className="progress-events full">
            {[...data.events].reverse().map((ev, i) => (
              <li key={i}>
                <span className="pe-delta">
                  {ev.from_progress}% → {ev.to_progress}%
                </span>
                <span className="pe-reason">{ev.reason}</span>
                <span className="muted pe-meta">
                  {ev.source !== "manual" && <span className="tag">{ev.source === "ai" ? tr("评分·AI") : ev.source === "rollup" ? tr("子目标") : tr("评分")}</span>}
                  {fmtDateTime(ev.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
